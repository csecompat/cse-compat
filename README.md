# cse-compat

**A drop-in compatible endpoint for the retiring Google Custom Search JSON API — bring your own search API key, keep your code unchanged.**

Google shuts down the Custom Search JSON API on **January 1, 2027**. Every app calling `https://www.googleapis.com/customsearch/v1` breaks that day. `cse-compat` is a tiny Cloudflare Worker that serves the **same endpoint, same parameters, same response schema, same error envelope** — backed by *your own* API key from a modern search provider (Brave Search API, serper.dev, more coming).

Migration is the base URL and the key:

```diff
- https://www.googleapis.com/customsearch/v1?key=GOOGLE_KEY&cx=YOUR_CX&q=best+pizza
+ https://your-worker.example.workers.dev/customsearch/v1?key=YOUR_PROXY_KEY&cx=YOUR_CX&q=best+pizza
```

Everything downstream — `items[].link`, `items[].snippet`, `queries.nextPage`, `searchInformation.totalResults`, error handling — keeps working.

## Why BYOK (bring your own key)?

`cse-compat` never resells anyone's search data. **You** hold the account with the upstream provider; this software only translates request/response formats between their API and the legacy Google schema. That keeps you squarely inside the upstream providers' terms (you are their direct customer) and keeps this project a pure compatibility layer.

## Quick start

```bash
git clone <this repo> && cd cse-compat
npm install
npx wrangler secret put BRAVE_API_KEY     # your own Brave Search API token, and/or:
npx wrangler secret put SERPER_API_KEY    # your own serper.dev key
npx wrangler secret put PROXY_KEYS        # comma-separated keys your clients will send as ?key=
npx wrangler deploy
```

Then point your existing code's base URL at the worker. Done.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `BRAVE_API_KEY` | one of these | Your Brave Search API subscription token |
| `SERPER_API_KEY` | one of these | Your serper.dev API key |
| `PROXY_KEYS` | recommended | Accepted `?key=` values. Unset ⇒ open (private deployments only) |
| `PROVIDER_ORDER` | no | Default `brave,serper`, filtered to configured providers |
| `FAILOVER_ON_QUOTA` | no | `true` ⇒ on a 429 from one of *your* upstream keys, try the next provider. Default `false` (your quota problems are surfaced, not hidden) |
| `TIMEOUT_MS` | no | Per-provider timeout budget (default 4000) |

## Compatibility contract

Implemented and covered by the conformance test suite:

- `GET /customsearch/v1` and `GET /customsearch/v1/siterestrict`
- Params: `q`, `cx`, `key` (query or `x-goog-api-key` header), `num` (1–10 enforced), `start` (100-result window enforced), `safe`, `gl`, `hl`, `lr`, `cr`, `siteSearch`, `siteSearchFilter`, `dateRestrict`, `exactTerms`, `excludeTerms`, `fileType`, `sort`
- Envelope: `kind`, `url`, `queries.request/nextPage/previousPage`, `context`, `searchInformation`, `items[]`
- Per-result: `title`, `htmlTitle` (with `<b>` highlighting), `link`, `displayLink`, `snippet`, `htmlSnippet`, `formattedUrl`, `htmlFormattedUrl`
- `items` omitted when zero results (clients test membership)
- `totalResults` is an honest lower bound — no fabricated totals to send your pagination loop into orbit
- Google-exact error envelope: `400 INVALID_ARGUMENT`, `403 PERMISSION_DENIED`, `429 RESOURCE_EXHAUSTED`, `500 backendError` — never a `402`

Not yet implemented (PRs welcome): `searchType=image` (rejected loudly, not silently mis-served), `pagemap` reconstruction, cx→site-profile mapping, `orTerms`/`linkSite`/`lowRange`/`highRange`, `spelling` suggestions.

## Architecture

```
request ──▶ auth ──▶ param validation ──▶ router ──▶ adapter(Brave) ─┐
 (Google shape)      (Google-exact 400s)    │                        ├─▶ normalize ─▶ Google formatter ─▶ response
                                            └──▶ adapter(Serper) ────┘                 (legacy schema)
```

- **Adapter pattern** — each provider implements `search(req, creds, signal) → NormalizedResponse`. Adding a provider is one file.
- **Stateful circuit breaker** — 3 consecutive failures opens a provider for 30 s (per PoP); half-open trials recover it. Timeouts are enforced even against adapters that ignore the abort signal.
- **Pagination stickiness** — provider choice is keyed to a stable hash of the query, so page 2 comes from the same index as page 1.
- **Credential vs. transient failures** — a 401/403 on *your* upstream key never silently fails over (that would mask your misconfiguration and spend a different account's quota); 5xx/timeouts do.
- **Stateless by design** — no query logging, no result caching, nothing stored.

## Migration guides

Per-client diffs (python google-api-python-client, node googleapis, raw HTTP) live in [docs/migration.md](docs/migration.md).

## Development

```bash
npm test          # conformance + router suites (fixtures, no network)
npm run typecheck
npm run dev       # local wrangler dev server
```

## Legal notes

- This project is not affiliated with or endorsed by Google. "Google" and "Custom Search" are trademarks of Google LLC, referenced only to describe compatibility.
- BYOK means you are bound by your own upstream provider's terms (e.g., Brave's attribution requirements apply to your application). Read them.

## License

Apache-2.0
