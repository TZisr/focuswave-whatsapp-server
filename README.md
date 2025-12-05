# FocusWave WhatsApp Server

Node.js backend server for real WhatsApp integration with FocusWave.

## Quick Start

### Local Development

```bash
cd whatsapp-server
npm install
npm start
```

Server runs at `http://localhost:3001`

### Docker Deployment

```bash
cd whatsapp-server
docker-compose up -d
```

## Deploy to Production

### Option 1: Railway (Recommended)

1. Create account at [railway.app](https://railway.app)
2. New Project → Deploy from GitHub repo
3. Select this folder or upload files
4. Railway auto-detects Dockerfile
5. Get your URL: `https://your-app.railway.app`

### Option 2: Render

1. Create account at [render.com](https://render.com)
2. New → Web Service → Connect repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Get your URL: `https://your-app.onrender.com`

### Option 3: VPS (DigitalOcean, Linode, etc.)

```bash
# SSH into your server
ssh user@your-server

# Clone or upload the whatsapp-server folder
git clone your-repo
cd whatsapp-server

# Run with Docker
docker-compose up -d

# Or run directly with Node
npm install
npm start
```

## Connect to FocusWave

Once deployed, add your server URL as a secret in Lovable Cloud:

1. Go to your FocusWave project in Lovable
2. Settings → Secrets
3. Add: `WHATSAPP_SERVER_URL` = `https://your-server-url.com`

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/status` | GET | Connection status |
| `/qr` | GET | QR code for scanning |
| `/chats` | GET | All chats with messages |
| `/chats/:id/messages` | GET | Messages for specific chat |
| `/disconnect` | POST | Logout from WhatsApp |
| `/health` | GET | Health check |

## Session Persistence

The WhatsApp session is stored in `./whatsapp-session` folder. When using Docker, this is persisted in a volume so you don't need to scan the QR code after restarts.

## Troubleshooting

### QR Code not appearing
- Wait 10-30 seconds for initialization
- Check server logs for errors
- Ensure Chromium is installed (Docker handles this)

### Connection drops
- Check your server's memory (needs ~512MB+)
- WhatsApp may disconnect after inactivity
- Session will auto-reconnect on next request

### CORS errors
- Server allows all origins by default
- For production, configure specific origins in `server.js`
