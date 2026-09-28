/**
 * Provider routing with a real (stateful) circuit breaker and
 * pagination-sticky provider selection.
 *
 * Breaker semantics per provider:
 *  - CLOSED: requests flow. Consecutive failures are counted.
 *  - OPEN: after FAILURE_THRESHOLD consecutive failures, the provider is
 *    skipped until OPEN_MS elapses.
 *  - HALF-OPEN: after OPEN_MS, one trial request is allowed through; success
 *    closes the breaker, failure re-opens it.
 *
 * State lives in isolate memory: it is per-PoP and resets on eviction. That
 * is the right trade-off for a stateless worker — it protects each PoP from
 * hammering a dead upstream without adding a coordination dependency.
 *
 * Pagination stickiness: provider choice is keyed off a stable hash of the
 * query text, so page 2 of "foo" prefers the same provider that served
 * page 1 of "foo" (as long as it is healthy). Mixing providers across pages
 * of one query would duplicate or skip results.
 *
 * Failover policy:
 *  - Transient upstream errors (5xx, network, timeout) -> try next provider.
 *  - Credential errors (401/403) -> DO NOT fail over. The caller's own BYOK
 *    key is broken and silently switching providers would mask it (and spend
 *    a different account's quota without being asked).
 *  - Upstream quota errors (429) -> fail over ONLY if the caller opted in
 *    (failoverOnQuota), else surface as 429.
 */
import { ProviderError } from './types';
import type { NormalizedResponse, ProviderAdapter, ProviderCredentials, SearchRequest } from './types';

const FAILURE_THRESHOLD = 3;
const OPEN_MS = 30_000;
export const DEFAULT_TIMEOUT_MS = 4_000;

interface BreakerState {
  consecutiveFailures: number;
  openUntil: number; // epoch ms; 0 = closed
}

const breakers = new Map<string, BreakerState>();

function state(name: string): BreakerState {
  let s = breakers.get(name);
  if (!s) {
    s = { consecutiveFailures: 0, openUntil: 0 };
    breakers.set(name, s);
  }
  return s;
}

export function isAvailable(name: string, now = Date.now()): boolean {
  return state(name).openUntil <= now;
}

function recordSuccess(name: string): void {
  const s = state(name);
  s.consecutiveFailures = 0;
  s.openUntil = 0;
}

function recordFailure(name: string, now = Date.now()): void {
  const s = state(name);
  s.consecutiveFailures += 1;
  if (s.consecutiveFailures >= FAILURE_THRESHOLD) {
    s.openUntil = now + OPEN_MS;
    s.consecutiveFailures = 0; // half-open trial gets a fresh count
  }
}

/** Test hook. */
export function resetBreakers(): void {
  breakers.clear();
}

/** FNV-1a over the query for stable, cheap provider stickiness. */
export function stickyOrder<T>(items: T[], q: string): T[] {
  if (items.length <= 1) return items;
  let h = 0x811c9dc5;
  for (let i = 0; i < q.length; i++) {
    h ^= q.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const rot = h % items.length;
  return [...items.slice(rot), ...items.slice(0, rot)];
}

export interface RoutedProvider {
  adapter: ProviderAdapter;
  creds: ProviderCredentials;
}

export interface RouteOptions {
  timeoutMs?: number;
  failoverOnQuota?: boolean;
}

export async function routeSearch(
  req: SearchRequest,
  providers: RoutedProvider[],
  opts: RouteOptions = {},
): Promise<NormalizedResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ordered = stickyOrder(providers, req.q);
  const now = Date.now();

  // Prefer healthy providers; keep unhealthy ones as a last resort so a
  // fully-open board still attempts (half-open behaviour under pressure).
  const healthy = ordered.filter((p) => isAvailable(p.adapter.name, now));
  const candidates = healthy.length > 0 ? healthy : ordered;

  let lastError: unknown;
  for (const { adapter, creds } of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Race against the abort signal so the budget holds even if an
      // adapter implementation forgets to honor `signal`.
      const res = await Promise.race([
        adapter.search(req, creds, controller.signal),
        new Promise<never>((_, reject) =>
          controller.signal.addEventListener('abort', () =>
            reject(new ProviderError(adapter.name, `timed out after ${timeoutMs}ms`)),
          ),
        ),
      ]);
      recordSuccess(adapter.name);
      return res;
    } catch (e) {
      lastError = e;
      if (e instanceof ProviderError && e.isCredentialError) {
        // Caller's own key is bad: never mask this with failover.
        throw e;
      }
      if (e instanceof ProviderError && e.isQuotaError && !opts.failoverOnQuota) {
        throw e;
      }
      recordFailure(adapter.name);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError ?? new ProviderError('router', 'no providers configured');
}
