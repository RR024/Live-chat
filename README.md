# LiveChat — End-to-End Encrypted

🔗 **Live Demo: [https://live-chat-hqp9.onrender.com](https://live-chat-hqp9.onrender.com)**

A real-time group chat app where **the server never sees your messages**. Messages are encrypted in the browser before being sent, and decrypted only by the intended recipients.

Built with Node.js, Socket.IO, and TweetNaCl. No accounts. No message logs. No snooping.

---

## Features

- 🔐 **True E2E encryption** — Curve25519 key exchange + XSalsa20-Poly1305 (NaCl box)
- 💬 **Real-time messaging** — typing indicators, join/leave events, live user list
- 🏠 **Private rooms** — create or join any room by ID; share the ID to invite others
- 😊 **Emoji & sticker pickers** — categorised emoji panel and sticker packs
- 🌐 **Instant public URL** — zero-config SSH tunnel via localhost.run (no account needed)
- 🔄 **Auto-reconnect tunnel** — exponential backoff restarts the tunnel if it drops
- 🛡️ **Security hardened** — Helmet headers, HTTP rate limiting, per-socket message rate limiting
- 📱 **Mobile responsive** — sliding sidebar overlay on small screens
- 🚀 **Deploy-ready** — Railway and Render config included

---

## How E2E Encryption Works

```
Browser A                      Server                      Browser B
─────────────────────────────────────────────────────────────────────
generate keypair A                                  generate keypair B
send pubKey_A ──────────────────────────────────────────► exchange
                                                    send pubKey_B ──►
◄─────────────────── relay pubKey_B                receive pubKey_A

encrypt(msg, pubKey_B, privKey_A) ──► relay ciphertext ──►
                                                    decrypt(ct, pubKey_A, privKey_B)
```

1. Each user generates an ephemeral **Curve25519 key pair** in the browser on join.
2. Public keys are exchanged via the server — the server only ever sees public keys, never plaintext.
3. Every message is encrypted with **`nacl.box`** (Curve25519 + XSalsa20 + Poly1305), using the recipient's public key and the sender's private key.
4. A fresh random **24-byte nonce** is generated per message.
5. The server routes only ciphertext + nonce. It cannot decrypt anything.
6. Keys are ephemeral — never stored, lost on page close.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ |
| Server framework | Express |
| Real-time | Socket.IO |
| Encryption | TweetNaCl (`nacl.box`) |
| Security headers | Helmet |
| Rate limiting | express-rate-limit |
| Frontend | Vanilla JS, CSS |
| Tunnel | localhost.run (SSH) |

---

## Quick Start

### Requirements

- Node.js 18+
- SSH (built into Windows 10/11, macOS, and Linux)

### Install & Run

```bash
git clone <your-repo-url>
cd live-chat
npm install

# LAN access only (share your local IP with people on the same WiFi):
npm start

# Public internet access — share with anyone anywhere:
npm run tunnel
```

Open `http://localhost:3000` in your browser. Share the **PUBLIC** URL printed by the tunnel command with anyone you want to chat with.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `ALLOWED_ORIGIN` | `*` | Restrict Socket.IO CORS to a specific origin in production |

---

## Deploying

### Railway

1. Push the repo to GitHub.
2. Create a new Railway project → **Deploy from GitHub repo**.
3. Railway auto-detects `Procfile` and sets the start command.

### Render

The included `render.yaml` configures the web service automatically. Connect your repo to Render and it will deploy on push.

---

## Project Structure

```
app-core.js       — Shared Express + Socket.IO server logic
server.js         — Entry point for local and deployed use
tunnel.js         — Starts server + auto-reconnecting SSH tunnel (localhost.run)
public/
  index.html      — UI markup
  app.js          — Client-side logic, socket event handling
  crypto.js       — E2E encryption wrapper around TweetNaCl
  style.css       — Dark theme
  emojis.js       — Emoji picker data
  stickers.js     — Sticker pack data
```

---

## Security Highlights

| Layer | Detail |
|---|---|
| Transport | HTTPS/WSS when deployed (Render/Railway provide TLS) |
| End-to-end | Messages encrypted before leaving the browser; server sees only ciphertext |
| Security headers | `helmet` sets `X-Frame-Options`, `X-Content-Type-Options`, HSTS, etc. |
| HTTP rate limiting | 200 requests per minute per IP |
| Socket rate limiting | Max 10 messages per second per connection |
| XSS prevention | All user content rendered via `textContent`, never `innerHTML` |
| Message size cap | 100 KB server-side, 2 000 chars client-side |
| Input validation | Room ID and username validated on both client and server |
| Key hygiene | Ephemeral key pairs generated fresh each session, never persisted |

---

## License

MIT
