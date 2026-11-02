// ユアー・パーキング: 全物件の列挙（2026-11-02） --------------------------------------------
// 公式の地図（https://www.waxds.com/ypark/map.php）の JS（map.js）は、地図が止まるたびに表示している範囲で
//   mapc.php?crud=getallpoint&areaid=undefined&neLat=..&neLng=..&swLat=..&swLng=..
// を読む（GET・JSON の配列 [{ id, pn, a1: 名前, a3: 都道府県, a4: 住所, a7: 台数, lat, lng, … }]）。
// 画面を日本全体まで縮めたときと同じ範囲で1回読めば全件がそろう（2026-11-01 で632件。同社の表示は「約620現場」）。
// NPC の location.json を全国の範囲で1回読むのと同じ考え方。
// 地図の JS にある crud=updatecenter（地図の位置を書き換える管理用）・readAll・showparkinfo などは呼ばない。読むのはこの1つだけ。
// 外す物件（記録しない）:
//   ・a7（台数の欄）が「近日OPEN予定」「長期貸切（…まで）」… まだ開いていない・時間貸しでない（2026-11-01 で3件）
//   ・名前に「駐輪」「バイク」「自転車」がある（2026-11-01 では0件）
import fs from "node:fs";
import path from "node:path";
import { cacheFresh, markFetched, keepPrevIfShrunk } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";
import { NOT_OPEN_RE, TWO_WHEEL_RE } from "./ypark.js";

// 日本全体（北東 46,146・南西 24,122）。地図の画面と同じ引数の並び
export const LIST_URL = "https://www.waxds.com/ypark/mapc.php?crud=getallpoint&areaid=undefined&neLat=46&neLng=146&swLat=24&swLng=122";

/** getallpoint の JSON → { ids, excluded: [{ id, name, why }] } */
export function parseYparkList(text) {
  let arr;
  try { arr = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const ids = [], excluded = [], seen = new Set();
  for (const x of arr) {
    const id = String(x?.id ?? "");
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const a7 = String(x.a7 ?? ""), name = String(x.a1 ?? "");
    if (NOT_OPEN_RE.test(a7)) { excluded.push({ id, name, why: a7.replace(/\s+/g, " ").trim() }); continue; }
    if (TWO_WHEEL_RE.test(name)) { excluded.push({ id, name, why: "駐輪場・バイク" }); continue; }
    ids.push(id);
  }
  return { ids: ids.sort((a, b) => Number(a) - Number(b)), excluded };
}

export async function getAllYparkIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    if (cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const res = await politeFetch(LIST_URL);
  throwIfRobotsSkipped(res, "ユアー・パーキング一覧");
  if (!res.ok) throw new Error(`ユアー・パーキング一覧取得失敗: ${failText(res)}`);
  const parsed = parseYparkList(res.html);
  if (!parsed) throw new Error("ユアー・パーキング一覧が JSON の配列ではない（作りが変わった見込み）");
  const { ids, excluded } = parsed;
  if (!ids.length) throw new Error("ユアー・パーキング一覧の解析結果が0件（ページ構造変更の可能性）");
  if (excluded.length) console.log(`[ユアー・パーキング] 一覧${ids.length + excluded.length}件のうち${excluded.length}件を外す: ` +
    excluded.map((x) => `${x.name}（${x.why.slice(0, 30)}）`).join("・"));
  // 範囲の読み方が変わるなどで急に半分未満になったら、前の一覧で回して次の回に作り直す（cache-age.js の keepPrevIfShrunk）
  const prev = cacheFile && fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean) : [];
  const old = prev.length ? keepPrevIfShrunk("ユアー・パーキング", ids, prev) : null;
  if (old) return old;
  if (cacheFile) {
    fs.mkdirSync(path.dirname(path.resolve(cacheFile)), { recursive: true });
    fs.writeFileSync(cacheFile, ids.join("\n") + "\n");
    markFetched(cacheFile);
  }
  return ids;
}
