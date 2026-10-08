# Database foundation

Run `npm run db:migrate -- --local-bootstrap` for the first local database. Omit `--local-bootstrap` on Supabase, where roles already exist. The runner applies each migration once; it never resets or truncates application data. The connection must own the schema and be able to install `pgcrypto` and `btree_gist`.

Runtime writes use server-only PostgreSQL transactions. A verified JWT subject maps to `va_workers.id`; never trust owner IDs supplied by a request. Read isolation uses `request.jwt.claim.sub` as an explicitly transaction-local setting when switching to `authenticated`. With pooled connections use `SET LOCAL` / `set_config(..., true)` inside a transaction, never a session-global claim. Supabase REST integration must supply that claim or use verified server reads. `service_role` bypasses RLS; every write routine must enforce identity and active membership independently.

## Contract

- Workspace: `va_workspaces(id,name,time_zone,config_version)`; defaults `Asia/Dubai`.
- Workers: `va_workers(id,workspace_id,email,display_name,active)`; UUID auth subjects, no local dependency on `auth.users`.
- Sessions: `va_sessions(id,workspace_id,worker_id,state,version,facts,created_at,updated_at,content_redacted_at)`.
- Turns: `va_turns(id,workspace_id,worker_id,session_id,turn_no,speaker,body,source,client_turn_id,created_at,content_redacted_at)`.
- Proposals: `va_proposals(id,workspace_id,worker_id,session_id,version,session_version,config_version,calendar_id,snapshot,snapshot_hash,starts_at,ends_at,time_zone,checked_at,expires_at,status,created_at,content_redacted_at)`.
- Attempts: `va_attempts(id,workspace_id,worker_id,session_id,proposal_id,idempotency_key,intent_hash,calendar_id,event_id,starts_at,ends_at,time_zone,status,confirmed_at,dispatch_at,resolved_at,recovery_token,recovery_generation,recovery_lease_until,error_code,created_at,updated_at)`.
- Records: `va_records(id,workspace_id,worker_id,session_id,kind,title,body,location,starts_at,ends_at,time_zone,booking_attempt_id,outcome,created_at,content_redacted_at)`.
- Request ledger: `va_idempotency(workspace_id,worker_id,operation,idempotency_key,payload_hash,status,response,resource_id,created_at,updated_at)`. Compare hash on conflicts. `response` may contain content and must be redacted with the content retention window; retain the key/hash/resource reference.
- Speech: `va_speech_sessions` exists before any capture to meter abandoned streams. `va_usage_events` supports optional owned `session_id` and `speech_session_id`.
- Secrets/operations: `private.va_calendar_connections`, `private.va_credentials`, `private.va_rate_limits`, `private.va_operation_events`. Never expose the private schema through REST.

## Required transactional behavior

Lock session before proposal, and compare session/config version before confirmation. Invalidate the prior ready proposal before creating another. Reserve before calling external services; commit before network IO. Exclude the current attempt from subsequent local conflict queries. Complete by updating attempt to `succeeded`, then inserting its record, then updating session, in one transaction.

An attempt begins `reserved`, transitions to `writing`, then `succeeded`, `unknown` or `failed`. `reserved` may also become `blocked` or `failed`. `unknown` may become `succeeded` or `failed` only following verification. Terminal status cannot be reversed. Recovery remains in `unknown`: claim a fresh UUID `recovery_token`, increment `recovery_generation`, set `recovery_lease_until` atomically, and compare token/generation on every outcome update. Original dispatch timestamp cannot change. A failed retry does not establish that an earlier ambiguous dispatch failed; keep it unknown until own-event readback verifies the outcome. Do not release uncertainty automatically.

Database guards enforce immutable proposal/attempt identity, same-owner links, deterministic event IDs (`vc` + attempt UUID without hyphens), active slot exclusion, one active attempt, and event-record success evidence. Application code must additionally validate snapshot field contents against normalized columns, canonical hash, expiry, allowed state transitions for sessions, calendar selection, authenticated intent, and recovery evidence. The database does not pretend to make external Google writes transactional.

## Tests

`TEST_DATABASE_URL` must reference a disposable database whose name contains `test`. `tests/db/foundation.test.ts` resets only that dedicated database's public/private schemas, bootstraps local roles, applies migrations, and checks ownership, RLS, immutable binding, overlapping concurrent transactions, and terminal-state protection. Do not point it at the development or production database.
