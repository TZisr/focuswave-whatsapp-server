const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

// State
let currentQR = null;
let sock = null;
let isConnected = false;
let isInitializing = true;
let connectionInfo = null;

async function connectToWhatsApp() {
  console.log('🚀 Starting WhatsApp connection...');
  isInitializing = true;
  
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  
  sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' })
  });
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log('📱 QR Code received');
      isInitializing = false;
      try {
        currentQR = await QRCode.toDataURL(qr);
        console.log('✅ QR Code ready for scanning');
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }
    
    if (connection === 'close') {
      isConnected = false;
      currentQR = null;
      
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log('🔌 Connection closed. Status code:', statusCode);
      
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('Should reconnect:', shouldReconnect);
      
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      console.log('✅ Connected to WhatsApp!');
      isConnected = true;
      isInitializing = false;
      currentQR = null;
      
      connectionInfo = {
        pushname: sock.user?.name || 'Unknown',
        phone: sock.user?.id?.split(':')[0] || 'Unknown'
      };
      console.log('📞 Logged in as:', connectionInfo.pushname);
    }
  });
}

// Start connection
connectToWhatsApp();

// Routes
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    authenticated: isConnected,
    scanning: !isConnected && currentQR !== null,
    initializing: isInitializing,
    info: connectionInfo
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, qr: null });
  }
  
  if (!currentQR) {
    return res.status(503).json({ 
      error: 'QR code not available yet',
      message: 'Waiting for QR code...',
      initializing: isInitializing
    });
  }
  
  res.json({ qr: currentQR });
});

app.get('/chats', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'Not connected' });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    const chats = Object.values(groups || {}).slice(0, 50).map(chat => ({
      id: chat.id,
      name: chat.subject || 'Unknown',
      isGroup: true,
      participants: chat.participants?.length || 0,
      messages: []
    }));
    res.json({ chats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) await sock.logout();
    isConnected = false;
    currentQR = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isConnected });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
