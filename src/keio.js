// 京王不動産 / 京王コインパーク（keiofudosan.co.jp）詳細ページのパーサ -------
// 一覧 /rent/coinpark/all/ に全件（現状69件）、詳細 /rent/coinpark/detail/{slug}。
// 詳細は <dl class="modBlockCard01__detail-item"> の
//   <dt class="...__detail-title">ラベル</dt><dd class="...__detail-body">値</dd> 形式で
//   所在地 / 最寄駅 / 収容台数 / 入出庫可能時間 / 料金 / 特徴 を持つ。
// 緯度経度は所在地欄の Google マップリンク（maps?q=lat, lng）から取得。
// robots.txt の Disallow は /mt/ のみ。

import { han, strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://www.keiofudosan.co.jp/rent/coinpark/detail/";

export function detailUrl(id) {
  return `${BASE}${id}`;
}

function detailItem(html, dtLabel) {
  const m = html.match(new RegExp(
    `<dt class="modBlockCard01__detail-title">\\s*${dtLabel}\\s*</dt>\\s*<dd class="modBlockCard01__detail-body">([\\s\\S]*?)</dd>`
  ));
  return m ? m[1] : null;
}

export function parseKeioDetail(html, { id, label } = {}) {
  const h1 = (html.match(/<h1[^>]*class="[^"]*modBlockCard01__title[^"]*"[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const name = h1 ? strip(h1) : null;

  // 住所の後ろに「Googleマップをみる」リンク(<p class="modTxtLink01">)が続くので切る
  const addrCell = detailItem(html, "所在地");
  const address = addrCell ? strip(addrCell.split(/<p[^>]*class="modTxtLink01/)[0]) || null : null;

  let lat = null, lng = null;
  const q = html.match(/maps\?q=(-?[\d.]+),\s*(-?[\d.]+)/);
  if (q) { lat = Number(q[1]); lng = Number(q[2]); }

  // 「76（軽自動車区画、障害者等用区画2台含む）台」のような表記があるので先頭の数値を採る
  const capCell = detailItem(html, "収容台数");
  const capacity = capCell ? Number((han(strip(capCell)).match(/(\d+)/) || [])[1]) || null : null;

  const hoursCell = detailItem(html, "入出庫可能時間");
  const openingHours = hoursCell ? strip(hoursCell) || null : null;

  const feeCell = detailItem(html, "料金");
  const { unitCharges, maxFees } = feeCell ? parseFeeBlock(feeCell) : { unitCharges: [], maxFees: [] };

  return {
    operator: "keio",
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
