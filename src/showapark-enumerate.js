// ショウワパーク: 全物件の列挙（2026-11-02） ----------------------------------------------
// /parking/ に都道府県のリンク /parking_search/pref/{n}/（「東京都(141件)」。2026-11-01 で19都道府県・計737件）がある。
// 都道府県のページには市区のリンク /parking_search/city/{コード}/ が並び、市区のページ（どれでも）の地図用の JS 配列
//   parking_list = ["3,パーク保谷（…）,35.747531,139.567289,東京都,練馬区,南大泉3-31-23,西武池袋線　保谷駅,32", …]
// に、その都道府県の全物件（番号・名前・緯度・経度・都道府県・市区・住所・最寄駅・台数）が入っている
// （東京141件・神奈川333件・大阪163件・福岡3件で、都道府県の件数と同じだった。2026-11-01）。
// そこで 1（/parking/）＋ 都道府県ごとに2枚（県のページ・最初の市区のページ）＝約39リクエストで全件がそろう。
// 737件には駐輪場・月極も入っている（トップの表示は 586か所）。名前に「駐輪場」がある物件はここで外す
// （「ショウワパーク上大岡西2丁目バイク駐輪場」「パーク元住吉（自転車専用駐輪場）」など）。
// 「パーク保谷（自転車・バイク併設駐車場）」のように名前に駐輪場と書いていない物件は、詳細のページで見分ける（showapark.js）。
// 月極だけの物件は一覧では見分けられないので、詳細のページで基本料金が空なら記録しない（showapark.js）。
import fs from "node:fs";
import path from "node:path";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

const ORIGIN = "https://www.shouwapark.co.jp";
export const TOP_URL = `${ORIGIN}/parking/`;

/** /parking/ → [{ pref: "13", name: "東京都", count: 141 }] */
export function parsePrefLinks(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html).matchAll(/href="(?:https?:\/\/www\.shouwapark\.co\.jp)?\/parking_search\/pref\/(\d+)\/"[^>]*>\s*([^<(（]+?)\s*[(（]\s*(\d+)\s*件\s*[)）]/g)) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ pref: m[1], name: m[2].trim(), count: Number(m[3]) });
  }
  return out;
}

/** 都道府県のページ → 最初の市区のコード（無ければ null） */
export function firstCityCode(html) {
  const m = String(html).match(/\/parking_search\/city\/(\d+)\//);
  return m ? m[1] : null;
}

/** 市区（または物件）のページの parking_list → [{ id, name, lat, lng, pref, city, address, station, capacity }] */
export function parseParkingList(html) {
  const m = String(html).match(/parking_list\s*=\s*(\[[\s\S]*?\])\s*;/);
  if (!m) return null;
  let arr;
  try { arr = JSON.parse(m[1]); } catch { return null; }
  return arr.map((s) => {
    const f = String(s).split(",");
    // 名前に「,」が入ると列がずれる。前から番号・名前、後ろから台数・最寄駅・住所・市区・都道府県・経度・緯度の順に取る
    const n = f.length;
    return { id: f[0], name: f.slice(1, n - 7).join(","), lat: Number(f[n - 7]), lng: Number(f[n - 6]),
      pref: f[n - 5], city: f[n - 4], address: f[n - 3], station: f[n - 2], capacity: Number(f[n - 1]) || null };
  }).filter((x) => /^\d+$/.test(x.id));
}

/** 一覧から外す物件（駐輪場）。名前に「駐輪場」がある物件だけ。「併設駐車場」は残す */
export const isBicycleLot = (row) => /駐輪場/.test(row.name ?? "");

export async function getAllShowaparkIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    if (cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const top = await politeFetch(TOP_URL);
  throwIfRobotsSkipped(top, "ショウワパーク一覧");
  if (!top.ok) throw new Error(`ショウワパーク一覧取得失敗: ${failText(top)}`);
  const prefs = parsePrefLinks(top.html);
  if (!prefs.length) throw new Error("ショウワパーク一覧の都道府県が0件（ページ構造変更の可能性）");

  const ids = new Set();
  const failed = [], short = [];
  let listed = 0, bicycles = 0;
  for (const p of prefs) {
    const pr = await politeFetch(`${ORIGIN}/parking_search/pref/${p.pref}/`);
    throwIfRobotsSkipped(pr, "ショウワパーク一覧");
    const city = pr.ok ? firstCityCode(pr.html) : null;
    if (!city) { failed.push(`${p.name}（${pr.ok ? "市区のリンクが無い" : failText(pr)}）`); continue; }
    const cr = await politeFetch(`${ORIGIN}/parking_search/city/${city}/`);
    throwIfRobotsSkipped(cr, "ショウワパーク一覧");
    const rows = cr.ok ? parseParkingList(cr.html) : null;
    if (!rows) { failed.push(`${p.name}（${cr.ok ? "parking_list が読めない" : failText(cr)}）`); continue; }
    // 市区のページに県の全件が入っている前提。件数が合わなければ health に残す（作りが変わったときに気づけるように）
    if (rows.length !== p.count) short.push(`${p.name} ${rows.length}/${p.count}件`);
    listed += rows.length;
    for (const r of rows) {
      if (isBicycleLot(r)) { bicycles++; continue; }
      ids.add(r.id);
    }
  }
  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  console.log(`[ショウワパーク] 一覧 ${listed}件（都道府県の件数の合計 ${prefs.reduce((a, p) => a + p.count, 0)}件）のうち駐輪場${bicycles}件を外して ${list.length}件`);

  // 一部の県が取れなかった回。前の一覧があれば前の一覧で回し、取得日を進めずに次の回に作り直す
  // （欠けた一覧で上書きすると、その県の物件を7日間回らなくなる）
  const note = [failed.length ? `一覧の一部が取れず: ${failed.join("・")}` : null,
    short.length ? `県の件数と一覧が合わない: ${short.join("・")}` : null].filter(Boolean).join(" / ") || null;
  if (failed.length && cacheFile && fs.existsSync(cacheFile)) {
    const prev = fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
    if (prev.length) {
      console.warn(`::warning::[ショウワパーク] ${note}。前の一覧（${prev.length}件）を使い、次の回に作り直す`);
      prev.listNote = `${note}（前の一覧で回した）`;
      return prev;
    }
  }
  if (!list.length) throw new Error(`ショウワパーク一覧の解析結果が0件（ページ構造変更の可能性）${note ? `。${note}` : ""}`);
  if (cacheFile) {
    fs.mkdirSync(path.dirname(path.resolve(cacheFile)), { recursive: true });
    fs.writeFileSync(cacheFile, list.join("\n") + "\n");
    if (!failed.length) markFetched(cacheFile);
  }
  if (note) list.listNote = note;
  return list;
}
