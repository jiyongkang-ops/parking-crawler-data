// 節度ある取得の中核 -------------------------------------------------------
// - robots.txt を取得・解釈し、Disallow パスは絶対に踏まない
// - robots.txt が 401・403（断られている）なら取りに行かない。届かない（通信の失敗・5xx）ときは10分見送る
// - リクエスト間に最低 minDelayMs のスリープ（直列）
// - 用途と連絡先を明記した User-Agent を必ず送る
// - ページキャッシュで短時間の再取得を防ぐ

import { config } from "../config.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
const robotsCache = new Map(); // origin -> { kind, rules, status, why, fetchedAt, ttl }

/** fetch の例外を、原因が分かる文にする。Node の fetch は何が起きても「fetch failed」としか言わないので、
 *  e.cause.code（ENOTFOUND・ECONNREFUSED・ECONNRESET・UND_ERR_CONNECT_TIMEOUT など）を添える。
 *  AbortSignal.timeout で切れたときは TimeoutError（2026-10-17 のエコロは「fetch failed」だけで原因が分からなかった） */
export function fetchErrorText(e) {
  const code = e?.cause?.code ?? (e?.name === "TimeoutError" ? "TIMEOUT" : null);
  const msg = e?.message ?? String(e);
  return code && !msg.includes(code) ? `${msg}（${code}）` : msg;
}

/** アクセス間隔を空ける（直列・最低 minDelay）。robots.txt もこの間隔に入れる */
async function pace(minDelay) {
  const wait = minDelay - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);
  lastRequestAt = Date.now();
}

// robots.txt をごく単純に解釈する（User-agent: * と当ボットのブロックのみ対象）。
function parseRobots(txt) {
  const groups = [];
  let current = null;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (current && current.hasRules) current = null;
      if (!current) {
        current = { agents: [], rules: [], hasRules: false };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "disallow" && current) {
      current.hasRules = true;
      if (value) current.rules.push({ type: "disallow", path: value });
    } else if (field === "allow" && current) {
      current.hasRules = true;
      if (value) current.rules.push({ type: "allow", path: value });
    }
  }
  return groups;
}

function rulesFor(groups, uaToken) {
  // 当ボット名に一致するグループがあれば優先、なければ "*" を使う
  const ua = uaToken.toLowerCase();
  let chosen = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  if (!chosen) chosen = groups.find((g) => g.agents.includes("*"));
  return chosen ? chosen.rules : [];
}

// robots.txt の状態（origin ごと）。kind:
//   ok          … 取れた（2xx）。書かれた規則に従う
//   none        … 404 などの 4xx。規則なし＝制限なし（RFC 9309 で 4xx は「無い」と同じ）
//   blocked     … 401・403。当ボットを断っている。その origin には本ページを送らない
//   unreachable … 通信の失敗・タイムアウト・5xx・429。RFC 9309 では全面不許可として扱う決まり。
//                 その origin は robotsUnreachableCacheMs（10分）だけ見送り、過ぎたら robots.txt を取り直す
// 以前は 2xx 以外を全部「制限なし」として本ページを取りに行っていた。2026-10-17 のエコロは相手先が落ちていて
// robots.txt も取れなかったのに、45分間で257回取りに行った。robots.txt まで 403 の社（スペース二十四）にも送っていた
async function getRobots(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < cached.ttl) return cached;
  let entry;
  try {
    await pace(config.minDelayMs);
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": config.userAgent },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    const st = res.status;
    if (res.ok) {
      const txt = await res.text();
      entry = { kind: "ok", rules: rulesFor(parseRobots(txt), config.userAgent), status: st };
    } else if (st === 401 || st === 403) entry = { kind: "blocked", rules: [], status: st };
    else if (st >= 500 || st === 429) entry = { kind: "unreachable", rules: [], status: st, why: `HTTP ${st}` };
    else entry = { kind: "none", rules: [], status: st };
  } catch (e) {
    entry = { kind: "unreachable", rules: [], status: null, why: fetchErrorText(e) };
  }
  entry.fetchedAt = Date.now();
  entry.ttl = entry.kind === "unreachable" ? (config.robotsUnreachableCacheMs ?? 10 * 60_000) : config.robotsCacheMs;
  // 取り直したときだけ1回出す（origin ごと。あとから「robots.txt が何を返していたか」を確かめられるように）
  const how = { ok: `HTTP ${entry.status}（規則${entry.rules.length}件）`, none: `HTTP ${entry.status}（無い＝制限なし）`,
    blocked: `HTTP ${entry.status}（断られている。この origin には取りに行かない）`,
    unreachable: `届かない: ${entry.why}（${Math.round(entry.ttl / 60_000)}分見送る）` }[entry.kind];
  (entry.kind === "ok" || entry.kind === "none" ? console.log : console.warn)(`[robots] ${origin} ${how}`);
  robotsCache.set(origin, entry);
  return entry;
}

// robots.txt の判定（RFC 9309 準拠）:
// パスに前方一致するルールのうち「最も長いもの」が勝ち、同じ長さなら Allow を優先する。
// 例）Disallow: / ＋ Allow: /parknet/ のサイトでは /parknet/... は許可される。
// （以前は Allow を無視していたため、部分許可のサイトを丸ごとブロックしていた）
function isAllowed(rules, pathname) {
  let best = null;
  for (const r of rules) {
    if (!r.path || !pathname.startsWith(r.path)) continue;
    if (!best || r.path.length > best.path.length
      || (r.path.length === best.path.length && r.type === "allow")) best = r;
  }
  return !best || best.type === "allow";
}

// 節度を守って 1 件取得する。
// opts.minDelay でこの取得のアクセス間隔を上書き（事業者ごとの配慮に使う）。
// opts.redirect: "manual" で転送を追わない（閉じた物件をトップへ転送する社で、転送先を物件として読まないため。
//   追わない分、転送先のページを取りに行く1回も減る）。転送のときは status が 3xx、location に転送先が入る。
// 戻り値: { ok, status, html, skippedReason, location }。本ページを送らなかったときは skippedReason が入り、
//   robots.txt で断られた（401・403）なら blocked: true、robots.txt に届かない（通信の失敗・5xx）なら transient: true
export async function politeFetch(url, opts = {}) {
  const u = new URL(url);
  const origin = `${u.protocol}//${u.host}`;

  // 1) robots.txt チェック
  const robots = await getRobots(origin);
  if (robots.kind === "blocked") {
    return { ok: false, blocked: true, status: robots.status, skippedReason: `robots.txt が HTTP ${robots.status}（断られている）` };
  }
  if (robots.kind === "unreachable") {
    return { ok: false, transient: true, status: null, skippedReason: "robots.txt に届かない（相手先の障害の可能性）", robotsError: robots.why };
  }
  if (!isAllowed(robots.rules, u.pathname)) {
    return { ok: false, skippedReason: `robots.txt で Disallow: ${u.pathname}` };
  }

  // 2) アクセス間隔の確保（直列・最低 minDelayMs、opts.minDelay があれば優先）
  await pace(opts.minDelay ?? config.minDelayMs);

  // 3) 取得
  const res = await fetch(url, {
    headers: {
      "User-Agent": config.userAgent,
      "Accept-Language": "ja,en;q=0.8",
    },
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: opts.redirect === "manual" ? "manual" : "follow",
  });
  const html = await res.text();
  return { ok: res.ok, status: res.status, html, location: res.headers.get("location") };
}

/** テスト用: robots.txt の控えを消す */
export function _resetRobotsCache() { robotsCache.clear(); lastRequestAt = 0; }
