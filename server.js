const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS - allow all origins
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// State
let currentQR = null;
let isConnected = false;
let isInitializing = true;
let initError = null;
let clientInfo = null;

// Find Chromium - Puppeteer image has it pre-installed
const possiblePaths = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);

let CHROMIUM_PATH = null;
for (const p of possiblePaths) {
  try {
    if (fs.existsSync(p)) {
      CHROMIUM_PATH = p;
      break;
    }
  } catch (e) {
    // Ignore errors
  }
}

console.log('🌐 Chromium path:', CHROMIUM_PATH || 'Using Puppeteer default');

// Build puppeteer options
const puppeteerOptions = {
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--single-process',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-default-browser-check',
    '--safebrowsing-disable-auto-update'
  ]
};

// Only set executablePath if we found a specific one
if (CHROMIUM_PATH) {
  puppeteerOptions.executablePath = CHROMIUM_PATH;
}

// Initialize WhatsApp client
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './whatsapp-session'
  }),
  puppeteer: puppeteerOptions
});

// Event handlers
client.on('qr', async (qr) => {
  console.log('📱 QR Code generated - scan with WhatsApp');
  isInitializing = false;
  try {
    currentQR = await QRCode.toDataURL(qr, {
      width: 256,
      margin: 2,
      color: { dark: '#000000', light: '#FFFFFF' }
    });
    console.log('✅ QR Code ready for scanning');
  } catch (err) {
    console.error('❌ QR generation error:', err);
    currentQR = qr;
  }
});

client.on('authenticated', () => {
  console.log('🔐 Authentication successful');
  currentQR = null;
  isInitializing = false;
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
  isConnected = false;
  currentQR = null;
  initError = 'Authentication failed: ' + msg;
});

client.on('ready', () => {
  console.log('✅ WhatsApp client is ready!');
  isConnected = true;
  isInitializing = false;
  currentQR = null;
  clientInfo = client.info;
  console.log('📞 Connected as:', clientInfo?.pushname || 'Unknown');
});

client.on('disconnected', (reason) => {
  console.log('🔌 Client disconnected:', reason);
  isConnected = false;
  clientInfo = null;
  setTimeout(() => {
    console.log('🔄 Attempting to reinitialize...');
    client.initialize().catch(err => {
      console.error('❌ Reinitialize failed:', err.message);
    });
  }, 5000);
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Loading: ${percent}% - ${message}`);
});

// Initialize client
console.log('🚀 Starting WhatsApp client...');
client.initialize()
  .then(() => {
    console.log('✅ Client initialized successfully');
  })
  .catch(err => {
    console.error('❌ Failed to initialize client:', err.message);
    initError = err.message;
    isInitializing = false;
  });

// Routes

app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    authenticated: isConnected,
    scanning: !isConnected && currentQR !== null,
    initializing: isInitializing,
    error: initError,
    info: isConnected ? {
      pushname: clientInfo?.pushname,
      phone: clientInfo?.wid?.user
    } : null
  });
});

app.get('/qr', (req, res) => {
  if (isConnected) {
    return res.json({ connected: true, qr: null });
  }
  
  if (initError) {
    return res.status(500).json({ 
      error: 'Client initialization failed',
      message: initError
    });
  }
  
  if (!currentQR) {
    return res.status(503).json({ 
      error: 'QR code not available yet',
      message: isInitializing ? 'WhatsApp client is starting up...' : 'Please wait for the QR code to be generated',
      initializing: isInitializing
    });
  }
  
  res.json({ qr: currentQR });
});

app.get('/chats', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ 
      error: 'WhatsApp not connected',
      message: 'Please scan the QR code first'
    });
  }

  try {
    const chats = await client.getChats();
    
    const formattedChats = await Promise.all(
      chats.slice(0, 50).map(async (chat) => {
        try {
          const messages = await chat.fetchMessages({ limit: 20 });
          
          return {
            id: chat.id._serialized,
            name: chat.name || chat.id.user || 'Unknown',
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount || 0,
            timestamp: chat.timestamp ? new Date(chat.timestamp * 1000).toISOString() : null,
            lastMessage: chat.lastMessage?.body || null,
            participants: chat.isGroup ? (chat.participants?.length || 0) : null,
            messages: messages.map(msg => ({
              id: msg.id._serialized,
              body: msg.body,
              author: msg.author || msg.from,
              authorName: msg._data?.notifyName || msg.author || 'Unknown',
              timestamp: new Date(msg.timestamp * 1000).toISOString(),
              fromMe: msg.fromMe,
              hasMedia: msg.hasMedia,
              type: msg.type
            }))
          };
        } catch (err) {
          return {
            id: chat.id._serialized,
            name: chat.name || 'Unknown',
            isGroup: chat.isGroup,
            unreadCount: chat.unreadCount || 0,
            messages: []
          };
        }
      })
    );

    res.json({ chats: formattedChats });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch chats', message: err.message });
  }
});

app.get('/chats/:chatId/messages', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp not connected' });
  }

  try {
    const { chatId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    
    const chat = await client.getChatById(chatId);
    const messages = await chat.fetchMessages({ limit });
    
    res.json({
      messages: messages.map(msg => ({
        id: msg.id._serialized,
        body: msg.body,
        author: msg.author || msg.from,
        authorName: msg._data?.notifyName || 'Unknown',
        timestamp: new Date(msg.timestamp * 1000).toISOString(),
        fromMe: msg.fromMe,
        hasMedia: msg.hasMedia,
        type: msg.type
      }))
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch messages', message: err.message });
  }
});

app.post('/disconnect', async (req, res) => {
  try {
    await client.logout();
    res.json({ success: true, message: 'Disconnected successfully' });
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
║         FocusWave WhatsApp Server                         ║
╠═══════════════════════════════════════════════════════════╣
║  Server running on port ${PORT}                              ║
║  Endpoints:                                               ║
║    GET  /status  - Connection status                      ║
║    GET  /qr      - QR code for scanning                   ║
║    GET  /chats   - All chats with messages                ║
║    POST /disconnect - Logout                              ║
║    GET  /health  - Health check                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down...');
  try { await client.destroy(); } catch (e) {}
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received...');
  try { await client.destroy(); } catch (e) {}
  process.exit(0);
});
