# Voice Capture Agent — sequential MVP implementation plan

Prepared 7 October 2026. User has authorized implementation and parallel agent reviews. Baseline decisions are approved in docs/DECISIONS.md. Local implementation with simulated providers is authorized while live access is prepared. Browser functionality is primary; iOS Shortcuts are optional.

Source specification: `/workspace/voiceagent-design`. Repository: `adarshvinayak/Nova_Agent`. Existing reference SQL is a design input, not a production migration.

## Module sequence

| Module | Scope | Dependency | Exit evidence | Roadblocks / treatment |
| --- | --- | --- | --- | --- |
| M0 — Decisions and environment | Confirm worker/calendar topology, timezone, scheduling rules, retention and recovery; configure local/live modes | User answers | Recorded decisions and explicit access inventory | Scope approved; live credentials must still be injected |
| M1 — Foundation and identity | Next.js/TypeScript application, configuration validation, PostgreSQL migrations, worker identity, RLS, secret handling, test harness | M0 architecture decisions | Build/type checks; real PostgreSQL migration and two-worker privilege tests | Supabase project/DB access required for hosted verification; use local DB only if authorized |
| M2 — Durable text capture | Reviewed typed/shared-text input, owned sessions/turns, capture status/resume, idempotency and conversation shell | M1 | Exact replay returns prior result; changed payload rejected; reload and concurrent edits tested | Existing API specification omits conversation-read/capture-resume routes; add them |
| M3 — Agent and scheduling facts | Groq adapter, structured extraction, saved facts, clarification, deterministic date/time validation, manual corrections | M2 | Ambiguous dates/DST/duration/location and stale inference tests; no calendar authority in model | Live Groq key/model needed for quality evaluation; simulated extraction is not model acceptance |
| M4 — Notes and dashboard | Explicit note saving, own notes/requests/events, pagination, filters, resume and expired-content states | M2–M3 | Note path never calls calendar; two-worker isolation; durable reload | Store action payload hashes; distinguish explicit note from incomplete appointment |
| M5 — Google connection and proposals | Owner setup/OAuth, encrypted tokens, scope selection, free/busy, immutable expiring cards | M3, configuration from M0 | OAuth contract tests, nested free/busy errors, stale/config-changed cards | Google client/test calendar/account owner; final redirect host; scope depends on calendar ownership |
| M6 — Confirm, create and recover | Human confirmation, transactional reservation, stable event IDs, monotonic states, guarded recovery | M5 | Concurrency/replay/fault tests; timeout after remote success; late response cannot release booked interval | Own-event readback approved; external calendar race cannot be made atomic |
| M7 — Browser speech | Temporary STT token, direct Deepgram socket, supported codec, interim/final text and review | M2–M3 | Adapter contracts and UI tests; actual Safari/home-screen mic tests | Deepgram account/model/privacy controls; actual worker devices |
| M8 — iOS Shortcut | Capture-only per-worker credentials, reviewed dictation/shared text, single-use handoff, installation guide | M2, M4 | Invalid/revoked tokens denied; owner-bound handoff; actual Back Tap/share-sheet tests | Locked-phone behavior and on-device dictation need real devices; installation cannot be completed remotely without participation |
| M9 — Operations and release | Usage costs, retention, backup/restore, provisioning/revocation, observability, release setup, runbook | All modules | End-to-end safety suite, live provider smoke tests, device acceptance, deployment evidence | Hosting/deployment access, approved data policy, accounts and acceptance owner |

Implementation remains sequential through these gates. Agents may work on independent pieces inside a module once interfaces are agreed; overlapping edits will be avoided. A module is not complete merely because mock tests pass when live/device evidence is part of its gate.

## Engineering corrections accepted for implementation

