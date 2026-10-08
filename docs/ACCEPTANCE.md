# MVP acceptance matrix

This is a test plan, not a claim that tests have passed. Record command/result, evidence and date in the release report. Browser capture is primary; optional iOS acceptance does not block release of the agreed browser MVP. Use synthetic content and a dedicated test calendar until live account/data controls are ready.

## Required browser MVP checks

| ID | Scenario | Required result | Evidence layer |
| --- | --- | --- | --- |
| A01 | Anonymous/disabled worker calls API | Denied; no durable business mutation/provider write | API integration |
| A02 | Worker A requests/mutates B's session, proposal, attempt, note | Uniform 404, no data/ownership leak or mutation | API + real PostgreSQL |
| A03 | Worker JWT directly queries tables/private schema | Only own allowed reads; direct writes/private access denied | Real PostgreSQL RLS/grants |
| A04 | Demo mode starts in production or live provider config is incomplete | Startup rejects unsafe mode; missing names reported without secrets | Configuration |
| A05 | Capture replay, same key/different payload | Replay reuses capture/turn; changed content returns conflict | Repository/API |
| A06 | Extraction fails after durable accepted text; retry/reload | Accepted input retained, no duplicate turn, processing resumes | Fault integration |
| A07 | Two tabs submit at same version; delayed model completion arrives | One accepted version; stale result cannot overwrite newer facts/card | Concurrency integration |
| A08 | Explicit correction to accepted facts; >20 turns | Correction wins; durable facts survive bounded model context | Domain/provider contract |
| A09 | Malformed model JSON, unsupported intent, prompt-injection text | Validated rejection/manual clarification; zero booking authority | Provider/domain |
| A10 | Ambiguous date/AM-PM, past date, overnight/DST edge | Deterministic rejection/clarification; Asia/Dubai shown by default | Domain |
| A11 | Missing duration/location | Ask or visibly suggest duration; require acceptance and location/N/A | Browser/domain |
| A12 | Explicit note and incomplete appointment | Note saves without calendar; incomplete appointment asks/offers note | API/browser |
| A13 | Repeated note action with identical/different payload | One note for replay; mismatch rejected | Repository |
| A14 | Busy partial overlap, adjacency and two workers same slot | Overlap blocked, adjacency allowed, one reservation winner | Domain + PostgreSQL race |
| A15 | Google HTTP success containing per-calendar error | Availability unknown; confirmation blocked | Provider contract |
| A16 | Foreign worker overlap | Time interval/label only; no foreign title or transcript | API/browser |
| A17 | Dictated/typed “confirm,” page reload, model output | No event insertion without explicit card action | API/browser |
| A18 | Edit, expiry, configuration change, stale hash/version | Old card cannot authorize insertion | Domain/API |
| A19 | Double tap, replay, concurrent confirms | One immutable attempt and one deterministic event ID | PostgreSQL + fault integration |
| A20 | Worker deactivated or connection changed before dispatch | Dispatch blocked before provider insert | Fault integration |
| A21 | Function dies before dispatch vs after dispatch | Pre-dispatch safe failure; post-dispatch uncertainty holds slot | Fault integration |
| A22 | Timeout after Google creates; readback matches | Recover success using stored ID and frozen fields; no new ID | Provider + repository fault |
| A23 | Readback mismatch/error/404 with possible outstanding write | Remain unresolved; no premature release or claimed success | Recovery fault |
| A24 | HTTP 409 on insert | Verify own stored event; 409 alone never means success | Provider contract |
| A25 | DB finalization fails after remote success | Show uncertainty, readback reconciles, no duplicate booking | Fault integration |
| A26 | Late error arrives after success; recovery lease collision | Success cannot downgrade; one recovery dispatcher | Race/fault integration |
| A27 | Original confirmation expired during recovery | Readback allowed; no new insertion dispatched | Recovery/domain |
| A28 | OAuth state replay/mismatch, refresh expiry/revocation | Denied/reconnect required; notes remain usable | OAuth contract + live |
| A29 | Own-event readback receives forged event/calendar ID | Browser input cannot select unrelated event or calendar | API/security |
| A30 | Reload/dashboard pagination/type/status filters | Own durable records and recoverable states; stable bounded results | API/browser |
| A31 | Browser microphone permission and direct STT stream | Audio goes directly to approved provider; temporary token only | Network + actual browser |
| A32 | Interim/final segments, stop/cancel/disconnection | Finals deduplicate, stop flushes, cancel does not submit, text preserved | Browser/provider |
| A33 | Master key/token/transcript logging and browser cache inspection | No secrets/content in logs, URLs, bundles or service-worker cache | Static/network review |
| A34 | Speech playback, muted mode, keyboard and mobile layout | Text always accessible, explicit replay/mute, no overflow, usable focus/actions | Browser/accessibility |
| A35 | Provider unavailable | Explicit failure/text fallback; never successful mock fallback in live mode | Provider/API |
| A36 | Usage missing or stream abandoned before capture | Unknown stays null; estimated quantities labeled; abandoned usage retained | Metering integration |
| A37 | Rate limit/restart | Durable worker/IP limit holds across instances; safe replay behavior | Repository/API |
| A38 | Retention with future/uncertain event, ordinary old content | Old content redacted while unresolved/future safety metadata preserved | PostgreSQL/operations |
| A39 | Backup restore and rollback | Restore rehearsed; external side effects reconciled; rollback never deletes events | Operations rehearsal |
| A40 | Controlled real booking and worker onboarding | Correct reviewed fields/calendar, workers can sign in/capture/resume | Live browser/owner |

