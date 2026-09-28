import { describe, it, expect, vi, afterEach } from 'vitest';
import worker, { type Env, DEMO_RATE_MESSAGE, DEMO_CREDITS_MESSAGE } from '../src/index';
import { resetBreakers } from '../src/router';
import serperFixture from './fixtures/serper-search.json';

afterEach(() => {
  vi.unstubAllGlobals();
  resetBreakers();
});

function limiter(allowFirst: number) {
  let n = 0;
  const keys: string[] = [];
  return {
    keys,
    binding: {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        n += 1;
        return { success: n <= allowFirst };
      },
    },
  };
}

function req(key: string, ip = '203.0.113.7') {
  return new Request(`https://csecompat.com/customsearch/v1?key=${key}&cx=demo&q=pizza&num=3`, {
    headers: { 'cf-connecting-ip': ip },
  });
}

function okUpstream() {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(serperFixture), { status: 200 })));
}

describe('public demo key', () => {
  it('allows demo requests under the limit, keyed per visitor IP', async () => {
    okUpstream();
    const l = limiter(10);
    const env: Env = { SERPER_API_KEY: 'k', PROXY_KEYS: 'private,demo', DEMO_LIMITER: l.binding };
    const r = await worker.fetch(req('demo'), env);
    expect(r.status).toBe(200);
    expect(l.keys).toEqual(['demo:203.0.113.7']);
  });

  it('returns a Google-style 429 with a friendly message once over the limit', async () => {
    okUpstream();
    const l = limiter(0);
    const env: Env = { SERPER_API_KEY: 'k', PROXY_KEYS: 'private,demo', DEMO_LIMITER: l.binding };
    const r = await worker.fetch(req('demo'), env);
    expect(r.status).toBe(429);
    const body = (await r.json()) as any;
    expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
    expect(body.error.message).toBe(DEMO_RATE_MESSAGE);
  });

  it('never throttles private keys', async () => {
    okUpstream();
    const l = limiter(0);
    const env: Env = { SERPER_API_KEY: 'k', PROXY_KEYS: 'private,demo', DEMO_LIMITER: l.binding };
    const r = await worker.fetch(req('private'), env);
    expect(r.status).toBe(200);
    expect(l.keys).toEqual([]);
  });

  it('explains exhausted demo credits instead of blaming the provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })));
    const env: Env = { SERPER_API_KEY: 'k', PROXY_KEYS: 'private,demo', DEMO_LIMITER: limiter(10).binding };
    const r = await worker.fetch(req('demo'), env);
    expect(r.status).toBe(429);
    expect(((await r.json()) as any).error.message).toBe(DEMO_CREDITS_MESSAGE);
  });

  it('works without the limiter binding (self-hosters)', async () => {
    okUpstream();
    const env: Env = { SERPER_API_KEY: 'k', PROXY_KEYS: 'demo' };
    expect((await worker.fetch(req('demo'), env)).status).toBe(200);
  });
});
