// TOBU PARK（東武不動産 パーキング事業本部 / tobu-re-parking.jp）---------------------------------------------------------
// 2026-11-27 本人「作れるものは全部作って」。robots.txt は管理画面だけの禁止。サイトポリシーに自動収集の文は無いが、
// 権利者の承諾なく法律で認められる範囲を超えて転用・複製することを禁じる一般的な文がある（トラストパークと同じ種類。本人に伝えたうえで）。
// 物件ページは https://www.tobu-re-parking.jp/parking/{番号}.html（sitemap parking-sitemap.xml に約820件。月極・駐輪場も混ざる）。
//   名前 … <h1 class="title-h1__jp">
//   位置 … <gmp-map center="緯度,経度">
//   分類 … tag-contract__hourly（時間貸）・tag-type__car-parking（駐車場）。時間貸しの駐車場でなければ記録しない（{ skip }）
//   表   … 所在地・形態・車室数他・料金等（「8:00～20:00 200円/30分」「24時間最大 900円」「夜間最大(20:00～8:00) 400円」）
import { strip } from "./jp-fee-text.js";
import { feeFromLines, linesOf, cellOf, capOf, latLngOf, sitemapLocs } from "./fee-rows.js";
import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

export const SITEMAP_URL = "https://www.tobu-re-parking.jp/parking-sitemap.xml";
export const detailUrl = (id) => `https://www.tobu-re-parking.jp/parking/${id}.html`;

export function parseTobuSitemap(xml) {
  const ids = [];
  for (const u of sitemapLocs(xml)) { const m = u.match(/tobu-re-parking\.jp\/parking\/(\d+)\.html$/); if (m) ids.push(m[1]); }
  return [...new Set(ids)].sort((a, b) => Number(a) - Number(b));
}

export async function getAllTobuIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const res = await politeFetch(SITEMAP_URL);
  throwIfRobotsSkipped(res, "TOBU PARK sitemap");
  if (!res.ok) throw new Error(`TOBU PARK sitemap: ${failText(res)}`);
  const ids = parseTobuSitemap(res.html);
  if (!ids.length) throw new Error("TOBU PARK sitemap が0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, ids.join("\n") + "\n"); markFetched(cacheFile); }
  return ids;
}

export function parseTobuDetail(html, { id, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const name = strip((page.match(/<h1 class="title-h1__jp[^"]*">([\s\S]*?)<\/h1>/) || [])[1] ?? "") || null;
  const table = (page.match(/<table class="tbl-common">([\s\S]*?)<\/table>/) || [])[1] ?? "";
  const hourly = /tag-contract__hourly/.test(table);
  const car = /tag-type__car-parking/.test(table);
  const feeCell = cellOf(table, /料金等/);
  const fees = feeCell ? feeFromLines(linesOf(feeCell)) : { unitCharges: [], maxFees: [] };
  const g = latLngOf((page.match(/<gmp-map[^>]*>/) || [])[0] ?? "");
  const rec = {
    operator: "tobupark",
    parkId: String(id),
    label: label ?? null,
    name,
    address: strip(cellOf(table, /所在地/) ?? "") || null,
    lat: g.lat,
    lng: g.lng,
    capacity: capOf(cellOf(table, /車室数/)),
    openingHours: null,
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: detailUrl(id),
  };
  if (name && !car) return { ...rec, skip: "駐輪場・バイク置場" };
  if (name && !hourly) return { ...rec, skip: "月極だけ" };
  return rec;
}
