'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const cookieParser = require('cookie-parser');

// ─── Config ──────────────────────────────────────────────────────────────────

// Load .env if present (no dependency needed – manual parse for simplicity)
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split('\n')
    .forEach(line => {
      const clean = line.trim();
      if (!clean || clean.startsWith('#')) return;
      const eq = clean.indexOf('=');
      if (eq === -1) return;
      const key = clean.slice(0, eq).trim();
      const val = clean.slice(eq + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    });
}

const DATA_FILE  = process.env.DATA_FILE
  ? path.resolve(__dirname, process.env.DATA_FILE)
  : path.join(__dirname, 'data.json');

const JWT_SECRET = process.env.JWT_SECRET;
const PORT       = parseInt(process.env.PORT || '3000', 10);

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is not set.');
  process.exit(1);
}

const BCRYPT_ROUNDS   = parseInt(process.env.BCRYPT_ROUNDS    || '12',   10);
const MSG_MAX_LENGTH  = parseInt(process.env.MSG_MAX_LENGTH   || '4000', 10);
const MAX_MSG_LIMIT   = parseInt(process.env.MAX_MSG_LIMIT    || '200',  10);
const SAVE_DEBOUNCE   = parseInt(process.env.SAVE_DEBOUNCE_MS || '200',  10);
const CORS_ORIGIN     = process.env.CORS_ORIGIN || '*';

// Only accept connections from a trusted reverse proxy (e.g. Cloudflare, nginx).
// Set to the proxy's IP or CIDR in production so req.ip is the real visitor IP,
// not the proxy's. Set BIND_HOST to 127.0.0.1 to refuse direct internet connections.
const TRUSTED_PROXY   = process.env.TRUSTED_PROXY || false;   // e.g. '103.21.244.0/22'
const BIND_HOST       = process.env.BIND_HOST || '0.0.0.0';   // '127.0.0.1' = loopback only

// Auto-detect proxy prefix from the request URL at runtime.
// Matches /proxy/<token>/<token> e.g. /proxy/3000/content
const PROXY_RE = /^(\/proxy\/[^/?#]+(?:\/[^/?#]+)?)/;

const USERNAME_MIN = parseInt(process.env.USERNAME_MIN_LENGTH || '3',  10);
const USERNAME_MAX = parseInt(process.env.USERNAME_MAX_LENGTH || '32', 10);
const PASSWORD_MIN = parseInt(process.env.PASSWORD_MIN_LENGTH || '8',  10);
const USERNAME_PATTERN = new RegExp(`^[a-zA-Z0-9_-]{${USERNAME_MIN},${USERNAME_MAX}}$`);

const SOCKET_PING_TIMEOUT  = parseInt(process.env.SOCKET_PING_TIMEOUT_MS  || '30000', 10);
const SOCKET_PING_INTERVAL = parseInt(process.env.SOCKET_PING_INTERVAL_MS || '15000', 10);

const RATE = {
  register: { window: parseInt(process.env.RATE_LIMIT_REGISTER_WINDOW_MS || '60000', 10), max: parseInt(process.env.RATE_LIMIT_REGISTER_MAX || '5',  10) },
  login:    { window: parseInt(process.env.RATE_LIMIT_LOGIN_WINDOW_MS    || '60000', 10), max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX    || '10', 10) },
  messages: { window: parseInt(process.env.RATE_LIMIT_MESSAGES_WINDOW_MS || '10000', 10), max: parseInt(process.env.RATE_LIMIT_MESSAGES_MAX || '30', 10) },
  contacts: { window: parseInt(process.env.RATE_LIMIT_CONTACTS_WINDOW_MS || '60000', 10), max: parseInt(process.env.RATE_LIMIT_CONTACTS_MAX || '20', 10) },
};

// ─── App / Server ─────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  path: '/socket.io',  // Socket.IO path is always /socket.io; the proxy rewrite handles the prefix
  cors: { origin: CORS_ORIGIN, credentials: true },
  pingTimeout: SOCKET_PING_TIMEOUT,
  pingInterval: SOCKET_PING_INTERVAL,
});

// ─── Middleware ───────────────────────────────────────────────────────────────

