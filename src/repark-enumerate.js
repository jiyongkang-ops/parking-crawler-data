// リパーク全物件の列挙とローリング巡回の状態管理 ---------------------------
// repark には一括APIが無く 1物件=1ページ取得しかないため、全国16,000件超を
// 一度に取得するのは「節度ある収集」と両立しない。
// そこで sitemap から全 parkId を列挙し、「最も長く取得していないものから順に
// 毎回 N 件だけ」取得するローリング方式で、数日かけて全国を1巡する。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP_URL = "https://www.repark.jp/sitemap_park.xml";

// sitemap をローカルにキャッシュし、parkId 一覧を返す。
export async function getAllParkIds({ cacheFile, cacheMs }) {
  let xml = null;
  const abs = path.resolve(cacheFile);
  if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
    xml = fs.readFileSync(abs, "utf8");
  } else {
    const res = await politeFetch(SITEMAP_URL);
    if (res.skippedReason) throw new Error(`sitemap: ${res.skippedReason}`);
    if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
    xml = res.html;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, xml);
  }
  // www 版の detail URL から park= の値だけを重複なく拾う
  const ids = new Set();
  const re = /result\/detail\/\?park=(REP\d+)/g;
  let m;
  while ((m = re.exec(xml))) ids.add(m[1]);
  return [...ids];
}

// ローリング状態（parkId -> 最終取得ISO、または "ISO|時間帯マスク36進"）を読み書き。
// 時間帯マスクは「その物件を日本時間の何時に見たことがあるか」の24ビット。
// GitHub Actions の定時実行は混雑時に平気で2〜3時間ずれる（実測: 1時間おき指定でも
// 16:55→19:28→22:17）。実行時刻に頼って時間帯をそろえる作りだと、この遅れが
// そのまま偏りになる。そこで「今の時刻をまだ見ていない物件」を先に選ぶ。
// こうすると実行がいつ走ろうと、24時間ぶんの穴が順に埋まっていく。
export function loadCrawlState(stateFile) {
  const abs = path.resolve(stateFile);
  if (!fs.existsSync(abs)) return {};
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return {};
  }
}

export function saveCrawlState(stateFile, state) {
  const abs = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(state, null, 0));
}

const ALL_HOURS = (1 << 24) - 1;

/** 状態の値を分解する。古い形式（ISO文字列だけ）もそのまま読める */
export function parseState(v) {
  if (!v) return { t: 0, mask: 0 };
  const [iso, m] = String(v).split("|");
  return { t: new Date(iso).getTime() || 0, mask: m ? parseInt(m, 36) : 0 };
}

/** 取得できたときに書き戻す値。24時間ぜんぶ見終わったマスクは畳んで次の一巡に入る */
export function stampState(prev, atIso) {
  const { mask } = parseState(prev);
  const hour = new Date(new Date(atIso).getTime() + 9 * 3600e3).getUTCHours(); // 日本時間
  const next = (mask === ALL_HOURS ? 0 : mask) | (1 << hour);
  return `${atIso}|${next.toString(36)}`;
}

/** 未取得 → 取得が古い順に N 件選ぶ。
 *  spreadHours を渡すと「その時刻をまだ見ていない物件」を先に回す（満空を時間帯ごと均等に採るため）。 */
export function pickRolling(allIds, state, n, { spreadHours = false, at = null } = {}) {
  const st = (id) => parseState(state[id]);
  if (!spreadHours) {
    return [...allIds].sort((a, b) => st(a).t - st(b).t).slice(0, n);
  }
  const bit = 1 << new Date(new Date(at ?? Date.now()).getTime() + 9 * 3600e3).getUTCHours();
  const need = [], done = [];
  for (const id of allIds) ((st(id).mask & bit) ? done : need).push(id);
  const byAge = (a, b) => st(a).t - st(b).t;
  need.sort(byAge);
  if (need.length >= n) return need.slice(0, n);
  // 穴が尽きたら（＝全物件がこの時刻を見終わったら）いつもどおり古い順で埋める
  return need.concat(done.sort(byAge).slice(0, n - need.length));
}
