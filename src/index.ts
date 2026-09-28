/**
 * cse-compat — a drop-in compatible endpoint for the retiring Google
 * Custom Search JSON API, backed by the caller's OWN upstream search
 * API keys (BYOK).
 *
 * Routes served:
 *   GET /customsearch/v1
 *   GET /customsearch/v1/siterestrict
 *
 * Configuration (Worker environment):
 *   PROXY_KEYS         optional comma-separated list of accepted `key=`
 *                      values. Unset => the proxy accepts any key
 *                      (for private self-hosted deployments); set it for
 *                      anything reachable from the internet.
 *   BRAVE_API_KEY      your own Brave Search API subscription token.
 *   SERPER_API_KEY     your own serper.dev API key.
 *   PROVIDER_ORDER     optional, default "brave,serper" filtered to the
 *                      providers that have keys configured.
 *   FAILOVER_ON_QUOTA  "true" to fail over to the next provider when one
 *                      returns 429 on YOUR key. Default false: your quota
 *                      problems are surfaced, not silently rerouted.
 *   TIMEOUT_MS         per-provider timeout budget. Default 4000.
 */
import { parseSearchParams } from './params';
import { formatGoogleResponse } from './googleFormat';
import {
  backendError,
  googleError,
  rateLimited,
  badApiKey,
  missingApiKey,
  notFound,
  upstreamCredentialError,
  upstreamQuotaError,
} from './errors';
import { routeSearch, DEFAULT_TIMEOUT_MS } from './router';
import type { RoutedProvider } from './router';
import { ProviderError } from './types';
import { braveAdapter } from './adapters/brave';
import { handleStats, type StatsKV } from './stats';
import { serperAdapter } from './adapters/serper';

export interface Env {
  PROXY_KEYS?: string;
  BRAVE_API_KEY?: string;
  SERPER_API_KEY?: string;
  PROVIDER_ORDER?: string;
  FAILOVER_ON_QUOTA?: string;
  TIMEOUT_MS?: string;
  /** Optional KV namespace for landing-page waitlist signups. */
  WAITLIST?: {
    get(key: string): Promise<string | null>;
    put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
    list?(opts: { prefix: string; cursor?: string }): Promise<{
      keys: { name: string }[];
      list_complete: boolean;
      cursor?: string;
    }>;
  };
  /** Secret for the private /stats page (16+ chars). Unset = page disabled. */
  STATS_KEY?: string;
  /** Optional Workers rate-limit binding applied to the public demo key, per visitor IP. */
  DEMO_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
  /** The public demo key (default "demo"). Requests with it get demo limits. */
  DEMO_KEY?: string;
  /** Max demo-key requests per UTC day across all visitors (default 150). Uses the WAITLIST KV. */
  DEMO_DAILY_CAP?: string;
}

export const DEMO_DAILY_MESSAGE =
  "The public demo has reached today's limit and resets at midnight UTC. " +
  'Self-host with your own (free-tier) key to keep testing: https://github.com/csecompat/cse-compat';

/**
 * Global daily budget for the demo key. KV is eventually consistent, so under
 * bursts the count can drift slightly past the cap; that is acceptable for a
 * demo budget and costs no extra infrastructure.
 */
async function demoDailyBudgetOk(env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<boolean> {
  if (!env.WAITLIST) return true;
  const cap = parseInt(env.DEMO_DAILY_CAP ?? '150', 10);
  const key = `demo-count:${new Date().toISOString().slice(0, 10)}`;
  const used = parseInt((await env.WAITLIST.get(key)) ?? '0', 10);
  if (used >= cap) return false;
  const write = env.WAITLIST.put(key, String(used + 1), { expirationTtl: 60 * 60 * 48 });
  if (ctx) ctx.waitUntil(write);
  else await write;
  return true;
}

export const DEMO_RATE_MESSAGE =
  'Demo limit reached: the public demo key allows 10 requests per minute per visitor. ' +
  'For unlimited use, self-host with your own key: https://github.com/csecompat/cse-compat';

export const DEMO_CREDITS_MESSAGE =
  'The public demo has used up its search credits for now. Self-host with your own ' +
  '(free-tier) key to keep testing: https://github.com/csecompat/cse-compat';

const ADAPTERS = { brave: braveAdapter, serper: serperAdapter } as const;
type ProviderName = keyof typeof ADAPTERS;

export function buildProviders(env: Env): RoutedProvider[] {
  const keys: Record<ProviderName, string | undefined> = {
    brave: env.BRAVE_API_KEY,
    serper: env.SERPER_API_KEY,
  };
  const order = (env.PROVIDER_ORDER ?? 'brave,serper')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderName => s in ADAPTERS);
  return order
    .filter((name) => Boolean(keys[name]))
    .map((name) => ({ adapter: ADAPTERS[name], creds: { apiKey: keys[name] as string } }));
}

