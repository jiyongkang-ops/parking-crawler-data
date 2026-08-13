// スペース二十四: 一覧（10件/頁 × 約150頁）から詳細IDを列挙 -------------------
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const LIST_URL = (page) => `https://space24.co.jp/parkings?page=${page}`;

export async function getAllSpace24Ids({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const ids = new Set();
  let lastPage = 200;
  for (let page = 1; page <= lastPage; page++) {
    const res = await politeFetch(LIST_URL(page));
    if (!res.ok || res.skippedReason) break;
    if (page === 1) {
      // ページャの最大値（?page=150）から総ページ数を得る
      const pages = [...res.html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1]));
      if (pages.length) lastPage = Math.min(300, Math.max(...pages));
    }
    const found = [...res.html.matchAll(/\/parkings\/detail\/(\d+)/g)].map((m) => m[1]);
    if (!found.length) break;
    const before = ids.size;
    found.forEach((x) => ids.add(x));
    if (ids.size === before) break; // 同じ内容が返り始めたら終了
  }
  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  if (!list.length) throw new Error("スペース24一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  return list;
}
