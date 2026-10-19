// リパーク全物件の列挙とローリング巡回の状態管理 ---------------------------
// repark には一括APIが無く 1物件=1ページ取得しかないため、全国16,000件超を
// 一度に取得するのは「節度ある収集」と両立しない。
// そこで sitemap から全 parkId を列挙し、「最も長く取得していないものから順に
// 毎回 N 件だけ」取得するローリング方式で、数日かけて全国を1巡する。
// 2026-10-18〜: sitemap の更新が止まっているので、地図のマーカー（repark-map.js）で見つけた番号も足す。

import fs from "node:fs";
import { cacheFresh, markFetched, keepPrevIfShrunk } from "./cache-age.js";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";
import { writeFileAtomic } from "./write-atomic.js";
import { getMapParkIds, readMapList, mapIdsOf } from "./repark-map.js";

const SITEMAP_URL = "https://www.repark.jp/sitemap_park.xml";

/** sitemap（www 版の detail URL）から park= の値だけを重複なく拾う。一覧のキャッシュ（XML のまま）を読むときにも使う */
export function parkIdsFromSitemap(xml) {
  const ids = new Set();
  const re = /result\/detail\/\?park=(REP\d+)/g;
  let m;
  while ((m = re.exec(String(xml)))) ids.add(m[1]);
  return [...ids];
}

/** sitemap の lastmod のいちばん新しい日（YYYY-MM-DD）。lastmod が無ければ null */
export function newestLastmod(xml) {
  let best = null;
  for (const m of String(xml).matchAll(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/g)) if (!best || m[1] > best) best = m[1];
  return best;
}
/** sitemap の lastmod のいちばん新しい日がこれより古ければ、sitemap の更新が止まっているとみなす（日） */
export const SITEMAP_STALE_DAYS = 90;
/** 地図の一覧をこれより長く作り直せていなければ、地図の一覧も古いとみなす */
const MAP_STALE_MS = 14 * 864e5;
/** 地図の一覧（repark-map.js）と、初回に長方形を決める座標（満空の控え）。sitemap の控えと同じ置き場に置く */
export const mapFileOf = (cacheFile) => path.join(path.dirname(path.resolve(cacheFile)), "repark-map-ids.txt");
const coordsFileOf = (cacheFile) => path.join(path.dirname(path.resolve(cacheFile)), "vacancy-lots.jsonl");

// sitemap をローカルにキャッシュし、parkId 一覧を返す。
// 取れた sitemap の物件が前の一覧の半分未満（途中で切れた・作りが変わったなど。0件を含む）なら、前の一覧を使い続ける
// （keepPrevIfShrunk。取得日は進めず、health で知らせる）。欠けた sitemap で上書きすると7日間その分を回らなくなるため
async function sitemapList({ abs, cacheMs, fetcher }) {
  const prevXml = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const prev = parkIdsFromSitemap(prevXml);
  if (prev.length && cacheFresh(abs, cacheMs)) return { ids: prev, xml: prevXml };
  const res = await fetcher(SITEMAP_URL);
  if (res.skippedReason) throw new Error(`sitemap: ${res.skippedReason}`);
  if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
  const ids = parkIdsFromSitemap(res.html);
  const kept = keepPrevIfShrunk("リパーク", ids, prev);
  if (kept) return { ids: kept, xml: prevXml };
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, res.html);
  markFetched(abs);
  return { ids, xml: res.html };
}

