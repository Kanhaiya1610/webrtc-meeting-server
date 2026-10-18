# Meeting server deployment

The meeting server owns live WebSocket connections and room state. Run one
canonical production instance for normal traffic. A second deployment may be
used as reconnect failover, but it must not be used as an ordinary round-robin
load balancer while rooms are kept in memory.

## Required environment variables

Copy `.env.example` to the deployment provider's environment settings and set:

- `GOOGLE_CLIENT_ID` to the same client ID used by the browser configuration.
- `ALLOWED_ORIGINS` to the exact HTTPS origin hosting the client.
- `NODE_ENV=production`, `REQUIRE_TLS=true`, and `TRUST_PROXY_HOPS=1` when
  exactly one trusted HTTPS reverse proxy sits in front of Node. Keep
  `TRUST_PROXY_HOPS=0` when Node is directly exposed.
- `GEMINI_API_KEY` if live caption translation is enabled.
- `GROQ_API_KEY` for the server-side Whisper fallback. Paste it only into the
  Koyeb/Render secret environment settings or a local ignored `.env` file as
  `GROQ_API_KEY=your-key`. Never paste it into `webrtc-meeting-client`,
  `config.js`, GitHub, browser code, or chat.
- `GROQ_TRANSCRIPTION_MODEL=whisper-large-v3-turbo`.
- `GROQ_SUMMARY_MODEL=openai/gpt-oss-120b` and the bounded summary/transcript
  limits from `.env.example` when the host-triggered AI summary is enabled.
- `ICE_SERVERS_JSON` to TURN credentials from a managed TURN provider. Do not
  copy static credentials from the old source file.
- `JOIN_REQUEST_TTL_MS`, `JOIN_GRANT_TTL_MS`, and `MAX_PENDING_JOIN_REQUESTS`
  if the default host-admission queue limits do not match the deployment.

Unauthenticated `/ice` requests receive public STUN only. The client reloads
the endpoint after Google authentication to receive configured ICE servers.
Use short-lived TURN credentials and provider-side quotas.

The Groq fallback endpoint accepts one bounded raw audio chunk per request at
`POST /captions/transcribe`. It is authenticated with the same short-lived
server session used by the meeting WebSocket. The browser never receives the
Groq key. A host-triggered meeting summary sends only bounded final caption
text to Groq's chat-completions endpoint once per room; raw audio, private
notes, and chat history are not included in that summary request.

Room codes only create a join request. The host must admit each visitor before
that visitor receives a short-lived, one-use admission grant. Admission state
is held in memory with the room, so the canonical backend and reconnect rules
above still apply.

Update `webrtc-meeting-client/config.js` with the canonical backend URL and the
same public Google client ID. The browser client ID is not a secret; Gemini and
TURN credentials must never be placed in that file. The background-filter UI
loads the MediaPipe segmentation runtime from jsDelivr, so retain the matching
CSP allowlist or self-host that runtime before deployment.

The Google Cloud OAuth client must contain the client origin under **Authorized
JavaScript origins**. The backend does not need a Google redirect URI because
the app uses Google Identity Services in the browser.

## Render and Koyeb

Do not send users to both deployments with DNS round-robin or a frontend array
that selects a different server for every request. A WebSocket connection is
long-lived, and each server has its own in-memory rooms, host tokens, and peer
connections. A room created on Render is therefore invisible to Koyeb.

Use this topology instead:

1. Point the client at one canonical backend.
2. Keep the second endpoint only for initial-connection or idle-client
   failover. An active meeting must keep reconnecting to its original backend.
3. Use the room resume token when reconnecting to that same backend during its
   grace period.
4. For true horizontal scaling or cross-provider recovery, move room/session
   state to a shared store and
   route WebSocket traffic with a shared signaling layer. Supabase can provide
   durable metadata or presence, but it is not automatically a Redis-style
   pub/sub layer for WebSocket signaling.

## Local development

```powershell
cd webrtc-meeting-server
Copy-Item .env.example .env
npm install
npm start
```

Serve `webrtc-meeting-client` from `http://localhost:5500` (for example with
VS Code Live Server). The client automatically uses `http://localhost:8080`
when opened from localhost.

Never commit `.env`. Rotate any Gemini or TURN credentials that were present in
older deployments.

For local development, the only permitted secret location is:

```text
webrtc-meeting-server/.env
```

Example:

```env
GROQ_API_KEY=replace-with-private-key
```

The `.env` file is ignored by Git. In production, prefer the provider's secret
environment-variable UI instead of uploading a `.env` file.

Before launch, configure the frontend host with HTTPS, HSTS, a restrictive
Content-Security-Policy, `Referrer-Policy: no-referrer`,
`Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)`,
`X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`. See
`SECURITY-REVIEW.md` for the complete launch gate and residual-risk list.
