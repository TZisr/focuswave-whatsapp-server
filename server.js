const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const P = require('pino');
const NodeCache = require('@cacheable/node-cache').default;
const { Boom } = require('@hapi/boom');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

// Logger - set to silent for production
const logger = P({ level: 'silent' });

// Message retry counter cache
const msgRetryCounterCache = new NodeCache();

// State
let currentQR = null;
let sock = null;
let isConnected = false;
let isInitializing = true;
let connectionInfo = null;

async function startSock() {
  console.log('🚀 Starting WhatsApp connection...');
  isInitializing = true;
  
  const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
  
  // Fetch latest version
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📱 Using WA v${version.join('.')}, isLatest: ${isLatest}`);
  
  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    msgRetryCounterCache,
    generateHighQualityLinkPreview: false
  });
  
  // Process events in batch (official pattern)
  sock.ev.process(async (events) => {
    // Connection update
    if (events['connection.update']) {
      const update = events['connection.update'];
      const { connection, lastDisconnect, qr } = update;
      
      console.log('Connection update:', JSON.stringify({ connection, hasQr: !!qr }));
      
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
        
        const statusCode = (lastDisconnect?.error)?.output?.statusCode;
        console.log('🔌 Connection closed. Status:', statusCode);
        
        // Reconnect if not logged out
        if (statusCode !== DisconnectReason.loggedOut) {
          console.log('🔄 Reconnecting...');
          setTimeout(startSock, 3000);
        } else {
          console.log('👋 Logged out, not reconnecting');
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
    }
    
    // Credentials update
    if (events['creds.update']) {
      await saveCreds();
    }
  });
}

// Start connection
startSock();

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
