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

## Mobile voice interface — 8 October 2026

The start page now supports microphone-first requests, voice or text follow-up, inline detail editing, explicit booking confirmation, browser spoken replies with mute, and logout. The dashboard opens separately for tasks and workspace records. The platform uses a slate/navy theme, mobile safe areas, 16px inputs, and reduced-motion support.

Validation: 72 unit/database tests passed; eight browser scenarios passed using simulated speech/language responses with real local PostgreSQL. Voice browser coverage includes streaming submission and confirmation on the start page, denied microphone permission, and secure-upload fallback. The upload recovery case additionally confirms that failed submission retains the transcript and retries with the same capture identifier and original voice source. Fifteen page/viewport checks covered agent, tasks, calendar, audit, and settings at 320px, 390px, and 1440px without horizontal overflow or browser errors. Production build passed.

Live Deepgram access could not be established from this execution environment. The browser tests validate application behavior with simulated provider transport; actual Safari/Chrome microphone codecs, device speech output, provider credentials, and the deployed Vercel site still need live-device acceptance testing. No new environment variables are required.

## Detailed audit, fixed chat, and latency — 8 October 2026

Implemented a fixed mobile agent viewport with only conversation interactions scrolling, bottom microphone/chat controls, inline errors/detail forms/approvals/outcomes, visual-viewport handling, live streaming captions, and a persisted automatic/manual speech completion toggle. Automatic completion requires actual speech; initial silence cannot send. Restricted-token upload mode explains its after-recording captions and uses local silence detection.

Detailed audit migration includes submitted words, agent replies, before/after fields, exact approval snapshots, booking decisions/outcomes, speech/provider states, and usage metadata. Speech completion captures client-reported transcript, mode, reason, and recording duration without including transcription wait in audio duration. Processing records carry safe failure codes and duration before commit. Audit pagination is bounded; worker isolation and admin visibility remain enforced. Tests cover text redaction and the absence of expired proposal text in fresh logs after retention.

Latency changes remove three sequential round trips from each conversation read, combine membership/permission/audit context reads, parallelize independent availability checks, reuse idle connections longer, bootstrap pilot authentication into the page, reuse the login response, and load dashboard code separately. API application timing is available through `Server-Timing`. A 40-read warm local comparison measured 3.40 ms versus 2.43 ms median for the old/new conversation-read query shape; this does not measure production improvement. Vercel functions are configured for Tokyo (`hnd1`), matching the confirmed Supabase region.

All 80 unit/database tests and eleven browser scenarios passed during integration, with six affected voice/layout scenarios rerun after final speech lifecycle changes. Fifteen page/viewport checks at 320px, 390px, and 1440px passed without overflow or browser errors. Live production timing requests were blocked by the environment proxy (CONNECT 403); provider latency and actual-device microphone behavior remain unverified.

## Request allowance and HQ verification — 9 October 2026

The production build and TypeScript checks passed. All 165 unit/database tests and 15 browser scenarios passed against local PostgreSQL and controlled/simulated providers. New coverage includes concurrent allocation, follow-up reuse, exactly-once completion, inactivity and committed expiry, reset isolation, fresh-role admin exemption, cancellation without a language-provider call, ambiguous cancellation clarification, third-action booking replay/readback recovery, voice authorization boundaries, API rejection after exhaustion, dashboard read-only behavior, mobile HQ and live reset re-enablement. Mobile HQ overflow was checked at 320px.

A review identified and fixed quota-blocked uncertain-booking recovery, missing activity touch on explicit Resume and premature cancellation of an ambiguous mixed request. Browser fixtures reset real user allowance through the administrator HQ API rather than disabling enforcement. Local transport-rate buckets were cleared before the final browser run to isolate repeated test runs; production rate limits are unchanged for users, and authenticated administrators are exempt.

Live Groq response quality, Deepgram real microphone behavior and the deployed Vercel/Supabase migration are not verified in this environment. No new environment variables are needed; migration 009 runs through the configured Vercel build command. The quota implementation remains server-enforced even if UI polling fails. Idle expiry is observed on the next quota check, including the three-second HQ/user poll; no scheduled expiry worker is required.
