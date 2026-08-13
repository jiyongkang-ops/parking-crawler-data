// JQパークス: トップの駅リンク（約222駅）を巡回して物件コードを列挙 -----------
// 県/市区ページには物件が無く、駅ページ（/station/{駅名}）にのみ /number/{code} が載る。
// 駅ページ巡回は7日キャッシュ前提（初回のみ約222リクエスト）。
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const TOP = "https://www.parking-kyushu.jp/";

export async function getAllJqparksIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const top = await politeFetch(TOP);
  if (!top.ok) throw new Error(`JQパークス トップ取得失敗: HTTP ${top.status}`);
  const stations = [...new Set([...top.html.matchAll(/href="(\/station\/[^"]+)"/g)].map((m) => m[1]))];
  if (!stations.length) throw new Error("駅リンクが0件（ページ構造変更の可能性）");
  const ids = new Set();
  for (const path of stations) {
    const url = "https://www.parking-kyushu.jp" + path.split("/").map((p, i) => (i > 1 ? encodeURIComponent(decodeURIComponent(p)) : p)).join("/");
    let res;
    try { res = await politeFetch(url); } catch { continue; }
    if (!res.ok || res.skippedReason) continue;
    for (const m of res.html.matchAll(/\/number\/(\d{6,})/g)) ids.add(m[1]);
  }
  const list = [...ids].sort();
  if (!list.length) throw new Error("JQパークス物件コードが0件");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  return list;
}
