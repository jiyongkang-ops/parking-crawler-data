// いずみパーキング（株式会社いずみパーキング / ssparking.co.jp。名古屋）-----------------------------------------------------
// 2026-11-27 本人「作れるものは全部作って」。robots.txt は管理画面だけの禁止・規約のページは無い（2026-11-27 確認）。
// 物件ページは https://ssparking.co.jp/detail/{物件名}/（sitemap wp-sitemap-posts-detail-1.xml に約360件）。巡回の番号は URL そのもの。
//   名前 … <p class="result_ttl">
//   位置 … <div class="marker" data-lat data-lng>
//   表   … エリア・住所（名古屋市…。都道府県は無い）・営業時間・管理形態（時間貸し／月極／来客用）・収容台数・料金等
//   料金 … 「【時間料金】」「【打切り・前払い設定など】」「【月極料金】」の3つの欄が1つのセルに並ぶ
// 時間貸しでない物件（月極・来客用・ビルの専用）は記録しない（{ skip }）。
import { han, strip } from "./jp-fee-text.js";
import { feeFromLines, linesOf, mergeFees, cellOf, capOf, hoursOf, latLngOf, sitemapLocs } from "./fee-rows.js";
import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

export const SITEMAP_URL = "https://ssparking.co.jp/wp-sitemap-posts-detail-1.xml";

export function parseIzumiSitemap(xml) {
  return [...new Set(sitemapLocs(xml).filter((u) => /ssparking\.co\.jp\/detail\/[^/]+\/?$/.test(u)))];
}

export async function getAllIzumiUrls({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const res = await politeFetch(SITEMAP_URL);
  throwIfRobotsSkipped(res, "いずみパーキング sitemap");
  if (!res.ok) throw new Error(`いずみパーキング sitemap: ${failText(res)}`);
  const urls = parseIzumiSitemap(res.html);
  if (!urls.length) throw new Error("いずみパーキング sitemap が0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, urls.join("\n") + "\n"); markFetched(cacheFile); }
  return urls;
}

/** URL → 物件名（parkId に使う） */
export function slugOf(url) {
  const m = String(url ?? "").match(/\/detail\/([^/?#]+)\/?/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** 「料金等」のセル → { unitCharges, maxFees }（月極の欄は読まない） */
export function parseIzumiFee(cellHtml) {
  const t = String(cellHtml ?? "");
  const part = (re) => { const m = t.match(re); return m ? m[1] : ""; };
  const unit = part(/【\s*時間料金\s*】([\s\S]*?)(?=【|$)/);
  const max = part(/【\s*打切り?[^】]*】([\s\S]*?)(?=【\s*月極|$)/);
  return mergeFees([feeFromLines(linesOf(unit)), feeFromLines(linesOf(max), { section: "max" })]);
}

export function parseIzumiDetail(html, { url, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const name = strip((page.match(/<p class="result_ttl">([\s\S]*?)<\/p>/) || [])[1] ?? "") || null;
  const table = (page.match(/<table class="table_1">([\s\S]*?)<\/table>/) || [])[1] ?? "";
  const kind = strip(cellOf(table, /管理形態/) ?? "");
  const fees = parseIzumiFee(cellOf(table, /料金等/));
  const g = latLngOf((page.match(/<div class="marker"[^>]*>/) || [])[0] ?? "");
  const rec = {
    operator: "izumipark",
    parkId: slugOf(url),
    label: label ?? null,
    name,
    address: strip(cellOf(table, /^住所/) ?? "") || null,
    lat: g.lat,
    lng: g.lng,
    capacity: capOf(cellOf(table, /収容台数/)),
    openingHours: hoursOf(cellOf(table, /^営業時間/)),
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: url ?? null,
  };
  if (name && !/時間貸/.test(kind)) return { ...rec, skip: `時間貸しでない（管理形態: ${kind || "空"}）` };
  return rec;
}
