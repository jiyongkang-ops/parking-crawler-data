// システムパーク（仙台 / systempark.biz）詳細ページのパーサ -------------------
// /jisseki/index.php?cat=N がエリアタブ一覧、/jisseki/detail.php?id=N が詳細。
// 詳細は #ParkingData の <table> に 所在地 / 駐車可能台数（時間貸し）/ ご利用金額（時間貸し）。
// 台数は全角数字（７台）で入るため han() で正規化してからパースする。
// 緯度経度は「大きい地図で見る」リンクの ll=lat,lng から取得する。
//   ※一覧ページの markerJson は lat と lng が入れ替わって入っているので使わない。
// robots.txt は存在しない（404）＝制限なし。

import { han, strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://systempark.biz/jisseki/";

export function detailUrl(id) {
  return `${BASE}detail.php?id=${id}`;
}

function rowCell(html, thLabel) {
  const m = html.match(new RegExp(`<th[^>]*>\\s*${thLabel}[^<]*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : null;
}

export function parseSystemparkDetail(html, { id, label } = {}) {
  const h4 = (html.match(/<div id="ParkingData">[\s\S]*?<h4>([\s\S]*?)<\/h4>/) || [])[1];
  const name = h4 ? strip(h4) : strip((html.match(/<title>([^<|]+)/) || [, ""])[1]) || null;

  const addrCell = rowCell(html, "所在地");
  const address = addrCell ? strip(addrCell) || null : null;

  const capCell = rowCell(html, "駐車可能台数");
  let capacity = capCell ? Number((strip(capCell).match(/(\d+)/) || [])[1]) || null : null;
  if (capacity === null) {
    const ico = html.match(/class="icoShosai"[\s\S]*?>\s*([^<]*台)/);
    capacity = ico ? Number((han(ico[1]).match(/(\d+)/) || [])[1]) || null : null;
  }

  const feeCell = rowCell(html, "ご利用金額");
  const { unitCharges, maxFees } = feeCell ? parseFeeBlock(feeCell) : { unitCharges: [], maxFees: [] };

  let lat = null, lng = null;
  const ll = html.match(/[?&]ll=(-?[\d.]+),(-?[\d.]+)/);
  if (ll) { lat = Number(ll[1]); lng = Number(ll[2]); }

  return {
    operator: "systempark",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat,
    lng,
    capacity,
    openingHours: null, // 入出庫可能時間の欄は無い
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}
