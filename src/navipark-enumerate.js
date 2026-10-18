// ナビパーク 全物件の列挙 --------------------------------------------------
// sitemap が無いため（/sitemap.xml は 404。robots.txt も 404。2026-10-18 確認）、エリア階層を辿って物件コードを収集する：
//   searchAreaList-{都道府県1..47} → parkingList-{都道府県}-{市区}（1ページ10件） → parkingDetail/{code}.html
// 市区ページは1ページ10件で、2ページ目からは /search/parkingList.php?prefCD=..&cityCD=..&page=N に続く
// （ページの並びの最後に「次へ」のリンクがある）。
//
// 以前は市区ページの1ページ目だけを読んでいたので、どの市区も10件で止まっていた。
// 一覧1,283件のうち、ちょうど10件の市区が78か所（東京26・神奈川25・千葉20・埼玉7）で、10件を超える市区は0。
// 世田谷区は「該当駐車場件数：49件」・5ページあり、2ページ目の10件は1件も一覧に無かった（2026-10-18 確認）。
// 並びは物件コードの古い順なので、新しい物件ほど一度も巡回されていなかった。
//
// 取り直しが途中で欠けたときは、欠けた一覧で上書きしない（前の一覧を使い続け、取得日 .fetched も進めない）。
// 以前は都道府県ページや市区ページが取れなくても黙って飛ばし、欠けた一覧を「作り直した」と記録していた。
// robots.txt に届かない・断られているとき（polite-fetch.js が本ページを送らずに skippedReason を返す）も同じで、
// 以前は47都道府県を全部飛ばして0件の一覧を書き、取得日も進めていた。そうなると7日間ナビパーク（約1,300件）を1件も回らず、
// health も「取る物件が無い＝成功」になる（2026-10-18 の点検の試しで分かった。本番では起きていない）。
// 守りは times-enumerate.js と同じ形（前の一覧の9割・14日で知らせる）にそろえ、cache-age.js の keepPrevIfShrunk（半分）は使わない。
// 二重に持つと、どちらの割合で止まったのか分からなくなるため。
// 収集した code 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。

import fs from "node:fs";
import { cacheFresh, markFetched, cacheAgeMs } from "./cache-age.js";
import path from "node:path";
import { politeFetch, sleep, failText } from "./polite-fetch.js";

const ORIGIN = "https://www.navipark1.com";
const PREFS = 47;
/** 1市区で辿るページの上限（10件/ページ）。いちばん多い市区でも十数ページの見込み。止まらない事故の歯止め */
const MAX_CITY_PAGES = 30;
/** 作り直した一覧が前の一覧のこの割合より少なければ、作り直しの失敗とみなす（times-enumerate.js と同じ） */
const MIN_RATIO = 0.9;
/** 前の一覧を使い続けてよい長さ。これを過ぎたら staleReason を付けて知らせる（run.js が health に出す） */
const STALE_WARN_MS = 14 * 864e5;
/** 相手先の一時的な不調（タイムアウト・5xx）のとき、1回だけ取り直すまでの待ち */
const RETRY_WAIT_MS = 30_000;
/** 作り直しに失敗したあと、次に作り直しを試すまでの間（1日3回の回のうち、おおむね1日1回にする）。
 *  一覧づくりは1回で約500リクエストあるので、失敗が続くときに毎回やり直すと相手先の負荷が増える */
const RETRY_AFTER_FAIL_MS = 20 * 3600e3;

const readList = (abs) => fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
const failStampOf = (abs) => `${abs}.failed`;

/** 都道府県の市区一覧ページ */
export const prefUrl = (pref) => `${ORIGIN}/searchAreaList-${pref}/`;

/** 市区ページ（city は "13-112" の形）。1ページ目はいままでどおりの URL、2ページ目からは「次へ」と同じ URL */
export function cityPageUrl(city, page) {
  if (page <= 1) return `${ORIGIN}/parkingList-${city}/`;
  const [pref, cityCd] = city.split("-");
  return `${ORIGIN}/search/parkingList.php?prefCD=${pref}&cityCD=${cityCd}&page=${page}`;
}

/** 都道府県ページから市区（"13-112"）を重複なく取り出す */
export function parseCityLinks(html) {
  return [...new Set([...String(html).matchAll(/parkingList-(\d+)-(\d+)/g)].map((m) => `${m[1]}-${m[2]}`))];
}