// Tell Express to trust the proxy so req.ip reflects the real visitor IP.
if (TRUSTED_PROXY) app.set('trust proxy', TRUSTED_PROXY);

app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));

// Strip headers that leak server identity or origin IP
app.use((_req, res, next) => {
  res.removeHeader('X-Powered-By');          // hides 'Express'
  res.removeHeader('Server');                // hides Node/http server banner
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');  // prevents Referer leaking your origin URL
  next();
});
// Auto-detect and strip /proxy/<token>/<token> prefix so all routes stay path-agnostic.
// Works transparently whether accessed directly or through a reverse proxy.
app.use((req, _res, next) => {
  const original = req.url;
  const m = PROXY_RE.exec(req.url);
  if (m) {
    req.url = req.url.slice(m[1].length) || '/';
    req.path = req.url.split('?')[0] || '/';
    console.log(`[proxy-rewrite] ${original} -> ${req.url}`);
  } else {
    console.log(`[proxy-rewrite] no match for: ${original}`);
  }
  next();
});

const PUBLIC_DIR = process.env.PUBLIC_DIR
  ? path.resolve(__dirname, process.env.PUBLIC_DIR)
  : path.join(__dirname, 'public');
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const HAS_INDEX  = fs.existsSync(INDEX_FILE); // check once at startup

app.use('/', express.static(PUBLIC_DIR));

// SPA fallback: serve index.html for any non-API GET that wasn't a static file.
// Uses req.url (already rewritten above) rather than req.path to be safe.
app.use((req, res, next) => {
  const p = req.url.split('?')[0];
  if (req.method === 'GET' && !p.startsWith('/api/') && !p.startsWith('/socket.io') && HAS_INDEX) {
    return res.sendFile(INDEX_FILE);
  }
  next();
});

// Simple in-process rate limiter (per IP, per route prefix)
const rateLimitMap = new Map(); // key → { count, resetAt }
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key   = `${req.ip}:${req.path}`;
    const now   = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > max) {
      return res.status(429).json({ error: 'Too many requests, please slow down.' });
    }
    next();
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const EMPTY_STORE = { users: [], chats: [], contactRequests: [] };

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(EMPTY_STORE, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Corrupt data.json – starting fresh:', err.message);
    return JSON.parse(JSON.stringify(EMPTY_STORE));
  }
}

let data = loadData();

let saveTimeout = null;
function saveDataDebounced() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    const tmp = DATA_FILE + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DATA_FILE);   // atomic replace
    } catch (err) {
      console.error('Failed to save data.json:', err.message);
    }
    saveTimeout = null;
  }, SAVE_DEBOUNCE);
}

// Flush before exit
process.on('SIGINT',  () => { if (saveTimeout) { clearTimeout(saveTimeout); saveDataSync(); } process.exit(0); });
process.on('SIGTERM', () => { if (saveTimeout) { clearTimeout(saveTimeout); saveDataSync(); } process.exit(0); });
function saveDataSync() {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (_) {}
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

function createToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
}

const COOKIE_NAME = 'kx_token';
const COOKIE_OPTS = {
  httpOnly: true,                        // JS cannot read this
  sameSite: 'lax',                       // CSRF protection
  secure: process.env.NODE_ENV === 'production', // HTTPS only in prod
  maxAge: 7 * 24 * 60 * 60 * 1000       // 7 days
};

function authMiddleware(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not authenticated.' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired session.' });
  }
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

const findUserByUsername     = (u)  => data.users.find(x => x.username === u);
const findUserById           = (id) => data.users.find(x => x.id === id);
const findUserByContactNumber = (n)  => data.users.find(x => x.contactNumber === n);

function resolveTarget(withUser) {
  if (/^C-\d{6}$/.test(withUser)) return findUserByContactNumber(withUser);
  return findUserByUsername(withUser);
}

function generateContactNumber() {
  let n;
  do { n = 'C-' + Math.floor(100000 + Math.random() * 900000); }
  while (data.users.find(u => u.contactNumber === n));
  return n;
}

function publicUser(u) {
  return { id: u.id, username: u.username, contactNumber: u.contactNumber };
}

