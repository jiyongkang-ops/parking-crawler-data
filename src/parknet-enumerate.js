// パークネット: 検索トップ → 都道府県ページ → 市区リンク（pref_cd\tcity）を列挙 --
import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, failText, fetchErrorText } from "./polite-fetch.js";
import { prefListUrl, parseCityLinks, cityListUrl, parseParknetList, parseParknetTotal, parsePagerOffsets,
  PARKNET_PAGE_SIZE, PARKNET_MAX_PAGES } from "./parknet.js";

const TOP = "https://parknet.shinmaywa.co.jp/parknet/search/";

export async function getAllParknetCities({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    if (cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const top = await politeFetch(TOP);
  if (!top.ok) throw new Error(`パークネット トップ取得失敗: ${failText(top)}`);
  const prefs = [...new Set([...top.html.matchAll(/city_list_(\d+)\.html/g)].map((m) => m[1]))];
  if (!prefs.length) throw new Error("都道府県リンクが0件（ページ構造変更の可能性）");
  const cities = new Set();
  for (const p of prefs) {
    let res;
    try { res = await politeFetch(prefListUrl(p)); } catch { continue; }
    if (!res.ok || res.skippedReason) continue;
    for (const c of parseCityLinks(res.html)) cities.add(c);
  }
  const list = [...cities].sort();
  if (!list.length) throw new Error("パークネット市区リンクが0件");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  if (cacheFile) markFetched(cacheFile);
  return list;
}

/**
 * 1つの市区の一覧を、最後のページまで（10件ずつ・offset=0,10,20…）取る。2026-10-18 まで1ページ目しか取っておらず、
 * 10件を超える市区は毎回10件で止まっていた（札幌市中央区は59件のうち10件だけ）。
 *   onPage(records, url) … ページごとに、そのページで初めて見た物件を渡す（取れた分をすぐ記録するため）。
 *   次のページがあるかは、総件数（「該当した駐車場：N件」）で決める。総件数が読めないときはページ送りのリンクに次の offset があるかで決める。
 * 途中のページが取れなかったとき（例外・HTTP エラー・robots.txt の Disallow）は、その市区はそこで止める。
 *   それまでのページの物件は onPage で渡し済みで、取れなかったページの物件も何も消さない（料金の記録は追記だけで、
 *   パークネットには「一覧に無ければ閉鎖」の扱いも無い）。次の回にまた1ページ目から取る。
 * robots.txt で断られた・届かない（blocked・transient。本ページは送っていない）ときは stop を返す。残りの市区も同じ答えなので、
 *   呼ぶ側でパークネットごと打ち切る。
 * 同じ物件しか返らないページ（offset が効かなくなった＝サイトの作りの変更）が来たら、それ以上は取りに行かない（dup）。
 * 戻り値: { pages: 送ったページ数, total, got: 渡した物件数, failed: { offset, why } | null, stop, stopKind, capped, dup }
 */
export async function crawlParknetCity(prefCd, city, { onPage, maxPages = PARKNET_MAX_PAGES, fetchPage = politeFetch } = {}) {
  const out = { pages: 0, total: null, got: 0, failed: null, stop: null, stopKind: null, capped: false, dup: false };
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const offset = page * PARKNET_PAGE_SIZE;
    const url = cityListUrl(prefCd, city, offset);
    let res;
    try { res = await fetchPage(url); } catch (e) { out.failed = { offset, why: fetchErrorText(e) }; break; }
    if (res.blocked || res.transient) { out.stop = failText(res); out.stopKind = res.blocked ? "blocked" : "unreachable"; break; }
    if (!res.ok || res.skippedReason) { out.failed = { offset, why: failText(res) }; break; }
    out.pages++;
    const records = parseParknetList(res.html);
    if (page === 0) out.total = parseParknetTotal(res.html);
    const fresh = records.filter((r) => !seen.has(r.parkId));
    if (page > 0 && records.length && !fresh.length) { out.dup = true; break; }
    for (const r of fresh) seen.add(r.parkId);
    if (fresh.length) onPage?.(fresh, url);
    out.got += fresh.length;
    const next = offset + PARKNET_PAGE_SIZE;
    const hasNext = out.total != null ? next < out.total : parsePagerOffsets(res.html).some((o) => o >= next);
    if (!records.length || !hasNext) break;
    if (page + 1 >= maxPages) out.capped = true;   // まだ次があるのに上限に当たった
  }
  return out;
}
