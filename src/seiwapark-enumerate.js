// セイワパーク: 一覧 /search/(page/N) を巡回して全物件スラッグを列挙 ----------
// 1ページ20件・全5ページ前後（約100件）。ページ数はページャの最大値から判定する。
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const LIST_URL = (page) =>
  page > 1 ? `https://www.seiwapark.co.jp/search/page/${page}` : "https://www.seiwapark.co.jp/search/";

const MAX_PAGES = 30; // 暴走よけの上限

export async function getAllSeiwaparkIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const ids = new Set();
  let last = 1;
  for (let page = 1; page <= Math.min(last, MAX_PAGES); page++) {
    const res = await politeFetch(LIST_URL(page));
    if (!res.ok) break;
    const found = [...res.html.matchAll(/href="https:\/\/www\.seiwapark\.co\.jp\/search\/([^"\/]+)"/g)].map((m) => m[1]);
    const before = ids.size;
    found.forEach((x) => ids.add(x));
    // ページャ（1..N）から総ページ数を確定
    const pages = [...res.html.matchAll(/\/search\/page\/(\d+)/g)].map((m) => Number(m[1]));
    if (pages.length) last = Math.max(last, ...pages);
    if (!found.length || ids.size === before) break; // 新規なし＝末尾
  }
  const list = [...ids].sort();
  if (!list.length) throw new Error("セイワパーク一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  return list;
}
