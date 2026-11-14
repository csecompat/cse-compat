/**
 * SpecStream adapter: request mapping, paging onto native {num, page}
 * (page capped at 10), error mapping, and the whole worker end to end with
 * the upstream mocked from a fixture. No network, no real key.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { type Env } from '../src/index';
import { resetBreakers } from '../src/router';
import { specstreamAdapter, dateRestrictToAfter } from '../src/adapters/specstream';
import type { SearchRequest } from '../src/types';
import specstreamFixture from './fixtures/specstream-web-search.json';

const REQ = (start: number, num: number, extra: Partial<SearchRequest> = {}): SearchRequest => ({
  q: 'best pizza new york',
  cx: 'abc',
  start,
  num,
  safe: 'off',
  siteRestrictEndpoint: false,
  ...extra,
});

const CREDS = { apiKey: 'test-specstream-key' };
const SIGNAL = new AbortController().signal;

function sources(first: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://r${first + i}.example/`,
    title: `Result ${first + i}`,
    site: `r${first + i}.example`,
    snippet: `snippet ${first + i}`,
  }));
}

/** Mock SpecStream that honors {num, page} over a list of `total` results. */
function mockSpecStream(total = 100) {
  const calls: URL[] = [];
  const headers: Headers[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(url);
      headers.push(new Headers(init?.headers));
      const num = Number(url.searchParams.get('num') ?? 10);
      const page = Number(url.searchParams.get('page') ?? 1);
      const first = (page - 1) * num + 1;
      const count = Math.max(0, Math.min(num, total - first + 1));
      const next = first + count - 1 < total && page < 10 ? page + 1 : null;
      return new Response(JSON.stringify({ data: { sources: sources(first, count), page, next_page: next } }), {
        status: 200,
      });
    }),
  );
  return { calls, headers };
}

function respondWith(status: number, body: unknown = { error: { message: 'nope' } }) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

beforeEach(() => resetBreakers());
afterEach(() => vi.unstubAllGlobals());

describe('specstream request mapping', () => {
  it('calls GET /v1/web-search with the key as a Bearer token and fast speed', async () => {
    const { calls, headers } = mockSpecStream();
    await specstreamAdapter.search(REQ(1, 10), CREDS, SIGNAL);
    expect(calls).toHaveLength(1);
    expect(calls[0].origin + calls[0].pathname).toBe('https://api.specstream.ai/v1/web-search');
    expect(calls[0].searchParams.get('q')).toBe('best pizza new york');
    expect(calls[0].searchParams.get('speed')).toBe('fast');
    expect(calls[0].searchParams.get('num')).toBe('10');
    expect(calls[0].searchParams.has('page')).toBe(false);
    expect(headers[0].get('authorization')).toBe('Bearer test-specstream-key');
  });

  it('maps gl, lr, hl, safe and the query operators', async () => {
    const { calls } = mockSpecStream();
    await specstreamAdapter.search(
      REQ(1, 10, { gl: 'de', lr: 'lang_de', hl: 'en', safe: 'active', siteSearch: 'example.com', fileType: 'pdf' }),
      CREDS,
      SIGNAL,
    );
    const p = calls[0].searchParams;
    expect(p.get('country')).toBe('DE');
    expect(p.get('language')).toBe('de');
    expect(p.get('safe')).toBe('moderate');
    expect(p.get('q')).toBe('best pizza new york filetype:pdf site:example.com');
  });

  it('falls back to hl for the language and sends safe=off by default', async () => {
    const { calls } = mockSpecStream();
    await specstreamAdapter.search(REQ(1, 10, { hl: 'pt-BR' }), CREDS, SIGNAL);
    expect(calls[0].searchParams.get('language')).toBe('pt');
    expect(calls[0].searchParams.get('safe')).toBe('off');
  });

  it('turns dateRestrict into an after: operator', () => {
    const now = new Date('2026-11-11T09:00:00Z');
    expect(dateRestrictToAfter('d5', now)).toBe(' after:2026-11-06');
    expect(dateRestrictToAfter('w2', now)).toBe(' after:2026-10-28');
    expect(dateRestrictToAfter('m6', now)).toBe(' after:2026-05-11');
    expect(dateRestrictToAfter('y', now)).toBe(' after:2025-11-11');
    expect(dateRestrictToAfter('bogus', now)).toBe('');
    expect(dateRestrictToAfter(undefined, now)).toBe('');
  });
});

