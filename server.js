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
const REQUIRE_TLS = process.env.REQUIRE_TLS === 'true' || NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_TRANSCRIPTION_MODEL = process.env.GROQ_TRANSCRIPTION_MODEL || 'whisper-large-v3-turbo';
const GROQ_MAX_AUDIO_BYTES = clampNumber(process.env.GROQ_MAX_AUDIO_BYTES, 256 * 1024, 25 * 1024 * 1024, 10 * 1024 * 1024);
const MAX_PARTICIPANTS = clampNumber(process.env.MAX_PARTICIPANTS, 2, 100, 25);
const ROOM_IDLE_TIMEOUT_MS = clampNumber(process.env.ROOM_IDLE_TIMEOUT_MS, 60_000, 7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000);
const DISCONNECT_GRACE_MS = clampNumber(process.env.DISCONNECT_GRACE_MS, 5_000, 5 * 60 * 1000, 30_000);
const SESSION_TTL_MS = 30 * 60 * 1000;
const AUTH_TIMEOUT_MS = 10_000;
const MAX_CHAT_LENGTH = 1_000;
const MAX_CAPTION_LENGTH = 500;
const MAX_TRANSLATION_LENGTH = 1_000;
const MAX_SIGNALING_SDP_LENGTH = 100_000;
const MAX_SIGNALING_CANDIDATE_LENGTH = 8_000;
const MAX_INBOUND_BYTES_PER_WINDOW = 1_500_000;
const MAX_INVALID_MESSAGES = 5;
const MAX_OUTBOUND_BUFFERED_BYTES = 512 * 1024;
const MAX_ACTIVE_CONNECTIONS = clampNumber(process.env.MAX_ACTIVE_CONNECTIONS, 10, 50_000, 2_000);
const MAX_CONNECTIONS_PER_IP = clampNumber(process.env.MAX_CONNECTIONS_PER_IP, 1, 200, 25);
const MAX_CONNECTIONS_PER_USER = clampNumber(process.env.MAX_CONNECTIONS_PER_USER, 1, 20, 5);
const MAX_ACTIVE_ROOMS = clampNumber(process.env.MAX_ACTIVE_ROOMS, 1, 20_000, 2_000);
const MAX_ROOMS_PER_USER = clampNumber(process.env.MAX_ROOMS_PER_USER, 1, 100, 5);
const JOIN_REQUEST_TTL_MS = clampNumber(process.env.JOIN_REQUEST_TTL_MS, 15_000, 10 * 60 * 1000, 120_000);
const JOIN_GRANT_TTL_MS = clampNumber(process.env.JOIN_GRANT_TTL_MS, 10_000, 5 * 60 * 1000, 30_000);
const MAX_PENDING_JOIN_REQUESTS = clampNumber(process.env.MAX_PENDING_JOIN_REQUESTS, 1, 200, 50);
const TRUST_PROXY_HOPS = clampNumber(process.env.TRUST_PROXY_HOPS, 0, 10, 0);

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
const pendingJoinRequests = new Map();
const connectionAttempts = new Map();
const activeConnectionsByIp = new Map();
const authenticatedConnectionsByUser = new Map();
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
  // Non-browser HTTP clients may omit Origin. Browser WebSocket upgrades use
  // the stricter check below.
  return !origin || ALLOWED_ORIGINS.has(origin);
}

function isAllowedWebSocketOrigin(origin) {
  // A browser must send Origin in production. Native clients are not part of
  // this browser product and should not get an origin-check bypass.
  return origin ? ALLOWED_ORIGINS.has(origin) : NODE_ENV !== 'production';
}

function getClientAddress(request) {
  if (TRUST_PROXY_HOPS > 0) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) return forwarded.split(',')[0].trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

