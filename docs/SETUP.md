# Local setup and live verification

Baseline agreed on 7 October 2026: browser capture is primary; iOS Shortcut is optional; two workers share an existing calendar; timezone is `Asia/Dubai`. Other people may write to that calendar. The application may read back its own persisted event IDs to recover uncertain writes, but may not list arbitrary events, update or delete events. Retention defaults are 30 days for text and 90 days for operational metadata, preserving future and unresolved booking reservations.

## Local development

Use Node.js 22 or newer and PostgreSQL. Work from the repository root. Copy `.env.example` to `.env.local`, use a local development database in `DATABASE_URL` and a separate disposable database in `TEST_DATABASE_URL`. Do not point tests or demo seeding at a live database.

```sh
cp .env.example .env.local
npm ci
npm run db:migrate
npm run db:seed
npm run dev
```

Run `npm ci` once a lockfile exists; during initial repository bootstrap use `npm install` to produce it. The migration/seed commands depend on their scripts being delivered. Database credentials and the database itself must already exist. These commands are instructions, not evidence that setup or live integration has passed.

Keep `APP_MODE=demo` and `APP_ORIGIN=http://localhost:3000` during local synthetic-data development. Demo responses and calendars must be visibly labeled simulations. Local mode is not approved for real worker data or a public deployment.

Set four independent random application secrets: `SESSION_SECRET`, `TOKEN_ENCRYPTION_KEY`, `SHORTCUT_HASH_KEY` and `OWNER_SETUP_SECRET`. Generate a separate 32-byte random value for each using a local cryptographic generator or password manager. Use 64 hexadecimal characters for each unless the configuration validator requires a different encoding. Store them directly in the ignored environment file or deployment secret manager. Do not paste them into chat, command arguments, issue comments, screenshots or source control. Preserve the encryption key securely: replacing it without re-encrypting existing tokens breaks Google reconnection state.

## Configuration reference

The actual supported variable names are in `.env.example`; do not add `NEXT_PUBLIC_` to server secrets.

| Variable | Value / purpose |
| --- | --- |
| `APP_MODE` | `demo` locally; `live` only with real identity, database and provider configuration |
| `APP_ORIGIN` | Exact trusted application origin; HTTPS for deployment |
| `WORKSPACE_TIME_ZONE` | `Asia/Dubai` |
| `DATABASE_URL` | Server PostgreSQL runtime/migration connection; never exposed to browser |
| `TEST_DATABASE_URL` | Separate disposable PostgreSQL test database |
| `SESSION_SECRET` | Local demo session signing secret; not a replacement for live Supabase identity |
| `TOKEN_ENCRYPTION_KEY` | Server encryption key for stored OAuth credentials |
| `SHORTCUT_HASH_KEY` | Server keyed-hash secret for capture-only Shortcut credentials |
| `OWNER_SETUP_SECRET` | Server support authorization secret for owner connection setup |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL; public configuration |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public browser key, safe only with correct RLS and grants |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service credential, bypasses RLS |
| `GROQ_API_KEY` / `GROQ_MODEL` | Server API key; recommended initial model `openai/gpt-oss-20b` |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL` | Server credential able to issue tokens; initial model `nova-3` |
| `DEEPGRAM_ENDPOINT` | Approved WebSocket origin/path, default `wss://api.deepgram.com/v1/listen` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth web-client configuration, secret server-only |
| `GOOGLE_CALENDAR_ID` | Exact configured shared destination, not a user-supplied request parameter |
| `GOOGLE_REDIRECT_URI` | Exact authorized callback, e.g. `https://your-host/api/oauth/google/callback` |
| `GOOGLE_CALENDAR_OWNERSHIP` | `shared`, or `owned` only when the authorizing Google account owns the calendar |

Use separate staging and production credentials. A staging deployment must use a test calendar. Supabase SMTP credentials belong in Supabase's Auth email configuration rather than the browser/application environment. Deployment region and provider data regions are separate choices.

## Checks during implementation

```sh
npm run typecheck
npm run test:unit
npm run test:db
npm run build
npm run test:e2e
```

Run available checks at the relevant module gate; do not claim a check passed before its suite exists and runs. Database tests need the test database. End-to-end checks need their configured app/database lifecycle. Record actual command outcomes separately from these instructions.

## Live gates

1. **Identity/database:** migrations applied; two invited workers can sign in; disabled workers fail; private tables are inaccessible; worker A cannot read or mutate worker B's records through either UI or direct requests. Email delivery and session expiry/revocation are exercised.
2. **Language:** configured Groq model accepts the actual strict schema. Synthetic appointment, correction, note and ambiguous-date samples produce sensible facts; unavailable/quota/invalid-output cases preserve entered text and cannot cause a booking.
3. **Calendar:** account holder completes OAuth against a test calendar, refresh works, destination is verified, busy intervals and nested per-calendar errors are tested. Confirm creates one event; concurrent taps and timeout-after-success recovery create no duplicate. Readback rejects any event ID absent from a persisted application attempt.
4. **Audio/browser:** real supported browsers establish Deepgram authentication and stream their actual codec; final transcript is retained after Stop and socket interruption; microphone tracks stop; denied permission has a typed alternative; no raw audio is stored by the application. Verify privacy settings and two-minute client cutoff.
5. **Deployment:** eligible commercial hosting, exact OAuth/Auth redirects, environment separation, HTTPS, origin checks, secret redaction, backup/restore and retention jobs verified. Record actual provider rates and billing alerts.
6. **Acceptance:** actual worker devices perform review, clarification, explicit confirmation, note saving and reload. Calendar-owner recovery and reconnection are rehearsed. Optional Shortcut acceptance applies only if that route is delivered/enabled.

External writers can insert between the final free/busy check and event insertion. The application cannot make that cross-system operation atomic; own-event readback improves recovery, not external clash prevention. Never use automatic deletion to undo a conflict.

Until the live gates pass, describe the deliverable as a locally verified implementation with pending live acceptance. See [Provider access](PROVIDER_ACCESS.md) for account setup and primary-source details.
