require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { OAuth2Client } = require('google-auth-library');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  noServer: true,
  clientTracking: true,
  perMessageDeflate: false,
  maxPayload: 256 * 1024
});

const configuredPort = Number(process.env.PORT);
const PORT = Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const MAX_PARTICIPANTS = clampNumber(process.env.MAX_PARTICIPANTS, 2, 100, 25);
const ROOM_IDLE_TIMEOUT_MS = clampNumber(process.env.ROOM_IDLE_TIMEOUT_MS, 60_000, 7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const DISCONNECT_GRACE_MS = clampNumber(process.env.DISCONNECT_GRACE_MS, 5_000, 5 * 60 * 1000, 30_000);
const SESSION_TTL_MS = 30 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_CHAT_LENGTH = 1_000;
const MAX_CAPTION_LENGTH = 500;
const MAX_TRANSLATION_LENGTH = 1_000;

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://kanhaiya1610.github.io'
];
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS.join(','))
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

const CAPTION_LANGUAGES = {
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  'es-ES': 'Spanish (Spain)',
  'es-MX': 'Spanish (Mexico)',
  'fr-FR': 'French',
  'de-DE': 'German',
  'it-IT': 'Italian',
  'pt-BR': 'Portuguese (Brazil)',
  'pt-PT': 'Portuguese (Portugal)',
  'ru-RU': 'Russian',
  'ja-JP': 'Japanese',
  'ko-KR': 'Korean',
  'zh-CN': 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  'hi-IN': 'Hindi',
  'ar-SA': 'Arabic',
  'nl-NL': 'Dutch',
  'pl-PL': 'Polish',
  'tr-TR': 'Turkish',
  'sv-SE': 'Swedish'
};

const rooms = new Map();
const connections = new Map();
const sessions = new Map();
const translationUsage = new Map();
const connectionAttempts = new Map();
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(number, min), max);
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function isAllowedOrigin(origin) {
  // Native WebSocket clients do not send Origin. Browser clients are checked.
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function canOpenConnection(request) {
  const address = request.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const record = connectionAttempts.get(address) || { startedAt: now, count: 0 };
  if (now - record.startedAt >= 60_000) {
    record.startedAt = now;
    record.count = 0;
  }
  record.count += 1;
  connectionAttempts.set(address, record);
  return record.count <= 30;
}

function parseIceServers() {
  const fallback = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (!process.env.ICE_SERVERS_JSON) return fallback;

  try {
    const parsed = JSON.parse(process.env.ICE_SERVERS_JSON);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('ICE_SERVERS_JSON must be a non-empty array');
    return parsed;
  } catch (error) {
    console.error('Invalid ICE_SERVERS_JSON; using public STUN fallback:', error.message);
    return fallback;
  }
}

const iceServers = parseIceServers();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400
}));
app.use(express.json({ limit: '32kb' }));

const generalHttpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again shortly.' }
});

const translationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Translation rate limit exceeded.' }
});

app.use(['/ice', '/translate'], generalHttpLimiter);

function getSessionFromRequest(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const session = sessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(match[1]);
    return null;
  }

  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function sendJsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

app.get('/health', (req, res) => {
  const response = {
    status: 'ok',
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  };

  if (process.env.EXPOSE_HEALTH_DETAILS === 'true') {
    response.rooms = rooms.size;
    response.connections = wss.clients.size;
  }

  res.json(response);
});

app.get('/ice', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    iceServers,
    iceTransportPolicy: process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    iceCandidatePoolSize: 10
  });
});

