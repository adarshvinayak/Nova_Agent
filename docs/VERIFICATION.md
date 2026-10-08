# Verification — 8 October 2026

Local synthetic-data evidence:

- 43 unit/database tests passed together; the added retention regression then passed with all 23 database tests (44 unit/database tests total across these runs).
- Four Chromium browser scenarios passed: note save/reload and worker isolation, explicit appointment confirmation, 320px layout, invitation credentials removed from URL without automatic submission. The invitation assertion was narrowed to distinguish the app alert from Next.js's route announcer and rerun successfully.
- TypeScript and production Next.js build passed.
- Retention dry run completed and rolled back; regression confirms settled text redaction preserves unresolved booking recovery and idempotency identities.
- Usage report executed successfully against synthetic captures.

Fault/concurrency coverage includes duplicate taps, concurrent dispatch, stale/foreign cards, availability recheck, remote-success timeout, uncertain readback, late completion fencing, captured-time date anchoring and preservation of facts during calendar failure.

Not verified: live Supabase invitations/session behavior, Groq structured responses, Deepgram microphone/codec behavior on real devices, Google OAuth/refresh/creation/readback, hosting deployment, backup restoration and owner pilot acceptance. Provider tests use mocked transport; simulated browser booking does not create Google events.

Playwright's browser download was blocked by network policy. Browser scenarios used the already-installed `/usr/bin/chromium` instead. No network-policy bypass was used.

## Dashboard revision verification — 8 October 2026

57 unit/database tests passed after adding workspace permissions, shared tasks/calendar, audit isolation, connector parsing/host safety and external availability checks. All five browser scenarios passed across targeted reruns; obsolete login and mobile navigation locators were corrected. Browser cases cover reviewed notes/reload/isolation, confirmed built-in booking, 320px layout, invitation handling, task completion, manual event creation, own/admin audit visibility and admin permission revoke/restore. Browser capture extraction used a deterministic simulated provider; durable bookings and dashboard data used the actual local PostgreSQL database.

The updated production build and TypeScript checks passed. The running production process uses the saved Groq and Deepgram configuration and the local PostgreSQL database, with pilot user/admin login enabled. Supabase Auth, Groq and Deepgram live readiness probes each failed with EAI_AGAIN DNS/network errors. Remote Supabase migrations and actual provider functionality are therefore unverified. External calendar OAuth/application or CalDAV credentials are not configured. This is a local operational dashboard with blocked live-provider verification, not a fully verified deployed service.

Credentials supplied in chat were saved only to ignored .env.local. No actual credentials were added to documentation or source control. The remote Supabase connection is saved separately as SUPABASE_DATABASE_URL; DATABASE_URL remains local until connectivity and a controlled migration are possible.
