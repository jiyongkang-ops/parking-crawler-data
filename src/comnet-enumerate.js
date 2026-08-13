// コムネット / コムパーク: 地図用JSONから全物件IDを列挙（1リクエスト）--------
// トップページに markerJson[N] = {... LINK:'https://comnet-p.co.jp/parking/000091/'}
// が全件（現状195件）埋まっている。取れなかった場合は parking-sitemap.xml で代替。
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const MAP_URL = "https://comnet-p.co.jp/";
const SITEMAP_URL = "https://comnet-p.co.jp/parking-sitemap.xml";

export async function getAllComnetIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const ids = new Set();

  const res = await politeFetch(MAP_URL);
  if (res.ok) {
    for (const m of res.html.matchAll(/LINK\s*:\s*'https?:\/\/comnet-p\.co\.jp\/parking\/(\d+)\/'/g)) ids.add(m[1]);
  }
  if (!ids.size) {
    const sm = await politeFetch(SITEMAP_URL);
    if (sm.ok) for (const m of sm.html.matchAll(/<loc>\s*https?:\/\/comnet-p\.co\.jp\/parking\/(\d+)\/\s*<\/loc>/g)) ids.add(m[1]);
  }

  const list = [...ids].sort();
  if (!list.length) throw new Error("コムパーク一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  return list;
}