app.post('/translate', translationLimiter, async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) return sendJsonError(res, 401, 'Authentication required');

  if (!GEMINI_API_KEY) {
    return sendJsonError(res, 503, 'Translation service is not configured');
  }

  const { text, sourceLang, targetLang } = req.body || {};
  if (
    typeof text !== 'string' ||
    text.trim().length === 0 ||
    text.length > MAX_TRANSLATION_LENGTH ||
    !CAPTION_LANGUAGES[sourceLang] ||
    !CAPTION_LANGUAGES[targetLang]
  ) {
    return sendJsonError(res, 400, 'Invalid translation request');
  }

  const usage = translationUsage.get(session.user.sub) || { windowStartedAt: Date.now(), count: 0 };
  if (Date.now() - usage.windowStartedAt >= 60_000) {
    usage.windowStartedAt = Date.now();
    usage.count = 0;
  }
  if (usage.count >= 20) return sendJsonError(res, 429, 'Translation quota exceeded for this user');
  usage.count += 1;
  translationUsage.set(session.user.sub, usage);

  if (sourceLang === targetLang) {
    return res.json({ translatedText: text.trim() });
  }

  const sourceName = CAPTION_LANGUAGES[sourceLang];
  const targetName = CAPTION_LANGUAGES[targetLang];
  const prompt = [
    `Translate the following text from ${sourceName} to ${targetName}.`,
    'Return only the translation. Do not add explanations, labels, quotation marks, or commentary.',
    `Text: ${JSON.stringify(text.trim())}`
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: controller.signal
      }
    );

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      console.error('Translation provider rejected request:', response.status);
      return sendJsonError(res, 502, 'Translation provider unavailable');
    }

    const translatedText = payload?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!translatedText) return sendJsonError(res, 502, 'Translation provider returned no text');
    return res.json({ translatedText });
  } catch (error) {
    console.error('Translation request failed:', error.name === 'AbortError' ? 'timeout' : error.message);
    return sendJsonError(res, 502, 'Translation provider unavailable');
  } finally {
    clearTimeout(timeout);
  }
});

function safeSend(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify(message));
    return true;
  } catch (error) {
    console.error('WebSocket send failed:', error.message);
    return false;
  }
}

function broadcast(room, message, excludedClientId = null) {
  if (!room) return;
  for (const [clientId, participant] of room.participants) {
    if (clientId === excludedClientId) continue;
    safeSend(participant.ws, message);
  }
}

function participantState(participant) {
  return {
    clientId: participant.clientId,
    username: participant.user.name,
    picture: participant.user.picture || null,
    isMuted: Boolean(participant.isMuted),
    isAdminMuted: Boolean(participant.isAdminMuted),
    handRaised: Boolean(participant.handRaised),
    isCameraOff: Boolean(participant.isCameraOff),
    connected: Boolean(participant.ws)
  };
}

function getRoomState(room, excludedClientId = null) {
  return Array.from(room.participants.values())
    .filter(participant => participant.clientId !== excludedClientId)
    .map(participantState);
}

function touchRoom(room) {
  room.lastActivityAt = Date.now();
}

function createParticipant(state, roomId, resumeToken = randomToken()) {
  return {
    clientId: state.clientId,
    ws: state.ws,
    user: state.user,
    roomId,
    resumeToken,
    isMuted: false,
    isAdminMuted: false,
    handRaised: false,
    isCameraOff: false,
    connectedAt: Date.now(),
    lastSeenAt: Date.now(),
    disconnectTimer: null
  };
}

function sendYourInfo(state, room = null) {
  const isAdmin = Boolean(room && room.adminClientId === state.clientId);
  safeSend(state.ws, {
    type: 'your_info',
    clientId: state.clientId,
    isAdmin,
    adminToken: isAdmin ? room.adminToken : undefined,
    roomId: room?.roomId || null,
    user: state.user || null
  });
}

function requireAuthenticated(state) {
  if (!state.authenticated || !state.user) {
    safeSend(state.ws, { type: 'error', code: 'AUTH_REQUIRED', message: 'Please sign in before using the meeting.' });
    return false;
  }
  return true;
}

function getCurrentRoom(state) {
  return state.roomId ? rooms.get(state.roomId) : null;
}

function requireRoom(state) {
  const room = getCurrentRoom(state);
  if (!room) {
    safeSend(state.ws, { type: 'error', code: 'NOT_IN_ROOM', message: 'You are not in a meeting.' });
    return null;
  }
  touchRoom(room);
  return room;
}

function validateRoomId(value) {
  const roomId = String(value || '').trim().toUpperCase();
  return /^[A-Z0-9]{6}$/.test(roomId) ? roomId : null;
}

function stringValue(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function validateMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Invalid message format';
  if (typeof data.type !== 'string' || data.type.length > 40) return 'Missing or invalid message type';
  return null;
}

