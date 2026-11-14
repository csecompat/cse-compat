/**
 * SpecStream Search API adapter (BYOK: the key belongs to the caller's own
 * SpecStream account; this software only transforms requests and responses).
 *
 * Request: GET https://api.specstream.ai/v1/web-search with the key as a
 * Bearer token. `speed=fast` returns the engines' ranked results with their
 * snippets in about a second, without the answer step, which is all a
 * Custom Search client reads.
 *
 * Paging: SpecStream takes {num, page} natively (num 1..100, page 1..10) and
 * says in `next_page` whether more results exist. A page-aligned request
 * (start = 1 + k*num) maps onto one {num, page} call when page <= 10.
 * Anything else (unaligned, or a small num deep into the window) uses pages
 * of 10: the window [start, start+num) spans at most two of them, and
 * Google's 100-result cap keeps both within page 10.
 */
import { ProviderError } from '../types';
import type { NormalizedResponse, ProviderAdapter, ProviderCredentials, SearchRequest } from '../types';
import { effectiveQuery } from '../params';

const ENDPOINT = 'https://api.specstream.ai/v1/web-search';
const MAX_PAGE = 10;
const FALLBACK_PAGE_SIZE = 10;

export const specstreamAdapter: ProviderAdapter = {
  name: 'specstream',

  async search(req: SearchRequest, creds: ProviderCredentials, signal: AbortSignal): Promise<NormalizedResponse> {
    const firstIndex = req.start - 1;
    const q = effectiveQuery(req) + dateRestrictToAfter(req.dateRestrict);

    if (firstIndex % req.num === 0 && firstIndex / req.num + 1 <= MAX_PAGE) {
      const page = await fetchPage(q, req, creds, signal, req.num, firstIndex / req.num + 1);
      const slice = page.sources.slice(0, req.num);
      return toResponse(slice, firstIndex, page.hasMore);
    }

    const size = FALLBACK_PAGE_SIZE;
    const firstPage = Math.floor(firstIndex / size) + 1;
    const a = await fetchPage(q, req, creds, signal, size, firstPage);
    let pool = a.sources.slice(firstIndex - (firstPage - 1) * size);
    let hasMore = a.hasMore;
    if (pool.length < req.num && hasMore && firstPage < MAX_PAGE) {
      const b = await fetchPage(q, req, creds, signal, size, firstPage + 1);
      pool = pool.concat(b.sources);
      hasMore = b.hasMore;
    }
    const slice = pool.slice(0, req.num);
    return toResponse(slice, firstIndex, hasMore || pool.length > req.num);
  },
};

async function fetchPage(
  q: string,
  req: SearchRequest,
  creds: ProviderCredentials,
  signal: AbortSignal,
  num: number,
  page: number,
): Promise<{ sources: SpecStreamSource[]; hasMore: boolean }> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('speed', 'fast');
  url.searchParams.set('num', String(num));
  if (page > 1) url.searchParams.set('page', String(page));
  if (req.gl) url.searchParams.set('country', req.gl.toUpperCase());
  const language = languageOf(req);
  if (language) url.searchParams.set('language', language);
  url.searchParams.set('safe', req.safe === 'active' ? 'moderate' : 'off');

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: { Accept: 'application/json', Authorization: `Bearer ${creds.apiKey}` },
      signal,
    });
  } catch (e) {
    throw new ProviderError('specstream', `network error: ${(e as Error).message}`);
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ProviderError('specstream', `credential rejected (${resp.status})`, resp.status, true);
  }
  // 402: the account's balance or monthly spending limit is used up. That is
  // the caller's own quota, surfaced as a 429 like any other provider's.
  if (resp.status === 402 || resp.status === 429) {
    throw new ProviderError('specstream', `upstream quota exhausted (${resp.status})`, resp.status, false, true);
  }
  if (!resp.ok) {
    let detail = '';
    try {
      const j = (await resp.json()) as { error?: { message?: unknown }; message?: unknown };
      const message = j.error?.message ?? j.message;
      if (typeof message === 'string') detail = `: ${message.slice(0, 120)}`;
    } catch {
      // non-JSON error body: status code alone is enough
    }
    const rejected = resp.status === 400 || resp.status === 422;
    throw new ProviderError('specstream', `HTTP ${resp.status}${detail}`, resp.status, false, false, rejected);
  }

  let body: SpecStreamResponse;
  try {
    body = (await resp.json()) as SpecStreamResponse;
  } catch {
    throw new ProviderError('specstream', 'malformed JSON from upstream');
  }
  const data = body.data;
  if (!data || typeof data !== 'object') {
    throw new ProviderError('specstream', 'malformed JSON from upstream');
  }
  return { sources: data.sources ?? [], hasMore: data.next_page !== null && data.next_page !== undefined };
}

function toResponse(slice: SpecStreamSource[], firstIndex: number, hasMore: boolean): NormalizedResponse {
  return {
    provider: 'specstream',
    results: slice.map((r) => ({
      title: r.title ?? '',
      link: r.url ?? '',
      snippet: r.snippet ?? '',
    })),
    totalResultsLowerBound: firstIndex + slice.length,
    hasMore,
  };
}

/** Google lr (lang_de) or hl (de, pt-BR) -> SpecStream's two-letter language. */
function languageOf(req: SearchRequest): string | undefined {
  const raw = req.lr ? req.lr.replace(/^lang_/, '') : req.hl;
  const m = /^([a-z]{2})(?:[-_].*)?$/i.exec(raw ?? '');
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Google dateRestrict (d5 / w2 / m6 / y1) -> SpecStream's `after:` operator,
 * which holds on every result. A bare unit (d, w, m, y) means one.
 */
export function dateRestrictToAfter(dr: string | undefined, now: Date = new Date()): string {
  const m = /^([dwmy])(\d*)$/i.exec((dr ?? '').trim());
  if (!m) return '';
  const n = m[2] === '' ? 1 : parseInt(m[2], 10);
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const unit = m[1].toLowerCase();
  if (unit === 'd') d.setUTCDate(d.getUTCDate() - n);
  if (unit === 'w') d.setUTCDate(d.getUTCDate() - 7 * n);
  if (unit === 'm') d.setUTCMonth(d.getUTCMonth() - n);
  if (unit === 'y') d.setUTCFullYear(d.getUTCFullYear() - n);
  return ` after:${d.toISOString().slice(0, 10)}`;
}

interface SpecStreamSource {
  url?: string;
  title?: string;
  site?: string;
  snippet?: string;
}

interface SpecStreamResponse {
  data?: {
    sources?: SpecStreamSource[];
    page?: number;
    next_page?: number | null;
  };
}