/** 市区ページから物件コードを重複なく取り出す */
export function parseCodes(html) {
  return [...new Set([...String(html).matchAll(/parkingDetail\/([A-Za-z0-9]+)\.html/g)].map((m) => m[1]))];
}

/** 「次へ」のリンクが指すページ番号。無ければ null（最後のページ） */
export function nextPageNo(html) {
  const m = String(html).match(/<a\b[^>]*\bhref="[^"]*[?&;]page=(\d+)[^"]*"[^>]*>\s*次へ\s*<\/a>/);
  return m ? Number(m[1]) : null;
}

/** 市区ページの「該当駐車場件数：49件」。読めなければ null */
export function declaredCount(html) {
  const m = String(html).match(/該当駐車場件数：\s*<span>\s*([\d,]+)\s*<\/span>/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

// 1ページ取る。タイムアウト・5xx だけは間をあけて1回だけ取り直す（403・404・429・robots.txt の禁止は取り直さない）。
// 取れなければ例外にする。1つでも欠けたら一覧は使わないので、その時点で打ち切って無駄なアクセスをしない
async function getPage(fetcher, url, st, retryWaitMs) {
  for (let attempt = 1; ; attempt++) {
    let res = null, err = null;
    try { res = await fetcher(url); } catch (e) { err = e; }
    if (!res?.skippedReason) st.requests++;
    if (res && res.ok && !res.skippedReason) return res.html ?? "";
    // robots.txt で見送ったとき（本ページは送っていない）は、その理由（届かない・断られている・Disallow）を出す
    const why = err ? err.message : !res ? "応答がありません" : failText(res);
    const transient = !res?.skippedReason && (err || !res || (res.status >= 500 && res.status <= 599));
    if (attempt === 1 && transient) {
      console.warn(`[ナビパーク] ${url} が取れない（${why}）。${Math.round(retryWaitMs / 1000)}秒あけて1回だけ取り直す`);
      st.retried++;
      await sleep(retryWaitMs);
      continue;
    }
    st.failed++;
    throw new Error(`${url} が取れない（${why}）`);
  }
}

// 都道府県 → 市区 → 市区のページ送り、の順に辿って物件コードを集める。
async function collect(fetcher, { maxCityPages, retryWaitMs }, st) {
  const codes = new Set();
  const cities = new Set();
  for (let pref = 1; pref <= PREFS; pref++) {
    const html = await getPage(fetcher, prefUrl(pref), st, retryWaitMs);
    for (const city of parseCityLinks(html)) {
      if (cities.has(city)) continue;   // 同じ市区を2回辿らない
      cities.add(city);
      const mine = new Set();
      let declared = null;
      for (let page = 1; ; page++) {
        const h = await getPage(fetcher, cityPageUrl(city, page), st, retryWaitMs);
        st.pages++;
        if (page === 1) declared = declaredCount(h);
        const fresh = parseCodes(h).filter((c) => !mine.has(c));
        for (const c of fresh) { mine.add(c); codes.add(c); }
        // 新しいコードが無いページで止める（ページ送りが効かず同じページが返るときの歯止めにもなる）
        if (!fresh.length) break;
        const next = nextPageNo(h);
        if (!next || next <= page) break;   // 「次へ」が無い＝最後のページ
        if (page >= maxCityPages) {
          st.capped.push(city);
          console.warn(`::warning::[ナビパーク] ${city} は${maxCityPages}ページで止めた（${mine.size}件。まだ続きがある）`);
          break;
        }
      }
      if (declared != null) {
        st.declared += declared;
        if (mine.size < declared) st.short.push(`${city}（${mine.size}/${declared}件）`);
      }
    }
  }
  st.cities = cities.size;
  if (!cities.size) throw new Error("都道府県ページに市区のリンクが1つもありません（ページの作りの変更の可能性）");
  if (!codes.size) throw new Error("市区ページに物件コードが1件もありません（ページの作りの変更の可能性）");
  return [...codes];
}

// 物件コード一覧を返す（キャッシュ優先）。
// 作り直しに失敗したら（1ページでも取れない・前の一覧の9割に満たない）、前の一覧があればそれを使い続ける。
// .fetched は進めないが、次に試すのは RETRY_AFTER_FAIL_MS あと（失敗の時刻を <一覧>.failed に残す）。
// 前の一覧が無いときだけ例外にする。長く作り直せていないときは返す配列に staleReason を付ける。
// fetcher・maxCityPages・retryWaitMs はテスト用（既定は polite-fetch・30ページ・30秒）。
export async function getAllNaviparkCodes({
  cacheFile, cacheMs, fetcher = politeFetch, maxCityPages = MAX_CITY_PAGES, retryWaitMs = RETRY_WAIT_MS,
}) {
  const abs = path.resolve(cacheFile);
  const old = fs.existsSync(abs) ? readList(abs) : null;
  // 前の一覧が空なら、取得日が新しくても作り直す（空の一覧で7日間何もしないことにしない）
  if (old?.length && cacheFresh(abs, cacheMs)) return old;
  const useOld = (why) => {
    const ageMs = cacheAgeMs(abs);
    const age = Number.isFinite(ageMs) ? `${(ageMs / 864e5).toFixed(0)}日前` : "取得日不明";
    console.warn(`::warning::[ナビパーク] 一覧を作り直せなかったので、前の一覧（${old.length}件・${age}）を使う: ${why}`);
    if (!(ageMs < STALE_WARN_MS)) old.staleReason = `一覧を作り直せていない（${age}の一覧）: ${why}`;
    return old;
  };

  // 前回の作り直しが失敗して間もないなら、この回は試さない（失敗が続くときに毎回約500リクエストを重ねない）
  if (old?.length) {
    try {
      const [at, ...why] = fs.readFileSync(failStampOf(abs), "utf8").trim().split(" ");
      const since = Date.now() - Date.parse(at);
      if (since < RETRY_AFTER_FAIL_MS) {
        console.log(`[ナビパーク] 前回の作り直しが ${(since / 3600e3).toFixed(1)}時間前に失敗したので、この回は試さない（${RETRY_AFTER_FAIL_MS / 3600e3}時間あける）`);
        return useOld(`前回の失敗: ${why.join(" ")}`);
      }
    } catch { /* 失敗の記録が無い */ }
  }

  const st = { requests: 0, retried: 0, failed: 0, pages: 0, cities: 0, declared: 0, capped: [], short: [] };
  const t0 = Date.now();
  let list;
  try {
    list = await collect(fetcher, { maxCityPages, retryWaitMs }, st);
    if (old && list.length < old.length * MIN_RATIO) {
      throw new Error(`一覧が ${old.length}件 → ${list.length}件に減った（${Math.round(MIN_RATIO * 100)}%未満は作り直しの失敗とみなす）`);
    }
  } catch (e) {
    console.warn(`[ナビパーク] 一覧づくり: 取得${st.requests}回（取り直し${st.retried}回・失敗${st.failed}件）・市区ページ${st.pages}枚で止めた`);
    if (!old?.length) throw e;
    try { fs.writeFileSync(failStampOf(abs), `${new Date().toISOString()} ${e.message}`); } catch { /* 書けなくても巡回は続ける */ }
    return useOld(e.message);
  }

  console.log(
    `[ナビパーク] 一覧を作り直した: 市区${st.cities}・市区ページ${st.pages}枚・取得${st.requests}回` +
    `（取り直し${st.retried}回・約${Math.round((Date.now() - t0) / 60000)}分） → ${list.length}件` +
    `（前回${old ? old.length : 0}件${st.declared ? `・サイトの「該当駐車場件数」の合計${st.declared}件` : ""}）`
  );
  if (st.capped.length) console.warn(`::warning::[ナビパーク] ${maxCityPages}ページで止めた市区が${st.capped.length}か所: ${st.capped.join(" ")}`);
  // 表示の件数より少ない市区があれば知らせる（ページ送りの作りが変わって2ページ目から読めなくなった、などに気づくため）
  if (st.short.length) {
    const level = list.length < st.declared * MIN_RATIO ? "::warning::" : "";
    console.warn(`${level}[ナビパーク] 表示の件数より少ない市区が${st.short.length}か所: ${st.short.slice(0, 20).join(" ")}${st.short.length > 20 ? " …" : ""}`);
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  markFetched(abs);
  fs.rmSync(failStampOf(abs), { force: true });   // 失敗の記録は、作り直せたら消す
  return list;
}
