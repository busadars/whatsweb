const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds, proto } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;

let currentQR = null;
let isConnected = false;

// --- 1. Web Page Endpoint ---
app.get('/', async (req, res) => {
    if (!MONGODB_URI) {
        return res.send('<h2 style="font-family:sans-serif; text-align:center; color:red;">Error: MONGODB_URI is missing in Render Environment Variables.</h2>');
    }
    if (isConnected) {
        return res.send('<h2 style="font-family:sans-serif; text-align:center; color:green;">✅ Bot is active and connected to WhatsApp!</h2>');
    }
    if (currentQR) {
        try {
            const qrImageUrl = await QRCode.toDataURL(currentQR);
            return res.send(`
                <div style="text-align:center; padding:30px; font-family:sans-serif;">
                    <h2>Scan this QR Code with WhatsApp</h2>
                    <img src="${qrImageUrl}" style="width:260px; height:260px; border:2px solid #ccc; border-radius:8px;" />
                    <p style="color:#666;">Open WhatsApp > Linked Devices > Link a device</p>
                </div>
            `);
        } catch (err) {
            return res.send('Error rendering QR code.');
        }
    }
    res.send('<h2 style="font-family:sans-serif; text-align:center;">Bot is starting... Please refresh in 5 seconds.</h2>');
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// --- 2. MongoDB Authentication Adapter ---
async function useMongoDBAuthState(collection) {
    const writeData = async (data, id) => {
        const informationToStore = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
        await collection.updateOne({ _id: id }, { $set: { data: informationToStore } }, { upsert: true });
    };
    
    const readData = async (id) => {
        try {
            const doc = await collection.findOne({ _id: id });
            return doc ? JSON.parse(JSON.stringify(doc.data), BufferJSON.reviver) : null;
        } catch (error) {
            return null;
        }
    };
    
    const removeData = async (id) => {
        await collection.deleteOne({ _id: id });
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async id => {
                        let value = await readData(`${type}-${id}`);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
}

// --- 3. WhatsApp Bot Logic ---
const BLOCKED_DOMAINS = [
    'chat.whatsapp.com', 
    'wa.me',             
    't.me',              
    'bit.ly',            
    'tinyurl.com',       
    'cutt.ly',           
    'shorte.st'          
];

const warnings = new Map();
const messageTracker = new Map();
const SPAM_WINDOW_MS = 5000; // 5 seconds
const SPAM_MSG_LIMIT = 10;   // Max 10 messages

async function startBot() {
    if (!MONGODB_URI) {
        return console.log('Waiting for MongoDB URI to be added in Render...');
    }
    
    // Connect to MongoDB
    const mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
    const collection = mongoClient.db('whatsapp_bot').collection('auth_session');
    
    // Load session from Database
    const { state, saveCreds } = await useMongoDBAuthState(collection);
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            currentQR = qr;
            qrcodeTerminal.generate(qr, { small: true });
        }
        if (connection === 'open') {
            isConnected = true;
            currentQR = null;
            console.log('✅ Bot is ready and connected!');
        }
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) startBot(); // Auto-reconnect
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        if (!chatId.endsWith('@g.us')) return; // Ignore private messages

        const author = msg.key.participant;
        const number = author.split('@')[0];
        const trackerKey = `${chatId}-${author}`;
        const now = Date.now();

        // -- Anti-Flood / Spam Control --
        let userMessages = messageTracker.get(trackerKey) || [];
        userMessages = userMessages.filter(timestamp => now - timestamp < SPAM_WINDOW_MS);
        userMessages.push(now);
        messageTracker.set(trackerKey, userMessages);

        if (userMessages.length >= SPAM_MSG_LIMIT) {
            messageTracker.delete(trackerKey);
            warnings.delete(trackerKey);
            await sock.sendMessage(chatId, { 
                text: `@${number} Anti-Spam triggered. You are sending messages too fast. Removing you from the group.`, 
                mentions: [author] 
            });
            await sock.groupParticipantsUpdate(chatId, [author], 'remove');
            return; // Stop processing further
        }

        // -- Anti-Link Control --
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const linkRegex = /(https?:\/\/[^\s]+)/g;
        const links = text.match(linkRegex);

        if (links) {
            const isBlocked = links.some(link => 
                BLOCKED_DOMAINS.some(domain => link.toLowerCase().includes(domain))
            );
            
            if (isBlocked) {
                const count = (warnings.get(trackerKey) || 0) + 1;
                warnings.set(trackerKey, count);

                try {
                    await sock.sendMessage(chatId, { delete: msg.key });
                } catch (err) {
                    console.log('Failed to delete message. Bot must be an Admin.');
                }

                if (count >= 3) {
                    await sock.sendMessage(chatId, { 
                        text: `@${number} 3 warnings reached for sending invites/spam. Removing you from the group.`, 
                        mentions: [author] 
                    });
                    await sock.groupParticipantsUpdate(chatId, [author], 'remove');
                    warnings.delete(trackerKey);
                } else {
                    await sock.sendMessage(chatId, { 
                        text: `@${number} Warning ${count}/3: Group invites and spam links are strictly prohibited.`, 
                        mentions: [author] 
                    });
                }
            }
        }
    });
}

startBot();
