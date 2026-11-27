// コインパーク（株式会社コインパーク / コインパーク駐車場検索 coinpark.info）詳細ページのパーサ ------------------------------
// 2026-11-27 本人「作れるものは全部作って」（11/02 に「取らない」と決めた社。調べ直して、規約のページが無く robots.txt も
// 管理画面だけの禁止と分かったうえで）。物件ページは https://www.coinpark.info/{物件名}/（WordPress の投稿。sitemap 1枚に約1,820件）。
//   名前と管理番号 … <div class="detailParkName spNone"><span>A-3635&nbsp;コインパーク西片2丁目</span>
//   住所          … <p class="parkAddress detailsAddress">
//   位置          … 本文の地図の google.maps.LatLng(緯度,経度)（#mainContent の中。左の一覧にも同じ形があるので本文から読む）
//   台数          … 「時間貸し収容台数」の「[車: 5台]」
//   料金          … 「料金体系」の表。行の見出しが曜日の区分（【全日】【月～土】【日 祝】）、中身は
//                   「■通常料金」「【00:00～24:00】20分200円」「■最大料金」「【駐車後24時間毎】1700円」「【18:00～7:00】400円」
// ページは約600KB（左の一覧に同じ区の物件が全部載る）。1回の件数を抑える（config の coinparkRollingPerRun）。
// AURA PARKING（管理番号 B-…）も同じサイトに載る、コインパークが運営する駐車場なので同じく記録する。
// 車の台数が無い物件（バイク・駐輪場だけ）は記録しない。
import fs from "node:fs";
import { han, strip } from "./jp-fee-text.js";
import { feeOf, mergeFees, scopeOf, capOf, cellOf, sitemapLocs } from "./fee-rows.js";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

export const SITE = "https://www.coinpark.info/";
export const SITEMAP_INDEX = "https://www.coinpark.info/wp-sitemap.xml";

/** sitemap の索引 → 投稿（物件）の sitemap（wp-sitemap-posts-post-N.xml）の URL */
export const parsePostSitemaps = (xml) => sitemapLocs(xml).filter((u) => /wp-sitemap-posts-post-\d+\.xml$/.test(u));
/** 投稿の sitemap → 物件ページの URL（coinpark.info/{1つの部分}/ の形だけ） */
export const parseCoinparkSitemap = (xml) => [...new Set(sitemapLocs(xml).filter((u) => /^https:\/\/www\.coinpark\.info\/[^/?#]+\/$/.test(u)))];

/** 一覧（物件ページの URL）。7日ごとに sitemap（索引1枚＋投稿の sitemap 1〜2枚）を読み直す */
export async function getAllCoinparkUrls({ cacheFile, cacheMs = 7 * 864e5, fetcher = (u) => politeFetch(u) } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const idx = await fetcher(SITEMAP_INDEX);
  throwIfRobotsSkipped(idx, "コインパーク sitemap");
  if (!idx.ok) throw new Error(`コインパーク sitemap: ${failText(idx)}`);
  const maps = parsePostSitemaps(idx.html);
  if (!maps.length) throw new Error("コインパーク sitemap に物件の sitemap が無い（ページ構造変更の可能性）");
  const urls = new Set();
  for (const m of maps) {
    const res = await fetcher(m);
    throwIfRobotsSkipped(res, "コインパーク sitemap");
    if (!res.ok) throw new Error(`コインパーク sitemap（${m.split("/").pop()}）: ${failText(res)}（欠けた一覧で上書きしない）`);
    parseCoinparkSitemap(res.html).forEach((u) => urls.add(u));
  }
  const list = [...urls];
  if (!list.length) throw new Error("コインパーク sitemap が0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, list.join("\n") + "\n"); markFetched(cacheFile); }
  return list;
}

/** URL の最後の部分（物件名）を文字に戻す */
export function slugOf(url) {
  const m = String(url ?? "").match(/coinpark\.info\/([^/?#]+)\/?/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

/** 料金の表の1行（中身）→ { unitCharges, maxFees }（scope はその行の見出し） */
export function parseCoinparkFeeCell(tdHtml, scope = "全日") {
  const parts = [];
  let sec = null;
  for (const raw of String(tdHtml ?? "").split(/<br\s*\/?>/i)) {
    let t = han(strip(raw));
    if (!t) continue;
    if (/^■\s*(?:通常|基本)料金/.test(t)) { sec = null; continue; }
    if (/^■\s*(?:最大|打切|打ち切)/.test(t)) { sec = "max"; continue; }
    if (/^■/.test(t)) { sec = "skip"; continue; }        // ■月極 など、時間貸しの料金でない見出し
    if (sec === "skip") continue;
    t = t.replace(/^【([^】]*)】\s*/, "$1 ");            // 【00:00～24:00】・【駐車後24時間毎】の括弧を外す
    parts.push(feeOf(t, { scope, section: sec }));
  }
  return mergeFees(parts);
}

export function parseCoinparkDetail(html, { url, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const main = page.slice(Math.max(0, page.indexOf('id="mainContent"')));
  const head = (main.match(/<div class="detailParkName spNone">\s*<span>([\s\S]*?)<\/span>/) || [])[1];
  let manageNo = null, name = null;
  if (head) {
    const t = strip(head.replace(/&nbsp;/g, " "));
    const m = t.match(/^([A-Z]-\d+)\s+(.+)$/);
    if (m) { manageNo = m[1]; name = m[2].trim(); } else name = t || null;
  }
  const address = strip((main.match(/<p class="parkAddress detailsAddress">([\s\S]*?)<\/p>/) || [])[1] ?? "") || null;

  let lat = null, lng = null;
  const ll = main.match(/LatLng\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
  if (ll) { lat = Number(ll[1]) || null; lng = Number(ll[2]) || null; }

  const details = main.slice(0, Math.max(0, main.indexOf('<div class="pcNone">')) || undefined);
  const capCell = cellOf(details, /時間貸し?収容台数/);
  const capText = han(strip((capCell ?? "").replace(/&nbsp;/g, " ")));
  const car = capText.match(/車\s*:?\s*(\d+)\s*台/);
  const capacity = car ? Number(car[1]) || null : (/バイク|駐輪|自転車/.test(capText) ? 0 : capOf(capText));

  const feeTable = (details.match(/料金体系\s*<\/h3>\s*<table>([\s\S]*?)<\/table>/) || [])[1] ?? "";
  const rows = [...feeTable.matchAll(/<tr>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)];
  const fees = mergeFees(rows.map((m) => parseCoinparkFeeCell(m[2], scopeOf(m[1]) ?? (han(strip(m[1])).replace(/[【】\s]/g, "") || "全日"))));

  const rec = {
    operator: "coinpark",
    parkId: manageNo ?? slugOf(url),
    label: label ?? null,
    name,
    address,
    lat,
    lng,
    capacity,
    openingHours: /24時間営業/.test(main.slice(0, 4000)) ? "24時間" : null,
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: url ?? null,
  };
  if (name && capacity === 0) return { ...rec, skip: "車の区画が無い（バイク・駐輪場だけ）" };
  // 物件のページでない投稿（sitemap に混ざる「…__trashed」など。名前の欄が無い）。ページの作りが変わって全部がこれになったときは、
  // 巡回の一斉の閉鎖の歯止めで止まる
  if (!head && /<title>/.test(page) && !/料金体系/.test(page)) return { ...rec, skip: "物件のページでない" };
  return rec;
}
