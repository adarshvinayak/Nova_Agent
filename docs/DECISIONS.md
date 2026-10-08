# Accepted implementation decisions — 7 October 2026

- Browser app is the primary product and must work without iOS Shortcuts. Shortcut integration is an optional extra and not a browser MVP release blocker.
- Two workers, English, one shared Google Calendar; only an explicit confirmation tap can authorize creation. No rescheduling or cancellation.
- Appointments use `Asia/Dubai` (UAE). Thirty-minute duration is a suggestion requiring acceptance, never a silent default; location or explicit Not applicable is required.
- Calendar recovery may read back an event using only an event ID derived from a persisted app booking attempt. Unrelated event details, arbitrary event lookup, list, update and delete remain excluded.
- The destination is an existing calendar with other writers. Fresh conflict checks are required, but external writes cannot be made atomic with this app's insertion.
- Local development and tests may use simulated providers while the user prepares live access and a Google test account/calendar.
- No mandatory data region. No application audio storage; 30-day text and 90-day operational retention, preserving future/unresolved booking metadata as necessary.
- The user will provide Google configuration/credentials securely. Worker identities, live provider credentials, account owner participation and hosting access remain integration/release dependencies rather than blockers to local work.

These decisions supersede conflicting design-pack assumptions, including the prior blanket prohibition on calendar `get`, the assumption that iOS was the primary entry route, and the requirement that optional Shortcut device testing block the browser MVP.

## Dashboard revision — 8 October 2026

The user replaced Google as the mandatory destination with a built-in calendar, requested separate tasks/calendar/audit/settings, and approved open section permissions by default plus admin controls. User1/user2 codes are stable; names are temporary aliases. Pilot administrator login uses name and current UAE MMYYYY code. Individual users view their own audit logs; admins view all. External Google/Outlook/iCloud/Fastmail calendars use their supported authentication mechanisms and import read-only events. Credentials supplied by the user are held only in the ignored local environment file. Actual provider connectivity remains a release gate.
