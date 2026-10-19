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
 * 総件数が読めたのに、取れた物件がそれより少ないまま一覧が尽きた（途中のページが0件で返った・最後のページが短かった）ときは
 *   short を立てる。offset が効かなくなって空のページが返る形だと、dup では気づけないため（2026-10-19 の点検の指摘）。
 *   取れなかった・上限に当たった・dup・stop のときは、そちらで知らせるので short にはしない。
 *   onFetch(res, url) … 取りに行ったページごとの答え（例外のときは res が null）。HTTP の状態を数えたい呼ぶ側のため
 * 戻り値: { pages: 送ったページ数, total, got: 渡した物件数, failed: { offset, why, res } | null, stop, stopKind, stopRes, capped, dup, short }
 *   failed.res・stopRes は politeFetch の答えそのもの（例外のときは null）。失敗の種類を呼ぶ側で決められるように渡す
 */
export async function crawlParknetCity(prefCd, city, { onPage, onFetch, maxPages = PARKNET_MAX_PAGES, fetchPage = politeFetch } = {}) {
  const out = { pages: 0, total: null, got: 0, failed: null, stop: null, stopKind: null, stopRes: null, capped: false, dup: false, short: false };
  const seen = new Set();
  for (let page = 0; page < maxPages; page++) {
    const offset = page * PARKNET_PAGE_SIZE;
    const url = cityListUrl(prefCd, city, offset);
    let res;
    try { res = await fetchPage(url); } catch (e) { onFetch?.(null, url); out.failed = { offset, why: fetchErrorText(e), res: null }; break; }
    onFetch?.(res, url);
    if (res.blocked || res.transient) { out.stop = failText(res); out.stopKind = res.blocked ? "blocked" : "unreachable"; out.stopRes = res; break; }
    if (!res.ok || res.skippedReason) { out.failed = { offset, why: failText(res), res }; break; }
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
  if (out.total != null && out.got < out.total && !out.failed && !out.capped && !out.dup && !out.stop) out.short = true;
  return out;
}

/**
 * 市区の一覧（"pref_cd\tcity" の行）を順に crawlParknetCity で最後のページまで取り、まとめを返す（run.js のパークネットの処理の中身）。
 *   onRecord(rec) … 物件ごと（_requestUrl はその物件が載っていたページの URL。1ページ目は以前と同じ URL）
 *   onFetch(res, url) … 取りに行ったページごとの答え（例外のときは res が null）。そのまま crawlParknetCity に渡す（状態コードを数える呼ぶ側のため）
 * 途中のページが取れなかった市区は、そこまでの分を渡してから次の市区へ進む（何も消さない）。
 * robots.txt で断られた・届かないときは、残りの市区も同じ答えなので、そこで打ち切る（stop）。
 * 戻り値: { count, pages, stop, stopKind, stopRes, failedCities, partialCities, cappedCities, dupCities, shortCities,
 *           failures: [{ city, res }]（取れなかったページの答え。例外は null。失敗の種類を呼ぶ側で決めるため） }
 */
export async function crawlParknetCities(lines, { onRecord, onFetch, crawlCity = crawlParknetCity, log = console } = {}) {
  const sum = { count: 0, pages: 0, stop: null, stopKind: null, stopRes: null,
    failedCities: [], partialCities: [], cappedCities: [], dupCities: [], shortCities: [], failures: [] };
  for (const line of lines) {
    const [prefCd, city] = String(line).split("\t");
    if (!prefCd || !city) continue;
    const r = await crawlCity(prefCd, city, {
      onFetch,
      onPage: (recs, url) => { for (const rec of recs) { rec._requestUrl = url; onRecord?.(rec); sum.count++; } },
    });
    sum.pages += r.pages;
    if (r.stop) { sum.stop = r.stop; sum.stopKind = r.stopKind; sum.stopRes = r.stopRes; log.warn(`  [abort] パークネット: ${r.stop}`); break; }
    if (r.failed) {
      (r.pages ? sum.partialCities : sum.failedCities).push(city);
      sum.failures.push({ city, res: r.failed.res ?? null });
      log.error(`  [error] ${city} ${r.failed.offset + 1}件目から: ${r.failed.why}${r.pages ? `（${r.got}件は記録した）` : ""}`);
    }
    if (r.capped) { sum.cappedCities.push(city); log.warn(`  [warn] ${city}: ${r.total}件のうち、上限の${r.pages}ページ（${r.got}件）で止めた`); }
    if (r.dup) { sum.dupCities.push(city); log.warn(`  [warn] ${city}: ${r.pages}ページ目が前のページと同じ物件だけだったので止めた（ページ送りの作りの変更の可能性）`); }
    if (r.short) { sum.shortCities.push(city); log.warn(`  [warn] ${city}: 総件数${r.total}件のうち${r.got}件しか載っていなかった（${r.pages}ページで一覧が尽きた。ページ送りの作りの変更の可能性）`); }
    if (r.pages > 1) log.log(`  ${city}: ${r.got}件（${r.pages}ページ${r.total != null ? `・総件数 ${r.total}` : ""}）`);
  }
  return sum;
}

/** crawlParknetCities のまとめ → health の { ok, n, reason, extra }。
 *  ok の決め方は以前と同じ（1件以上取れて、打ち切りが無ければ成功）。途中のページが取れなかった市区などは補足（extra と reason）に残す。
 *  Advisor は ok:false のときしか reason を使わないので、ok のときの補足で通知は変わらない */
export function parknetHealth(sum) {
  const notes = [
    sum.failedCities.length && `取れなかった市区${sum.failedCities.length}`,
    sum.partialCities.length && `途中のページから取れなかった市区${sum.partialCities.length}`,
    sum.cappedCities.length && `上限のページ数で止めた市区${sum.cappedCities.length}`,
    sum.dupCities.length && `ページ送りが効かなかった市区${sum.dupCities.length}`,
    sum.shortCities.length && `総件数より少なかった市区${sum.shortCities.length}`,
  ].filter(Boolean).join("・") || null;
  const extra = { pages: sum.pages };
  if (sum.stopKind) extra.kind = sum.stopKind;
  for (const k of ["failedCities", "partialCities", "cappedCities", "dupCities", "shortCities"]) if (sum[k].length) extra[k] = sum[k];
  return { ok: sum.count > 0 && !sum.stop, n: sum.count, reason: sum.stop ?? (sum.count ? notes : "0件"), extra };
}
