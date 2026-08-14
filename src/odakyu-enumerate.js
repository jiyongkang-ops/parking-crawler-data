// 小田急パーキング: 時間貸し一覧からスラッグを列挙（1リクエスト）------------
// /parking/hourly_parking/ に東京・神奈川の全物件が1ページで載る（ページャ無し）。
// スラッグは URL エンコードのまま保持する（detailUrl がそのまま使える）。
// 【注意】GitHub Actions のIPからは一覧が HTTP 403 を返す（ローカルからは取得可）。
//   失敗しても run.js が continue するため他社の収集には影響しない。
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const LIST_URL = "https://service.odakyu-life.jp/parking/hourly_parking/";

export async function getAllOdakyuIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const res = await politeFetch(LIST_URL);
  if (!res.ok) throw new Error(`小田急パーキング一覧取得失敗: HTTP ${res.status ?? res.skippedReason}`);
  const ids = [...new Set(
    [...res.html.matchAll(/\/parking\/hourly_parking\/([^"\/\s]+)\/"/g)].map((m) => m[1])
  )].filter((s) => s !== "hourly_parking").sort();
  if (!ids.length) throw new Error("小田急パーキング一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, ids.join("\n") + "\n");
  return ids;
}
