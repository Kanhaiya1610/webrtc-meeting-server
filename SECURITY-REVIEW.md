# Meeting application security review

## Scope

This review covers only:

- `webrtc-meeting-client`
- `webrtc-meeting-server`

The standalone broadcast client and signaling server are intentionally outside
the scope of this application review.

This is a source and local abuse review. It is not a substitute for an
external penetration test against the deployed Render/Koyeb services.

## Security boundary

The browser is an untrusted client. A user can open DevTools, edit JavaScript,
call globally exposed functions, forge WebSocket messages, and record media
that has already been delivered to their browser. Those actions are expected to
be possible for the participant's own browser.

The security boundary is therefore the meeting server. The server must derive
the acting identity from the verified Google token and must independently check
room membership and host authorization for every state-changing operation.

## Controls implemented

### Identity and authorization

- Google ID tokens are verified server-side with issuer, audience, signature,
  expiry, subject, and verified-email checks.
- Client-provided email, username, admin flags, and sender IDs are not used as
  authentication.
- WebSocket room actions require an authenticated connection.
- Host actions require the server-side current host connection and the current
  room-scoped admin token.
- Resume requires both a room resume token and the matching Google subject.
- Knowing a room code creates a pending join request; it does not create room
  membership. The host must approve the request with the current admin token.
- Admission grants are short-lived, bound to the requester connection and
  verified Google subject, and consumed once before participant creation.
- Admin tokens rotate when host privileges transfer or are reassigned.
- Sign-out revokes the server session and closes the meeting socket.

### WebSocket abuse resistance

- Browser origins are checked; production connections without an Origin are
  rejected.
- Maximum WebSocket frame size is bounded.
- Invalid JSON and invalid message structures are counted and eventually close
  the connection.
- Aggregate inbound bytes and message counts are bounded per connection.
- Signaling SDP and ICE payloads have explicit schemas and size limits.
- Outbound messages are bounded and slow clients are closed when their send
  buffer grows too large.
- Active connections are limited globally, by source address, and by verified
  Google subject.
- Room creation has global and per-account limits.
- Chat, captions, translation, and room membership are bounded.
- Pending admission requests and grants are bounded, expire, and are cleared
  when the requester disconnects or the room ends.

### HTTP and provider protections

- Helmet security headers are enabled on API responses.
- CORS is allowlisted and does not use `*`.
- JSON request bodies are limited to 32 KB.
- HTTP and translation rate limits are enabled.
- Translation requires a server-issued session and has per-user quotas.
- Host-only meeting summaries use one bounded, server-memory transcript snapshot
  per room and one Groq chat-completions call; raw audio, chat, and private
  notes are excluded.
- Groq fallback transcription requires a server-issued session, room membership,
  bounded raw audio chunks, and per-user request limits.
- The Groq API key is read only from the server environment and is never sent
  to the browser or returned by an API response.
- Translation provider timeouts prevent hung requests.
- Raw translated text is not retained in a shared process-wide cache.
- Unauthenticated `/ice` requests receive public STUN only; configured TURN
  credentials require authentication.
- API responses do not return provider error bodies or secrets.
- Production deployments require HTTPS/WSS through the configured edge.

### Browser privacy protections

- Camera/microphone access is requested for creators after preparation and for
  visitors only after the server issues a host admission grant.
- Room codes are validated strictly and removed from browser history after an
  invitation is read.
- Remote participant IDs are validated before being used in DOM IDs or WebRTC
  routing.
- Chat, captions, usernames, timestamps, and account data use safe rendering
  or escaping.
- Chat DOM retention is bounded.
- Recording and screen sharing send participant notifications.
- A participant's own caption transcription is not rendered locally; the
  server broadcasts captions only to the other room participants.
- Shared-screen presentation uses a fit-to-stage layout with local pin and
  movable presenter-overlay controls; browser fullscreen is not required.
- Meeting notes stay in browser-local storage and are never sent over signaling.
- Background filters run client-side and fall back to the raw camera if the
  segmentation runtime is unavailable.
- TURN configuration is loaded with authenticated credentials after sign-in.

