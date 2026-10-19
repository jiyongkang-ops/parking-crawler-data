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
// 取れなかったときの扱い（2026-10-18 の2回目の点検で分けた）:
//  ・1つの市区・都道府県のページだけが無い（404・410）、中身が無い（200 なのに物件コードも「見つかりませんでした」も無い。
//    メンテナンス画面など）、表示の件数の半分も読めない、のどれかなら、その市区・都道府県だけを「取れなかった」として飛ばし、
//    作り直しは続ける。飛ばした所は、前回の作り直しで市区ごとに控えた番号（<一覧>.cities.json）をそのまま残す。
//    控えが無ければ（この直しのあと初めての作り直しなど）、前の一覧のうち今回見つからなかった番号を全部残す（落とすより残すほうを選ぶ）。
//    取れなかった所はログ（::warning::）と health の reason（ok は true のまま。run.js の listNote）に出す。
//    以前は1ページでも 404 が続くと一覧づくりが毎日まるごと失敗し、2ページ目以降を辿る直しがいつまでも効かなかった。
//  ・飛ばした所が MAX_SKIPPED を超える、403・429・取り直しても取れない 5xx・タイムアウト、robots.txt で見送り、
//    取り直しや時間の上限を超えた、前の一覧の9割に満たない（取れなかった所の前の番号を残したあと）、
//    今回読めた番号が前の一覧の半分に満たない、のどれかなら、作り直しの失敗とする。
//    欠けた一覧で上書きせず、前の一覧を使い続ける（取得日 .fetched は進めない。次に試すのは20時間あと。
//    失敗が続けば 2日→4日→7日 と延ばす。RETRY_AFTER_FAIL_MS）。
//    以前は都道府県ページや市区ページが取れなくても黙って飛ばし、欠けた一覧を「作り直した」と記録していた。
//    robots.txt に届かない・断られているときは、47都道府県を全部飛ばして0件の一覧を書き、7日間1件も回らないところだった
//    （2026-10-18 の点検の試しで分かった。本番では起きていない）。
// 守りは times-enumerate.js と同じ形（前の一覧の9割・14日で知らせる）にそろえ、cache-age.js の keepPrevIfShrunk（半分）は使わない。
// 二重に持つと、どちらの割合で止まったのか分からなくなるため。
// 収集した code 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。

import fs from "node:fs";
import { cacheFresh, markFetched, cacheAgeMs, readFailStamp, writeFailStamp, clearFailStamp } from "./cache-age.js";
import path from "node:path";
import { politeFetch, sleep, failText, fetchErrorText } from "./polite-fetch.js";
import { writeFileAtomic } from "./write-atomic.js";

const ORIGIN = "https://www.navipark1.com";
const PREFS = 47;
/** 1市区で辿るページの上限（10件/ページ）。いちばん多い市区でも十数ページの見込み。止まらない事故の歯止め */
const MAX_CITY_PAGES = 30;
/** 作り直した一覧（取れなかった所の前の番号を残したあと）が前の一覧のこの割合より少なければ、作り直しの失敗とみなす（times-enumerate.js と同じ）。
 *  取れなかったと分かっている所は前の番号を残すので、ここで捕まるのは「黙って欠けた」分（ページの作りの変更など） */
const MIN_RATIO = 0.9;
/** 今回実際に読めた番号が前の一覧のこの割合より少なければ、作り直しの失敗とみなす。
 *  1つの県（東京・千葉はそれぞれ一覧の約3分の1）だけが取れないなら進めるが、大きな県がいくつも同時に取れないときはサイト全体の不調とみなす */
const MIN_READ_RATIO = 0.5;
/** 前の一覧を使い続けてよい長さ。これを過ぎたら staleReason を付けて知らせる（run.js が health に ok:false で出す） */
const STALE_WARN_MS = 14 * 864e5;
/** 相手先の一時的な不調（タイムアウト・5xx）のとき、1回だけ取り直すまでの待ち */
const RETRY_WAIT_MS = 30_000;
/** 一覧づくり全体で取り直してよい回数。超えたら相手先の不調とみなして打ち切る。
 *  上限が無いと、毎回1回目だけ失敗するサイトで約511ページ×（20秒＋30秒＋4秒）≒7.7時間かかり、リクエストも約2倍になる */
const MAX_RETRIES = 5;
/** 一覧づくり全体の時間の上限（分）。ふだんは約34分（約511回×4秒。4秒より遅い応答はその分のびる）。超えたら打ち切る。
 *  巡回の45分と合わせても約135分で、ワークフローの上限（340分）に収まる */
