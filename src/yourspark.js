// ユアーズパーキング（株式会社ユアーズ・コーポレーション / coin-parking.com。東京・神奈川・千葉・埼玉・宮城）-------------------------
// ※ユアー・パーキング（ypark・株式会社ユアー・パーキング）とは別の会社。
// 2026-11-27 本人「作れるものは全部作って」。robots.txt は禁止なし。規約（/tos.html）に自動収集の文は無いが、
// 複製・二次利用は申請して許可を得ること、とある（トラストパークと同じ種類。本人に伝えたうえで）。
// 一覧 … https://www.coin-parking.com/case.html?page={0…}&todoufuken=&kushichouson=default（1ページ20件・約14ページ・約276件。
//         sitemap.xml は新しい物件が載っていないので一覧をたどる）
// 詳細 … https://www.coin-parking.com/case_detail{番号}.html。<h1 class="contentTitle">名前（「茅ヶ崎第2」のように社名なし）・
//         住所（〒つき）・収容台数・利用金額（「オールタイム30分200円」「24時間最大料金600円」「夜時間(18:00～翌8:00）最大料金300円」。
//         空行のあとの「領収書発行：可」などは料金ではない）・地図の埋め込み（pb の !3d緯度!2d経度）
// 名前は Parkopedia・看板の書き方に合わせて「ユアーズ・パーキング」を頭に付ける。
import fs from "node:fs";
import { strip } from "./jp-fee-text.js";
import { feeFromLines, capOf, latLngOf } from "./fee-rows.js";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

const BASE = "https://www.coin-parking.com";
export const listUrl = (page) => `${BASE}/case.html?page=${page}&todoufuken=&kushichouson=default`;
export const detailUrl = (id) => `${BASE}/case_detail${id}.html`;
export const BRAND = "ユアーズ・パーキング";
const MAX_PAGES = 40;

/** 一覧の1ページ → { ids, lastPage }（ページ送りのリンクの最大） */
export function parseYoursList(html) {
  const s = String(html ?? "");
  const ids = [...new Set([...s.matchAll(/case_detail(\d+)\.html/g)].map((m) => m[1]))];
  const pages = [...s.matchAll(/case\.html\?page=(\d+)/g)].map((m) => Number(m[1]));
  return { ids, lastPage: pages.length ? Math.max(...pages) : 0 };
}

export async function getAllYoursIds({ cacheFile, cacheMs = 7 * 864e5, fetcher = (u) => politeFetch(u) } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const all = new Set();
  let last = 0;
  for (let p = 0; p <= Math.min(last, MAX_PAGES); p++) {
    const res = await fetcher(listUrl(p));
    throwIfRobotsSkipped(res, "ユアーズ一覧");
    if (!res.ok) {
      if (p === 0) throw new Error(`ユアーズ一覧: ${failText(res)}`);
      throw new Error(`ユアーズ一覧 ${p + 1}ページ目: ${failText(res)}（欠けた一覧で上書きしない）`);
    }
    const { ids, lastPage } = parseYoursList(res.html);
    last = Math.max(last, lastPage);
    const before = all.size;
    ids.forEach((i) => all.add(i));
    if (all.size === before) break;
  }
  const ids = [...all].sort((a, b) => Number(a) - Number(b));
  if (!ids.length) throw new Error("ユアーズ一覧が0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, ids.join("\n") + "\n"); markFetched(cacheFile); }
  return ids;
}

/** <dt>ラベル</dt><dd>中身</dd> の中身 */
function dd(html, re) {
  for (const m of String(html).matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) if (re.test(strip(m[1]))) return m[2];
  return null;
}

export function parseYoursDetail(html, { id, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const title = strip((page.match(/<h1 class="contentTitle">([\s\S]*?)<\/h1>/) || [])[1] ?? "");
  const box = (page.match(/<ul class="case">([\s\S]*?)<\/ul>/) || [])[1] ?? "";
  const address = strip((dd(box, /住所/) ?? "").replace(/&nbsp;/g, " ")).replace(/^〒?\s*\d{3}-?\d{4}\s*/, "") || null;
  // 料金は最初の空行まで（そのあとは領収書・紙幣・設置場所などの案内）
  const feeHtml = (dd(box, /利用金額|料金/) ?? "").split(/<br\s*\/?>\s*<br\s*\/?>/i)[0];
  const lines = feeHtml.split(/<br\s*\/?>/i).map((x) => strip(x)).filter((x) => x && !/：|:\s*(?:可|不可)/.test(x.replace(/\d{1,2}:\d{2}/g, "")));
  const fees = feeFromLines(lines);
  const g = latLngOf((box.match(/<iframe[^>]*>/) || [])[0] ?? "");
  return {
    operator: "yourspark",
    parkId: String(id),
    label: label ?? null,
    name: title ? (title.startsWith("ユアーズ") ? title : `${BRAND}${title}`) : null,
    address,
    lat: g.lat,
    lng: g.lng,
    capacity: capOf(dd(box, /収容台数/)),
    openingHours: null,
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: detailUrl(id),
  };
}
