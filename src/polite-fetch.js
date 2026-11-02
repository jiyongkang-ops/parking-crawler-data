// 節度ある取得の中核 -------------------------------------------------------
// - robots.txt を取得・解釈し、Disallow パスは絶対に踏まない
// - robots.txt が 401・403（断られている）なら取りに行かない。届かない（通信の失敗・5xx）ときは10分見送る
// - リクエスト間に最低 minDelayMs のスリープ（直列）
// - 用途と連絡先を明記した User-Agent を必ず送る
// - ページキャッシュで短時間の再取得を防ぐ

import { config } from "../config.js";
import { maintenanceOf } from "./maintenance.js";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
const robotsCache = new Map(); // origin -> { kind, rules, status, why, fetchedAt, ttl }

/** fetch の例外を、原因が分かる文にする。Node の fetch は何が起きても「fetch failed」としか言わないので、
 *  e.cause.code（ENOTFOUND・ECONNREFUSED・ECONNRESET・UND_ERR_CONNECT_TIMEOUT など）を添える。
 *  AbortSignal.timeout で切れたときは TimeoutError（2026-10-17 のエコロは「fetch failed」だけで原因が分からなかった） */
export function fetchErrorText(e) {
  const c = e?.cause;
  // 接続の失敗は cause.code。IPv4/IPv6 の両方を試して失敗したときは cause.errors[].code に入る。符号が無ければ cause の文
  const code = c?.code ?? c?.errors?.find?.((x) => x?.code)?.code ?? (e?.name === "TimeoutError" ? "TIMEOUT" : null) ?? c?.message ?? null;
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
    // robots.txt の転送は追ってよい（RFC 9309 2.3.1.2・5回まで）が、1回ずつ間隔をあける（2026-11-02）
    let cur = `${origin}/robots.txt`;
    let res = await fetchOnce(cur);
    for (let hop = 0; hop < MAX_REDIRECTS && isRedirect(res.status) && res.headers.get("location"); hop++) {
      cur = new URL(res.headers.get("location"), cur).href;
      await res.text().catch(() => "");
      await pace(config.minDelayMs);
      res = await fetchOnce(cur);
    }
    const st = res.status;
    // 断られた・多すぎる・届かないの答えでも、中身がメンテナンスの告知なら一時的な見送りにする。
    // メンテナンスの告知を 403・429 で返すサイトがある（2026-10-22〜 ザ・パーク 403・あなぶき 429・近鉄不動産 403）
    const mt = !res.ok && (st === 401 || st === 403 || st === 429 || st >= 500) ? maintenanceOf(await res.text().catch(() => "")) : null;
    if (mt) entry = { kind: "maintenance", rules: [], status: st, why: `メンテナンス中（「${mt}」・HTTP ${st}）`, title: mt };
    else if (res.ok) {
      const txt = await res.text();
      entry = { kind: "ok", rules: rulesFor(parseRobots(txt), config.userAgent), status: st };
    } else if (st === 401 || st === 403) entry = { kind: "blocked", rules: [], status: st };
    else if (st >= 500 || st === 429) entry = { kind: "unreachable", rules: [], status: st, why: `HTTP ${st}` };
    else entry = { kind: "none", rules: [], status: st };
  } catch (e) {
    entry = { kind: "unreachable", rules: [], status: null, why: fetchErrorText(e) };
  }
  entry.fetchedAt = Date.now();
  entry.ttl = entry.kind === "unreachable" || entry.kind === "maintenance" ? (config.robotsUnreachableCacheMs ?? 10 * 60_000) : config.robotsCacheMs;
  // 取り直したときだけ1回出す（origin ごと。あとから「robots.txt が何を返していたか」を確かめられるように）
  const how = { ok: `HTTP ${entry.status}（規則${entry.rules.length}件）`, none: `HTTP ${entry.status}（無い＝制限なし）`,
    blocked: `HTTP ${entry.status}（断られている。この origin には取りに行かない）`,
    unreachable: `届かない: ${entry.why}（${Math.round(entry.ttl / 60_000)}分見送る）`,
    maintenance: `${entry.why}（${Math.round(entry.ttl / 60_000)}分見送る）` }[entry.kind];
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

