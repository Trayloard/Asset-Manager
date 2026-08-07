# Threat Model

## Project Overview

Empiri is a Node.js/Express AI companion application. Users authenticate via Replit OIDC, then chat with an AI companion backed by OpenAI. The API server is a TypeScript/Express 5 app with PostgreSQL (Drizzle ORM) storage. A companion mobile app (Expo/React Native) is served as a static build. The project is not yet deployed to production.

Stack: pnpm workspaces, Node.js 24, TypeScript 5.9, Express 5, PostgreSQL, Drizzle ORM, Zod validation, OpenAI SDK, Replit OIDC.

## Assets

- **User sessions** — session tokens (random 32-byte hex) stored in the `sessions` table; compromise allows full account impersonation.
- **Conversation data** — message history and AI-generated context summaries that may contain personal/sensitive user disclosures.
- **Companion inner-self state** — per-conversation trait/drive/interest data stored in the database; user-specific.
- **OpenAI API key** — `AI_INTEGRATIONS_OPENAI_API_KEY`; if leaked, enables arbitrary model usage billed to the owner.
- **Database credentials** — `DATABASE_URL`; full database access if leaked.
- **Replit OIDC client secret** — identity of the REPL_ID; used for the OIDC client.

## Trust Boundaries

- **Browser/Mobile to API** — all client requests cross this boundary. The API must authenticate and authorize every request to protected resources. The client is untrusted.
- **API to PostgreSQL** — the API has direct database access via Drizzle ORM with parameterized queries. SQL injection at the API layer would expose the full database.
- **API to OpenAI** — the API calls OpenAI with a secret key. Key leakage allows unauthorized model usage.
- **API to Replit OIDC** — server exchanges OIDC codes and refresh tokens with Replit. The callback URL is derived from request host headers.
- **Public / Authenticated** — `/api/healthz`, `/api/login`, `/api/callback`, `/api/logout` are public. All `/api/conversations/*`, `/api/companion-settings`, and `/api/voice/*` require authentication. `/api/auth/user` is public but returns null for unauthenticated callers.
- **Mobile auth exchange** — `/api/mobile-auth/token-exchange` accepts an authorization code from the mobile app and creates a session. This endpoint is unauthenticated by design but must validate the OIDC code.

## Scan Anchors

- **Production entry points**: `artifacts/api-server/src/app.ts`, `artifacts/api-server/src/routes/` (auth, companion, voice, health)
- **Highest-risk areas**: CORS config in `app.ts`, OIDC flow in `routes/auth.ts`, `getOrigin()` host header trust, voice endpoints (unauthenticated? — check), conversation ownership in `requireOwnedConversation`
- **Public surface**: `/api/login`, `/api/callback`, `/api/logout`, `/api/healthz`, `/api/auth/user`, `/api/mobile-auth/token-exchange`, `/api/mobile-auth/logout`
- **Authenticated surface**: all `/api/conversations/*`, `/api/companion-settings`, `/api/voice/*`
- **Dev-only surface**: `artifacts/mockup-sandbox/` (design mockup), `artifacts/mobile/server/serve.js` (static Expo build server)

## Threat Categories

### Spoofing

Authentication is handled via Replit OIDC with PKCE and nonce. Sessions are random 32-byte hex tokens stored server-side in PostgreSQL. Session cookies are `httpOnly`, `secure`, `sameSite: lax`. The OIDC callback validates `state`, `nonce`, and `codeVerifier` from short-lived cookies.

**Risk**: The `getOrigin()` helper in `routes/auth.ts` trusts the `x-forwarded-host` and `x-forwarded-proto` headers without validation. An attacker who can inject these headers (e.g., if the server is directly reachable without a trusted proxy) could manipulate the `redirect_uri` sent to the OIDC provider and the `post_logout_redirect_uri` in end-session requests.

**Required guarantee**: `x-forwarded-*` headers must only be trusted if the request comes from a known, trusted proxy, or the allowed redirect URIs must be allowlisted.

### Tampering

All conversation and message operations use `requireOwnedConversation`, which validates conversation ownership server-side before any operation. All DB queries use Drizzle ORM parameterized statements (no raw SQL interpolation found).

### Repudiation

Pino HTTP logging is in place for all requests. Sensitive operations (login, message send) are logged. Log content is intentionally minimal (method, path without query string, status code).

### Information Disclosure

**CORS misconfiguration** (`cors({ credentials: true, origin: true })`): The `origin: true` setting reflects any `Origin` header back, effectively allowing any domain to make credentialed cross-origin requests. This lets malicious third-party sites read authenticated API responses (conversation data, messages) via JavaScript.

No evidence of secrets logged in plaintext. OpenAI API key is via environment variable. Stack traces are not returned to clients in error responses.

### Denial of Service

Request body limit is set to 50 MB (`express.json({ limit: "50mb" })`). No rate limiting middleware is present on any endpoint. The `/api/voice/transcribe` endpoint accepts base64-encoded audio up to the body limit and processes it (format conversion + OpenAI Whisper call) with no authentication check.

**Required guarantee**: Rate limiting should be applied to at minimum auth, voice, and AI-completion endpoints.

### Elevation of Privilege

Conversation ownership is checked server-side. The `/conversations/:id/dev/regress` endpoint is guarded with `NODE_ENV === "production"` check. All admin-style operations enforce `req.isAuthenticated()` checks. No role escalation vectors identified.
