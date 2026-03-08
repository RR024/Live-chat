/**
 * app-core.js — Express + Socket.io server with auth, TURN, push, etc.
 */

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const webpush    = require('web-push');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || '*' }
});

// ── Config ─────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'livechat-jwt-dev-secret-change-in-prod';
const DATA_DIR   = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// VAPID keys for web push
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BG5muKyULiwDyV8-VL6xX_d1vme3aq3v-GMLV1B87GDo53AjZ6wymN1zo8f6Pnl9mWrDLWaby_Qw9NGjtv3w1zg';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'bQhEf6D7UXxvU6UGkHLF4RLPhYqV8lmwRaWXwHP4BvA';
webpush.setVapidDetails('mailto:admin@livechat.app', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Helpers ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// ── Express setup ──────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '5mb' }));

// HTTP rate limiting
const limiter = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH ROUTES ────────────────────────────────────────────────────────────
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 chars, letters/numbers/underscores only.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const users = loadUsers();
  if (users[username.toLowerCase()]) return res.status(409).json({ error: 'Username already taken.' });

  const hash = await bcrypt.hash(password, 12);
  users[username.toLowerCase()] = { username, passwordHash: hash, createdAt: Date.now(), pushSubscriptions: [] };
  saveUsers(users);

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const users = loadUsers();
  const user  = users[username.toLowerCase()];
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

// ── TURN CREDENTIALS (short-lived, per-request) ───────────────────────────
app.get('/api/turn-credentials', (req, res) => {
  // Use freely available public TURN servers from Open Relay Project
  res.json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  });
});

// ── PUSH SUBSCRIPTION ─────────────────────────────────────────────────────
app.post('/api/push/subscribe', (req, res) => {
  const { subscription, username } = req.body || {};
  if (!subscription || !username) return res.status(400).json({ error: 'Missing fields.' });
  const users = loadUsers();
  const key   = username.toLowerCase();
  if (!users[key]) return res.status(404).json({ error: 'User not found.' });
  const subs = users[key].pushSubscriptions || [];
  const endpoint = subscription.endpoint;
  if (!subs.find(s => s.endpoint === endpoint)) {
    subs.push(subscription);
    users[key].pushSubscriptions = subs.slice(-5); // keep last 5
    saveUsers(users);
  }
  res.json({ ok: true });
});

// ── VAPID public key endpoint ──────────────────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

// ── In-memory store ────────────────────────────────────────────────────────
// roomId -> { users, meet, password, messages[] }
const rooms = {};

// ── Auth middleware for sockets ────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket._authUsername = decoded.username;
    } catch { /* guest */ }
  }
  next();
});

