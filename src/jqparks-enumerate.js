// JQパークス: 駅ごとの一覧を巡回して物件コードを列挙 ------------------------------
// 県/市区ページには物件が無く、駅の一覧にのみ /number/{code} が載る。robots.txt は Allow: /。
//
// 駅の集め方（2026-11-02 に直した）:
//   トップの駅リンクに加えて、トップの県ページ /city/{県}（7県）→ 市区ページ /city/{県}/{市区} → 駅リンク /station/{駅} の順にたどる。
//   以前はトップの href="/station/…" だけを拾っていた。大分・長崎のタブの駅リンクは先頭の / が無い相対の href="station/…"（57駅）で、
//   1つも拾えていなかった（トップの表示は大分107件・長崎56件なのに、DB は大分12件・長崎2件。2026-11-01）。
//   相対のリンクも拾う。地図に載っていない駅（長崎市の肥前古賀駅など）もあるので、市区ページからもたどる。
//   駅は駅名で重複を除く（タブ違いの同じ駅も、検索の結果は同じ。2026-11-02 に久留米駅で確かめた）。
//
// 駅の一覧の取り方:
//   /station/{駅} は、11件以上あると 302 で /s/?m=1&w={駅}&a=… に転送される。politeFetch は転送を追うので、
//   4秒あかずに2回続けて取ってしまう。転送先と同じ /s/?m=1&w={駅} を直接取る（a は結果を変えない）。
//   一覧は1ページ10件。「合計：N件中」を読み、&p=2 以降もたどる。以前は1ページ目しか読まず、どの駅も11件目以降が
//   抜けていた（博多駅は16件のうち6件・大分駅は19件のうち9件。2026-11-01）。
//
// 一覧のページから、物件ごとの座標（makePin(緯度, 経度, 番号, 名前, 物件コード)。世界測地系。DB の住所からの座標と数m〜十数mで一致）
// と「時間貸OK」の印（icon_01.png。月極だけの物件は icon_00.gif）も読み、<一覧>-lots.json に残す（jqparks.js が記録に入れる）。
// 月極だけの物件も一覧から外さない（相場に入れるかは別に決める。詳細ページには時間貸の料金が無い）。
//
// 一覧の作り直しは週1回・約500リクエスト（県7・市区約100・駅約400・2ページ目以降）。4秒おきで約35分。
// 守り（times-enumerate.js・ecolo-enumerate.js と同じ形）:
//   ・トップが取れない・取れないページが続く（BREAK_AFTER 回）・取れた件数が前の一覧の9割に満たない → 作り直しの失敗。
//     前の一覧（取れた分と合わせる）を使い、取得日（.fetched）は進めない。次に試すのは RETRY_AFTER_FAIL_MS あと
//     （約500リクエストの作り直しを毎回くり返さない）。前の一覧が14日より古いままなら staleReason（health は ok:false）
//   ・取れなかった駅のページが少し（MAX_MISS_RATIO まで）なら作り直しは成功にして、前の一覧の物件も残す（その駅の物件を落とさない）
//   ・トップの合計（746件）の9割に届かないときは listNote で知らせる（ok のまま）
import fs from "node:fs";
import path from "node:path";
import { cacheFresh, markFetched, cacheAgeMs, readFailStamp, writeFailStamp, clearFailStamp } from "./cache-age.js";
import { politeFetch, failText, fetchErrorText, throwIfRobotsSkipped } from "./polite-fetch.js";

const ORIGIN = "https://www.parking-kyushu.jp";
const TOP = `${ORIGIN}/`;
/** 1駅でたどるページの上限（いちばん多い熊本駅でも23件＝3ページ） */
export const MAX_STATION_PAGES = 20;
/** 取れたコードが前の一覧のこの割合より少なければ、作り直しの失敗とみなす */
const MIN_RATIO = 0.9;
/** 取れなかった駅のページがこの割合までなら、作り直しは成功とみなす（前の一覧の物件は残す） */
const MAX_MISS_RATIO = 0.05;
/** 取れないページがこの回数続いたら、相手先の不調とみなして作り直しをやめる */
const BREAK_AFTER = 5;
/** 前の一覧を使い続けてよい長さ。これを過ぎたら staleReason を付けて知らせる（run.js が health に ok:false で出す） */
const STALE_WARN_MS = 14 * 864e5;
/** 作り直しに失敗したあと、次に試すまでの間 */
const RETRY_AFTER_FAIL_MS = 20 * 3600e3;

