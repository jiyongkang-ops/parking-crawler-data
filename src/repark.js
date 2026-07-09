// 三井のリパーク 詳細ページのパーサ ---------------------------------------
// サーバ描画される以下を利用する（堅牢な順に）：
//  1) JSON-LD <script type="application/ld+json"> の ParkingFacility
//     → 名称・住所・緯度経度・収容台数・営業時間・最大料金テキスト
//  2) <p class="unit-inner-quarter-charge"> / -note の対 → 時間帯別の単価

import * as cheerio from "cheerio";

const DETAIL_BASE = "https://www.repark.jp/parking_user/time/result/detail/";

export function detailUrl(parkId) {
  return `${DETAIL_BASE}?park=${encodeURIComponent(parkId)}`;
}

function extractParkingFacilityLd(html) {
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const obj = JSON.parse(m[1]);
      if (obj && obj["@type"] === "ParkingFacility") return obj;
    } catch {
      /* 壊れた JSON-LD は無視 */
    }
  }
  return null;
}

// description テキストから最大料金の記述を拾う。
// 例: "最大料金【全日】20:00～8:00以内 最大料金500円【全日】最大料金入庫後24時間以内1400円"
function parseMaxFees(description) {
  if (!description) return [];
  const fees = [];
  // 【…】 区切りごとに「…N円」を拾う
  const re = /【([^】]+)】([^【]*?)(\d[\d,]*)\s*円/g;
  let m;
  while ((m = re.exec(description))) {
    fees.push({
      scope: m[1].trim(), // 例: 全日 / 月～金 / 土日祝
      condition: m[2].replace(/最大料金/g, "").trim(), // 例: 20:00～8:00以内
      amountYen: Number(m[3].replace(/,/g, "")),
    });
  }
  return fees;
}

// 時間帯別の単価（"08:00-20:00" → "20分/220円"）
function parseUnitCharges($) {
  const units = [];
  const ranges = $(".unit-inner-quarter-charge");
  ranges.each((_, el) => {
    const $el = $(el);
    const timeRange = $el.text().trim();
    // 直後の note 要素が料金
    const note = $el.nextAll(".unit-inner-quarter-charge-note").first().text().trim();
    const fm = note.match(/(\d+)\s*分\s*\/\s*(\d[\d,]*)\s*円/);
    if (timeRange && fm) {
      units.push({
        timeRange, // 例: 08:00-20:00
        perMinutes: Number(fm[1]),
        amountYen: Number(fm[2].replace(/,/g, "")),
      });
    }
  });
  return units;
}

// パース本体。戻り値は保存用の正規化レコード（operator 横断の共通スキーマ）。
export function parseReparkDetail(html, { parkId, label } = {}) {
  const $ = cheerio.load(html);
  const ld = extractParkingFacilityLd(html);

  const name = ld?.name ?? ($("h1").first().text().trim() || null);
  const addr = ld?.address ?? {};
  const address = [addr.addressRegion, addr.addressLocality, addr.streetAddress]
    .filter(Boolean)
    .join("");
  const capacity = ld?.maximumAttendeeCapacity
    ? Number(String(ld.maximumAttendeeCapacity).replace(/[^\d]/g, "")) || null
    : null;

  return {
    operator: "repark",
    parkId,
    label: label ?? null,
    name,
    address: address || null,
    lat: ld?.geo?.latitude ?? null,
    lng: ld?.geo?.longitude ?? null,
    capacity,
    openingHours: ld?.openingHours ?? null,
    unitCharges: parseUnitCharges($), // 時間帯別 単価
    maxFees: parseMaxFees(ld?.description), // 最大料金
    sourceUrl: detailUrl(parkId),
  };
}
