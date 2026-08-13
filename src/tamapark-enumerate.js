// タマパーク: 一覧ページ（1枚に全物件）から日本語スラッグを列挙 ----------------
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const LIST_URL = "https://www.tamapark.co.jp/parking/";

export async function getAllTamaparkIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const res = await politeFetch(LIST_URL);
  if (!res.ok) throw new Error(`タマパーク一覧取得失敗: HTTP ${res.status}`);
  const ids = [...new Set([...res.html.matchAll(/href="https:\/\/www\.tamapark\.co\.jp\/parking\/([^"\/]+)\/"/g)]
    .map((m) => decodeURIComponent(m[1])))].filter((s) => s && s !== "parking").sort();
  if (!ids.length) throw new Error("タマパーク一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, ids.join("\n") + "\n");
  return ids;
}