const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
const enc = (s) => encodeURIComponent(s);

/** 駅の一覧の URL（転送先の /s/ を直接）。2ページ目からは &p= を付ける */
export const stationListUrl = (station, page = 1) => `${ORIGIN}/s/?m=1&w=${enc(station)}${page > 1 ? `&p=${page}` : ""}`;
const cityUrl = (...parts) => `${ORIGIN}/city/${parts.map(enc).join("/")}`;

/** 物件ごとの座標・時間貸の印の控え（一覧のとなり。data/jqparks-ids.txt → data/jqparks-lots.json） */
export const lotsFileOf = (cacheFile) => (/-ids\.txt$/.test(cacheFile) ? cacheFile.replace(/-ids\.txt$/, "-lots.json") : `${cacheFile}.lots.json`);

/** トップの「合計」の件数（県ごとの件数は「(332件)」、合計は「746件」）。読めなければ null */
export function parseTopTotal(html) {
  const s = String(html);
  const i = s.indexOf("<strong>合計</strong>");
  if (i < 0) return null;
  const m = s.slice(i).match(/<td[^>]*>\s*([\d,]+)件\s*<\/td>/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

/** ページの中の駅リンク（/station/{駅} と /station/{駅}/{タブ}。トップの大分・長崎のタブは先頭の / が無い station/…）の駅名。重複なし */
export function parseStationNames(html) {
  const names = [...String(html).matchAll(/href="\/?station\/([^"/&?]+)/g)].map((m) => decode(m[1]).trim()).filter(Boolean);
  return [...new Set(names)];
}

/** 県ページへのリンク（/city/{県}）の県名。重複なし */
export function parsePrefLinks(html) {
  return [...new Set([...String(html).matchAll(/href="\/city\/([^"/]+)"/g)].map((m) => decode(m[1])))];
}

/** 市区ページへのリンク（/city/{県}/{市区}）。[県, 市区] の配列。重複なし */
export function parseCityLinks(html) {
  const seen = new Set(), out = [];
  for (const m of String(html).matchAll(/href="\/city\/([^"/]+)\/([^"/]+)"/g)) {
    const pair = [decode(m[1]), decode(m[2])];
    const k = pair.join("/");
    if (!seen.has(k)) { seen.add(k); out.push(pair); }
  }
  return out;
}

/** 駅の一覧の1ページ。total … 「合計：N件中」（読めなければ null）。
 *  lots … 物件コードごとの { lat, lng, hourlyOk }（座標は makePin、時間貸の印は行（id="t{コード}"）の icon_01.png / icon_00.gif）。
 *  ids … ページの中の /number/{コード}（行と地図のピンのどちらかにあれば拾う） */
export function parseStationPage(html) {
  const s = String(html);
  const tm = s.match(/合計：\s*<strong>\s*([\d,]+)\s*<\/strong>\s*件中/);
  const total = tm ? Number(tm[1].replace(/,/g, "")) : null;
  const lots = new Map();
  const lotOf = (code) => { if (!lots.has(code)) lots.set(code, { lat: null, lng: null, hourlyOk: null }); return lots.get(code); };
  // makePin(33.578404638166745, 130.4235260057455,'01','JQParks博多駅南第3','19022151');（関数の定義 makePin(lat,lon,…) は数字でないので当たらない）
  for (const m of s.matchAll(/makePin\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,[^;]*?'(\d{6,})'\s*\)\s*;/g)) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (!(lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154)) continue;   // 日本の外・0,0 は座標なし
    Object.assign(lotOf(m[3]), { lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
  }
  // 行ごとの印。<tr … id="t19022151"> … <img src="/img/icon_01.png" … alt="時間貸OK" /> … </tr>
  for (const m of s.matchAll(/<tr\b[^>]*\bid="t(\d{6,})"[^>]*>([\s\S]*?)<\/tr>/g)) {
    const icon = m[2].match(/<img\s+src="\/img\/(icon_\d+)\.[a-z]+"[^>]*alt="時間貸OK"/);
    if (icon) lotOf(m[1]).hourlyOk = icon[1] === "icon_01";
  }
  const ids = [...new Set([...s.matchAll(/\/number\/(\d{6,})/g)].map((m) => m[1]))];
  return { total, lots, ids };
}

const readList = (abs) => fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
function readLots(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, "utf8"));
    return new Map(Object.entries(o && typeof o === "object" ? o : {}));
  } catch { return new Map(); }   // まだ無い（直す前の一覧）・読めない。座標と印が無いだけで巡回はできる
}