// robots.txt の関所。取ってよければ null、だめなら politeFetch の戻り値の形（skippedReason つき）を返す
async function robotsGate(u) {
  const origin = `${u.protocol}//${u.host}`;
  const robots = await getRobots(origin);
  if (robots.kind === "blocked") {
    return { ok: false, blocked: true, status: robots.status, skippedReason: `robots.txt が HTTP ${robots.status}（断られている）` };
  }
  if (robots.kind === "unreachable") {
    return { ok: false, transient: true, status: null, skippedReason: "robots.txt に届かない（相手先の障害の可能性）", robotsError: robots.why };
  }
  if (robots.kind === "maintenance") {
    return { ok: false, transient: true, maintenance: robots.title, status: null, skippedReason: `相手先のサイトがメンテナンス中（「${robots.title}」）` };
  }
  if (!isAllowed(robots.rules, u.pathname)) {
    return { ok: false, skippedReason: `robots.txt で Disallow: ${u.pathname}` };
  }
  return null;
}

// 転送をたどる上限（RFC 9110 の目安の5回）
const MAX_REDIRECTS = 5;
const isRedirect = (st) => st === 301 || st === 302 || st === 303 || st === 307 || st === 308;
const originOf = (u) => `${u.protocol}//${u.host}`;

/** 1回だけ送る（転送は追わない）。間隔は呼ぶ側で取る */
async function fetchOnce(url) {
  return fetch(url, {
    headers: { "User-Agent": config.userAgent, "Accept-Language": "ja,en;q=0.8" },
    signal: AbortSignal.timeout(config.timeoutMs),
    redirect: "manual",
  });
}

// 節度を守って 1 件取得する。
// opts.minDelay でこの取得のアクセス間隔を上書き（事業者ごとの配慮に使う）。
// opts.redirect: "manual" で転送を追わない（閉じた物件をトップへ転送する社で、転送先を物件として読まないため。
//   追わない分、転送先のページを取りに行く1回も減る）。転送のときは status が 3xx、location に転送先が入る。
// opts.encoding: 本文の文字コード（"shift_jis" など）。無ければ今までどおり UTF-8 で読む（res.text()）。
//   MAYパークの一覧は Shift_JIS で、Content-Type に charset が無い。UTF-8 で読むと文字化けして0件になる（2026-11-02）
// 転送は fetch に任せず、1回ずつ自分でたどる（2026-11-02）。以前は fetch が転送をそのまま追っていたので、
//   ・転送先の robots.txt を見ていなかった（別のホストへの転送でも、同じホストの Disallow のパスへの転送でも）。
//     パークネットの robots.txt は「Disallow: /・Allow: /parknet/」で、改修で /parknet/ の外へ転送されると禁止のページを取ってしまう
//   ・転送の2回目を間をあけずにすぐ送っていた（パークネットの一覧は1ページごとに 302 と 200 の2回）
//   いまは転送のたびに、転送先の robots.txt（ホストとパス）を確かめ、いつもの間隔をあけてから送る。断られたら送らずに返す
//   （skippedReason は「転送先の…」）。別のホストへ移ったときは movedTo に転送先を入れる（run.js が health に残す。
//   http → https のようにホストが同じ転送は入れない。robots.txt は origin ごとに確かめる）
// 戻り値: { ok, status, html, skippedReason, location, url, movedTo }。本ページを送らなかったときは skippedReason が入り、
//   robots.txt で断られた（401・403）なら blocked: true、robots.txt に届かない（通信の失敗・5xx）なら transient: true
//   （別の origin への転送先の robots.txt で見送ったときは、どちらも付けず redirectBlocked: true。そのページ1件の見送り）
//   url は最後に取ったページの URL（転送をたどったときは転送先）
export async function politeFetch(url, opts = {}) {
  const start = new URL(url);

  // 1) robots.txt チェック
  const gate = await robotsGate(start);
  if (gate) return gate;

  // 2) アクセス間隔の確保（直列・最低 minDelayMs、opts.minDelay があれば優先）
  const minDelay = opts.minDelay ?? config.minDelayMs;
  await pace(minDelay);

  // 3) 取得。転送は1回ずつたどる
  let cur = start;
  let res = await fetchOnce(cur.href);
  for (let hop = 0; opts.redirect !== "manual" && isRedirect(res.status) && res.headers.get("location"); hop++) {
    const location = res.headers.get("location");
    await res.text().catch(() => "");   // 転送の本文は読まずに捨てる（接続を返すため）
    if (hop >= MAX_REDIRECTS) {
      console.warn(`[redirect] ${url}: 転送が${MAX_REDIRECTS}回を超えたので止めた（最後の転送先 ${location}）`);
      return { ok: false, status: res.status, html: "", location, url: cur.href };
    }
    const next = new URL(location, cur);
    const moved = next.host !== start.host ? { movedTo: next.href } : {};
    const g = await robotsGate(next);
    if (g) {
      console.warn(`[redirect] ${cur.href} → ${next.href}: 転送先の${g.skippedReason}。転送先は取りに行かない`);
      const skippedReason = `転送先（${next.host}）の ${g.skippedReason}`;
      // 別の origin の robots.txt で断られた・届かないのは、その転送先だけの話。blocked・transient・maintenance を付けたまま返すと、
      // run.js は「この社のサイトに断られた・届かない」としてその社の回をまるごと打ち切り、物件の時刻も進めないので、
      // 1件の物件が別のホストへ転送されるだけで毎回そこで止まり続ける（2026-11-02 点検の訂正）。
      // その物件1件の見送り（redirectBlocked。status は転送の 3xx）として返す。同じ origin なら robots.txt は同じなので今のまま
      if (originOf(next) !== originOf(start)) {
        return { ok: false, status: res.status, redirectBlocked: true, skippedReason,
          ...(g.robotsError ? { robotsError: g.robotsError } : {}), location, url: cur.href, ...moved };
      }
      return { ...g, skippedReason, location, url: cur.href, ...moved };
    }
    await pace(minDelay);
    cur = next;
    res = await fetchOnce(cur.href);
  }
  const html = await bodyText(res, opts.encoding);
  const moved = cur.host !== start.host ? { movedTo: cur.href } : {};
  return { ok: res.ok, status: res.status, html, location: res.headers.get("location"), url: cur.href, ...moved };
}

