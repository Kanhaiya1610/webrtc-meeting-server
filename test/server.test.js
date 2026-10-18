const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { OAuth2Client } = require('google-auth-library');

process.env.PORT = '0';
process.env.ALLOWED_ORIGINS = 'http://localhost:5500';
process.env.GOOGLE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
process.env.GROQ_API_KEY = 'test-groq-key';
process.env.JOIN_GRANT_TTL_MS = '120000';
process.env.ICE_SERVERS_JSON = JSON.stringify([{ urls: 'turn:test.example.com', username: 'test-user', credential: 'test-credential' }]);

const originalVerifyIdToken = OAuth2Client.prototype.verifyIdToken;
OAuth2Client.prototype.verifyIdToken = async ({ idToken }) => ({
  getPayload: () => ({
    iss: 'https://accounts.google.com',
    email_verified: true,
    sub: `test-user-${idToken}`,
    email: `${idToken}@example.test`,
    name: `Test ${idToken}`
  })
});

const { server, startServer } = require('../server');
const activeSockets = new Set();

function waitForListening() {
  return new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
    startServer();
  });
}

function waitForWebSocketMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('error', onError);
      ws.off('message', onMessage);
      reject(new Error('WebSocket test timed out'));
    }, 2_000);
    const onError = error => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      reject(error);
    };
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('error', onError);
      ws.off('message', onMessage);
      resolve(message);
    };
    ws.on('error', onError);
    ws.on('message', onMessage);
  });
}

function waitForNoCaption(ws, duration = 150) {
  return new Promise(resolve => {
    const onMessage = raw => {
      const message = JSON.parse(raw.toString());
      if (message.type !== 'caption') return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(false);
    };
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      resolve(true);
    }, duration);
    ws.on('message', onMessage);
  });
}

async function openAuthenticatedSocket(credential) {
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: 'http://localhost:5500' }
  });
  activeSockets.add(ws);
  ws.once('close', () => activeSockets.delete(ws));

  const infoPromise = waitForWebSocketMessage(ws, message => message.type === 'your_info');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await infoPromise;

  const authenticatedPromise = waitForWebSocketMessage(ws, message => message.type === 'authenticated');
  ws.send(JSON.stringify({ type: 'authenticate', credential }));
  const authenticated = await authenticatedPromise;
  return { ws, sessionToken: authenticated.sessionToken };
}

async function closeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  await new Promise(resolve => {
    ws.once('close', resolve);
    ws.close();
  });
}

test.before(async () => {
  await waitForListening();
});

test.after(async () => {
  await Promise.all(Array.from(activeSockets, closeSocket));
  await new Promise(resolve => server.close(resolve));
  OAuth2Client.prototype.verifyIdToken = originalVerifyIdToken;
});

test('health endpoint does not require authentication', async () => {
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('unauthenticated WebSocket clients cannot create rooms', async () => {
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: 'http://localhost:5500' }
  });
  const infoPromise = waitForWebSocketMessage(ws, message => message.type === 'your_info');
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const info = await infoPromise;
  assert.ok(info.clientId);

  const errorPromise = waitForWebSocketMessage(ws, message => message.type === 'error');
  ws.send(JSON.stringify({ type: 'create_room' }));
  const error = await errorPromise;
  assert.equal(error.code, 'AUTH_REQUIRED');
  ws.close();
});

test('translation endpoint requires a server-issued session', async () => {
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'hello', sourceLang: 'en-US', targetLang: 'fr-FR' })
  });
  assert.equal(response.status, 401);
});

test('Groq caption transcription requires a server-issued session', async () => {
  const port = server.address().port;
  const form = new FormData();
  form.append('audio', new Blob(['not-audio'], { type: 'audio/webm' }), 'test.webm');
  const response = await fetch(`http://127.0.0.1:${port}/captions/transcribe`, {
    method: 'POST',
    body: form
  });
  assert.equal(response.status, 401);
});

