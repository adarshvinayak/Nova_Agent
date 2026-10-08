# Provider access and integration contracts

Official documentation reviewed 7 October 2026. No account access, real keys, microphone sessions or external calendar mutations were performed by this documentation review. Account-specific permissions, pricing and behavior still require live verification.

## Secure handoff

Account owners configure secrets in `.env.local` or the hosting secret manager, then share only readiness and public identifiers. Do not send API keys in chat. Generate application secrets locally. Google refresh tokens come from the owner's OAuth flow and are encrypted in the private database; do not ask anyone to copy a refresh token manually.

## Supabase

Create separate staging/production projects in approved regions. Supply the project URL, publishable key, server service credential and PostgreSQL connection through the configured environment. Apply migrations before enabling worker access; do not expose private operational schemas through the Data API. Disable public signup and provision the two approved identities. Set Auth Site URL to `APP_ORIGIN` and allow only the implemented callback URLs for each environment. Use server-verified identity and current active-worker records, not a user ID supplied by a browser.

If email invitations, OTP, magic links or password recovery are used, configure a custom SMTP provider, sender/domain and credentials in Supabase. The default sender is restricted to organization team addresses and is unsuitable as the worker delivery assumption. Check inbox delivery, spam placement and expired-link behavior. Do not add workers as infrastructure administrators merely to bypass this restriction. See [custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp) and [Auth configuration](https://supabase.com/docs/guides/auth/general-configuration).

## Google Calendar

Enable Calendar API in the owner-controlled Google Cloud project. Configure OAuth consent audience and a Web application client. Add the exact `GOOGLE_REDIRECT_URI`, including scheme/path/port; a deployment hostname change requires updating it. For external Testing, add the actual authorizing account to test users. The account needs write access to the configured destination. Use a dedicated test calendar during verification, even though production uses the existing shared calendar.

For the shared-calendar case request `https://www.googleapis.com/auth/calendar.events` plus `https://www.googleapis.com/auth/calendar.events.freebusy`. If the authorizing account actually owns the destination, the event scope can instead be `https://www.googleapis.com/auth/calendar.events.owned`. These grants are broader than application policy; there is no insert-only scope. `calendar.app.created` is unsuitable for the existing calendar. See [scope definitions](https://developers.google.com/workspace/calendar/api/auth).

Use server-side authorization-code exchange, state, one-use owner setup authorization, exact redirect validation and offline access. Retain an existing refresh token if a refresh response omits one. Handle `invalid_grant` as reconnect-required. External Testing with Calendar scopes can yield refresh tokens that expire after seven days; production verification is a separate externally controlled process. See [OAuth web server flow](https://developers.google.com/identity/protocols/oauth2/web-server) and [token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

**Recommended adapter:** `queryBusy(range)`, `insertEvent(persistedAttempt)` and `getOwnEvent(persistedAttempt)`. Calendar selection is trusted configuration. Readback must first load an owned application attempt and its deterministic event ID; never accept an arbitrary caller-provided ID. Compare ID, status and material frozen fields before resolving an uncertain attempt. A mismatch/cancellation remains a reconciliation issue; a temporary 404 cannot alone prove an outstanding insert will never arrive. No event-list, patch, update or delete method. [Insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert), [get](https://developers.google.com/workspace/calendar/api/v3/reference/events/get) and [free/busy](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query) document the corresponding operations.

## Deepgram

Create a funded project and server API key with at least Member permissions. Use `POST https://api.deepgram.com/v1/auth/grant`, header `Authorization: Token <server-key>`, JSON `{ "ttl_seconds": 60 }`. Parse `access_token` and `expires_in`; issue tokens only to authenticated active workers under durable limits. Tokens grant broad `usage::write` access to core voice APIs, not a per-worker/STT-only capability. Expiry limits the initial connection, not an existing socket's lifetime. See [temporary-token authentication](https://developers.deepgram.com/guides/fundamentals/token-based-authentication).

**Recommended response contract:** `{ accessToken, expiresInSeconds, webSocketUrl, maxDurationSeconds: 120 }`, with `Cache-Control: no-store`. Connect immediately using native `new WebSocket(webSocketUrl, ['bearer', accessToken])`; no credential in the URL. The official [JavaScript SDK browser transport](https://github.com/deepgram/deepgram-js-sdk/blob/main/src/CustomClient.ts) implements this bearer subprotocol distinction. Never expose the permanent key or use the API-key `token` scheme for the temporary JWT.

Configure the URL with `model=nova-3`, `language=en`, `interim_results=true`, `smart_format=true` and `mip_opt_out=true`. Handle `Results`, `Metadata`, errors and socket closure; collect final segments without duplication. After the recorder emits its final chunk, request finalization and allow bounded final-message drain before cleanup. Completed voice messages send when the worker taps Stop. Interrupted streams preserve final text in the chat draft and require manual submission. Booking always requires a separate confirmation tap. See [Listen streaming protocol](https://developers.deepgram.com/reference/speech-to-text/listen-streaming).

If Deepgram returns HTTP 403 for temporary-token grants, the application offers a server-side prerecorded transcription fallback. The browser uploads audio to the authenticated `/api/speech/transcribe` route; the server holds the permanent key. Audio is processed in memory only. The route enforces ownership, one-use session claims, origin, format, rate, 4 MB audio size and 120-second limits. The 4 MB cap leaves room below Vercel’s 4.5 MB request limit.

Select a supported `MediaRecorder` MIME type at runtime. Containerized WebM/MP4 audio must omit both `encoding` and `sample_rate`; raw PCM requires an explicit encoding and actual sample rate. Test Safari's actual stream, not just MIME support detection. An AudioWorklet PCM fallback needs conversion/resampling consistent with its declared rate. See [encoding](https://developers.deepgram.com/docs/encoding/) and [sample rate](https://developers.deepgram.com/docs/sample-rate/).

Verify account data handling and opt-out pricing before real audio. The application sends the opt-out parameter, but a browser-held token does not enforce model, privacy parameters or two-minute duration against a modified client. Apply account budgets, token-issuance limits and monitoring; do not describe these tokens as strictly STT-only or claim the client timer is a provider-enforced spending cap. Provider retention is separate from application audio non-storage.

## Groq

Configure `GROQ_API_KEY` server-side and start with `GROQ_MODEL=openai/gpt-oss-20b`. Send non-streaming requests to `https://api.groq.com/openai/v1/chat/completions` with Bearer authorization, bounded context and `response_format.type=json_schema`, `json_schema.strict=true`. Every object is closed with `additionalProperties:false`; all properties are required, with `null` representing missing facts. No tools are sent. Validate the returned data again and handle refusal, truncation, empty choices, rate limits and deadlines. Strict JSON shape does not prove date/fact accuracy. See [structured outputs](https://console.groq.com/docs/structured-outputs).

**Recommended adapter:** `extract({ latestText, priorFacts, recentTurns, capturedAt, timeZone }) -> { facts, suggestedReply, usage }`. Facts preserve missing/ambiguous fields; deterministic application rules own dates, conflict truth, proposals and booking. Keep credentials, foreign-worker text and raw audio out of the prompt. A one-attempt bounded repair may be used for invalid output; otherwise retain text and offer deterministic/manual correction. Confirm actual model availability and account quotas using [supported models](https://console.groq.com/docs/models). Review effective account settings and exceptions in [Groq data controls](https://console.groq.com/docs/your-data) before live text.

## Hosting and verification evidence

Configure an eligible commercial Vercel plan or an agreed alternative. [Vercel Hobby](https://vercel.com/docs/plans/hobby) is restricted to personal non-commercial use. Use Node server execution and bounded HTTP deadlines; direct browser audio avoids requiring a persistent server WebSocket. Staging must not inherit production OAuth/provider secrets. Never use a deployment platform's ephemeral filesystem as durable booking storage.

For every live gate record date, environment, account owner, model/API configuration, test scenario and result, with identifiers redacted where needed. Keep mocked contract tests and genuine provider/device tests separately labeled. The release checklist is in [Setup](SETUP.md).