function canOpenConnection(request) {
  if (wss.clients.size >= MAX_ACTIVE_CONNECTIONS) return false;
  const address = getClientAddress(request);
  if ((activeConnectionsByIp.get(address) || 0) >= MAX_CONNECTIONS_PER_IP) return false;
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

function incrementCount(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function decrementCount(map, key) {
  const next = (map.get(key) || 0) - 1;
  if (next > 0) map.set(key, next);
  else map.delete(key);
}

function countRoomsCreatedBy(userId) {
  let count = 0;
  for (const room of rooms.values()) {
    if (room.createdByUserId === userId) count += 1;
  }
  return count;
}

function registerAuthenticatedConnection(state, userId) {
  if ((authenticatedConnectionsByUser.get(userId) || 0) >= MAX_CONNECTIONS_PER_USER) return false;
  state.authenticatedUserId = userId;
  incrementCount(authenticatedConnectionsByUser, userId);
  return true;
}

function unregisterAuthenticatedConnection(state) {
  if (!state.authenticatedUserId) return;
  decrementCount(authenticatedConnectionsByUser, state.authenticatedUserId);
  state.authenticatedUserId = null;
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
const publicIceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Caption-Language',
    'X-Caption-Chunk'
  ],
  maxAge: 86400
}));
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  if (!REQUIRE_TLS || req.path === '/health') return next();
  const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (req.secure || forwardedProtocol === 'https' || req.socket.encrypted) return next();
  return sendJsonError(res, 426, 'HTTPS is required');
});

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

const transcriptionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: req => req.meetingSession.user.sub,
  message: { error: 'Caption transcription rate limit exceeded.' }
});

app.use(['/ice', '/translate'], generalHttpLimiter);
app.use('/captions/transcribe', generalHttpLimiter);

function getSessionFromRequest(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const session = sessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    if (session) sessions.delete(match[1]);
    return null;
  }

  const connection = connections.get(session.clientId);
  if (
    !connection ||
    !connection.authenticated ||
    connection.sessionToken !== match[1] ||
    connection.user?.sub !== session.user.sub
  ) {
    sessions.delete(match[1]);
    return null;
  }

  return session;
}

function sendJsonError(res, status, message) {
  return res.status(status).json({ error: message });
}

function requireSession(req, res, next) {
  const session = getSessionFromRequest(req);
  if (!session) return sendJsonError(res, 401, 'Authentication required');
  req.meetingSession = session;
  return next();
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
  const session = getSessionFromRequest(req);
  res.set('Cache-Control', 'no-store');
  res.json({
    // Never expose configured TURN credentials to unauthenticated callers.
    // Use short-lived TURN credentials in ICE_SERVERS_JSON in production.
    iceServers: session ? iceServers : publicIceServers,
    iceTransportPolicy: session && process.env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
    iceCandidatePoolSize: 10
  });
});

app.post('/translate', translationLimiter, async (req, res) => {
  const session = getSessionFromRequest(req);
  if (!session) return sendJsonError(res, 401, 'Authentication required');
  res.set('Cache-Control', 'no-store');

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

  const trimmedText = text.trim();
  if (sourceLang === targetLang) {
    return res.json({ translatedText: trimmedText });
  }

  const usage = translationUsage.get(session.user.sub) || { windowStartedAt: Date.now(), count: 0 };
  if (Date.now() - usage.windowStartedAt >= 60_000) {
    usage.windowStartedAt = Date.now();
    usage.count = 0;
  }
  if (usage.count >= 60) return sendJsonError(res, 429, 'Translation quota exceeded for this user');
  usage.count += 1;
  translationUsage.set(session.user.sub, usage);

  const sourceName = CAPTION_LANGUAGES[sourceLang];
  const targetName = CAPTION_LANGUAGES[targetLang];
  const prompt = [
    `Translate the following spoken conversation text directly from ${sourceName} to ${targetName}.`,
    'Return ONLY the direct translation. Do not add quotes, markdown formatting, explanations, or commentary.',
    `Text: ${JSON.stringify(trimmedText)}`
  ].join('\n');

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 200
          }
        }),
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

function getWhisperLanguage(language) {
  if (typeof language !== 'string') return null;
  const normalized = language.trim().toLowerCase();
  return /^[a-z]{2}$/.test(normalized) ? normalized : normalized.split('-')[0].match(/^[a-z]{2}$/)?.[0] || null;
}

const ALLOWED_AUDIO_TYPES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav'
]);

