// フルーツパーク（株式会社グッドハウジング / fruit-parking.jp。フルーツパーク・イージーパーク など）--------------------------------
// 2026-11-27 本人「作れるものは全部作って」。robots.txt は管理画面だけの禁止・サイトの規約のページは無い（2026-11-27 確認）。
// 物件ページは https://www.fruit-parking.jp/coin/{スラッグ}（sitemap wp-sitemap-posts-coin-1.xml に約500件。京都・大阪が中心）。
//   名前 … <div class="description"><h2>
//   表   … 住所（都道府県の無いものがある）・時間貸収容台数・営業時間
//   料金 … <div class="price_table"> の表。1行に「ラベル・値」の組が2つ（「昼間（8-19時）」「60分／220円」「昼間最大」「550円（繰り返し可）」）。
//          ラベルに【平日】【土日祝】が付くことがある。「毎月25日」「年末年始特別料金」の組は特別な日なので読まない
//   位置 … 地図の iframe の q=緯度,経度
import { han, strip } from "./jp-fee-text.js";
import { feeOf, mergeFees, scopeOf, cellOf, capOf, hoursOf, latLngOf, sitemapLocs, tidyFee } from "./fee-rows.js";
import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

export const SITEMAP_URL = "https://www.fruit-parking.jp/wp-sitemap-posts-coin-1.xml";
export const detailUrl = (id) => `https://www.fruit-parking.jp/coin/${id}`;

export function parseFruitSitemap(xml) {
  const ids = [];
  for (const u of sitemapLocs(xml)) { const m = u.match(/fruit-parking\.jp\/coin\/([^/?#]+)\/?$/); if (m) ids.push(m[1]); }
  return [...new Set(ids)];
}

export async function getAllFruitIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const res = await politeFetch(SITEMAP_URL);
  throwIfRobotsSkipped(res, "フルーツパーク sitemap");
  if (!res.ok) throw new Error(`フルーツパーク sitemap: ${failText(res)}`);
  const ids = parseFruitSitemap(res.html);
  if (!ids.length) throw new Error("フルーツパーク sitemap が0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, ids.join("\n") + "\n"); markFetched(cacheFile); }
  return ids;
}

const SPECIAL = /毎月|年末|年始|特別|イベント|GW|ゴールデン|お盆|祭/;

/** 料金の表 → { unitCharges, maxFees } */
export function parseFruitPrice(tableHtml) {
  const parts = [];
  for (const row of String(tableHtml ?? "").match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...row.matchAll(/<(th|td)[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => [m[1], m[2]]);
    // 「ラベル(th)・値(td)」の組。同じ行の単価の時間帯を、その行の「昼間最大」「夜間最大」の時間帯にも使う
    const prs = [];
    for (let i = 0; i + 1 < cells.length; i++) if (cells[i][0] === "th" && cells[i + 1][0] === "td") prs.push([cells[i][1], cells[i + 1][1]]);
    let rowRange = null;
    for (const [lh, vh] of prs) {
      const label = tidyFee(strip(lh)), value = tidyFee(strip(vh));
      if (!label || label === "-" || !value || value === "-" || SPECIAL.test(label)) continue;
      const scope = scopeOf(label) ?? "全日";
      const range = (label.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/) || []).slice(1, 3).join("-") || null;
      const cond = label.replace(/【[^】]*】/g, " ").replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
      const isMax = /最大|まで|打切|打ち切/.test(label) || !/分|時間/.test(value);
      if (!isMax) {
        rowRange = range ?? rowRange;
        parts.push(feeOf(`${range ?? ""} ${value.replace(/^終日\s*/, "")}`, { scope }));
      } else {
        // 「昼間最大」「夜間最大」は同じ行の単価の時間帯で書く（normalize.js が時間帯の最大料金として読めるように）
        const c = /^(昼間|夜間)最大$/.test(cond) && (range ?? rowRange) ? `${range ?? rowRange} 最大` : cond;
        parts.push(feeOf(`${c} ${value}`, { scope, section: "max" }));
      }
    }
  }
  return mergeFees(parts);
}

export function parseFruitDetail(html, { id, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const desc = (page.match(/<div class="description">([\s\S]*?)<\/table>/) || [])[1] ?? "";
  const name = strip((desc.match(/<h2>([\s\S]*?)<\/h2>/) || [])[1] ?? "") || null;
  const price = (page.match(/<div class="price_table">([\s\S]*?)<\/div>/) || [])[1] ?? "";
  const fees = parseFruitPrice(price);
  const g = latLngOf((page.match(/<div class="g_map">[\s\S]*?<\/iframe>/) || [])[0] ?? "");
  return {
    operator: "fruitpark",
    parkId: String(id),
    label: label ?? null,
    name,
    address: strip(cellOf(desc, /^住所/) ?? "") || null,
    lat: g.lat,
    lng: g.lng,
    capacity: capOf(cellOf(desc, /収容台数/)),
    openingHours: hoursOf(cellOf(desc, /営業時間/)),
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: detailUrl(id),
  };
}
