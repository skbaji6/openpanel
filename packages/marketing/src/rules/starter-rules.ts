import type { RuleDefinition } from './rule.schema';

const HOUR = 3600;
const DAY = 24 * HOUR;

// Event names and properties are placeholders for the admin to edit.
export const STARTER_RULES: Record<
  | 'cart-abandoned'
  | 'registered-not-bought'
  | 'bought-never-opened'
  | 'opened-sections-untouched',
  RuleDefinition
> = {
  'cart-abandoned': {
    name: 'Added to cart, not bought',
    trigger: { event: 'add_to_cart' },
    matchOn: 'item_id',
    goal: { kind: 'event', event: 'purchase' },
    steps: [
      {
        delaySeconds: HOUR,
        channel: 'email',
        template: {
          subject: 'You left something behind',
          body: '<p>Hi {{profile.firstName}}, {{event.item_name}} is still waiting in your cart.</p>',
        },
      },
      {
        delaySeconds: DAY,
        channel: 'email',
        template: {
          subject: 'Still thinking it over?',
          body: '<p>Hi {{profile.firstName}}, your cart is saved if you want to come back to {{event.item_name}}.</p>',
        },
      },
    ],
    reentry: { enabled: true, cooldownSeconds: 7 * DAY },
    allowedEventProps: ['item_name'],
  },
  'registered-not-bought': {
    name: 'Registered, not bought',
    trigger: { event: 'signup' },
    goal: { kind: 'event', event: 'purchase' },
    steps: [
      {
        delaySeconds: DAY,
        channel: 'email',
        template: {
          subject: 'Ready when you are',
          body: '<p>Hi {{profile.firstName}}, welcome! Have a look around whenever you like.</p>',
        },
      },
      {
        delaySeconds: 3 * DAY,
        channel: 'email',
        template: {
          subject: 'Need a hand getting started?',
          body: '<p>Hi {{profile.firstName}}, just reply if you have any questions.</p>',
        },
      },
    ],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  },
  'bought-never-opened': {
    name: 'Bought, never opened',
    trigger: { event: 'purchase' },
    matchOn: 'item_id',
    goal: { kind: 'event', event: 'content_opened' },
    steps: [
      {
        delaySeconds: DAY,
        channel: 'email',
        template: {
          subject: 'Your purchase is ready',
          body: '<p>Hi {{profile.firstName}}, {{event.item_name}} is ready for you to open.</p>',
        },
      },
      {
        delaySeconds: 3 * DAY,
        channel: 'push',
        template: {
          subject: 'Pick up where you left off',
          body: '{{event.item_name}} is waiting for you.',
        },
      },
    ],
    reentry: { enabled: true, cooldownSeconds: 0 },
    allowedEventProps: ['item_name'],
  },
  'opened-sections-untouched': {
    name: 'Opened, specific sections untouched',
    trigger: { event: 'content_opened' },
    matchOn: 'item_id',
    goal: {
      kind: 'set',
      event: 'section_opened',
      property: 'section_id',
      setKey: 'item_id',
    },
    steps: [
      {
        delaySeconds: 2 * DAY,
        channel: 'email',
        template: {
          subject: 'You have not visited everything yet',
          body: '<p>Hi {{profile.firstName}}, you have not opened: {{missing}}.</p>',
        },
      },
    ],
    reentry: { enabled: false, cooldownSeconds: 0 },
    allowedEventProps: [],
  },
};
