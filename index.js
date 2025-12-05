const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = './auth_state';

// ============ EXPRESS SETUP ============
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ============ LOGGER ============
const logger = pino({ 
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
}).child({ module: 'baileys' });

// Silence baileys internal logs
const baileysLogger = pino({ level: 'silent' });

// ============ STATE ============
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
let userInfo = null;

// ============ WHATSAPP CONNECTION ============
async function connectWhatsApp() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Initializing WhatsApp connection...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  connectionStatus = 'connecting';
  qrCode = null;

  try {
    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    
    // Get latest WA version
    const { version } = await fetchLatestBaileysVersion();
    console.log(`📱 WhatsApp Web version: ${version.join('.')}`);

    // Create socket
    sock = makeWASocket({
      version,
      logger: baileysLogger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, baileysLogger)
      },
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    // ===== CONNECTION EVENTS =====
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      // QR Code received
      if (qr) {
        console.log('📲 QR Code generated - scan with WhatsApp!');
        connectionStatus = 'waiting_for_scan';
        try {
          qrCode = await QRCode.toDataURL(qr);
        } catch (err) {
          console.error('Failed to generate QR:', err.message);
        }
      }

      // Connection opened
      if (connection === 'open') {
        console.log('✅ Connected to WhatsApp!');
        connectionStatus = 'connected';
        qrCode = null;
        userInfo = {
          name: sock.user?.name || 'Unknown',
          id: sock.user?.id?.split(':')[0] || 'Unknown'
        };
        console.log(`👤 Logged in as: ${userInfo.name} (${userInfo.id})`);
      }

      // Connection closed
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.output?.payload?.message || 'Unknown';
        
        console.log(`🔌 Disconnected: ${reason} (code: ${statusCode})`);
        connectionStatus = 'disconnected';
        qrCode = null;
        userInfo = null;

        // Handle different disconnect reasons
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('🚪 Logged out - clearing session...');
          // Clear auth state
          const fs = require('fs');
          if (fs.existsSync(AUTH_FOLDER)) {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
          }
          // Restart to get new QR
          setTimeout(connectWhatsApp, 2000);
        } else if (statusCode === DisconnectReason.restartRequired) {
          console.log('🔄 Restart required...');
          setTimeout(connectWhatsApp, 1000);
        } else if (statusCode !== DisconnectReason.connectionClosed) {
          // Auto-reconnect for other errors
          console.log('🔄 Reconnecting in 3 seconds...');
          setTimeout(connectWhatsApp, 3000);
        }
      }
    });

    // ===== CREDENTIALS UPDATE =====
    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error('❌ Connection error:', err.message);
    connectionStatus = 'error';
    // Retry after error
    setTimeout(connectWhatsApp, 5000);
  }
}

// ============ API ROUTES ============

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'running',
    connected: connectionStatus === 'connected',
    uptime: Math.floor(process.uptime())
  });
});

// Connection status
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    hasQR: qrCode !== null,
    user: userInfo
  });
});

// Get QR code
app.get('/qr', (req, res) => {
  if (connectionStatus === 'connected') {
    return res.json({ 
      status: 'connected',
      message: 'Already connected to WhatsApp',
      qr: null 
    });
  }

  if (!qrCode) {
    return res.status(202).json({ 
      status: connectionStatus,
      message: 'QR code not ready yet, please wait...',
      qr: null 
    });
  }

  res.json({ 
    status: 'waiting_for_scan',
    qr: qrCode 
  });
});

// Get all group chats
app.get('/chats', async (req, res) => {
  if (connectionStatus !== 'connected' || !sock) {
    return res.status(503).json({ 
      error: 'Not connected',
      status: connectionStatus 
    });
  }

  try {
    const groups = await sock.groupFetchAllParticipating();
    const chatList = Object.values(groups).map(group => ({
      id: group.id,
      name: group.subject || 'Unknown Group',
      participants: group.participants?.length || 0,
      creation: group.creation,
      desc: group.desc || ''
    }));

    res.json({ 
      count: chatList.length,
      chats: chatList 
    });
  } catch (err) {
    console.error('Error fetching chats:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Disconnect / Logout
app.post('/disconnect', async (req, res) => {
  if (!sock) {
    return res.json({ success: true, message: 'Already disconnected' });
  }

  try {
    await sock.logout();
    connectionStatus = 'disconnected';
    qrCode = null;
    userInfo = null;
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force restart connection
app.post('/restart', (req, res) => {
  console.log('🔄 Manual restart requested');
  if (sock) {
    try { sock.end(); } catch (e) {}
  }
  connectionStatus = 'disconnected';
  qrCode = null;
  setTimeout(connectWhatsApp, 500);
  res.json({ success: true, message: 'Restarting...' });
});

// ============ START SERVER ============
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║     FocusWave WhatsApp Server         ║');
  console.log('╚═══════════════════════════════════════╝');
  console.log(`🌐 Server running on port ${PORT}`);
  console.log('');
  
  // Start WhatsApp connection
  connectWhatsApp();
});
