const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 8080;

// Quieter logger for production
const logger = pino({ level: 'warn' });

app.use(cors({ origin: '*' }));
app.use(express.json());

// State
let currentQR = null;
let sock = null;
let isConnected = false;
let isInitializing = true;
let initError = null;
let connectionInfo = null;

async function connectToWhatsApp() {
  console.log('🚀 Starting WhatsApp connection...');
  isInitializing = true;
  initError = null;
  
  try {
    // Get auth state from file system
    const { state, saveCreds } = await useMultiFileAuthState('./whatsapp-session');
    
    // Fetch latest version
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 Using WA version: ${version.join('.')}`);
    
    // Create socket
    sock = makeWASocket({
      version,
      auth: state,
      logger,
      printQRInTerminal: true,
      browser: ['FocusWave', 'Chrome', '120.0.0'],
      syncFullHistory: false
    });

    // Connection update handler
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('📱 QR Code generated');
        isInitializing = false;
        try {
          currentQR = await QRCode.toDataURL(qr, {
            width: 256,
            margin: 2
          });
          qrcodeTerminal.generate(qr, { small: true });
        } catch (err) {
          console.error('QR generation error:', err);
        }
      }
      
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log('🔌 Connection closed. Status:', statusCode);
        isConnected = false;
        currentQR = null;
        
        if (shouldReconnect) {
          console.log('🔄 Reconnecting...');
          setTimeout(connectToWhatsApp, 3000);
        } else {
          console.log('👋 Logged out, not reconnecting');
          initError = 'Logged out from WhatsApp';
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected!');
        isConnected = true;
        isInitializing = false;
        currentQR = null;
        
        // Get connection info
        const user = sock.user;
        connectionInfo = {
          pushname: user?.name || 'Unknown',
          phone: user?.id?.split(':')[0] || 'Unknown'
        };
        console.log('📞 Connected as:', connectionInfo.pushname);
      }
    });

    // Save credentials when updated
    sock.ev.on('creds.update', saveCreds);

    console.log('✅ Socket created, waiting for connection...');
    
  } catch (err) {
    console.error('❌ Failed to initialize:', err.message);
    initError = err.message;
    isInitializing = false;
  }
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
    error: initError,
    info: isConnected ? connectionInfo : null
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, qr: null });
  }
  
  if (initError) {
    return res.status(500).json({ 
      error: 'Initialization failed',
      message: initError
    });
  }
  
  if (!currentQR) {
    return res.status(503).json({ 
      error: 'QR code not available yet',
      message: isInitializing ? 'Starting up...' : 'Waiting for QR...',
      initializing: isInitializing
    });
  }
  
  res.json({ qr: currentQR });
});

app.get('/chats', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ 
      error: 'WhatsApp not connected',
      message: 'Please scan the QR code first'
    });
  }

  try {
    // Get all chats from store
    const chats = await sock.groupFetchAllParticipating();
    const chatList = Object.values(chats || {});
    
    // Get individual conversations too
    const store = sock.store;
    
    const formattedChats = chatList.slice(0, 50).map(chat => ({
      id: chat.id,
      name: chat.subject || chat.name || 'Unknown',
      isGroup: chat.id.includes('@g.us'),
      unreadCount: 0,
      timestamp: chat.creation ? new Date(chat.creation * 1000).toISOString() : null,
      participants: chat.participants?.length || 0,
      messages: []
    }));

    res.json({ chats: formattedChats });
  } catch (err) {
    console.error('Error fetching chats:', err);
    res.status(500).json({ error: 'Failed to fetch chats', message: err.message });
  }
});

app.get('/chats/:chatId/messages', async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    // Fetch messages
    const messages = await sock.fetchMessages(chatId, limit);
    
    res.json({
      messages: (messages || []).map(msg => ({
        id: msg.key.id,
        body: msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              '[Media]',
        author: msg.key.participant || msg.key.remoteJid,
        timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
        fromMe: msg.key.fromMe,
        type: Object.keys(msg.message || {})[0] || 'unknown'
      }))
    });
  } catch (err) {
    console.error('Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages', message: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    isConnected = false;
    currentQR = null;
    res.json({ success: true, message: 'Disconnected' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect', message: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    connected: isConnected,
    initializing: isInitializing,
    hasError: !!initError
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║         FocusWave WhatsApp Server (Baileys)               ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║  No Chromium required! 🎉                                 ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 SIGTERM received...');
  process.exit(0);
});