// 巡回の一覧 = sitemap の番号 ＋ 地図のマーカーで見つけた番号（repark-map.js）。
// sitemap は lastmod が 2025-06-18 で止まっていて、それより後に開いた物件が載っていない（2026-10-18 の点検）。
// 地図の一覧で sitemap に無い物件を足す。並びは sitemap の順のあとに地図だけの番号（番号の順）。
// 返す配列に付けるもの（run.js が使う）:
//   perRunIds  … 1回あたりの取得件数を決める番号（sitemap の分だけ）。地図で物件が増えても1回あたりの詳細ページは増やさない
//               （1周にかかる回数が少し延びる）
//   staleReason… 一覧が古いまま（health で ok:false。Advisor が知らせる）。sitemap の更新が SITEMAP_STALE_DAYS 日より前で止まっていて、
//               しかも地図の一覧も14日より長く作れていない（地図を使わない設定を含む）とき（新しい物件を取る手立てが無いとき）
//   listNote   … 気をつけること（ok のまま health の reason に残す）。sitemap が止まっているが地図で補えているときなど
//   listInfo   … 件数の内訳（health に残す）
export async function getAllParkIds({ cacheFile, cacheMs, mapFile = mapFileOf(cacheFile), coordsFile = coordsFileOf(cacheFile),
  fetcher = politeFetch, nowMs = Date.now(), mapMaxRequests } = {}) {
  const abs = path.resolve(cacheFile);
  const sm = await sitemapList({ abs, cacheMs, fetcher });
  const map = await getMapParkIds({ file: mapFile, coordsFile, fetcher, nowMs,
    ...(mapMaxRequests !== undefined ? { maxRequests: mapMaxRequests } : {}) });
  const inSitemap = new Set(sm.ids);
  const mapOnly = map.ids.filter((id) => !inSitemap.has(id));
  const ids = sm.ids.concat(mapOnly);
  ids.perRunIds = sm.ids;
  if (sm.ids.staleReason) ids.staleReason = sm.ids.staleReason;

  const newest = newestLastmod(sm.xml);
  const ageDays = newest ? Math.floor((nowMs - Date.parse(`${newest}T00:00:00+09:00`)) / 864e5) : null;
  const sitemapStale = ageDays != null && ageDays > SITEMAP_STALE_DAYS;
  const mapFresh = !map.disabled && !!map.completeAt && nowMs - map.completeAt < MAP_STALE_MS;
  const notes = [];
  if (sitemapStale) notes.push(`sitemap の更新が止まっている（いちばん新しい lastmod が ${newest}・${ageDays}日前）`);
  if (map.disabled) { if (sitemapStale) notes.push("地図の一覧は使っていない（REPARK_MAP_MAX_REQUESTS=0）"); }
  else if (!mapFresh) {
    notes.push(`地図の一覧を${map.completeAt ? `${Math.floor((nowMs - map.completeAt) / 864e5)}日` : "一度も"}作り直せていない`
      + (map.error ? `（${map.error}）` : ""));
  }
  if (!ids.staleReason && sitemapStale && !mapFresh) {
    ids.staleReason = `${notes.join("。")}。sitemap に載っていない新しい物件を取れない`;
  } else if (notes.length) {
    ids.listNote = sitemapStale ? `${notes.join("。")}。地図の一覧（sitemap に無い${mapOnly.length}件）で補っている` : notes.join("。");
  }
  if (ids.staleReason || ids.listNote) console.warn(`::warning::[リパーク] ${ids.staleReason ?? ids.listNote}`);
  ids.listInfo = { sitemap: sm.ids.length, sitemapNewest: newest, map: map.ids.length, mapOnly: mapOnly.length,
    mapCompleteAt: map.completeAt ? new Date(map.completeAt).toISOString() : null,
    ...(map.refreshed ? { mapRequests: map.requests } : {}) };
  console.log(`[リパーク] 一覧: sitemap ${sm.ids.length}件（lastmod の最新 ${newest ?? "不明"}）＋地図だけの${mapOnly.length}件 = ${ids.length}件`);
  return ids;
}

/** 前の回の一覧（sitemap の控え＋地図の一覧）を読む。run.js が一覧を作り直す前に読み、unparkGone で「新しく載った番号」を見分ける */
export function readCachedParkIds(cacheFile, nowMs = Date.now()) {
  const abs = path.resolve(cacheFile);
  const sm = fs.existsSync(abs) ? parkIdsFromSitemap(fs.readFileSync(abs, "utf8")) : [];
  const inSitemap = new Set(sm);
  const ids = sm.concat(mapIdsOf(readMapList(mapFileOf(cacheFile)), nowMs).filter((id) => !inSitemap.has(id)));
  return ids.length ? ids : null;
}

