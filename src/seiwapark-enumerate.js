// セイワパーク: 一覧 /search/(page/N) を巡回して物件スラッグを列挙 ------------
// /search/ は月極とコインパーキングの両方を含むので、検索フォームの絞り込み
// （type[]=35 = コインパーキング。form は method=get でページャにも引き継がれる）
// を付けて巡る。0件だった場合のみ絞り込み無しで再試行する。
// 1ページ20件。ページャは現在地周辺しか出さないため、毎ページ最大値を取り直す。
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const QS = "post_type=search&type%5B0%5D=35"; // 35 = コインパーキング
const LIST_URL = (page, filtered) => {
  const base = page > 1 ? `https://www.seiwapark.co.jp/search/page/${page}` : "https://www.seiwapark.co.jp/search/";
  return filtered ? `${base}?${QS}` : base;
};

const MAX_PAGES = 40; // 暴走よけの上限

export async function getAllSeiwaparkIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const walk = async (filtered) => {
    const ids = new Set();
    let last = 1;
    for (let page = 1; page <= Math.min(last, MAX_PAGES); page++) {
      const res = await politeFetch(LIST_URL(page, filtered));
      if (!res.ok) break;
      const found = [...res.html.matchAll(/href="https:\/\/www\.seiwapark\.co\.jp\/search\/([^"\/?]+)"/g)].map((m) => m[1]);
      const before = ids.size;
      found.forEach((x) => ids.add(x));
      const pages = [...res.html.matchAll(/\/search\/page\/(\d+)/g)].map((m) => Number(m[1]));
      if (pages.length) last = Math.max(last, ...pages);
      if (!found.length || ids.size === before) break; // 新規なし＝末尾
    }
    return ids;
  };

  let ids = await walk(true);
  if (!ids.size) ids = await walk(false);
  const list = [...ids].sort();
  if (!list.length) throw new Error("セイワパーク一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  return list;
}
