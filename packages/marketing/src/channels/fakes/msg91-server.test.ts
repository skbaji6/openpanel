import { afterEach, describe, expect, it } from 'bun:test';
import { type FakeMsg91, responses, startFakeMsg91 } from './msg91-server';

const SMS_PATH = '/api/v5/flow';
const WHATSAPP_PATH = '/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const RETRY_AFTER_SECONDS = 3;
const HANG_OBSERVE_MS = 150;
const SMS_PHONE = '919000000001';

let fake: FakeMsg91 | undefined;

afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function start(opts?: { delayMs?: number }) {
  fake = await startFakeMsg91(opts);
  return fake;
}

function smsBody(...phones: string[]) {
  return {
    template_id: 'flow_1',
    short_url: '0',
    realTimeResponse: '1',
    recipients: phones.map((mobiles) => ({ mobiles, var1: 'a' })),
  };
}

function whatsappBody(...phones: string[]) {
  return {
    integrated_number: '918712606305',
    content_type: 'template',
    payload: {
      messaging_product: 'whatsapp',
      type: 'template',
      template: {
        name: 'tpl',
        language: { code: 'en', policy: 'deterministic' },
        namespace: 'ns',
        to_and_components: phones.map((phone) => ({
          to: [phone],
          components: { body_1: { type: 'text', value: 'x' } },
        })),
      },
    },
  };
}

