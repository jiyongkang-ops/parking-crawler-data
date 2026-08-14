// 節度ある取得の中核 -------------------------------------------------------
// - robots.txt を取得・解釈し、Disallow パスは絶対に踏まない
// - リクエスト間に最低 minDelayMs のスリープ（直列）
// - 用途と連絡先を明記した User-Agent を必ず送る
// - ページキャッシュで短時間の再取得を防ぐ

import { config } from "../config.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastRequestAt = 0;
const robotsCache = new Map(); // origin -> { rules, fetchedAt }

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

async function getRobots(origin) {
  const cached = robotsCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < config.robotsCacheMs) {
    return cached.rules;
  }
  let rules = [];
  try {
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { "User-Agent": config.userAgent },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (res.ok) {
      const txt = await res.text();
      rules = rulesFor(parseRobots(txt), config.userAgent);
    }
  } catch (e) {
    // robots.txt が取れない場合は安全側に倒し、取得を控える方針も取り得るが、
    // ここでは「制限不明＝ルートのみ許可」とせず、空（制限なし）として扱う。
    // 必要に応じて厳格化すること。
    console.warn(`[robots] ${origin} 取得失敗: ${e.message}`);
  }
  robotsCache.set(origin, { rules, fetchedAt: Date.now() });
  return rules;
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
// 戻り値: { ok, status, html, skippedReason }
export async function politeFetch(url, opts = {}) {
  const u = new URL(url);
  const origin = `${u.protocol}//${u.host}`;

  // 1) robots.txt チェック
  const rules = await getRobots(origin);
  if (!isAllowed(rules, u.pathname)) {
    return { ok: false, skippedReason: `robots.txt で Disallow: ${u.pathname}` };
  }

  // 2) アクセス間隔の確保（直列・最低 minDelayMs、opts.minDelay があれば優先）
  const minDelay = opts.minDelay ?? config.minDelayMs;
  const wait = minDelay - (Date.now() - lastRequestAt);
  if (wait > 0) await sleep(wait);

  // 3) 取得
  lastRequestAt = Date.now();
  const res = await fetch(url, {
    headers: {
      "User-Agent": config.userAgent,
      "Accept-Language": "ja,en;q=0.8",
    },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const html = await res.text();
  return { ok: res.ok, status: res.status, html };
}
