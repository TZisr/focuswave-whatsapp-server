const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const fs = require('fs');

// ============ CONFIG ============
const PORT = process.env.PORT || 3000;
const AUTH_FOLDER = './auth_state';

// ============ EXPRESS SETUP ============
const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// ============ LOGGER ============
const logger = pino({ level: 'silent' });

// ============ STATE ============
let sock = null;
let qrCode = null;
let connectionStatus = 'initializing';
let userInfo = null;

// ============ WHATSAPP CONNECTION ============
async function connectWhatsApp() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 Starting WhatsApp connection...');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  
  connectionStatus = 'connecting';
  qrCode = null;

  try {
    // Ensure auth folder exists
    if (!fs.existsSync(AUTH_FOLDER)) {
      fs.mkdirSync(AUTH_FOLDER, { recursive: true });
    }

    // Load auth state
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    
    // Get latest WA version
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`📱 Using WA v${version.join('.')}, isLatest: ${isLatest}`);

    // Create socket - minimal config following official docs
    sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: true,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ['FocusWave', 'Chrome', '120.0.0'],
      generateHighQualityLinkPreview: false
    });

    // ===== CONNECTION EVENTS =====
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      console.log(`Connection update: ${JSON.stringify({ connection, hasQr: !!qr })}`);
      
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
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        console.log(`🔌 Connection closed. Code: ${statusCode}, Error: ${error?.message || 'none'}, Reconnect: ${shouldReconnect}`);
        
        connectionStatus = 'disconnected';
        qrCode = null;
        userInfo = null;

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('🚪 Logged out - clearing session...');
          clearAuthState();
        }
        
        if (shouldReconnect) {
          console.log('🔄 Reconnecting in 5s...');
          setTimeout(connectWhatsApp, 5000);
        }
      }
    });

    // ===== CREDENTIALS UPDATE =====
    sock.ev.on('creds.update', saveCreds);

  } catch (err) {
    console.error('❌ Connection error:', err.message);
    connectionStatus = 'error';
    setTimeout(connectWhatsApp, 5000);
  }
}

function clearAuthState() {
  try {
    if (fs.existsSync(AUTH_FOLDER)) {
      fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
      console.log('🧹 Auth state cleared');
    }
  } catch (e) {
    console.error('Failed to clear auth state:', e.message);
  }
}

// ============ API ROUTES ============

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok',
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
  userInfo = null;
  setTimeout(connectWhatsApp, 500);
  res.json({ success: true, message: 'Restarting connection...' });
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
