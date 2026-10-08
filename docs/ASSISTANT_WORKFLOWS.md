# Personal assistant and assignments

Nova supports four actions: draft appointments, draft notes, assign tasks, and summarize the user's agenda. The Groq adapter receives the current merged draft, the eight most recent conversation turns (bounded per turn), active stable user codes, the current worker code and the persisted input timestamp. It returns validated facts; application code controls questions, permissions, summaries and writes.

## Confirmation and corrections

- Appointments retain availability checks, immutable proposals, expiry, explicit confirmation and uncertain-write recovery.
- Notes and tasks now present editable drafts and require a confirmation tap before saving. Successful confirmation closes the conversation; later messages and edits require a new chat.
- Corrections invalidate the previous draft/version. Stale confirmations fail, and replaying the same accepted confirmation cannot create duplicates.
- Note headings and complete note text are separate, preserving up to 8,000 characters of canonical text after corrections.
- Unrelated questions preserve unconfirmed facts and do not execute an action. Saved calendar events still cannot be moved, edited or deleted.
- The visible new-chat icon asks before clearing the current chat. Leaving a draft does not create an appointment or task.

## Assignments and ordering

Tasks default to self; another assignee must be an active worker in the same workspace with task access. Stable codes identify recipients, and names are temporary aliases. Assignment and permissions are checked again at confirmation. A date without a time means 23:59 UAE time; deadlines are optional. Assignment changes are audited.

The Tasks section retains the shared pilot overview. Assignments shows tasks assigned to or created by the signed-in user; administrators can view all. Unfinished tasks sort by earliest deadline, then tasks without deadlines, then completed tasks. My activity combines relevant tasks, appointments, notes and requests: scheduled work appears first, followed by undated work, drafts and historical items. Pagination preserves its time anchor and ordering.

## Grounded agenda answers

Supported queries include “what's next”, “today's appointments”, “today's tasks”, “my tasks”, and the combined “today” agenda. Personal tasks mean unfinished tasks assigned to the signed-in worker. Appointments come from the shared internal calendar and connected calendars. Queries enforce current task/calendar permissions and never ask the model to invent schedule entries.

Today uses midnight-to-midnight in Asia/Dubai. Upcoming calendar summaries cover the next 90 days and label that range. My tasks includes deadlines beyond that range. Results display up to ten items (one for what's next) with a dashboard link hint when more exist. Overdue tasks are explicitly described as overdue. Connected-calendar failures prevent a falsely complete summary.

## Mobile controls

The microphone is the wide primary control. A keyboard icon slides the composer into the primary position; the smaller microphone icon switches back. Switching preserves unsent text and never unmounts an active recording. Recording prevents a mode change. Reduced-motion preferences disable transitions. Only the conversation pane scrolls, and confirmation cards expand for additional details.

## Deployment and validation

Migrations 007 and 008 add assignments and assistant conversation states. The existing Vercel build command applies migrations before building; no additional environment variables are required. Local tests use simulated providers. Live Groq quality and external-calendar accuracy require provider access and pilot acceptance testing; the current environment's Groq probe returned PROVIDER_UNREACHABLE.

Validated on 8 October 2026: 71 unit tests, 44 database tests, 13 browser scenarios, and the production build. Layout checks at 320, 390 and 1440 pixels found no page overflow. Browser tests cover corrections, assignment, agenda cards, confirmations, mode switching, draft preservation, new-chat approval, recording failures and permission isolation.