function post(baseUrl: string, path: string, body: unknown, authkey?: string) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authkey ? { authkey } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('fake MSG91 server', () => {
  it('the default SMS response is type success with a request id', async () => {
    const { baseUrl, requests } = await start();
    const response = await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE), 'key-1');
    const json = (await response.json()) as { type: string; message: string };
    expect(response.status).toBe(200);
    expect(json.type).toBe('success');
    expect(json.message.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.authkey).toBe('key-1');
    expect(requests[0]?.path).toBe(SMS_PATH);
  });

  it('the default WhatsApp response is success without error and records a null authkey when absent', async () => {
    const { baseUrl, requests } = await start();
    const response = await post(
      baseUrl,
      WHATSAPP_PATH,
      whatsappBody('919000000002')
    );
    const json = (await response.json()) as Record<string, unknown>;
    expect(json).toMatchObject({ status: 'success', hasError: false });
    expect(typeof json.request_id).toBe('string');
    expect(requests[0]?.authkey).toBeNull();
  });

  it('script with rateLimited(3) answers 429 with Retry-After 3', async () => {
    const { baseUrl, script, delivered } = await start();
    script(SMS_PATH, responses.rateLimited(RETRY_AFTER_SECONDS));
    const response = await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('3');
    expect(delivered.size).toBe(0);
  });

  it('scripted authFailed, serverError and badRequestIfPhone answer their statuses', async () => {
    const { baseUrl, script, delivered } = await start();
    script(SMS_PATH, responses.authFailed());
    expect((await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE))).status).toBe(
      401
    );
    script(SMS_PATH, responses.serverError());
    expect((await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE))).status).toBe(
      500
    );
    script(SMS_PATH, responses.badRequestIfPhone('919000000009'));
    expect(
      (await post(baseUrl, SMS_PATH, smsBody('919000000009'))).status
    ).toBe(400);
    expect((await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE))).status).toBe(
      200
    );
    expect([...delivered.keys()]).toEqual([SMS_PHONE]);
  });

  it('hang never answers and reset closes the socket', async () => {
    const { baseUrl, script } = await start();
    script(SMS_PATH, 'hang');
    const hung = post(baseUrl, SMS_PATH, smsBody(SMS_PHONE)).then(
      () => 'answered',
      () => 'failed'
    );
    const outcome = await Promise.race([
      hung,
      Bun.sleep(HANG_OBSERVE_MS).then(() => 'pending'),
    ]);
    expect(outcome).toBe('pending');

    script(SMS_PATH, 'reset');
    await expect(post(baseUrl, SMS_PATH, smsBody(SMS_PHONE))).rejects.toThrow();
    // close() in afterEach must end the hanging request
    await fake?.close();
    expect(await hung).toBe('failed');
  });

  it('hang and reset deliver nothing; reset rejects the fetch after the body was received', async () => {
    const { baseUrl, script, delivered, requests } = await start();
    script(SMS_PATH, 'reset');
    await expect(post(baseUrl, SMS_PATH, smsBody(SMS_PHONE))).rejects.toThrow();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({ template_id: 'flow_1' });
    script(SMS_PATH, 'hang');
    post(baseUrl, SMS_PATH, smsBody(SMS_PHONE)).catch(() => undefined);
    await Bun.sleep(HANG_OBSERVE_MS);
    expect(delivered.size).toBe(0);
  });

  it('records the content-type header', async () => {
    const { baseUrl, requests } = await start();
    await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE));
    expect(requests[0]?.contentType).toBe('application/json');
  });

  it('a WhatsApp entry with two phones counts both', async () => {
    const { baseUrl, delivered } = await start();
    const body = whatsappBody('1');
    body.payload.template.to_and_components[0]!.to = ['1', '2'];
    await post(baseUrl, WHATSAPP_PATH, body);
    expect(Object.fromEntries(delivered)).toEqual({ '1': 1, '2': 1 });
  });

  it('the responder index is per path', async () => {
    const { baseUrl, script } = await start();
    const seen: string[] = [];
    script(SMS_PATH, (_body, index) => {
      seen.push(`sms${index}`);
      return { status: 200, body: {} };
    });
    script(WHATSAPP_PATH, (_body, index) => {
      seen.push(`wa${index}`);
      return { status: 200, body: {} };
    });
    await post(baseUrl, SMS_PATH, smsBody('1'));
    await post(baseUrl, WHATSAPP_PATH, whatsappBody('1'));
    await post(baseUrl, SMS_PATH, smsBody('1'));
    expect(seen).toEqual(['sms0', 'wa0', 'sms1']);
  });

  it('delayMs also delays the invalid-JSON 400', async () => {
    const delayMs = 120;
    const { baseUrl } = await start({ delayMs });
    const startedAt = performance.now();
    await post(baseUrl, SMS_PATH, '{nope');
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(delayMs - 10);
  });

  it('three sequential fetches with keep-alive use one connection', async () => {
    const { baseUrl, connections } = await start();
    for (let i = 0; i < 3; i++) {
      const response = await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE));
      await response.text();
    }
    expect(connections()).toBe(1);
  });

  it('delivered counts a phone once per accepted request', async () => {
    const { baseUrl, delivered, script } = await start();
    await post(baseUrl, SMS_PATH, smsBody('1', '2'));
    await post(baseUrl, WHATSAPP_PATH, whatsappBody('2', '3'));
    expect(Object.fromEntries(delivered)).toEqual({ '1': 1, '2': 2, '3': 1 });

    script(SMS_PATH, responses.serverError());
    await post(baseUrl, SMS_PATH, smsBody('4'));
    expect(delivered.has('4')).toBe(false);
  });

  it('partial answers per-recipient results and does not count failed phones as delivered', async () => {
    const { baseUrl, delivered, script } = await start();
    script(WHATSAPP_PATH, responses.partial(['2']));
    const response = await post(baseUrl, WHATSAPP_PATH, whatsappBody('1', '2'));
    const json = (await response.json()) as {
      hasError: boolean;
      results: { to: string; status: string; error_code?: string }[];
    };
    expect(json.hasError).toBe(true);
    expect(json.results.map((r) => [r.to, r.status])).toEqual([
      ['1', 'success'],
      ['2', 'failed'],
    ]);
    expect(Object.fromEntries(delivered)).toEqual({ '1': 1 });
  });

  it('a body that is not JSON gets 400 and is recorded with a null body', async () => {
    const { baseUrl, requests } = await start();
    const response = await post(baseUrl, SMS_PATH, '{nope');
    expect(response.status).toBe(400);
    expect(requests[0]?.body).toBeNull();
  });

  it('malformed answers 200 with a body that is not JSON', async () => {
    const { baseUrl, script } = await start();
    script(SMS_PATH, responses.malformed());
    const response = await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(() => JSON.parse(text)).toThrow();
  });

  it('the responder receives the parsed body and the request index', async () => {
    const { baseUrl, script } = await start();
    const seen: [unknown, number][] = [];
    script(SMS_PATH, (body, index) => {
      seen.push([body, index]);
      return { status: 200, body: { type: 'success', message: 'x' } };
    });
    await post(baseUrl, SMS_PATH, smsBody('1'));
    await post(baseUrl, SMS_PATH, smsBody('2'));
    expect(seen.map(([, index]) => index)).toEqual([0, 1]);
    expect(seen[0]?.[0]).toMatchObject({ template_id: 'flow_1' });
  });

  it('delayMs delays every answer', async () => {
    const delayMs = 120;
    const { baseUrl } = await start({ delayMs });
    const startedAt = performance.now();
    await post(baseUrl, SMS_PATH, smsBody(SMS_PHONE));
    expect(performance.now() - startedAt).toBeGreaterThanOrEqual(delayMs - 10);
  });

  it('close is safe to call twice and refuses new connections', async () => {
    const { baseUrl, close } = await start();
    await close();
    await close();
    await expect(post(baseUrl, SMS_PATH, smsBody(SMS_PHONE))).rejects.toThrow();
  });
});
