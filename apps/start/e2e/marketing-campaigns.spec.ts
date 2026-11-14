// Needs the marketing worker and the dev stack (`bun scripts/dev-stack.ts` in packages/marketing),
// so it only runs with MARKETING_E2E=1. See packages/marketing/README.md, "Trying it locally".

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  dismissFeedbackPrompt,
  gotoHydrated,
  trpcMutation,
  trpcQuery,
} from './org-helpers';
import { busiestProject } from './seed-manifest';

const SLOW_TIMEOUT_MS = 600_000;
const ACTION_TIMEOUT_MS = 30_000;
const SEND_TIMEOUT_MS = 180_000;
const HTTP_FORBIDDEN = 403;
const GUEST_PASSWORD = 'E2e-marketing-Passw0rd!';

// The dev stack seeds 20 students in semester 6, each with a phone and SMS consent.
const SEMESTER = '6';
const EXPECTED_STUDENTS = 20;
const TEST_STUDENT_ID = 's008';
const AUDIENCE_URL =
  process.env.MARKETING_E2E_AUDIENCE_URL ?? 'http://localhost:4200';
const AUDIENCE_KEY_ID = process.env.MARKETING_E2E_AUDIENCE_KEY_ID ?? 'dev';
const AUDIENCE_SECRET =
  process.env.MARKETING_E2E_AUDIENCE_SECRET ?? 'dev-stack-not-a-real-secret';
const MSG91_URL = process.env.MARKETING_E2E_MSG91_URL ?? '';

const RUN_ID = Date.now();
const TEMPLATE_NAME = `E2E reminder ${RUN_ID}`;
const AUDIENCE_NAME = `E2E semester ${SEMESTER} ${RUN_ID}`;
const CAMPAIGN_NAME = `E2E campaign ${RUN_ID}`;
const MEMBER_EMAIL = `e2e-marketing-${RUN_ID}@example.com`;
const OUTSIDER_EMAIL = `e2e-marketing-out-${RUN_ID}@example.com`;
const THROWAWAY_EMAIL = /^e2e-marketing(-out)?-\d+@example\.com$/;

test.skip(
  process.env.MARKETING_E2E !== '1',
  'Needs the marketing worker and the dev stack; set MARKETING_E2E=1'
);
test.describe.configure({ mode: 'serial' });
test.setTimeout(SLOW_TIMEOUT_MS);
test.use({ actionTimeout: ACTION_TIMEOUT_MS });

let campaignId = '';

interface Invite {
  id: string;
  email: string;
}

interface Member {
  id: string;
  userId: string;
  email: string;
}

const toast = (page: Page, text: string) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text });

const openTab = (
  page: Page,
  projectId: string,
  organizationId: string,
  tab: string
) => gotoHydrated(page, `/${organizationId}/${projectId}/marketing/${tab}`);

const cardRegion = (page: Page, name: string) =>
  page.getByRole('region', { name, exact: true });

const marketingRequest = (
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  projectId: string
) => {
  const headers = {
    'x-marketing-csrf': '1',
    'x-marketing-project-id': projectId,
    origin: new URL(page.url()).origin,
  };
  const url = `/marketing-api/${path}`;
  return method === 'GET'
    ? page.request.get(url, { headers })
    : page.request.post(url, { headers, data: {} });
};

async function signUp(page: Page, url: string, email: string) {
  await dismissFeedbackPrompt(page);
  await gotoHydrated(page, url);
  await page.getByLabel('First name').fill('E2E');
  await page.getByLabel('Last name').fill('Marketing');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(GUEST_PASSWORD);
  await page.getByLabel('Confirm password').fill(GUEST_PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
}

test.beforeEach(async ({ page }) => {
  await dismissFeedbackPrompt(page);
});

test.afterAll(async ({ browser, seed }) => {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: 'e2e/.auth/user.json',
  });
  const page = await context.newPage();
  const { organizationId } = seed;
  const invites = await trpcQuery<Invite[]>(page, 'organization.invitations', {
    organizationId,
  });
  for (const invite of invites) {
    if (THROWAWAY_EMAIL.test(invite.email)) {
      await trpcMutation(page, 'organization.revokeInvite', {
        inviteId: invite.id,
      });
    }
  }
  const members = await trpcQuery<Member[]>(page, 'organization.members', {
    organizationId,
  });
  for (const member of members) {
    if (THROWAWAY_EMAIL.test(member.email)) {
      await trpcMutation(page, 'organization.removeMember', {
        organizationId,
        userId: member.userId,
        id: member.id,
      });
    }
  }
  await context.close();
});