1. Implement atomic capture, note, reservation and completion operations through trusted PostgreSQL transactions or narrowly scoped RPCs. Do not approximate transactions with independent Supabase calls.
2. Enforce allowed booking state transitions. `succeeded` is terminal; a failed retry must not erase evidence of an earlier uncertain dispatch.
3. Add recovery ownership/fencing and conditional completion. An expired lease does not prove a remote write failed. Preserve uncertain reservations until verified.
4. Exclude the current attempt from local conflict checks after reservation. Other workers' conflict details remain private.
5. Persist operation-specific idempotency keys, canonical payload hashes and results for capture, turns, notes and confirmation.
6. Apply optimistic versions to inference completion; retain accepted input while rejecting stale model results.
7. Recheck worker activation, selected connection/config and authorization expiry immediately before dispatch. Document the remaining remote-call race.
8. Add owned conversation retrieval and capture processing-status/resume APIs. One-use handoff replay must not mint unlimited new codes.
9. Track speech sessions before a capture exists so abandoned streams still contribute usage; link the capture later. Client usage is an estimate until reconciled.
10. Implement retention as state-aware redaction first; unresolved snapshots and future booking metadata cannot be removed prematurely. Handle circular capture/session references explicitly.
11. Keep provider failures distinct from unknown outcomes. Never infer successful creation merely from a busy interval or HTTP 409.
12. Test actual PostgreSQL constraints/RLS/concurrency, including service-role ownership enforcement; mock repositories do not prove database safety.

## Decision record (approved in chat; see DECISIONS.md)

| Decision | Recommended choice / question |
| --- | --- |
| MVP scope | Two workers, English, one shared calendar, explicit confirmation, create only, explicit duration with a 30-minute suggestion, location or Not applicable |
| Timezone and devices | User supplies IANA timezone plus both iPhone models/iOS versions; no location inferred from AED currency |
| Recovery readback | Allow a narrowly scoped read of a server-stored app-created event ID to verify uncertain writes; no unrelated event reads and no update/delete operations. Otherwise retain manual reconciliation. |
| Local build while access is prepared | Build/test with local DB and simulated providers; mark provider/device validation pending until real access arrives |
| Data policy | No app audio storage; 30-day text and 90-day operational retention, preserving future/unresolved booking metadata; user supplies mandatory region requirements if any |
| Calendar writers | Prefer a dedicated pilot calendar; if others write to it, explicitly accept best-effort conflict detection against external changes |
| Ownership | Name Google account holder, device test participants and final acceptance owner; worker identities can be provisioned before live onboarding |

The user's new implementation instruction authorizes technical work. Expiration of the old proposal's price validity is not an artificial blocker to local development. Paid purchases or changed vendor spending still require actual account/budget configuration.

## Secure access inventory

Supply secret values through secure environment/deployment settings, not repository files or chat. Public identifiers may be shared normally. Generate application encryption/hashing/setup secrets locally when implementing; never ask the user to invent them. Google refresh tokens come from the account holder's OAuth flow.

| Service | Public/configuration input | Secure access required | Needed by |
| --- | --- | --- | --- |
| Supabase | Project URL, publishable key, selected region, worker identities | Server-side secret/service credential; PostgreSQL migration/runtime connection; SMTP settings if email sign-in/invitations used | M1 hosted verification; live onboarding |
| Groq | Selected available model and approved data controls | `GROQ_API_KEY` | M3 live evaluation |
| Google | Cloud project, enabled Calendar API, OAuth client ID, exact test/destination calendar IDs, consent app type/status, owner/test users | `GOOGLE_CLIENT_SECRET`; owner authorization flow obtains tokens | M5–M6 live integration |
| Deepgram | Model/region, approved retention/training settings | `DEEPGRAM_API_KEY` with suitable temporary-credential permissions | M7 live transcription |
| Hosting | Commercially eligible Vercel team/project or selected alternative; region and optional domain | Deployment connection/credential through supported environment configuration | M9 deployment |

No live provider secrets or outbound identities were configured in the inspected environment. A Git remote exists; write/deployment access is not yet verified. Default Supabase email delivery, provider credit purchases, regional availability and token permissions must not be assumed.

## Completion criteria

The MVP is complete when its working code, migrations, setup instructions and operations runbook are delivered; meaningful unit/integration/end-to-end checks pass; user identity and booking safety are verified; live provider connections and the primary browser capture route is tested on the agreed devices (optional iOS Shortcuts are tracked separately); and the chosen deployment is accessible to the pilot workers. If external input remains missing, report exactly which gates are pending instead of labeling the full MVP complete.

## Implementation status — 8 October 2026

M0–M7 local implementation delivered, with live identity/provider/device acceptance pending. M8 is optional and deferred. M9 operational scripts and runbooks delivered; deployment, real-provider integration, backup restore rehearsal and owner sign-off remain open. The user has confirmed all service accounts except Google OAuth/test calendar are ready and will own Google connection and acceptance. Credentials are not yet injected into this environment. See OPERATIONS.md and VERIFICATION.md for current evidence rather than the original planning assumptions above.
