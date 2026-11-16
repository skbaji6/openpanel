# Cut-over: backend journeys to marketing plugin journeys

The owner's backend (`sia-backend`) has a hard-coded journey service, `NotificationJourneyService` (`service/NotificationJourneyService.java`). It reacts to app events posted to `POST /api/v1/events`, and writes push notifications into a queue (`push_queue`) with a `journeyKey`, a daily cap of 2 and a weekly cap of 10 per user. This page is the plan for replacing it with plugin journeys, with the same events and the same wording, and for switching the old one off without sending anything twice.

## Read this first: opt-out is not handled

**Opt-out handling is deferred.** The plugin sends to everyone in an audience that the audience API returns as contactable (`ok`). The contract reserves `suppressed` and an `opted_out` style reason, and the plugin records and skips them, but `sia-backend` has no server-side opt-out field today (students opt out in the mobile app), and the plugin does not read the `consent` object in `lookup` yet. A student who turned notifications off in the app and who still has an active device token is messaged by the plugin as by the old service (the push itself is subject to the OS setting). Before go-live decide, with the owner, how those students are excluded: for example map them to `suppressed` in the audience API once a field exists. Do not flip the flag until this is a conscious decision.

Also true at cut-over: the plugin's frequency cap does not see the backend's own sends, and the old daily and weekly caps (2 and 10) are not copied automatically (see "Caps").

## What the backend covers today

Events arrive as `eventType` plus a `userId` and a `metadata` map. For each, the service schedules a push (`title` `SIA`) at a delay, after the cap check. Cancellations are the calls to `cancelPendingByUserAndJourney`.

| Backend event | Journey key | Delay | Message (summary: copy the exact wording, emojis included, from the backend code) | Cancelled by |
|---|---|---|---|---|
| `USER_LOGGED_IN` | `LOGIN_WELCOME` | now | Welcome, complete your setup and get access to free PYQs & LMR for your semester | (a comment says "cancel if course selected within 10 minutes"; the code does not) |
| `INVALID_OTP` | `INVALID_OTP_REMINDER` | 1 minute | Trouble logging in? Tap to resend OTP or reach support directly | `USER_LOGGED_IN` |
| `REGISTRATION_STARTED` | `REG_DROP_OFF` | 30 minutes | Complete setup to unlock study material for `[University/Semester]` | nothing |
| `HOME_VIEW` | `HOME_IDLE` | 5 minutes | Explore PYQs, Topic Notes & LMR to get started with your prep | nothing |
| `APP_OPEN_SECOND_USE` | `SECOND_USE` | now | Welcome back, continue from where you left off in `[Subject]` | nothing |
| `BUY_NOW_CLICK` | `BUY_NOW_REMINDER` | 10 minutes | Almost there! Unlock `[Subject]` LMR & PYQs now | `COURSE_BOUGHT` |
| `CHECKOUT_VIEW` | `CHECKOUT_DROPOFF` | 2 hours | Your cart is waiting, complete your purchase before exams | `COURSE_BOUGHT` |
| `COURSE_BOUGHT` | `PURCHASE_SUCCESS` | now | You got `[Subject/Pack]`! Start revising today for best results | (it cancels the two above) |
| `TOPIC_OR_LMR_CLICK` | `CONTENT_REVISIT` | 24 hours | You opened `[Unit Name]`. Continue now and master it before exams | nothing |
| `VIDEO_STARTED` | `VIDEO_NOT_COMPLETED` | now, only if `metadata.progress` is a number below 0.3 | You left `[Video Topic]` midway. Pick up where you stopped | nothing |
| `IQ_OR_PYQ_VIEWED` | `IQ_PYQ_REVISIT` | 24 hours | Revise Important Questions & PYQs again today | nothing |
| `APP_INACTIVE_72H` | `RETENTION_3D` | now | Exams are getting closer! Come back and revise with Topic Notes & LMR | nothing |
| `APP_INACTIVE_7D` | `RETENTION_7D` | now | Don't fall behind! Students using RAM revise 2x faster, open the app now | nothing |
| `APP_UNINSTALLED` | none | none | Handled "via SMS/Email/WhatsApp externally"; no code | not applicable |