function findOrCreateDirectChat(userA, userB) {
  let chat = data.chats.find(
    c => c.type === 'direct' &&
         c.participants.includes(userA) &&
         c.participants.includes(userB)
  );
  if (!chat) {
    chat = { id: 'chat-' + uuidv4(), type: 'direct', participants: [userA, userB], messages: [], updatedAt: Date.now() };
    data.chats.push(chat);
    saveDataDebounced();
  }
  return chat;
}

function findOrCreateInbox(username) {
  let chat = data.chats.find(
    c => c.type === 'inbox' && c.participants.length === 1 && c.participants[0] === username
  );
  if (!chat) {
    chat = { id: 'inbox-' + username, type: 'inbox', participants: [username], messages: [], updatedAt: Date.now() };
    data.chats.push(chat);
    saveDataDebounced();
  }
  return chat;
}

function systemMessage(text, meta = {}) {
  return { id: 'm-' + uuidv4(), sender: 'system', text, timestamp: Date.now(), meta };
}

function pushToInbox(username, msg) {
  const inbox = findOrCreateInbox(username);
  inbox.messages.push(msg);
  inbox.updatedAt = Date.now();
  io.to(inbox.id).emit('new_message', { chatId: inbox.id, message: msg });
}

// ─── Validation helpers ───────────────────────────────────────────────────────

function validateBody(req, res, fields) {
  for (const f of fields) {
    if (!req.body[f] || typeof req.body[f] !== 'string' || !req.body[f].trim()) {
      res.status(400).json({ error: `'${f}' is required.` });
      return false;
    }
  }
  return true;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Register
app.post('/api/register', rateLimit(RATE.register.window, RATE.register.max), async (req, res) => {
  if (!validateBody(req, res, ['username', 'password'])) return;

  const { username, password } = req.body;

  if (!USERNAME_PATTERN.test(username)) {
    return res.status(400).json({ error: `Username must be ${USERNAME_MIN}–${USERNAME_MAX} characters and contain only letters, numbers, _ or -.` });
  }
  if (password.length < PASSWORD_MIN) {
    return res.status(400).json({ error: `Password must be at least ${PASSWORD_MIN} characters.` });
  }
  if (findUserByUsername(username)) {
    return res.status(409).json({ error: 'Username is already taken.' });
  }

  const id           = 'user-' + uuidv4();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const contactNumber = generateContactNumber();
  const now          = Date.now();

  const user = { id, username, passwordHash, contactNumber, createdAt: now, lastSeen: now };
  data.users.push(user);
  findOrCreateInbox(username);
  saveDataDebounced();

  const token = createToken(user);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  res.status(201).json({ user: publicUser(user) });
});

// Login
app.post('/api/login', rateLimit(RATE.login.window, RATE.login.max), async (req, res) => {
  if (!validateBody(req, res, ['username', 'password'])) return;

  const { username, password } = req.body;
  const user = findUserByUsername(username);

  // Always hash-compare to prevent timing attacks leaking whether a user exists
  const hash = user ? user.passwordHash : '$2b$12$invalidhashfortimingattempts00000000000000000000000';
  const ok   = await bcrypt.compare(password, hash);

  if (!user || !ok) return res.status(401).json({ error: 'Invalid username or password.' });

  user.lastSeen = Date.now();
  saveDataDebounced();

  const token = createToken(user);
  res.cookie(COOKIE_NAME, token, COOKIE_OPTS);
  res.json({ user: publicUser(user) });
});

// Current user
app.get('/api/me', authMiddleware, (req, res) => {
  const user = findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  res.json({ ...publicUser(user), createdAt: user.createdAt, lastSeen: user.lastSeen });
});

// User list (omit sensitive fields)
app.get('/api/users', authMiddleware, (req, res) => {
  res.json(data.users.map(publicUser));
});

// Chats list
app.get('/api/chats', authMiddleware, (req, res) => {
  const { username } = req.user;
  const chats = data.chats
    .filter(c => c.participants.includes(username))
    .map(c => ({
      id:          c.id,
      type:        c.type,
      participants: c.participants,
      lastMessage: c.messages.length ? c.messages[c.messages.length - 1] : null,
      updatedAt:   c.updatedAt,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json(chats);
});

// Create / get direct chat
app.post('/api/chats/direct', authMiddleware, (req, res) => {
  if (!validateBody(req, res, ['withUser'])) return;
  const { username }  = req.user;
  const { withUser }  = req.body;
  const targetUser    = resolveTarget(withUser.trim());

  if (!targetUser)                  return res.status(404).json({ error: 'User not found.' });
  if (targetUser.username === username) return res.status(400).json({ error: 'Cannot start a chat with yourself.' });

  res.json(findOrCreateDirectChat(username, targetUser.username));
});

// Get messages (paginated)
app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
  const { chatId }   = req.params;
  const { username } = req.user;
  const limit  = Math.min(MAX_MSG_LIMIT, Math.max(1, parseInt(req.query.limit || '50', 10)));
  const before = parseInt(req.query.before || '0', 10);

  const chat = data.chats.find(c => c.id === chatId && c.participants.includes(username));
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });

  let messages = chat.messages;
  if (before) messages = messages.filter(m => m.timestamp < before);
  res.json(messages.slice(-limit));
});

