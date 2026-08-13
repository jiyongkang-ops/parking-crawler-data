// 東急ライフィア 全物件の列挙 ----------------------------------------------
// /parking/coin/ のトップは新着31件しか出ないため、検索結果を使う。
//   https://www.tokyulifia.co.jp/parking/search/coin/?page=N （1始まり・10件/頁）
// 1ページ目に「<em class="color_red">109</em>件中」と総件数が出るのでページ数を算出し、
// 以降を順に巡回する。?page= を付けないとテンプレートだけの空HTMLが返る点に注意。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";
import { parseTokyuLifiaSearch, searchUrl } from "./tokyulifia.js";

const PER_PAGE = 10;
const MAX_PAGES = 60;

export async function getAllTokyuLifiaIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile) {
    const abs = path.resolve(cacheFile);
    if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
      return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
    }
  }

  const first = await politeFetch(searchUrl(1));
  if (first.skippedReason) throw new Error(`tokyulifia 検索: ${first.skippedReason}`);
  if (!first.ok) throw new Error(`tokyulifia 検索 HTTP ${first.status}`);

  const ids = new Set();
  const { ids: firstIds, total } = parseTokyuLifiaSearch(first.html);
  for (const id of firstIds) ids.add(id);

  const pages = Math.min(total ? Math.ceil(total / PER_PAGE) : 1, MAX_PAGES);
  for (let p = 2; p <= pages; p++) {
    let res;
    try {
      res = await politeFetch(searchUrl(p));
    } catch (e) {
      console.warn(`[tokyulifia] page ${p} 取得失敗: ${e.message}`);
      continue;
    }
    if (!res.ok || res.skippedReason) continue;
    const before = ids.size;
    for (const id of parseTokyuLifiaSearch(res.html).ids) ids.add(id);
    if (ids.size === before) break; // 同じ結果が返り続けたら終端
  }

  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  if (!list.length) throw new Error("tokyulifia: 列挙結果が0件（ページ構造変更の可能性）");
  if (cacheFile) {
    const abs = path.resolve(cacheFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, list.join("\n") + "\n");
  }
  return list;
}