function rateLimitMessage(state, type) {
  const now = Date.now();
  state.messageTimes = state.messageTimes.filter(timestamp => now - timestamp < 10_000);
  const limit = type === 'caption' ? 80 : 150;
  if (state.messageTimes.length >= limit) return false;
  state.messageTimes.push(now);
  return true;
}

async function verifyGoogleCredential(credential) {
  if (!googleClient || !GOOGLE_CLIENT_ID) throw new Error('Google authentication is not configured');
  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();
  if (!payload || payload.iss !== 'https://accounts.google.com' && payload.iss !== 'accounts.google.com') {
    throw new Error('Invalid Google token issuer');
  }
  if (payload.email_verified !== true || !payload.sub || !payload.email) {
    throw new Error('Google account is not verified');
  }

  return {
    sub: payload.sub,
    email: payload.email,
    name: String(payload.name || payload.email.split('@')[0]).slice(0, 80),
    picture: typeof payload.picture === 'string' ? payload.picture.slice(0, 2_000) : null
  };
}

function createSession(user, clientId) {
  const token = randomToken(32);
  sessions.set(token, { user, clientId, expiresAt: Date.now() + SESSION_TTL_MS });
  return token;
}

function promoteReplacementAdmin(room) {
  const connected = Array.from(room.participants.values()).filter(participant => participant.ws);
  if (connected.length === 0) {
    rooms.delete(room.roomId);
    return;
  }

  const preferred = connected.find(participant => participant.user.sub === room.adminUserId);
  const replacement = preferred || connected[0];
  const previousAdminId = room.adminClientId;
  room.adminClientId = replacement.clientId;
  room.adminUserId = replacement.user.sub;
  room.adminToken = randomToken();
  safeSend(replacement.ws, {
    type: 'your_info',
    clientId: replacement.clientId,
    isAdmin: true,
    adminToken: room.adminToken,
    roomId: room.roomId,
    user: replacement.user
  });
  broadcast(room, {
    type: 'admin_changed',
    oldAdminId: previousAdminId,
    newAdminId: replacement.clientId,
    newAdminName: replacement.user.name
  });
}

function removeParticipant(room, participant, notify = true) {
  if (!room || !participant || !room.participants.has(participant.clientId)) return;
  if (participant.disconnectTimer) clearTimeout(participant.disconnectTimer);
  room.participants.delete(participant.clientId);
  if (notify) broadcast(room, { type: 'peer_left', clientId: participant.clientId });

  if (room.adminClientId === participant.clientId) {
    promoteReplacementAdmin(room);
  }

  if (room.participants.size === 0) rooms.delete(room.roomId);
}

function markDisconnected(state) {
  const room = getCurrentRoom(state);
  if (!room) return;
  const participant = room.participants.get(state.clientId);
  if (!participant || participant.ws !== state.ws) return;

  participant.ws = null;
  participant.lastSeenAt = Date.now();
  safeSend(state.ws, { type: 'disconnected', roomId: room.roomId });
  broadcast(room, { type: 'peer_disconnected', clientId: participant.clientId });

  participant.disconnectTimer = setTimeout(() => {
    const currentRoom = rooms.get(room.roomId);
    const currentParticipant = currentRoom?.participants.get(participant.clientId);
    if (currentParticipant && !currentParticipant.ws) removeParticipant(currentRoom, currentParticipant);
  }, DISCONNECT_GRACE_MS);
}

function closeRoom(room, reason) {
  if (!room) return;
  broadcast(room, { type: 'meeting_ended', reason });
  for (const participant of room.participants.values()) {
    if (participant.ws && participant.ws.readyState === WebSocket.OPEN) {
      participant.ws.close(1000, reason || 'Meeting ended');
    }
  }
  rooms.delete(room.roomId);
}