test('an owner sends a campaign from connection to completion', async ({
  page,
  seed,
}, testInfo) => {
  expect(
    MSG91_URL,
    'set MARKETING_E2E_MSG91_URL to the value dev-stack prints'
  ).not.toBe('');
  const { id: projectId } = busiestProject(seed);
  const { organizationId } = seed;

  await test.step('connect the audience source', async () => {
    await openTab(page, projectId, organizationId, 'channels');
    const source = cardRegion(page, 'Audience source');
    const kind = source.getByRole('combobox', {
      name: 'Where contacts come from',
    });
    if (!(await kind.innerText()).includes('HTTP API')) {
      await kind.click();
      await page.getByRole('option', { name: 'HTTP API' }).click();
    }
    await source.getByLabel('Base URL').fill(AUDIENCE_URL);
    await source.getByLabel('Key id').fill(AUDIENCE_KEY_ID);
    await source.getByLabel('Secret').fill(AUDIENCE_SECRET);
    await source.getByRole('button', { name: 'Save' }).click();
    const testConnection = source.getByRole('button', {
      name: 'Test connection',
    });
    await expect(testConnection).toBeEnabled();
    await testConnection.click();
    await expect(source.getByRole('status')).toContainText('Connected');
  });

  await test.step('save SMS credentials and sending settings', async () => {
    const sms = cardRegion(page, 'SMS (MSG91)');
    await sms.getByLabel('MSG91 auth key').fill('dev-stack-fake-key');
    await sms.getByLabel('Base URL').fill(MSG91_URL);
    await sms.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'SMS (MSG91) saved')).toBeVisible();

    const settings = cardRegion(page, 'SMS (MSG91) sending settings');
    await settings.getByLabel('Concurrency').fill('2');
    await settings.getByLabel('Rate per second').fill('10');
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Sending settings saved')).toBeVisible();
  });

  await test.step('register an SMS template', async () => {
    await gotoHydrated(
      page,
      `/${organizationId}/${projectId}/marketing/templates?channel=sms`
    );
    await page.getByRole('button', { name: 'Add template' }).click();
    await page.getByLabel('Name', { exact: true }).fill(TEMPLATE_NAME);
    await page.getByLabel('Flow ID').fill('e2e_flow_1');
    await page.getByLabel('Approved text').fill('Your exam is soon');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(toast(page, 'Template saved')).toBeVisible();
    const row = page.getByRole('row', { name: new RegExp(TEMPLATE_NAME) });
    await expect(row).toBeVisible();
    const enable = row.getByRole('button', { name: 'Enable', exact: true });
    if ((await enable.count()) > 0) {
      await enable.click();
    }
    await expect(
      row.getByRole('button', { name: 'Disable', exact: true })
    ).toBeVisible();
  });

  await test.step('create an audience, count it and preview it', async () => {
    await openTab(page, projectId, organizationId, 'audiences');
    await page.getByRole('button', { name: 'New audience' }).click();
    await page.getByLabel('Name', { exact: true }).fill(AUDIENCE_NAME);
    const filter = page.getByRole('region', { name: 'Who is in', exact: true });
    await filter.getByRole('button', { name: 'Add condition' }).click();
    await filter
      .getByRole('combobox', { name: 'Field, condition 1' })
      .selectOption({ label: 'Semester' });
    await filter.getByLabel('Semester value').fill(SEMESTER);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page, 'Audience saved')).toBeVisible();

    await page.getByRole('button', { name: 'Count', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'students' }).first()
    ).toContainText(`${EXPECTED_STUDENTS} students`);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(
      page.getByRole('columnheader', { name: 'Student id' }).first()
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('audience-editor.png'),
      fullPage: true,
    });
  });

  await test.step('draft a campaign, count, estimate and test send', async () => {
    await openTab(page, projectId, organizationId, 'campaigns');
    await page.getByRole('button', { name: 'New campaign' }).click();
    await page.getByLabel('Name', { exact: true }).fill(CAMPAIGN_NAME);
    await page
      .getByLabel('Channel', { exact: true })
      .selectOption({ label: 'SMS' });
    await page
      .getByLabel('Audience', { exact: true })
      .selectOption({ label: AUDIENCE_NAME });
    await page
      .getByLabel('Template', { exact: true })
      .selectOption({ label: TEMPLATE_NAME });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(toast(page, 'Campaign saved')).toBeVisible();
    await expect(page).toHaveURL(/[?&]id=/);
    campaignId = new URL(page.url()).searchParams.get('id') ?? '';
    expect(campaignId).not.toBe('');

    const panel = page.getByRole('region', { name: 'Check and send' });
    await panel.getByRole('button', { name: 'Count students' }).click();
    await expect(
      panel.getByText(`${EXPECTED_STUDENTS}`, { exact: true }).first()
    ).toBeVisible();
    await expect(panel.getByText(/messages per second/)).toBeVisible();

    await panel.getByLabel('Student id').fill(TEST_STUDENT_ID);
    await panel.getByRole('button', { name: 'Send test' }).click();
    await expect(toast(page, 'Test queued')).toBeVisible();
    await expect(
      panel.getByRole('cell', { name: 'Sent', exact: true })
    ).toBeVisible({
      timeout: SEND_TIMEOUT_MS,
    });
  });

  await test.step('start it and watch it complete', async () => {
    const panel = page.getByRole('region', { name: 'Check and send' });
    await panel.getByRole('button', { name: 'Start now' }).click();
    await expect(
      page
        .getByRole('dialog')
        .getByText(`Send to ${EXPECTED_STUDENTS} students by SMS?`)
    ).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes' }).click();
    await expect(toast(page, 'Campaign started')).toBeVisible();

    await expect(page.getByText('Completed', { exact: true })).toBeVisible({
      timeout: SEND_TIMEOUT_MS,
    });
    const toSend = page
      .locator('dt', { hasText: 'To send' })
      .locator('xpath=following-sibling::dd');
    const sent = page
      .locator('dt', { hasText: /^Sent$/ })
      .locator('xpath=following-sibling::dd');
    await expect(toSend).toHaveText(`${EXPECTED_STUDENTS}`);
    await expect(sent).toHaveText(`${EXPECTED_STUDENTS}`);

    await page.getByRole('button', { name: 'Show recipients' }).click();
    await expect(
      page.getByRole('cell', { name: 'Sent', exact: true }).first()
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath('campaign-completed.png'),
      fullPage: true,
    });
  });
});

