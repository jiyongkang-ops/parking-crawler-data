// ナビパーク（スターツアメニティー / navipark1.com）詳細ページのパーサ ------
// 料金はサーバ描画の静的HTML。table.table05（列: 料金体系 / 時間帯 / 単位・金額 / 備考）。
//   通常料金:  料金体系="全曜日" 等、時間帯="8:00 ～ 22:00"、単位金額="60分 / 300円"
//   最大料金:  料金体系に「最大」を含む（例: ２４時間最大（全曜日）／夜間最大（全曜日））
// robots.txt は無し（404）。sitemap も無いため、エリア階層を辿って列挙する（navipark-enumerate）。

import * as cheerio from "cheerio";

const BASE = "https://www.navipark1.com/parkingDetail/";

export function detailUrl(code) {
  return `${BASE}${code}.html`;
}

// 料金体系テキストから曜日区分を拾う（全曜日/平日/土日祝 等）
function scopeOf(keihou) {
  const m = keihou.match(/[（(]([^）)]+)[)）]/);
  const base = m ? m[1] : keihou;
  if (/全曜日|全日|終日/.test(base)) return "全曜日";
  if (/平日|月|火|水|木|金/.test(base)) return "平日";
  if (/土|日|祝/.test(base)) return "土日祝";
  return base.trim() || "全曜日";
}

export function parseNaviparkDetail(html, { code, label } = {}) {
  const $ = cheerio.load(html);

  const title = ($("title").first().text() || "").split("｜")[0].trim();
  const name = title || null;

  // 所在地
  let address = null;
  $("th,td").each((_, el) => {
    if (address) return;
    if (/所在地|住所/.test($(el).text())) {
      const v = $(el).next().text().replace(/\s+/g, " ").trim();
      if (v) address = v;
    }
  });
  if (!address) {
    const m = html.match(/所在地[\s\S]{0,40}?([都道府県　-鿿0-9０-９\-－]{4,40})/);
    address = m ? m[1].trim() : null;
  }

  const unitCharges = [];
  const maxFees = [];
  $("table.table05 tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length < 3) return; // ヘッダや備考(colspan)行を除外
    const keihou = $(tds[0]).text().replace(/\s+/g, " ").trim();
    const jikan = $(tds[1]).text().replace(/\s+/g, "").trim(); // 8:00～22:00
    const kingaku = $(tds[2]).text().replace(/\s+/g, " ").trim();
    if (!keihou && !kingaku) return;

    if (/最大/.test(keihou)) {
      const am = kingaku.match(/([\d,]+)\s*円/);
      if (am) {
        maxFees.push({
          scope: scopeOf(keihou),
          condition: [keihou.replace(/[（(][^）)]*[)）]/, "").trim(), jikan].filter(Boolean).join(" ").trim(),
          amountYen: Number(am[1].replace(/,/g, "")),
        });
      }
    } else {
      const um = kingaku.match(/(\d+)\s*分\s*\/\s*([\d,]+)\s*円/);
      if (um) {
        unitCharges.push({
          scope: scopeOf(keihou),
          timeRange: jikan.replace(/～/, "-") || "全日",
          perMinutes: Number(um[1]),
          amountYen: Number(um[2].replace(/,/g, "")),
        });
      }
    }
  });

  return {
    operator: "navipark",
    parkId: code,
    label: label ?? null,
    name,
    address,
    lat: null, // 静的HTMLに座標なし（必要時に住所からジオコーディング）
    lng: null,
    capacity: null,
    openingHours: null,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(code),
  };
}
