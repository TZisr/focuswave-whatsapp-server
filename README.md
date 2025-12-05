# FocusWave WhatsApp Server

WhatsApp bridge server using Baileys for FocusWave dashboard.

## Deploy to Railway

### Option 1: One-Click Deploy
1. Push this folder to a GitHub repository
2. Go to [railway.app](https://railway.app)
3. Click **New Project** → **Deploy from GitHub repo**
4. Select your repository
5. Railway will auto-detect and deploy

### Option 2: Railway CLI
```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/status` | Connection status |
| GET | `/qr` | Get QR code (base64 data URL) |
| GET | `/chats` | List all group chats |
| POST | `/disconnect` | Logout from WhatsApp |
| POST | `/restart` | Force restart connection |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port (set by Railway) |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |

## Local Development

```bash
cd whatsapp-server
npm install
npm start
```

Server runs at http://localhost:3000

## Connect to FocusWave

After deploying, add the Railway URL as a secret in Lovable:
1. Go to project Settings → Secrets
2. Add `WHATSAPP_SERVER_URL` = `https://your-app.railway.app`

## Session Persistence

- Auth state is stored in `./auth_state/`
- On Railway, enable a volume mount for `/app/auth_state` for persistence
- Without a volume, you'll need to scan QR after each deploy

## Troubleshooting

### QR not appearing
- Wait 10-20 seconds for initialization
- Check `/status` endpoint for current state
- Use `/restart` to force reconnection

### Connection keeps dropping
- Normal during initial pairing (reconnects automatically)
- Check Railway logs for specific errors
- Ensure no other devices are using this WhatsApp account
