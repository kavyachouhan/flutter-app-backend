/**
 * The delivery seam: every vendor failure becomes a typed DeliveryError with
 * the right `retryable` flag, because that flag is what decides whether the
 * person sees "try again shortly" or "check your number".
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeProvider } from './providers/fake.js';
import { createMsg91Provider } from './providers/msg91.js';
import { createTwilioProvider } from './providers/twilio.js';
import { __testing, getOtpDeliveryProvider } from './registry.js';
import {
  DeliveryError,
  isRetryableHttpStatus,
  renderOtpTemplate,
  type OtpDeliveryInput,
} from './types.js';

const INPUT: OtpDeliveryInput = { phone: '919876543210', code: '482913', ttlSeconds: 300 };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A fetch stub that records the request and answers with `response`. */
function stubFetch(response: Response | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

async function rejection(promise: Promise<unknown>): Promise<DeliveryError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DeliveryError);
    return error as DeliveryError;
  }
  throw new Error('expected the promise to reject');
}

describe('template rendering', () => {
  it('substitutes the code and the validity in whole minutes', () => {
    expect(renderOtpTemplate('Code {code}, valid {minutes} min', INPUT)).toBe(
      'Code 482913, valid 5 min',
    );
    expect(renderOtpTemplate('{minutes}', { ...INPUT, ttlSeconds: 61 })).toBe('2');
    expect(renderOtpTemplate('{minutes}', { ...INPUT, ttlSeconds: 1 })).toBe('1');
  });
});

describe('HTTP status classification', () => {
  it('retries only on server errors, timeouts and throttling', () => {
    expect([500, 502, 503, 408, 429].map(isRetryableHttpStatus)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect([400, 401, 403, 404, 422].map(isRetryableHttpStatus)).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('registry', () => {
  afterEach(() => __testing.reset());

  it('selects the provider named by the environment and memoises it', () => {
    const provider = getOtpDeliveryProvider();
    expect(provider.name).toBe('console');
    expect(getOtpDeliveryProvider()).toBe(provider);
  });

  it('has a factory for every provider the environment schema accepts', () => {
    expect(__testing.providerNames.sort()).toEqual(['console', 'fake', 'msg91', 'twilio']);
  });
});

describe('fake provider', () => {
  it('records codes and can look up the latest per phone', async () => {
    const fake = createFakeProvider();
    await fake.sendOtp(INPUT);
    await fake.sendOtp({ ...INPUT, code: '000001' });
    await fake.sendOtp({ ...INPUT, phone: '919000000000', code: '999999' });

    expect(fake.sent).toHaveLength(3);
    expect(fake.lastCodeFor('919876543210')).toBe('000001');
    expect(fake.lastCodeFor('910000000000')).toBeUndefined();
  });

  it('fails once when told to, then recovers', async () => {
    const fake = createFakeProvider();
    fake.failNextWith(new DeliveryError('down', { provider: 'fake', retryable: true }));
    await expect(fake.sendOtp(INPUT)).rejects.toBeInstanceOf(DeliveryError);
    await expect(fake.sendOtp(INPUT)).resolves.toMatchObject({ provider: 'fake' });
    fake.reset();
    expect(fake.sent).toHaveLength(0);
  });
});

describe('twilio provider', () => {
  const settings = {
    baseUrl: 'https://api.twilio.invalid',
    accountSid: 'AC123',
    authToken: 'secret',
    senderId: '+15005550006',
    messageTemplate: 'Your code is {code}',
    timeoutMs: 1000,
  };

  it('posts a form-encoded message with basic auth and returns the sid', async () => {
    const { fetch, calls } = stubFetch(jsonResponse(201, { sid: 'SM1' }));
    const provider = createTwilioProvider(settings, { fetch });

    await expect(provider.sendOtp(INPUT)).resolves.toEqual({
      provider: 'twilio',
      channel: 'sms',
      providerMessageId: 'SM1',
    });

    const call = calls[0]!;
    expect(call.url).toBe('https://api.twilio.invalid/2010-04-01/Accounts/AC123/Messages.json');
    const headers = call.init?.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('AC123:secret').toString('base64')}`,
    );
    const body = call.init?.body as URLSearchParams;
    expect(Object.fromEntries(body)).toEqual({
      To: '+919876543210',
      From: '+15005550006',
      Body: 'Your code is 482913',
    });
  });

  it('marks a 4xx as terminal and a 5xx as retryable', async () => {
    const terminal = await rejection(
      createTwilioProvider(settings, stubFetch(jsonResponse(400, { message: 'bad' }))).sendOtp(
        INPUT,
      ),
    );
    expect(terminal).toMatchObject({ provider: 'twilio', retryable: false, statusCode: 400 });

    const transient = await rejection(
      createTwilioProvider(settings, stubFetch(jsonResponse(503, {}))).sendOtp(INPUT),
    );
    expect(transient).toMatchObject({ retryable: true, statusCode: 503 });
  });

  it('treats a network failure or timeout as retryable', async () => {
    const error = await rejection(
      createTwilioProvider(settings, stubFetch(new Error('ECONNRESET'))).sendOtp(INPUT),
    );
    expect(error.retryable).toBe(true);
    expect(error.cause).toBeInstanceOf(Error);
  });
});

describe('msg91 provider', () => {
  const settings = {
    baseUrl: 'https://control.msg91.invalid/',
    authKey: 'key',
    templateId: 'tpl',
    timeoutMs: 1000,
  };

  it('sends the template, mobile, otp and expiry as query parameters', async () => {
    const { fetch, calls } = stubFetch(jsonResponse(200, { type: 'success', message: 'req1' }));
    await expect(createMsg91Provider(settings, { fetch }).sendOtp(INPUT)).resolves.toEqual({
      provider: 'msg91',
      channel: 'sms',
      providerMessageId: 'req1',
    });

    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/api/v5/otp');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      template_id: 'tpl',
      mobile: '919876543210',
      otp: '482913',
      otp_expiry: '5',
    });
    expect((calls[0]!.init?.headers as Record<string, string>)['authkey']).toBe('key');
  });

  it('treats an in-body error on HTTP 200 as terminal', async () => {
    const error = await rejection(
      createMsg91Provider(
        settings,
        stubFetch(jsonResponse(200, { type: 'error', message: 'invalid mobile' })),
      ).sendOtp(INPUT),
    );
    expect(error).toMatchObject({ provider: 'msg91', retryable: false });
  });

  it('retries on throttling', async () => {
    const error = await rejection(
      createMsg91Provider(settings, stubFetch(jsonResponse(429, {}))).sendOtp(INPUT),
    );
    expect(error.retryable).toBe(true);
  });
});