const MAX_MINUTES = 90;
/** 飛ばしてよい市区・都道府県の数。超えたら、サイトの作りの変更・保守などで全体が取れていないとみなして打ち切る */
const MAX_SKIPPED = 10;
/** 市区で読めた件数が「該当駐車場件数」のこの割合より少なければ、その市区は取れなかったとみなす（2ページ目以降が保守の画面など） */
const SHORT_RATIO = 0.5;
/** 作り直しに失敗したあと、次に作り直しを試すまでの間。続けて失敗した回数（<一覧>.failed に残す）ごとに
 *  1回目 20時間（1日3回の回のうち、おおむね1日1回）→ 2回目 2日 → 3回目 4日 → 4回目から 7日（上限）。作り直せたら元に戻る。
 *  一覧づくりは1回で約500リクエストあるので、失敗が続くときに毎回やり直すと相手先の負荷が増える。
 *  20時間のままだと、断られている・保守が長いときも毎日約500回を送り続けていた（2026-10-19 の最終点検） */
const RETRY_AFTER_FAIL_MS = [20 * 3600e3, 2 * 864e5, 4 * 864e5, 7 * 864e5];
/** 続けて count 回失敗したあとの待ち */
export const retryAfterFailMs = (count) =>
  RETRY_AFTER_FAIL_MS[Math.min(Math.max(1, Math.floor(count) || 1), RETRY_AFTER_FAIL_MS.length) - 1];
const hoursText = (ms) => (ms < 864e5 * 2 ? `${ms / 3600e3}時間` : `${ms / 864e5}日`);
/** health の reason に並べる、取れなかった所の数 */
const NOTE_MAX = 5;

const readList = (abs) => fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
/** 市区ごとの番号の控え（取れなかった市区の番号を残すため）。{ at, missing: [{ key, why }], cities: { "13-112": [番号…] } } */
const citiesFileOf = (abs) => `${abs}.cities.json`;

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

/** 物件の無い県の都道府県ページか（「お探しのエリアに駐車場は見つかりませんでした。」。青森で確認 2026-10-18）。
 *  市区のリンクが0件でこの文も無いページは、保守の画面などとみなす */
export const isEmptyAreaPage = (html) => /駐車場は見つかりませんでした/.test(String(html));

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

// 1ページ取る。404・410 は null を返す（そのページだけが無い。呼び出し側で、その市区・都道府県を飛ばす）。
// タイムアウト・5xx だけは間をあけて1回だけ取り直す（403・429・robots.txt の見送りは取り直さない）。
// それ以外で取れなければ例外にする（作り直しの失敗。残りのページも同じ答えの見込みなので、無駄なアクセスをしない）。
// 取り直しの合計回数（maxRetries）と、一覧づくり全体の時間（maxMs）にも上限を設ける
async function getPage(fetcher, url, st, o) {
  for (let attempt = 1; ; attempt++) {
    const elapsed = Date.now() - st.t0;
    if (elapsed > o.maxMs) {
      throw new Error(`一覧づくりが${Math.round(o.maxMs / 60000)}分を超えた（取得${st.requests}回・約${Math.round(elapsed / 60000)}分。相手先が遅い見込み）`);
    }
    let res = null, err = null;
    try { res = await fetcher(url); } catch (e) { err = e; }
    // robots.txt に届かない・断られている・Disallow。本ページは送っていないので数えない。残りのページも同じ答えなので打ち切る
    if (res?.skippedReason) { st.failed++; throw new Error(`${url} を取りに行けない（${failText(res)}）`); }
    st.requests++;
    if (res && res.ok) return res.html ?? "";
    if (res && (res.status === 404 || res.status === 410)) return null;
    const why = err ? fetchErrorText(err) : !res ? "応答がありません" : `HTTP ${res.status}`;
    const transient = !!err || !res || (res.status >= 500 && res.status <= 599);
    if (attempt === 1 && transient) {
      if (st.retried >= o.maxRetries) {
        st.failed++;
        throw new Error(`取り直しが上限の${o.maxRetries}回に達した（相手先の不調の見込み。最後は ${url}: ${why}）`);
      }
      console.warn(`[ナビパーク] ${url} が取れない（${why}）。${Math.round(o.retryWaitMs / 1000)}秒あけて1回だけ取り直す`);
      st.retried++;
      await sleep(o.retryWaitMs);
      continue;
    }
    st.failed++;
    throw new Error(`${url} が取れない（${why}）`);
  }
}

