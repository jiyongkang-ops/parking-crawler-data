// 名鉄協商 全物件の列挙 ----------------------------------------------------
// 個別物件は sitemap_coin_detail.xml に掲載（/search/detail/{id}）。
// 抽出した ID 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。
// sitemap が途中で切れた・作りが変わったなどで、前の一覧の半分未満（0件を含む）しか取れなければ前の一覧を使う
// （keepPrevIfShrunk。以前は0件でもそのまま書く作りで、そうなると7日間1件も回らず、health も成功のままになるところだった）。

import fs from "node:fs";
import { cacheFresh, markFetched, keepPrevIfShrunk } from "./cache-age.js";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP = "https://mkp.jp/sitemap_coin_detail.xml";
const ID_RE = /\/search\/detail\/([0-9-]+)/g;

export async function getAllMkpIds({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  const prev = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").split("\n").filter(Boolean) : [];
  if (prev.length && cacheFresh(abs, cacheMs)) return prev;
  const res = await politeFetch(SITEMAP);
  if (res.skippedReason) throw new Error(`mkp sitemap: ${res.skippedReason}`);
  if (!res.ok) throw new Error(`mkp sitemap HTTP ${res.status}`);
  const ids = new Set();
  let m;
  while ((m = ID_RE.exec(res.html))) ids.add(m[1]);
  const list = [...ids];
  const kept = keepPrevIfShrunk("名鉄協商", list, prev);
  if (kept) return kept;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  markFetched(abs);
  return list;
}
