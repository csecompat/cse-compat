import { describe, it, expect } from 'vitest';
import worker, { type Env } from '../src/index';

function post(body: unknown): Request {
  return new Request('https://proxy.example/api/waitlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function kvStub() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      put: async (k: string, v: string) => {
        store.set(k, v);
      },
    },
  };
}

describe('/api/waitlist', () => {
  it('stores a valid signup, lowercased and idempotent by key', async () => {
    const { store, kv } = kvStub();
    const env: Env = { WAITLIST: kv };
    const resp = await worker.fetch(post({ email: 'Dev@Example.COM' }), env);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ ok: true });
    expect(store.has('email:dev@example.com')).toBe(true);
    expect(JSON.parse(store.get('email:dev@example.com')!)).toHaveProperty('signedUpAt');
  });

  it('rejects invalid emails and bodies', async () => {
    const { kv } = kvStub();
    const env: Env = { WAITLIST: kv };
    expect((await worker.fetch(post({ email: 'not-an-email' }), env)).status).toBe(400);
    expect((await worker.fetch(post({}), env)).status).toBe(400);
    const badJson = new Request('https://proxy.example/api/waitlist', { method: 'POST', body: '{oops' });
    expect((await worker.fetch(badJson, env)).status).toBe(400);
  });

  it('returns 503 when KV is not configured (self-host without waitlist)', async () => {
    const resp = await worker.fetch(post({ email: 'a@b.co' }), {});
    expect(resp.status).toBe(503);
  });

  it('does not shadow the search endpoint', async () => {
    // GET /api/waitlist is not a route; falls through to the 404 envelope.
    const resp = await worker.fetch(new Request('https://proxy.example/api/waitlist'), {});
    expect(resp.status).toBe(404);
  });
});
