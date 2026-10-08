# Vercel deployment

The user authorized deploying to Vercel and activating Supabase, Groq and Deepgram. The requested pilot name/user-selector and MMYYYY administrator login remains enabled; Supabase supplies the persistent database while this login uses signed application cookies.

## Cloud environment access

Open the selected cloud environment's configuration in Codex and locate network/internet access. Preserve current package-manager rules. Allow HTTPS to api.vercel.com, vercel.com, auth.vercel.com, oqlqeexbbzmojnuyxkzi.supabase.co, api.groq.com and api.deepgram.com. The deployed application's actual hostname must also be allowed for verification; *.vercel.app covers default deployments where wildcard rules are supported. cdn.playwright.dev is needed only to download a Playwright browser. Save/apply configuration; restart if the configuration workflow requests it. Editing /etc/codex/network-policy.json does not grant access.

This environment currently blocks those services. Vercel CLI is installed but logged out; its login attempt failed on network access. Store VERCEL_TOKEN through secure environment settings, or complete vercel login after allowing Vercel access. Set VERCEL_TEAM_SLUG and VERCEL_PROJECT_NAME if deploying into a specific team/existing project; the default new project name is nova-agent.

## Database connection

The supplied remote Supabase connection is held separately from the local development database. VERCEL_DATABASE_URL may override it with the Supabase session pooler connection copied from Connect in the Supabase dashboard. Use the session pooler if the direct IPv6 database hostname cannot be reached by the build/functions. Preserve certificate verification; provide an appropriate trusted CA if required, rather than disabling TLS checks.

Migrations and pilot initialization run in the Vercel build environment, which avoids this cloud workspace's public PostgreSQL TCP restriction. Initialization is idempotent: it keeps disabled users, revoked permissions, pending internal bookings and the existing calendar configuration version. Database migrations are additive and run under an advisory lock. A failed deployment does not roll back already committed schema migrations.

## Configure and deploy

```sh
npm run vercel:configure
vercel deploy --prod --yes
```

The configuration script validates the remote database and required secrets, links the selected project and sends production variables to Vercel through stdin, stored as sensitive values. It does not put values in command arguments or print them. .vercelignore excludes local environment files, artifacts, tests, backups, build output and Git metadata from upload. .vercel linkage files are gitignored.

Vercel runs npm run build:vercel: database migrations, pilot initialization, then Next.js production build. Production uses APP_MODE=live, LANGUAGE_PROVIDER=groq and SPEECH_PROVIDER=deepgram. The application origin defaults to VERCEL_PROJECT_PRODUCTION_URL (enable Vercel's automatic system environment variables). Set VERCEL_APP_ORIGIN before configuration for an explicit custom production domain. Preview environments require separate database/provider configuration; this script configures production only.

The script uses the existing server encryption/setup/signing secrets and supplied provider settings. SUPABASE_SERVICE_ROLE_KEY is not required for the current selector login/database model; invite-based Supabase Auth is a separate optional flow.

## Verification after deployment

Verify the canonical production domain, HTTPS, worker/admin login, persistent tasks/events and audit visibility, permission revocation, Groq fact extraction, a Deepgram temporary token and real browser microphone capture. Verify all state survives a redeployment and that no local PostgreSQL address is used. External calendar integrations still require their own OAuth clients or CalDAV app passwords.

Current status: deployment files and CLI are prepared; no Vercel project was linked, no production credentials uploaded, no remote Supabase migrations applied, and no deployment created while authentication/network access remain unavailable.
