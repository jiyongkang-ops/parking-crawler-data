// 京成パーク（京成不動産 / keisei-park.com。エスピーパーク・京成パーク。東京東部・千葉）---------------------------------------
// 2026-11-27 本人「作れるものは全部作って」。robots.txt は禁止なし。サイトポリシーに自動収集の文は無いが、無断の複製・転用を
// 禁じる一般的な文がある（トラストパークと同じ種類。本人に伝えたうえで）。
// 物件ページは sitemap.xml（約475件）のうち /car/carhourly/…/{名前}.html（約85件）。巡回の番号は URL そのもの。
// バイク（/motorbike/）・月極（/car/carmonthly/）の URL は読まない。
//   名前 … <article> の <h3>
//   位置 … 地図の埋め込み（pb の !3d緯度!2d経度）
//   表   … 「ご利用案内」所在地・営業時間・収容台数。「ご利用料金」は 時間帯（th）→ 料金（td）、「最大料金（繰り返し適用）」→
//          「24時間最大900円<br>20：00～8：00 最大300円」
import fs from "node:fs";
import { strip } from "./jp-fee-text.js";
import { feeFromLines, linesOf, mergeFees, pairs, cellOf, capOf, hoursOf, latLngOf, sitemapLocs, scopeOf } from "./fee-rows.js";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

export const SITEMAP_URL = "https://www.keisei-park.com/sitemap.xml";

export function parseKeiseiSitemap(xml) {
  return [...new Set(sitemapLocs(xml).filter((u) => /keisei-park\.com\/car\/carhourly\/[^?#]+\/[^/]+\.html$/.test(u)))];
}

export async function getAllKeiseiUrls({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const res = await politeFetch(SITEMAP_URL);
  throwIfRobotsSkipped(res, "京成パーク sitemap");
  if (!res.ok) throw new Error(`京成パーク sitemap: ${failText(res)}`);
  const urls = parseKeiseiSitemap(res.html);
  if (!urls.length) throw new Error("京成パーク sitemap の時間貸しが0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, urls.join("\n") + "\n"); markFetched(cacheFile); }
  return urls;
}

export const idOf = (url) => (String(url ?? "").match(/\/([^/]+)\.html$/) || [])[1] ?? null;

export function parseKeiseiDetail(html, { url, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const art = (page.match(/<article[^>]*>([\s\S]*?)<\/article>/) || [])[1] ?? "";
  const name = strip((art.match(/<h3>([\s\S]*?)<\/h3>/) || [])[1] ?? "") || null;
  const tables = [...art.matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]);
  const info = tables.find((t) => /所在地/.test(t)) ?? "";
  const price = tables.find((t) => /円/.test(t) && !/所在地/.test(t)) ?? "";
  const parts = [];
  for (const [label0, td] of pairs(price)) {
    const scope = scopeOf(label0) ?? "全日";
    if (/最大|打切/.test(label0)) parts.push(feeFromLines(linesOf(td), { scope, section: "max" }));
    else parts.push(feeFromLines(linesOf(td).map((x) => `${label0.replace(/^(平日|土日祝日?|全日)\s*/, "")} ${x}`), { scope }));
  }
  const fees = mergeFees(parts);
  const g = latLngOf((art.match(/<iframe[^>]*>/) || [])[0] ?? "");
  return {
    operator: "keiseipark",
    parkId: idOf(url),
    label: label ?? null,
    name,
    address: strip(cellOf(info, /所在地/) ?? "") || null,
    lat: g.lat,
    lng: g.lng,
    capacity: capOf(cellOf(info, /収容台数/)),
    openingHours: hoursOf(cellOf(info, /営業時間/)),
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: url ?? null,
  };
}
