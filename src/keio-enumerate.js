// 京王コインパーク: 全件一覧 /rent/coinpark/all/ からスラッグを列挙（1リクエスト）
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const LIST_URL = "https://www.keiofudosan.co.jp/rent/coinpark/all/";

export async function getAllKeioIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const res = await politeFetch(LIST_URL);
  if (!res.ok) throw new Error(`京王コインパーク一覧取得失敗: HTTP ${res.status ?? res.skippedReason}`);
  const ids = [...new Set(
    [...res.html.matchAll(/href="(?:https:\/\/www\.keiofudosan\.co\.jp)?\/rent\/coinpark\/detail\/([^"\/]+)\/?"/g)].map((m) => m[1])
  )].sort();
  if (!ids.length) throw new Error("京王コインパーク一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, ids.join("\n") + "\n");
  return ids;
}