// ローリング状態（parkId -> 最終取得ISO、または "ISO|時間帯マスク36進"）を読み書き。
// 時間帯マスクは「その物件を日本時間の何時に見たことがあるか」の24ビット。
// GitHub Actions の定時実行は混雑時に平気で2〜3時間ずれる（実測: 1時間おき指定でも
// 16:55→19:28→22:17）。実行時刻に頼って時間帯をそろえる作りだと、この遅れが
// そのまま偏りになる。そこで「今の時刻をまだ見ていない物件」を先に選ぶ。
// こうすると実行がいつ走ろうと、24時間ぶんの穴が順に埋まっていく。
export function loadCrawlState(stateFile) {
  const abs = path.resolve(stateFile);
  let state = {};
  if (fs.existsSync(abs)) {
    try { state = JSON.parse(fs.readFileSync(abs, "utf8")); } catch { state = {}; }
  }
  openedStates.set(abs, state);
  return state;
}

// この実行で読み込んだ巡回状態（絶対パス -> 状態）。巡回が止められたとき・途中の例外で落ちたときに
// flushCrawlStates で書き出す。観測（料金・満空）は取るたびに追記しているが、状態は50件ごとと各回の終わりにしか
// 書いていないので、その間に取った物件が「取っていない」ことになり、次の回にまた取りに行っていた（2026-10-18）
const openedStates = new Map();
/** 読み込んだ巡回状態をすべて書き出す（書き終わった社をもう一度書いても中身は同じ）。書いた数を返す */
export function flushCrawlStates() {
  for (const [abs, state] of openedStates) saveCrawlState(abs, state);
  return openedStates.size;
}

export function saveCrawlState(stateFile, state) {
  const abs = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  // 一時ファイルに書いてから置き換える。書いている途中で止められても、壊れた JSON を残さない（2026-10-18）
  writeFileAtomic(abs, JSON.stringify(state, null, 0));
  // ここで markFetched は呼ばない。取得日の記録は「物件一覧」のためのもので、
  // 巡回状態は毎回書き換わる別物（付けると不要な .fetched が毎回生まれる）
}

const ALL_HOURS = (1 << 24) - 1;
/** 消えた物件（404）を寝かせる期間の下限。
 *  もとは「一覧を7日ごとに作り直すから7日」としていたが、実際に作り直してみると
 *  リパークの一覧は2か月変わっておらず、404の975件がそのまま載っていた。
 *  7日ごとに975件の404を投げ直すだけになるので、時間では長めに置く。
 *  一覧に新しく載った番号は、期限を待たずに起こす（unparkGone）。 */
const GONE_MS = 30 * 864e5;
/** 寝かせる期間を物件ごとにずらす幅（時間）。30日＋（番号のハッシュ％721）時間＝30〜60日。
 *  日単位（％31日）だと、同じ回に寝かせた物件が毎日同じ1時間にまとまって起きる（リパークの本物の状態で1時間に最大27件）。
 *  時間単位にすると1時間あたり1〜2件になる */
const GONE_SPREAD_HOURS = 30 * 24 + 1;

/** 物件ごとの寝かせる期間（30〜60日）。番号だけから決まる（毎回同じ値）。
 *  一律30日だと、同じ日に寝かせた物件が30日後に一斉に起きる。リパークでは 9/12 に寝かせた約975件が
 *  10/12 に一度に起き、2回の巡回で962件の404をまとめて投げ、その回の取得と満空の観測が約800行失われた。
 *  10/12 に寝かせ直した964件も 11/11 の2回の巡回（604件・358件）に同じ山になるところだった。番号のハッシュで
 *  30日ぶんの時間に散らすと、1日あたり約30件・毎時の回で1〜2件にならされる。
 *  状態の値の形（"GONE|ISO"）は変えない（studio-index.mjs が読む） */