app.post(
  '/captions/transcribe',
  requireSession,
  transcriptionLimiter,
  express.raw({ type: () => true, limit: GROQ_MAX_AUDIO_BYTES }),
  async (req, res) => {
  const session = req.meetingSession;
  res.set('Cache-Control', 'no-store');

  const connection = connections.get(session.clientId);
  const room = connection ? getCurrentRoom(connection) : null;
  if (!connection || !room || !connection.authenticated) {
    return sendJsonError(res, 403, 'You must be in a meeting to transcribe audio');
  }
  if (!GROQ_API_KEY) return sendJsonError(res, 503, 'Groq transcription is not configured');
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return sendJsonError(res, 400, 'An audio file is required');
  }
  const audioMimeType = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!ALLOWED_AUDIO_TYPES.has(audioMimeType)) {
    return sendJsonError(res, 415, 'Unsupported audio format');
  }

  const form = new FormData();
  form.append('file', new Blob([req.body], { type: audioMimeType }), `caption-${Date.now()}.${audioMimeType.split('/')[1] || 'webm'}`);
  form.append('model', GROQ_TRANSCRIPTION_MODEL);
  form.append('temperature', '0');
  form.append('response_format', 'verbose_json');
  const whisperLanguage = getWhisperLanguage(req.get('x-caption-language'));
  if (whisperLanguage) form.append('language', whisperLanguage);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const providerResponse = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
      body: form,
      signal: controller.signal
    });
    const payload = await providerResponse.json().catch(() => null);
    if (!providerResponse.ok) {
      console.error('Groq transcription provider rejected request:', providerResponse.status);
      return sendJsonError(res, 502, 'Caption transcription provider unavailable');
    }

    const text = typeof payload?.text === 'string' ? payload.text.trim().slice(0, MAX_CAPTION_LENGTH) : '';
    if (!text) return res.json({ text: '', provider: 'groq' });

    broadcast(room, {
      type: 'caption',
      fromClientId: connection.clientId,
      fromUsername: connection.user.name,
      text,
      isFinal: true,
      language: CAPTION_LANGUAGES[req.get('x-caption-language')] ? req.get('x-caption-language') : 'en-US',
      provider: 'groq',
      chunkNumber: Number(req.get('x-caption-chunk')) || 0
    }, connection.clientId);

    return res.json({ text, provider: 'groq' });
  } catch (error) {
    console.error('Groq transcription request failed:', error.name === 'AbortError' ? 'timeout' : error.message);
    return sendJsonError(res, 502, 'Caption transcription provider unavailable');
  } finally {
    clearTimeout(timeout);
  }
  }
);

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') return sendJsonError(res, 413, 'Audio chunk is too large');
  if (error?.message === 'Origin is not allowed') return sendJsonError(res, 403, 'Origin is not allowed');
  console.error('HTTP request failed:', error?.message || error);
  return sendJsonError(res, 500, 'Request could not be processed');
});

function safeSend(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    const serialized = JSON.stringify(message);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_OUTBOUND_BUFFERED_BYTES) return false;
    if (ws.bufferedAmount > MAX_OUTBOUND_BUFFERED_BYTES) {
      ws.close(1009, 'Connection is too slow');
      return false;
    }
    ws.send(serialized);
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

function participantState(participant, room = null) {
  return {
    clientId: participant.clientId,
    username: participant.user.name,
    picture: participant.user.picture || null,
    isMuted: Boolean(participant.isMuted),
    isAdminMuted: Boolean(participant.isAdminMuted),
    handRaised: Boolean(participant.handRaised),
    isCameraOff: Boolean(participant.isCameraOff),
    isHost: Boolean(room && room.adminClientId === participant.clientId),
    connected: Boolean(participant.ws)
  };
}