// 都道府県 → 市区 → 市区のページ送り、の順に辿って物件コードを集める。
// prevCities は前回の控え（市区 → 番号。無ければ null）。都道府県ページに市区が0件のとき、前回あったかを見るのに使う。
// 戻り値: { byCity: Map(市区 → Set(番号)), missing: [{ key, why }], codes: [番号…（辿った順）] }。
// missing の key は市区（"13-112"）か都道府県（"pref:13"）
async function collect(fetcher, o, st, prevCities) {
  const byCity = new Map();
  const missing = [];
  const skip = (key, why) => {
    missing.push({ key, why });
    console.warn(`::warning::[ナビパーク] ${labelOf(key)} が取れなかった（${why}）。前の一覧の番号を残す`);
    if (missing.length > o.maxSkipped) {
      throw new Error(`取れなかった市区・都道府県が上限の${o.maxSkipped}か所を超えた（${missing.slice(0, NOTE_MAX).map(noteOf).join("・")} …）。サイトの作りの変更・保守の見込み`);
    }
  };
  for (let pref = 1; pref <= PREFS; pref++) {
    const html = await getPage(fetcher, prefUrl(pref), st, o);
    if (html == null) { skip(`pref:${pref}`, "HTTP 404"); continue; }
    const cities = parseCityLinks(html);
    if (!cities.length) {
      // 物件の無い県も 200 で返り、「見つかりませんでした」と出る（青森 2026-10-18）。その文が無ければ保守の画面などとみなす。
      // ただし前回の控えでこの県に市区が無かったなら、文の書き方が変わっただけとみなして飛ばさない
      const before = prevCities ? Object.keys(prevCities).filter((k) => k.startsWith(`${pref}-`)).length : null;
      if (!isEmptyAreaPage(html) && before !== 0) skip(`pref:${pref}`, `市区のリンクも「見つかりませんでした」も無い${before ? `（前回は${before}市区）` : ""}`);
      continue;
    }
    for (const city of cities) {
      if (byCity.has(city)) continue;   // 同じ市区を2回辿らない
      const mine = new Set();
      byCity.set(city, mine);
      let declared = null, why = null;
      for (let page = 1; ; page++) {
        const h = await getPage(fetcher, cityPageUrl(city, page), st, o);
        // 2ページ目以降が無ければ、その市区はそこまで（読めた番号は使い、前回の番号も残す）
        if (h == null) { why = `${page}ページ目が HTTP 404`; break; }
        st.pages++;
        if (page === 1) declared = declaredCount(h);
        const found = parseCodes(h);
        // 200 なのに物件コードが0件（「該当駐車場件数：0件」でもない）。保守の画面・アクセス制限の画面などの見込み
        if (page === 1 && !found.length && declared !== 0) { why = "200 だが物件コードが0件（保守の画面などの見込み）"; break; }
        const fresh = found.filter((c) => !mine.has(c));
        for (const c of fresh) mine.add(c);
        // 新しいコードが無いページで止める（ページ送りが効かず同じページが返るときの歯止めにもなる）
        if (!fresh.length) break;
        const next = nextPageNo(h);
        if (!next || next <= page) break;   // 「次へ」が無い＝最後のページ
        if (page >= o.maxCityPages) {
          st.capped.push(city);
          console.warn(`::warning::[ナビパーク] ${city} は${o.maxCityPages}ページで止めた（${mine.size}件。まだ続きがある）`);
          break;
        }
      }
      if (!why && declared != null) {
        st.declared += declared;
        if (mine.size < declared) st.short.push(`${city}（${mine.size}/${declared}件）`);
        if (mine.size < declared * SHORT_RATIO) why = `表示${declared}件のうち${mine.size}件しか読めない`;
      }
      if (why) skip(city, why);
    }
  }
  st.cities = byCity.size;
  if (!byCity.size) throw new Error("都道府県ページに市区のリンクが1つもありません（ページの作りの変更の可能性）");
  const codes = [...new Set([...byCity.values()].flatMap((s) => [...s]))];
  if (!codes.length) throw new Error("市区ページに物件コードが1件もありません（ページの作りの変更の可能性）");
  return { byCity, missing, codes };
}

const labelOf = (key) => (key.startsWith("pref:") ? `都道府県${key.slice(5)}` : `市区${key}`);
const noteOf = (m) => `${labelOf(m.key)} ${m.why}`;