/** 一覧を作る（駅をたどる）。戻り値 { ids, lots, total, misses, pages, aborted }。
 *  aborted … 続けて取れず途中でやめた理由。misses … 取れなかったページ（URL と理由） */
async function crawlStations(fetcher, log) {
  const top = await fetcher(TOP);
  throwIfRobotsSkipped(top, "JQパークス トップ");
  if (!top.ok) throw new Error(`JQパークス トップ取得失敗: ${failText(top)}`);
  const total = parseTopTotal(top.html);
  const stations = new Set(parseStationNames(top.html));
  const fromTop = stations.size;
  const ids = new Set(), lots = new Map(), misses = [];
  let pages = 0, streak = 0, aborted = null;
  // 取れたら streak を戻す。取れなければ misses に足し、続いたら打ち切る。robots.txt で断られた・届かないときはすぐ打ち切る
  const get = async (url) => {
    if (aborted) return null;
    let res;
    try { res = await fetcher(url); } catch (e) { res = { ok: false, error: fetchErrorText(e) }; }
    if (res.blocked || res.transient) { aborted = failText(res); return null; }
    if (!res.ok || res.skippedReason) {
      misses.push({ url, why: res.error ?? failText(res) });
      if (++streak >= BREAK_AFTER) aborted = `取れないページが${streak}回続いた（最後は ${res.error ?? failText(res)}）`;
      return null;
    }
    streak = 0; pages++;
    return res.html;
  };

  // トップ → 県 → 市区 → 駅名
  const prefs = parsePrefLinks(top.html);
  const cities = [];
  for (const pref of prefs) {
    const html = await get(cityUrl(pref));
    if (html != null) cities.push(...parseCityLinks(html).filter(([p]) => p === pref));
  }
  for (const [pref, city] of cities) {
    const html = await get(cityUrl(pref, city));
    if (html != null) parseStationNames(html).forEach((n) => stations.add(n));
  }
  log(`[JQパークス] 駅${stations.size}（トップ${fromTop}・県${prefs.length}・市区${cities.length}からたどった）`);

  // 駅ごとに最後のページまで
  for (const st of stations) {
    if (aborted) break;
    for (let page = 1, last = 1; page <= Math.min(last, MAX_STATION_PAGES); page++) {
      const html = await get(stationListUrl(st, page));
      if (html == null) break;
      const p = parseStationPage(html);
      if (page === 1 && p.total) last = Math.ceil(p.total / 10);
      p.ids.forEach((id) => ids.add(id));
      for (const [code, v] of p.lots) lots.set(code, v);
      if (!p.ids.length) break;
    }
  }
  return { ids, lots, total, misses, pages, aborted, stations: stations.size };
}

