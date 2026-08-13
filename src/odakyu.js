// 小田急不動産 / 小田急パーキング（service.odakyu-life.jp/parking/）のパーサ --
// WordPress。一覧 /parking/hourly_parking/ に全件（現状51件・ページャ無し）、
// 詳細は /parking/hourly_parking/{slug}/（英字スラッグと日本語URLエンコードが混在）。
// 詳細ページの構造:
//   名称   … <section class="p-cont"><h3>名称</h3>
//   所在地 … <span class="cms-info__adrs">（市区町村と丁目が <i> で分かれる）
//   台数   … <div class="...cms-timedai">（時間貸し台数）/ <span class="cms-info__dai">（総台数）
//   料金   … <div class="p-tabl__data__ttl">通常料金|最大料金</div> 直後の
//            <div class="p-tabl__data__inf">
//   緯度経度 … Googleマップ埋め込み iframe の !2d{lng}!3d{lat}
// 最大料金は「昼間最大　1,000円/夜間最大　300円」のように "円/" で連結されるため、
// 通常料金の "20分/100円" を壊さないよう「円の直後の / 」だけを行区切りに直す。
// robots.txt は存在しない（404）＝制限なし。

import { han, strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://service.odakyu-life.jp/parking/hourly_parking/";

export function detailUrl(id) {
  const slug = /[^\x00-\x7F]/.test(id) ? encodeURIComponent(id) : id;
  return `${BASE}${slug}/`;
}

function decodeId(id) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function tablValue(html, label) {
  const m = html.match(new RegExp(
    `<div class="p-tabl__data__ttl">\\s*${label}\\s*</div>\\s*<div class="p-tabl__data__inf[^"]*">([\\s\\S]*?)</div>`
  ));
  return m ? m[1] : null;
}

export function parseOdakyuDetail(html, { id, label } = {}) {
  const h3 = (html.match(/<section class="p-cont">\s*<h3>([\s\S]*?)<\/h3>/) || [])[1];
  const name = h3 ? strip(h3) : strip((html.match(/<title>([^<|]+)/) || [, ""])[1]) || null;

  const adrs = (html.match(/<span class="cms-info__adrs">([\s\S]*?)<\/span>/) || [])[1];
  const address = adrs ? strip(adrs).replace(/\s+/g, "") || null : null;

  // 台数: 時間貸し台数を優先、無ければ総台数
  const timeDai = (html.match(/class="[^"]*cms-timedai[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
  const totalDai = (html.match(/<span class="cms-info__dai">([\s\S]*?)<\/span>/) || [])[1];
  const capFrom = (v) => (v ? Number((han(strip(v)).match(/(\d+)/) || [])[1]) || null : null);
  const capacity = capFrom(timeDai) ?? capFrom(totalDai);

  const openCell = (html.match(/<span class="cms-info__(?:eigyo|jikan|riyo)">([\s\S]*?)<\/span>/) || [])[1];
  const openingHours = openCell ? strip(openCell) || null : null;

  // "円/" を行区切りに直してから解釈する
  const splitYenSlash = (s) => String(s ?? "").replace(/円\s*[\/／]/g, "円<br>");
  const normal = parseFeeBlock(splitYenSlash(tablValue(html, "通常料金")));
  const maxi = parseFeeBlock(splitYenSlash(tablValue(html, "最大料金")), "max");

  let lat = null, lng = null;
  const emb = html.match(/maps\/embed\?pb=[^"']*?!2d(-?[\d.]+)!3d(-?[\d.]+)/);
  if (emb) { lng = Number(emb[1]); lat = Number(emb[2]); }

  return {
    operator: "odakyu",
    parkId: decodeId(String(id)),
    label: label ?? null,
    name,
    address,
    lat,
    lng,
    capacity,
    openingHours,
    unitCharges: [...normal.unitCharges, ...maxi.unitCharges],
    maxFees: [...normal.maxFees, ...maxi.maxFees],
    sourceUrl: detailUrl(id),
  };
}
