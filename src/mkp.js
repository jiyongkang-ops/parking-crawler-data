// 名鉄協商パーキング（mkp.jp）詳細ページのパーサ ---------------------------
// 料金はサーバ描画の静的HTML。名称・住所・緯度経度は JSON-LD(ParkingFacility)、
// 料金は .box_price 内の table.tbl_basic から取得する。
//   ヘッダ列: 最大料金 / 通常料金（駐輪場は 一時料金 / 一時料金(1日)）
//   1セルに複数の <p> が入りうる（例: 入庫より24時間まで600円 / 12時間まで500円）
// robots.txt は /admin//batch//config/ のみ禁止で、詳細ページは許可。

import * as cheerio from "cheerio";

const BASE = "https://mkp.jp/search/detail/";

export function detailUrl(id) {
  return `${BASE}${id}`;
}

function extractLd(html) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const o = JSON.parse(m[1]);
      if (o && o["@type"] === "ParkingFacility") return o;
    } catch { /* skip */ }
  }
  return null;
}

// 列ヘッダから「最大料金列」かどうかを判定
function isMaxHeader(th) {
  return /最大/.test(th) || /1日|１日/.test(th);
}

// <p>テキストから時間帯単価を抽出： "00:00 - 24:00 40分 200円"
function parseUnit(text) {
  const m = text.match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(\d+)\s*分\s*([\d,]+)\s*円/);
  if (!m) return null;
  return {
    timeRange: `${m[1]}-${m[2]}`,
    perMinutes: Number(m[3]),
    amountYen: Number(m[4].replace(/,/g, "")),
  };
}

// <p>テキストから最大料金を抽出： "入庫より24時間まで 600円"
function parseMax(text) {
  const m = text.match(/(.+?)\s*([\d,]+)\s*円/);
  if (!m) return null;
  return {
    condition: m[1].trim(),
    amountYen: Number(m[2].replace(/,/g, "")),
  };
}

export function parseMkpDetail(html, { id, label } = {}) {
  const $ = cheerio.load(html);
  const ld = extractLd(html);

  const name = ld?.name ?? ($("h1").first().text().trim() || null);
  const addr = ld?.address ?? {};
  const address = addr.streetAddress || [addr.addressRegion, addr.addressLocality].filter(Boolean).join("") || null;

  const unitCharges = [];
  const maxFees = [];

  const table = $(".box_price table.tbl_basic").first();
  // ヘッダ列の種別（index → "max" | "unit"）
  const colType = [];
  table.find("tr").first().find("th").each((i, th) => {
    colType[i] = isMaxHeader($(th).text()) ? "max" : "unit";
  });

  table.find("tr").slice(1).each((_, tr) => {
    const tds = $(tr).find("td");
    const scope = $(tds[0]).text().trim() || "全日";
    tds.each((ci, td) => {
      if (ci === 0) return; // 先頭は曜日区分
      const type = colType[ci] ?? "unit";
      $(td).find("p").each((__, p) => {
        const text = $(p).text().replace(/\s+/g, " ").trim();
        if (!text) return;
        if (type === "unit") {
          const u = parseUnit(text);
          if (u) unitCharges.push({ scope, ...u });
        } else {
          const mx = parseMax(text);
          if (mx) maxFees.push({ scope, ...mx });
        }
      });
    });
  });

  return {
    operator: "mkp",
    parkId: id,
    label: label ?? null,
    name,
    address,
    lat: ld?.geo?.latitude ?? null,
    lng: ld?.geo?.longitude ?? null,
    capacity: null, // 名鉄協商は収容台数を静的に出していない
    openingHours: ld?.openinghours ?? null,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}
