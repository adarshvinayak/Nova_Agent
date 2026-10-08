# Operations and release gates

## Current scope

Implemented: browser capture, reviewed speech integration, conversation and manual edits, immutable confirmation cards, duplicate-safe booking with uncertain-outcome readback, worker-isolated activity, note saving, invitation/password setup, Google OAuth connection setup, database migrations and operational scripts. iOS Shortcuts remain an optional later feature.

On 8 October 2026 the owner reported Supabase, Deepgram, Groq and hosting accounts ready; Google OAuth and the test calendar remain in preparation. The owner will connect Google and sign off acceptance. Account readiness does not mean credentials have been injected or integrations verified. This task environment currently reports no injected secrets and restricts outbound access to package-manager hosts.

Configure the names in `.env.example` through secure environment settings. Permit outbound access to the actual Supabase project/auth and database hosts, `api.groq.com`, `api.deepgram.com`, `oauth2.googleapis.com`, and `www.googleapis.com`. Account-holder OAuth uses `accounts.google.com`; browser streaming uses Deepgram WSS. Allow `cdn.playwright.dev` only if downloading the Playwright browser is needed. Do not put credentials in chat or source control.

## Live onboarding

1. Configure a staging database and apply migrations; do not run demo seed against it. Set `APP_MODE=live`, HTTPS `APP_ORIGIN`, provider credentials and independent server secrets.
2. Configure Supabase email delivery and allow `APP_ORIGIN/auth/accept` as an invitation redirect. Run `npx tsx scripts/provision-worker.ts email@example.com "Worker Name"` once per worker. The invite page removes URL credentials and sets a password only after user submission.
3. Configure Google web OAuth with the exact `GOOGLE_REDIRECT_URI`, shared-calendar access, and test users. Run `npx tsx scripts/connect-google.ts WORKSPACE_UUID`; the owner opens the one-use authorization URL.
4. Verify all live gates in SETUP.md and ACCEPTANCE.md, including actual microphone/codecs, Google refresh/recovery, SMTP and disabled-account behavior. No deployment or live booking has been verified by local tests.

## Retention and usage

`npm run ops:retention` performs a transactionally rolled-back dry run. Inspect its counts, then schedule `npm run ops:retention -- --apply` daily using the hosting provider's secured scheduler. Text is redacted after 30 days of session inactivity. Operational logs, usage and terminal speech records expire after 90 days. Pending/uncertain bookings retain exact recovery data; future booking intervals, event identities and idempotency tombstones remain available. The app does not delete Google events. Review unresolved reservations with the calendar owner rather than clearing them speculatively.

`npm run ops:usage -- 30` reports quantities and unknown-cost counts. Unknown provider cost is not zero; configure provider billing alerts and reconcile with billed usage before making a cost-per-capture claim. Browser-reported audio duration is an estimate.

## Backup, restore and revocation

Enable encrypted managed Postgres backups/PITR and record the retention window. Store encryption-key backups separately with restricted access. Before release, restore a backup into an isolated staging database, use separate providers/test calendar, verify migration state and worker isolation, and reconcile pending event IDs before enabling writes. Never point a restored clone at the live calendar while the original is active.

To revoke a worker, an authorized database operator sets `va_workers.active=false` for the exact worker UUID and revokes Supabase sessions. Application mutations recheck active status. To revoke Google access, disable the workspace connection and revoke the application grant in the Google account; reconnect through the owner flow. Preserve pending attempt records. Rotating `TOKEN_ENCRYPTION_KEY` requires decrypting and re-encrypting existing credentials with an explicitly reviewed migration; replacing the environment value alone will break token access.

## Remaining release blockers

- Securely inject ready service credentials and configure provider network access.
- Complete Google OAuth and the test calendar.
- Verify real provider APIs, email onboarding, streaming audio and device behavior.
- Deploy to the selected host, schedule retention, verify backups/restore and obtain the owner's pilot sign-off.

## Current runtime revision

The user requested pilot selector/month-code login and a built-in calendar. Set PILOT_LOGIN=true and run npx tsx scripts/pilot-setup.ts after migrations; administrator code uses current UAE MMYYYY. Provider override flags LANGUAGE_PROVIDER=groq and SPEECH_PROVIDER=deepgram activate supplied accounts independently of local mode. Supabase credentials are saved but its remote database has not been migrated because connectivity is unavailable. Current runtime uses local PostgreSQL. See VERIFICATION.md for actual checks and CALENDAR_CONNECTORS.md for external-calendar setup. All module permissions start enabled; administrators manage each permanent user code's access. The prior invite-based identity/mandatory Google destination applies only when intentionally returning to that earlier deployment model.
