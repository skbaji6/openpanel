# Marketing platform, phases 3 to 5: design

Status: draft for the owner's approval. Builds on `2026-10-28-marketing-platform-design.md` (sections 5 to 7), which this document replaces for phases 3 to 5. Nothing here is built.

## Purpose

Phases 1 and 2 ship the engine and the campaign dashboard. These phases make the platform useful day to day for the ed-tech team: the 11 behaviour-triggered push journeys from the owner's workbook, proof of what happened to each message, and a proper email editor. Student contact data is still never copied: the marketing workers read it through the audience API of `sia-backend`.

## Decisions the owner made

| Topic | Decision |
|---|---|
| Journey triggers | The app's events already reach OpenPanel, and the event profile id is the same student id the audience API returns. Journeys trigger on existing events; no id mapping is built. |
| Journey authoring | Journeys are importable (workbook or CSV) and creatable in the dashboard. Import produces drafts to review, never live journeys. |
| Regional wording | Every journey step has one message per state (workbook tabs TS and AP), chosen by the student's `state` trait. A step with no variant for the student's state falls back to a default variant; with no default the step is skipped with a visible reason. |
| Journey caps | No frequency caps for journeys. Quiet hours still apply. Per-campaign caps are unchanged. |
| Channels | Push (FCM), WhatsApp and SMS (MSG91) first. Email is built last and tested against a fake SMTP server; its provider setup is the owner's later task. |
| Statuses | sent, delivered, failed, skipped, uncertain, read, clicked, converted. |
| Click tracking | Redirects through `campaign.sianext.com`; the public URL and the campaign URL are configurable in the dashboard, each with an explanation. |
| Conversion | A student opening the app within a configurable number of days after the message. The number of days is configurable. |
| Delivery reports | MSG91 delivery webhook, configured by the owner on the provider side. |
| Opt-out | Out of scope for now. |
| A/B tests | Parked; not in these phases. |

## Phase 3: journeys from the workbook, templates and email editor

- **Journey import.** An importer reads the workbook sheets (or an equivalent CSV) and creates draft journeys: trigger event, wait, goal event, message variants per state. It reports every row it could not map. Re-importing updates drafts by journey key and never touches a live journey.
- **Journey editor in the dashboard.** The Journeys tab gains create and edit: trigger, wait, goal, steps and the per-state message variants, with the same preview and test send as campaigns. Starting a journey is admin-only and shows what it will react to.
- **Templates with versions.** Message templates become named and versioned; a campaign or journey step pins a version at start. The Start confirmation already names the template and version.
- **Email editor (last step of this phase).** A block-based editor that produces safe HTML through the existing strict renderer, with an automatic plain-text alternative and image limits. Delivery is tested only against fake SMTP.

## Phase 4: tracking and reports

- **Delivery events.** MSG91 webhook updates message status to delivered or failed; push reports what FCM returns; every status above is stored per message, ids only.
- **Links.** Message links are rewritten to signed redirects on the campaign URL; a click records `clicked` and sends the student on. The signing key is per project; tokens expire.
- **Read.** Push and WhatsApp read signals where the provider gives them; email open pixel is a later option.
- **Conversion.** A `converted` record is written when the student's app-open event arrives within the configured window after a message; attribution is last message wins.
- **Reports.** Per-campaign and per-journey views: counts per status over time, per-state breakdown for journeys, and a funnel from sent to converted. Engagement rows hold ids and counters only; high-volume storage can move to ClickHouse behind a small write interface later.
- **Privacy.** No phone, email, token or trait value is stored in tracking data, logs or the dashboard.

## Phase 5: not in scope

A/B tests and branching journeys stay parked. Journeys remain linear: trigger, waits, steps, goal.

## Non-goals

- Copying student data into the marketing database.
- Opt-out and consent management (revisit before the first production send).
- Replacing the admin Notification feature of `sia-backend`.
- Journey caps and A/B tests.

## Left to the builder

Workbook parsing details, the importer's error report format, the signed-token format, how the dashboard shows per-state variants, and the report layout, within the privacy rule above.

## Verification

Each phase has its own plan. Import is tested with the owner's workbook; tracking is tested end to end against fake MSG91 and a fake link target; the dashboard gets a browser pass as owner, member and outsider. These phases do not start until the owner approves this document.