// 取れなかった市区・都道府県の番号を、前回の控えから残す。戻り値は { list, cities, kept }。
//   list   … 今回読めた番号（辿った順）＋残した番号
//   cities … 次の回の控え。取れなかった市区は「今回読めた番号＋前回の番号」にする（また取れなくても落とさない）
// 控えに無い所（控えのファイルが無い・新しく出てきた市区）は、前の一覧のうち今回見つからなかった番号を全部残し、その所の控えに入れる。
// どの市区の番号か分からないので広めに残す（次に取れた回に、本当に無くなった番号は落ちる）
function keepMissing({ byCity, missing, codes }, old, prevCities) {
  const cities = {};
  for (const [city, set] of byCity) cities[city] = [...set];
  const keep = new Set();
  const unknown = [];
  for (const m of missing) {
    const keys = m.key.startsWith("pref:")
      ? Object.keys(prevCities ?? {}).filter((k) => k.startsWith(`${m.key.slice(5)}-`))
      : prevCities?.[m.key] ? [m.key] : [];
    // 前回の控えがあって、その県に市区が無かった（物件の無い県）なら、残す番号も無い
    if (!keys.length && !(prevCities && m.key.startsWith("pref:"))) { unknown.push(m.key); continue; }
    for (const k of keys) {
      for (const c of prevCities[k]) keep.add(c);
      cities[k] = [...new Set([...(cities[k] ?? []), ...prevCities[k]])];
    }
  }
  if (unknown.length && old?.length) {
    const found = new Set(codes);
    const rest = old.filter((c) => !found.has(c) && !keep.has(c));
    for (const c of rest) keep.add(c);
    for (const key of unknown) {
      const k = key.startsWith("pref:") ? `${key.slice(5)}-?` : key;   // 県の分は「県番号-?」に入れる（次の回は県番号で引ける）
      cities[k] = [...new Set([...(cities[k] ?? []), ...rest])];
    }
  }
  const list = [...codes];
  const seen = new Set(list);
  let kept = 0;
  for (const c of keep) if (!seen.has(c)) { seen.add(c); list.push(c); kept++; }
  return { list, cities, kept };
}

function readCities(abs) {
  try {
    const j = JSON.parse(fs.readFileSync(citiesFileOf(abs), "utf8"));
    return j && typeof j.cities === "object" && j.cities ? j : null;
  } catch { return null; }   // 無い・壊れている（この直しより前の一覧）
}

// 1市区1行にして書く（毎週の作り直しの差分を git で読めるように）
function writeCities(abs, missing, cities) {
  const rows = Object.entries(cities).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  writeFileAtomic(citiesFileOf(abs),
    `{\n "at": ${JSON.stringify(new Date().toISOString())},\n "missing": ${JSON.stringify(missing)},\n "cities": {\n${rows.join(",\n")}\n }\n}\n`);
}

/** 取れなかった所の短い説明（health の reason・ログ用） */
const missingNote = (missing) =>
  `取れなかった市区・都道府県${missing.length}か所（${missing.slice(0, NOTE_MAX).map(noteOf).join("・")}${missing.length > NOTE_MAX ? " …" : ""}）`;

