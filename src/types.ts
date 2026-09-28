/**
 * Internal, provider-agnostic types. Every adapter normalizes into these;
 * the Google formatter serializes out of these. Nothing provider-specific
 * may leak past this boundary.
 */

export interface SearchRequest {
  /** The search query (`q`). Required. */
  q: string;
  /** Programmable Search Engine id (`cx`). Accepted, mapped to a profile if one exists. */
  cx: string;
  /** 1-based index of the first result (`start`). Default 1. */
  start: number;
  /** Number of results requested (`num`). 1–10. Default 10. */
  num: number;
  /** Geolocation (`gl`), two-letter country code. */
  gl?: string;
  /** Interface language (`hl`). */
  hl?: string;
  /** Language restriction (`lr`), e.g. `lang_en`. */
  lr?: string;
  /** Country restriction (`cr`), e.g. `countryUS`. */
  cr?: string;
  /** SafeSearch: "active" | "off". Default "off". */
  safe: 'active' | 'off';
  /** Restrict to a site (`siteSearch`) with include/exclude (`siteSearchFilter`: i|e). */
  siteSearch?: string;
  siteSearchFilter?: 'i' | 'e';
  /** Date restriction (`dateRestrict`), e.g. d5, w2, m6, y1. */
  dateRestrict?: string;
  exactTerms?: string;
  excludeTerms?: string;
  fileType?: string;
  /** Sort expression, e.g. "date". */
  sort?: string;
  /** True when the request hit /customsearch/v1/siterestrict. */
  siteRestrictEndpoint: boolean;
}

export interface NormalizedResult {
  title: string;
  link: string;
  snippet: string;
  /** Optional structured data recovered from the provider (rare). */
  pagemap?: Record<string, unknown>;
  mime?: string;
  fileFormat?: string;
}

export interface NormalizedResponse {
  results: NormalizedResult[];
  /**
   * Lower-bound estimate of total results. Serialized into
   * `searchInformation.totalResults`. Never fabricate a large number:
   * clients use it (and queries.nextPage) to drive pagination loops.
   */
  totalResultsLowerBound: number;
  /** Whether the provider indicated more results exist past this window. */
  hasMore: boolean;
  /** Which provider actually served the request (for logging/telemetry). */
  provider: string;
  /** Search latency in seconds, if the provider reports it. */
  searchTimeSeconds?: number;
}

export interface ProviderAdapter {
  readonly name: string;
  /**
   * Fetch and normalize one page-window of results.
   * MUST throw ProviderError on any upstream failure (network, non-2xx,
   * malformed body) so the router's circuit breaker can act on it.
   */
  search(req: SearchRequest, creds: ProviderCredentials, signal: AbortSignal): Promise<NormalizedResponse>;
}

export interface ProviderCredentials {
  apiKey: string;
}

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    /** Upstream HTTP status if there was one. */
    public readonly upstreamStatus?: number,
    /** True for 401/403 from upstream: the customer's own key is bad — do NOT failover. */
    public readonly isCredentialError: boolean = false,
    /** True for 429 from upstream: the customer's own quota — do NOT failover silently. */
    public readonly isQuotaError: boolean = false,
    /**
     * True when the upstream rejected this specific query as invalid for the
     * caller's plan (e.g. Serper free tier: quoted domains). Another provider
     * may still answer it, so failover is allowed; if all fail it is a 400.
     */
    public readonly isQueryRejected: boolean = false,
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}
