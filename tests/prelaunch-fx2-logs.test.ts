// api-security-6: request_failed and job_failed log lines never carry the server's secrets or the
// query string of a URL (Meta's signup code exchange carries the app secret in its URL).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { logFailure, PublicError } from '../server/security';
import { processJob } from '../server/service';
import { makeJob } from '../server/jobs';
import { finishSignup } from '../server/integrations/signup';
import { company, turnStore } from './helpers/fx2-turns';

const { repo } = turnStore();
const APP_SECRET = 'meta-app-secret-for-tests-0001';
const SERVICE_KEY = 'service-role-key-for-tests-0002';
beforeEach(() => {
  vi.stubEnv('META_APP_SECRET', APP_SECRET);
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', SERVICE_KEY);
});

describe('api-security-6: failure logs never carry secrets or URL query strings', () => {
  it('hides the signup code exchange URL and the app secret in request_failed', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    logFailure(
      'request_failed',
      { method: 'POST', route: '/api/whatsapp/signup' },
      new TypeError(
        `error sending request for url (https://graph.facebook.com/v21.0/oauth/access_token?client_id=123&client_secret=${APP_SECRET}&code=AQD-signup-code)`,
      ),
    );
    const line = String(log.mock.calls[0]![0]);
    expect(line).not.toContain(APP_SECRET);
    expect(line).not.toContain('AQD-signup-code');
    expect(line).not.toContain('client_id=123');
    expect(JSON.parse(line).message).toContain(
      'https://graph.facebook.com/v21.0/oauth/access_token?[hidden]',
    );
    // A secret quoted anywhere else is hidden too, and so is a secret-looking parameter.
    logFailure('request_failed', {}, new Error(`bad key ${SERVICE_KEY} rejected`));
    expect(String(log.mock.calls[1]![0])).not.toContain(SERVICE_KEY);
    logFailure('request_failed', {}, new Error('form sent access_token=EAAB-live-token&x=1'));
    expect(String(log.mock.calls[2]![0])).not.toContain('EAAB-live-token');
  });

  it('hides them in job_failed too', async () => {
    const job = makeJob(company.id, 'incoming', {
      phone: '923005500099',
      messageId: `wamid-${randomUUID()}`,
      text: 'hello',
    });
    await repo().insertJob(job);
    vi.spyOn(repo(), 'commitTurn').mockRejectedValueOnce(
      new Error(
        `fetch failed: https://project.supabase.co/rest/v1/rpc/commit_turn?apikey=${SERVICE_KEY}&select=*`,
      ),
    );
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(processJob(repo(), job.id)).rejects.toMatchObject({ status: 503 });
    const line = String(log.mock.calls[0]![0]);
    expect(JSON.parse(line).event).toBe('job_failed');
    expect(line).not.toContain(SERVICE_KEY);
    expect(line).toContain('https://project.supabase.co/rest/v1/rpc/commit_turn?[hidden]');
  });

  it('turns a network failure in the signup exchange into a public error without its URL', async () => {
    vi.stubEnv('META_GRAPH_VERSION', 'v21.0');
    vi.stubEnv('META_APP_ID', '123');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        throw new TypeError(`error sending request for url (${url})`);
      }),
    );
    const failure = await finishSignup(repo(), company.id, {
      code: 'AQD-signup-code',
      phoneNumberId: '111',
      wabaId: '222',
      coexistence: false,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PublicError);
    expect(failure).toMatchObject({ status: 502 });
    expect((failure as Error).cause).toBeUndefined();
    expect((failure as Error).message).not.toContain(APP_SECRET);
    expect((failure as Error).message).not.toContain('graph.facebook.com');
  });
});