describe('specstream paging', () => {
  it('page 2 (start=11, num=10) is one native page=2 call', async () => {
    const { calls } = mockSpecStream();
    const res = await specstreamAdapter.search(REQ(11, 10), CREDS, SIGNAL);
    expect(calls.map((u) => [u.searchParams.get('num'), u.searchParams.get('page')])).toEqual([['10', '2']]);
    expect(res.results[0].title).toBe('Result 11');
    expect(res.results).toHaveLength(10);
    expect(res.hasMore).toBe(true);
    expect(res.totalResultsLowerBound).toBe(20);
  });

  it('a small num deep in the window stays within page 10 (start=100, num=1)', async () => {
    const { calls } = mockSpecStream();
    const res = await specstreamAdapter.search(REQ(100, 1), CREDS, SIGNAL);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get('num')).toBe('10');
    expect(calls[0].searchParams.get('page')).toBe('10');
    expect(res.results.map((r) => r.title)).toEqual(['Result 100']);
  });

  it('unaligned window (start=4, num=10) stitches two pages of 10', async () => {
    const { calls } = mockSpecStream();
    const res = await specstreamAdapter.search(REQ(4, 10), CREDS, SIGNAL);
    expect(calls.map((u) => u.searchParams.get('page'))).toEqual([null, '2']);
    expect(res.results).toHaveLength(10);
    expect(res.results[0].title).toBe('Result 4');
    expect(res.results[9].title).toBe('Result 13');
  });

  it('does not fetch a second page when next_page is null', async () => {
    const { calls } = mockSpecStream(5);
    const res = await specstreamAdapter.search(REQ(4, 10), CREDS, SIGNAL);
    expect(calls).toHaveLength(1);
    expect(res.results.map((r) => r.title)).toEqual(['Result 4', 'Result 5']);
    expect(res.hasMore).toBe(false);
  });

  it('a short final page yields fewer results and hasMore=false', async () => {
    mockSpecStream(13);
    const res = await specstreamAdapter.search(REQ(11, 10), CREDS, SIGNAL);
    expect(res.results).toHaveLength(3);
    expect(res.hasMore).toBe(false);
  });
});

describe('specstream error mapping', () => {
  it('401 and 403 are credential errors', async () => {
    for (const status of [401, 403]) {
      respondWith(status);
      await expect(specstreamAdapter.search(REQ(1, 10), CREDS, SIGNAL)).rejects.toMatchObject({
        isCredentialError: true,
        upstreamStatus: status,
      });
    }
  });

  it('402 (balance or spending limit used up) is a quota error', async () => {
    respondWith(402, { error: { code: 'insufficient_balance', message: 'Add balance.' } });
    await expect(specstreamAdapter.search(REQ(1, 10), CREDS, SIGNAL)).rejects.toMatchObject({
      isQuotaError: true,
      isCredentialError: false,
    });
  });

  it('422 is a rejected query with its message', async () => {
    respondWith(422, { error: { message: 'q is over 2,000 characters' } });
    await expect(specstreamAdapter.search(REQ(1, 10), CREDS, SIGNAL)).rejects.toMatchObject({
      isQueryRejected: true,
      message: expect.stringContaining('q is over 2,000 characters'),
    });
  });

  it('503 is transient, so the router may fail over', async () => {
    respondWith(503);
    await expect(specstreamAdapter.search(REQ(1, 10), CREDS, SIGNAL)).rejects.toMatchObject({
      upstreamStatus: 503,
      isCredentialError: false,
      isQuotaError: false,
      isQueryRejected: false,
    });
  });

  it('a body without data is malformed', async () => {
    respondWith(200, { sources: [] });
    await expect(specstreamAdapter.search(REQ(1, 10), CREDS, SIGNAL)).rejects.toThrow('malformed JSON');
  });
});

describe('worker with SPECSTREAM_API_KEY only', () => {
  const ENV: Env = { SPECSTREAM_API_KEY: 'test-specstream-key', PROXY_KEYS: 'good-key' };

  async function run(path: string): Promise<{ status: number; body: any; provider: string | null }> {
    const resp = await worker.fetch(new Request(`https://proxy.example${path}`), ENV);
    return { status: resp.status, body: await resp.json(), provider: resp.headers.get('X-CSE-Compat-Provider') };
  }

  it('serves the legacy envelope from the SpecStream fixture', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(specstreamFixture), { status: 200 })),
    );
    const { status, body, provider } = await run('/customsearch/v1?key=good-key&cx=abc&q=best+pizza+new+york');
    expect(status).toBe(200);
    expect(provider).toBe('specstream');
    expect(body.kind).toBe('customsearch#search');
    expect(body.items).toHaveLength(10);
    expect(body.items[0].link).toBe('https://joespizza.com/');
    expect(body.items[0].displayLink).toBe('joespizza.com');
    expect(body.items[0].htmlSnippet.toLowerCase()).toContain('<b>best</b>');
    expect(body.queries.nextPage[0].startIndex).toBe(11);
  });

  it('omits items when SpecStream returns no sources', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ data: { sources: [], page: 1, next_page: null } }), { status: 200 })),
    );
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=zzzz');
    expect(status).toBe(200);
    expect('items' in body).toBe(false);
    expect(body.searchInformation.totalResults).toBe('0');
  });

  it('never returns 402: an empty SpecStream balance surfaces as 429 RESOURCE_EXHAUSTED', async () => {
    respondWith(402, { error: { code: 'insufficient_balance', message: 'Add balance.' } });
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=x');
    expect(status).toBe(429);
    expect(body.error.status).toBe('RESOURCE_EXHAUSTED');
  });

  it('a rejected SpecStream key is a 403 naming the provider', async () => {
    respondWith(401, { error: { code: 'invalid_token' } });
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=x');
    expect(status).toBe(403);
    expect(body.error.message).toContain('specstream');
  });
});
