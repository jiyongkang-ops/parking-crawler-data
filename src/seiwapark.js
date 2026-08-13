// セイワパーク（seiwapark.co.jp）駐車場ページのパーサ ------------------------
// WordPress。カスタム投稿 "search" が1物件＝1ページ。
//   一覧 /search/ (+ /search/page/N) … 名称・住所・料金まで一覧に直載（5ページで全件）
//   詳細 /search/{slug}              … 一覧の情報に加え 収容台数・緯度経度
// parkId は URL スラッグ（日本語）。列挙は seiwapark-enumerate（一覧5ページ巡回）。
// robots.txt に制限は無い（空レスポンス）。
// 注: 一覧・詳細とも <address>/<td> 内の <br> 区切り自由文が料金。jp-fee-text で解釈する。

import { strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://www.seiwapark.co.jp/search/";

// 列挙が返すのは URL エンコード済みスラッグ。日本語で渡された場合も通るようにする。
export function detailUrl(id) {
  const slug = /[^\x00-\x7F]/.test(id) ? encodeURIComponent(id) : id;
  return `${BASE}${slug}`;
}

function decodeId(id) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function tableCell(html, thLabel) {
  const m = html.match(new RegExp(`<th>\\s*${thLabel}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : null;
}

// 詳細ページ /search/{slug}
export function parseSeiwaparkDetail(html, { id, label } = {}) {
  const h1 = (html.match(/<h1[^>]*class="[^"]*p-parking-detail__heading[^"]*"[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const name = h1 ? strip(h1) : strip((html.match(/<title>([^<|]+)/) || [, ""])[1]) || null;

  // 住所セルの末尾に「Googleマップで見る」ボタン(div)が付くので div 以降を捨てる
  const addrCell = tableCell(html, "住所");
  const address = addrCell ? strip(addrCell.split(/<div/)[0]) || null : null;

  let lat = null, lng = null;
  const q = html.match(/maps\/search\/\?api=1&query=(-?[\d.]+),\s*(-?[\d.]+)/);
  if (q) { lat = Number(q[1]); lng = Number(q[2]); }

  const capCell = tableCell(html, "収容台数");
  const capacity = capCell ? Number((strip(capCell).match(/(\d+)\s*台/) || [])[1]) || null : null;

  const feeCell = tableCell(html, "料金形態");
  const { unitCharges, maxFees } = feeCell ? parseFeeBlock(feeCell) : { unitCharges: [], maxFees: [] };

  return {
    operator: "seiwapark",
    parkId: decodeId(String(id)),
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

// 一覧ページ /search/(page/N) → レコード配列（詳細を踏まず5リクエストで済ませたい場合用）
export function parseSeiwaparkList(html) {
  const records = [];
  for (const chunk of html.split(/<li class="p-parking-search__item">/).slice(1)) {
    const href = chunk.match(/href="https:\/\/www\.seiwapark\.co\.jp\/search\/([^"\/]+)"/);
    if (!href) continue;
    const slug = href[1];
    const name = strip((chunk.match(/<h3 class="p-parking-search__ttl">([\s\S]*?)<\/h3>/) || [, ""])[1]) || null;
    const addrBlock = (chunk.match(/<address class="p-parking-search__address">([\s\S]*?)<\/address>/) || [, ""])[1];
    // 1行目が住所、2行目以降が料金（最初の <br> が区切り）
    const parts = addrBlock.split(/<br\s*\/?>/i);
    const address = strip(parts[0]) || null;
    const { unitCharges, maxFees } = parseFeeBlock(parts.slice(1).join("<br>"));
    records.push({
      operator: "seiwapark",
      parkId: decodeId(slug),
      label: null,
      name,
      address,
      lat: null,
      lng: null,
      capacity: null,
      openingHours: null,
      unitCharges,
      maxFees,
      sourceUrl: detailUrl(slug),
    });
  }
  const pages = [...html.matchAll(/\/search\/page\/(\d+)/g)].map((m) => Number(m[1]));
  return { records, maxPage: pages.length ? Math.max(...pages) : 1 };
}
