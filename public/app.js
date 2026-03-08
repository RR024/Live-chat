
(function () {
  'use strict';

  // ── DOM refs ─────────────────────────────────────────────────────────
  const joinScreen       = document.getElementById('join-screen');
  const chatScreen       = document.getElementById('chat-screen');
  const inputUsername    = document.getElementById('input-username');
  const inputRoom        = document.getElementById('input-room');
  const btnGenRoom       = document.getElementById('btn-gen-room');
  const btnJoin          = document.getElementById('btn-join');
  const joinError        = document.getElementById('join-error');
  const messagesArea     = document.getElementById('messages');
  const messageInput     = document.getElementById('message-input');
  const btnSend          = document.getElementById('btn-send');
  const btnEmoji         = document.getElementById('btn-emoji');
  const btnSticker       = document.getElementById('btn-sticker');
  const emojiPicker      = document.getElementById('emoji-picker');
  const stickerPicker    = document.getElementById('sticker-picker');
  const userListEl       = document.getElementById('user-list');
  const displayRoomId    = document.getElementById('display-room-id');
  const btnCopyRoom      = document.getElementById('btn-copy-room');
  const chatRoomTitle    = document.getElementById('chat-room-title');
  const typingIndicator  = document.getElementById('typing-indicator');
  const selfIndicator    = document.getElementById('self-indicator');
  const btnLeave         = document.getElementById('btn-leave');
  const toastContainer   = document.getElementById('toast-container');
  const btnSidebarToggle  = document.getElementById('btn-sidebar-toggle');
  const btnSidebarClose   = document.getElementById('btn-sidebar-close');
  const memberCountBadge  = document.getElementById('member-count-badge');
  const sidebar           = document.querySelector('.sidebar');
  const sidebarOverlay    = document.getElementById('sidebar-overlay');
  const roomTabsEl       = document.getElementById('room-tabs');
  const btnAddRoom       = document.getElementById('btn-add-room');
  const addRoomPanel     = document.getElementById('add-room-panel');
  const inputNewRoom     = document.getElementById('input-new-room');
  const btnJoinNewRoom   = document.getElementById('btn-join-new-room');
  const addRoomError     = document.getElementById('add-room-error');

  // ── State ─────────────────────────────────────────────────────────────
  let socket       = null;
  let mySocketId   = null;
  let myUsername   = '';
  let activeRoomId = '';
  let typingTimer  = null;
  let isTyping     = false;

  // Per-room state: roomId -> { nodes: Node[], users: [], unread: 0, typingText: '' }
  const roomStates = {};

  // ── Session persistence (localStorage) ────────────────────────────────
  const SESSION_KEY = 'livechat_session';
  function saveSession() {
    try {
      if (!myUsername || Object.keys(roomStates).length === 0) return;
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        username: myUsername,
        rooms: Object.keys(roomStates)
      }));
    } catch (e) {}
  }
  // Always save right before page closes / refreshes
  window.addEventListener('beforeunload', saveSession);
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  // ── Avatar colors ──────────────────────────────────────────────────────
  const AVATAR_COLORS = [
    '#7c6af7','#f76a8e','#6af7b0','#f7c46a',
    '#6ac4f7','#f76af0','#a3f76a','#f7956a'
  ];
  function avatarColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
  function avatarInitial(name) {
    return (name || '?').charAt(0).toUpperCase();
  }

  // ── Utility ────────────────────────────────────────────────────────────
  function sanitize(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function randomRoomId() {
    const words = ['swift','neon','lunar','pixel','crisp','echo','vivid','flux','prism','zen'];
    const w = words[Math.floor(Math.random() * words.length)];
    const n = Math.floor(1000 + Math.random() * 9000);
    return `${w}-${n}`;
  }

  // ── Toast notifications ────────────────────────────────────────────────
  function showToast(msg, duration = 3000) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => {
      t.classList.add('fade-out');
      setTimeout(() => t.remove(), 320);
    }, duration);
  }

  // ── Mobile sidebar toggle ──────────────────────────────────────────────
  function closeSidebar() {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('visible');
  }
  btnSidebarToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('visible');
  });
  btnSidebarClose.addEventListener('click', closeSidebar);
  sidebarOverlay.addEventListener('click', closeSidebar);

  // ── Join screen ────────────────────────────────────────────────────────
  btnGenRoom.addEventListener('click', () => {
    inputRoom.value = randomRoomId();
  });

  btnJoin.addEventListener('click', joinFirstRoom);
  [inputUsername, inputRoom].forEach(el =>
    el.addEventListener('keydown', e => { if (e.key === 'Enter') joinFirstRoom(); })
  );

  function joinFirstRoom() {
    const username = inputUsername.value.trim();
    const roomId   = inputRoom.value.trim();

    joinError.textContent = '';

    if (!username) { joinError.textContent = 'Please enter your name.'; return; }
    if (!roomId)   { joinError.textContent = 'Please enter a room ID.'; return; }
    if (username.length > 20) { joinError.textContent = 'Name too long (max 20).'; return; }
    if (!/^[a-zA-Z0-9 _\-]+$/.test(roomId)) {
      joinError.textContent = 'Room ID may only contain letters, numbers, spaces, - or _.';
      return;
    }

    myUsername = username;
    selfIndicator.textContent = myUsername;

    socket = io();
    mySocketId = null;

    socket.on('connect', () => {
      mySocketId = socket.id;
      _socketJoinRoom(roomId);
    });

    socket.on('connect_error', () => {
      joinError.textContent = 'Could not connect to server. Is it running?';
    });

    setupSocketEvents();
    showChatScreen(roomId);
    saveSession();
  }

  function _socketJoinRoom(roomId) {
    const myPublicKeyB64 = E2E.generateKeyPairForRoom(roomId);
    socket.emit('join-room', { roomId, username: myUsername, publicKey: myPublicKeyB64 });
  }

  function showChatScreen(firstRoomId) {
    joinScreen.classList.remove('active');
    chatScreen.classList.add('active');
    buildEmojiPicker();
    buildStickerPicker();
    _initRoom(firstRoomId);
    switchRoom(firstRoomId);
    messageInput.focus();
  }

  // ── Per-room state management ───────────────────────────────────────────
  function _initRoom(roomId) {
    if (roomStates[roomId]) return;
    roomStates[roomId] = { nodes: [], users: [], unread: 0, typingText: '' };
    E2E.initRoom(roomId);
  }

  function switchRoom(roomId) {
    if (!roomStates[roomId]) return;

    // Stash current room's message nodes
    if (activeRoomId && activeRoomId !== roomId && roomStates[activeRoomId]) {
      roomStates[activeRoomId].nodes = Array.from(messagesArea.children)
        .filter(n => n.id !== 'chat-bg-canvas');
    }

    activeRoomId = roomId;

    // Clear messages area (keep canvas)
    Array.from(messagesArea.children).forEach(n => {
      if (n.id !== 'chat-bg-canvas') messagesArea.removeChild(n);
    });

    const state = roomStates[roomId];
    if (state.nodes.length === 0) {
      messagesArea.appendChild(_buildWelcomeCard());
    } else {
      state.nodes.forEach(n => messagesArea.appendChild(n));
    }
    messagesArea.scrollTop = messagesArea.scrollHeight;

    state.unread = 0;
    chatRoomTitle.textContent = roomId;
    displayRoomId.textContent = roomId;
    typingIndicator.textContent = state.typingText;
    renderUserList(state.users);
    renderRoomTabs();
  }

  function _buildWelcomeCard() {
    const div = document.createElement('div');
    div.className = 'welcome-msg';
    div.innerHTML = `
      <div class="welcome-msg-card">
        <div class="welcome-lock">🔐</div>
        <div class="welcome-title">End-to-End Encrypted Chat</div>
        <p class="welcome-sub">Every message is encrypted in your browser before it leaves.<br/>Nobody — not even the server — can read them.</p>
        <div class="welcome-tags">
          <span class="welcome-tag">Zero Logs</span>
          <span class="welcome-tag">No Snooping</span>
          <span class="welcome-tag">Real-time</span>
        </div>
      </div>`;
    return div;
  }

  // ── Room tabs ────────────────────────────────────────────────────────────
  function renderRoomTabs() {
    roomTabsEl.innerHTML = '';
    Object.keys(roomStates).forEach(roomId => {
      const li = document.createElement('li');
      li.className = 'room-tab' + (roomId === activeRoomId ? ' active' : '');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'room-tab-name';
      nameSpan.textContent = roomId;

      const badge = document.createElement('span');
      badge.className = 'room-tab-badge';
      const unread = roomStates[roomId].unread;
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.style.display = unread > 0 ? 'inline-flex' : 'none';

      const closeBtn = document.createElement('button');
      closeBtn.className = 'room-tab-close';
      closeBtn.title = 'Leave room';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        leaveRoom(roomId);
      });

      li.appendChild(nameSpan);
      li.appendChild(badge);
      li.appendChild(closeBtn);
      li.addEventListener('click', () => switchRoom(roomId));
      roomTabsEl.appendChild(li);
    });
  }

  // ── Add-room panel ────────────────────────────────────────────────────────
  btnAddRoom.addEventListener('click', (e) => {
    e.stopPropagation();
    addRoomPanel.classList.toggle('hidden');
    if (!addRoomPanel.classList.contains('hidden')) inputNewRoom.focus();
  });

  btnJoinNewRoom.addEventListener('click', joinNewRoom);
  inputNewRoom.addEventListener('keydown', e => { if (e.key === 'Enter') joinNewRoom(); });

  function joinNewRoom() {
    const roomId = inputNewRoom.value.trim();
    addRoomError.textContent = '';
    if (!roomId) { addRoomError.textContent = 'Enter a room ID.'; return; }
    if (!/^[a-zA-Z0-9 _\-]+$/.test(roomId)) { addRoomError.textContent = 'Invalid room ID.'; return; }
    if (roomStates[roomId]) { addRoomError.textContent = 'Already in this room.'; return; }
    _initRoom(roomId);
    _socketJoinRoom(roomId);
    inputNewRoom.value = '';
    addRoomPanel.classList.add('hidden');
    switchRoom(roomId);
    saveSession();
    showToast(`Joined room: ${roomId}`);
  }

  // ── Socket events ───────────────────────────────────────────────────────
  function setupSocketEvents() {

    socket.on('room-peers', ({ roomId, peers }) => {
      if (!roomStates[roomId]) return;
      peers.forEach(({ socketId, publicKey }) => {
        E2E.addPeerKeyForRoom(roomId, socketId, publicKey);
      });
    });

    socket.on('peer-joined', ({ socketId, username, publicKey, roomId }) => {
      if (!roomStates[roomId]) return;
      E2E.addPeerKeyForRoom(roomId, socketId, publicKey);
      appendSystemMessage(roomId, `${sanitize(username)} joined the room 🎉`);
      if (roomId === activeRoomId) showToast(`${username} joined`);
    });

    socket.on('peer-left', ({ socketId, username, roomId }) => {
      if (!roomStates[roomId]) return;
      E2E.removePeerKeyForRoom(roomId, socketId);
      appendSystemMessage(roomId, `${sanitize(username || 'Someone')} left the room`);
    });

    socket.on('user-list', ({ roomId, users }) => {
      if (!roomStates[roomId]) return;
      roomStates[roomId].users = users;
      if (roomId === activeRoomId) renderUserList(users);
    });

    socket.on('receive-message', (payload) => {
      handleIncomingMessage(payload);
    });

    socket.on('user-typing', ({ username, isTyping: typing, roomId }) => {
      if (!roomStates[roomId]) return;
      const text = typing ? `${username} is typing…` : '';
      roomStates[roomId].typingText = text;
      if (roomId === activeRoomId) typingIndicator.textContent = text;
    });

    socket.on('disconnect', () => {
      appendSystemMessage(activeRoomId, 'Disconnected from server.');
    });

    setupMeetSocketEvents();
  }

  // ── Sending messages ────────────────────────────────────────────────────
  function sendMessage(text, type = 'text') {
    if (!text.trim() && type === 'text') return;
    const roomId    = activeRoomId;
    const peers     = E2E.getAllPeerIdsForRoom(roomId);
    const timestamp = Date.now();
    const msgId     = Math.random().toString(36).slice(2);

    appendMessage(roomId, { from: mySocketId, fromUsername: myUsername, text, messageType: type, timestamp, self: true });

    if (peers.length === 0) return;

    peers.forEach(peerId => {
      let encrypted;
      try { encrypted = E2E.encryptForInRoom(roomId, peerId, text); } catch { return; }
      socket.emit('send-message', {
        roomId, to: peerId,
        encryptedMessage: encrypted.encryptedMessage,
        nonce: encrypted.nonce,
        messageType: type, timestamp, msgId, skipEcho: true
      });
    });
  }

  function handleIncomingMessage(payload) {
    const { from, fromUsername, encryptedMessage, nonce, messageType, timestamp, self: isSelf, roomId } = payload;
    if (isSelf) return;
    if (!roomStates[roomId]) return;
    const text = E2E.decryptInRoom(roomId, encryptedMessage, nonce, from);
    if (text === null) return;
    appendMessage(roomId, { from, fromUsername, text, messageType: messageType || 'text', timestamp, self: false });
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function appendMessage(roomId, { from, fromUsername, text, messageType, timestamp, self: isSelf }) {
    const isActive = roomId === activeRoomId;
    const state = roomStates[roomId];
    if (!state) return;

    // Remove welcome card when first message arrives
    if (isActive) {
      const welcome = messagesArea.querySelector('.welcome-msg');
      if (welcome) welcome.remove();
    } else {
      const idx = state.nodes.findIndex(n => n.classList && n.classList.contains('welcome-msg'));
      if (idx !== -1) state.nodes.splice(idx, 1);
    }

    const row = document.createElement('div');
    row.className = `msg-row ${isSelf ? 'self' : 'other'}`;

    const meta = document.createElement('div');
    meta.className = 'msg-meta';

    const author = document.createElement('span');
    author.className = 'msg-author';
    author.textContent = isSelf ? 'You' : sanitize(fromUsername || 'Unknown');

    const time = document.createElement('span');
    time.className = 'msg-time';
    time.textContent = formatTime(timestamp || Date.now());

    meta.appendChild(author);
    meta.appendChild(time);

    const bubble = document.createElement('div');
    bubble.className = messageType === 'sticker' ? 'msg-bubble sticker' : 'msg-bubble';
    bubble.textContent = text;

    row.appendChild(meta);
    row.appendChild(bubble);

    if (isActive) {
      messagesArea.appendChild(row);
      messagesArea.scrollTop = messagesArea.scrollHeight;
    } else {
      state.nodes.push(row);
      if (!isSelf) { state.unread++; renderRoomTabs(); }
    }

  }

  function appendSystemMessage(roomId, html) {
    const state = roomStates[roomId];
    if (!state) return;
    const div = document.createElement('div');
    div.className = 'sys-msg';
    div.innerHTML = html;
    if (roomId === activeRoomId) {
      messagesArea.appendChild(div);
      messagesArea.scrollTop = messagesArea.scrollHeight;
    } else {
      state.nodes.push(div);
    }
  }

  function renderUserList(users) {
    userListEl.innerHTML = '';
    if (memberCountBadge) memberCountBadge.textContent = users.length;
    users.forEach(({ socketId, username }) => {
      const li = document.createElement('li');
      if (socketId === mySocketId) li.classList.add('self-user');

      const av = document.createElement('span');
      av.className = 'avatar';
      av.textContent = avatarInitial(username);
      av.style.background = avatarColor(username);
      av.style.color = '#fff';

      const name = document.createElement('span');
      name.textContent = socketId === mySocketId ? `${username} (you)` : username;

      const dot = document.createElement('span');
      dot.className = 'u-dot';

      li.appendChild(av);
      li.appendChild(name);
      li.appendChild(dot);
      userListEl.appendChild(li);
    });
  }

  // ── Input / send handlers ───────────────────────────────────────────────
  btnSend.addEventListener('click', () => {
    const text = messageInput.value;
    sendMessage(text, 'text');
    messageInput.value = '';
    autoResizeTextarea();
    stopTyping();
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = messageInput.value;
      sendMessage(text, 'text');
      messageInput.value = '';
      autoResizeTextarea();
      stopTyping();
    }
  });

  messageInput.addEventListener('input', () => {
    autoResizeTextarea();
    if (!isTyping) {
      isTyping = true;
      socket && socket.emit('typing', { roomId: activeRoomId, isTyping: true });
    }
    clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, 1500);
  });

  function stopTyping() {
    if (isTyping) {
      isTyping = false;
      socket && socket.emit('typing', { roomId: activeRoomId, isTyping: false });
    }
    clearTimeout(typingTimer);
  }

  function autoResizeTextarea() {
    messageInput.style.height = 'auto';
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + 'px';
  }

  // ── Emoji picker ────────────────────────────────────────────────────────
  function buildEmojiPicker() {
    emojiPicker.innerHTML = '';
    EMOJIS.forEach(({ category, emojis }) => {
      const label = document.createElement('span');
      label.className = 'ep-category';
      label.textContent = category;
      emojiPicker.appendChild(label);

      emojis.forEach(em => {
        const btn = document.createElement('button');
        btn.textContent = em;
        btn.title = em;
        btn.addEventListener('click', () => {
          messageInput.value += em;
          messageInput.focus();
          autoResizeTextarea();
        });
        emojiPicker.appendChild(btn);
      });
    });
  }

  btnEmoji.addEventListener('click', (e) => {
    e.stopPropagation();
    emojiPicker.classList.toggle('hidden');
    stickerPicker.classList.add('hidden');
    btnEmoji.classList.toggle('active', !emojiPicker.classList.contains('hidden'));
    btnSticker.classList.remove('active');
  });

  // ── Sticker picker ──────────────────────────────────────────────────────
  function buildStickerPicker() {
    stickerPicker.innerHTML = '';
    STICKER_PACKS.forEach(({ name, stickers }) => {
      const label = document.createElement('div');
      label.className = 'sticker-cat-label';
      label.textContent = name;
      stickerPicker.appendChild(label);

      const grid = document.createElement('div');
      grid.className = 'sticker-grid';

      stickers.forEach(sticker => {
        const btn = document.createElement('button');
        btn.className = 'sticker-btn';
        btn.textContent = sticker;
        btn.addEventListener('click', () => {
          sendMessage(sticker, 'sticker');
          stickerPicker.classList.add('hidden');
          btnSticker.classList.remove('active');
        });
        grid.appendChild(btn);
      });

      stickerPicker.appendChild(grid);
    });
  }

  btnSticker.addEventListener('click', (e) => {
    e.stopPropagation();
    stickerPicker.classList.toggle('hidden');
    emojiPicker.classList.add('hidden');
    btnSticker.classList.toggle('active', !stickerPicker.classList.contains('hidden'));
    btnEmoji.classList.remove('active');
  });

  // Close pickers and add-room panel on outside click
  document.addEventListener('click', (e) => {
    if (!emojiPicker.contains(e.target) && e.target !== btnEmoji) {
      emojiPicker.classList.add('hidden');
      btnEmoji.classList.remove('active');
    }
    if (!stickerPicker.contains(e.target) && e.target !== btnSticker) {
      stickerPicker.classList.add('hidden');
      btnSticker.classList.remove('active');
    }
    if (!addRoomPanel.contains(e.target) && e.target !== btnAddRoom) {
      addRoomPanel.classList.add('hidden');
    }
  });

  // ── Copy room ID ────────────────────────────────────────────────────────
  btnCopyRoom.addEventListener('click', () => {
    navigator.clipboard.writeText(activeRoomId)
      .then(() => showToast('Room ID copied!'))
      .catch(() => showToast('Could not copy — try manually.'));
  });

  // ── Leave room ──────────────────────────────────────────────────────────
  btnLeave.addEventListener('click', () => leaveRoom(activeRoomId));

  function leaveRoom(roomId) {
    if (!roomStates[roomId]) return;
    if (meetActive && meetRoomId === roomId) leaveMeet();
    if (socket) socket.emit('leave-room', { roomId });
    E2E.destroyRoom(roomId);
    delete roomStates[roomId];

    const remaining = Object.keys(roomStates);
    if (remaining.length === 0) {
      // Last room — disconnect, clear session, return to join screen
      clearSession();
      if (socket) { socket.disconnect(); socket = null; }
      chatScreen.classList.remove('active');
      joinScreen.classList.add('active');
      _resetMessagesArea();
      userListEl.innerHTML = '';
      typingIndicator.textContent = '';
      messageInput.value = '';
      activeRoomId = '';
      myUsername = '';
      mySocketId = null;
      roomTabsEl.innerHTML = '';
    } else {
      const next = activeRoomId === roomId ? remaining[0] : activeRoomId;
      activeRoomId = '';
      switchRoom(next);
      saveSession();
      showToast(`Left room: ${roomId}`);
    }
  }

  function _resetMessagesArea() {
    messagesArea.innerHTML = `
      <canvas id="chat-bg-canvas" aria-hidden="true"></canvas>
      <div class="welcome-msg">
        <div class="welcome-msg-card">
          <div class="welcome-lock">🔐</div>
          <div class="welcome-title">End-to-End Encrypted Chat</div>
          <p class="welcome-sub">Every message is encrypted in your browser before it leaves.<br/>Nobody — not even the server — can read them.</p>
          <div class="welcome-tags">
            <span class="welcome-tag">Zero Logs</span>
            <span class="welcome-tag">No Snooping</span>
            <span class="welcome-tag">Real-time</span>
          </div>
        </div>
      </div>`;
    initChatCanvas();
  }

  // ── 3D Card Tilt Effect ───────────────────────────────────────────────
  (function () {
    const card = document.querySelector('.join-card');
    if (!card) return;
    const TILT = 10;
    joinScreen.addEventListener('mousemove', (e) => {
      const r   = card.getBoundingClientRect();
      const cx  = r.left + r.width  / 2;
      const cy  = r.top  + r.height / 2;
      const dx  = (e.clientX - cx) / (window.innerWidth  / 2);
      const dy  = (e.clientY - cy) / (window.innerHeight / 2);
      const rx  = (-dy * TILT).toFixed(2);
      const ry  = ( dx * TILT).toFixed(2);
      card.style.transform = `perspective(900px) rotateX(${rx}deg) rotateY(${ry}deg) translateZ(6px)`;
      const sx = (-dx * 18).toFixed(1);
      const sy = ( dy * 18 + 22).toFixed(1);
      const glow = (Math.abs(dx) + Math.abs(dy)) * 0.12;
      card.style.boxShadow = `${sx}px ${sy}px 60px rgba(0,0,0,0.6), 0 8px 24px rgba(0,0,0,0.35), 0 0 40px rgba(0,212,170,${glow.toFixed(2)})`;
    });
    joinScreen.addEventListener('mouseleave', () => {
      card.style.transform  = '';
      card.style.boxShadow  = '';
    });
  })();

  // ── Particle Constellation Canvas ──────────────────────────────────────
  function initChatCanvas() {
    const canvas = document.getElementById('chat-bg-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const TEAL   = '0,212,170';
    const BLUE   = '0,150,255';
    const N      = 62;
    const LINK   = 140;
    let w, h, particles = [], raf = null;
    const mouse  = { x: null, y: null };

    function resize() {
      w = canvas.width  = canvas.offsetWidth;
      h = canvas.height = canvas.offsetHeight;
    }

    class P {
      constructor() { this.init(); }
      init() {
        this.x  = Math.random() * w;
        this.y  = Math.random() * h;
        this.vx = (Math.random() - 0.5) * 0.35;
        this.vy = (Math.random() - 0.5) * 0.35;
        this.r  = 1.2 + Math.random() * 1.6;
        this.op = 0.25 + Math.random() * 0.45;
        this.col = Math.random() > 0.35 ? TEAL : BLUE;
      }
      step() {
        // subtle mouse attraction
        if (mouse.x !== null) {
          const dx = mouse.x - this.x, dy = mouse.y - this.y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          if (d < 160) {
            this.vx += dx / d * 0.018;
            this.vy += dy / d * 0.018;
          }
        }
        // dampen & clamp speed
        this.vx *= 0.985;
        this.vy *= 0.985;
        const spd = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (spd > 1.4) { this.vx = this.vx / spd * 1.4; this.vy = this.vy / spd * 1.4; }
        this.x += this.vx;
        this.y += this.vy;
        if (this.x < 0) this.x = w;
        if (this.x > w) this.x = 0;
        if (this.y < 0) this.y = h;
        if (this.y > h) this.y = 0;
      }
      draw() {
        // outer halo
        const g = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.r * 3.5);
        g.addColorStop(0,   `rgba(${this.col},${(this.op * 0.9).toFixed(2)})`);
        g.addColorStop(0.5, `rgba(${this.col},${(this.op * 0.3).toFixed(2)})`);
        g.addColorStop(1,   `rgba(${this.col},0)`);
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r * 3.5, 0, Math.PI * 2);
        ctx.fillStyle = g;
        ctx.fill();
        // core dot
        ctx.beginPath();
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${this.col},${this.op.toFixed(2)})`;
        ctx.fill();
      }
    }

    function drawLinks() {
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const a = particles[i], b = particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < LINK) {
            const alpha = (1 - dist / LINK) * 0.22;
            const col   = a.col === TEAL ? TEAL : BLUE;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(${col},${alpha.toFixed(3)})`;
            ctx.lineWidth = 0.8;
            ctx.stroke();
          }
        }
      }
    }

    // Mouse proximity highlight beam
    function drawMouseBeam() {
      if (mouse.x === null) return;
      for (let i = 0; i < particles.length; i++) {
        const p    = particles[i];
        const dx   = p.x - mouse.x, dy = p.y - mouse.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 100) {
          const alpha = (1 - dist / 100) * 0.35;
          ctx.beginPath();
          ctx.moveTo(mouse.x, mouse.y);
          ctx.lineTo(p.x, p.y);
          ctx.strokeStyle = `rgba(${TEAL},${alpha.toFixed(3)})`;
          ctx.lineWidth = 0.7;
          ctx.stroke();
        }
      }
    }

    function loop() {
      ctx.clearRect(0, 0, w, h);
      drawLinks();
      drawMouseBeam();
      for (const p of particles) { p.step(); p.draw(); }
      raf = requestAnimationFrame(loop);
    }

    function start() {
      if (raf) cancelAnimationFrame(raf);
      resize();
      particles = Array.from({ length: N }, () => new P());
      loop();
    }

    const resizeObs = new ResizeObserver(() => {
      resize();
      for (const p of particles) {
        p.x = Math.min(p.x, w);
        p.y = Math.min(p.y, h);
      }
    });
    resizeObs.observe(canvas.parentElement);

    const msgArea = document.getElementById('messages');
    if (msgArea) {
      msgArea.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        mouse.x = e.clientX - r.left;
        mouse.y = e.clientY - r.top;
      });
      msgArea.addEventListener('mouseleave', () => { mouse.x = null; mouse.y = null; });
    }

    start();
  }

  initChatCanvas();

  // ── Meet (Voice / Video Call) ────────────────────────────────────────────
  const meetOverlay   = document.getElementById('meet-overlay');
  const meetTilesEl   = document.getElementById('meet-tiles');
  const btnMeetJoin   = document.getElementById('btn-meet');
  const btnMeetMic    = document.getElementById('btn-meet-mic');
  const btnMeetCam    = document.getElementById('btn-meet-cam');
  const btnMeetScreen = document.getElementById('btn-meet-screen');
  const btnMeetPip    = document.getElementById('btn-meet-pip');
  const btnMeetLeave  = document.getElementById('btn-meet-leave');
  const btnMeetMin    = document.getElementById('btn-meet-minimize');
  const meetRoomLabel = document.getElementById('meet-room-label');
  const meetCountEl   = document.getElementById('meet-count-badge');

  const MIC_ON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
  const MIC_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
  const CAM_ON  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`;
  const CAM_OFF = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3.5-3H21a2 2 0 0 1 2 2v9.5"/><polyline points="16 9 23 7 23 17"/></svg>`;

  let meetActive  = false;
  let meetRoomId  = null;
  let localStream = null;
  let micEnabled  = true;
  let camEnabled  = true;
  const meetPeers = new Map(); // socketId -> RTCPeerConnection
  const meetNames = new Map(); // socketId -> username

  const ICE_CFG = { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]};

  async function joinMeet() {
    if (meetActive) { meetOverlay.classList.remove('hidden'); return; }
    const roomId = activeRoomId;
    if (!roomId || !socket) { showToast('Join a room first.'); return; }

    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      camEnabled = true;
    } catch {
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        camEnabled = false;
      } catch {
        showToast('Microphone / camera access denied.');
        return;
      }
    }

    meetActive = true;
    meetRoomId = roomId;
    micEnabled = true;
    meetRoomLabel.textContent = roomId;
    meetTilesEl.innerHTML = '';
    _addMeetTile('local', myUsername + ' (you)', localStream, true);
    _syncMeetCtrl();
    meetOverlay.classList.remove('hidden');
    btnMeetJoin.classList.add('in-call');
    socket.emit('meet-join', { roomId });
  }

  function leaveMeet() {
    if (!meetActive) return;
    if (socket && meetRoomId) socket.emit('meet-leave', { roomId: meetRoomId });
    meetPeers.forEach(pc => pc.close());
    meetPeers.clear();
    meetNames.clear();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    meetActive = false;
    meetRoomId = null;
    meetTilesEl.innerHTML = '';
    meetOverlay.classList.add('hidden');
    btnMeetJoin.classList.remove('in-call');
    if (meetCountEl) meetCountEl.textContent = '';
  }

  function _addMeetTile(id, username, stream, isLocal) {
    const tileId = `mti-${id}`;
    const existing = document.getElementById(tileId);
    if (existing) {
      const v = existing.querySelector('video');
      if (v && stream) v.srcObject = stream;
      return;
    }
    const tile = document.createElement('div');
    tile.className = 'meet-tile';
    tile.id = tileId;

    const video = document.createElement('video');
    video.autoplay = true; video.playsInline = true; video.muted = isLocal;
    if (stream) video.srcObject = stream;

    const av = document.createElement('div');
    av.className = 'meet-tile-av';
    av.textContent = (username || '?').charAt(0).toUpperCase();
    av.style.background = avatarColor(username);
    const hasVid = stream && stream.getVideoTracks().length > 0;
    const showAv = !hasVid || (isLocal && !camEnabled);
    av.style.display    = showAv ? 'flex'  : 'none';
    video.style.display = showAv ? 'none'  : 'block';

    const nameEl = document.createElement('div');
    nameEl.className = 'meet-tile-name';
    nameEl.textContent = sanitize(username);

    tile.appendChild(video);
    tile.appendChild(av);
    tile.appendChild(nameEl);
    meetTilesEl.appendChild(tile);
    _updateMeetCount();
    if (typeof _pipSync === 'function') _pipSync();
  }

  function _removeMeetTile(socketId) {
    const tile = document.getElementById(`mti-${socketId}`);
    if (tile) tile.remove();
    _updateMeetCount();
    if (typeof _pipSync === 'function') _pipSync();
  }

  function _updateMeetCount() {
    const n = meetTilesEl.querySelectorAll('.meet-tile').length;
    if (meetCountEl) meetCountEl.textContent = meetActive && n > 0 ? String(n) : '';
  }

  function _syncMeetCtrl() {
    btnMeetMic.innerHTML = micEnabled ? MIC_ON  : MIC_OFF;
    btnMeetCam.innerHTML = camEnabled ? CAM_ON  : CAM_OFF;
    btnMeetMic.classList.toggle('muted', !micEnabled);
    btnMeetCam.classList.toggle('muted', !camEnabled);
  }

  function toggleMeetMic() {
    if (!meetActive) return;
    micEnabled = !micEnabled;
    localStream?.getAudioTracks().forEach(t => t.enabled = micEnabled);
    _syncMeetCtrl();
  }

  function toggleMeetCam() {
    if (!meetActive) return;
    camEnabled = !camEnabled;
    localStream?.getVideoTracks().forEach(t => t.enabled = camEnabled);
    const tile = document.getElementById('mti-local');
    if (tile) {
      const v  = tile.querySelector('video');
      const av = tile.querySelector('.meet-tile-av');
      if (v)  v.style.display  = camEnabled ? 'block' : 'none';
      if (av) av.style.display = camEnabled ? 'none'  : 'flex';
    }
    _syncMeetCtrl();
  }

  async function toggleMeetScreen() {
    if (!meetActive) return;
    try {
      const ss    = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = ss.getVideoTracks()[0];
      meetPeers.forEach(pc => {
        const sender = pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) sender.replaceTrack(track);
      });
      const tile = document.getElementById('mti-local');
      if (tile) {
        const v = tile.querySelector('video');
        if (v) v.srcObject = new MediaStream([track, ...(localStream?.getAudioTracks() || [])]);
      }
      btnMeetScreen.classList.add('active');
      track.onended = () => {
        const camTrack = localStream?.getVideoTracks()[0];
        if (camTrack) {
          meetPeers.forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(camTrack);
          });
          const t = document.getElementById('mti-local');
          if (t) { const v = t.querySelector('video'); if (v) v.srcObject = localStream; }
        }
        btnMeetScreen.classList.remove('active');
      };
    } catch { /* user cancelled or not supported */ }
  }

  async function _createMeetPC(remoteId, initiator) {
    const pc = new RTCPeerConnection(ICE_CFG);
    meetPeers.set(remoteId, pc);
    localStream?.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = ({ streams: [stream] }) => {
      const uname = meetNames.get(remoteId) || 'Unknown';
      _addMeetTile(remoteId, uname, stream, false);
    };

    pc.onicecandidate = ({ candidate }) => {
      if (candidate && socket) {
        socket.emit('webrtc-ice', { to: remoteId, candidate, roomId: meetRoomId });
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        _removeMeetTile(remoteId);
        pc.close();
        meetPeers.delete(remoteId);
      }
    };

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { to: remoteId, offer, roomId: meetRoomId });
    }
    return pc;
  }

  function setupMeetSocketEvents() {
    socket.on('meet-peers', async ({ roomId, peers }) => {
      if (roomId !== meetRoomId) return;
      for (const { socketId, username } of peers) {
        meetNames.set(socketId, username);
        await _createMeetPC(socketId, true);
      }
    });

    socket.on('meet-peer-joined', ({ socketId, username, roomId }) => {
      meetNames.set(socketId, username);
      if (roomId === activeRoomId) showToast(`${sanitize(username)} joined the Meet 📹`);
    });

    socket.on('meet-peer-left', ({ socketId }) => {
      const pc = meetPeers.get(socketId);
      if (pc) { pc.close(); meetPeers.delete(socketId); }
      _removeMeetTile(socketId);
      meetNames.delete(socketId);
    });

    socket.on('webrtc-offer', async ({ from, offer, roomId }) => {
      if (!meetActive || roomId !== meetRoomId) return;
      let pc = meetPeers.get(from);
      if (!pc) pc = await _createMeetPC(from, false);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc-answer', { to: from, answer, roomId: meetRoomId });
    });

    socket.on('webrtc-answer', async ({ from, answer }) => {
      const pc = meetPeers.get(from);
      if (!pc) return;
      try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); } catch {}
    });

    socket.on('webrtc-ice', async ({ from, candidate }) => {
      const pc = meetPeers.get(from);
      if (!pc) return;
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
    });
  }

  // ── PiP Video Popup ──────────────────────────────────────────────
  const pipChat      = document.getElementById('pip-chat');
  const pipTilesEl   = document.getElementById('pip-tiles');
  const pipRoomName  = document.getElementById('pip-room-name');
  const btnPipExpand = document.getElementById('btn-pip-expand');
  let   pipOpen      = false;

  // Build mini video tiles in pip from existing meet tile streams
  function _pipBuildTiles() {
    pipTilesEl.innerHTML = '';
    const meetTileNodes = meetTilesEl.querySelectorAll('.meet-tile');
    meetTileNodes.forEach(t => {
      const id    = t.id.replace('mti-', '');
      const srcV  = t.querySelector('video');
      const srcAv = t.querySelector('.meet-tile-av');
      const srcNm = t.querySelector('.meet-tile-name');

      const tile = document.createElement('div');
      tile.className = 'pip-tile';
      tile.id = 'piptile-' + id;

      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true;
      video.muted = (id === 'local');
      if (srcV && srcV.srcObject) video.srcObject = srcV.srcObject;

      const av = document.createElement('div');
      av.className = 'pip-tile-av';
      av.textContent = srcAv ? srcAv.textContent : '?';
      av.style.background = srcAv ? srcAv.style.background : '#444';

      const showAv = !srcV || srcV.style.display === 'none';
      video.style.display = showAv ? 'none' : 'block';
      av.style.display    = showAv ? 'flex'  : 'none';

      const name = document.createElement('div');
      name.className = 'pip-tile-name';
      name.textContent = srcNm ? srcNm.textContent : '';

      tile.appendChild(video);
      tile.appendChild(av);
      tile.appendChild(name);
      pipTilesEl.appendChild(tile);
    });
  }

  // Keep pip tiles in sync when meet tiles change (peer joins/leaves)
  function _pipSync() {
    if (!pipOpen) return;
    _pipBuildTiles();
  }

  function openPip() {
    pipOpen = true;
    pipRoomName.textContent = activeRoomId;
    _pipBuildTiles();
    meetOverlay.classList.add('hidden');
    pipChat.classList.remove('hidden');
    btnMeetPip.classList.add('active');
  }

  function closePip() {
    pipOpen = false;
    pipChat.classList.add('hidden');
    if (meetActive) meetOverlay.classList.remove('hidden');
    btnMeetPip.classList.remove('active');
  }

  function togglePiP() {
    if (!meetActive) return;
    if (pipOpen) closePip(); else openPip();
  }

  btnPipExpand.addEventListener('click', closePip);

  // Draggable pip window
  ;(function makeDraggable() {
    const handle = document.getElementById('pip-drag-handle');
    let dragging = false, ox = 0, oy = 0;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true;
      const r = pipChat.getBoundingClientRect();
      ox = e.clientX - r.left;
      oy = e.clientY - r.top;
      pipChat.style.transition = 'none';
      pipChat.style.right = 'auto';
      pipChat.style.bottom = 'auto';
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      pipChat.style.left = (e.clientX - ox) + 'px';
      pipChat.style.top  = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => {
      dragging = false;
      pipChat.style.transition = '';
    });
    handle.addEventListener('touchstart', (e) => {
      if (e.target.closest('button')) return;
      const t = e.touches[0];
      dragging = true;
      const r = pipChat.getBoundingClientRect();
      ox = t.clientX - r.left;
      oy = t.clientY - r.top;
      pipChat.style.right = 'auto';
      pipChat.style.bottom = 'auto';
    }, { passive: true });
    document.addEventListener('touchmove', (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      pipChat.style.left = (t.clientX - ox) + 'px';
      pipChat.style.top  = (t.clientY - oy) + 'px';
    }, { passive: true });
    document.addEventListener('touchend', () => { dragging = false; });
  })();

  btnMeetJoin.addEventListener('click', joinMeet);
  btnMeetMic.addEventListener('click', toggleMeetMic);
  btnMeetCam.addEventListener('click', toggleMeetCam);
  btnMeetScreen.addEventListener('click', toggleMeetScreen);
  btnMeetPip.addEventListener('click', togglePiP);
  btnMeetLeave.addEventListener('click', leaveMeet);
  btnMeetMin.addEventListener('click', () => meetOverlay.classList.add('hidden'));

  // ── Auto-rejoin on refresh ─────────────────────────────────────────────
  (function autoRejoin() {
    const session = loadSession();
    if (!session || !session.username || !Array.isArray(session.rooms) || session.rooms.length === 0) return;

    myUsername = session.username;
    selfIndicator.textContent = myUsername;

    socket = io();
    mySocketId = null;

    socket.on('connect', () => {
      mySocketId = socket.id;
      session.rooms.forEach(roomId => _socketJoinRoom(roomId));
    });

    socket.on('connect_error', () => {
      // Socket.io will auto-retry — just show a toast; keep session intact
      showToast('Reconnecting…');
    });

    setupSocketEvents();

    // Init all rooms so tabs render correctly
    session.rooms.forEach(roomId => _initRoom(roomId));

    // Show chat screen directly (no join screen)
    joinScreen.classList.remove('active');
    chatScreen.classList.add('active');
    buildEmojiPicker();
    buildStickerPicker();
    switchRoom(session.rooms[0]);
    messageInput.focus();
  })();

})();
