# MVP architecture

Implementation baseline: 7 October 2026. User decisions supersede the original specification where stated here. The primary product is the browser app. iOS Shortcut support is optional and does not gate the browser MVP. Two workers use an existing shared calendar in `Asia/Dubai`; other people can also write to that calendar. Local development uses synthetic data and simulated providers while external credentials are prepared.

## Approved behavior

- English reviewed text and browser speech, persistent clarification, notes, own-record dashboard and explicit confirmation before creation.
- Require title, date, start, duration/end and location or an explicit Not applicable choice. Offer 30 minutes as a suggestion; never silently apply it.
- Five-minute immutable confirmation cards, fresh conflict checks, no conflict override, no calendar updates or deletes.
- Permit readback of an event created by this app, using its persisted deterministic ID. Never accept an arbitrary calendar/event ID from a worker to perform readback.
- No application audio retention. Default content retention is 30 days and operational retention 90 days; preserve unresolved booking snapshots and future reservation metadata.
- Existing external calendar writers mean conflict prevention is best effort across systems. Local transactions prevent two pilot operations reserving overlapping intervals, but Google does not provide atomic check-and-insert.

## Modules and boundaries

| Module | Responsibility | Must not do |
| --- | --- | --- |
| Web UI | Reviewed capture, conversation, field edits, note action, cards, dashboard and explicit confirmation | Assert booking success from model text or initiate creation on reload |
| Authentication | Verify web session/active worker; derive trusted worker identity | Trust request-body ownership or arbitrary identity headers |
| Application service | Coordinate capture, extraction, proposals, notes and outcomes | Hold a SQL transaction open during provider HTTP |
| Repository | Atomic owned mutations, version checks, reservations, idempotency, guarded state transitions and worker reads | Return foreign records or treat separate writes as a transaction |
| Language provider | Return schema-validated extracted facts, candidate question and usage | Choose calendar IDs, invoke booking or establish calendar truth |
| Calendar reader | Free/busy and app-owned event readback | Read unrelated event details |
| Booking service/writer | Consume explicit authorization and insert frozen payload with persisted ID | Update/delete events or generate new IDs during recovery |
| Speech provider/UI | Issue temporary credential; direct browser audio stream; finalized reviewed text | Expose a master key or automatically submit interim text |
| Operations | Provision/revoke, reconcile, redact, backup/restore and record usage | Release an unresolved booking merely because time elapsed |

Keep these as modules of one Next.js application. Provider code and privileged repositories are server-only. Avoid microservices, a general-purpose agent tool executor and an always-on audio backend.

## Contract recommendations

Treat this as a contract guide; the implemented TypeScript interfaces are authoritative for exact names.

- `LanguageProvider.extract(context)` returns structured facts and usage, never a tool command. Deterministic code validates field completeness, dates and unsupported intents.
- `CalendarReader.queryBusy(configuredCalendar, start, end)` returns busy intervals or explicit unavailable status, including per-calendar errors.
- `CalendarReader.getOwnedEvent(attempt)` derives calendar/event identifiers from a stored authorized attempt. Return found normalized fields, absent, or unavailable. No worker-controlled ID escape hatch.
- `CalendarWriter.insert(attempt)` submits only the immutable stored snapshot and deterministic event ID. The booking service is its sole application caller.
- Repository operations must cover atomic capture/replay, accepted turn/version, conditional extraction completion, note/replay, proposal supersession, reservation/consumption, dispatch claim and conditional finalization. All owned operations receive trusted actor identity; worker ID is part of lookup predicates.
- Provider results must preserve definitive rejection versus uncertain transport outcome. Unknown cost is null with a reason, never zero.

## Route inventory

All business routes authenticate and derive the actor server-side. Web mutations enforce same-origin/CSRF protection. Inaccessible records return 404 consistently. Exact implemented route names may be consolidated while preserving these operations.

