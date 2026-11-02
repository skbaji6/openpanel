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
