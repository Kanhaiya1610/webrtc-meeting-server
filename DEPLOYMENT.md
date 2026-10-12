# Meeting server deployment

The meeting server owns live WebSocket connections and room state. Run one
canonical production instance for normal traffic. A second deployment may be
used as reconnect failover, but it must not be used as an ordinary round-robin
load balancer while rooms are kept in memory.

## Required environment variables

Copy `.env.example` to the deployment provider's environment settings and set:

- `GOOGLE_CLIENT_ID` to the same client ID used by the browser configuration.
- `ALLOWED_ORIGINS` to the exact HTTPS origin hosting the client.
- `GEMINI_API_KEY` if live caption translation is enabled.
- `ICE_SERVERS_JSON` to TURN credentials from a managed TURN provider. Do not
  copy static credentials from the old source file.

Update `webrtc-meeting-client/config.js` with the canonical backend URL and the
same public Google client ID. The browser client ID is not a secret; Gemini and
TURN credentials must never be placed in that file.

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