test('caption transcription preflight allows the client upload headers', async () => {
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/captions/transcribe`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5500',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type,x-caption-language,x-caption-chunk,x-caption-session'
    }
  });
  assert.equal(response.status, 204);
  const allowedHeaders = response.headers.get('access-control-allow-headers') || '';
  for (const header of ['authorization', 'content-type', 'x-caption-language', 'x-caption-chunk', 'x-caption-session']) {
    assert.match(allowedHeaders.toLowerCase(), new RegExp(`\\b${header}\\b`));
  }
});

test('authenticated Groq transcription accepts raw audio and broadcasts captions', async () => {
  const host = await openAuthenticatedSocket('caption-host');
  const roomPromise = waitForWebSocketMessage(host.ws, message => message.type === 'room_created');
  const hostInfoPromise = waitForWebSocketMessage(host.ws, message => message.type === 'your_info' && message.isAdmin === true && message.adminToken);
  host.ws.send(JSON.stringify({ type: 'create_room' }));
  const room = await roomPromise;
  const hostInfo = await hostInfoPromise;

  const guest = await openAuthenticatedSocket('caption-guest');
  const preparedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'room_prepared');
  guest.ws.send(JSON.stringify({ type: 'prepare_room', action: 'join', roomId: room.roomId }));
  await preparedPromise;
  const pendingPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'join_request_pending');
  const requestPromise = waitForWebSocketMessage(host.ws, message => message.type === 'join_request_received');
  guest.ws.send(JSON.stringify({ type: 'request_join', roomId: room.roomId }));
  const request = await requestPromise;
  await pendingPromise;
  const admittedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'join_admitted');
  host.ws.send(JSON.stringify({ type: 'admit_join_request', requestId: request.requestId, adminToken: hostInfo.adminToken }));
  const admitted = await admittedPromise;
  const guestJoinPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'room_joined');
  guest.ws.send(JSON.stringify({ type: 'join_room', roomId: room.roomId, admissionToken: admitted.admissionToken }));
  await guestJoinPromise;

  const originalFetch = global.fetch;
  let providerRequest;
  global.fetch = async (url, options) => {
    if (url === 'https://api.groq.com/openai/v1/audio/transcriptions') {
      providerRequest = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ text: 'hello from Groq' })
      };
    }
    return originalFetch(url, options);
  };

  try {
    const captionPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'caption');
    const senderCaptionPromise = waitForNoCaption(host.ws);
    const response = await originalFetch(`http://127.0.0.1:${server.address().port}/captions/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${host.sessionToken}`,
        'Content-Type': 'audio/webm;codecs=opus',
        'X-Caption-Language': 'hi-IN',
        'X-Caption-Chunk': '7'
      },
      body: Buffer.from('fake-audio')
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: 'hello from Groq', provider: 'groq' });

    const caption = await captionPromise;
    assert.equal(await senderCaptionPromise, true);
    assert.equal(caption.text, 'hello from Groq');
    assert.equal(caption.provider, 'groq');
    assert.equal(caption.language, 'hi-IN');
    assert.equal(caption.chunkNumber, 7);
    assert.equal(providerRequest.options.headers.Authorization, 'Bearer test-groq-key');
    assert.equal(providerRequest.options.body.get('model'), 'whisper-large-v3-turbo');
    assert.equal(providerRequest.options.body.get('language'), 'hi');
    assert.equal(providerRequest.options.body.get('response_format'), 'verbose_json');
  } finally {
    global.fetch = originalFetch;
    await closeSocket(host.ws);
    await closeSocket(guest.ws);
  }
});

test('resumed sessions retain HTTP authorization after reconnect', async () => {
  const first = await openAuthenticatedSocket('resume-user');
  const roomPromise = waitForWebSocketMessage(first.ws, message => message.type === 'room_created');
  first.ws.send(JSON.stringify({ type: 'create_room' }));
  const room = await roomPromise;
  await closeSocket(first.ws);

  const resumed = await openAuthenticatedSocket('resume-user');
  const resumedPromise = waitForWebSocketMessage(resumed.ws, message => message.type === 'room_resumed');
  resumed.ws.send(JSON.stringify({ type: 'resume_room', roomId: room.roomId, resumeToken: room.resumeToken }));
  await resumedPromise;

  const port = server.address().port;
  const iceResponse = await fetch(`http://127.0.0.1:${port}/ice`, {
    headers: { Authorization: `Bearer ${resumed.sessionToken}` }
  });
  assert.equal(iceResponse.status, 200);
  assert.deepEqual((await iceResponse.json()).iceServers, [{ urls: 'turn:test.example.com', username: 'test-user', credential: 'test-credential' }]);

  const translationResponse = await fetch(`http://127.0.0.1:${port}/translate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resumed.sessionToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text: 'hello', sourceLang: 'en-US', targetLang: 'en-US' })
  });
  assert.equal(translationResponse.status, 200);
  assert.deepEqual(await translationResponse.json(), { translatedText: 'hello' });

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (url === 'https://api.groq.com/openai/v1/audio/transcriptions') {
      return { ok: true, status: 200, json: async () => ({ text: 'resumed caption' }) };
    }
    return originalFetch(url, options);
  };
  try {
    const transcriptionResponse = await originalFetch(`http://127.0.0.1:${port}/captions/transcribe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resumed.sessionToken}`,
        'Content-Type': 'audio/webm'
      },
      body: Buffer.from('fake-audio')
    });
    assert.equal(transcriptionResponse.status, 200);
    assert.deepEqual(await transcriptionResponse.json(), { text: 'resumed caption', provider: 'groq' });
  } finally {
    global.fetch = originalFetch;
    await closeSocket(resumed.ws);
  }
});