## Tests run

The meeting server currently passes:

```text
npm run check
npm test
npm audit --omit=dev --audit-level=high
```

The integration tests cover:

1. Health endpoint availability.
2. Unauthenticated room-creation rejection.
3. Unauthenticated translation rejection.
4. Unauthenticated ICE responses not containing TURN credentials.
5. Termination after repeated malformed WebSocket messages.
6. Raw Groq transcription authentication, CORS, provider forwarding, and
   sender-excluded caption broadcast.
7. Resumed HTTP sessions retaining their bound client identity.
8. Host admission, one-use grants, direct-join rejection, and host-token
   authorization.
9. Host-only, one-call Groq summary generation and delivery to all current
   participants without exposing the transcript.

The meeting client passes JavaScript syntax checks with `node --check` for
`main.js` and `config.js`.

## Deployment gates before public launch

These checks must be completed against the actual deployed services:

1. Rotate the Gemini key and any TURN credentials that appeared in older source
   or deployments.
2. Set `NODE_ENV=production`, `REQUIRE_TLS=true`, and the correct
   `TRUST_PROXY_HOPS` for the provider edge.
3. Set `ALLOWED_ORIGINS` to the exact frontend HTTPS origin.
4. Configure a supported Node LTS runtime.
5. Use short-lived TURN credentials with provider-side quotas. Do not deploy
   long-lived shared TURN passwords.
6. Configure the static frontend host with response headers equivalent to:

   ```text
   Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; worker-src 'self' blob:; connect-src 'self' https://accounts.google.com https://cdn.jsdelivr.net https://your-meeting-backend.example wss://your-meeting-backend.example; img-src 'self' data: https:; style-src 'self' https://cdnjs.cloudflare.com; style-src-attr 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com https://cdn.jsdelivr.net; worker-src 'self' blob:; media-src 'self' blob:; font-src 'self' https://cdnjs.cloudflare.com
   Referrer-Policy: no-referrer
   Permissions-Policy: camera=(self), microphone=(self), display-capture=(self)
   X-Content-Type-Options: nosniff
   X-Frame-Options: DENY
   Strict-Transport-Security: max-age=31536000; includeSubDomains
   ```

   The client now uses delegated event listeners instead of inline event
   handlers. The remaining `style-src-attr 'unsafe-inline'` is for dynamic
   visual state changes and does not permit JavaScript execution. The
   server-side authorization remains effective even if a user modifies the
   page.
7. Verify the deployed `/health`, `/ice`, and `/translate` behavior from an
   unauthenticated client and with an invalid Origin.
8. Run a two-browser test for Google sign-in, room isolation, host controls,
   reconnect, recording notifications, screen-share notifications, and media
   permissions.
9. Run an authorized external scan and manual test. Do not scan third-party
   TURN or Google endpoints.

## Residual risks

- In-memory rooms disappear when the server restarts. This is an availability
  limitation, not a confidentiality bypass.
- Active rooms cannot safely fail over between Render and Koyeb without shared
  signaling state and connection routing.
- Room codes are invitation secrets. Anyone with a valid code and a verified
  Google account may attempt to join; host admission or domain allowlists can be
  added if stricter privacy is required.
- WebRTC may expose peer network metadata depending on ICE policy and browser
  behavior. Use relay-only ICE if hiding peer addresses is a product
  requirement.
- Browser speech recognition and translation may process meeting content with
  third-party providers. This requires a user-facing privacy notice and an
  appropriate data-processing decision.
- The Groq fallback uploads short microphone chunks to Groq only when browser
  speech recognition is unavailable or fails. Audio is held in memory only for
  the request and should not be logged or persisted by this application.
- A host summary request uploads bounded final caption text to Groq. The
  transcript is ephemeral process memory, is never sent to clients, and is
  discarded when the room is disposed. Provider output is escaped as chat text.
- A participant can always use an operating-system screen recorder or capture
  media that their browser has already received. Web applications cannot fully
  prevent that.
- No source-only review can certify provider, proxy, DNS, TLS, Google Cloud,
  or TURN account configuration.
