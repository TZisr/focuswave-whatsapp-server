const express = require('express');
const cors = require('cors');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');

const app = express();
const PORT = process.env.PORT || 3001;

// CORS - allow all origins (configure for production)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// State
let currentQR = null;
let isConnected = false;
let clientInfo = null;

// Initialize WhatsApp client with local session storage
const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: './whatsapp-session'
  }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

// Event handlers
client.on('qr', async (qr) => {
  console.log('📱 QR Code generated - scan with WhatsApp');
  try {
    // Generate QR code as data URL for frontend display
    currentQR = await QRCode.toDataURL(qr);
    console.log('✅ QR Code ready for scanning');
  } catch (err) {
    console.error('❌ QR generation error:', err);
    currentQR = qr; // Fallback to raw string
  }
});

client.on('authenticated', () => {
  console.log('🔐 Authentication successful');
  currentQR = null;
});

client.on('auth_failure', (msg) => {
  console.error('❌ Authentication failed:', msg);
  isConnected = false;
  currentQR = null;
});

client.on('ready', () => {
  console.log('✅ WhatsApp client is ready!');
  isConnected = true;
  currentQR = null;
  clientInfo = client.info;
  console.log('📞 Connected as:', clientInfo?.pushname || 'Unknown');
});

client.on('disconnected', (reason) => {
  console.log('🔌 Client disconnected:', reason);
  isConnected = false;
  clientInfo = null;
});

client.on('loading_screen', (percent, message) => {
  console.log(`⏳ Loading: ${percent}% - ${message}`);
});

// Initialize client
console.log('🚀 Starting WhatsApp client...');
client.initialize().catch(err => {
  console.error('❌ Failed to initialize client:', err);
});

// Routes

// GET /status - Connection status
app.get('/status', (req, res) => {
  console.log('📡 Status check - connected:', isConnected);
  res.json({
    connected: isConnected,
    authenticated: isConnected,
    scanning: !isConnected && currentQR !== null,
    info: isConnected ? {
      pushname: clientInfo?.pushname,
      phone: clientInfo?.wid?.user
    } : null
  });
});

// GET /qr - Get QR code for scanning
app.get('/qr', (req, res) => {
  if (isConnected) {
    console.log('📱 QR requested but already connected');
    return res.json({ connected: true, qr: null });
  }
  
  if (!currentQR) {
    console.log('📱 QR not ready yet');
    return res.status(503).json({ 
      error: 'QR code not available yet',
      message: 'Please wait for the QR code to be generated'
    });
  }
  
  console.log('📱 Serving QR code');
  res.json({ qr: currentQR });
});

// GET /chats - Get all chats with recent messages
app.get('/chats', async (req, res) => {
  if (!isConnected) {
    return res.status(503).json({ 
      error: 'WhatsApp not connected',
      message: 'Please scan the QR code first'
    });
  }

  try {
    console.log('📋 Fetching chats...');
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
          console.error(`Error fetching messages for chat ${chat.name}:`, err.message);
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

    console.log(`✅ Returning ${formattedChats.length} chats`);
    res.json({ chats: formattedChats });
  } catch (err) {
    console.error('❌ Error fetching chats:', err);
    res.status(500).json({ error: 'Failed to fetch chats', message: err.message });
  }
});

// GET /chats/:id/messages - Get messages for specific chat
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
    console.error('❌ Error fetching messages:', err);
    res.status(500).json({ error: 'Failed to fetch messages', message: err.message });
  }
});

// POST /disconnect - Disconnect the client
app.post('/disconnect', async (req, res) => {
  try {
    await client.logout();
    res.json({ success: true, message: 'Disconnected successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect', message: err.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', connected: isConnected });
});

// Start server
app.listen(PORT, () => {
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
╚═══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  try {
    await client.destroy();
  } catch (err) {
    console.error('Error during shutdown:', err);
  }
  process.exit(0);
});