test('unauthenticated ICE requests do not receive TURN credentials', async () => {
  const port = server.address().port;
  const response = await fetch(`http://127.0.0.1:${port}/ice`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(Array.isArray(payload.iceServers));
  assert.equal(payload.iceServers.some(server => server.credential || server.username), false);
});

test('repeated malformed WebSocket messages are terminated', async () => {
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: 'http://localhost:5500' }
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const closePromise = new Promise(resolve => ws.once('close', (code) => resolve(code)));
  for (let index = 0; index < 5; index += 1) ws.send('{}');
  assert.equal(await closePromise, 1008);
});

test('WebSocket upgrades reject an untrusted browser origin', async () => {
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Origin: 'https://attacker.example' }
  });
  const result = await new Promise(resolve => {
    ws.once('open', () => resolve('accepted'));
    ws.once('unexpected-response', () => resolve('rejected'));
    ws.once('error', () => resolve('rejected'));
  });
  assert.equal(result, 'rejected');
});


test('host admission is required before joining a room', async () => {
  const host = await openAuthenticatedSocket('admission-host');
  const roomPromise = waitForWebSocketMessage(host.ws, message => message.type === 'room_created');
  const hostInfoPromise = waitForWebSocketMessage(host.ws, message => message.type === 'your_info' && message.isAdmin === true && message.adminToken);
  host.ws.send(JSON.stringify({ type: 'create_room' }));
  const room = await roomPromise;
  const hostInfo = await hostInfoPromise;

  const guest = await openAuthenticatedSocket('admission-guest');
  const preparedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'room_prepared');
  guest.ws.send(JSON.stringify({ type: 'prepare_room', action: 'join', roomId: room.roomId }));
  const prepared = await preparedPromise;
  assert.equal(prepared.admissionRequired, true);

  const directJoinError = waitForWebSocketMessage(guest.ws, message => message.type === 'error' && message.code === 'ADMISSION_REQUIRED');
  guest.ws.send(JSON.stringify({ type: 'join_room', roomId: room.roomId }));
  await directJoinError;

  const pendingPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'join_request_pending');
  const hostRequestPromise = waitForWebSocketMessage(host.ws, message => message.type === 'join_request_received');
  guest.ws.send(JSON.stringify({ type: 'request_join', roomId: room.roomId }));
  const [pending, request] = await Promise.all([pendingPromise, hostRequestPromise]);
  assert.equal(pending.roomId, room.roomId);
  assert.equal(request.roomId, room.roomId);
  assert.equal(request.username, 'Test admission-guest');
  assert.equal('email' in request, false);
  assert.equal('admissionToken' in request, false);

  const unauthorizedPromise = waitForWebSocketMessage(host.ws, message => message.type === 'error' && message.code === 'UNAUTHORIZED');
  host.ws.send(JSON.stringify({ type: 'admit_join_request', requestId: request.requestId, adminToken: 'wrong-token' }));
  await unauthorizedPromise;

  const removedPromise = waitForWebSocketMessage(host.ws, message => message.type === 'join_request_removed' && message.requestId === request.requestId);
  const admittedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'join_admitted');
  host.ws.send(JSON.stringify({ type: 'admit_join_request', requestId: request.requestId, adminToken: hostInfo.adminToken }));
  const admitted = await admittedPromise;
  await removedPromise;
  assert.equal(admitted.roomId, room.roomId);
  assert.ok(admitted.admissionToken);

  const joinedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'room_joined');
  guest.ws.send(JSON.stringify({ type: 'join_room', roomId: room.roomId, admissionToken: admitted.admissionToken }));
  await joinedPromise;
  await closeSocket(host.ws);
  await closeSocket(guest.ws);
});