## Optional iOS integration

| ID | Scenario | Required result |
| --- | --- | --- |
| I01 | Dictation and shared text | Review before sending; unsupported media rejected |
| I02 | Back Tap/Siri/home-screen, locked/unlocked device | Actual behavior documented; no unverified locked-phone guarantee |
| I03 | Revoked Shortcut token; attempt to confirm | Capture denied after revocation; capture token never authorizes booking |
| I04 | One-use handoff replay/expiry/wrong worker | Rejected; normal signed-in dashboard provides recovery |

## Release evidence and unresolved external gates

Local automated tests can establish domain behavior, repository semantics and simulated provider failure handling. They cannot establish live Groq extraction accuracy, Deepgram Safari codec behavior, Google scopes/consent, hosted Supabase configuration or actual microphone permissions. Record each of these as pending until exercised with configured accounts/devices.

Evaluate the original proposed performance targets only with real providers: at least 30 representative turns where practical, p95 agent turn at most five seconds and resolved booking at most eight seconds; report errors/uncertain outcomes and sample size. Field accuracy and capture success need user-reviewed realistic scenarios. These targets are proposed pilot criteria, not claims based on mocks.

Release requires all applicable browser safety/isolation/recovery checks, provider/data configuration, usable deployment and controlled owner-approved booking. Optional iOS tests and general external calendar synchronization are outside the browser MVP release gate.

## User allowances and HQ

- Complete three user flows using Confirm/Complete/cancellation: each consumes exactly one action regardless of follow-up count; further capture, text and voice attempts fail server-side.
- Leave a flow idle for more than three minutes: quota polling expires it once; returning or late provider results cannot revive it. Other active flows remain valid.
- With two used actions and one active flow, follow-ups and its final confirmation still work; opening a fourth flow fails.
- Exhausted users can browse their dashboard; write controls remain disabled. Administrators can continue using the assistant without this allowance or authenticated user burst limits.
- HQ displays per-user counts live, permits permission changes, and resets only the selected user to three available slots. Non-administrators cannot read HQ or reset anyone.
- During appointment follow-ups say “cancel it”: receive a brief cancellation, no repeated missing-field question, no event write, one action consumed. A note containing “cancel it” must remain a note.
- An uncertain booking confirmed as the third action can still be checked; accepted confirmation replay creates neither a second event nor an additional quota charge.