| Operation | Suggested route | Rules |
| --- | --- | --- |
| Capture reviewed text | `POST /api/v1/captures` | Worker-scoped idempotency key and payload hash |
| Resume capture processing | `POST /api/v1/captures/{id}/resume` | Reuse stored user turn; reject concurrent processing/stale completion |
| Capture status | `GET /api/v1/captures/{id}` | Own state; no provider write side effect |
| Read conversation | `GET /api/v1/sessions/{id}` | Own turns, facts, version and current proposal/outcome |
| Submit follow-up | `POST /api/v1/sessions/{id}/turns` | Expected version and action identity |
| Save note | `POST /api/v1/sessions/{id}/note` | Explicit intent/action, atomic replay protection, no calendar call |
| Edit proposal | `POST /api/v1/proposals/{id}/edit` | Supersede immutable card; revalidate/recheck |
| Confirm proposal | `POST /api/v1/proposals/{id}/confirm` | Web session, exact version/hash, idempotency, sole new-write authorization |
| Attempt status/recovery | `GET /api/v1/booking-attempts/{id}`; `POST .../resume` | Read status versus guarded recovery of existing authorization |
| Own dashboard | `GET /api/v1/dashboard` | Bounded pagination and own filters |
| Speech credential | `POST /api/v1/speech-token` | Temporary restricted credential and metering session |
| Google connect | `/api/oauth/google/start`, `/callback` | Separate one-use owner setup authorization; validated OAuth state |

Optional Shortcut routes use capture-only credentials and a short-lived, one-use worker-bound handoff. They cannot confirm or resume a booking.

## Booking and readback recovery

1. Verify worker activation, proposal ownership, version/hash, expiry and current calendar configuration. A replay first finds the existing attempt.
2. Transactionally consume the card and reserve the interval under uniqueness/exclusion constraints. Persist immutable payload and deterministic event ID.
3. Query fresh Google free/busy. Exclude this attempt from local overlap checks. A failure before dispatch may release the reservation through a conditional transition.
4. Claim dispatch once and persist its timestamp before insertion. Recheck authorization expiry/activation/configuration immediately before dispatch.
5. Confirm success only after a successful provider response and durable local finalization. If either outcome is uncertain, hold the slot and expose the uncertain state.
6. Recovery reads only that stored event ID. Matching material fields and destination establish success; mismatched fields remain unresolved for owner reconciliation. Compare normalized instants, title and location; do not compare provider-added metadata.
7. A 404 alone does not prove a timed-out original request cannot still complete. Keep the same ID, preserve uncertainty, and never create a replacement attempt automatically. A bounded same-ID retry requires an exclusive recovery claim, still-valid original authorization, no outstanding local dispatcher and a safe free/busy check. Expired authorization permits readback only.
8. Provider read errors or 409 without matching readback do not establish success or failure. `succeeded` is terminal; late errors cannot downgrade it or release its reservation.

Manual external edits/deletions of known events can still make local reservation metadata stale. The MVP does not perform general event synchronization. Support reconciliation is explicit; readback of uncertain attempts must not silently rewrite a confirmed event's reviewed snapshot.

## Local demo and live isolation

Demo mode must be explicit and visually labeled. Use seeded synthetic workers with signed, HttpOnly, SameSite cookies and a local secret; demo worker selection is an intentionally isolated sign-in endpoint, never an identity override in business APIs. Enforce ownership in demo repositories too. A production start must fail closed if demo authentication/providers are selected. Use secure cookies under HTTPS.

Mock providers enable deterministic busy, timeout and malformed-output scenarios. They do not prove external access, model quality, browser microphone compatibility or PostgreSQL RLS. If local persistence differs from hosted PostgreSQL, state that distinction in startup documentation and test reports. Prefer real local PostgreSQL for constraints and transactions.

Live mode requires configured Supabase/auth, provider credentials, owner-authorized Google calendar and commercially eligible hosting. Startup/config validation must list missing variable names without printing secret values. Never silently fall back from a failed live provider to a successful mock response. Real data and live booking remain disabled until account/data settings and integration acceptance are complete.