// Post message (REST path – socket is preferred for real-time)
app.post('/api/chats/:chatId/messages', authMiddleware, rateLimit(RATE.messages.window, RATE.messages.max), (req, res) => {
  const { chatId }   = req.params;
  const { username } = req.user;

  if (!validateBody(req, res, ['text'])) return;

  const { text } = req.body;
  if (text.length > MSG_MAX_LENGTH) {
    return res.status(400).json({ error: `Message exceeds ${MSG_MAX_LENGTH} character limit.` });
  }

  const chat = data.chats.find(c => c.id === chatId && c.participants.includes(username));
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });

  const message = { id: 'm-' + uuidv4(), sender: username, text: text.trim(), timestamp: Date.now(), meta: {} };
  chat.messages.push(message);
  chat.updatedAt = Date.now();
  saveDataDebounced();

  io.to(chat.id).emit('new_message', { chatId: chat.id, message });
  res.status(201).json(message);
});

// ─── Contact accept helper ────────────────────────────────────────────────────

function acceptContactRequest(request) {
  request.status     = 'accepted';
  request.resolvedAt = Date.now();
  const requestId    = request.id;
  const direct = findOrCreateDirectChat(request.from, request.to);
  pushToInbox(request.to,   systemMessage(`You accepted ${request.from}'s contact request. A chat has been created.`, { type: 'contact_accepted', requestId }));
  pushToInbox(request.from, systemMessage(`${request.to} accepted your contact request. You can now chat.`,           { type: 'contact_accepted', requestId }));
  saveDataDebounced();
  io.emit('chat_created', { chat: direct });
  return direct;
}

// ─── Contact requests ─────────────────────────────────────────────────────────

// Get all contact requests involving the current user
app.get('/api/contacts/requests', authMiddleware, (req, res) => {
  const { username } = req.user;
  const requests = data.contactRequests.filter(
    r => r.from === username || r.to === username
  );
  res.json(requests);
});

app.post('/api/contacts/request', authMiddleware, rateLimit(RATE.contacts.window, RATE.contacts.max), (req, res) => {
  if (!validateBody(req, res, ['to'])) return;

  const from       = req.user.username;
  const { to }     = req.body;
  const targetUser = resolveTarget(to.trim());

  if (!targetUser)                  return res.status(404).json({ error: 'User not found.' });
  if (targetUser.username === from) return res.status(400).json({ error: 'Cannot send a request to yourself.' });

  const toUsername = targetUser.username;
  const existing   = data.contactRequests.find(
    r => r.from === from && r.to === toUsername && r.status === 'pending'
  );
  if (existing) return res.status(409).json({ error: 'A request is already pending.' });

  const request = { id: 'req-' + uuidv4(), from, to: toUsername, status: 'pending', timestamp: Date.now() };
  data.contactRequests.push(request);

  // Check if the other person already sent a request to us — auto-accept mutually
  const reverse = data.contactRequests.find(
    r => r.from === toUsername && r.to === from && r.status === 'pending'
  );
  if (reverse) {
    // Accept the reverse request (which also creates the chat and notifies both)
    const direct = acceptContactRequest(reverse);
    // Also mark our new request as accepted
    request.status     = 'accepted';
    request.resolvedAt = Date.now();
    return res.status(201).json({ ok: true, mutual: true, request, chat: direct });
  }

  const msg = systemMessage(`${from} sent you a contact request.`, { requestId: request.id, type: 'contact_request', from });
  pushToInbox(toUsername, msg);
  saveDataDebounced();

  res.status(201).json({ ok: true, request });
});

