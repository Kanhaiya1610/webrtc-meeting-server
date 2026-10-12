const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

process.env.PORT = '0';
process.env.ALLOWED_ORIGINS = 'http://localhost:5500';

const { server, startServer } = require('../server');

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
    const timer = setTimeout(() => reject(new Error('WebSocket test timed out')), 2_000);
    const onError = error => {
      clearTimeout(timer);
      reject(error);
    };
    ws.on('error', onError);
    ws.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('error', onError);
      resolve(message);
    });
  });
}

test.before(async () => {
  await waitForListening();
});

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
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
