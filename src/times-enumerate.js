// タイムズ全物件の列挙 -----------------------------------------------------
// 物件一覧は sitemap（index → 子3ファイル）に直接掲載されている。
// 抽出した個別物件URL一覧をローカルにキャッシュ（12MB級の生XMLは保持しない）。
// 巡回状態の管理は repark-enumerate の汎用関数を共用する。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP_INDEX = "https://times-info.net/parkdetails_index.xml";
const DETAIL_RE = /https:\/\/times-info\.net\/P\d+-[a-z]+\/C\d+\/park-detail-BUK\d+\//g;

// 個別物件URL一覧を返す（キャッシュ優先）。
export async function getAllParkUrls({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
    return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
  }
  // index から子 sitemap を取得
  const idxRes = await politeFetch(SITEMAP_INDEX);
  if (idxRes.skippedReason) throw new Error(`sitemap index: ${idxRes.skippedReason}`);
  if (!idxRes.ok) throw new Error(`sitemap index HTTP ${idxRes.status}`);
  const childUrls = [...idxRes.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  const urls = new Set();
  for (const child of childUrls) {
    const res = await politeFetch(child);
    if (!res.ok || res.skippedReason) {
      console.warn(`[times] 子sitemap取得失敗: ${child}`);
      continue;
    }
    for (const m of res.html.matchAll(DETAIL_RE)) urls.add(m[0]);
  }

  const list = [...urls];
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  return list;
}