test('a member can look but not start, delete or add templates', async ({
  page,
  seed,
  browser,
}, testInfo) => {
  const { id: projectId } = busiestProject(seed);
  const { organizationId } = seed;
  expect(campaignId, 'the owner test must have created a campaign').not.toBe(
    ''
  );

  await gotoHydrated(page, `/${organizationId}/members/invitations`);
  await page.getByRole('button', { name: 'Invite user' }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByLabel('Email').fill(MEMBER_EMAIL);
  await sheet.getByRole('button', { name: 'Invite user' }).click();
  await expect(
    sheet.getByRole('heading', { name: 'User has been invited' })
  ).toBeVisible();
  const invites = await trpcQuery<Invite[]>(page, 'organization.invitations', {
    organizationId,
  });
  const invite = invites.find((candidate) => candidate.email === MEMBER_EMAIL);
  if (!invite) {
    throw new Error('Invite was not created');
  }

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
  });
  const member = await context.newPage();
  try {
    await signUp(member, `/onboarding?inviteId=${invite.id}`, MEMBER_EMAIL);
    await member.waitForURL(new RegExp(`/${organizationId}$`), {
      timeout: 60_000,
    });

    await openTab(member, projectId, organizationId, 'campaigns');
    await expect(
      member.getByRole('button', { name: CAMPAIGN_NAME })
    ).toBeVisible();
    await member.getByRole('button', { name: CAMPAIGN_NAME }).click();
    await expect(member.getByText('Completed', { exact: true })).toBeVisible();
    await expect(member.getByRole('button', { name: 'Start now' })).toHaveCount(
      0
    );
    await expect(
      member.locator('button:not([disabled])', { hasText: 'Delete' })
    ).toHaveCount(0);

    await openTab(member, projectId, organizationId, 'audiences');
    await expect(
      member.getByRole('row', { name: new RegExp(AUDIENCE_NAME) })
    ).toBeVisible();
    await expect(
      member.locator('button:not([disabled])', { hasText: 'Delete' })
    ).toHaveCount(0);

    await openTab(member, projectId, organizationId, 'templates');
    await expect(
      member.getByRole('row', { name: new RegExp(TEMPLATE_NAME) })
    ).toBeVisible();
    await expect(
      member.getByRole('button', { name: 'Add template' })
    ).toHaveCount(0);
    await member.screenshot({
      path: testInfo.outputPath('member-view.png'),
      fullPage: true,
    });

    const start = await marketingRequest(
      member,
      'POST',
      `campaigns/${campaignId}/start`,
      projectId
    );
    expect(start.status()).toBe(HTTP_FORBIDDEN);
  } finally {
    await context.close();
  }
});

test('a signed-in user outside the organization sees no marketing data', async ({
  seed,
  browser,
}) => {
  const { id: projectId } = busiestProject(seed);
  const { organizationId } = seed;
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    storageState: { cookies: [], origins: [] },
  });
  const outsider = await context.newPage();
  try {
    const signedUp = outsider.waitForResponse((response) =>
      response.url().includes('/trpc/auth.signUpEmail')
    );
    await signUp(outsider, '/onboarding', OUTSIDER_EMAIL);
    expect((await signedUp).ok()).toBe(true);

    await gotoHydrated(
      outsider,
      `/${organizationId}/${projectId}/marketing/campaigns`
    );
    await expect(outsider.getByText(CAMPAIGN_NAME)).toHaveCount(0);
    const list = await marketingRequest(
      outsider,
      'GET',
      'campaigns',
      projectId
    );
    expect(list.status()).toBe(HTTP_FORBIDDEN);
  } finally {
    await context.close();
  }
});
