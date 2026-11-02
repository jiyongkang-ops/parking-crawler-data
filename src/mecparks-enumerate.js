// 三菱地所パークス（Parking NAVI）: 都道府県の一覧 → 100件で頭打ちの所だけ市区 → さらに町丁、とたどって全件を取る（2026-11-02 追加）
// 一覧ページに料金まで載っているので、詳細ページは回らない（一覧型。GSパーク・パークネットと同じく毎回全件を取る）。
// 1巡は 都道府県47 ＋ 東京都の市区の一覧1 ＋ 東京都の市区 約50 ＝ 約100リクエスト（4秒おきで約7分）。
// 2026-11-01 時点で100件に達するのは東京都だけ（神奈川56・大阪53・愛知46）。市区で100件に達した所は無い。
import { politeFetch, failText, fetchErrorText } from "./polite-fetch.js";
import { listUrl, areaUrl, parseMecparksList, parseCityCodes, parseTownCodes, MECPARKS_LIST_CAP } from "./mecparks.js";

export const MECPARKS_PREFS = Array.from({ length: 47 }, (_, i) => i + 1);

/**
 * 全国の一覧を取り、物件ごとに onRecord(rec, at) を呼ぶ（at はそのページを取った時刻）。
 *   onFetch(res, url) … 取りに行ったページごとの答え（例外のときは res が null）。状態コードを数える呼ぶ側のため
 *   prefs … 取る都道府県（既定は全国。確かめのときに絞る）
 * 1ページが100件（MECPARKS_LIST_CAP）に達したら、その都道府県は市区ごと、市区も達したら町丁ごとに取り直す
 * （達したページの物件は記録しない。下の層で同じ物件が取れるため。番号 pid で重複も除く）。
 * 途中のページが取れなかったら、そのページだけ飛ばして次へ進む（何も消さない。一覧型には「一覧に無ければ閉鎖」の扱いが無い）。
 * robots.txt で断られた・届かない（本ページは送っていない）ときは、残りも同じ答えなので打ち切る（stop）。
 * 戻り値: { count, pages, rows（一覧に載っていた件数）, skipped（記録しなかった理由ごとの件数）, stop, stopKind, stopRes,
 *           failures: [{ where, why, res }], broken: [where]（customdata が読めなかったページ）, capped: [where]（町丁でも100件） }
 */
export async function crawlMecparks({ onRecord, onFetch, prefs = MECPARKS_PREFS, label = null, fetchPage = politeFetch, log = console } = {}) {
  const sum = { count: 0, pages: 0, rows: 0, skipped: {}, stop: null, stopKind: null, stopRes: null, failures: [], broken: [], capped: [] };
  const seen = new Set();

  /** 1ページを取る。取れたら HTML、取れなければ null（打ち切りなら sum.stop が入る） */
  const get = async (url, where) => {
    let res;
    try { res = await fetchPage(url); } catch (e) {
      onFetch?.(null, url); sum.failures.push({ where, why: fetchErrorText(e), res: null });
      log.error(`  [error] ${where}: ${fetchErrorText(e)}`); return null;
    }
    onFetch?.(res, url);
    if (res.blocked || res.transient) {
      sum.stop = failText(res); sum.stopKind = res.blocked ? "blocked" : "unreachable"; sum.stopRes = res;
      log.warn(`  [abort] 三菱地所パークス: ${sum.stop}`); return null;
    }
    if (!res.ok || res.skippedReason) {
      sum.failures.push({ where, why: failText(res), res }); log.error(`  [error] ${where}: ${failText(res)}`); return null;
    }
    sum.pages++;
    return res.html;
  };

  /** 一覧の1ページ。100件に達していれば true を返し（下の層へ）、物件は記録しない */
  const takeList = async (url, where) => {
    const html = await get(url, where);
    if (html == null) return false;
    const at = new Date().toISOString();
    const r = parseMecparksList(html, { label });
    if (r.broken) { sum.broken.push(where); log.error(`  [parse error] ${where}: 一覧のデータ（customdata）が読めない`); return false; }
    if (r.rows >= MECPARKS_LIST_CAP) return true;
    sum.rows += r.rows;
    for (const [k, n] of Object.entries(r.skipped)) sum.skipped[k] = (sum.skipped[k] ?? 0) + n;
    for (const rec of r.records) {
      if (seen.has(rec.parkId)) continue;
      seen.add(rec.parkId);
      rec._requestUrl = url;
      onRecord?.(rec, at);
      sum.count++;
    }
    return false;
  };

  for (const pref of prefs) {
    if (sum.stop) break;
    if (!(await takeList(listUrl(pref), `都道府県${pref}`))) continue;
    if (sum.stop) break;
    // 100件で頭打ち → 市区ごと
    const areaHtml = await get(areaUrl(pref), `都道府県${pref}の市区`);
    if (areaHtml == null) continue;
    const cities = parseCityCodes(areaHtml, pref);
    if (!cities.length) { sum.broken.push(`都道府県${pref}の市区`); log.error(`  [parse error] 都道府県${pref}: 市区が0件`); continue; }
    log.log(`  都道府県${pref}: 一覧が${MECPARKS_LIST_CAP}件で頭打ちなので、市区${cities.length}件に分けて取る`);
    for (const city of cities) {
      if (sum.stop) break;
      if (!(await takeList(listUrl(pref, { city }), `市区${city}`))) continue;
      if (sum.stop) break;
      // 市区でも頭打ち → 町丁ごと
      const townHtml = await get(areaUrl(pref, city), `市区${city}の町丁`);
      if (townHtml == null) continue;
      const towns = parseTownCodes(townHtml, pref, city);
      if (!towns.length) { sum.broken.push(`市区${city}の町丁`); continue; }
      log.log(`  市区${city}: 一覧が${MECPARKS_LIST_CAP}件で頭打ちなので、町丁${towns.length}件に分けて取る`);
      for (const town of towns) {
        if (sum.stop) break;
        if (await takeList(listUrl(pref, { city, town }), `町丁${town}`)) { sum.capped.push(`町丁${town}`); log.warn(`  [warn] 町丁${town}: ${MECPARKS_LIST_CAP}件で頭打ち（取りこぼしの可能性）`); }
      }
    }
  }
  return sum;
}

/** crawlMecparks のまとめ → health の { ok, n, reason, extra }（パークネットの parknetHealth と同じ決め方）。
 *  1件以上取れて打ち切りが無ければ成功。取れなかったページ・読めなかったページ・頭打ちは補足に残す */
export function mecparksHealth(sum) {
  const notes = [
    sum.failures.length && `取れなかったページ${sum.failures.length}`,
    sum.broken.length && `読めなかったページ${sum.broken.length}`,
    sum.capped.length && `町丁でも${MECPARKS_LIST_CAP}件で頭打ち${sum.capped.length}`,
  ].filter(Boolean).join("・") || null;
  const extra = { pages: sum.pages, rows: sum.rows, skipped: sum.skipped };
  if (sum.stopKind) extra.kind = sum.stopKind;
  if (sum.failures.length) extra.failed = sum.failures.map((f) => f.where);
  if (sum.broken.length) extra.broken = sum.broken;
  if (sum.capped.length) extra.capped = sum.capped;
  return { ok: sum.count > 0 && !sum.stop, n: sum.count, reason: sum.stop ?? (sum.count ? notes : "0件"), extra };
}