Strings in `[brackets]` are literal placeholders in the code (the service never fills them); see open questions.

## The plugin rule that replaces each

A plugin rule is: trigger event (with optional `equals` property filters), optional `matchOn`, a goal that ends the journey (required: an `event`, a `set` or `inactivity`; there is no rule without a goal) and timed steps with `delaySeconds` from 0 (`GUIDE.md`, section 7). Where the old code never cancelled a journey, `inactivity` is the closest goal; say so in the shadow run. Use the push channel with the project's audience source set to the `http` source, so the device tokens come from `lookup` at send time. The event names below are suggestions: the plugin matches the exact event name your apps send to OpenPanel, so use whatever the app sends and keep the names consistent (see open questions on event routing).

| Backend journey | Plugin rule |
|---|---|
| `LOGIN_WELCOME` | Trigger `USER_LOGGED_IN`; goal `event` on the course-selected event if the app has one (the comment's intent), else `inactivity`; one push step at 0 s. |
| `INVALID_OTP_REMINDER` | Trigger `INVALID_OTP`; goal `event` `USER_LOGGED_IN`; one push step at 60 s. |
| `REG_DROP_OFF` | Trigger `REGISTRATION_STARTED`; goal: the registration-completed event if the app sends one, else `inactivity`; push at 1,800 s. |
| `HOME_IDLE` | Trigger `HOME_VIEW`; goal `inactivity` (the old code never cancelled it); push at 300 s. |
| `SECOND_USE` | Trigger `APP_OPEN_SECOND_USE`; goal `inactivity`; push at 0 s. |
| `BUY_NOW_REMINDER` | Trigger `BUY_NOW_CLICK`; goal `event` `COURSE_BOUGHT`; push at 600 s. |
| `CHECKOUT_DROPOFF` | Trigger `CHECKOUT_VIEW`; goal `event` `COURSE_BOUGHT`; push at 7,200 s. These two can be one rule with two triggers only if the app can send one trigger; otherwise keep two rules. |
| `PURCHASE_SUCCESS` | Trigger `COURSE_BOUGHT`; goal `inactivity`; push at 0 s. |
| `CONTENT_REVISIT` | Trigger `TOPIC_OR_LMR_CLICK`; goal `inactivity`; push at 86,400 s. |
| `VIDEO_NOT_COMPLETED` | Trigger filters support `equals` only, so "progress below 0.3" cannot be expressed: have the app send a dedicated event only when progress is below 0.3 (see open questions); goal `inactivity`; push at 0 s. |
| `IQ_PYQ_REVISIT` | Trigger `IQ_OR_PYQ_VIEWED`; goal `inactivity`; push at 86,400 s. |
| `RETENTION_3D`, `RETENTION_7D` | Either the same two trigger events if your system still emits them, or one `inactivity`-goal rule per window; see open questions. |
| `APP_UNINSTALLED` | Nothing to replace. |

Caps: set the project's caps and quiet hours on the Channels tab (for example at most 2 per 1 day is not expressible together with 10 per 7 days; the plugin has one cap, `max` per `periodSeconds`, so pick the tighter weekly value or accept the difference and say so to the owner).

## Steps

1. **Prerequisites.** The audience API is live in `sia-backend` and passes the conformance suite (`AUDIENCE_CONTRACT.md`); the project's audience source is set and shows healthy on the Channels tab; push is configured (Firebase service account); a project API key exists. The apps (or the backend, forwarding) send the journey events to OpenPanel with `profileId` equal to the student id the audience API uses.
2. **Copy the wording.** For every row above copy the message text from the service into the rule's template (title and body). Replace the `[Subject]`-style placeholders with template variables the source provides in `traits` (`{{profile.<trait>}}`), or with event properties listed in `allowedEventProps`, or rewrite the line without them; ask the owner which. Email, SMS and WhatsApp copies do not exist in the backend (it only sends push); where the owner wants those channels, SMS and WhatsApp need owner-approved templates registered in the settings, which belong to phase 2 and are not available in this version.
3. **Create the rules paused**, one per row, and check each with the template preview.
4. **Shadow run.** Point the source at a test deployment or restrict sending to a test list: use an audience API that returns only the test students (staff devices) as contactable, or run the rules in a test project. Activate the rules and drive each event from a test device. Compare, per journey: the event was seen, the step came due at the same delay, the text matches, the goal cancels it. The backend keeps sending to real students meanwhile; nobody gets two messages because the plugin only reaches the test list. Watch Results and the `unreachable`/`skipped` reasons.
5. **Agree the caps and quiet hours** with the owner (above) and set them.
6. **Flip the flag.** In `sia-backend` set `sia.notifications.journeys.enabled=false` (it does not exist yet: it is created by Track B, the plan `docs/superpowers/plans/2026-11-02-sia-backend-audience-api.md`, with default `true` so behaviour is unchanged until you set it). With it `false` the backend still records events but schedules and sends nothing, and its scheduler's journey step does nothing. Deploy that, then immediately switch the plugin rules from the test list to the real source (or activate them). Do both within a short window: between them students get nothing, which is better than getting both.
7. **Drain.** Pushes the backend already queued with a `journeyKey` may still go out after the flag flips; check the queue and cancel pending journey rows if you want a clean break.
8. **Watch** for a week: Results (enrolled, sent, skipped, failed), the source status on the Channels tab, and the `unreachable:` reasons.

## Rollback

1. Pause the plugin rules (pausing cancels their running journeys).
2. Set `sia.notifications.journeys.enabled=true` in `sia-backend` and redeploy; the old service resumes from the next event. Events that arrived while it was off were recorded but not acted on, so there is no replay.
3. Fix the cause, return to the shadow run.

The flag is the only switch on the backend side, and the plugin rules can be paused at any time, so the two can be flipped independently.

## Open questions

These could not be settled from the code and need the owner:

1. **Event routing.** The backend receives these events at `POST /api/v1/events`, not in OpenPanel. The plugin reads OpenPanel's Kafka topic, so the apps (or the backend forwarding) must also send each event to OpenPanel `/track` with `profileId` set to the student id. Who sends them, and under which names (`USER_LOGGED_IN` or `user_logged_in`)?
2. **`APP_INACTIVE_72H` and `APP_INACTIVE_7D`.** Nothing in `sia-backend` emits them (only `EventController` calls `recordEvent`); something external must post them. Should the plugin use its own `inactivity` goal instead, and from which trigger (login? any session)?
3. **Placeholders.** `[University/Semester]`, `[Subject]`, `[Unit Name]`, `[Video Topic]`, `[Subject/Pack]` are never filled by the backend. Which student traits should the audience API return, and which event properties will the apps send?
4. **`VIDEO_STARTED` progress filter.** The old rule fires only when `metadata.progress` is below 0.3. Plugin trigger filters are `equals` only, so the app must send a dedicated event (or a boolean property) for the below-0.3 case.
5. **`LOGIN_WELCOME` cancellation.** The code comment says it is cancelled if a course is selected within 10 minutes, but the code does not do that. Which behaviour does the owner want, and what is the course-selected event?
6. **Caps.** The backend caps at 2 per day and 10 per week; the plugin has one cap. Which value?
7. **"Now" journeys.** Several journeys send immediately. A step with `delaySeconds: 0` goes out on the ticker's next tick (`MARKETING_TICK_MS`, default 5 s) after the consumer has read the event; confirm a few seconds of latency is acceptable.
8. **Opt-out.** See the first section: how are students who opted out excluded?
9. **Other channels.** The backend only sends push. If SMS, WhatsApp or email versions are wanted, they need phase 2 channels and owner-approved templates.
10. **`APP_UNINSTALLED`.** The comment says SMS, email and WhatsApp handle it "externally"; that is outside this cut-over.
