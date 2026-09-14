# Campaign workspace user stories

Each story has a visible path in the dashboard and a deterministic verification path. No operational state is hidden behind a generic success message.

## 1. See what needs attention

**As an operator, I want the Overview to tell me what is blocked, queued, or waiting so I can act without guessing.**

- UI path: `Overview` → metric cards → `Needs attention` table → `Open draft` or `Open queue`.
- API path: `GET /api/overview`.
- Confirm: queue totals, next scheduled message, warning reason, and next action agree with the underlying message state.

## 2. Import and assign an audience

**As an operator, I want to add leads once and assign them to a campaign without creating duplicates.**

- UI path: `Add lead` → paste CSV/TSV or mixed text → save → `Overview` → select leads → `Assign`.
- API path: `POST /api/leads`, `POST /api/campaigns/:id/leads`.
- Confirm: the lead table shows the segment, status, source, and campaign assignment.

## 3. Generate and approve safe drafts

**As an operator, I want relevant drafts with a clear next step and a visible quality decision.**

- UI path: `Drafts` → filter by segment/date → `Select visible` → `Regenerate visible` or `Review and approve`.
- API path: `POST /api/leads/:id/draft`, `PATCH /api/messages/:id`, `POST /api/messages/:id/approve`.
- Confirm: preview, offer, CTA, quality status, warnings, and next-step plan are shown before queueing.

## 4. Control the queue

**As an operator, I want to know exactly when an email will go and be able to cancel or move it.**

- UI path: `Queue` → filter status/company → `Select visible` → `Cancel selected`; or `Reschedule` on one row.
- API path: `POST /api/messages/:id/cancel`, `POST /api/messages/:id/reschedule`.
- Confirm: cancelled rows leave the send queue and show `Cancelled by operator`; rescheduled rows show the new time.

## 5. Recover delivery failures safely

**As an operator, I want a provider error to explain the next action rather than showing an opaque internal error.**

- UI path: `Queue` → `Failed` or `Unknown outcome` → expand `Provider detail` → `Retry`.
- API path: `POST /api/messages/:id/retry`.
- Confirm: invalid recipients are suppressed; sender/provider failures point to verification or message repair; unknown outcomes require confirmation.

## 6. Reconcile sent mail and replies

**As an operator, I want sent history and human-approved reply actions to be separate from drafts.**

- UI path: `Sent` → inspect immutable sent body; `Replies` → classify → `Draft reply`, `Suppress`, or stage action.
- API path: `GET /api/messages?status=sent`, `GET /api/replies`.
- Confirm: a sent message never returns to Drafts and suggested replies are never auto-sent.

## 7. Change settings without breaking approved work

**As an operator, I want sender profiles, footer, and wording to be reusable while approved drafts remain sendable.**

- UI path: `Settings` → edit sender profile/footer → inspect sandboxed preview; `Campaigns` → verify selected profile.
- API path: `GET/POST /api/admin/outreach/settings`, `GET/POST/PATCH /api/sender-profiles`.
- Confirm: new drafts use the new profile, while an already-sendable draft retains its saved sender, footer, CTA, and quality snapshot.