test('host can generate one Groq meeting summary and publish it to participants', async () => {
  const host = await openAuthenticatedSocket('summary-host');
  const roomPromise = waitForWebSocketMessage(host.ws, message => message.type === 'room_created');
  const hostInfoPromise = waitForWebSocketMessage(host.ws, message => message.type === 'your_info' && message.isAdmin && message.adminToken);
  host.ws.send(JSON.stringify({ type: 'create_room' }));
  const room = await roomPromise;
  const hostInfo = await hostInfoPromise;

  const guest = await openAuthenticatedSocket('summary-guest');
  const preparedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'room_prepared');
  guest.ws.send(JSON.stringify({ type: 'prepare_room', action: 'join', roomId: room.roomId }));
  await preparedPromise;
  const pendingPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'join_request_pending');
  const requestPromise = waitForWebSocketMessage(host.ws, message => message.type === 'join_request_received');
  guest.ws.send(JSON.stringify({ type: 'request_join', roomId: room.roomId }));
  const request = await requestPromise;
  await pendingPromise;
  const admittedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'join_admitted');
  host.ws.send(JSON.stringify({ type: 'admit_join_request', requestId: request.requestId, adminToken: hostInfo.adminToken }));
  const admitted = await admittedPromise;
  const joinedPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'room_joined');
  guest.ws.send(JSON.stringify({ type: 'join_room', roomId: room.roomId, admissionToken: admitted.admissionToken }));
  await joinedPromise;

  const originalFetch = global.fetch;
  let providerRequest;
  global.fetch = async (url, options) => {
    if (url === 'https://api.groq.com/openai/v1/chat/completions') {
      providerRequest = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Summary\n\nDecisions\n- Test decision' } }] })
      };
    }
    return originalFetch(url, options);
  };

  try {
    const guestCaptionPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'caption');
    host.ws.send(JSON.stringify({
      type: 'caption',
      captionId: 'summary-caption-1',
      text: 'We decided to ship the update on Friday.',
      language: 'en-US',
      isFinal: true
    }));
    await guestCaptionPromise;

    const generatingPromise = waitForWebSocketMessage(host.ws, message => message.type === 'summary_status' && message.state === 'generating');
    const hostChatPromise = waitForWebSocketMessage(host.ws, message => message.type === 'new_chat_message' && message.messageKind === 'meeting_summary');
    const guestChatPromise = waitForWebSocketMessage(guest.ws, message => message.type === 'new_chat_message' && message.messageKind === 'meeting_summary');
    const publishedPromise = waitForWebSocketMessage(host.ws, message => message.type === 'summary_status' && message.state === 'published');
    host.ws.send(JSON.stringify({ type: 'request_meeting_summary', adminToken: hostInfo.adminToken }));
    await generatingPromise;
    const [hostChat, guestChat, published] = await Promise.all([hostChatPromise, guestChatPromise, publishedPromise]);

    assert.equal(published.state, 'published');
    assert.equal(hostChat.fromUsername, 'Meet Clone');
    assert.equal(hostChat.fromClientId, null);
    assert.equal(guestChat.message, hostChat.message);
    assert.match(hostChat.message, /Test decision/);

    const requestBody = JSON.parse(providerRequest.options.body);
    assert.equal(requestBody.model, 'openai/gpt-oss-120b');
    assert.equal(requestBody.stream, false);
    assert.match(requestBody.messages[1].content, /ship the update on Friday/);
    assert.doesNotMatch(requestBody.messages[1].content, /summary-host@example\.test/);
    assert.doesNotMatch(requestBody.messages[1].content, /adminToken/);

    const duplicateErrorPromise = waitForWebSocketMessage(host.ws, message => message.type === 'error' && message.code === 'SUMMARY_ALREADY_REQUESTED');
    host.ws.send(JSON.stringify({ type: 'request_meeting_summary', adminToken: hostInfo.adminToken }));
    await duplicateErrorPromise;
  } finally {
    global.fetch = originalFetch;
    await closeSocket(host.ws);
    await closeSocket(guest.ws);
  }
});