// 物件コード一覧を返す（キャッシュ優先）。返す配列の listMeta に、物件コード → { lat, lng, hourlyOk } の Map を付ける
// （run.js が詳細ページのパーサに渡す）。fetcher はテスト用（既定は polite-fetch）、log もテスト用
export async function getAllJqparksIds({ cacheFile, cacheMs = 7 * 864e5, fetcher = politeFetch, log = console.log } = {}) {
  const abs = cacheFile ? path.resolve(cacheFile) : null;
  const lotsFile = abs ? lotsFileOf(abs) : null;
  const prev = abs && fs.existsSync(abs) ? readList(abs) : [];
  const withMeta = (list, meta) => { list.listMeta = meta; return list; };
  if (abs && fs.existsSync(abs) && cacheFresh(abs, cacheMs)) return withMeta(prev, readLots(lotsFile));

  const prevLots = lotsFile ? readLots(lotsFile) : new Map();
  const useOld = (why, got = null) => {
    // 取れた分と合わせる（新しく見つかった物件も回す）。座標と印は取れた分を優先
    const merged = [...new Set([...prev, ...(got ? [...got.ids] : [])])].sort();
    const meta = new Map([...prevLots, ...(got?.lots ?? [])]);
    const ageMs = cacheAgeMs(abs);
    const age = Number.isFinite(ageMs) ? `${(ageMs / 864e5).toFixed(0)}日前` : "取得日不明";
    console.warn(`::warning::[JQパークス] 一覧を作り直せなかったので、前の一覧（${prev.length}件・${age}）${got?.ids.size ? `と取れた分を合わせた${merged.length}件` : ""}を使う: ${why}`);
    if (!(ageMs < STALE_WARN_MS)) merged.staleReason = `一覧を作り直せていない（前の一覧は${age}）: ${why}`;
    else merged.listNote = `一覧を作り直せず、前の一覧（${prev.length}件・${age}）を使っている: ${why}`;
    return withMeta(merged, meta);
  };

  // 前回の作り直しが失敗して間もないなら、この回は試さない（約500リクエストを毎回くり返さない）
  const failed = prev.length ? readFailStamp(abs) : null;
  if (failed) {
    const since = Date.now() - failed.at;
    if (since < RETRY_AFTER_FAIL_MS) {
      log(`[JQパークス] 前回の作り直しが ${(since / 3600e3).toFixed(1)}時間前に失敗したので、この回は試さない（${RETRY_AFTER_FAIL_MS / 3600e3}時間あける）`);
      return useOld(`前回の失敗: ${failed.why}`);
    }
  }
  const fail = (why, got) => {
    if (!prev.length) throw new Error(`JQパークス一覧: ${why}`);
    if (abs) writeFailStamp(abs, why, (failed?.count ?? 0) + 1);
    return useOld(why, got);
  };

  let got;
  try { got = await crawlStations(fetcher, log); } catch (e) { return fail(e?.message ?? String(e)); }
  const tried = got.pages + got.misses.length;
  const missNote = got.misses.length ? `取れなかったページ${got.misses.length}件（例: ${decode(got.misses[0].url.replace(ORIGIN, ""))} ${got.misses[0].why}）` : "";
  if (got.aborted) return fail(`${got.aborted}。${got.pages}ページまで取れた`, got);
  if (!got.ids.size) return fail("物件コードが0件（ページの作りの変更の可能性）", got);
  if (got.misses.length > Math.max(3, tried * MAX_MISS_RATIO)) return fail(missNote, got);
  // 取れなかったページが少しあるときは、前の一覧の物件も残す（取れなかった駅の物件を落とさない。閉じていれば詳細ページの 404 で寝かせる）
  const list = [...new Set([...got.ids, ...(got.misses.length ? prev : [])])].sort();
  if (prev.length && list.length < prev.length * MIN_RATIO) {
    return fail(`一覧が ${prev.length}件 → ${list.length}件に減った（${Math.round(MIN_RATIO * 100)}%未満は作り直しの失敗とみなす）`, got);
  }
  const meta = new Map([...(got.misses.length ? prevLots : []), ...got.lots]);
  const notes = [];
  if (got.misses.length) notes.push(`${missNote}。その分は前の一覧の番号を残した`);
  if (got.total && got.ids.size < got.total * MIN_RATIO) notes.push(`駅の一覧で見つかったのは${got.ids.size}件（トップの表示は${got.total}件）`);
  const hourly = [...got.lots.values()].filter((v) => v.hourlyOk === true).length;
  log(`[JQパークス] 一覧を作り直した: 駅${got.stations}・${got.pages}ページ・${list.length}件（トップの表示${got.total ?? "不明"}件・前回${prev.length}件・時間貸OK ${hourly}件）`);
  if (abs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, list.join("\n") + "\n");
    const listed = new Set(list);
    fs.writeFileSync(lotsFile, JSON.stringify(Object.fromEntries([...meta].filter(([k]) => listed.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)))) + "\n");
    markFetched(abs);
    clearFailStamp(abs);
  }
  if (notes.length) {
    console.warn(`::warning::[JQパークス] ${notes.join("。")}`);
    list.listNote = notes.join("。");
  }
  return withMeta(list, meta);
}