/** 本文を文字列にする。encoding があればその文字コードで読む（TextDecoder。Node の ICU は shift_jis・euc-jp を読める） */
async function bodyText(res, encoding) {
  if (!encoding) return res.text();
  return new TextDecoder(encoding).decode(await res.arrayBuffer());
}

/** robots.txt を見ずに、1ページだけ取る。メンテナンスの確かめ（markMaintenance）で、robots.txt が 401・403 だった社の
 *  入口（トップページ）を1回だけ見るためだけに使う（RFC 9309 2.3.1.3 では 4xx のときは取ってよい）。間隔は守る。
 *  転送は politeFetch と同じく1回ずつたどり、毎回間隔をあける。同じ origin の中の転送は robots.txt を見ない（4xx なので取ってよい）が、
 *  別の origin へ転送されたときは、その origin の robots.txt を確かめ、だめなら取りに行かない（2026-11-02） */
export async function fetchOnceIgnoringRobots(url, opts = {}) {
  const start = new URL(url);
  await pace(config.minDelayMs);
  let cur = start;
  let res = await fetchOnce(cur.href);
  for (let hop = 0; isRedirect(res.status) && res.headers.get("location"); hop++) {
    const location = res.headers.get("location");
    await res.text().catch(() => "");
    if (hop >= MAX_REDIRECTS) return { ok: false, status: res.status, html: "" };
    const next = new URL(location, cur);
    if (originOf(next) !== originOf(start) && await robotsGate(next)) return { ok: false, status: res.status, html: "" };
    await pace(config.minDelayMs);
    cur = next;
    res = await fetchOnce(cur.href);
  }
  return { ok: res.ok, status: res.status, html: await bodyText(res, opts.encoding).catch(() => "") };
}

/** 取れなかった理由の短い文。robots.txt で見送ったときは status が null なので、「HTTP null」ではなく見送りの理由を出す */
export function failText(res) {
  if (res?.skippedReason) return `${res.skippedReason}${res.robotsError ? `（${res.robotsError}）` : ""}`;
  return `HTTP ${res?.status}`;
}

/** robots.txt で断られた・届かない（本ページを送っていない）なら例外にする。一覧の作り直しで、残りのページも同じ答えになるとき用 */
export function throwIfRobotsSkipped(res, label) {
  if (res?.blocked || res?.transient) throw new Error(`${label}: ${failText(res)}`);
}

/** テスト用: robots.txt の控えを消す */
export function _resetRobotsCache() { robotsCache.clear(); lastRequestAt = 0; }