export function goneMsOf(id) {
  // FNV-1a（32ビット）。番号の末尾の数字が並んでいても散るように、最後にもう一度かき混ぜる
  let h = 0x811c9dc5;
  const s = String(id);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13;
  return GONE_MS + ((h >>> 0) % GONE_SPREAD_HOURS) * 3600e3;
}
/** 寝かせている最中か（GONE で、期限がまだ来ていない） */
const sleeping = (id, x, nowMs) => x.gone && nowMs - x.t < goneMsOf(id);
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

/** 取得の結果を状態へ書き戻す。404・410 は寝かせ、それ以外の失敗は時刻だけ進める
 *  （相手先の不調で取れなかったときは、先に isTransient で分けて recordTransient を使う） */
export function recordVisit(state, key, atIso, res, { hours = false, seen } = {}) {
  if (res && (res.status === 404 || res.status === 410)) { state[key] = goneState(atIso); return; }
  const ok = !!(res && res.ok && !res.skippedReason);
  // seen を渡されたら「その時刻を見た」の判定はそちら（満空が読めたかどうか）に従う
  state[key] = hours ? stampState(state[key], atIso, seen ?? ok) : atIso;
}

/** 相手先の不調で取れなかったか（物件が消えたとは言えない失敗）。
 *  通信の失敗・タイムアウト（res が無い）、5xx、429（多すぎる）、403（断られた）、robots.txt に届かず見送った分（res.transient）。
 *  404・410（閉鎖）、ほかの 4xx、robots.txt の Disallow で見送った分は含めない（従来どおり recordVisit） */
export const isTransient = (res) => !res || !!res.transient
  || (!res.skippedReason && (res.status >= 500 || res.status === 429 || res.status === 403));

/** 状態の値の末尾の「1回見送った」印 */
const RETRY_MARK = "|r";
/** 相手先の不調で取れなかった物件を状態へ書き戻す。戻り値は「次の回に取り直すか」。
 *  1回目は時刻を進めず印だけ付ける（古い順の先頭に残り、次の回に取り直す）。
 *  以前は失敗でも時刻を進めていたので、タイムズで 2026-10-02 21:08〜21:40（日本時間）に先方が 502・503・
 *  タイムアウトを返したとき、取れなかった124件がデータの無いまま1巡（当時約16日）後ろへ回った。
 *  2回続けて取れなかったら従来どおり時刻を進める。いつまでも進めないと、壊れたページが先頭に居座って
 *  巡回が止まる（2026-09-12 に404の物件で起きたこと）。閉鎖（GONE）の印はそのまま寝かせ直す。 */
export function recordTransient(state, key, atIso, { hours = false } = {}) {
  const s = state[key] == null ? "" : String(state[key]);
  if (s.startsWith("GONE|")) { state[key] = goneState(atIso); return false; }
  if (s.endsWith(RETRY_MARK)) {
    const base = s.slice(0, -RETRY_MARK.length);
    state[key] = hours ? stampState(base, atIso, false) : atIso;
    return false;
  }
  // 「ISO|時間帯マスク|r」。ISO は今までの値のまま（一度も取っていない物件は 1970年＝いちばん古い）。
  // 読む側（parseState・studio-index.mjs）は「|」の3つ目を見ないので、そのまま読める。取れたら stampState で消える
  const { t, mask } = parseState(s);
  state[key] = `${new Date(t).toISOString()}|${mask.toString(36)}${RETRY_MARK}`;
  return true;
}

/** 相手先の不調が続いたら、その回の巡回を打ち切る仕掛け。
 *  不調の失敗が limit 件続いたら true を返す。取れた・404 など相手先が答えた回で数え直す。
 *  run.js は取り直しの2回目の失敗を数えない（壊れたページが先頭に並んだだけで止めないため）。
 *  2026-10-02 のタイムズは不調のあいだも6秒おきに249件を取りに行き、124件が失敗していた。
 *  先方が苦しいときに叩き続けないためと、取れない物件を無駄に回さないため。 */
export function makeBreaker(limit = 8) {
  let streak = 0;
  return { fail: () => ++streak >= limit, ok: () => { streak = 0; }, get streak() { return streak; } };
}

