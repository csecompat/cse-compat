import { describe, it, expect, beforeEach } from 'vitest';
import { routeSearch, resetBreakers, stickyOrder, isAvailable } from '../src/router';
import { ProviderError } from '../src/types';
import type { NormalizedResponse, ProviderAdapter, SearchRequest } from '../src/types';

const REQ: SearchRequest = {
  q: 'hello world',
  cx: 'abc',
  start: 1,
  num: 10,
  safe: 'off',
  siteRestrictEndpoint: false,
};

function okResponse(provider: string): NormalizedResponse {
  return { provider, results: [], totalResultsLowerBound: 0, hasMore: false };
}

function adapter(name: string, impl: () => Promise<NormalizedResponse>): ProviderAdapter {
  return { name, search: impl };
}

beforeEach(() => resetBreakers());

describe('stickyOrder', () => {
  it('is deterministic per query', () => {
    const items = ['a', 'b', 'c'];
    expect(stickyOrder(items, 'query one')).toEqual(stickyOrder(items, 'query one'));
  });
  it('preserves the full set', () => {
    expect([...stickyOrder(['a', 'b', 'c'], 'x')].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('circuit breaker', () => {
  it('opens after 3 consecutive failures and skips the dead provider', async () => {
    let deadCalls = 0;
    const dead = adapter('dead', async () => {
      deadCalls++;
      throw new ProviderError('dead', 'down', 503);
    });
    const alive = adapter('alive', async () => okResponse('alive'));
    const providers = [
      { adapter: dead, creds: { apiKey: 'k' } },
      { adapter: alive, creds: { apiKey: 'k' } },
    ];

    // Use a query whose sticky rotation puts `dead` first.
    let q = 'q';
    while (stickyOrder(providers, q)[0].adapter.name !== 'dead') q += 'q';
    const req = { ...REQ, q };

    for (let i = 0; i < 3; i++) {
      const r = await routeSearch(req, providers);
      expect(r.provider).toBe('alive'); // failover each time
    }
    expect(deadCalls).toBe(3);
    expect(isAvailable('dead')).toBe(false); // breaker now open

    await routeSearch(req, providers);
    expect(deadCalls).toBe(3); // dead was skipped entirely
  });

  it('does not fail over on credential errors', async () => {
    const badCreds = adapter('bad', async () => {
      throw new ProviderError('bad', 'unauthorized', 401, true);
    });
    const alive = adapter('alive', async () => okResponse('alive'));
    const providers = [
      { adapter: badCreds, creds: { apiKey: 'k' } },
      { adapter: alive, creds: { apiKey: 'k' } },
    ];
    let q = 'q';
    while (stickyOrder(providers, q)[0].adapter.name !== 'bad') q += 'q';
    await expect(routeSearch({ ...REQ, q }, providers)).rejects.toMatchObject({ isCredentialError: true });
  });

  it('fails over on quota errors only when opted in', async () => {
    const quota = adapter('quota', async () => {
      throw new ProviderError('quota', '429', 429, false, true);
    });
    const alive = adapter('alive', async () => okResponse('alive'));
    const providers = [
      { adapter: quota, creds: { apiKey: 'k' } },
      { adapter: alive, creds: { apiKey: 'k' } },
    ];
    let q = 'q';
    while (stickyOrder(providers, q)[0].adapter.name !== 'quota') q += 'q';
    const req = { ...REQ, q };

    await expect(routeSearch(req, providers)).rejects.toMatchObject({ isQuotaError: true });
    const r = await routeSearch(req, providers, { failoverOnQuota: true });
    expect(r.provider).toBe('alive');
  });

  it('times out a hanging provider and falls back', async () => {
    const hang = adapter('hang', (): Promise<NormalizedResponse> => new Promise((resolve, reject) => {
      // resolves only if aborted never fires — simulate an upstream that never answers
      setTimeout(() => reject(new ProviderError('hang', 'aborted')), 60_000);
    }));
    const alive = adapter('alive', async () => okResponse('alive'));
    const providers = [
      { adapter: hang, creds: { apiKey: 'k' } },
      { adapter: alive, creds: { apiKey: 'k' } },
    ];
    let q = 'q';
    while (stickyOrder(providers, q)[0].adapter.name !== 'hang') q += 'q';
    const start = Date.now();
    const r = await routeSearch({ ...REQ, q }, providers, { timeoutMs: 100 });
    expect(r.provider).toBe('alive');
    expect(Date.now() - start).toBeLessThan(5_000);
  }, 10_000);
});

describe('query rejections vs provider health', () => {
  it('does not open the breaker on repeated query rejections', async () => {
    const picky = adapter('picky', async () => {
      throw new ProviderError('picky', 'HTTP 400: Query pattern not allowed', 400, false, false, true);
    });
    for (let i = 0; i < 5; i++) {
      await expect(routeSearch(REQ, [{ adapter: picky, creds: { apiKey: 'k' } }])).rejects.toMatchObject({
        isQueryRejected: true,
      });
    }
    expect(isAvailable('picky')).toBe(true);
  });
});
