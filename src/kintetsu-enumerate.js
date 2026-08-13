// 近鉄不動産 全物件の列挙 --------------------------------------------------
// detail.php?id= は連番ではなく歯抜け（33, 105, 154, …, 477）なのでID総当りはせず、
// 検索結果一覧 list.php を「次へ」が消えるまで辿る。
//   https://parking.kintetsu-re.co.jp/hourly/list.php?page=N （page は 0 始まり、20件/頁）
// URLに付く ustr= は検索セッションキーだが、無くても page 指定だけで通る。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";
import { listUrl, parseKintetsuList } from "./kintetsu.js";

const MAX_PAGES = 60; // 20件/頁 → 1,200件相当。暴走防止の上限

export async function getAllKintetsuIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile) {
    const abs = path.resolve(cacheFile);
    if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
      return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
    }
  }

  const ids = new Set();
  let page = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await politeFetch(listUrl(page));
    if (res.skippedReason) throw new Error(`kintetsu 一覧: ${res.skippedReason}`);
    if (!res.ok) break;
    const { ids: pageIds, nextPage } = parseKintetsuList(res.html);
    const before = ids.size;
    for (const id of pageIds) ids.add(id);
    // 「次へ」が無い、または新規IDが1件も増えなければ終端
    if (nextPage == null || nextPage <= page) break;
    if (ids.size === before && i > 0) break;
    page = nextPage;
  }

  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  if (!list.length) throw new Error("kintetsu: 列挙結果が0件（ページ構造変更の可能性）");
  if (cacheFile) {
    const abs = path.resolve(cacheFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, list.join("\n") + "\n");
  }
  return list;
}