/** 一斉の閉鎖の歯止め（2026-10-18 の点検）。先方がサイトの作り替えや保守で、全ページを同じ所（/misc/404.php や /）へ
 *  転送したり 404 を返したりすると、その回に取った物件が全部 GONE（30〜60日寝かせ、studio-index.mjs の相場からも外れる）になる。
 *  一覧はほとんど変わらないので unparkGone でも起こされない。
 *  answered(isClosed) … 「前は生きていた物件」（run.js の watch。一覧に載っていて、取った記録があり、寝かせていないもの）で先方が答えた1件。
 *    閉鎖でない答え（isClosed が false）なら、閉鎖の連続の数を0に戻す。
 *  closed(id, prev, watch) … 閉鎖とみなして印を付けた1件（prev は印を付ける前の状態の値）。数えるのは watch の分だけ。
 *    一覧から外れた物件・一覧から消えた物件の確かめ・寝かせた物件の起き抜け・初めての物件は、閉鎖が多くて当たり前なので数えない
 *    （数えると、正しい閉鎖が続いただけで止まり、戻した物件が次の回も先頭に来て巡回が進まなくなる）。
 *    watch の閉鎖が min 件以上、かつ answered の ratio 以上になったら true を返す。
 *    また watch の閉鎖が（閉鎖でない答えをはさまず）続けて streak 件になったときも true を返す。
 *    回の途中から先方が保守の画面などに切り替わると、それまでに取れた件数で割合が薄まり、割合の条件だけでは止まらない
 *    （300件取れたあとに全部が転送になると、閉鎖が300件に達するまで印を付け続ける。2026-10-19 の最終点検）。
 *    どちらで止めたかは stats.trippedBy（"ratio" か "streak"）。
 *  restore(state) … この回に付けた閉鎖の印を、数えなかった分も含めて全部前の値に戻し、戻した件数を返す
 *    （確かめられていない閉鎖で相場から外さない。正しい閉鎖は次の回以降にまた確かめる）。
 *  名鉄協商の最初の数回は正しい閉鎖が約22%（今の状態ファイルで試すと、30件を超えてからの割合は最大26%）なので止まらない */
export function makeMassGone({ min = 30, ratio = 0.5, streak = 20 } = {}) {
  let answered = 0, counted = 0, run = 0, trippedBy = null;
  const marked = new Map();
  return {
    answered: (isClosed = false) => { answered++; if (!isClosed) run = 0; },
    closed(id, prev, watch = true) {
      if (!marked.has(id)) marked.set(id, prev);
      if (!watch) return false;
      counted++; run++;
      if (counted >= min && counted >= answered * ratio) trippedBy = "ratio";
      else if (run >= streak) trippedBy = "streak";
      return !!trippedBy;
    },
    restore(state) {
      for (const [id, prev] of marked) { if (prev === undefined) delete state[id]; else state[id] = prev; }
      const n = marked.size; marked.clear(); return n;
    },
    get stats() { return { answered, closed: counted, marked: marked.size, streak: run, trippedBy }; },
  };
}

/** 一覧から消えた物件のうち、今の一覧を作ってから一度も確かめていないもの（古い順に max 件）。
 *  詳細ページを1回だけ取りに行き、閉鎖なら 404 で GONE が付いて Advisor の相場から外れる（studio-index.mjs）。
 *  それまでは一覧から消えると二度と取りに行かず、閉鎖の印も付かないまま相場に残っていた
 *  （タイムズで64件。2026-10-18 に4件を確かめたら3件が404・1件はまだ載っていた）。
 *  先方は一覧（sitemap）から一時的に外すこともある（タイムズは5回の作り直しで34件が出戻り）ので、
 *  一覧から消えただけでは閉鎖にしない。確かめると時刻が一覧の作成より新しくなるので、次に一覧を
 *  作り直すまでは再び取りに行かない。listAtMs … 今の一覧を作った時刻（分からなければ何も選ばない）。
 *  keyOf … 一覧の1件 → 物件の番号（タイムズは URL → BUK）。URL だけ変わって同じ番号が一覧に残っている物件は
 *  消えていないので選ばない（古い URL に GONE を付けると、番号でまとめる studio-index.mjs が生きている物件を外すため） */
