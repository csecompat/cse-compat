/**
 * Serper-style Google SERP adapter (BYOK). Serper accepts arbitrary `num`
 * up to 100, so the simplest correct paging strategy is to fetch the whole
 * prefix window [1, start-1+num] and slice — legal because Google's own cap
 * means start-1+num <= 100.
 */
import { ProviderError } from '../types';
import type { NormalizedResponse, ProviderAdapter, ProviderCredentials, SearchRequest } from '../types';
import { effectiveQuery } from '../params';

export const serperAdapter: ProviderAdapter = {
  name: 'serper',

  async search(req: SearchRequest, creds: ProviderCredentials, signal: AbortSignal): Promise<NormalizedResponse> {
    const firstIndex = req.start - 1;
    const windowSize = firstIndex + req.num; // <= 100 by param validation

    const payload: Record<string, unknown> = {
      q: effectiveQuery(req),
      num: windowSize,
    };
    if (req.gl) payload.gl = req.gl.toLowerCase();
    if (req.hl) payload.hl = req.hl;

    let resp: Response;
    try {
      resp = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': creds.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (e) {
      throw new ProviderError('serper', `network error: ${(e as Error).message}`);
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new ProviderError('serper', `credential rejected (${resp.status})`, resp.status, true);
    }
    if (resp.status === 429) {
      throw new ProviderError('serper', 'upstream quota exhausted (429)', 429, false, true);
    }
    if (!resp.ok) {
      throw new ProviderError('serper', `upstream error ${resp.status}`, resp.status);
    }

    let data: SerperResponse;
    try {
      data = (await resp.json()) as SerperResponse;
    } catch {
      throw new ProviderError('serper', 'malformed JSON from upstream');
    }

    const organic = data.organic ?? [];
    const slice = organic.slice(firstIndex, firstIndex + req.num);

    return {
      provider: 'serper',
      results: slice.map((r) => ({
        title: r.title ?? '',
        link: r.link ?? '',
        snippet: r.snippet ?? '',
      })),
      totalResultsLowerBound: organic.length,
      hasMore: organic.length >= windowSize,
    };
  },
};

interface SerperResponse {
  organic?: Array<{ title?: string; link?: string; snippet?: string; position?: number }>;
}
