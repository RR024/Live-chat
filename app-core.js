/**
 * app-core.js — Shared Express + Socket.io setup.
 * Exported so both server.js and tunnel.js use the same instance
 * without spawning a child process.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.ALLOWED_ORIGIN || '*' }
});

// Trust one proxy hop (tunnel / Railway / Render all add X-Forwarded-For)
app.set('trust proxy', 1);

// Security headers (CSP disabled — scripts loaded from CDN in index.html)
app.use(helmet({ contentSecurityPolicy: false }));

// HTTP rate limiting — 200 requests per minute per IP
app.use(rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false
}));

app.use(express.static(path.join(__dirname, 'public')));

// In-memory store: roomId -> { users: { socketId -> { username, publicKey } } }
const rooms = {};

io.on('connection', (socket) => {

  const ROOM_RE = /^[a-zA-Z0-9 _\-]{1,30}$/;
  const NAME_RE = /^[\S\s]{1,20}$/;

  socket.roomIds = new Set(); // track all rooms this socket is in

  socket.on('join-room', ({ roomId, username, publicKey }) => {
    if (!roomId || !username || !publicKey) return;
    if (!ROOM_RE.test(roomId) || !NAME_RE.test(username)) return;
    if (typeof publicKey !== 'string' || publicKey.length > 64) return;
    if (socket.roomIds.has(roomId)) return; // already in this room

    if (!rooms[roomId]) rooms[roomId] = { users: {}, meet: { users: {} } };

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

  socket.on('send-message', ({ roomId, to, encryptedMessage, nonce, messageType, timestamp, msgId, skipEcho }) => {
    if (!roomId || !encryptedMessage || !nonce) return;
    if (typeof encryptedMessage !== 'string' || encryptedMessage.length > 100000) return;

    // Per-socket rate limit: max 10 messages per second
    const now = Date.now();
    if (!socket._msgWindowStart || now - socket._msgWindowStart > 1000) {
      socket._msgWindowStart = now;
      socket._msgCount = 0;
    }
    socket._msgCount++;
    if (socket._msgCount > 10) return;

    const payload = {
      from: socket.id,
      fromUsername: socket.username,
      encryptedMessage,
      nonce,
      messageType: messageType || 'text',
      timestamp: timestamp || Date.now(),
      msgId: msgId || uuidv4(),
      roomId
    };

    if (to) {
      io.to(to).emit('receive-message', payload);
      if (!skipEcho) socket.emit('receive-message', { ...payload, self: true });
    } else {
      socket.to(roomId).emit('receive-message', payload);
      socket.emit('receive-message', { ...payload, self: true });
    }
  });

  socket.on('typing', ({ roomId, isTyping }) => {
    socket.to(roomId).emit('user-typing', {
      socketId: socket.id,
      username: socket.username,
      isTyping,
      roomId
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
    socketId: id,
    username: data.username
  }));
  io.to(roomId).emit('user-list', { roomId, users });
}

module.exports = { server };
