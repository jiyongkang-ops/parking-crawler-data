// パークジャパン（株式会社パークジャパン / parkjapan.com）---------------------------------------------------------------
// 2026-11-27 本人「作れるものは全部作って」（11/02 に「取らない」と決めた社。調べ直して、サイトの規約のページが無く、
// robots.txt の禁止は /test など数か所だけと分かったうえで）。
// 一覧 … https://www.parkjapan.com/search/timeresult.php の1ページに全国の時間貸し（約825件）。地図の JS に
//         { latitude, longitude, title, content: '名前<br />住所<br /><a href="#p{番号}">' } が並ぶので、位置はここから読む。
// 詳細 … https://www.parkjapan.com/search/parkinginfo1_{番号}.html（一覧の <a href="parkinginfo_{番号}.html"> は 404 を返す。
//         2026-11-27 に東京から確かめた）。<h2>名前</h2> と表（所在地・最寄駅・車時間貸料金・車台数）。位置は無い。
//         料金の欄は「月-金」「土日祝」の行が区分の見出しで、「8:00～22:00 200円/30分」「22:00～8:00最大料金400円」の並び。
import fs from "node:fs";
import { strip } from "./jp-fee-text.js";
import { feeFromLines, linesOf, cellOf, capOf, hoursOf } from "./fee-rows.js";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

export const LIST_URL = "https://www.parkjapan.com/search/timeresult.php";
export const detailUrl = (id) => `https://www.parkjapan.com/search/parkinginfo1_${id}.html`;

/** 一覧のページ → [{ id, name, address, lat, lng }]（地図の JS から。番号の重なりは最初のもの） */
export function parseParkjapanList(html) {
  const out = new Map();
  const re = /latitude:\s*(-?[\d.]+),\s*longitude:\s*(-?[\d.]+),\s*title:\s*'([^']*)',\s*content:\s*'([^']*)'/g;
  for (const m of String(html ?? "").matchAll(re)) {
    const id = (m[4].match(/#p(\d+)/) || [])[1];
    if (!id || out.has(id)) continue;
    const parts = m[4].split(/<br\s*\/?>/i).map((x) => strip(x));
    const lat = Number(m[1]), lng = Number(m[2]);
    const ok = lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154;
    out.set(id, { id, name: strip(m[3]) || null, address: parts[1] || null, lat: ok ? lat : null, lng: ok ? lng : null });
  }
  // 地図に載らない物件（位置の無いもの）も一覧の本文にはある
  for (const m of String(html ?? "").matchAll(/parkinginfo1?_(\d+)\.html">([^<]*)</g))
    if (!out.has(m[1])) out.set(m[1], { id: m[1], name: strip(m[2]) || null, address: null, lat: null, lng: null });
  return [...out.values()];
}

/** 位置の控えのファイル（番号の一覧のファイルの隣。「番号\t緯度\t経度」の行） */
export const lotsFileOf = (cacheFile) => String(cacheFile).replace(/-ids\.txt$/, "") + "-lots.tsv";

/** 一覧（番号）。listMeta に番号 → { lat, lng } を付ける（run.js が詳細のパーサに渡す。詳細のページには位置が無い）。
 *  番号の一覧（1行1件）と位置の控え（lotsFileOf）を7日ごとに作り直す */
export async function getAllParkjapanIds({ cacheFile, cacheMs = 7 * 864e5, fetcher = (u) => politeFetch(u) } = {}) {
  const withMeta = (ids, rows) => { ids.listMeta = new Map(rows.map((r) => [r.id, { lat: r.lat, lng: r.lng }])); return ids; };
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) {
    const ids = fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
    let rows = [];
    try { rows = readParkjapanLots(fs.readFileSync(lotsFileOf(cacheFile), "utf8")); } catch { /* 控えが無い（位置は空のまま） */ }
    return withMeta(ids, rows);
  }
  const res = await fetcher(LIST_URL);
  throwIfRobotsSkipped(res, "パークジャパン一覧");
  if (!res.ok) throw new Error(`パークジャパン一覧: ${failText(res)}`);
  const rows = parseParkjapanList(res.html);
  if (!rows.length) throw new Error("パークジャパン一覧が0件（ページ構造変更の可能性）");
  const ids = rows.map((r) => r.id);
  if (cacheFile) {
    fs.writeFileSync(lotsFileOf(cacheFile), rows.map((r) => [r.id, r.lat ?? "", r.lng ?? ""].join("\t")).join("\n") + "\n");
    fs.writeFileSync(cacheFile, ids.join("\n") + "\n"); markFetched(cacheFile);
  }
  return withMeta(ids, rows);
}

/** 位置の控えの中身 → [{ id, lat, lng }] */
export function readParkjapanLots(text) {
  return String(text ?? "").split("\n").filter(Boolean).map((line) => {
    const [id, la, ln] = line.split("\t");
    return { id, lat: la ? Number(la) : null, lng: ln ? Number(ln) : null };
  });
}

export function parseParkjapanDetail(html, { id, label, listMeta } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const art = (page.match(/<div class="art2">([\s\S]*?)<\/table>/) || [])[1] ?? "";
  const name = strip((art.match(/<h2>([\s\S]*?)<\/h2>/) || [])[1] ?? "") || null;
  const address = strip(cellOf(art, /所在地/) ?? "") || null;
  const feeCell = cellOf(art, /車?時間貸料金/);
  const fees = feeCell ? feeFromLines(linesOf(feeCell)) : { unitCharges: [], maxFees: [] };
  const rec = {
    operator: "parkjapan",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat: listMeta?.lat ?? null,
    lng: listMeta?.lng ?? null,
    capacity: capOf(cellOf(art, /車台数/)),
    openingHours: hoursOf(cellOf(art, /営業時間/)),
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: detailUrl(id),
  };
  // 車の料金の欄が無い（バイクだけの区画）
  if (name && !feeCell && cellOf(art, /バイク/)) return { ...rec, skip: "車の区画が無い（バイクだけ）" };
  return rec;
}
