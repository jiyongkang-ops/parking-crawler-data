// あなぶきパーク 全物件の列挙 ----------------------------------------------
// 2系統を突き合わせる:
//   1) sitemap.xml（1リクエスト・約517件）… 速いが更新が遅く取りこぼしがある
//   2) /park/hourly/page/N/ の一覧ページ（1ページ12件・約60ページ）… 正
// 一覧のページ送りを辿って全ID を集め、sitemap 由来のIDと和集合を取る。
// 週1回のキャッシュ更新を想定（既定 7日）。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const LIST = "https://www.anabuki-housing.co.jp/park/hourly/";
const SITEMAP = "https://www.anabuki-housing.co.jp/sitemap.xml";
const ID_RE = /\/park\/hourly\/entry-(\d+)\.html/g;
const MAX_PAGES = 200; // 暴走防止の上限

export async function getAllAnabukiIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile) {
    const abs = path.resolve(cacheFile);
    if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
      return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
    }
  }

  const ids = new Set();

  // 1) sitemap（失敗しても一覧巡回で補える）
  try {
    const sm = await politeFetch(SITEMAP);
    if (sm.ok && !sm.skippedReason) {
      for (const m of sm.html.matchAll(ID_RE)) ids.add(m[1]);
    }
  } catch (e) {
    console.warn(`[anabuki] sitemap 取得失敗: ${e.message}`);
  }

  // 2) 一覧ページ送り。1ページ目のページャから総ページ数を得て 2..N を巡回。
  const first = await politeFetch(LIST);
  if (first.skippedReason) throw new Error(`anabuki 一覧: ${first.skippedReason}`);
  if (!first.ok) throw new Error(`anabuki 一覧 HTTP ${first.status}`);
  for (const m of first.html.matchAll(ID_RE)) ids.add(m[1]);

  const pageNums = [...first.html.matchAll(/\/park\/hourly\/page\/(\d+)\//g)].map((m) => Number(m[1]));
  const lastPage = Math.min(pageNums.length ? Math.max(...pageNums) : 1, MAX_PAGES);

  for (let p = 2; p <= lastPage; p++) {
    let res;
    try {
      res = await politeFetch(`${LIST}page/${p}/`);
    } catch (e) {
      console.warn(`[anabuki] page ${p} 取得失敗: ${e.message}`);
      continue;
    }
    if (!res.ok || res.skippedReason) continue;
    for (const m of res.html.matchAll(ID_RE)) ids.add(m[1]);
  }

  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  if (!list.length) throw new Error("anabuki: 列挙結果が0件（ページ構造変更の可能性）");
  if (cacheFile) {
    const abs = path.resolve(cacheFile);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, list.join("\n") + "\n");
  }
  return list;
}
