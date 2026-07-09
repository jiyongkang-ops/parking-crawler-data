// リパーク全物件の列挙とローリング巡回の状態管理 ---------------------------
// repark には一括APIが無く 1物件=1ページ取得しかないため、全国16,000件超を
// 一度に取得するのは「節度ある収集」と両立しない。
// そこで sitemap から全 parkId を列挙し、「最も長く取得していないものから順に
// 毎回 N 件だけ」取得するローリング方式で、数日かけて全国を1巡する。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP_URL = "https://www.repark.jp/sitemap_park.xml";

// sitemap をローカルにキャッシュし、parkId 一覧を返す。
export async function getAllParkIds({ cacheFile, cacheMs }) {
  let xml = null;
  const abs = path.resolve(cacheFile);
  if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
    xml = fs.readFileSync(abs, "utf8");
  } else {
    const res = await politeFetch(SITEMAP_URL);
    if (res.skippedReason) throw new Error(`sitemap: ${res.skippedReason}`);
    if (!res.ok) throw new Error(`sitemap HTTP ${res.status}`);
    xml = res.html;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, xml);
  }
  // www 版の detail URL から park= の値だけを重複なく拾う
  const ids = new Set();
  const re = /result\/detail\/\?park=(REP\d+)/g;
  let m;
  while ((m = re.exec(xml))) ids.add(m[1]);
  return [...ids];
}

// ローリング状態（parkId -> 最終取得ISO）を読み書き。
export function loadCrawlState(stateFile) {
  const abs = path.resolve(stateFile);
  if (!fs.existsSync(abs)) return {};
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8"));
  } catch {
    return {};
  }
}

export function saveCrawlState(stateFile, state) {
  const abs = path.resolve(stateFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(state, null, 0));
}

// 未取得 → 取得が古い順に N 件選ぶ。
export function pickRolling(allIds, state, n) {
  const ts = (id) => (state[id] ? new Date(state[id]).getTime() : 0);
  return [...allIds].sort((a, b) => ts(a) - ts(b)).slice(0, n);
}
