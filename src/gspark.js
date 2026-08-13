// GSパーク（gs-park.com）エリア一覧ページのパーサ ------------------------------
// /time_parking/ にエリアコード（e0101等）一覧。/time_parking_lists/area_cd/{code}(/page/N/) に
// 物件が table.result_list で直接掲載（名称・所在地・料金）。詳細ページ巡回は不要。
// parkId は物件リンク /time_parking/{id}/ の id。robots.txt 制限なし。

const BASE = "https://www.gs-park.com";

export function areaListUrl(code, page = 1) {
  return page > 1 ? `${BASE}/time_parking_lists/area_cd/${code}/page/${page}/` : `${BASE}/time_parking_lists/area_cd/${code}`;
}

// 一覧HTML → 物件レコード配列 ＋ 次ページ有無
export function parseGsparkList(html) {
  const records = [];
  const tables = html.split(/<table class="result_list">/).slice(1);
  for (const chunk of tables) {
    const link = chunk.match(/href="https?:\/\/www\.gs-park\.com\/time_parking\/([^"\/]+)\/?"[^>]*>([\s\S]*?)</);
    if (!link) continue;
    const parkId = link[1];
    const name = link[2].replace(/<[^>]+>/g, "").trim();
    const addr = chunk.match(/<th>\s*所在地\s*<\/th>\s*<td>([\s\S]*?)<\/td>/);
    const address = addr ? addr[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
    const unitCharges = [];
    const maxFees = [];
    // 【scope】ブロックごとに dl（時間割料金 / 最大料金）
    const feeTd = chunk.match(/time_price_box[\s\S]*?<td>([\s\S]*?)<\/td>/);
    if (feeTd) {
      const blocks = feeTd[1].split(/<p>/).slice(1);
      for (const b of blocks) {
        const scope = (b.match(/【([^】]+)】/) || [, "全日"])[1];
        // 時間割料金
        const unitSec = b.match(/時間割料金[\s\S]*?<ul>([\s\S]*?)<\/ul>/);
        if (unitSec) for (const li of unitSec[1].split(/<li>/).slice(1)) {
          const t = li.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          const m = t.match(/(\d{1,2}:\d{2})\s*[〜~～-]\s*(\d{1,2}:\d{2})\s*(\d+)\s*分\s*([\d,]+)\s*円/);
          if (m) unitCharges.push({ scope, timeRange: `${m[1]}-${m[2]}`, perMinutes: Number(m[3]), amountYen: Number(m[4].replace(/,/g, "")) });
        }
        // 最大料金
        const maxSec = b.match(/最大料金[\s\S]*?<ul>([\s\S]*?)<\/ul>/);
        if (maxSec) for (const li of maxSec[1].split(/<li>/).slice(1)) {
          const t = li.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
          const m = t.match(/^(.*?)\s*([\d,]+)\s*円/);
          if (m) maxFees.push({ scope, condition: m[1].trim() || "最大", amountYen: Number(m[2].replace(/,/g, "")) });
        }
      }
    }
    records.push({ operator: "gspark", parkId, label: null, name, address,
      lat: null, lng: null, capacity: null, openingHours: null,
      unitCharges, maxFees, sourceUrl: `${BASE}/time_parking/${parkId}/` });
  }
  const hasNext = /class="next page-numbers"/.test(html);
  return { records, hasNext };
}

// /time_parking/ からエリアコード一覧
export function parseAreaCodes(html) {
  return [...new Set([...html.matchAll(/\/time_parking_lists\/area_cd\/([a-z]\d+)/g)].map((m) => m[1]))].sort();
}
