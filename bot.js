const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');

// 1. Dummy Web Server to keep Render awake
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is active 24/7'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// 2. Bot Logic
const ALLOWED_DOMAINS = ['youtube.com', 'madh-site.com'];
const warnings = new Map();

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }) // Suppresses huge logs so the QR code is readable
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectToWhatsApp();
        } else if (connection === 'open') {
            console.log('Bot is ready and connected!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const chatId = msg.key.remoteJid;
        if (!chatId.endsWith('@g.us')) return; // Group messages only

        // Extract text from both standard and extended messages (link previews)
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        const linkRegex = /(https?:\/\/[^\s]+)/g;
        const links = text.match(linkRegex);

        if (links) {
            const isAllowed = links.every(link => ALLOWED_DOMAINS.some(domain => link.includes(domain)));
            
            if (!isAllowed) {
                const author = msg.key.participant;
                const key = `${chatId}-${author}`;
                
                const count = (warnings.get(key) || 0) + 1;
                warnings.set(key, count);

                if (count >= 3) {
                    await sock.sendMessage(chatId, { text: '3 warnings reached. Removing from group.' }, { quoted: msg });
                    await sock.groupParticipantsUpdate(chatId, [author], 'remove');
                    warnings.delete(key);
                } else {
                    await sock.sendMessage(chatId, { text: `Warning ${count}/3: Unauthorized links are not allowed.` }, { quoted: msg });
                }
            }
        }
    });
}

connectToWhatsApp();
