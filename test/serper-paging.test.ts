/**
 * Regression tests for Serper paging: found live — Serper capped num=20 to
 * 10 results, so window-slicing returned an empty page 2. Page-aligned
 * requests must use Serper's native {num, page}.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { serperAdapter } from '../src/adapters/serper';
import type { SearchRequest } from '../src/types';

const REQ = (start: number, num: number): SearchRequest => ({
  q: 'best pizza new york',
  cx: 'abc',
  start,
  num,
  safe: 'off',
  siteRestrictEndpoint: false,
});

function organicPage(pageStart: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    title: `Result ${pageStart + i}`,
    link: `https://r${pageStart + i}.example/`,
    snippet: `snippet ${pageStart + i}`,
    position: i + 1,
  }));
}

/** Mock Serper that honors {num, page} but CAPS num at 10 (observed live). */
function mockSerper() {
  const calls: Array<{ num: number; page: number }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const num = Math.min(body.num ?? 10, 10); // the live cap
      const page = body.page ?? 1;
      calls.push({ num: body.num, page });
      return new Response(JSON.stringify({ organic: organicPage((page - 1) * num + 1, num) }), { status: 200 });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const CREDS = { apiKey: 'k' };
const SIGNAL = new AbortController().signal;

describe('serper paging vs the num cap', () => {
  it('page 2 (start=11, num=10) uses native page=2 and returns 10 results', async () => {
    const calls = mockSerper();
    const res = await serperAdapter.search(REQ(11, 10), CREDS, SIGNAL);
    expect(calls).toEqual([{ num: 10, page: 2 }]);
    expect(res.results).toHaveLength(10);
    expect(res.results[0].title).toBe('Result 11');
    expect(res.hasMore).toBe(true);
  });

  it('page 1 stays a single page=1 request', async () => {
    const calls = mockSerper();
    const res = await serperAdapter.search(REQ(1, 10), CREDS, SIGNAL);
    expect(calls).toEqual([{ num: 10, page: 1 }]);
    expect(res.results[0].title).toBe('Result 1');
  });

  it('aligned num=5 pages map correctly (start=6 -> page 2 of size 5)', async () => {
    const calls = mockSerper();
    const res = await serperAdapter.search(REQ(6, 5), CREDS, SIGNAL);
    expect(calls).toEqual([{ num: 5, page: 2 }]);
    expect(res.results).toHaveLength(5);
    expect(res.results[0].title).toBe('Result 6');
  });

  it('unaligned window (start=4, num=10) stitches two pages', async () => {
    const calls = mockSerper();
    const res = await serperAdapter.search(REQ(4, 10), CREDS, SIGNAL);
    expect(calls.length).toBe(2);
    expect(res.results).toHaveLength(10);
    expect(res.results[0].title).toBe('Result 4');
    expect(res.results[9].title).toBe('Result 13');
  });

  it('short final page yields fewer results and hasMore=false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ organic: organicPage(11, 3) }), { status: 200 })),
    );
    const res = await serperAdapter.search(REQ(11, 10), CREDS, SIGNAL);
    expect(res.results).toHaveLength(3);
    expect(res.hasMore).toBe(false);
  });
});