// 物件コード一覧を返す（キャッシュ優先）。
// 作り直しに失敗したら（上の「取れなかったときの扱い」）、前の一覧があればそれを使い続ける。
// .fetched は進めないが、次に試すのは RETRY_AFTER_FAIL_MS あと（失敗の時刻と続けて失敗した回数を <一覧>.failed に残す）。
// 前の一覧が無いときだけ例外にする。長く作り直せていないときは返す配列に staleReason を付ける（health は ok:false）。
// 一部の市区を飛ばしたとき・作り直せず前の一覧を使っているときは listNote を付ける（health の reason に出す。ok は true のまま）。
// fetcher・maxCityPages・retryWaitMs・maxRetries・maxMinutes・maxSkipped はテスト用（既定は polite-fetch と上の定数）。
export async function getAllNaviparkCodes({
  cacheFile, cacheMs, fetcher = politeFetch, maxCityPages = MAX_CITY_PAGES, retryWaitMs = RETRY_WAIT_MS,
  maxRetries = MAX_RETRIES, maxMinutes = MAX_MINUTES, maxSkipped = MAX_SKIPPED,
}) {
  const abs = path.resolve(cacheFile);
  const old = fs.existsSync(abs) ? readList(abs) : null;
  const prev = readCities(abs);
  // 前の一覧が空なら、取得日が新しくても作り直す（空の一覧で7日間何もしないことにしない）
  if (old?.length && cacheFresh(abs, cacheMs)) {
    // 前回の作り直しで飛ばした所があれば、次の作り直しまで毎回 health に出す
    if (prev?.missing?.length) old.listNote = `前回の一覧づくり（${String(prev.at).slice(0, 10)}）で${missingNote(prev.missing)}。その分は前の一覧の番号を残している`;
    return old;
  }
  const useOld = (why) => {
    const ageMs = cacheAgeMs(abs);
    const age = Number.isFinite(ageMs) ? `${(ageMs / 864e5).toFixed(0)}日前` : "取得日不明";
    console.warn(`::warning::[ナビパーク] 一覧を作り直せなかったので、前の一覧（${old.length}件・${age}）を使う: ${why}`);
    if (!(ageMs < STALE_WARN_MS)) old.staleReason = `一覧を作り直せていない（前の一覧は${age}）: ${why}`;
    else old.listNote = `一覧を作り直せず、前の一覧（${old.length}件・${age}）を使っている: ${why}`;
    return old;
  };

  // 前回の作り直しが失敗して間もないなら、この回は試さない（失敗が続くときに毎回約500リクエストを重ねない）
  const failed = old?.length ? readFailStamp(abs) : null;
  if (failed) {
    const since = Date.now() - failed.at;
    const wait = retryAfterFailMs(failed.count);
    if (since < wait) {
      console.log(`[ナビパーク] 前回の作り直しが ${(since / 3600e3).toFixed(1)}時間前に失敗した（続けて${failed.count}回）ので、` +
        `この回は試さない（${hoursText(wait)}あける）`);
      return useOld(`前回の失敗: ${failed.why}（続けて${failed.count}回。次に試すのは${hoursText(wait)}あと）`);
    }
  }

  const st = { t0: Date.now(), requests: 0, retried: 0, failed: 0, pages: 0, cities: 0, declared: 0, capped: [], short: [] };
  const o = { maxCityPages, retryWaitMs, maxRetries, maxMs: maxMinutes * 60_000, maxSkipped };
  let got, list, cities, kept;
  try {
    got = await collect(fetcher, o, st, prev?.cities ?? null);
    ({ list, cities, kept } = keepMissing(got, old, prev?.cities ?? null));
    if (old && list.length < old.length * MIN_RATIO) {
      throw new Error(`一覧が ${old.length}件 → ${list.length}件に減った（${kept ? `取れなかった所の前の番号${kept}件を含む。` : ""}${Math.round(MIN_RATIO * 100)}%未満は作り直しの失敗とみなす）`);
    }
    if (old && got.codes.length < old.length * MIN_READ_RATIO) {
      throw new Error(`今回読めたのは${got.codes.length}件で、前の一覧${old.length}件の${Math.round(MIN_READ_RATIO * 100)}%に満たない（取れなかった所が大きすぎる。サイト全体の不調の見込み）`);
    }
  } catch (e) {
    console.warn(`[ナビパーク] 一覧づくり: 取得${st.requests}回（取り直し${st.retried}回・失敗${st.failed}件）・市区ページ${st.pages}枚・約${Math.round((Date.now() - st.t0) / 60000)}分で止めた`);
    if (!old?.length) throw e;
    writeFailStamp(abs, e.message, (failed?.count ?? 0) + 1);
    return useOld(e.message);
  }

  console.log(
    `[ナビパーク] 一覧を作り直した: 市区${st.cities}・市区ページ${st.pages}枚・取得${st.requests}回` +
    `（取り直し${st.retried}回・約${Math.round((Date.now() - st.t0) / 60000)}分） → ${list.length}件` +
    `（前回${old ? old.length : 0}件${st.declared ? `・サイトの「該当駐車場件数」の合計${st.declared}件` : ""}` +
    `${kept ? `・取れなかった所の前の番号${kept}件を含む` : ""}）`
  );
  if (st.capped.length) console.warn(`::warning::[ナビパーク] ${maxCityPages}ページで止めた市区が${st.capped.length}か所: ${st.capped.join(" ")}`);
  // 表示の件数より少ない市区があれば知らせる（ページ送りの作りが変わって2ページ目から読めなくなった、などに気づくため）
  if (st.short.length) {
    const level = got.codes.length < st.declared * MIN_RATIO ? "::warning::" : "";
    console.warn(`${level}[ナビパーク] 表示の件数より少ない市区が${st.short.length}か所: ${st.short.slice(0, 20).join(" ")}${st.short.length > 20 ? " …" : ""}`);
  }
  if (got.missing.length) {
    list.listNote = `一覧づくりで${missingNote(got.missing)}。その分は前の一覧の番号${kept}件を残した`;
    console.warn(`::warning::[ナビパーク] ${list.listNote}`);
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  writeFileAtomic(abs, list.join("\n") + "\n");   // 書いている途中で止められても、欠けた一覧を残さない
  writeCities(abs, got.missing, cities);
  markFetched(abs);
  clearFailStamp(abs);   // 失敗の記録は、作り直せたら消す（待ちも元に戻る）
  return list;
}
