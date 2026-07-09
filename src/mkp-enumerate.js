// 名鉄協商 全物件の列挙 ----------------------------------------------------
// 個別物件は sitemap_coin_detail.xml に掲載（/search/detail/{id}）。
// 抽出した ID 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP = "https://mkp.jp/sitemap_coin_detail.xml";
const ID_RE = /\/search\/detail\/([0-9-]+)/g;

export async function getAllMkpIds({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
    return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
  }
  const res = await politeFetch(SITEMAP);
  if (res.skippedReason) throw new Error(`mkp sitemap: ${res.skippedReason}`);
  if (!res.ok) throw new Error(`mkp sitemap HTTP ${res.status}`);
  const ids = new Set();
  let m;
  while ((m = ID_RE.exec(res.html))) ids.add(m[1]);
  const list = [...ids];
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  return list;
}