export function pickDropped(allIds, state, listAtMs, max = 100, keyOf = null) {
  if (!Number.isFinite(listAtMs)) return [];
  const inList = new Set(allIds);
  const inListKey = keyOf ? new Set(allIds.map(keyOf)) : null;
  const out = [];
  for (const [k, v] of Object.entries(state)) {
    if (k.startsWith("_") || inList.has(k) || inListKey?.has(keyOf(k))) continue;
    const x = parseState(v);
    if (x.gone || x.t >= listAtMs) continue;
    out.push([k, x.t]);
  }
  return out.sort((a, b) => a[1] - b[1]).slice(0, max).map((x) => x[0]);
}

/** 一覧の中身の指紋。作り直して中身が変わったかを見るのに使う */
export function listHash(ids) {
  let h = 0;
  for (const id of ids) { for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0; h = (h + 0x9e3779b9) | 0; }
  return `${ids.length}:${(h >>> 0).toString(36)}`;
}

/** 一覧に新しく載った物件のうち、寝かせていたものを起こす。
 *  先方が物件を載せ直したということなので、404だったものが復活している見込みがある。
 *  以前は一覧が1件でも変わると、一覧の中の寝かせた物件を全部起こしていた。あなぶきパークでは 10/12 に一覧が
 *  792→793 件に1件増えただけで寝かせた68件を起こし、68件すべてがまた404だった。そこで前の一覧（prevIds。
 *  run.js が一覧を作り直す前のファイルから読む）と比べ、前の一覧に無く今回載った番号だけを起こす。
 *  前の一覧が分からないときは何も起こさない（寝かせる期限 goneMsOf が切れれば普通に戻る） */
export function unparkGone(state, ids, prevIds = null) {
  const h = listHash(ids);
  if (state._list === h) return 0;
  // 記録が無い初回は、一覧が変わったかどうか分からない。起こさずに指紋だけ控える
  if (state._list === undefined || !prevIds?.length) { state._list = h; return 0; }
  const before = new Set(prevIds);
  let n = 0;
  for (const id of ids) if (!before.has(id) && String(state[id] ?? "").startsWith("GONE|")) { delete state[id]; n++; }
  state._list = h;
  return n;
}

/** 生きている（寝かせていない）物件の数。1周の回数を決めるのに使う */
export function countLive(allIds, state, nowMs = Date.now()) {
  return allIds.filter((id) => !sleeping(id, parseState(state[id]), nowMs)).length;
}

/** 優先物件の番号を、巡回の一覧の書き方に読み替える。
 *  Advisor は満空の表（vacancy_lots.park_id）の番号で渡してくる。リパークは REP… で一覧と同じだが、
 *  タイムズは BUK… の駐車場コードで、一覧・状態ファイルはページのURLで持っている。そのまま比べると
 *  1件も当たらず、622件が優先されないまま最大16日前になっていた（2026-10-17 点検。本人指示: 直せるものは直して）。
 *  keyOf（一覧の1件 → 番号）を渡すと番号どうしで照合し、一覧の書き方で返す。一覧に無い番号は missing に数える
 *  （閉鎖や、周辺の満空だけで見えている物件。ログに出して、ずれに気づけるようにする）。 */