function authorized(url: URL, headers: Headers, env: Env): 'ok' | 'missing' | 'bad' {
  // Google clients send the key as ?key= or the x-goog-api-key header.
  const presented = url.searchParams.get('key') ?? headers.get('x-goog-api-key');
  const allowed = (env.PROXY_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) return 'ok'; // open self-hosted mode
  if (!presented) return 'missing';
  return allowed.includes(presented) ? 'ok' : 'bad';
}

async function handleWaitlist(request: Request, env: Env): Promise<Response> {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (!env.WAITLIST) {
    return json(503, { ok: false, error: 'waitlist storage not configured' });
  }
  if (env.DEMO_LIMITER) {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const { success } = await env.DEMO_LIMITER.limit({ key: `waitlist:${ip}` });
    if (!success) return json(429, { ok: false, error: 'too many signups, try again in a minute' });
  }
  let email = '';
  try {
    const body = (await request.json()) as { email?: unknown };
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  } catch {
    return json(400, { ok: false, error: 'invalid JSON body' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json(400, { ok: false, error: 'invalid email' });
  }
  // Idempotent by key: re-signups just refresh the timestamp.
  await env.WAITLIST.put(`email:${email}`, JSON.stringify({ signedUpAt: new Date().toISOString() }));
  return json(200, { ok: true });
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    // Landing-page waitlist signups (static site itself is served by the
    // [assets] binding in wrangler.toml; the worker only sees non-asset routes).
    if (path === '/api/waitlist' && request.method === 'POST') {
      return handleWaitlist(request, env);
    }
    if (path === '/stats' && request.method === 'GET') {
      const kv = env.WAITLIST;
      return handleStats(url, {
        STATS_KEY: env.STATS_KEY,
        DEMO_DAILY_CAP: env.DEMO_DAILY_CAP,
        WAITLIST: kv && kv.list ? (kv as StatsKV) : undefined,
      });
    }

    const siteRestrict = path === '/customsearch/v1/siterestrict';
    if (path !== '/customsearch/v1' && !siteRestrict) {
      return notFound();
    }
    if (request.method !== 'GET') {
      return notFound();
    }

    const auth = authorized(url, request.headers, env);
    if (auth === 'missing') return missingApiKey();
    if (auth === 'bad') return badApiKey();

    const parsed = parseSearchParams(url, siteRestrict);
    if (!parsed.ok) return parsed.response;

    // Public demo key: throttle per visitor so many people can try it
    // without one script draining the shared upstream credits.
    const presentedKey = url.searchParams.get('key') ?? request.headers.get('x-goog-api-key');
    const isDemo = presentedKey === (env.DEMO_KEY ?? 'demo');
    if (isDemo && env.DEMO_LIMITER) {
      const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
      const { success } = await env.DEMO_LIMITER.limit({ key: `demo:${ip}` });
      if (!success) return rateLimited(DEMO_RATE_MESSAGE);
    }
    if (isDemo && !(await demoDailyBudgetOk(env, ctx))) {
      return rateLimited(DEMO_DAILY_MESSAGE);
    }

    const providers = buildProviders(env);
    if (providers.length === 0) {
      return backendError('No upstream provider configured. Set BRAVE_API_KEY and/or SERPER_API_KEY.');
    }

    try {
      const result = await routeSearch(parsed.req, providers, {
        timeoutMs: env.TIMEOUT_MS ? parseInt(env.TIMEOUT_MS, 10) : DEFAULT_TIMEOUT_MS,
        failoverOnQuota: env.FAILOVER_ON_QUOTA === 'true',
      });
      const body = formatGoogleResponse(result, parsed.req);
      return new Response(JSON.stringify(body, null, 1), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=UTF-8',
          'Cache-Control': 'private, max-age=0',
          'X-CSE-Compat-Provider': result.provider,
        },
      });
    } catch (e) {
      if (e instanceof ProviderError && e.isCredentialError) {
        return upstreamCredentialError(e.provider);
      }
      if (e instanceof ProviderError && e.isQuotaError) {
        return isDemo ? rateLimited(DEMO_CREDITS_MESSAGE) : upstreamQuotaError(e.provider);
      }
      if (e instanceof ProviderError && e.isQueryRejected) {
        // The query itself was refused (not a transient failure): clients must not retry.
        return googleError(
          400,
          `Your upstream search provider rejected this query (${e.message}). ` +
            'Some provider plans restrict patterns such as quoted domain names.',
          'invalid',
          'INVALID_ARGUMENT',
        );
      }
      if (e instanceof ProviderError) {
        // Say which upstream failed and how; never includes keys or query text.
        return backendError(`Backend Error (upstream ${e.message})`);
      }
      return backendError();
    }
  },
} satisfies ExportedHandler<Env>;
