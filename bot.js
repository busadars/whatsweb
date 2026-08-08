const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 10000;

let currentQR = null;
let isConnected = false;

// 1. Web Page Endpoint
app.get('/', async (req, res) => {
    if (isConnected) {
        return res.send('✅ Bot is active and connected to WhatsApp!');
    }
    if (currentQR) {
        try {
            const qrImageUrl = await QRCode.toDataURL(currentQR);
            return res.send(`
                
                    Scan this QR Code with WhatsApp
                    
                    Open WhatsApp > Linked Devices > Link a device
                
            `);
        } catch (err) {
            return res.send('Error rendering QR code.');
        }
    }
    res.send('Bot is starting... Please refresh in 5 seconds.');
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// 2. WhatsApp Bot Logic
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

// Flood Control Variables
const messageTracker = new Map();
const SPAM_WINDOW_MS = 5000; // 5 seconds (time window)
const SPAM_MSG_LIMIT = 10;   // 10 messages max within the window

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
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
            if (shouldReconnect) connectToWhatsApp();
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        if (!chatId.endsWith('@g.us')) return; // Group messages only

        const author = msg.key.participant;
        const number = author.split('@')[0];
        const trackerKey = `${chatId}-${author}`;
        const now = Date.now();

        // --- 1. FLOOD CONTROL SYSTEM ---
        let userMessages = messageTracker.get(trackerKey) || [];
        
        // Remove timestamps older than 5 seconds
        userMessages = userMessages.filter(timestamp => now - timestamp < SPAM_WINDOW_MS);
        userMessages.push(now); // Add current message timestamp
        messageTracker.set(trackerKey, userMessages);

        if (userMessages.length >= SPAM_MSG_LIMIT) {
            // Clear their tracker so the bot doesn't spam the kick message while processing
            messageTracker.delete(trackerKey);
            warnings.delete(trackerKey); // Reset standard warnings since they are being kicked

            await sock.sendMessage(chatId, { 
                text: `@${number} Anti-Spam triggered: You are sending messages too fast. Removing you from the group.`,
                mentions: [author]
            });
            await sock.groupParticipantsUpdate(chatId, [author], 'remove');
            return; // Stop processing this message to avoid triggering link warnings
        }

        // --- 2. ANTI-LINK SYSTEM ---
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
                    console.log('Failed to delete message.');
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

connectToWhatsApp();
