# Launch post drafts

Drafts for the validation/outreach phase. Voice: honest, technical, no hype —
these communities punish marketing tone and reward specifics. Post only after
the repo is public and one live demo deployment exists; every thread should
end with a URL people can `curl`.

---

## Show HN

**Title:** Show HN: cse-compat – drop-in replacement for Google's dying Custom Search JSON API

**Body:**

Google shuts down the Custom Search JSON API on January 1, 2027 (it's been
closed to new customers since January). The official migration paths are
Vertex AI Search (≤50 domains, your own corpus) or a partner-only "Web Search
Service" with no published pricing. Everything else — Brave, Serper, Exa —
means rewriting your response parsing.

cse-compat is a small Cloudflare Worker that serves `customsearch/v1` with the
legacy contract intact: same params (num/start limits enforced with Google's
exact 400s), same envelope (`items[]`, `htmlSnippet` highlighting,
`queries.nextPage`), same error format (429 RESOURCE_EXHAUSTED, never a 402
your client library has no case for). You point it at your own Brave or
Serper key — BYOK, so it resells nothing and there's no markup. Apache-2.0.

Honest limitations: ranking comes from your provider's index, not Google's;
`searchType=image` and `pagemap` aren't implemented yet; CSE console features
(refinements, promotions) don't exist here. There's a structural-diff tool in
the repo that compares a deployment's output against golden fixtures captured
from the real API — if you still have a working key, capture yours now; after
Jan 1 they can't be regenerated.

Repo: https://github.com/csecompat/cse-compat — demo: `curl "https://csecompat.com/customsearch/v1?key=demo&cx=test&q=hello"`

---

## Reddit r/googlecloud or r/webscraping

**Title:** Google CSE JSON API dies Jan 1 — I built an open-source drop-in so you only change the base URL

**Body:**

If you're one of the people with production code against
`googleapis.com/customsearch/v1`, you've probably seen the migration notices.
I didn't want to rewrite parsers across several apps, so I built a translator
worker instead: it accepts Google's exact request format and returns Google's
exact response format, fetching from Brave/Serper with **your** API key
underneath.

- One env-var change to migrate (guides for python-client and googleapis-node
  overrides included — `client_options`/`rootUrl`, since the official clients
  hardcode the host)
- Google-exact error envelopes so retry/backoff code keeps working
- Circuit breaker + failover between providers; page 2 stays on the same index
- Stateless: no query logging
- Apache-2.0, self-host on Cloudflare's free tier

What it doesn't do (yet): image search, pagemap. And ranking is the provider's,
not Google's — same shape, different results.

Repo: https://github.com/csecompat/cse-compat. If you have a working CSE key, the repo has a fixture-capture
script — golden responses from the real API become irreplaceable after the
shutdown, and PRs adding cases are very welcome.

---

## dev.to article outline

**Title:** "Google's Custom Search JSON API dies in N days. Here's the migration that doesn't touch your parser."

1. What's shutting down, exactly (dates, who's affected, the closed-to-new-customers detail)
2. Why the official paths hurt (Vertex ≠ web search; partner API is gated)
3. The three migration strategies: rewrite for a new provider / self-host a bridge / compatibility proxy
4. Anatomy of the legacy contract — the fields people underestimate (`htmlSnippet` bolding, `queries.nextPage`, the 100-result window, error envelopes)
5. Walkthrough: deploy cse-compat, one config change per client library
6. The honest deltas table (ranking, pagemap, image search)
7. Capture your golden fixtures before Jan 1 — regardless of which migration you pick

---

## Direct outreach template (GitHub issues / maintainers)

> Hi — saw [project] calls the Google Custom Search JSON API, which shuts down
> 2027-01-01 (already closed to new signups). I maintain cse-compat, an
> Apache-2.0 worker that serves the same endpoint/schema backed by a
> Brave/Serper key, so [project] users could migrate with a base-URL config
> change instead of a parser rewrite. Happy to open a PR adding it as a
> documented option, or answer questions. Repo: https://github.com/csecompat/cse-compat

Rules for outreach: only projects with real CSE usage in code (search GitHub
for `customsearch/v1` and `googleapis.com/customsearch`); one message, no
follow-up spam; lead with their problem, not the product.

---

## Validation tracker

Log every conversation. Kill threshold (set 2026-09-28): fewer than 20
waitlist signups or fewer than 5 credible "I would pay for the managed
version" by ~2026-10-12 → pivot or stop.

| Date | Where | Who | Signal (pain? would pay? self-host?) |
|---|---|---|---|
|  |  |  |  |
