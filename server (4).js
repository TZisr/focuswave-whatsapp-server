const express = require('express');
const cors = require('cors');
const QRCode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const pino = require('pino');
const fs = require('fs');
const { 
  default: makeWASocket, 
  DisconnectReason, 
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 8080;

const logger = pino({ level: 'silent' });

app.use(cors({ origin: '*' }));
app.use(express.json());

// State
let currentQR = null;
let sock = null;
let isConnected = false;
let isInitializing = true;
let initError = null;
let connectionInfo = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// Clear corrupted session if needed
function clearSession() {
  const sessionPath = './whatsapp-session';
  if (fs.existsSync(sessionPath)) {
    console.log('🧹 Clearing old session...');
    fs.rmSync(sessionPath, { recursive: true, force: true });
  }
}

async function connectToWhatsApp(forceNew = false) {
  console.log('🚀 Starting WhatsApp connection...');
  isInitializing = true;
  initError = null;
  
  if (forceNew) {
    clearSession();
    reconnectAttempts = 0;
  }
  
  try {
    const { state, saveCreds } = await useMultiFileAuthState('./whatsapp-session');
    
    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: true,
      browser: Browsers.ubuntu('Chrome'),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      emitOwnEvents: false,
      generateHighQualityLinkPreview: false,
      syncFullHistory: false,
      markOnlineOnConnect: false
    });

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      
      if (qr) {
        console.log('📱 QR Code generated - scan with WhatsApp!');
        isInitializing = false;
        reconnectAttempts = 0;
        try {
          currentQR = await QRCode.toDataURL(qr, { width: 256, margin: 2 });
          qrcodeTerminal.generate(qr, { small: true });
        } catch (err) {
          console.error('QR error:', err.message);
        }
      }
      
      if (connection === 'close') {
        isConnected = false;
        currentQR = null;
        
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = DisconnectReason[statusCode] || statusCode;
        console.log('🔌 Disconnected. Reason:', reason);
        
        // Handle different disconnect reasons
        if (statusCode === DisconnectReason.loggedOut) {
          console.log('👋 Logged out - clearing session');
          clearSession();
          setTimeout(() => connectToWhatsApp(true), 3000);
        } else if (statusCode === DisconnectReason.badSession) {
          console.log('❌ Bad session - clearing and retrying');
          clearSession();
          setTimeout(() => connectToWhatsApp(true), 3000);
        } else if (statusCode === DisconnectReason.connectionClosed || 
                   statusCode === DisconnectReason.connectionLost ||
                   statusCode === DisconnectReason.timedOut ||
                   statusCode === undefined) {
          reconnectAttempts++;
          if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            console.log(`🔄 Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
            setTimeout(connectToWhatsApp, 3000 * reconnectAttempts);
          } else {
            console.log('❌ Max reconnect attempts reached, clearing session');
            clearSession();
            reconnectAttempts = 0;
            setTimeout(() => connectToWhatsApp(true), 5000);
          }
        } else {
          console.log('🔄 Unknown disconnect, retrying...');
          setTimeout(connectToWhatsApp, 5000);
        }
      } else if (connection === 'open') {
        console.log('✅ WhatsApp connected!');
        isConnected = true;
        isInitializing = false;
        currentQR = null;
        reconnectAttempts = 0;
        
        const user = sock.user;
        connectionInfo = {
          pushname: user?.name || 'Unknown',
          phone: user?.id?.split(':')[0] || 'Unknown'
        };
        console.log('📞 Connected as:', connectionInfo.pushname);
      } else if (connection === 'connecting') {
        console.log('⏳ Connecting...');
      }
    });

    sock.ev.on('creds.update', saveCreds);
    
  } catch (err) {
    console.error('❌ Init error:', err.message);
    initError = err.message;
    isInitializing = false;
    
    // Clear session on init error and retry
    clearSession();
    setTimeout(() => connectToWhatsApp(true), 5000);
  }
}

// Start connection
connectToWhatsApp(true); // Start fresh

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
    return res.status(500).json({ error: 'Init failed', message: initError });
  }
  
  if (!currentQR) {
    return res.status(503).json({ 
      error: 'QR code not available yet',
      message: isInitializing ? 'Starting...' : 'Waiting for QR...',
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
    clearSession();
    isConnected = false;
    currentQR = null;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/reset', (req, res) => {
  console.log('🔄 Manual reset requested');
  clearSession();
  isConnected = false;
  currentQR = null;
  reconnectAttempts = 0;
  setTimeout(() => connectToWhatsApp(true), 1000);
  res.json({ success: true, message: 'Resetting connection...' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isConnected, initializing: isInitializing });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║         FocusWave WhatsApp Server (Baileys)               ║
║  Port: ${PORT}                                               ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));