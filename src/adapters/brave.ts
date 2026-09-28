/**
 * Brave Search API adapter (BYOK — the key belongs to the caller's own
 * Brave account; this software only transforms requests and responses).
 *
 * Paging model differences vs Google:
 *  - Brave: `offset` is a PAGE index (0-based) over windows of `count`
 *    results (count <= 20). Google: `start` is a 1-based RESULT index.
 *  - Strategy: fetch the enclosing 20-result window and slice locally, so
 *    any legal (start, num) combination maps correctly.
 */
import { ProviderError } from '../types';
import type { NormalizedResponse, ProviderAdapter, ProviderCredentials, SearchRequest } from '../types';
import { effectiveQuery } from '../params';

const WINDOW = 20;

export const braveAdapter: ProviderAdapter = {
  name: 'brave',

  async search(req: SearchRequest, creds: ProviderCredentials, signal: AbortSignal): Promise<NormalizedResponse> {
    const firstIndex = req.start - 1; // 0-based index of first wanted result
    const page = Math.floor(firstIndex / WINDOW);
    const offsetInWindow = firstIndex - page * WINDOW;

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', effectiveQuery(req));
    url.searchParams.set('count', String(WINDOW));
    url.searchParams.set('offset', String(page));
    if (req.gl) url.searchParams.set('country', req.gl.toUpperCase());
    if (req.hl) url.searchParams.set('ui_lang', req.hl);
    if (req.lr) url.searchParams.set('search_lang', req.lr.replace(/^lang_/, ''));
    url.searchParams.set('safesearch', req.safe === 'active' ? 'moderate' : 'off');
    if (req.dateRestrict) {
      const f = dateRestrictToFreshness(req.dateRestrict);
      if (f) url.searchParams.set('freshness', f);
    }

    let resp: Response;
    try {
      resp = await fetch(url.toString(), {
        headers: { Accept: 'application/json', 'X-Subscription-Token': creds.apiKey },
        signal,
      });
    } catch (e) {
      throw new ProviderError('brave', `network error: ${(e as Error).message}`);
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new ProviderError('brave', `credential rejected (${resp.status})`, resp.status, true);
    }
    if (resp.status === 429) {
      throw new ProviderError('brave', 'upstream quota exhausted (429)', 429, false, true);
    }
    if (!resp.ok) {
      throw new ProviderError('brave', `upstream error ${resp.status}`, resp.status);
    }

    let data: BraveWebSearchResponse;
    try {
      data = (await resp.json()) as BraveWebSearchResponse;
    } catch {
      throw new ProviderError('brave', 'malformed JSON from upstream');
    }

    const raw = data.web?.results ?? [];
    const slice = raw.slice(offsetInWindow, offsetInWindow + req.num);

    return {
      provider: 'brave',
      results: slice.map((r) => ({
        title: r.title ?? '',
        link: r.url ?? '',
        snippet: stripTags(r.description ?? ''),
      })),
      // Brave reports no reliable total; expose only what we've actually seen.
      totalResultsLowerBound: firstIndex + raw.length - offsetInWindow,
      hasMore: data.query?.more_results_available === true || raw.length === WINDOW,
    };
  },
};

/** Google dateRestrict (d5 / w2 / m6 / y1) -> Brave freshness (pd/pw/pm/py). */
function dateRestrictToFreshness(dr: string): string | undefined {
  const m = /^([dwmy])(\d*)$/i.exec(dr.trim());
  if (!m) return undefined;
  return { d: 'pd', w: 'pw', m: 'pm', y: 'py' }[m[1].toLowerCase() as 'd' | 'w' | 'm' | 'y'];
}

/** Brave descriptions may carry <strong> markup; internal snippets are plain text. */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

interface BraveWebSearchResponse {
  query?: { more_results_available?: boolean };
  web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
}