function getRoomState(room, excludedClientId = null) {
  return Array.from(room.participants.values())
    .filter(participant => participant.clientId !== excludedClientId)
    .map(participant => participantState(participant, room));
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

function countActiveJoinGrants(room) {
  let count = 0;
  for (const request of pendingJoinRequests.values()) {
    if (request.roomId === room.roomId && request.status === 'granted') count += 1;
  }
  return count;
}

function sendPendingJoinRequests(room, targetState = null) {
  const host = targetState || connections.get(room?.adminClientId);
  if (!room || !host || !host.ws || host.clientId !== room.adminClientId) return;
  safeSend(host.ws, {
    type: 'pending_join_requests',
    roomId: room.roomId,
    requests: Array.from(room.pendingJoinRequests.values()).map(request => ({
      requestId: request.requestId,
      roomId: request.roomId,
      username: request.username,
      picture: request.picture,
      expiresAt: request.expiresAt
    }))
  });
}

function clearJoinRequestTimer(request) {
  if (request?.expiryTimer) {
    clearTimeout(request.expiryTimer);
    request.expiryTimer = null;
  }
}

function notifyJoinRequestRemoved(request, reason) {
  const room = rooms.get(request.roomId);
  const host = room ? connections.get(room.adminClientId) : null;
  if (host && host.clientId === room.adminClientId) {
    safeSend(host.ws, {
      type: 'join_request_removed',
      requestId: request.requestId,
      roomId: request.roomId,
      reason
    });
  }
}

function removeJoinRequestFromQueue(request, reason) {
  const room = rooms.get(request.roomId);
  if (room?.pendingJoinRequests?.delete(request.requestId)) {
    notifyJoinRequestRemoved(request, reason);
  }
}

function destroyJoinRequest(request, reason, requesterMessageType = null) {
  if (!request || !pendingJoinRequests.has(request.requestId)) return;
  clearJoinRequestTimer(request);
  removeJoinRequestFromQueue(request, reason);
  pendingJoinRequests.delete(request.requestId);

  const requester = connections.get(request.requesterClientId);
  if (requester?.pendingJoinRequestId === request.requestId) requester.pendingJoinRequestId = null;
  if (requesterMessageType && requester) {
    safeSend(requester.ws, {
      type: requesterMessageType,
      requestId: request.requestId,
      roomId: request.roomId,
      reason
    });
  }
}

function expireJoinRequest(request) {
  if (!request || !pendingJoinRequests.has(request.requestId)) return;
  destroyJoinRequest(request, request.status === 'granted' ? 'ADMISSION_TIMEOUT' : 'REQUEST_TIMEOUT', 'join_request_expired');
}

function scheduleJoinRequestExpiry(request, delay) {
  clearJoinRequestTimer(request);
  request.expiryTimer = setTimeout(() => expireJoinRequest(request), delay);
  request.expiryTimer.unref?.();
}

function cancelJoinRequestForState(state, reason = 'REQUEST_CANCELLED') {
  const request = state?.pendingJoinRequestId ? pendingJoinRequests.get(state.pendingJoinRequestId) : null;
  if (!request || request.requesterClientId !== state.clientId) {
    if (state) state.pendingJoinRequestId = null;
    return;
  }
  destroyJoinRequest(request, reason, state.ws.readyState === WebSocket.OPEN ? 'join_request_cancelled' : null);
}

function validateAdmissionToken(state, room, token) {
  const request = token
    ? Array.from(pendingJoinRequests.values()).find(candidate => candidate.admissionToken === token)
    : null;
  if (
    !request ||
    request.status !== 'granted' ||
    request.roomId !== room.roomId ||
    request.requesterClientId !== state.clientId ||
    request.requesterUserId !== state.user.sub ||
    request.grantExpiresAt <= Date.now()
  ) return null;
  return request;
}

function admitJoinRequest(state, requestId, providedAdminToken) {
  const room = getCurrentRoom(state);
  if (!room || room.adminClientId !== state.clientId || providedAdminToken !== room.adminToken) {
    safeSend(state.ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Only the host can admit participants.' });
    return;
  }
  const request = room.pendingJoinRequests.get(requestId);
  if (!request || request.status !== 'pending') {
    safeSend(state.ws, { type: 'error', code: 'REQUEST_NOT_FOUND', message: 'That join request is no longer available.' });
    return;
  }
  if (room.participants.size + countActiveJoinGrants(room) >= MAX_PARTICIPANTS) {
    return safeSend(state.ws, { type: 'error', code: 'ROOM_FULL', message: 'There is no available participant slot.' });
  }

  request.status = 'granted';
  request.admissionToken = randomToken();
  request.grantExpiresAt = Date.now() + JOIN_GRANT_TTL_MS;
  removeJoinRequestFromQueue(request, 'ADMITTED');
  scheduleJoinRequestExpiry(request, JOIN_GRANT_TTL_MS);

  const requester = connections.get(request.requesterClientId);
  if (!requester || requester.user?.sub !== request.requesterUserId || requester.roomId || requester.ws.readyState !== WebSocket.OPEN) {
    return destroyJoinRequest(request, 'REQUESTER_UNAVAILABLE');
  }
  requester.pendingJoinRequestId = request.requestId;
  safeSend(requester.ws, {
    type: 'join_admitted',
    requestId: request.requestId,
    roomId: request.roomId,
    admissionToken: request.admissionToken,
    expiresAt: request.grantExpiresAt
  });
}

function rejectJoinRequest(state, requestId, providedAdminToken) {
  const room = getCurrentRoom(state);
  if (!room || room.adminClientId !== state.clientId || providedAdminToken !== room.adminToken) {
    safeSend(state.ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Only the host can reject participants.' });
    return;
  }
  const request = room.pendingJoinRequests.get(requestId);
  if (!request || request.status !== 'pending') {
    safeSend(state.ws, { type: 'error', code: 'REQUEST_NOT_FOUND', message: 'That join request is no longer available.' });
    return;
  }
  destroyJoinRequest(request, 'HOST_REJECTED', 'join_rejected');
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

function isSafeClientId(value) {
  return typeof value === 'string' && /^[a-f0-9-]{36}$/i.test(value);
}

function isValidSdpDescription(value, expectedType) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.type === expectedType &&
    typeof value.sdp === 'string' &&
    value.sdp.length > 0 &&
    value.sdp.length <= MAX_SIGNALING_SDP_LENGTH
  );
}

function isValidIceCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (typeof value.candidate !== 'string' || value.candidate.length > MAX_SIGNALING_CANDIDATE_LENGTH) return false;
  if (value.sdpMid !== null && value.sdpMid !== undefined && (typeof value.sdpMid !== 'string' || value.sdpMid.length > 100)) return false;
  if (value.sdpMLineIndex !== null && value.sdpMLineIndex !== undefined && (!Number.isInteger(value.sdpMLineIndex) || value.sdpMLineIndex < 0 || value.sdpMLineIndex > 100)) return false;
  if (value.usernameFragment !== null && value.usernameFragment !== undefined && (typeof value.usernameFragment !== 'string' || value.usernameFragment.length > 256)) return false;
  return true;
}

function recordInboundFrame(state, byteLength) {
  const now = Date.now();
  if (now - state.bytesWindowStartedAt >= 10_000) {
    state.bytesWindowStartedAt = now;
    state.bytesReceived = 0;
  }
  state.bytesReceived += byteLength;
  if (state.bytesReceived > MAX_INBOUND_BYTES_PER_WINDOW) {
    state.ws.close(1008, 'Message rate exceeded');
    return false;
  }
  return true;
}

function recordInvalidMessage(state) {
  state.invalidMessages += 1;
  if (state.invalidMessages >= MAX_INVALID_MESSAGES) {
    state.ws.close(1008, 'Too many invalid messages');
    return false;
  }
  return true;
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
    picture: typeof payload.picture === 'string' && /^https:\/\//i.test(payload.picture)
      ? payload.picture.slice(0, 2_000)
      : null
  };
}

