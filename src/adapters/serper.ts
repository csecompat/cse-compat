/**
 * Serper-style Google SERP adapter (BYOK).
 *
 * Paging: Serper caps/normalizes `num` on some plans (observed: num=20
 * returns 10), so prefix-window fetching silently breaks page 2. Instead:
 *  - Page-aligned requests (start = 1 + k*num — how Google clients actually
 *    paginate) map directly onto Serper's native {num, page}.
 *  - Unaligned requests fetch the two adjacent pages and slice across them.
 */
import { ProviderError } from '../types';
import type { NormalizedResponse, ProviderAdapter, ProviderCredentials, SearchRequest } from '../types';
import { effectiveQuery } from '../params';

export const serperAdapter: ProviderAdapter = {
  name: 'serper',

  async search(req: SearchRequest, creds: ProviderCredentials, signal: AbortSignal): Promise<NormalizedResponse> {
    const firstIndex = req.start - 1;
    const q = effectiveQuery(req);

    if (firstIndex % req.num === 0) {
      // Page-aligned: one native {num, page} request.
      const page = firstIndex / req.num + 1;
      const organic = await fetchPage(q, req, creds, signal, req.num, page);
      return toResponse(req, organic.slice(0, req.num), firstIndex, organic.length >= req.num);
    }

    // Unaligned: the window [firstIndex, firstIndex+num) spans at most two
    // Serper pages of size num. Fetch both and slice across them.
    const pageSize = req.num;
    const firstPage = Math.floor(firstIndex / pageSize) + 1;
    const offsetInPage = firstIndex - (firstPage - 1) * pageSize;
    const a = await fetchPage(q, req, creds, signal, pageSize, firstPage);
    let pool = a.slice(offsetInPage);
    let sawFullLastPage = a.length >= pageSize;
    if (pool.length < req.num && sawFullLastPage) {
      const b = await fetchPage(q, req, creds, signal, pageSize, firstPage + 1);
      pool = pool.concat(b);
      sawFullLastPage = b.length >= pageSize;
    }
    return toResponse(req, pool.slice(0, req.num), firstIndex, sawFullLastPage);
  },
};

async function fetchPage(
  q: string,
  req: SearchRequest,
  creds: ProviderCredentials,
  signal: AbortSignal,
  num: number,
  page: number,
): Promise<SerperOrganic[]> {
  const payload: Record<string, unknown> = { q, num };
  if (page > 1) payload.page = page;
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
    let detail = '';
    try {
      const j = (await resp.json()) as { message?: unknown };
      if (typeof j.message === 'string') detail = `: ${j.message.slice(0, 120)}`;
    } catch {
      // non-JSON error body: status code alone is enough
    }
    throw new ProviderError('serper', `HTTP ${resp.status}${detail}`, resp.status, false, false, resp.status === 400);
  }

  let data: SerperResponse;
  try {
    data = (await resp.json()) as SerperResponse;
  } catch {
    throw new ProviderError('serper', 'malformed JSON from upstream');
  }
  return data.organic ?? [];
}

function toResponse(
  req: SearchRequest,
  slice: SerperOrganic[],
  firstIndex: number,
  hasMore: boolean,
): NormalizedResponse {
  return {
    provider: 'serper',
    results: slice.map((r) => ({
      title: r.title ?? '',
      link: r.link ?? '',
      snippet: r.snippet ?? '',
    })),
    totalResultsLowerBound: firstIndex + slice.length,
    hasMore,
  };
}

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
  position?: number;
}

interface SerperResponse {
  organic?: SerperOrganic[];
}
