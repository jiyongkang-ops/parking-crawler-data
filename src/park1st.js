// Park1st.（阪急阪神ビルマネジメント / park1st.jp。大阪・京都・兵庫のビル・駅の駐車場）-----------------------------------------
// 2026-11-27 本人「作れるものは全部作って」。robots.txt は無い（404）・サイトの規約は駐車場の利用規約だけ（2026-11-27 確認）。
// 一覧 … /system/Parkings/index/1（時間貸し）に町ごとの一覧（約42）→ 各一覧に物件の詳細へのリンク
//         /system/Parkings/detail/{番号}/1/1/{都道府県}/{市}/{町}。巡回の番号は詳細の URL そのもの（番号だけの URL は確かめていない）
// 詳細 … <h4>名前・地図の iframe（q=緯度,経度）・表（住所・営業＝時間貸し・営業時間・台数）・料金の表（見出しの行の th と、
//         次の行の td が組。「全日」→「最初の60分 400円 / 以降30分毎 200円」・「当日最大」→「1,000円」・「定期券」は読まない）
import fs from "node:fs";
import { strip, han } from "./jp-fee-text.js";
import { feeFromLines, linesOf, mergeFees, cellOf, capOf, hoursOf, latLngOf, scopeOf } from "./fee-rows.js";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch, throwIfRobotsSkipped, failText } from "./polite-fetch.js";

const BASE = "https://park1st.jp";
export const INDEX_URL = `${BASE}/system/Parkings/index/1`;
const abs = (h) => new URL(h.replace(/&amp;/g, "&"), BASE + "/").href;

export const parseIndex = (html) => [...new Set([...String(html ?? "").matchAll(/href="([^"]*\/system\/Parkings\/parkinglist\/1\/[^"]+)"/g)].map((m) => abs(m[1])))];
export const parseAreaList = (html) => [...new Set([...String(html ?? "").matchAll(/href="([^"]*\/system\/Parkings\/detail\/\d+\/1\/[^"]+)"/g)].map((m) => abs(m[1])))];

export async function getAllPark1stUrls({ cacheFile, cacheMs = 7 * 864e5, fetcher = (u) => politeFetch(u) } = {}) {
  if (cacheFile && fs.existsSync(cacheFile) && cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  const top = await fetcher(INDEX_URL);
  throwIfRobotsSkipped(top, "Park1st 一覧");
  if (!top.ok) throw new Error(`Park1st 一覧: ${failText(top)}`);
  const areas = parseIndex(top.html);
  if (!areas.length) throw new Error("Park1st の町の一覧が0件（ページ構造変更の可能性）");
  const urls = new Map();
  for (const a of areas) {
    const res = await fetcher(a);
    throwIfRobotsSkipped(res, "Park1st 一覧");
    if (!res.ok) throw new Error(`Park1st 一覧（${decodeURI(a).split("/").slice(-1)[0]}）: ${failText(res)}（欠けた一覧で上書きしない）`);
    for (const u of parseAreaList(res.html)) { const id = idOf(u); if (id && !urls.has(id)) urls.set(id, u); }
  }
  const list = [...urls.values()];
  if (!list.length) throw new Error("Park1st の物件が0件（ページ構造変更の可能性）");
  if (cacheFile) { fs.writeFileSync(cacheFile, list.join("\n") + "\n"); markFetched(cacheFile); }
  return list;
}

export const idOf = (url) => (String(url ?? "").match(/\/detail\/(\d+)\//) || [])[1] ?? null;

/** 料金の表（見出しの行と値の行が交互）→ { unitCharges, maxFees } */
export function parsePark1stPrice(tableHtml) {
  const rows = (String(tableHtml ?? "").match(/<tr>[\s\S]*?<\/tr>/g) ?? []).map((r) => ({
    th: [...r.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1])),
    td: [...r.matchAll(/<td(?![^>]*bikou)[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]),
  }));
  const parts = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    if (!rows[i].th.length || !rows[i + 1].td.length) continue;
    rows[i].th.forEach((label, k) => {
      const td = rows[i + 1].td[k];
      if (!label || !td || /定期|回数券|月極|サービス券/.test(label)) return;
      const scope = scopeOf(label) ?? "全日";
      if (/最大|打切/.test(label)) {
        const cond = han(label).replace(/(全日|平日|土日祝日?|土曜|日曜|日祝)/g, "").trim() || "最大";
        parts.push(feeFromLines(linesOf(td).map((x) => `${cond} ${x}`), { scope, section: "max" }));
      } else {
        const range = han(label).match(/\d{1,2}:\d{2}\s*[~-]\s*\d{1,2}:\d{2}/)?.[0] ?? "";
        parts.push(feeFromLines(linesOf(td).map((x) => `${range} ${x}`), { scope }));
      }
    });
  }
  return mergeFees(parts);
}

export function parsePark1stDetail(html, { url, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const wrap = (page.match(/<div class="detail_wrap">([\s\S]*?)<p id="btn_print">/) || [])[1] ?? page;
  const name = strip((wrap.match(/<h4>([\s\S]*?)<\/h4>/) || [])[1] ?? "") || null;
  const tbl = (wrap.match(/<div id="dtl_tbl">([\s\S]*?)<\/table>/) || [])[1] ?? "";
  const price = (wrap.match(/<div class="dtl_price">([\s\S]*?)<\/table>/) || [])[1] ?? "";
  const kind = strip(cellOf(tbl, /^営業$/) ?? "");
  const fees = parsePark1stPrice(price);
  const g = latLngOf((wrap.match(/<iframe[^>]*>/) || [])[0] ?? "");
  const rec = {
    operator: "park1st",
    parkId: idOf(url),
    label: label ?? null,
    name,
    address: strip(cellOf(tbl, /^住所/) ?? "") || null,
    lat: g.lat,
    lng: g.lng,
    capacity: capOf(cellOf(tbl, /^台数/)),
    openingHours: hoursOf(cellOf(tbl, /営業時間/)),
    unitCharges: fees.unitCharges,
    maxFees: fees.maxFees,
    sourceUrl: url ?? null,
  };
  if (name && kind && !/時間貸/.test(kind)) return { ...rec, skip: `時間貸しでない（${kind}）` };
  return rec;
}
