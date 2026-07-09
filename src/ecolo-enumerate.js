// エコロパーク 全物件の列挙 ------------------------------------------------
// sitemap が無いため、時間貸しトップに列挙される全エリア（市区、約195件）を辿り、
// 各エリアページ（SSR）から物件ID（/coin-parking/{id}/）を収集する。
// 収集した ID 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const TOP = "https://service.ecolocity.co.jp/park/coin-parking/";
const AREA_RE = /coin-parking\/area\/([^"'\/]+)\//g;
const ID_RE = /coin-parking\/(\d+)\//g;

export async function getAllEcoloIds({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
    return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
  }

  const top = await politeFetch(TOP);
  if (top.skippedReason) throw new Error(`ecolo top: ${top.skippedReason}`);
  if (!top.ok) throw new Error(`ecolo top HTTP ${top.status}`);
  const areas = [...new Set([...top.html.matchAll(AREA_RE)].map((m) => m[1]))];

  const ids = new Set();
  for (const area of areas) {
    let res;
    try {
      res = await politeFetch(`${TOP}area/${area}/`);
    } catch { continue; }
    if (!res.ok || res.skippedReason) continue;
    for (const m of res.html.matchAll(ID_RE)) ids.add(m[1]);
  }

  const list = [...ids];
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  return list;
}
