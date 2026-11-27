// トラストパーク（トラストパーク株式会社 / トラストナビ tpnavi.com）詳細ページのパーサ -------------------------------
// 2026-11-27 本人「トラストパークも作って」。物件ページは http://tpnavi.com/P{番号}.html（約1,030件・sitemap から列挙）。
// 物件の名前は <h2>（頭に「【クレジット・電子決済利用可】」などの見出しが付く）、ほかの欄は
//   <div class="phyou_left">ラベル</div><div class="phyou_right">値</div>
// の並び（住所・駐車場台数・駐車制限・営業時間・料金）。座標は地図の「現在閲覧中の駐車場の位置に戻る」の
// google.maps.LatLng(緯度,経度)。料金の欄は「【時間料金】20分330円【長時間サービス料金】(07:00～19:00)最大3100円」の形。
// 共通の parseFeeBlock（jp-fee-text.js）は【時間料金】【長時間サービス料金】を曜日の区分と読んでしまうので、
// ここで【通常料金】【最大料金】に直してから渡す（jp-fee-text.js は変えない）。
// robots.txt は Googlebot 向けの決まりだけで Disallow は空。利用規約に自動収集を禁止する文は無い（第4条に無断の複製・
// 商業的利用・転載は著作権の侵害とある。2026-11-27 本人に伝えたうえで「作って」）。
import { han, strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "http://tpnavi.com/";

export function detailUrl(id) {
  return `${BASE}P${id}.html`;
}

/** 「phyou_left」のラベルの次の「phyou_right」の中身（HTML）。無ければ null */
function cell(html, label) {
  const m = html.match(new RegExp(`<div class="phyou_left">\\s*${label}\\s*</div>\\s*<div class="phyou_right">([\\s\\S]*?)</div>\\s*<br style="clear:both;"\\s*/?>`));
  return m ? m[1] : null;
}

/** 料金の欄 → parseFeeBlock が読める形（見出しを直し、注意書きを落とす） */
export function normalizeTrustFee(html) {
  return String(html ?? "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/※料金や制限事項等[\s\S]*$/, " ")
    .replace(/【\s*(?:時間料金|通常料金|基本料金)\s*】/g, "【通常料金】")
    .replace(/【\s*(?:長時間サービス料金|最大料金|打切料金|打ち切り料金)\s*】/g, "【最大料金】");
}

export function parseTrustparkDetail(html, { id, label } = {}) {
  const page = String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
  const h2 = (page.match(/<h2>([\s\S]*?)<\/h2>/) || [])[1];
  const name = h2 ? strip(h2).replace(/^(?:【[^】]*】\s*)+/, "").trim() || null : null;

  const addrCell = cell(page, "住所");
  const address = addrCell ? strip(addrCell.split(/<br\s*\/?>\s*<br/i)[0]) || null : null;

  let lat = null, lng = null;
  const ll = page.match(/LatLng\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)[^"]*"\s*>\s*現在閲覧中の駐車場の位置に戻る/)
    ?? page.match(/LatLng\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/);
  if (ll) { lat = Number(ll[1]) || null; lng = Number(ll[2]) || null; }

  // 「20台、月極バイク3台」→ 先頭の数（時間貸の台数）
  const capCell = cell(page, "駐車場台数");
  const capacity = capCell ? Number((han(strip(capCell)).match(/(\d+)\s*台/) || [])[1]) || null : null;

  const hoursCell = cell(page, "営業時間");
  const hours = hoursCell ? strip(hoursCell) : "";
  const openingHours = /24\s*時間/.test(hours) ? "24時間" : hours || null;

  const feeCell = cell(page, "料金");
  const { unitCharges, maxFees } = feeCell ? parseFeeBlock(normalizeTrustFee(feeCell)) : { unitCharges: [], maxFees: [] };

  return {
    operator: "trustpark",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat,
    lng,
    capacity,
    openingHours,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}
