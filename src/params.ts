/**
 * Parse and validate Google Custom Search JSON API query parameters,
 * enforcing the same constraints Google enforced, with the same error
 * envelope on violation.
 *
 * Documented constraints (developers.google.com/custom-search/v1):
 *  - num: integers 1–10 inclusive.
 *  - start: the API never returns more than 100 results; start + num must
 *    not exceed 101 (i.e. last requested index <= 100).
 *  - safe: "active" | "off".
 */
import type { SearchRequest } from './types';
import { invalidArgument } from './errors';

export type ParseResult = { ok: true; req: SearchRequest } | { ok: false; response: Response };

export function parseSearchParams(url: URL, siteRestrictEndpoint: boolean): ParseResult {
  const p = url.searchParams;

  const q = p.get('q');
  if (q === null || q === '') {
    return err(invalidArgument("Missing required parameter: 'q'"));
  }

  // cx is required by Google. We accept any non-empty value; unknown ids
  // behave as "search the whole web" unless a profile maps them.
  const cx = p.get('cx') ?? '';
  if (cx === '') {
    return err(invalidArgument("Request contains an invalid argument."));
  }

  let num = 10;
  if (p.has('num')) {
    num = intOr(p.get('num'), NaN);
    if (!Number.isInteger(num) || num < 1 || num > 10) {
      return err(invalidArgument(`Invalid value for parameter 'num': ${p.get('num')}. Valid values are integers between 1 and 10, inclusive.`));
    }
  }

  let start = 1;
  if (p.has('start')) {
    start = intOr(p.get('start'), NaN);
    if (!Number.isInteger(start) || start < 1) {
      return err(invalidArgument(`Invalid value for parameter 'start': ${p.get('start')}.`));
    }
  }
  if (start + num > 101) {
    return err(invalidArgument('Request contains an invalid argument.')); // Google's exact wording for the >100 window
  }

  const safeRaw = p.get('safe') ?? 'off';
  if (safeRaw !== 'active' && safeRaw !== 'off' && safeRaw !== 'high' && safeRaw !== 'medium') {
    return err(invalidArgument(`Invalid value for parameter 'safe': ${safeRaw}.`));
  }
  // Legacy values "high"/"medium" were deprecated aliases of "active".
  const safe: 'active' | 'off' = safeRaw === 'off' ? 'off' : 'active';

  const searchType = p.get('searchType');
  if (searchType !== null && searchType !== 'image') {
    return err(invalidArgument(`Invalid value for parameter 'searchType': ${searchType}.`));
  }
  if (searchType === 'image') {
    // v1 scope: web results only. Fail loudly and early rather than
    // returning web results shaped as images.
    return err(invalidArgument('searchType=image is not yet supported by this endpoint.'));
  }

  const siteSearchFilterRaw = p.get('siteSearchFilter');
  if (siteSearchFilterRaw !== null && siteSearchFilterRaw !== 'i' && siteSearchFilterRaw !== 'e') {
    return err(invalidArgument(`Invalid value for parameter 'siteSearchFilter': ${siteSearchFilterRaw}.`));
  }

  const req: SearchRequest = {
    q,
    cx,
    start,
    num,
    safe,
    gl: p.get('gl') ?? undefined,
    hl: p.get('hl') ?? undefined,
    lr: p.get('lr') ?? undefined,
    cr: p.get('cr') ?? undefined,
    siteSearch: p.get('siteSearch') ?? undefined,
    siteSearchFilter: (siteSearchFilterRaw as 'i' | 'e' | null) ?? undefined,
    dateRestrict: p.get('dateRestrict') ?? undefined,
    exactTerms: p.get('exactTerms') ?? undefined,
    excludeTerms: p.get('excludeTerms') ?? undefined,
    fileType: p.get('fileType') ?? undefined,
    sort: p.get('sort') ?? undefined,
    siteRestrictEndpoint,
  };
  return { ok: true, req };
}

function intOr(v: string | null, d: number): number {
  if (v === null || v.trim() === '' || !/^-?\d+$/.test(v.trim())) return d;
  return parseInt(v, 10);
}

function err(response: Response): ParseResult {
  return { ok: false, response };
}

/**
 * Compose the effective query string sent upstream, folding in the Google
 * parameters that providers have no native flag for. This mirrors what the
 * documented params mean, expressed as web search operators.
 */
export function effectiveQuery(req: SearchRequest): string {
  let q = req.q;
  if (req.exactTerms) q += ` "${req.exactTerms}"`;
  if (req.excludeTerms) {
    for (const t of req.excludeTerms.split(/\s+/).filter(Boolean)) q += ` -${t}`;
  }
  if (req.fileType) q += ` filetype:${req.fileType.replace(/^\./, '')}`;
  if (req.siteSearch) {
    q += req.siteSearchFilter === 'e' ? ` -site:${req.siteSearch}` : ` site:${req.siteSearch}`;
  }
  return q;
}
