# Calendar connections

The dashboard calendar is the primary booking calendar. Connected third-party calendars provide **read-only event imports**. Creating an internal appointment does not export it to external calendars, and imported events participate in internal availability checks; a connected calendar outage or truncated response blocks booking safely. The UI should label imports and expose connection failures. Do not claim two-way sync.

Settings includes Google Calendar, Microsoft Outlook, Apple iCloud and Fastmail. OAuth services require an application registration and account consent; an API key alone cannot authorize private calendar access.

## Google Calendar

Enable Google Calendar API and configure an OAuth web client. Add the exact redirect URI displayed by Settings: `APP_ORIGIN/api/connectors/google/callback`. Enter its client ID and client secret in Settings, optionally the calendar ID, then approve read-only calendar access. Test-mode OAuth applications must add the consenting account as a test user. A calendar ID supplied during setup must be visible to the consenting account.

## Microsoft Outlook

Register an application in Microsoft Entra supporting both organizational and personal Microsoft accounts. Add `APP_ORIGIN/api/connectors/outlook/callback` as a web redirect URI, create a client secret, and enable delegated `Calendars.Read` access. Enter the application client ID and secret, then authorize the account. Organizational policy may require administrator consent. The `common` endpoint is used; single-tenant-only applications are not supported by this connector.

## Apple iCloud and Fastmail

Use your account username and a provider-issued app-specific password, never a regular password. Apple requires two-factor authentication before issuing app-specific passwords. Use `https://caldav.icloud.com` or `https://caldav.fastmail.com`. Discovery follows the principal and calendar-home-set using PROPFIND. Event import uses REPORT with server-side recurrence expansion.

Only known HTTPS CalDAV hosts are accepted: `caldav.icloud.com`, its direct subdomains, Apple's `p<number>-caldav.icloud.com` shards, and `caldav.fastmail.com`. Redirects, arbitrary hosts, URL credentials, nonstandard ports and entity declarations are rejected. A discovery response cannot redirect authentication to an arbitrary server.

## Storage, limits and API

OAuth client secrets, refresh/access tokens and CalDAV app passwords are AES-GCM encrypted in private database tables. Secrets are never returned by status APIs or copied to audit logs. Disconnect erases stored credentials; revoke the grant/app password at the provider for account-side revocation. OAuth state is single-use and expires after ten minutes; reconnect requires active Settings permission. Access-token refresh preserves existing refresh tokens when the provider omits a replacement.

- `GET /api/connectors`: safe catalog and connection status; requires Settings access.
- `POST /api/connectors`: OAuth `{provider,clientId,clientSecret,calendarId?}` or CalDAV `{provider,username,password,serverUrl,calendarId?}`. Returns an authorization URL or validated calendar list.
- `DELETE /api/connectors`: `{provider}` disconnects the workspace connection.
- `GET /api/connectors/{provider}/events?start=ISO&end=ISO&calendarId=optional`: read-only imports; requires Calendar access. Date ranges are limited to 93 days; responses cap at 500 events and indicate truncation. The default is the selected calendar or first accessible calendar. Imported all-day Google events use UAE midnight. CalDAV entries missing an end time are omitted.

Connections belong to the shared workspace. All users have Settings access initially, as requested; administrators can revoke that access.

Required outbound hosts: `accounts.google.com`, `oauth2.googleapis.com`, `www.googleapis.com`, `login.microsoftonline.com`, `graph.microsoft.com`, the listed CalDAV hosts. Live connection verification requires real OAuth app registrations or CalDAV credentials and outbound network access. Automated tests use mocked provider responses and cannot establish account readiness.
