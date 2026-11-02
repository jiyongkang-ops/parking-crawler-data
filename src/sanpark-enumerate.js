// SANパーク: 都県の市区の選択肢 → 市区ごとの一覧（車1台以上）から物件の番号を列挙する（2026-11-02 追加） ----------------
// 1回の作り直しは 都県4 ＋ 市区 約128 ＝ 約132リクエスト（4秒おきで約9分）。7日ごとに作り直す。
// 一覧の名前が「マンスリー〜」（月極だけ）・駐輪場・近日オープンの物件は、ここで外す（物件ページを取りに行かない）。
// 一部の市区の一覧が取れなかったときは、その市区だけ前の一覧の番号を残す（番号は「市区/番号」なので市区で分けられる）。
// 外したままにすると、その市区の物件が7日間回らず、studio-index.mjs の「一覧に無い物件」の扱いにもなるため。
import fs from "node:fs";
import path from "node:path";
import { cacheFresh, markFetched, keepPrevIfShrunk } from "./cache-age.js";
import { politeFetch, failText, fetchErrorText, throwIfRobotsSkipped } from "./polite-fetch.js";
import { SANPARK_AREAS, cityOptionsUrl, cityListUrl, parseCityOptions, parseSanparkList, skipReasonOfName } from "./sanpark.js";

const readList = (abs) => { try { return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean); } catch { return []; } };

export async function getAllSanparkIds({ cacheFile, cacheMs = 7 * 864e5, fetchPage = politeFetch, log = console } = {}) {
  const abs = cacheFile ? path.resolve(cacheFile) : null;
  if (abs && fs.existsSync(abs) && cacheFresh(abs, cacheMs)) return readList(abs);
  const prev = abs ? readList(abs) : [];

  // ① 市区の選択肢
  const cities = new Set();
  const badAreas = [];
  for (const area of SANPARK_AREAS) {
    let res;
    try { res = await fetchPage(cityOptionsUrl(area)); } catch (e) { badAreas.push(`${area}（${fetchErrorText(e)}）`); continue; }
    throwIfRobotsSkipped(res, "SANパーク 市区の選択肢");
    if (!res.ok || res.skippedReason) { badAreas.push(`${area}（${failText(res)}）`); continue; }
    const got = parseCityOptions(res.html);
    if (!got.length) { badAreas.push(`${area}（市区が0件）`); continue; }
    for (const c of got) cities.add(c);
  }
  if (!cities.size) throw new Error(`SANパーク 市区の選択肢が取れない: ${badAreas.join("・")}`);

  // ② 市区ごとの一覧
  const ids = new Set();
  const failed = [];
  const skipped = {};
  for (const city of cities) {
    let res;
    try { res = await fetchPage(cityListUrl(city)); } catch (e) { failed.push(city); log.error(`  [error] SANパーク ${city}: ${fetchErrorText(e)}`); continue; }
    throwIfRobotsSkipped(res, "SANパーク 一覧");
    if (!res.ok || res.skippedReason) { failed.push(city); log.error(`  [error] SANパーク ${city}: ${failText(res)}`); continue; }
    const { rows, total } = parseSanparkList(res.html);
    if (total != null && rows.length < total) log.warn(`  [warn] SANパーク ${city}: 該当件数${total}件のうち${rows.length}件しか読めない`);
    for (const r of rows) {
      const why = skipReasonOfName(r.name);
      if (why) { skipped[why] = (skipped[why] ?? 0) + 1; continue; }
      ids.add(r.id);
    }
  }
  // 取れなかった市区は前の一覧の番号を残す（都県の選択肢が取れなかったときは、その都県の市区が分からないので前の一覧ごと残す）
  let kept = 0;
  if (failed.length || badAreas.length) {
    const lost = new Set(failed);
    for (const id of prev) {
      const city = id.slice(0, id.lastIndexOf("/"));
      if (lost.has(city) || (badAreas.length && !cities.has(city))) { if (!ids.has(id)) { ids.add(id); kept++; } }
    }
  }
  const list = [...ids].sort();
  const old = keepPrevIfShrunk("SANパーク", list, prev);
  if (old) return old;
  if (failed.length || badAreas.length) {
    list.listNote = `一覧づくりで${[badAreas.length && `都県の選択肢${badAreas.length}件`, failed.length && `市区${failed.length}件`].filter(Boolean).join("・")}が取れなかった。その分は前の一覧の番号${kept}件を残した`;
    log.warn(`::warning::[SANパーク] ${list.listNote}`);
  }
  log.log(`[SANパーク] 一覧 ${list.length}件（市区${cities.size}・外した物件 ${Object.entries(skipped).map(([k, n]) => `${k}${n}`).join("・") || "なし"}）`);
  if (abs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, list.join("\n") + "\n");
    markFetched(abs);
  }
  return list;
}