app.post('/api/contacts/respond', authMiddleware, (req, res) => {
  const { username } = req.user;
  if (!validateBody(req, res, ['requestId', 'action'])) return;

  const { requestId, action } = req.body;
  if (!['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: "action must be 'accept' or 'decline'." });
  }

  const request = data.contactRequests.find(r => r.id === requestId);
  if (!request)                    return res.status(404).json({ error: 'Request not found.' });
  if (request.to !== username)     return res.status(403).json({ error: 'Not authorized.' });
  if (request.status !== 'pending') return res.status(409).json({ error: 'Request already handled.' });

  request.status     = action === 'accept' ? 'accepted' : 'declined';
  request.resolvedAt = Date.now();

  if (action === 'accept') {
    const direct = acceptContactRequest(request);
    return res.json({ ok: true, status: 'accepted', chat: direct });
  }

  // declined
  pushToInbox(request.from, systemMessage(`${request.to} declined your contact request.`, { type: 'contact_declined', requestId }));
  saveDataDebounced();
  res.json({ ok: true, status: 'declined' });
});

// Logout — clear the auth cookie
app.post('/api/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, COOKIE_OPTS);
  res.json({ ok: true });
});

// ─── 404 fallback ─────────────────────────────────────────────────────────────

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// ─── Global error handler ─────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  // Try cookie first, fall back to handshake.auth.token for backwards compat
  let token = null;
  const cookieHeader = socket.handshake.headers.cookie || '';
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (match) token = decodeURIComponent(match[1]);
  if (!token) token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication error: no token.'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Authentication error: invalid token.'));
  }
});

io.on('connection', (socket) => {
  const { username } = socket.user;

  // Join all existing chat rooms for this user
  data.chats
    .filter(c => c.participants.includes(username))
    .forEach(c => socket.join(c.id));

  socket.emit('connected', { username });

  // Also join any new chat rooms created later (e.g. after accepting a request)
  socket.on('join_chat', ({ chatId }) => {
    const chat = data.chats.find(c => c.id === chatId && c.participants.includes(username));
    if (chat) socket.join(chat.id);
  });

  socket.on('send_message', ({ chatId, text } = {}) => {
    if (!chatId || !text || typeof text !== 'string') return;

    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MSG_MAX_LENGTH) return;

    const chat = data.chats.find(c => c.id === chatId && c.participants.includes(username));
    if (!chat) return;

    const message = { id: 'm-' + uuidv4(), sender: username, text: trimmed, timestamp: Date.now(), meta: {} };
    chat.messages.push(message);
    chat.updatedAt = Date.now();
    saveDataDebounced();

    io.to(chat.id).emit('new_message', { chatId: chat.id, message });
  });

  socket.on('typing', ({ chatId, typing } = {}) => {
    if (!chatId) return;
    socket.to(chatId).emit('typing', { chatId, username, typing: Boolean(typing) });
  });

  socket.on('disconnect', () => {
    const user = findUserByUsername(username);
    if (user) { user.lastSeen = Date.now(); saveDataDebounced(); }
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(PORT, BIND_HOST, () => {
  console.log(`Server listening on ${BIND_HOST}:${PORT}`);
  if (BIND_HOST === '127.0.0.1') {
    console.log('  Bound to loopback only — direct internet access is blocked.');
  }
  if (TRUSTED_PROXY) {
    console.log(`  Trusting proxy: ${TRUSTED_PROXY}`);
  } else {
    console.warn('  WARNING: TRUSTED_PROXY not set. Set it to your proxy IP in production.');
  }
});