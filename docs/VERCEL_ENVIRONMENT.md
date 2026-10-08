# GitHub → Vercel production setup

Import `adarshvinayak/Nova_Agent`, select the `main` branch, Next.js framework and repository root. Keep the checked-in `vercel.json` build command: `npm run build:vercel`. The build applies Supabase migrations, initializes the stable pilot accounts/internal calendar and builds the app. Install command: `npm ci`. Use Node.js 24.x.

Set the following variables for **Production** before the first deployment. Store credentials and application secrets as sensitive environment variables.

| Variable | Production value |
| --- | --- |
| `APP_MODE` | `live` |
| `PILOT_LOGIN` | `true` |
| `LANGUAGE_PROVIDER` | `groq` |
| `SPEECH_PROVIDER` | `deepgram` |
| `DATABASE_URL` | Supabase session pooler PostgreSQL connection, port 5432, with URL-encoded password and `sslmode=verify-full` |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://oqlqeexbbzmojnuyxkzi.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase project publishable key |
| `GROQ_API_KEY` | Groq API key |
| `DEEPGRAM_API_KEY` | Deepgram API key with permission to issue temporary access tokens |
| `SESSION_SECRET` | Independent random 64-character hexadecimal secret |
| `TOKEN_ENCRYPTION_KEY` | Another independent random 64-character hexadecimal secret |
| `OWNER_SETUP_SECRET` | Another independent random 64-character hexadecimal secret |

Recommended explicit model configuration (the application has these defaults):

| Variable | Value |
| --- | --- |
| `GROQ_MODEL` | `openai/gpt-oss-20b` |
| `DEEPGRAM_MODEL` | `nova-3` |
| `DEEPGRAM_ENDPOINT` | `wss://api.deepgram.com/v1/listen` |

`APP_ORIGIN` is optional if Vercel exposes its automatic system variables: the app derives the production HTTPS origin from `VERCEL_PROJECT_PRODUCTION_URL`. For a custom domain, set `APP_ORIGIN=https://your-exact-domain` without a path, and redeploy. Use the canonical production domain for login and mutations. Do not set `APP_ORIGIN` to localhost.

Generate each of the three application secrets independently on your computer, for example run this command three times and paste the outputs directly into Vercel:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Get the session pooler connection from **Supabase → Connect**. Its username normally includes the project reference. Example template (replace the entire host/credentials from the dashboard):

```text
postgresql://postgres.oqlqeexbbzmojnuyxkzi:URL_ENCODED_PASSWORD@SESSION_POOLER_HOST:5432/postgres?sslmode=verify-full
```

Prefer the session pooler because Supabase's direct database hostname may require IPv6. The migration runner and app both use `DATABASE_URL`. Preserve certificate validation; if the database requires a supplied CA, configure that CA rather than turning TLS verification off.

Do not configure `TEST_DATABASE_URL`, local development database URLs, `VERCEL_TOKEN`, `VERCEL_DATABASE_URL`, or `SUPABASE_DATABASE_URL` in the app. The last two are inputs to the optional CLI configuration helper; GitHub imports use `DATABASE_URL` directly. `SUPABASE_SERVICE_ROLE_KEY` is only needed if you enable the separate Supabase invite-based login workflow. Google OAuth and Shortcut keys are not needed for the current built-in calendar/pilot selector login.

Preview deployments need separate credentials/database and a separately chosen origin; configure Production first. After deployment, verify login, persistent tasks/calendar, audit isolation, administrator permissions, actual Groq extraction and Deepgram microphone streaming. A successful build alone does not verify provider behavior.

## Troubleshooting `DATABASE_URL is required`

This error means the deployment's build did not receive a nonempty variable named exactly `DATABASE_URL`; it occurs before attempting any database connection. In Vercel, open the project → Settings → Environment Variables, add the session pooler connection string under that exact name, select **Production**, and save. Redeploy afterward: changing variables does not update existing deployments.

Check the failed deployment's environment. Production variables are not available to Preview deployments. Set the project's Production Branch to `main` and deploy that branch to Production, or supply a separate database configuration for Preview. `NEXT_PUBLIC_SUPABASE_URL`, a database password alone, `SUPABASE_DATABASE_URL`, and `VERCEL_DATABASE_URL` do not replace the runtime/build `DATABASE_URL` for GitHub imports.

The Node.js engine is pinned to `24.x`. The esbuild install-script notice is unrelated to this missing-variable failure.

Never replace `TOKEN_ENCRYPTION_KEY` after storing calendar connector credentials without a re-encryption migration. Pilot setup is idempotent and preserves revoked permissions, disabled users and pending internal bookings across redeployments.

### Function placement and latency

The Supabase region was confirmed as `ap-northeast1` (Tokyo). `vercel.json` now places functions in `hnd1` (Tokyo). Deploy the new commit to apply placement. No additional environment variable is required. Conversation reads use one SQL snapshot, authorization and audit identity share a query, independent availability reads run concurrently, and idle database connections remain available for 60 seconds. Initial pilot authentication is included in the page response; login uses its returned actor and dashboard code loads separately.

API responses include a `Server-Timing: app;dur=...` header for application time. This excludes Vercel startup, network transit and browser rendering; it is a diagnostic aid, not an end-to-end latency guarantee. Live timing requests to `novaassist-six.vercel.app` were blocked by the execution environment proxy before reaching Vercel. Recheck the deployed site and microphone on a real phone after deployment. Live captions require a Deepgram key that can mint temporary browser tokens; upload fallback works with transcription-only keys but returns text after recording.
