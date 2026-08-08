const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const app = express();
const PORT = process.env.PORT || 10000;

let currentQR = null;
let isConnected = false;

// 1. Web Page Endpoint (Shows QR code as a clean image on your browser)
app.get('/', async (req, res) => {
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
                    <p style="font-size:12px; color:#999;">If scanning fails, refresh this page to get a fresh QR code.</p>
                </div>
            `);
        } catch (err) {
            return res.send('Error rendering QR code.');
        }
    }
    res.send('<h2 style="font-family:sans-serif; text-align:center;">Bot is starting... Please refresh in 5 seconds.</h2>');
});

app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// 2. WhatsApp Bot Logic
const ALLOWED_DOMAINS = ['youtube.com', 'madh-site.com'];
const warnings = new Map();

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
            console.log('New QR Code generated! Open your Render URL to view it.');
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
                    await sock.sendMessage(chatId, { text: '3 warnings reached. Removing user from group.' }, { quoted: msg });
                    await sock.groupParticipantsUpdate(chatId, [author], 'remove');
                    warnings.delete(key);
                } else {
                    await sock.sendMessage(chatId, { text: `Warning ${count}/3: Unauthorized links are not allowed in this group.` }, { quoted: msg });
                }
            }
        }
    });
}

connectToWhatsApp();
