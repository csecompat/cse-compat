/**
 * Private stats page: GET /stats?key=<STATS_KEY>
 *
 * Shows waitlist signups and public-demo usage in one place. Anything other
 * than the exact STATS_KEY gets a plain 404, so the page doesn't reveal that
 * it exists. The page is never cached and asks search engines not to index it.
 */

export interface StatsKV {
  get(key: string): Promise<string | null>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface StatsEnv {
  STATS_KEY?: string;
  WAITLIST?: StatsKV;
  DEMO_DAILY_CAP?: string;
}

const DAYS = 14;

export async function handleStats(url: URL, env: StatsEnv, now = new Date()): Promise<Response> {
  const presented = url.searchParams.get('key') ?? '';
  // Refuse to serve at all unless a reasonably long key is configured.
  if (!env.STATS_KEY || env.STATS_KEY.length < 16 || !timingSafeEqual(presented, env.STATS_KEY)) {
    return new Response('Not Found', { status: 404 });
  }
  if (!env.WAITLIST) {
    return new Response('Storage not configured', { status: 503 });
  }

  const signups = await loadSignups(env.WAITLIST);
  const demo = await loadDemoDays(env.WAITLIST, now);
  const cap = parseInt(env.DEMO_DAILY_CAP ?? '150', 10);

  return new Response(renderPage(signups, demo, cap, now), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

interface Signup {
  email: string;
  at: string;
}

async function loadSignups(kv: StatsKV): Promise<Signup[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'email:', cursor });
    for (const k of page.keys) names.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const out: Signup[] = [];
  for (const name of names) {
    const raw = await kv.get(name);
    let at = '';
    try {
      at = (JSON.parse(raw ?? '{}') as { signedUpAt?: string }).signedUpAt ?? '';
    } catch {
      at = '';
    }
    out.push({ email: name.slice('email:'.length), at });
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return out;
}

async function loadDemoDays(kv: StatsKV, now: Date): Promise<{ day: string; count: number }[]> {
  const days: { day: string; count: number }[] = [];
  for (let i = 0; i < DAYS; i++) {
    const d = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const v = parseInt((await kv.get(`demo-count:${d}`)) ?? '0', 10);
    days.push({ day: d, count: Number.isFinite(v) ? v : 0 });
  }
  return days;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPage(signups: Signup[], demo: { day: string; count: number }[], cap: number, now: Date): string {
  const today = demo[0]?.count ?? 0;
  const week = demo.slice(0, 7).reduce((n, d) => n + d.count, 0);
  const max = Math.max(cap, ...demo.map((d) => d.count), 1);
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const newThisWeek = signups.filter((s) => s.at >= since).length;

  const bars = [...demo]
    .reverse()
    .map((d) => {
      const pct = Math.round((d.count / max) * 100);
      const label = d.day.slice(5);
      return `<div class="bar" title="${esc(d.day)}: ${d.count}"><div class="fill${d.count >= cap ? ' full' : ''}" style="height:${pct}%"></div><span class="n">${d.count}</span><span class="d">${esc(label)}</span></div>`;
    })
    .join('');

  const rows = signups.length
    ? signups
        .map((s) => `<tr><td>${esc(s.email)}</td><td class="t">${esc(s.at.replace('T', ' ').slice(0, 16))}</td></tr>`)
        .join('')
    : '<tr><td colspan="2" class="empty">No signups yet.</td></tr>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>cse-compat stats</title>
<style>
:root{--bg:#121212;--surface:#171717;--line:#262626;--ink:#EDEDED;--body:#A1A1A1;--faint:#6B6B6B;--green:#3ECF8E;--amber:#F5B544;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:15px/1.6 -apple-system,'Segoe UI',sans-serif;padding:32px 20px 64px}
.col{max-width:860px;margin:0 auto}
h1{font:600 20px/1.2 ui-monospace,Menlo,monospace;color:var(--ink);margin:0 0 4px}
.sub{color:var(--faint);font-size:13px;margin:0 0 28px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:28px}
@media (max-width:640px){.tiles{grid-template-columns:repeat(2,1fr)}}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
.tile .v{font:600 28px/1.1 ui-monospace,Menlo,monospace;color:var(--ink);font-variant-numeric:tabular-nums}
.tile .k{font-size:12px;color:var(--faint);margin-top:4px}
h2{font-size:14px;font-weight:600;color:var(--ink);margin:0 0 12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:20px}
.chart{display:flex;align-items:flex-end;gap:6px;height:160px;padding-top:18px}
.bar{flex:1;height:100%;position:relative;display:flex;flex-direction:column;justify-content:flex-end}
.fill{background:var(--green);border-radius:3px 3px 0 0;min-height:1px;opacity:.85}
.fill.full{background:var(--amber)}
.bar .n{position:absolute;top:-2px;left:0;right:0;text-align:center;font:11px ui-monospace,Menlo,monospace;color:var(--body)}
.bar .d{font:10px ui-monospace,Menlo,monospace;color:var(--faint);text-align:center;margin-top:4px;white-space:nowrap}
.note{font-size:12px;color:var(--faint);margin:10px 0 0}
.tw{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:8px 4px;border-bottom:1px solid var(--line);color:var(--ink)}
td.t{color:var(--faint);font:12px ui-monospace,Menlo,monospace;white-space:nowrap;text-align:right}
td.empty{color:var(--faint)}
</style></head><body><div class="col">
<h1>cse-compat stats</h1>
<p class="sub">Private. Generated ${esc(now.toISOString().replace('T', ' ').slice(0, 16))} UTC. Refresh the page to update.</p>
<div class="tiles">
  <div class="tile"><div class="v">${signups.length}</div><div class="k">waitlist signups (total)</div></div>
  <div class="tile"><div class="v">${newThisWeek}</div><div class="k">new signups, last 7 days</div></div>
  <div class="tile"><div class="v">${today}<span style="font-size:14px;color:var(--faint)"> / ${cap}</span></div><div class="k">demo searches today</div></div>
  <div class="tile"><div class="v">${week}</div><div class="k">demo searches, last 7 days</div></div>
</div>
<div class="card"><h2>Demo searches per day (UTC)</h2><div class="chart">${bars}</div>
<p class="note">Amber means the daily demo cap was reached. Each demo search uses one Serper credit.</p></div>
<div class="card"><h2>Waitlist (newest first)</h2><div class="tw"><table>${rows}</table></div></div>
<p class="note">Page visits: Cloudflare dashboard → Analytics &amp; Logs → Web Analytics. Requests and errors: Workers &amp; Pages → cse-compat → Metrics.</p>
</div></body></html>`;
}
