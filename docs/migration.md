# Migrating to cse-compat, by client

The claim "change one URL" translates differently per client library. This page
shows the exact diff for the common ones. In every case: your parsing code,
your `items[]` handling, your pagination logic — unchanged.

Replace `https://cse.yourdomain.workers.dev` with your deployed Worker URL, and
use the `PROXY_KEYS` value you configured as the `key`.

---

## Raw HTTP (fetch / requests / curl / any language)

The majority of CSE integrations call the REST endpoint directly. The migration
is the hostname:

```diff
- https://www.googleapis.com/customsearch/v1?key=GOOGLE_KEY&cx=YOUR_CX&q=...
+ https://cse.yourdomain.workers.dev/customsearch/v1?key=PROXY_KEY&cx=YOUR_CX&q=...
```

If the base URL lives in an environment variable or config file (it usually
does), this is a config change and a redeploy — zero code.

---

## Python — `google-api-python-client`

The discovery-based client pins Google's host, but accepts an endpoint
override via `client_options`:

```diff
  from googleapiclient.discovery import build

  service = build(
      "customsearch", "v1",
      developerKey=API_KEY,
+     client_options={"api_endpoint": "https://cse.yourdomain.workers.dev"},
+     static_discovery=True,
  )
  res = service.cse().list(q="lectures", cx=CX).execute()   # unchanged
```

`static_discovery=True` (the default in recent versions) matters: it makes the
client use its bundled API description instead of fetching one from Google,
so nothing depends on Google's discovery service surviving the shutdown.

If you'd rather drop the heavyweight client, the equivalent in `requests` is:

```python
import requests

res = requests.get(
    "https://cse.yourdomain.workers.dev/customsearch/v1",
    params={"key": API_KEY, "cx": CX, "q": "lectures"},
).json()
# res["items"], res["queries"]["nextPage"], ... exactly as before
```

---

## Node.js — `googleapis`

Pass `rootUrl` when constructing the API:

```diff
  const { google } = require('googleapis');

- const customsearch = google.customsearch('v1');
+ const customsearch = google.customsearch({
+   version: 'v1',
+   rootUrl: 'https://cse.yourdomain.workers.dev',
+ });

  const res = await customsearch.cse.list({ auth: API_KEY, cx: CX, q: 'lectures' });
  // res.data.items — unchanged
```

---

## Anything else (Java, PHP, Go, Ruby, legacy internal tools)

Google's generated clients generally expose a root-URL or endpoint override
(`setRootUrl` in Java, `rootUrl` client options in Go). If yours doesn't, the
escape hatch that always works: replace the client call with one plain HTTPS
GET — the response body needs no new parsing, because it is the same JSON your
code already reads.

---

## What changes behaviorally

Be honest with yourself about these before flipping production traffic:

- **Ranking differs.** Results come from your configured provider's index
  (Brave, or Google via a SERP provider), not from Google's CSE ranking.
  Same shape, different ordering and coverage.
- **`searchType=image` is rejected** (loudly, HTTP 400) until implemented.
- **`pagemap` is absent** from results for now — if your code reads
  `item.pagemap`, guard it (well-written code already does, since Google
  omitted it for many results too).
- **CSE refinements, promotions, and synonyms** were CSE-console features and
  do not exist here.

Run `npm run diff-golden` against your deployment to see exactly which fields
your traffic would gain or lose — and if you still have a working Google key,
capture golden fixtures with `npm run capture` first. After 2027-01-01 that
option is gone.
