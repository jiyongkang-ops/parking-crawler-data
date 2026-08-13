// 東急ライフィア（tokyulifia.co.jp）コインパーキング詳細ページのパーサ --------
// https://www.tokyulifia.co.jp/parking/coin/{id}
// 全てサーバ描画。<table class="outlineTable"> の th/td 対に
//   料金 / 所在地 / 最寄り駅 / 収容台数 / 駐車場タイプ / 営業時間 / … が入る。
// 料金欄は 【通常料金】【最大料金】の見出し付きで <br> 区切り。例:
//   【通常料金】/ 09:00～20:00 30分/200円 / 20:00～09:00 60分/100円
//   【最大料金】/ 12時間 800円（繰り返し適用）
// 見出しが無く「平 日：300円／30分」のように金額先行の物件もある。
// 緯度経度が hidden input で出ているので lat/lng も埋める。
// robots.txt の Disallow は /sale/collaboration/pdf/ のみ。

import { linesOf, scopeOf, textOf, timeRangeOf, toHalfWidth, yen } from "./zenkaku.js";

const BASE = "https://www.tokyulifia.co.jp";

export function detailUrl(id) {
  return `${BASE}/parking/coin/${id}`;
}

export function searchUrl(page = 1) {
  return `${BASE}/parking/search/coin/?page=${page}`;
}

function cell(html, label) {
  const m = html.match(new RegExp(`<th>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : null;
}

function parseFeeLine(line, mode, out) {
  const t = toHalfWidth(line);
  if (!/円/.test(t)) return;
  const scope = scopeOf(t);
  const tr = timeRangeOf(t);

  if (mode !== "max") {
    // 「30分/200円」形式
    let hit = false;
    for (const m of t.matchAll(/(\d+)\s*分\s*[\/]?\s*([\d,]+)\s*円/g)) {
      out.unitCharges.push({ scope, timeRange: tr ?? "全日", perMinutes: Number(m[1]), amountYen: yen(m[2]) });
      hit = true;
    }
    // 「300円／30分」形式
    if (!hit) {
      for (const m of t.matchAll(/([\d,]+)\s*円\s*[\/]\s*(\d+)\s*分/g)) {
        out.unitCharges.push({ scope, timeRange: tr ?? "全日", perMinutes: Number(m[2]), amountYen: yen(m[1]) });
        hit = true;
      }
    }
    if (hit) return;
  }

  // 最大料金。「12時間 800円（繰り返し適用）」「24時間最大 1,000円」など。
  const m = t.match(/([\d,]+)\s*円/);
  if (!m) return;
  let condition = t
    .slice(0, m.index)
    .replace(/平日|土日祝|土・日・祝|日祝|土日/g, "")
    .replace(/[()【】]/g, " ")
    .replace(/\d{1,2}:\d{2}\s*[~\-]\s*\d{1,2}:\d{2}/, tr ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (tr && !/\d{1,2}:\d{2}-\d{1,2}:\d{2}/.test(condition)) condition = `${condition} ${tr}`.trim();
  out.maxFees.push({ scope, condition: condition || "最大", amountYen: yen(m[1]) });
}

export function parseTokyuLifiaFee(rawHtml) {
  const out = { unitCharges: [], maxFees: [] };
  let mode = "unit";
  for (const line of linesOf(rawHtml)) {
    if (/【\s*最大料金/.test(line)) { mode = "max"; continue; }
    if (/【\s*(通常料金|駐車料金|基本料金|時間料金)/.test(line)) { mode = "unit"; continue; }
    if (/【/.test(line) && !/円/.test(line)) { mode = "unit"; continue; }
    parseFeeLine(line, mode, out);
  }
  return out;
}

export function parseTokyuLifiaDetail(html, { id, label } = {}) {
  const h2 = (html.match(/<h2 class="ico">([\s\S]*?)<\/h2>/) || [])[1];
  const name = h2 ? textOf(h2) : textOf((html.match(/<title>([^<]*)/) || [])[1]);

  const address =
    textOf(cell(html, "所在地")) ||
    textOf((html.match(/<li class="ico_place">([\s\S]*?)<\/li>/) || [])[1]) ||
    null;

  const capText = textOf(cell(html, "収容台数"));
  const capacity = capText ? Number((capText.match(/(\d+)\s*台/) || [])[1]) || null : null;

  let openingHours = textOf(cell(html, "営業時間"));
  if (!openingHours || openingHours === "-") openingHours = null;

  const lat = Number((html.match(/id="latitude"\s+value="\s*([-\d.]+)\s*"/) || [])[1]);
  const lng = Number((html.match(/id="longitude"\s+value="\s*([-\d.]+)\s*"/) || [])[1]);

  const { unitCharges, maxFees } = parseTokyuLifiaFee(cell(html, "料金"));

  return {
    operator: "tokyulifia",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    capacity,
    openingHours,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}

// 検索結果ページ → 物件ID一覧と総件数
export function parseTokyuLifiaSearch(html) {
  const ids = [...new Set([...html.matchAll(/\/parking\/coin\/(\d+)/g)].map((m) => m[1]))];
  const tm = toHalfWidth(html).match(/<em class="color_red">(\d+)<\/em>\s*件中/);
  return { ids, total: tm ? Number(tm[1]) : null };
}
