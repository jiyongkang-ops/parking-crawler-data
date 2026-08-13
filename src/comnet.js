// コムネット / コムパーク（comnet-p.co.jp）詳細ページのパーサ ---------------
// WordPress。物件は /parking/{6桁ゼロ埋めID}/ 。詳細は <dl class="table"> の
// <dt>ラベル</dt><dd>値</dd> 形式で 所在地 / 収容台数 / 駐車料金 を持つ。
// 料金は 《通常料金》《最大料金》 の見出しで区切られた自由テキスト。
// 緯度経度は全ページに埋め込まれる地図用JS（markerJson[N] = {... LINK:'.../parking/ID/'}）
// から自ID分を引く。robots.txt の Disallow は /wp-admin/ のみ。

import { strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://comnet-p.co.jp/parking/";

export function detailUrl(id) {
  return `${BASE}${id}/`;
}

function dlValue(html, dtLabel) {
  const m = html.match(new RegExp(`<dt>\\s*${dtLabel}\\s*</dt>\\s*<dd>([\\s\\S]*?)</dd>`));
  return m ? m[1] : null;
}

// 地図用JSから自物件のマーカーを引く（緯度経度・台数・名称の補完に使う）
export function findMarker(html, id) {
  const m = html.match(new RegExp(`markerJson\\[\\d+\\]\\s*=\\s*\\{([^}]*LINK:'[^']*/parking/${id}/'[^}]*)\\}`));
  if (!m) return null;
  const body = m[1];
  const num = (k) => {
    const g = body.match(new RegExp(`${k}\\s*:\\s*(-?[\\d.]+)`));
    return g ? Number(g[1]) : null;
  };
  const str = (k) => {
    const g = body.match(new RegExp(`${k}\\s*:\\s*'([^']*)'`));
    return g ? g[1] : null;
  };
  return { lat: num("Lat"), lng: num("Lng"), capacity: Number(str("CAPACITY")) || null, title: str("TITLE") };
}

export function parseComnetDetail(html, { id, label } = {}) {
  const pid = String(id);
  const marker = findMarker(html, pid);
  const h1 = (html.match(/<div class="main column1">[\s\S]*?<h1>([\s\S]*?)<\/h1>/) || [])[1];
  const name = (h1 ? strip(h1) : null) || marker?.title || null;

  const addrCell = dlValue(html, "所在地");
  const address = addrCell ? strip(addrCell) || null : null;

  const capCell = dlValue(html, "収容台数");
  const capacity = (capCell ? Number((strip(capCell).match(/(\d+)/) || [])[1]) || null : null) ?? marker?.capacity ?? null;

  const feeCell = dlValue(html, "駐車料金");
  const { unitCharges, maxFees } = feeCell ? parseFeeBlock(feeCell) : { unitCharges: [], maxFees: [] };

  return {
    operator: "comnet",
    parkId: pid,
    label: label ?? null,
    name,
    address,
    lat: marker?.lat ?? null,
    lng: marker?.lng ?? null,
    capacity,
    openingHours: null, // 入出庫可能時間の欄は無い
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(pid),
  };
}
