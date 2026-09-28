/**
 * Serialize a NormalizedResponse into the exact legacy Custom Search JSON
 * envelope. Field order is kept close to Google's for byte-diff friendliness,
 * though JSON field order is not semantically meaningful.
 *
 * Compatibility rules encoded here:
 *  - `items` is OMITTED entirely when there are zero results (clients do
 *    `if 'items' in response`).
 *  - `queries.nextPage` is present only when another page exists AND the
 *    next window would still start at index <= 91 (the 100-result cap).
 *  - `totalResults` is a STRING, and is a lower bound — never a fabricated
 *    large number, or clients' pagination loops run away.
 *  - `htmlTitle` / `htmlSnippet` carry <b> highlighting of query terms over
 *    HTML-escaped text, as the legacy API did.
 */
import type { NormalizedResponse, SearchRequest } from './types';

const TEMPLATE =
  'https://www.googleapis.com/customsearch/v1?q={searchTerms}&num={count?}&start={startIndex?}&lr={language?}&safe={safe?}&cx={cx?}&sort={sort?}&filter={filter?}&gl={gl?}&cr={cr?}&googlehost={googleHost?}&c2coff={disableCnTwTranslation?}&hq={hq?}&hl={hl?}&siteSearch={siteSearch?}&siteSearchFilter={siteSearchFilter?}&exactTerms={exactTerms?}&excludeTerms={excludeTerms?}&linkSite={linkSite?}&orTerms={orTerms?}&dateRestrict={dateRestrict?}&lowRange={lowRange?}&highRange={highRange?}&searchType={searchType}&fileType={fileType?}&rights={rights?}&imgSize={imgSize?}&imgType={imgType?}&imgColorType={imgColorType?}&imgDominantColor={imgDominantColor?}&alt=json';

export function formatGoogleResponse(res: NormalizedResponse, req: SearchRequest): Record<string, unknown> {
  const count = res.results.length;
  const searchTime = res.searchTimeSeconds ?? 0.2;
  const totalResults = String(Math.max(res.totalResultsLowerBound, req.start - 1 + count));

  const requestQuery = pageQuery(req, req.start, count, totalResults);

  const queries: Record<string, unknown[]> = { request: [requestQuery] };
  const nextStart = req.start + count;
  if (res.hasMore && count > 0 && nextStart <= 91 + (10 - req.num)) {
    // next window must still fit inside the 100-result cap
    if (nextStart + req.num <= 101) {
      queries.nextPage = [pageQuery(req, nextStart, req.num, totalResults)];
    }
  }
  if (req.start > 1) {
    const prevStart = Math.max(1, req.start - req.num);
    queries.previousPage = [pageQuery(req, prevStart, req.num, totalResults)];
  }

  const body: Record<string, unknown> = {
    kind: 'customsearch#search',
    url: { type: 'application/json', template: TEMPLATE },
    queries,
    context: { title: 'cse-compat' },
    searchInformation: {
      searchTime,
      formattedSearchTime: searchTime.toFixed(2),
      totalResults,
      formattedTotalResults: formatWithCommas(totalResults),
    },
  };

  if (count > 0) {
    body.items = res.results.map((r) => {
      const escapedTitle = escapeHtml(r.title);
      const escapedSnippet = escapeHtml(r.snippet);
      const item: Record<string, unknown> = {
        kind: 'customsearch#result',
        title: r.title,
        htmlTitle: highlight(escapedTitle, req.q),
        link: r.link,
        displayLink: hostnameOf(r.link),
        snippet: r.snippet,
        htmlSnippet: highlight(escapedSnippet, req.q),
        formattedUrl: r.link,
        htmlFormattedUrl: escapeHtml(r.link),
      };
      if (r.mime) item.mime = r.mime;
      if (r.fileFormat) item.fileFormat = r.fileFormat;
      if (r.pagemap) item.pagemap = r.pagemap;
      return item;
    });
  }

  return body;
}

function pageQuery(req: SearchRequest, startIndex: number, count: number, totalResults: string) {
  const o: Record<string, unknown> = {
    title: `Google Custom Search - ${req.q}`,
    totalResults,
    searchTerms: req.q,
    count,
    startIndex,
    inputEncoding: 'utf8',
    outputEncoding: 'utf8',
    safe: req.safe,
    cx: req.cx,
  };
  if (req.gl) o.gl = req.gl;
  if (req.hl) o.hl = req.hl;
  if (req.lr) o.language = req.lr;
  if (req.sort) o.sort = req.sort;
  if (req.siteSearch) o.siteSearch = req.siteSearch;
  if (req.siteSearchFilter) o.siteSearchFilter = req.siteSearchFilter;
  if (req.exactTerms) o.exactTerms = req.exactTerms;
  if (req.excludeTerms) o.excludeTerms = req.excludeTerms;
  if (req.fileType) o.fileType = req.fileType;
  if (req.dateRestrict) o.dateRestrict = req.dateRestrict;
  return o;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Bold occurrences of each query term (case-insensitive, on word-ish
 * boundaries) the way legacy htmlSnippet did. Operates on already-escaped
 * text; terms themselves are regex-escaped.
 */
export function highlight(escapedText: string, q: string): string {
  const terms = q
    .replace(/["\-]|site:\S+|filetype:\S+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  let out = escapedText;
  for (const term of new Set(terms.map((t) => t.toLowerCase()))) {
    const safe = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![\\w&#;])(${safe})`, 'gi'), '<b>$1</b>');
  }
  return out;
}

function hostnameOf(link: string): string {
  try {
    return new URL(link).hostname;
  } catch {
    return link;
  }
}

function formatWithCommas(numeric: string): string {
  return numeric.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
