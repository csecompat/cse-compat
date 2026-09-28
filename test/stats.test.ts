import { describe, it, expect } from 'vitest';
import worker, { type Env } from '../src/index';

const KEY = 'a-long-private-stats-key-1234';

function kv(entries: Record<string, string>) {
  const store = new Map(Object.entries(entries));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  };
}

const today = new Date().toISOString().slice(0, 10);

function env(extra: Partial<Env> = {}): Env {
  return {
    STATS_KEY: KEY,
    WAITLIST: kv({
      'email:first@example.com': JSON.stringify({ signedUpAt: '2026-09-27T10:00:00.000Z' }),
      'email:<script>@x.co': JSON.stringify({ signedUpAt: '2026-09-28T10:00:00.000Z' }),
      [`demo-count:${today}`]: '42',
    }),
    ...extra,
  };
}

const get = (path: string, e: Env) => worker.fetch(new Request(`https://csecompat.com${path}`), e);

describe('/stats', () => {
  it('404s without the key, with a wrong key, and when no key is configured', async () => {
    expect((await get('/stats', env())).status).toBe(404);
    expect((await get('/stats?key=wrong', env())).status).toBe(404);
    expect((await get(`/stats?key=${KEY}`, env({ STATS_KEY: undefined }))).status).toBe(404);
    expect((await get('/stats?key=short', env({ STATS_KEY: 'short' }))).status).toBe(404);
  });

  it('shows signup count, demo usage and the waitlist with the right key', async () => {
    const r = await get(`/stats?key=${KEY}`, env());
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-robots-tag')).toContain('noindex');
    const html = await r.text();
    expect(html).toContain('first@example.com');
    expect(html).toContain('>2<'); // total signups tile
    expect(html).toContain('>42<'); // demo searches today
  });

  it('escapes stored emails (no HTML injection via the waitlist)', async () => {
    const html = await (await get(`/stats?key=${KEY}`, env())).text();
    expect(html).not.toContain('<script>@x.co');
    expect(html).toContain('&lt;script&gt;@x.co');
  });
});