export function matchPriority(want, allIds, keyOf = null) {
  const byKey = new Map(allIds.map((id) => [keyOf ? keyOf(id) : id, id]));
  const ids = [], seen = new Set();
  let missing = 0;
  for (const k of want) {
    const id = byKey.get(String(k));
    if (id === undefined) { missing++; continue; }
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return { ids, missing };
}

/** run.js の巡回の表（ROLLING_SITES）の1行 → pickRolling に渡す選び方。
 *  spreadPriority・dailyFirst は、その行に印のある社（リパーク）だけ。hours（満空が取れる）だけでは付けない
 *  （タイムズも hours だが、1日3回・1周約8日の社に付けると、優先物件の回数が減り、時間帯をならす仕組みも効かなくなる。2026-10-19 の点検） */
export function pickOptsOf(site, { at = null, priority = [], priorityMinAgeMs = 3 * 3600e3 } = {}) {
  return { spreadHours: !!site.hours, at, priority, priorityMinAgeMs,
    spreadPriority: !!site.spreadPriority, dailyFirst: !!(site.hours && site.dailyFirst) };
}

/** 未取得 → 取得が古い順に N 件選ぶ。
 *  spreadHours を渡すと「その時刻をまだ見ていない物件」を先に回す（満空を時間帯ごと均等に採るため）。
 *  spreadPriority を渡すと、優先物件を毎回少しずつ取る（説明は下）。毎時回る社（リパーク）だけが使う。
 *  dailyFirst を渡すと、spreadHours の選び方で「今日まだ見ていない物件」を先にする（pickRollingRest の説明）。リパークだけが使う */
export function pickRolling(allIds, state, n, { spreadHours = false, at = null, priority = [], priorityMinAgeMs = 3 * 3600e3,
  spreadPriority = false, dailyFirst = false } = {}) {
  // 状態の文字列は1回だけ読む（比較関数の中で毎回分解すると数十万回になる）
  const parsed = new Map(allIds.map((id) => [id, parseState(state[id])]));
  const st = (id) => parsed.get(id);
  // 消えた物件は寝かせる。期限が切れたら普通に戻る（本当に復活していれば取れる）
  const nowMs = new Date(at ?? Date.now()).getTime();
  const live = allIds.filter((id) => !sleeping(id, st(id), nowMs));
  // 優先物件（レポートで実際に見ている周りの物件）は、ローリングの順番を待たずに先に取る。
  // ただし前回から priorityMinAgeMs 空いているものだけ。毎時走っても同じ物件を毎時は叩かない
  // （既定3時間おき＝1日8回。全国を毎時回すより先方の負荷を桁違いに抑えつつ、重みは1週間で十分に付く）。
  // n とは別枠で足す。ここで n を食うと全国の1巡が遅れ、時間帯を均す仕掛けが崩れるため。
  const liveSet = new Set(live);
  const head = priority.filter((id) => liveSet.has(id) && nowMs - st(id).t >= priorityMinAgeMs)
    .sort((a, b) => st(a).t - st(b).t);
  let restN = n;
  if (spreadPriority && head.length) {
    // 優先物件を毎回少しずつ取る（2026-10-19）。
    // 以前は3時間たった優先物件を全部まとめて先頭に置いていた。リパークの優先は約770件で、1回の予算（50分・4秒おきで約750件）を
    // 優先だけで使い切るため、その回は全国の巡回が0件になり、優先を取る回は4時間おきの同じ時刻（日本時間 0・4・8・12・16・20時など）に
    // そろっていた。本物の状態で試すと、ふつうの物件はその6つの時刻の満空がほとんど取れない（ほかの時刻の0〜5割）。
    // そこで1回に取る優先物件を「優先の数 ÷ 間隔の時間」（3時間おきなら3分の1）までにする。優先の数が少なく1回で取り終わるときは
    // これまでどおり3時間おき、多いときもこれまでと同じ約4時間おき（取る順番は古い順のまま）。
    // 全国の巡回からは、この回に取る優先の数の半分を引く。以前は優先を取る回に全国の巡回が予算で削られていたので、
    // 引かないと1日に取る回数が約1割増える（本物の状態で試すと、引けば直す前とほぼ同じ。±2%）
    head.splice(Math.ceil(priority.length / Math.max(1, Math.round(priorityMinAgeMs / 3600e3))));
    restN = Math.max(0, n - Math.floor(head.length / 2));
  }
  // spreadPriority のときは、優先物件は先頭の枠だけで取る（枠からあふれた優先物件を全国の巡回の側で拾うと、少しずつ取る意味が無くなる）
  const skip = spreadPriority ? new Set(priority) : new Set(head);
  const rest = pickRollingRest(live.filter((id) => !skip.has(id)), st, restN, { spreadHours, nowMs, dailyFirst });
  return head.concat(rest);
}
/** 日本時間のその日の0時（ms）。「今日もう見たか」を決めるのに使う */
const jstDayStart = (ms) => Math.floor((ms + 9 * 3600e3) / 864e5) * 864e5 - 9 * 3600e3;
/** これより長く見ていない物件は、時間帯を問わず先に取る（spreadHours のとき。長く待たせないための歯止め） */
export const STARVE_MS = 48 * 3600e3;

function pickRollingRest(live, st, n, { spreadHours, nowMs, dailyFirst = false }) {
  const byAge = (a, b) => st(a).t - st(b).t;
  if (!spreadHours) {
    // 古い順。今日もう見た物件は今日まだ見ていない物件より必ず新しいので、そのままで「まだ見ていない物件が先」になる
    return [...live].sort(byAge).slice(0, n);
  }
  const bit = 1 << jstHour(nowMs);
  if (!dailyFirst) {
    // 1周に何日もかかる社（タイムズ）: 「この時刻をまだ見ていない物件」を先にする（直す前のまま）。
    // 取る番が来た物件はほぼ毎回48時間より前に見たものなので、「今日まだ見ていない」や48時間の歯止めで分けても意味が無く、
    // 時間帯をならす仕組みだけが効かなくなる（タイムズの本物の状態から40日回した試しで、まだ見ていない時刻の観測が 100%→93.9%）
    const need = [], done = [];
    // 24時間ぜんぶ見終わった物件を「どの時刻も済み」にすると、次の一巡に入れず後回しにされ続ける
    for (const id of live) ((effectiveMask(st(id).mask) & bit) ? done : need).push(id);
    need.sort(byAge);
    if (need.length >= n) return need.slice(0, n);
    // 穴が尽きたら（＝全物件がこの時刻を見終わったら）いつもどおり古い順で埋める
    return need.concat(done.sort(byAge).slice(0, n - need.length));
  }
  // dailyFirst（1日に全体の大半を回れる社＝リパーク）は、次の順に選ぶ（それぞれの中は古い順）:
  //   0. STARVE_MS（48時間）より長く見ていない
  //   1. 今日（日本時間）まだ見ていない・この時刻をまだ見ていない
  //   2. 今日まだ見ていない・この時刻はもう見た
  //   3. 今日もう見た・この時刻をまだ見ていない
  //   4. 今日もう見た・この時刻はもう見た
  // 以前は「この時刻をまだ見ていない」だけで先に選んでいた。時間帯の印（24時間ぶん）は物件ごとに一巡するので、
  // 多くの物件が22〜23時間ぶん見終わると、その物件はほとんどの時刻で「済み」になり、印の少ない一部の物件だけが
  // その日のうちに何度も選ばれていた。リパークの1日の物件数は 10/01 の12,445件から 10/16 の5,651件まで減り
  // （観測の回数は1日約1万4千回で変わらない）、手元で回すと数週間ごとに約4,600〜13,000件を行き来する作りだった。
  // 印がそろうまで選ばれない物件は、最長で11日（270時間）見られていなかった（2026-10-18 の本物の状態から21日回した試し）。
  // 今日まだ見ていない物件を先にすれば、取る回数は同じまま1日に見る物件が増える。時間帯をならすのは、今日まだ見ていない物件の中で行う。
  // 0 の歯止めが無いと、印のそろいかけた物件が「今日まだ見ていない・この時刻はもう見た」に残り続け、最長で約3〜5日待つことがある
  const dayStart = jstDayStart(nowMs);
  const tiers = [[], [], [], [], []];
  // 24時間ぜんぶ見終わった物件を「どの時刻も済み」にすると、次の一巡に入れず後回しにされ続ける（effectiveMask）
  for (const id of live) {
    const x = st(id);
    if (nowMs - x.t >= STARVE_MS) { tiers[0].push(id); continue; }
    tiers[1 + (x.t >= dayStart ? 2 : 0) + ((effectiveMask(x.mask) & bit) ? 1 : 0)].push(id);
  }
  const out = [];
  for (const tier of tiers) {
    if (out.length >= n) break;
    out.push(...tier.sort(byAge).slice(0, n - out.length));
  }
  return out;
}
