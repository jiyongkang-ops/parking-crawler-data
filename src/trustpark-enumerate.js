// トラストパーク: トラストナビ（tpnavi.com）の sitemap.xml から物件ページ（P{番号}.html）の番号を列挙（1リクエスト）。
// 2026-11-27 本人「トラストパークも作って」。sitemap には物件ページ 約1,030件（ほかにスマホ版・月極・都道府県のページ）が載る。
// https で開くと http へ転送されるので、はじめから http で読む。robots.txt は Googlebot 向けの決まりだけで Disallow は空。
import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, failText } from "./polite-fetch.js";

export const SITEMAP_URL = "http://tpnavi.com/sitemap.xml";

/** sitemap.xml の本文 → 物件ページの番号（文字列・小さい順） */
export function parseTrustparkSitemap(xml) {
  const ids = new Set();
  for (const m of String(xml ?? "").matchAll(/<loc>\s*https?:\/\/tpnavi\.com\/P(\d+)\.html\s*<\/loc>/g)) ids.add(m[1]);
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

export async function getAllTrustparkIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs))
    return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const res = await politeFetch(SITEMAP_URL);
  if (!res.ok || res.skippedReason) throw new Error(`トラストパーク sitemap: ${failText(res)}`);
  const ids = parseTrustparkSitemap(res.html);
  if (!ids.length) throw new Error("トラストパーク sitemap の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, ids.join("\n") + "\n"); markFetched(cacheFile); }
  return ids;
}
