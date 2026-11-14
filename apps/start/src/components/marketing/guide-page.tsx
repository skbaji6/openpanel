import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useAppParams } from '@/hooks/use-app-params';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card col gap-3 p-6">
      <h2 className="title">{title}</h2>
      {children}
    </section>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
      {children}
    </pre>
  );
}

const SYNC_EXAMPLE = `curl -X PUT $MARKETING_URL/marketing/contacts/user_123 \\
  -H "x-marketing-api-key: <key from the Channels tab>" \\
  -H "content-type: application/json" \\
  -d '{"email":"ada@example.com","attributes":{"firstName":"Ada"}}'`;

export function GuidePage() {
  const { organizationId, projectId } = useAppParams();
  return (
    <div className="col max-w-3xl gap-4 text-sm">
      <Section title="What journeys do">
        <p>
          A journey rule says:{' '}
          <strong>
            when someone does A, and does not reach the goal G within a set
            time, send them a message.
          </strong>{' '}
          Each rule is a timeline of steps; each step sends one message by
          email, push or webhook. If the person reaches the goal first, the
          remaining steps are cancelled.
        </p>
        <p className="text-muted-foreground">
          Example: someone adds a book to the cart. After 1 hour, email them. If
          they still have not bought it after 1 day, send a push. If they buy at
          any point, stop.
        </p>
        <p className="text-muted-foreground">
          Only people your app identifies (events that carry a profile id) are
          messaged. Anonymous visitors are ignored.
        </p>
      </Section>

      <Section title="Get started in 4 steps">
        <ol className="col list-decimal gap-2 pl-5">
          <li>
            <strong>Connect a channel.</strong> Open the{' '}
            <Link
              params={{ organizationId, projectId }}
              to="/$organizationId/$projectId/marketing/channels"
            >
              <u>Channels</u>
            </Link>{' '}
            tab and set up email (SMTP), push (a Firebase service account) or a
            webhook to your own backend. Create an API key there too if your
            backend will sync contacts, or choose the audience source there:
            your own audience API (people stay in your system) or the contacts
            you sync.
          </li>
          <li>
            <strong>Tell it who to contact.</strong> Your backend sends each
            person's email, name and push device token to the marketing service
            (see the example below). Without an email or device, that step is
            skipped.
          </li>
          <li>
            <strong>Create a rule.</strong> On the Journeys tab, pick{' '}
            <em>Start from template</em> and change the event names to the ones
            your app sends. The preview shows the message with sample data.
          </li>
          <li>
            <strong>Activate it and watch.</strong> New rules start paused.
            Press Activate. The Results tab shows how many people were enrolled,
            messaged and converted.
          </li>
        </ol>
      </Section>

      <Section title="The parts of a rule">
        <dl className="col gap-3">
          <div>
            <dt className="font-medium">When this happens (trigger)</dt>
            <dd className="text-muted-foreground">
              The event that starts a journey, for example{' '}
              <code>add_to_cart</code>. Use the exact event name your app sends.
              Add filters to react only to some events.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Match on property</dt>
            <dd className="text-muted-foreground">
              Keeps journeys per item. With <code>item_id</code>, buying book 7
              ends the journey for book 7 only. Leave empty for one journey per
              person.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Goal</dt>
            <dd className="text-muted-foreground">
              <strong>An event happens</strong>: for example{' '}
              <code>purchase</code>. <strong>Every item of a set</strong>: the
              person must reach each value in a list you register, such as every
              section of a book. <strong>Stays inactive</strong>: the person
              does nothing at all after the trigger.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Steps</dt>
            <dd className="text-muted-foreground">
              Each step has a delay counted from the trigger (1 hour, then 1
              day, and so on; each later than the one before), a channel and a
              message.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Re-entry</dt>
            <dd className="text-muted-foreground">
              Whether the same person can be messaged again for the same rule,
              and how long to wait before they can.
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="Writing the message">
        <p>Use variables in double curly braces:</p>
        <ul className="col list-disc gap-1 pl-5 text-muted-foreground">
          <li>
            <code>{'{{profile.firstName}}'}</code>: a value you synced for the
            person.
          </li>
          <li>
            <code>{'{{event.item_name}}'}</code>: a property of the trigger
            event. It only works if the property is listed under allowed event
            properties.
          </li>
          <li>
            <code>{'{{missing}}'}</code>: with a set goal, the items the person
            has not reached yet.
          </li>
        </ul>
        <p className="text-muted-foreground">
          Email bodies are HTML; subject, push and webhook text are plain text.
          Email always includes an unsubscribe link.
        </p>
      </Section>

      <Section title="Limits and quiet hours">
        <p className="text-muted-foreground">
          On the Channels tab you can cap how many messages one person gets in a
          period and block sending during quiet hours (a message that is held or
          capped shows as skipped in Results).
        </p>
      </Section>

      <Section title="Campaigns step by step">
        <p className="text-muted-foreground">
          A campaign sends one message to an audience, over one channel, now or
          at a set time. Journeys react to what a person does; campaigns go to a
          group you choose.
        </p>
        <ol className="col list-decimal gap-2 pl-5">
          <li>
            <strong>Set up the channel.</strong> On the Channels tab, connect
            the audience source, save the channel's credentials, then its
            sending settings (concurrency, rate per second, quiet hours, price).
            SMS and WhatsApp need a rate per second. Email is built, but its
            provider configuration is not set up yet; use SMS or push.
          </li>
          <li>
            <strong>Register a template</strong> (SMS and WhatsApp) on the
            Templates tab, then enable it. Only enabled templates can be picked
            in a campaign.
          </li>
          <li>
            <strong>Make an audience</strong> on the Audiences tab. Count it and
            preview it before you use it.
          </li>
          <li>
            <strong>Draft the campaign</strong> on the Campaigns tab: name,
            channel, audience, message, and when to send. Save it.
          </li>
          <li>
            <strong>Check and send.</strong> Press Count students. Then read the
            estimate, and send a test to one student. The count must be less
            than 15 minutes old to start.
          </li>
          <li>
            <strong>Start now</strong> (or Schedule for a set time). It always
            asks you to confirm the counted number of students and the channel,
            then runs the checks again on the server. If the number changed in
            the meantime you are asked to count again.
          </li>
        </ol>
        <p className="text-muted-foreground">
          One campaign per project runs at a time; others wait their turn. A
          draft cannot be cancelled, only edited or deleted. Cancel is for a
          campaign that is scheduled or has started. Only owners and admins can
          start, schedule, pause, resume, cancel, delete or send tests; members
          can draft and look.
        </p>
      </Section>

      <Section title="Audiences">
        <dl className="col gap-3">
          <div>
            <dt className="font-medium">Who is in, and who is left out</dt>
            <dd className="text-muted-foreground">
              Add conditions on the fields your audience API offers, such as
              semester or university, and combine them with all or any. You can
              also add students by id (paste a list) and leave students out by
              list or by filter. Leaving out always wins.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Dynamic or snapshot</dt>
            <dd className="text-muted-foreground">
              A dynamic audience is worked out again each time a campaign using
              it starts. A snapshot audience is frozen with Freeze now: the
              students at that moment stay, and any later edit makes it stale
              until you freeze again.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Check it</dt>
            <dd className="text-muted-foreground">
              Count shows how many students it holds, Preview lists some by id
              and masked name, and "Why is this student in or out?" explains one
              student. The source is asked each time; nothing is stored.
            </dd>
          </div>
          <div>
            <dt className="font-medium">In use</dt>
            <dd className="text-muted-foreground">
              An audience used by a campaign that has not finished cannot be
              changed or deleted. Make another audience, or wait for the
              campaign to end.
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="Templates">
        <p className="text-muted-foreground">
          SMS and WhatsApp messages go out as a template your provider has
          approved. Here you record the provider's reference (the SMS flow ID,
          or the WhatsApp template name, namespace and language), the approved
          text, and what fills each variable (for example{' '}
          <code>{'{{profile.first_name}}'}</code>). A student without that value
          is skipped with "A variable had no value for this student". Editing a
          template makes a new version; a campaign keeps the version it started
          with, and turning a template off only stops new campaigns from using
          it. Push and webhook messages are written in the campaign itself.
        </p>
      </Section>

      <Section title="Push messages">
        <p className="text-muted-foreground">
          A push message has a title, a text, and optionally an image and a
          link. The image must be an https address. Neither takes variables. The
          link reaches the app as <code>data.link</code>: the mobile app must
          read it and decide what to open, or it does nothing.
        </p>
      </Section>

      <Section title="What each state means">
        <dl className="col gap-2">
          <div>
            <dt className="font-medium">Draft</dt>
            <dd className="text-muted-foreground">
              Saved, not sent. You can edit or delete it.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Scheduled</dt>
            <dd className="text-muted-foreground">
              Waiting for its send time, or for another campaign in the project
              to finish. Unschedule turns it back into a draft.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Sending</dt>
            <dd className="text-muted-foreground">
              Building the recipient list, then sending. Pause stops sending
              until you resume; nothing is lost.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Paused</dt>
            <dd className="text-muted-foreground">
              Stopped by you. It keeps its place, so no other campaign in the
              project starts until it is resumed and finishes, or cancelled.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Completed</dt>
            <dd className="text-muted-foreground">
              Every student was sent, skipped or failed. "To send" is the number
              of students, and Sent, Failed, Skipped and Uncertain add up to it.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Cancelled, Failed, Missed</dt>
            <dd className="text-muted-foreground">
              Cancelled means you stopped it; messages already sent cannot be
              recalled. Failed means it could not go on (the reason is shown).
              Missed means the system was not running within the allowed
              lateness of the planned time, so nothing was sent; make a new
              campaign.
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="When a campaign is waiting">
        <p className="text-muted-foreground">
          A sending campaign can stop to wait, and says why. It carries on by
          itself when the reason goes away.
        </p>
        <ul className="col list-disc gap-1 pl-5 text-muted-foreground">
          <li>Waiting: the audience API is not answering</li>
          <li>Waiting: the audience API refused our credentials</li>
          <li>Waiting: the audience API returned an error</li>
          <li>Waiting: the channel provider refused our credentials</li>
          <li>Waiting: the channel provider cannot be reached</li>
          <li>Waiting: the channel is not set up</li>
          <li>Waiting: today's daily quota is used up</li>
          <li>Waiting: quiet hours are on</li>
          <li>Waiting: the provider asked us to slow down</li>
          <li>Waiting: sending hit an unexpected error and will retry</li>
        </ul>
        <p className="text-muted-foreground">
          Fix credentials on the Channels tab. Several failures in a row fail
          the campaign instead of waiting for ever.
        </p>
      </Section>

      <Section title="Uncertain">
        <p className="text-muted-foreground">
          Uncertain means sending was interrupted and the provider may or may
          not have received the message. It is never retried by itself. Retry
          uncertain sends those messages again, so a student the provider had
          already accepted gets a second message. Check with the provider first
          if that matters.
        </p>
      </Section>

      <Section title="Test sends">
        <p className="text-muted-foreground">
          Send test sends the campaign's message to one student, by id. It is
          queued, goes out once and is never retried, and is limited to 10 per
          campaign per hour. Quiet hours and limits do not apply to a test.
        </p>
      </Section>

      <Section title="Quiet hours and limits for a campaign">
        <dl className="col gap-3">
          <div>
            <dt className="font-medium">Quiet hours for this campaign</dt>
            <dd className="text-muted-foreground">
              "Use the channel's quiet hours" follows the setting on the
              Channels tab. "No quiet hours" turns them off for this campaign.
              "Other quiet hours" sets its own window. Messages due inside the
              window wait until it ends.
            </dd>
          </div>
          <div>
            <dt className="font-medium">Limit per student</dt>
            <dd className="text-muted-foreground">
              At most N messages in a period. It counts every message that
              student got on that channel, from any campaign or journey, not
              only this one. Students at the limit are skipped with "Limit per
              student reached".
            </dd>
          </div>
          <div>
            <dt className="font-medium">Campaign key</dt>
            <dd className="text-muted-foreground">
              Related campaigns can share a key so a student who already
              received one is skipped in the next.
            </dd>
          </div>
        </dl>
      </Section>

      <Section title="Connect your backend">
        <p className="text-muted-foreground">
          Your backend sends contacts, push tokens and item lists to the
          marketing service with an API key. For example, to save a person's
          email and name:
        </p>
        <Code>{SYNC_EXAMPLE}</Code>
        <p className="text-muted-foreground">
          Other calls: <code>PUT /marketing/devices</code> (push token) and{' '}
          <code>PUT /marketing/reference-sets/&lt;key&gt;</code> (list of items
          for a set goal). The full guide, with every call, webhook signature
          checking and troubleshooting, is in the repository at{' '}
          <code>packages/marketing/docs/GUIDE.md</code>.
        </p>
      </Section>
    </div>
  );
}
