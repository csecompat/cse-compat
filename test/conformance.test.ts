/**
 * Conformance tests: the whole worker, end to end, with upstream fetches
 * mocked from fixtures. Assertions encode the Google Custom Search JSON
 * contract that client code depends on.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import worker, { type Env } from '../src/index';
import { resetBreakers } from '../src/router';
import braveFixture from './fixtures/brave-web.json';
import serperFixture from './fixtures/serper-search.json';

const ENV: Env = { BRAVE_API_KEY: 'test-brave-key', SERPER_API_KEY: 'test-serper-key', PROXY_KEYS: 'good-key' };

function mockFetchOk(byHost: Record<string, unknown>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const [host, body] of Object.entries(byHost)) {
      if (href.includes(host)) {
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  });
}

function cse(path: string): Request {
  return new Request(`https://proxy.example${path}`);
}

async function run(path: string, env: Env = ENV): Promise<{ status: number; body: any }> {
  const resp = await worker.fetch(cse(path), env);
  return { status: resp.status, body: await resp.json() };
}

beforeEach(() => {
  resetBreakers();
  vi.stubGlobal(
    'fetch',
    mockFetchOk({ 'api.search.brave.com': braveFixture, 'google.serper.dev': serperFixture }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('envelope shape', () => {
  it('returns the legacy customsearch#search envelope', async () => {
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=best+pizza+new+york');
    expect(status).toBe(200);
    expect(body.kind).toBe('customsearch#search');
    expect(body.url.type).toBe('application/json');
    expect(body.url.template).toContain('customsearch/v1?q={searchTerms}');
    expect(body.queries.request).toHaveLength(1);
    expect(body.searchInformation.totalResults).toBeTypeOf('string');
    expect(body.searchInformation.formattedSearchTime).toBeTypeOf('string');
    expect(Array.isArray(body.items)).toBe(true);
  });

  it('items carry every legacy per-result field', async () => {
    const { body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=best+pizza+new+york');
    const item = body.items[0];
    for (const f of ['kind', 'title', 'htmlTitle', 'link', 'displayLink', 'snippet', 'htmlSnippet', 'formattedUrl', 'htmlFormattedUrl']) {
      expect(item, `missing field ${f}`).toHaveProperty(f);
    }
    expect(item.kind).toBe('customsearch#result');
    expect(item.displayLink).toBe('joespizza.com');
  });

  it('htmlSnippet highlights query terms with <b> and strips provider markup', async () => {
    const { body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=best+pizza+new+york');
    const first = body.items[0];
    expect(first.snippet).not.toContain('<strong>');
    expect(first.htmlSnippet).toContain('<b>');
    expect(first.htmlSnippet.toLowerCase()).toContain('<b>best</b>');
  });

  it('queries.request echoes the request parameters', async () => {
    const { body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=pizza&num=5&start=1&safe=active');
    const reqQ = body.queries.request[0];
    expect(reqQ.searchTerms).toBe('pizza');
    expect(reqQ.count).toBe(5);
    expect(reqQ.startIndex).toBe(1);
    expect(reqQ.safe).toBe('active');
    expect(reqQ.cx).toBe('abc123');
    expect(reqQ.inputEncoding).toBe('utf8');
  });
});

describe('pagination semantics', () => {
  it('provides nextPage when more results exist, with correct startIndex', async () => {
    const { body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=best+pizza+new+york&num=10&start=1');
    expect(body.queries.nextPage).toBeDefined();
    expect(body.queries.nextPage[0].startIndex).toBe(11);
    expect(body.queries.previousPage).toBeUndefined();
  });

  it('provides previousPage on page 2', async () => {
    const { body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=best+pizza+new+york&num=10&start=11');
    expect(body.queries.previousPage).toBeDefined();
    expect(body.queries.previousPage[0].startIndex).toBe(1);
  });

  it('start+num window maps into the provider window correctly (brave offset paging)', async () => {
    const { body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=best+pizza+new+york&num=3&start=4');
    expect(body.items).toHaveLength(3);
    // start=4 -> 0-based index 3 of the brave window
    expect(body.items[0].title).toBe('Prince Street Pizza');
  });

  it('never emits a nextPage that would cross the 100-result cap', async () => {
    const { body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=best+pizza+new+york&num=10&start=91');
    expect(body.queries.nextPage).toBeUndefined();
  });
});

describe('zero results', () => {
  it('omits items entirely when there are no results', async () => {
    vi.stubGlobal('fetch', mockFetchOk({ 'api.search.brave.com': { web: { results: [] }, query: {} }, 'google.serper.dev': { organic: [] } }));
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc123&q=zzzz');
    expect(status).toBe(200);
    expect('items' in body).toBe(false);
    expect(body.queries.nextPage).toBeUndefined();
    expect(body.searchInformation.totalResults).toBe('0');
  });
});

describe('parameter validation (Google-exact errors)', () => {
  it('rejects num > 10 with 400 INVALID_ARGUMENT', async () => {
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=x&num=11');
    expect(status).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
    expect(body.error.errors[0].reason).toBe('invalid');
  });

  it('rejects num=0 and non-integer num', async () => {
    expect((await run('/customsearch/v1?key=good-key&cx=abc&q=x&num=0')).status).toBe(400);
    expect((await run('/customsearch/v1?key=good-key&cx=abc&q=x&num=abc')).status).toBe(400);
  });

  it('rejects start+num beyond the 100-result window', async () => {
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=x&start=95&num=10');
    expect(status).toBe(400);
    expect(body.error.status).toBe('INVALID_ARGUMENT');
  });

  it('requires q and cx', async () => {
    expect((await run('/customsearch/v1?key=good-key&cx=abc')).status).toBe(400);
    expect((await run('/customsearch/v1?key=good-key&q=x')).status).toBe(400);
  });

  it('serves the siterestrict endpoint too', async () => {
    const { status } = await run('/customsearch/v1/siterestrict?key=good-key&cx=abc&q=pizza');
    expect(status).toBe(200);
  });

  it('404s unknown paths with the Google error envelope', async () => {
    const { status, body } = await run('/some/other/path?key=good-key');
    expect(status).toBe(404);
    expect(body.error.status).toBe('NOT_FOUND');
  });
});

describe('proxy auth', () => {
  it('403s a missing key when PROXY_KEYS is set', async () => {
    const { status, body } = await run('/customsearch/v1?cx=abc&q=x');
    expect(status).toBe(403);
    expect(body.error.status).toBe('PERMISSION_DENIED');
  });

  it('400s a wrong key (Google-style "API key not valid")', async () => {
    const { status, body } = await run('/customsearch/v1?key=wrong&cx=abc&q=x');
    expect(status).toBe(400);
    expect(body.error.message).toContain('API key not valid');
  });

  it('accepts the x-goog-api-key header', async () => {
    const resp = await worker.fetch(
      new Request('https://proxy.example/customsearch/v1?cx=abc&q=best+pizza+new+york', {
        headers: { 'x-goog-api-key': 'good-key' },
      }),
      ENV,
    );
    expect(resp.status).toBe(200);
  });
});

describe('failover & error mapping', () => {
  it('fails over to the second provider on a 500 from the first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (href.includes('api.search.brave.com')) return new Response('boom', { status: 500 });
        if (href.includes('google.serper.dev')) {
          return new Response(JSON.stringify(serperFixture), { status: 200 });
        }
        return new Response('nf', { status: 404 });
      }),
    );
    // PROVIDER_ORDER pins brave first regardless of sticky rotation
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=best+pizza+new+york', {
      ...ENV,
      PROVIDER_ORDER: 'brave,serper',
    });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(10);
  });

  it('surfaces upstream 401 as a clear credential error, without failover', async () => {
    let serperCalled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (href.includes('api.search.brave.com')) return new Response('nope', { status: 401 });
        if (href.includes('google.serper.dev')) {
          serperCalled = true;
          return new Response(JSON.stringify(serperFixture), { status: 200 });
        }
        return new Response('nf', { status: 404 });
      }),
    );
    // Force brave to be the first candidate deterministically.
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=best+pizza+new+york', {
      ...ENV,
      SERPER_API_KEY: undefined as unknown as string,
    });
    expect(status).toBe(403);
    expect(body.error.message).toContain('brave');
    expect(serperCalled).toBe(false);
  });

  it('maps total upstream failure to 500 backendError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 503 })));
    const { status, body } = await run('/customsearch/v1?key=good-key&cx=abc&q=x+y');
    expect(status).toBe(500);
    expect(body.error.errors[0].reason).toBe('backendError');
  });

  it('never returns 402 under any failure mode', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('quota', { status: 429 })));
    const { status } = await run('/customsearch/v1?key=good-key&cx=abc&q=x');
    expect(status).not.toBe(402);
    expect(status).toBe(429);
  });
});
