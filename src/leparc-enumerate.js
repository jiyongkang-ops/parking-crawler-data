// NTTル・パルク: attr 一覧から NRP ID を列挙 -----------------------------------
// 一覧は /b/leperc/attr/（1ページ目）と /b/leperc/attr/?start=N（N ページ目）。1ページ20件で、全24ページ・471件（2026-11-01）。
// ?start= は「何件目から」ではなくページ番号（サイトの「もっと見る」の base.js の getMoreList が start={今のページ+1} を送る）。
// 1ページ目の window.pageState の endPage（最後のページ）と「471件の店舗を表示」の件数を読み、2〜endPage ページを順に取る。
//
// 以前（2026-10-19 の記録）は ?start を件数と読み違え、start=0・20（1ページ目と20ページ目）だけを取って40件で止めていた。
// 「3ページ目（start=40）以降は 403＝連続取得を拒否する意思表示」とみなしていたが、start=40 は40ページ目で、全24ページを超えた
// ページにサイト自身のエラー画面（「お探しのページが見つかりませんでした」EX002・pageType 'error'）が 403 で返るだけだった。
// 当ボットを断る答えではない（robots.txt は 404＝制限なし・ページには meta robots ALL。2026-11-01 に当社の UA で確かめた）。
// 最後のページより先は取りに行かない。
//
// 途中のページが取れなかった・取れた件数がサイトの表示の件数の9割に満たない（ページの作りの変更など）ときは、欠けた一覧で上書きしない。
// この回は前の一覧と合わせた一覧を使い、取得日（.fetched）は進めない（次の回にまた作り直す。1回24リクエストほど）。
// health の reason に出す（listNote。ok は true のまま）。前の一覧が14日より古いままなら staleReason（health は ok:false）にする
// （times-enumerate.js と同じ形）。
import fs from "node:fs";
import { cacheFresh, markFetched, cacheAgeMs } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText, fetchErrorText } from "./polite-fetch.js";

const BASE = "https://sasp.mapion.co.jp/b/leperc/attr/";
/** 辿るページの上限。endPage が読めないとき（ページの作りの変更）の歯止めにもなる。いまは24ページ */
export const MAX_PAGES = 40;
/** 取れた件数がサイトの表示の件数のこの割合より少なければ、作り直しの失敗とみなす */
const MIN_RATIO = 0.9;
/** 前の一覧を使い続けてよい長さ。これを過ぎたら staleReason を付けて知らせる（run.js が health に ok:false で出す） */
const STALE_WARN_MS = 14 * 864e5;

/** page ページ目の一覧。1ページ目は ?start なし、2ページ目からは ?start=ページ番号 */
export const listUrl = (page) => (page <= 1 ? BASE : `${BASE}?start=${page}`);

/** 一覧のページから物件 ID（NRPxxxxx）を重複なく取り出す */
export function parseLeparcIds(html) {
  return [...new Set([...String(html).matchAll(/\/b\/leperc\/info\/(NRP\d+)\//g)].map((m) => m[1]))];
}

/** window.pageState = {pageType: 'attr', nowPage: 1, endPage: 24} を読む。無ければ null。
 *  最後のページを超えたページ（40ページ目など）はエラー画面で {pageType: 'error'} だけになる */
export function parsePageState(html) {
  const m = String(html).match(/window\.pageState\s*=\s*\{([^}]*)\}/);
  if (!m) return null;
  const num = (k) => { const x = m[1].match(new RegExp(`\\b${k}\\s*:\\s*(\\d+)`)); return x ? Number(x[1]) : null; };
  return { pageType: (m[1].match(/pageType\s*:\s*'([^']*)'/) || [])[1] ?? null, nowPage: num("nowPage"), endPage: num("endPage") };
}

/** 「<span class="num">471</span>件の店舗を表示」の件数。読めなければ null */
export function parseDeclaredCount(html) {
  const m = String(html).match(/<span class="num">\s*([\d,]+)\s*<\/span>\s*件/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

// fetcher はテスト用（既定は polite-fetch）
export async function getAllLeparcIds({ cacheFile, cacheMs = 7 * 864e5, fetcher = politeFetch } = {}) {
  const prev = cacheFile && fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean) : [];
  if (cacheFile && fs.existsSync(cacheFile)) {
    if (cacheFresh(cacheFile, cacheMs)) return prev;
  }
  const ids = new Set();
  let endPage = null, declared = null, why = null, pages = 0;
  for (let page = 1; page <= Math.min(endPage ?? MAX_PAGES, MAX_PAGES); page++) {
    let res;
    try { res = await fetcher(listUrl(page)); } catch (e) { why = `${page}ページ目: ${fetchErrorText(e)}`; break; }
    throwIfRobotsSkipped(res, "ル・パルク一覧");   // 「0件（ページ構造変更の可能性）」と取り違えない
    if (!res.ok || res.skippedReason) { why = `${page}ページ目が ${failText(res)}`; break; }
    pages++;
    if (page === 1) {
      endPage = parsePageState(res.html)?.endPage ?? null;
      declared = parseDeclaredCount(res.html);
    }
    const found = parseLeparcIds(res.html);
    const before = ids.size;
    found.forEach((x) => ids.add(x));
    // 新しい ID が無いページで止める（最後のページの先・ページ送りが効かず同じページが返るときの歯止め）
    if (found.length === 0 || ids.size === before) break;
  }
  const list = [...ids].sort();
  // 途中で取れなかったページが無く、表示の件数（読めなければ前の一覧の件数）の9割に届いたか。
  // 1ページでも取れなければ、9割に届いていても上書きしない（そのページの20件が7日間一覧から落ちるため）
  const target = declared ?? prev.length;
  const enough = list.length > 0 && !why && list.length >= target * MIN_RATIO;
  if (enough) {
    console.log(`[ルパルク] 一覧を作り直した: ${pages}ページ・${list.length}件（表示${declared ?? "不明"}件・前回${prev.length}件）`);
    if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
    if (cacheFile) markFetched(cacheFile);
    return list;
  }
  const short = `一覧が${list.length}件しか取れなかった（${declared != null ? `表示${declared}件` : `表示の件数が読めない・前回${prev.length}件`}` +
    `・${pages}ページ${endPage ? `／全${endPage}ページ` : ""}${why ? `。${why}` : ""}）`;
  if (!prev.length) {
    if (!list.length) throw new Error(why ? `ル・パルク一覧: ${why}` : "ル・パルク一覧の解析結果が0件（ページ構造変更の可能性）");
    // 前の一覧が無い（初回）。取れた分で回し、ファイルには残さない（次の回にまた作り直す）
    console.warn(`::warning::[ルパルク] ${short}。取れた分で回し、次の回に作り直す`);
    list.listNote = `${short}。次の回に作り直す`;
    return list;
  }
  // 欠けた一覧で上書きしない。この回は前の一覧と合わせて使う（取れなかったページの物件を落とさない）
  const merged = [...new Set([...prev, ...list])].sort();
  const ageMs = cacheAgeMs(cacheFile);
  const age = Number.isFinite(ageMs) ? `${(ageMs / 864e5).toFixed(0)}日前` : "取得日不明";
  console.warn(`::warning::[ルパルク] ${short}。前の一覧（${prev.length}件・${age}）と合わせた${merged.length}件で回し、次の回に作り直す`);
  if (!(ageMs < STALE_WARN_MS)) merged.staleReason = `一覧を作り直せていない（前の一覧は${age}）: ${short}`;
  else merged.listNote = `${short}。前の一覧（${prev.length}件・${age}）と合わせて回している`;
  return merged;
}