function createSession(user, clientId) {
  const token = randomToken(32);
  const issuedAt = Date.now();
  sessions.set(token, { user, clientId, issuedAt, expiresAt: issuedAt + SESSION_TTL_MS });
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
  sendPendingJoinRequests(room, replacement);
}

function removeParticipant(room, participant, notify = true) {
  if (!room || !participant || !room.participants.has(participant.clientId)) return;
  if (participant.disconnectTimer) clearTimeout(participant.disconnectTimer);
  room.participants.delete(participant.clientId);
  if (notify) broadcast(room, { type: 'peer_left', clientId: participant.clientId });

  if (room.adminClientId === participant.clientId) {
    promoteReplacementAdmin(room);
  }

  if (room.participants.size === 0) {
    for (const request of Array.from(pendingJoinRequests.values())) {
      if (request.roomId === room.roomId) destroyJoinRequest(request, 'MEETING_ENDED', 'join_request_expired');
    }
    rooms.delete(room.roomId);
  }
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
  for (const request of Array.from(pendingJoinRequests.values())) {
    if (request.roomId === room.roomId) destroyJoinRequest(request, 'MEETING_ENDED', 'join_request_expired');
  }
  broadcast(room, { type: 'meeting_ended', reason });
  for (const participant of room.participants.values()) {
    if (participant.disconnectTimer) clearTimeout(participant.disconnectTimer);
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
        if (!registerAuthenticatedConnection(state, user.sub)) {
          safeSend(state.ws, { type: 'error', code: 'SESSION_LIMIT', message: 'Too many active sessions for this account.' });
          return state.ws.close(1008, 'Session limit reached');
        }
        state.user = user;
        state.authenticated = true;
        state.sessionToken = createSession(user, state.clientId);
        safeSend(state.ws, { type: 'authenticated', sessionToken: state.sessionToken, user });
        sendYourInfo(state, getCurrentRoom(state));
      } catch (error) {
        state.authFailures += 1;
        console.error('Google authentication failed:', error.message);
        safeSend(state.ws, { type: 'error', code: 'AUTH_FAILED', message: 'Google sign-in could not be verified.' });
        if (state.authFailures >= 3) state.ws.close(1008, 'Authentication failed');
      }
      return;
    }

    case 'ping':
      return safeSend(state.ws, { type: 'pong', timestamp: Date.now() });

    case 'logout':
      cancelJoinRequestForState(state);
      {
        const room = getCurrentRoom(state);
        if (room) removeParticipant(room, room.participants.get(state.clientId));
        state.roomId = null;
      }
      if (state.sessionToken) sessions.delete(state.sessionToken);
      state.sessionToken = null;
      unregisterAuthenticatedConnection(state);
      state.authenticated = false;
      state.user = null;
      state.ws.close(1000, 'Signed out');
      return;

    case 'prepare_room': {
      if (!requireAuthenticated(state) || state.roomId) return;
      if (data.action === 'create') {
        if (rooms.size >= MAX_ACTIVE_ROOMS) return safeSend(state.ws, { type: 'error', code: 'SERVICE_BUSY', message: 'The meeting service is at capacity.' });
        if (countRoomsCreatedBy(state.user.sub) >= MAX_ROOMS_PER_USER) {
          return safeSend(state.ws, { type: 'error', code: 'ROOM_QUOTA', message: 'You have reached the active meeting limit.' });
        }
        return safeSend(state.ws, { type: 'room_prepared', action: 'create' });
      }

      if (data.action === 'join') {
        const roomId = validateRoomId(data.roomId);
        const room = roomId ? rooms.get(roomId) : null;
        if (!room) return safeSend(state.ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Meeting not found or already ended.' });
        if (room.participants.size + countActiveJoinGrants(room) >= MAX_PARTICIPANTS) return safeSend(state.ws, { type: 'error', code: 'ROOM_FULL', message: 'This meeting is full.' });
        return safeSend(state.ws, { type: 'room_prepared', action: 'join', roomId, admissionRequired: true });
      }

      return safeSend(state.ws, { type: 'error', code: 'INVALID_PREPARATION', message: 'Invalid meeting action.' });
    }

    case 'create_room': {
      if (!requireAuthenticated(state) || state.roomId) return;
      if (rooms.size >= MAX_ACTIVE_ROOMS) return safeSend(state.ws, { type: 'error', code: 'SERVICE_BUSY', message: 'The meeting service is at capacity.' });
      if (countRoomsCreatedBy(state.user.sub) >= MAX_ROOMS_PER_USER) {
        return safeSend(state.ws, { type: 'error', code: 'ROOM_QUOTA', message: 'You have reached the active meeting limit.' });
      }

      const roomId = generateRoomId();
      const participant = createParticipant(state, roomId);
      const room = {
        roomId,
        createdByUserId: state.user.sub,
        adminClientId: state.clientId,
        adminUserId: state.user.sub,
        adminToken: randomToken(),
        participants: new Map([[state.clientId, participant]]),
        pendingJoinRequests: new Map(),
        createdAt: Date.now(),
        lastActivityAt: Date.now()
      };
      rooms.set(roomId, room);
      state.roomId = roomId;

      safeSend(state.ws, { type: 'room_created', roomId, adminClientId: room.adminClientId, resumeToken: participant.resumeToken });
      sendYourInfo(state, room);
      return;
    }

    case 'request_join': {
      if (!requireAuthenticated(state) || state.roomId) return;
      const roomId = validateRoomId(data.roomId);
      const room = roomId ? rooms.get(roomId) : null;
      if (!room) return safeSend(state.ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Meeting not found or already ended.' });
      if (state.pendingJoinRequestId) {
        const existing = pendingJoinRequests.get(state.pendingJoinRequestId);
        if (existing && existing.roomId === roomId) {
          return safeSend(state.ws, {
            type: 'join_request_pending',
            requestId: existing.requestId,
            roomId: existing.roomId,
            expiresAt: existing.expiresAt
          });
        }
        cancelJoinRequestForState(state);
      }
      if (room.participants.size + countActiveJoinGrants(room) >= MAX_PARTICIPANTS) {
        return safeSend(state.ws, { type: 'error', code: 'ROOM_FULL', message: 'This meeting is full.' });
      }
      if (room.pendingJoinRequests.size >= MAX_PENDING_JOIN_REQUESTS) {
        return safeSend(state.ws, { type: 'ADMISSION_BUSY', message: 'The host admission queue is full. Please try again shortly.' });
      }

      const now = Date.now();
      const request = {
        requestId: randomToken(18),
        roomId,
        requesterClientId: state.clientId,
        requesterUserId: state.user.sub,
        username: state.user.name,
        picture: state.user.picture || null,
        status: 'pending',
        createdAt: now,
        expiresAt: now + JOIN_REQUEST_TTL_MS,
        admissionToken: null,
        grantExpiresAt: null,
        expiryTimer: null
      };
      pendingJoinRequests.set(request.requestId, request);
      room.pendingJoinRequests.set(request.requestId, request);
      state.pendingJoinRequestId = request.requestId;
      scheduleJoinRequestExpiry(request, JOIN_REQUEST_TTL_MS);

      safeSend(state.ws, {
        type: 'join_request_pending',
        requestId: request.requestId,
        roomId,
        expiresAt: request.expiresAt
      });
      const host = connections.get(room.adminClientId);
      if (host) safeSend(host.ws, {
        type: 'join_request_received',
        requestId: request.requestId,
        roomId,
        username: request.username,
        picture: request.picture,
        expiresAt: request.expiresAt
      });
      return;
    }

    case 'admit_join_request':
      if (!requireAuthenticated(state)) return;
      admitJoinRequest(state, stringValue(data.requestId, 200), stringValue(data.adminToken, 200));
      return;

    case 'reject_join_request':
      if (!requireAuthenticated(state)) return;
      rejectJoinRequest(state, stringValue(data.requestId, 200), stringValue(data.adminToken, 200));
      return;

    case 'cancel_join_request':
      if (!requireAuthenticated(state)) return;
      if (!state.pendingJoinRequestId || state.pendingJoinRequestId !== stringValue(data.requestId, 200)) {
        return safeSend(state.ws, { type: 'error', code: 'REQUEST_NOT_FOUND', message: 'That join request is no longer available.' });
      }
      cancelJoinRequestForState(state);
      return;

    case 'join_room': {
      if (!requireAuthenticated(state) || state.roomId) return;
      const roomId = validateRoomId(data.roomId);
      if (!roomId) return safeSend(state.ws, { type: 'error', code: 'INVALID_ROOM', message: 'Enter a valid six-character meeting code.' });
      const room = rooms.get(roomId);
      if (!room) return safeSend(state.ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Meeting not found or already ended.' });
      const admissionToken = stringValue(data.admissionToken, 200);
      const request = validateAdmissionToken(state, room, admissionToken);
      if (!request) return safeSend(state.ws, { type: 'error', code: 'ADMISSION_REQUIRED', message: 'Host approval is required to join this meeting.' });
      if (room.participants.size >= MAX_PARTICIPANTS) return safeSend(state.ws, { type: 'error', code: 'ROOM_FULL', message: 'This meeting is full.' });
      destroyJoinRequest(request, 'ADMITTED', null);

      const participant = createParticipant(state, roomId);
      room.participants.set(state.clientId, participant);
      state.roomId = roomId;
      touchRoom(room);

      broadcast(room, { type: 'peer_joined', ...participantState(participant, room) }, state.clientId);
      safeSend(state.ws, { type: 'room_joined', roomId, adminClientId: room.adminClientId, resumeToken: participant.resumeToken });
      safeSend(state.ws, { type: 'room_state', adminClientId: room.adminClientId, participants: getRoomState(room, state.clientId) });
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

      const session = sessions.get(state.sessionToken);
      if (!session) {
        return safeSend(state.ws, {
          type: 'error',
          code: 'RESUME_FAILED',
          message: 'Your meeting session could not be resumed.'
        });
      }
      if (participant.ws && participant.ws !== state.ws) participant.ws.close(1000, 'Session resumed elsewhere');
      if (participant.disconnectTimer) clearTimeout(participant.disconnectTimer);
      connections.delete(state.clientId);
      state.clientId = participant.clientId;
      connections.set(state.clientId, state);
      session.clientId = state.clientId;
      participant.ws = state.ws;
      participant.lastSeenAt = Date.now();
      state.roomId = room.roomId;
      touchRoom(room);

      safeSend(state.ws, { type: 'room_resumed', roomId: room.roomId, adminClientId: room.adminClientId, resumeToken: participant.resumeToken });
      safeSend(state.ws, { type: 'room_state', adminClientId: room.adminClientId, participants: getRoomState(room, state.clientId) });
      sendYourInfo(state, room);
      if (room.adminClientId === state.clientId) sendPendingJoinRequests(room, state);
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
      if (!room || !targetId || !isSafeClientId(targetId)) return;
      const target = room.participants.get(targetId);
      if (!target || !target.ws) return;

      if (data.type === 'offer' && !isValidSdpDescription(data.sdp, 'offer')) return;
      if (data.type === 'answer' && !isValidSdpDescription(data.sdp, 'answer')) return;
      if (data.type === 'ice_candidate' && !isValidIceCandidate(data.candidate)) return;

      const payload = {
        type: data.type,
        from: state.clientId,
        fromId: state.clientId,
        fromUsername: state.user.name
      };
      if (data.type === 'ice_candidate') {
        payload.candidate = {
          candidate: data.candidate.candidate,
          sdpMid: data.candidate.sdpMid ?? null,
          sdpMLineIndex: data.candidate.sdpMLineIndex ?? null,
          usernameFragment: data.candidate.usernameFragment ?? null
        };
      } else {
        payload.sdp = { type: data.sdp.type, sdp: data.sdp.sdp };
      }
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

    case 'recording_state': {
      const room = requireRoom(state);
      if (!room || typeof data.active !== 'boolean') return;
      broadcast(room, {
        type: 'recording_state',
        clientId: state.clientId,
        username: state.user.name,
        active: data.active
      });
      return;
    }

    case 'screen_share_state': {
      const room = requireRoom(state);
      if (!room || typeof data.active !== 'boolean') return;
      broadcast(room, {
        type: 'screen_share_state',
        clientId: state.clientId,
        username: state.user.name,
        active: data.active
      }, state.clientId);
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

      if (data.action === 'mute_toggle' && isSafeClientId(data.targetClientId)) {
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
      } else if (data.action === 'transfer_admin' && isSafeClientId(data.targetClientId)) {
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
    ipAddress: getClientAddress(request),
    user: null,
    authenticated: false,
    authenticatedUserId: null,
    sessionToken: null,
    roomId: null,
    pendingJoinRequestId: null,
    messageTimes: [],
    authTimer: null,
    invalidMessages: 0,
    bytesWindowStartedAt: Date.now(),
    bytesReceived: 0,
    authFailures: 0
  };
  connections.set(state.clientId, state);
  incrementCount(activeConnectionsByIp, state.ipAddress);
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
    if (!recordInboundFrame(state, Buffer.byteLength(raw))) return;
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch (error) {
      if (recordInvalidMessage(state)) safeSend(ws, { type: 'error', code: 'INVALID_JSON', message: 'Message must be valid JSON.' });
      return;
    }
    if (validateMessage(data)) {
      if (recordInvalidMessage(state)) safeSend(ws, { type: 'error', code: 'INVALID_MESSAGE', message: 'Invalid message format.' });
      return;
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
    cancelJoinRequestForState(state, 'REQUESTER_DISCONNECTED');
    const isCurrentConnection = connections.get(state.clientId) === state;
    if (isCurrentConnection) connections.delete(state.clientId);
    decrementCount(activeConnectionsByIp, state.ipAddress);
    unregisterAuthenticatedConnection(state);
    if (state.sessionToken) sessions.delete(state.sessionToken);
    if (isCurrentConnection) markDisconnected(state);
  });

  ws.on('error', error => {
    console.error(`WebSocket error for ${state.clientId}:`, error.message);
  });
});

server.on('upgrade', (request, socket, head) => {
  const pathname = new URL(request.url || '/', 'http://localhost').pathname;
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secureUpgrade = !REQUIRE_TLS || forwardedProtocol === 'https' || request.socket.encrypted;
  if (!['/', '/ws'].includes(pathname) || !isAllowedWebSocketOrigin(request.headers.origin) || !secureUpgrade || !canOpenConnection(request)) {
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
  for (const request of pendingJoinRequests.values()) {
    if (request.status === 'pending' && request.expiresAt <= now) expireJoinRequest(request);
    if (request.status === 'granted' && request.grantExpiresAt <= now) expireJoinRequest(request);
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
