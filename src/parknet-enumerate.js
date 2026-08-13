// パークネット: 検索トップ → 都道府県ページ → 市区リンク（pref_cd\tcity）を列挙 --
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";
import { prefListUrl, parseCityLinks } from "./parknet.js";

const TOP = "https://parknet.shinmaywa.co.jp/parknet/search/";

export async function getAllParknetCities({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const top = await politeFetch(TOP);
  if (!top.ok) throw new Error(`パークネット トップ取得失敗: HTTP ${top.status}`);
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
  return list;
}
