# Voice Capture Agent

Browser-first pilot for two workers: review typed or transcribed requests, clarify appointment details, save notes, and explicitly confirm bookings in the built-in shared calendar. Google, Outlook, iCloud and Fastmail connectors import external events. Appointments use Asia/Dubai. iOS Shortcut support is optional and not implemented in this release.

## Run locally

Requires Node 22+ and PostgreSQL 17 with `btree_gist`. Copy `.env.example` to `.env.local`, supply independent random application secrets and local database URLs, then:

```sh
npm ci
npm run db:migrate -- --local-bootstrap
npm run db:seed
npm run dev
```

Open http://localhost:3000. Pilot login provides user1, user2 and admin accounts with temporary aliases. Set PILOT_LOGIN=true and run npx tsx scripts/pilot-setup.ts after migrations. The administrator code is the current UAE month and year (MMYYYY). LANGUAGE_PROVIDER=groq and SPEECH_PROVIDER=deepgram enable configured real providers independently of local mode. Demo mode refuses public origins. Never use real worker data in demo mode. `--local-bootstrap` is only for local PostgreSQL; on Supabase use `npm run db:migrate` with the existing roles.

The test database must be separate and end in `_test`: database tests destroy its application schemas.

```sh
npm test
npm run typecheck
npm run build
# With the local app running and Playwright Chromium installed:
npm run test:e2e
# Alternatively, use an existing compatible Chromium:
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium npm run test:e2e
```

## Modules and operating guides

- [Sequential modules, issues and dependencies](docs/IMPLEMENTATION_PLAN.md)
- [Approved scope and decisions](docs/DECISIONS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Configuration and live setup](docs/SETUP.md)
- [Provider access](docs/PROVIDER_ACCESS.md)
- [Acceptance checklist](docs/ACCEPTANCE.md)
- [Operations and release status](docs/OPERATIONS.md)

## Safety properties

A confirmation card binds exact fields, worker, calendar configuration and version with a five-minute expiry. Confirmation persists an attempt before dispatch; database constraints serialize overlapping application bookings. Ambiguous writes retain their reservation and recover only by reading the persisted event ID. They never blindly insert again. Other calendar writers can still race between Google's availability check and insertion; Google does not offer an atomic check-and-create operation.

Worker data uses authenticated ownership checks and read-only RLS. OAuth refresh tokens are encrypted at rest. Raw audio streams directly from the browser to Deepgram and is not stored by this app. Provider account retention settings must also be verified before live use.

## Dashboard update

Separate Tasks, Calendar, Audit logs and Settings sections are implemented. Tasks and calendars are shared across the workspace by default. Audit logs are private to the stable user code, with administrators able to view all logs. Administrator settings can revoke section access or disable users. Names are session aliases and audit snapshots, never new identities.

See [Calendar connectors](docs/CALENDAR_CONNECTORS.md) for Google/Outlook OAuth and iCloud/Fastmail app-password setup. These imports are read-only; built-in bookings are not exported to external providers. The simple pilot login intentionally follows the requested user-selector/month-code flow and does not authenticate a person's identity.
