// リパーク全物件の列挙とローリング巡回の状態管理 ---------------------------
// repark には一括APIが無く 1物件=1ページ取得しかないため、全国16,000件超を
// 一度に取得するのは「節度ある収集」と両立しない。
// そこで sitemap から全 parkId を列挙し、「最も長く取得していないものから順に
// 毎回 N 件だけ」取得するローリング方式で、数日かけて全国を1巡する。

import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP_URL = "https://www.repark.jp/sitemap_park.xml";

// sitemap をローカルにキャッシュし、parkId 一覧を返す。
export async function getAllParkIds({ cacheFile, cacheMs }) {
  let xml = null;
  const abs = path.resolve(cacheFile);
  if (cacheFresh(abs, cacheMs)) {
    xml = fs.readFileSync(abs, "utf8");
  } else {
    const res = await politeFetch(SITEMAP_URL);
    if (res.skippedReason) throw new Error(`sitemap: ${res.skippedReason}`);
    if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
    xml = res.html;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, xml);
    markFetched(abs);
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
  markFetched(abs);
}

const ALL_HOURS = (1 << 24) - 1;
/** 消えた物件（404）を寝かせる期間。
 *  もとは「一覧を7日ごとに作り直すから7日」としていたが、実際に作り直してみると
 *  リパークの一覧は2か月変わっておらず、404の975件がそのまま載っていた。
 *  7日ごとに975件の404を投げ直すだけになるので、時間では長めに置き、
 *  **一覧の中身が変わったときに起こす**（unparkGone）のを主な復帰の合図にする。 */
const GONE_MS = 30 * 864e5;
/** 日本時間の「時」。stampState と pickRolling で同じ位置のビットを使うために1か所に置く */
const jstHour = (ms) => new Date(ms + 9 * 3600e3).getUTCHours();
/** 24時間ぜんぶ見終わったマスクは「まだ何も見ていない」と同じ扱い（次の一巡に入る） */
const effectiveMask = (mask) => (mask === ALL_HOURS ? 0 : mask);

/** 状態の値を分解する。古い形式（ISO文字列だけ）もそのまま読める */
export function parseState(v) {
  if (!v) return { t: 0, mask: 0, gone: false };
  const s = String(v);
  if (s.startsWith("GONE|")) return { t: new Date(s.slice(5)).getTime() || 0, mask: 0, gone: true };
  const [iso, m] = s.split("|");
  return { t: new Date(iso).getTime() || 0, mask: m ? parseInt(m, 36) : 0, gone: false };
}

/** 巡回したときに書き戻す値。
 *  seen=false（取れなかった）でも時刻だけは進める。**これをしないと失敗した物件が
 *  「最後に取れた時刻」のまま古い順の先頭に居座り、毎回そこだけを叩いて
 *  生きている物件へ一生たどり着かない**（1回あたりの件数を4500→629に減らしたとき、
 *  629件ぜんぶが404の物件になり巡回が止まった。2026-09-12）。
 *  24時間ぜんぶ見終わったマスクは畳んで次の一巡に入る。 */
export function stampState(prev, atIso, seen = true) {
  const { mask } = parseState(prev);
  if (!seen) return `${atIso}|${mask.toString(36)}`;
  const next = effectiveMask(mask) | (1 << jstHour(new Date(atIso).getTime()));
  return `${atIso}|${next.toString(36)}`;
}

/** 404（消えた物件）。一覧を作り直すまでは回さない。
 *  先方に無駄な404を投げ続けないための処置でもある（リパークで約970件あった） */
export const goneState = (atIso) => `GONE|${atIso}`;

/** 取得の結果を状態へ書き戻す。404 は寝かせ、それ以外の失敗は時刻だけ進める */
export function recordVisit(state, key, atIso, res, { hours = false, seen } = {}) {
  if (res && res.status === 404) { state[key] = goneState(atIso); return; }
  const ok = !!(res && res.ok && !res.skippedReason);
  // seen を渡されたら「その時刻を見た」の判定はそちら（満空が読めたかどうか）に従う
  state[key] = hours ? stampState(state[key], atIso, seen ?? ok) : atIso;
}

/** 一覧の中身の指紋。作り直して中身が変わったかを見るのに使う */
export function listHash(ids) {
  let h = 0;
  for (const id of ids) { for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0; h = (h + 0x9e3779b9) | 0; }
  return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/** 一覧が変わったら、寝かせていた物件を起こす。
 *  先方が物件を出し入れしたということなので、404だったものが復活している見込みがある。
 *  逆に一覧が変わらないうちは、何度叩いても404のままなので起こさない。 */
export function unparkGone(state, ids) {
  const h = listHash(ids);
  if (state._list === h) return 0;
  let n = 0;
  for (const id of ids) if (String(state[id] ?? "").startsWith("GONE|")) { delete state[id]; n++; }
  state._list = h;
  return n;
}

/** 生きている（寝かせていない）物件の数。1周の回数を決めるのに使う */
export function countLive(allIds, state, nowMs = Date.now()) {
  return allIds.filter((id) => { const x = parseState(state[id]); return !(x.gone && nowMs - x.t < GONE_MS); }).length;
}

/** 未取得 → 取得が古い順に N 件選ぶ。
 *  spreadHours を渡すと「その時刻をまだ見ていない物件」を先に回す（満空を時間帯ごと均等に採るため）。 */
export function pickRolling(allIds, state, n, { spreadHours = false, at = null } = {}) {
  // 状態の文字列は1回だけ読む（比較関数の中で毎回分解すると数十万回になる）
  const parsed = new Map(allIds.map((id) => [id, parseState(state[id])]));
  const st = (id) => parsed.get(id);
  // 消えた物件は寝かせる。期限が切れたら普通に戻る（本当に復活していれば取れる）
  const nowMs = new Date(at ?? Date.now()).getTime();
  const live = allIds.filter((id) => { const x = st(id); return !(x.gone && nowMs - x.t < GONE_MS); });
  if (!spreadHours) {
    return [...live].sort((a, b) => st(a).t - st(b).t).slice(0, n);
  }
  const bit = 1 << jstHour(nowMs);
  const need = [], done = [];
  // 24時間ぜんぶ見終わった物件を「どの時刻も済み」にすると、次の一巡に入れず後回しにされ続ける
  for (const id of live) ((effectiveMask(st(id).mask) & bit) ? done : need).push(id);
  const byAge = (a, b) => st(a).t - st(b).t;
  need.sort(byAge);
  if (need.length >= n) return need.slice(0, n);
  // 穴が尽きたら（＝全物件がこの時刻を見終わったら）いつもどおり古い順で埋める
  return need.concat(done.sort(byAge).slice(0, n - need.length));
}
