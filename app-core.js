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
const Database   = require('better-sqlite3');

// ── Logger ─────────────────────────────────────────────────────────────────
const pinoOpts = { level: process.env.LOG_LEVEL || 'info' };
if (process.env.NODE_ENV !== 'production') {
  try {
    require.resolve('pino-pretty');
    pinoOpts.transport = { target: 'pino-pretty', options: { colorize: true } };
  } catch { /* pino-pretty not installed */ }
}
const pino   = require('pino');
const logger = pino(pinoOpts);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: process.env.ALLOWED_ORIGIN ? { origin: process.env.ALLOWED_ORIGIN } : false
});

// ── Config ─────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  logger.fatal(
    'JWT_SECRET environment variable is required. ' +
    'Set it in your .env file or deployment config. Refusing to start. ' +
    'See .env.example for guidance.'
  );
  process.exit(1);
}

const DATA_DIR   = path.join(__dirname, 'data');

// VAPID keys for web push
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE;
let pushEnabled = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails('mailto:admin@livechat.app', VAPID_PUBLIC, VAPID_PRIVATE);
    pushEnabled = true;
    logger.info('Push notifications enabled.');
  } catch (e) {
    logger.warn({ err: e }, 'Invalid VAPID keys — push notifications disabled.');
  }
} else {
  logger.warn('VAPID_PUBLIC / VAPID_PRIVATE not set — push notifications disabled.');
}

// ── SQLite Database ─────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'livechat.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username_lower TEXT    PRIMARY KEY,
    username       TEXT    NOT NULL,
    password_hash  TEXT    NOT NULL,
    created_at     INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username_lower TEXT    NOT NULL REFERENCES users(username_lower) ON DELETE CASCADE,
    endpoint       TEXT    NOT NULL UNIQUE,
    subscription   TEXT    NOT NULL
  );
`);

const stmts = {
  findUser:      db.prepare('SELECT * FROM users WHERE username_lower = ?'),
  insertUser:    db.prepare('INSERT INTO users (username_lower, username, password_hash, created_at) VALUES (?, ?, ?, ?)'),
  deleteUser:    db.prepare('DELETE FROM users WHERE username_lower = ?'),
  findSubs:      db.prepare('SELECT subscription FROM push_subscriptions WHERE username_lower = ?'),
  insertSub:     db.prepare('INSERT OR IGNORE INTO push_subscriptions (username_lower, endpoint, subscription) VALUES (?, ?, ?)'),
  deleteOldSubs: db.prepare(`
    DELETE FROM push_subscriptions
    WHERE username_lower = ? AND id NOT IN (
      SELECT id FROM push_subscriptions WHERE username_lower = ? ORDER BY id DESC LIMIT 5
    )
  `)
};

// ── Helpers ─────────────────────────────────────────────────────────────────
// (users.json removed — now using SQLite via stmts above)

// ── Express setup ──────────────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'wss:', 'ws:'],
      mediaSrc:   ["'self'", 'blob:'],
      imgSrc:     ["'self'", 'data:', 'blob:'],
      workerSrc:  ["'self'"],
      manifestSrc:["'self'"],
    }
  }
}));
app.use(express.json({ limit: '5mb' }));

// HTTP rate limiting
const limiter = rateLimit({ windowMs: 60_000, max: 200, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

// Auth rate limiting (stricter)
const authLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

app.use(express.static(path.join(__dirname, 'public')));

// ── JWT auth middleware ────────────────────────────────────────────────────
function requireJWT(req, res, next) {
  const auth  = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

// ── AUTH ROUTES ────────────────────────────────────────────────────────────
app.post('/api/auth/signup', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username: 3-20 chars, letters/numbers/underscores only.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });

  const key = username.toLowerCase();
  if (stmts.findUser.get(key)) return res.status(409).json({ error: 'Username already taken.' });

  const hash = await bcrypt.hash(password, 12);
  stmts.insertUser.run(key, username, hash, Date.now());

  const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '30d' });
  logger.info({ username }, 'New user registered');
  res.json({ token, username });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required.' });

  const user = stmts.findUser.get(username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid username or password.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid username or password.' });

  const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, username: user.username });
});

// Account deletion — requires Bearer JWT + password confirmation
app.delete('/api/auth/account', authLimiter, requireJWT, async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password confirmation required.' });

  const user = stmts.findUser.get(req.user.username.toLowerCase());
  if (!user) return res.status(404).json({ error: 'Account not found.' });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ error: 'Incorrect password.' });

  stmts.deleteUser.run(req.user.username.toLowerCase());
  logger.info({ username: req.user.username }, 'Account deleted');
  res.json({ ok: true });
});

// ── TURN CREDENTIALS (short-lived, per-request) ───────────────────────────
app.get('/api/turn-credentials', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  // Use configured TURN server if provided; fall back to open relay
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls:       process.env.TURN_URL,
      username:   process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  } else {
    iceServers.push({
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp'
      ],
      username:   'openrelayproject',
      credential: 'openrelayproject'
    });
  }
  res.json({ iceServers });
});

// ── PUSH SUBSCRIPTION ─────────────────────────────────────────────────────
app.post('/api/push/subscribe', requireJWT, (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'Push notifications not configured.' });
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint) return res.status(400).json({ error: 'Missing subscription.' });
  const key = req.user.username.toLowerCase();
  if (!stmts.findUser.get(key)) return res.status(404).json({ error: 'User not found.' });
  stmts.insertSub.run(key, subscription.endpoint, JSON.stringify(subscription));
  stmts.deleteOldSubs.run(key, key);
  res.json({ ok: true });
});

// ── VAPID public key endpoint ──────────────────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'Push not configured.' });
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

    if (!rooms[roomId]) rooms[roomId] = { users: {}, meet: { users: {} }, password: password || null };

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