async function handleMessage(state, data) {
  const validationError = validateMessage(data);
  if (validationError) return safeSend(state.ws, { type: 'error', code: 'INVALID_MESSAGE', message: validationError });
  if (!rateLimitMessage(state, data.type)) {
    return safeSend(state.ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many messages. Please slow down.' });
  }

  switch (data.type) {
    case 'authenticate': {
      if (state.authenticated) return safeSend(state.ws, { type: 'error', code: 'ALREADY_AUTHENTICATED', message: 'This connection is already authenticated.' });
      const credential = stringValue(data.credential, 12_000);
      if (!credential) return safeSend(state.ws, { type: 'error', code: 'INVALID_CREDENTIAL', message: 'A valid Google credential is required.' });
      try {
        const user = await verifyGoogleCredential(credential);
        state.user = user;
        state.authenticated = true;
        state.sessionToken = createSession(user, state.clientId);
        safeSend(state.ws, { type: 'authenticated', sessionToken: state.sessionToken, user });
        sendYourInfo(state, getCurrentRoom(state));
      } catch (error) {
        console.error('Google authentication failed:', error.message);
        safeSend(state.ws, { type: 'error', code: 'AUTH_FAILED', message: 'Google sign-in could not be verified.' });
      }
      return;
    }

    case 'ping':
      return safeSend(state.ws, { type: 'pong', timestamp: Date.now() });

    case 'create_room': {
      if (!requireAuthenticated(state) || state.roomId) return;
      if (rooms.size >= 10_000) return safeSend(state.ws, { type: 'error', message: 'The meeting service is at capacity.' });

      const roomId = generateRoomId();
      const participant = createParticipant(state, roomId);
      const room = {
        roomId,
        adminClientId: state.clientId,
        adminUserId: state.user.sub,
        adminToken: randomToken(),
        participants: new Map([[state.clientId, participant]]),
        createdAt: Date.now(),
        lastActivityAt: Date.now()
      };
      rooms.set(roomId, room);
      state.roomId = roomId;

      safeSend(state.ws, { type: 'room_created', roomId, resumeToken: participant.resumeToken });
      sendYourInfo(state, room);
      return;
    }

    case 'join_room': {
      if (!requireAuthenticated(state) || state.roomId) return;
      const roomId = validateRoomId(data.roomId);
      if (!roomId) return safeSend(state.ws, { type: 'error', code: 'INVALID_ROOM', message: 'Enter a valid six-character meeting code.' });
      const room = rooms.get(roomId);
      if (!room) return safeSend(state.ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Meeting not found or already ended.' });
      if (room.participants.size >= MAX_PARTICIPANTS) return safeSend(state.ws, { type: 'error', code: 'ROOM_FULL', message: 'This meeting is full.' });

      const participant = createParticipant(state, roomId);
      room.participants.set(state.clientId, participant);
      state.roomId = roomId;
      touchRoom(room);

      broadcast(room, { type: 'peer_joined', ...participantState(participant) }, state.clientId);
      safeSend(state.ws, { type: 'room_joined', roomId, resumeToken: participant.resumeToken });
      safeSend(state.ws, { type: 'room_state', participants: getRoomState(room, state.clientId) });
      sendYourInfo(state, room);
      return;
    }

    case 'resume_room': {
      if (!requireAuthenticated(state) || state.roomId) return;
      const roomId = validateRoomId(data.roomId);
      const resumeToken = stringValue(data.resumeToken, 200);
      const room = roomId ? rooms.get(roomId) : null;
      if (!room || !resumeToken) return safeSend(state.ws, { type: 'error', code: 'RESUME_FAILED', message: 'Your meeting session could not be resumed.' });

      const participant = Array.from(room.participants.values()).find(candidate =>
        candidate.resumeToken === resumeToken && candidate.user.sub === state.user.sub
      );
      if (!participant) return safeSend(state.ws, { type: 'error', code: 'RESUME_FAILED', message: 'Your meeting session could not be resumed.' });

      if (participant.ws && participant.ws !== state.ws) participant.ws.close(1000, 'Session resumed elsewhere');
      if (participant.disconnectTimer) clearTimeout(participant.disconnectTimer);
      connections.delete(state.clientId);
      state.clientId = participant.clientId;
      connections.set(state.clientId, state);
      participant.ws = state.ws;
      participant.lastSeenAt = Date.now();
      state.roomId = room.roomId;
      touchRoom(room);

      safeSend(state.ws, { type: 'room_resumed', roomId: room.roomId, resumeToken: participant.resumeToken });
      safeSend(state.ws, { type: 'room_state', participants: getRoomState(room, state.clientId) });
      sendYourInfo(state, room);
      broadcast(room, { type: 'peer_reconnected', ...participantState(participant) }, state.clientId);
      return;
    }

    case 'leave_room': {
      const room = getCurrentRoom(state);
      if (room) {
        const participant = room.participants.get(state.clientId);
        removeParticipant(room, participant);
      }
      state.roomId = null;
      return safeSend(state.ws, { type: 'room_left' });
    }

    case 'offer':
    case 'answer':
    case 'ice_candidate': {
      const room = requireRoom(state);
      const targetId = stringValue(data.targetClientId || data.target, 100);
      if (!room || !targetId) return;
      const target = room.participants.get(targetId);
      if (!target || !target.ws) return;

      const payload = {
        type: data.type,
        from: state.clientId,
        fromId: state.clientId,
        fromUsername: state.user.name
      };
      if (data.type === 'ice_candidate') payload.candidate = data.candidate;
      else payload.sdp = data.sdp;
      safeSend(target.ws, payload);
      return;
    }

    case 'chat_message': {
      const room = requireRoom(state);
      const message = stringValue(data.message, MAX_CHAT_LENGTH);
      if (!room || !message) return;
      broadcast(room, {
        type: 'new_chat_message',
        fromClientId: state.clientId,
        fromUsername: state.user.name,
        message,
        timestamp: formatTimestamp()
      });
      return;
    }

    case 'caption': {
      const room = requireRoom(state);
      const text = stringValue(data.text, MAX_CAPTION_LENGTH);
      const language = CAPTION_LANGUAGES[data.language] ? data.language : 'en-US';
      if (!room || !text) return;
      broadcast(room, {
        type: 'caption',
        fromClientId: state.clientId,
        fromUsername: state.user.name,
        text,
        isFinal: Boolean(data.isFinal),
        language
      }, state.clientId);
      return;
    }

    case 'media_state': {
      const room = requireRoom(state);
      const participant = room?.participants.get(state.clientId);
      if (!room || !participant) return;
      if (typeof data.isMuted === 'boolean') participant.isMuted = data.isMuted;
      if (typeof data.isCameraOff === 'boolean') participant.isCameraOff = data.isCameraOff;
      if (typeof data.handRaised === 'boolean') participant.handRaised = data.handRaised;
      broadcast(room, { type: 'media_state', ...participantState(participant) });
      return;
    }

    case 'raise_hand': {
      const room = requireRoom(state);
      const participant = room?.participants.get(state.clientId);
      if (!room || !participant || typeof data.handRaised !== 'boolean') return;
      participant.handRaised = data.handRaised;
      broadcast(room, {
        type: 'hand_status_changed',
        clientId: participant.clientId,
        username: participant.user.name,
        handRaised: participant.handRaised
      });
      return;
    }

    case 'request_unmute': {
      const room = requireRoom(state);
      const admin = room ? room.participants.get(room.adminClientId) : null;
      if (!room || !admin) return;
      safeSend(admin.ws, {
        type: 'unmute_request',
        fromClientId: state.clientId,
        fromUsername: state.user.name
      });
      safeSend(state.ws, { type: 'unmute_request_sent' });
      return;
    }

    case 'admin_control': {
      const room = requireRoom(state);
      if (!room || room.adminClientId !== state.clientId || data.adminToken !== room.adminToken) {
        return safeSend(state.ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Only the host can perform that action.' });
      }

      if (data.action === 'mute_toggle' && typeof data.targetClientId === 'string') {
        const target = room.participants.get(data.targetClientId);
        if (!target || target.clientId === state.clientId) return;
        target.isMuted = Boolean(data.muteState);
        target.isAdminMuted = Boolean(data.muteState);
        safeSend(target.ws, {
          type: 'force_mute',
          targetClientId: target.clientId,
          muteState: target.isMuted,
          isAdminMuted: target.isAdminMuted
        });
        broadcast(room, { type: 'media_state', ...participantState(target) });
      } else if (data.action === 'mute_all') {
        for (const target of room.participants.values()) {
          if (target.clientId === state.clientId) continue;
          target.isMuted = true;
          target.isAdminMuted = true;
          target.handRaised = false;
          safeSend(target.ws, {
            type: 'force_mute',
            targetClientId: target.clientId,
            muteState: true,
            isAdminMuted: true
          });
        }
        broadcast(room, { type: 'all_hands_lowered' });
      } else if (data.action === 'transfer_admin' && typeof data.targetClientId === 'string') {
        const target = room.participants.get(data.targetClientId);
        if (!target || !target.ws || target.clientId === state.clientId) return;
        const oldAdminId = room.adminClientId;
        room.adminClientId = target.clientId;
        room.adminUserId = target.user.sub;
        room.adminToken = randomToken();
        sendYourInfo(target.ws ? { ...state, ws: target.ws, clientId: target.clientId, user: target.user } : target, room);
        safeSend(target.ws, { type: 'promoted_to_admin', byUsername: state.user.name });
        sendYourInfo(state, room);
        broadcast(room, {
          type: 'admin_changed',
          oldAdminId,
          newAdminId: target.clientId,
          newAdminName: target.user.name
        });
      }
      return;
    }

    case 'end_meeting': {
      const room = requireRoom(state);
      if (!room || room.adminClientId !== state.clientId || data.adminToken !== room.adminToken) {
        return safeSend(state.ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Only the host can end the meeting.' });
      }
      closeRoom(room, 'Meeting ended by host');
      return;
    }

    default:
      return safeSend(state.ws, { type: 'error', code: 'UNKNOWN_MESSAGE', message: 'Unsupported message type.' });
  }
}

wss.on('connection', (ws, request) => {
  const state = {
    clientId: crypto.randomUUID(),
    ws,
    user: null,
    authenticated: false,
    sessionToken: null,
    roomId: null,
    messageTimes: [],
    authTimer: null
  };
  connections.set(state.clientId, state);
  ws.isAlive = true;

  state.authTimer = setTimeout(() => {
    if (!state.authenticated) ws.close(1008, 'Authentication required');
  }, AUTH_TIMEOUT_MS);

  safeSend(ws, { type: 'your_info', clientId: state.clientId, isAdmin: false, user: null });

  ws.on('pong', () => {
    ws.isAlive = true;
    const participant = getCurrentRoom(state)?.participants.get(state.clientId);
    if (participant) participant.lastSeenAt = Date.now();
  });

  ws.on('message', async raw => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (error) {
      return safeSend(ws, { type: 'error', code: 'INVALID_JSON', message: 'Message must be valid JSON.' });
    }
    try {
      await handleMessage(state, data);
    } catch (error) {
      console.error('Unhandled WebSocket message error:', error);
      safeSend(ws, { type: 'error', code: 'SERVER_ERROR', message: 'The server could not process that request.' });
    }
  });

  ws.on('close', () => {
    if (state.authTimer) clearTimeout(state.authTimer);
    if (connections.get(state.clientId) !== state) return;
    connections.delete(state.clientId);
    markDisconnected(state);
  });

  ws.on('error', error => {
    console.error(`WebSocket error for ${state.clientId}:`, error.message);
  });
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  if (!['/', '/ws'].includes(pathname) || !isAllowedOrigin(request.headers.origin) || !canOpenConnection(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
});

function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let roomId;
  do {
    roomId = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(roomId));
  return roomId;
}

function formatTimestamp() {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.participants.size === 0 || now - room.lastActivityAt > ROOM_IDLE_TIMEOUT_MS) {
      closeRoom(room, 'Meeting expired');
      rooms.delete(roomId);
    }
  }
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  for (const [userId, usage] of translationUsage) {
    if (now - usage.windowStartedAt > 60_000) translationUsage.delete(userId);
  }
  for (const [address, record] of connectionAttempts) {
    if (now - record.startedAt > 60_000) connectionAttempts.delete(address);
  }
}, 60_000);
cleanupInterval.unref();

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30_000);
heartbeatInterval.unref();

function startServer() {
  return server.listen(PORT, () => {
    console.log(`Meeting server listening on port ${server.address().port}`);
    console.log(`Allowed browser origins: ${Array.from(ALLOWED_ORIGINS).join(', ')}`);
    console.log(`Google authentication: ${GOOGLE_CLIENT_ID ? 'configured' : 'NOT CONFIGURED'}`);
    console.log(`Translation service: ${GEMINI_API_KEY ? 'configured' : 'disabled'}`);
  });
}

if (require.main === module) startServer();

module.exports = { app, server, rooms, startServer };
