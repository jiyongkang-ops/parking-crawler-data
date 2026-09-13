// キョウテク: 一覧ページ（1ページ）から全物件スラッグを列挙 ------------------
import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch } from "./polite-fetch.js";

const LIST_URL = "https://kte.ne.jp/parking/";

export async function getAllKyotechIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    if (cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const res = await politeFetch(LIST_URL);
  if (!res.ok) throw new Error(`一覧取得失敗: HTTP ${res.status}`);
  const ids = [...new Set([...res.html.matchAll(/href="https:\/\/kte\.ne\.jp\/parking\/([^"\/]+)\//g)]
    .map((m) => decodeURIComponent(m[1])))].sort();
  if (!ids.length) throw new Error("一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, ids.join("\n") + "\n");
  if (cacheFile) markFetched(cacheFile);
  return ids;
}