// ── Socket.io ─────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  const ROOM_RE = /^[a-zA-Z0-9 _\-]{1,30}$/;
  const NAME_RE = /^[\S\s]{1,20}$/;
  const PASS_RE = /^.{0,50}$/;

  socket.roomIds = new Set();

  socket.on('join-room', ({ roomId, username, publicKey, password }) => {
    if (!roomId || !username || !publicKey) return;
    if (!ROOM_RE.test(roomId) || !NAME_RE.test(username)) return;
    if (typeof publicKey !== 'string' || publicKey.length > 64) return;
    if (socket.roomIds.has(roomId)) return;

    // Room password check
    if (rooms[roomId] && rooms[roomId].password) {
      if (!password || rooms[roomId].password !== password) {
        socket.emit('room-error', { roomId, error: 'Wrong password.' });
        return;
      }
    }

    if (!rooms[roomId]) rooms[roomId] = { users: {}, meet: { users: {} }, password: password || null, messages: [] };

    rooms[roomId].users[socket.id] = { username, publicKey };
    socket.join(roomId);
    socket.roomIds.add(roomId);
    socket.username = username;

    const peers = Object.entries(rooms[roomId].users)
      .filter(([id]) => id !== socket.id)
      .map(([id, data]) => ({ socketId: id, username: data.username, publicKey: data.publicKey }));

    socket.emit('room-peers', { roomId, peers });
    socket.to(roomId).emit('peer-joined', { socketId: socket.id, username, publicKey, roomId });
    broadcastUserList(roomId);
  });

  socket.on('leave-room', ({ roomId }) => {
    if (!roomId || !socket.roomIds.has(roomId)) return;
    _leaveRoom(socket, roomId);
  });

  socket.on('send-message', ({ roomId, to, encryptedMessage, nonce, messageType, timestamp, msgId, skipEcho, fileName, fileSize }) => {
    if (!roomId || !encryptedMessage || !nonce) return;
    if (typeof encryptedMessage !== 'string' || encryptedMessage.length > 4_000_000) return;

    // Per-socket rate limit: max 10 messages per second
    const now = Date.now();
    if (!socket._msgWindowStart || now - socket._msgWindowStart > 1000) {
      socket._msgWindowStart = now; socket._msgCount = 0;
    }
    socket._msgCount++;
    if (socket._msgCount > 10) return;

    const resolvedMsgId = msgId || uuidv4();
    const payload = {
      from: socket.id, fromUsername: socket.username,
      encryptedMessage, nonce,
      messageType: messageType || 'text',
      timestamp: timestamp || Date.now(),
      msgId: resolvedMsgId,
      roomId, fileName, fileSize
    };

    if (to) {
      io.to(to).emit('receive-message', payload);
      if (!skipEcho) socket.emit('receive-message', { ...payload, self: true });
    } else {
      socket.to(roomId).emit('receive-message', payload);
      socket.emit('receive-message', { ...payload, self: true });
    }
  });

  // Delete a message (broadcast to room)
  socket.on('delete-message', ({ roomId, msgId }) => {
    if (!roomId || !msgId || !socket.roomIds.has(roomId)) return;
    io.to(roomId).emit('message-deleted', { msgId, roomId, by: socket.id });
  });

  // Edit a message (re-encrypt and broadcast)
  socket.on('edit-message', ({ roomId, msgId, to, encryptedMessage, nonce }) => {
    if (!roomId || !msgId || !encryptedMessage || !nonce) return;
    if (!socket.roomIds.has(roomId)) return;
    if (typeof encryptedMessage !== 'string' || encryptedMessage.length > 4_000_000) return;
    if (to) {
      io.to(to).emit('message-edited', { msgId, roomId, from: socket.id, encryptedMessage, nonce });
    } else {
      socket.to(roomId).emit('message-edited', { msgId, roomId, from: socket.id, encryptedMessage, nonce });
      socket.emit('message-edited', { msgId, roomId, from: socket.id, encryptedMessage, nonce, self: true });
    }
  });

  // React to a chat message
  socket.on('message-react', ({ roomId, msgId, emoji }) => {
    if (!roomId || !msgId || !emoji || !socket.roomIds.has(roomId)) return;
    if (typeof emoji !== 'string' || emoji.length > 8) return;
    io.to(roomId).emit('message-reacted', { msgId, roomId, emoji, from: socket.id, username: socket.username });
  });

  // Read receipt
  socket.on('mark-read', ({ roomId, msgId }) => {
    if (!roomId || !msgId || !socket.roomIds.has(roomId)) return;
    socket.to(roomId).emit('message-seen', { msgId, roomId, by: socket.id, username: socket.username });
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    if (!roomId || !socket.roomIds.has(roomId)) return;
    socket.to(roomId).emit('user-typing', {
      socketId: socket.id, username: socket.username, isTyping, roomId
    });
  });

  // ── Meet / WebRTC signaling ─────────────────────────────────────────────
  socket.on('meet-join', ({ roomId }) => {
    if (!roomId || !socket.roomIds.has(roomId)) return;
    if (!rooms[roomId]) return;
    if (!rooms[roomId].meet) rooms[roomId].meet = { users: {} };
    if (rooms[roomId].meet.users[socket.id]) return;

    const existingPeers = Object.keys(rooms[roomId].meet.users)
      .map(id => ({ socketId: id, username: rooms[roomId].users[id]?.username || 'Unknown' }));

    rooms[roomId].meet.users[socket.id] = true;
    socket.emit('meet-peers', { roomId, peers: existingPeers });
    socket.to(roomId).emit('meet-peer-joined', { socketId: socket.id, username: socket.username, roomId });
  });

  socket.on('meet-leave', ({ roomId }) => {
    if (!roomId || !rooms[roomId]?.meet?.users[socket.id]) return;
    delete rooms[roomId].meet.users[socket.id];
    io.to(roomId).emit('meet-peer-left', { socketId: socket.id, roomId });
  });

  socket.on('webrtc-offer', ({ to, offer, roomId }) => {
    if (!to || !offer || !roomId || typeof offer !== 'object') return;
    if (!rooms[roomId]?.users[to]) return;
    io.to(to).emit('webrtc-offer', { from: socket.id, offer, roomId });
  });

  socket.on('webrtc-answer', ({ to, answer, roomId }) => {
    if (!to || !answer || !roomId || typeof answer !== 'object') return;
    if (!rooms[roomId]?.users[to]) return;
    io.to(to).emit('webrtc-answer', { from: socket.id, answer, roomId });
  });

  socket.on('webrtc-ice', ({ to, candidate, roomId }) => {
    if (!to || !candidate || !roomId || typeof candidate !== 'object') return;
    if (!rooms[roomId]?.users[to]) return;
    io.to(to).emit('webrtc-ice', { from: socket.id, candidate, roomId });
  });

  socket.on('meet-reaction', ({ roomId, emoji }) => {
    if (!roomId || !rooms[roomId]?.meet?.users[socket.id]) return;
    if (typeof emoji !== 'string' || emoji.length > 8) return;
    socket.to(roomId).emit('meet-reaction', { from: socket.id, username: socket.username, emoji, roomId });
  });

  socket.on('disconnect', () => {
    socket.roomIds.forEach(roomId => _leaveRoom(socket, roomId));
  });
});

function _leaveRoom(socket, roomId) {
  if (!rooms[roomId]) return;
  if (rooms[roomId].meet?.users[socket.id]) {
    delete rooms[roomId].meet.users[socket.id];
    io.to(roomId).emit('meet-peer-left', { socketId: socket.id, roomId });
  }
  delete rooms[roomId].users[socket.id];
  socket.leave(roomId);
  socket.roomIds.delete(roomId);
  io.to(roomId).emit('peer-left', { socketId: socket.id, username: socket.username, roomId });
  broadcastUserList(roomId);
  if (Object.keys(rooms[roomId].users).length === 0) delete rooms[roomId];
}

function broadcastUserList(roomId) {
  if (!rooms[roomId]) return;
  const users = Object.entries(rooms[roomId].users).map(([id, data]) => ({
    socketId: id, username: data.username
  }));
  io.to(roomId).emit('user-list', { roomId, users });
}

module.exports = { server };

