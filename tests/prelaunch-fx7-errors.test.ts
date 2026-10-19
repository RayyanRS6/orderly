// Fix package 7, failed requests: only a request body that is not JSON is the sender's mistake
// (api-security-7), and request logs hide phone numbers and a staff echo reads well
// (api-security-9).
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/app';
import { logFailure } from '../server/security';
import { modelRate } from '../server/integrations/models';
import { metaEchoText } from '../server/whatsapp/inbound';
import { company, demoApp } from './helpers/demo-app';

const app = demoApp();

describe('api-security-7: only a request body that is not JSON is the sender’s mistake', () => {
  it('answers any other SyntaxError as a server failure, logged with its reference', async () => {
    vi.spyOn(app.repo(), 'listProducts').mockRejectedValue(
      new SyntaxError('Unexpected token < in JSON at position 0'),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await app.request('/bootstrap');
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe(
      'The service could not complete this request. Check the connection and try again.',
    );
    expect(log).toHaveBeenCalledOnce();
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      event: 'request_failed',
      name: 'SyntaxError',
      requestId: body.requestId,
    });
  });

  it('still answers a body that is not JSON with 400, on any route', async () => {
    const response = await createApp(app.repo()).request(
      `http://127.0.0.1:4000/api/orders/x/status`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-company-id': company.id },
        body: '{"status":',
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'Request body must be valid JSON.' });
  });

  it('ignores a MODEL_PRICING_JSON that is not a JSON object, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('MODEL_PRICING_JSON', `{"custom-model-${randomUUID()}": [1, 2],}`);
    expect(modelRate('gpt-5.4-mini')).toEqual([0.75, 4.5]);
    expect(() => modelRate('custom-model')).toThrow('Enter the provider’s input and output');
    expect(warn).toHaveBeenCalledOnce();
    vi.stubEnv('MODEL_PRICING_JSON', 'null');
    expect(modelRate('gpt-5.4-mini')).toEqual([0.75, 4.5]);
    vi.stubEnv('MODEL_PRICING_JSON', '{"custom-model":[1,2]}');
    expect(modelRate('custom-model')).toEqual([1, 2]);
  });
});

describe('api-security-9: request logs and staff echoes', () => {
  it('hides phone numbers in request_failed lines, but keeps dates and short codes', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    logFailure(
      'request_failed',
      { route: '/api/x' },
      new Error(
        'upstream said 923001234567@s.whatsapp.net and +92 300 1234567 / 0300-1234567 failed on 2026-10-20 (code 131047)',
      ),
    );
    const message = JSON.parse(String(log.mock.calls[0]![0])).message as string;
    expect(message).not.toMatch(/1234567/);
    expect(message).toContain('[number]@s.whatsapp.net');
    expect(message).toContain('2026-10-20');
    expect(message).toContain('131047');
  });

  it('writes “an” before a vowel in a staff echo', () => {
    expect(metaEchoText({ type: 'image' })).toBe('Staff sent an image message in WhatsApp.');
    expect(metaEchoText({ type: 'interactive' })).toBe(
      'Staff sent an interactive message in WhatsApp.',
    );
    expect(metaEchoText({ type: 'audio' })).toBe('Staff sent an audio message in WhatsApp.');
    expect(metaEchoText({ type: 'sticker' })).toBe('Staff sent a sticker message in WhatsApp.');
    expect(metaEchoText({})).toBe('Staff sent a media message in WhatsApp.');
  });
});
