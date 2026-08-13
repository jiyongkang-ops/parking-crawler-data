// NTTル・パルク（sasp.mapion.co.jp/b/leperc / 全国 約480件）詳細ページのパーサ
// 一覧 /b/leperc/attr/?start=N（20件/頁）。詳細 /b/leperc/info/NRPxxxxx/?type=coin
// dl.description-list: 住所 / 駐車場情報（<br>区切り: 昼 8：00～20：00 30分/100円、
//   【最大料金】駐車後12時間毎 700円、夜間最大料金（20：00-8：00） 400円、駐車台数: 31台）
// 全角数字・全角コロンが混在するため正規化してから解析する。

export function detailUrl(id) {
  return `https://sasp.mapion.co.jp/b/leperc/info/${id}/?type=coin`;
}

const z2h = (s) => (s ?? "")
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/：/g, ":").replace(/／/g, "/").replace(/（/g, "（").replace(/～/g, "～");

function dd(html, dtLabel) {
  const re = new RegExp(`<dt>\\s*${dtLabel}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

export function parseLeparcDetail(html, { id } = {}) {
  const title = (html.match(/<title>([^<|]+)/) || [])[1] || "";
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const name = ((h1 ? h1.replace(/<[^>]+>/g, "") : title).trim()) || id;
  const address = (dd(html, "住所") ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null;
  const infoRaw = dd(html, "駐車場情報") ?? "";
  const lines = infoRaw.split(/<br\s*\/?>/i).map((l) => z2h(l.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()).filter(Boolean);
  const unitCharges = [];
  const maxFees = [];
  let capacity = null;
  let inMax = false;
  for (const line of lines) {
    if (/【最大料金】/.test(line)) { inMax = true; continue; }
    const capM = line.match(/駐車台数\s*:?\s*(\d+)/);
    if (capM) { capacity = Number(capM[1]); continue; }
    const amt = line.match(/([\d,]+)\s*円/);
    if (!amt) continue;
    const amountYen = Number(amt[1].replace(/,/g, ""));
    const range = (line.match(/(\d{1,2}:\d{2})\s*[～~〜-]\s*(\d{1,2}:\d{2})/) || []);
    const timeRange = range.length ? `${range[1]}-${range[2]}` : "";
    const unit = line.match(/(\d+)\s*分\s*[\/]?\s*[\d,]+\s*円/);
    if (!inMax && unit) {
      unitCharges.push({ scope: "全日", timeRange: timeRange || "00:00-24:00", perMinutes: Number(unit[1]), amountYen });
    } else if (/最大|毎|以内/.test(line) || inMax) {
      // 例: 駐車後12時間毎 700円（繰り返しＯＫ） / 夜間最大料金（20:00-8:00） 400円
      let condition = line.replace(/([\d,]+)\s*円.*/, "").replace(/最大料金/g, "最大").trim();
      if (timeRange && !condition.includes(timeRange)) condition += ` ${timeRange}`;
      maxFees.push({ scope: "全日", condition: condition.trim(), amountYen });
    }
  }
  return { operator: "leparc", parkId: id, label: null, name, address,
    lat: null, lng: null, capacity, openingHours: null,
    unitCharges, maxFees, sourceUrl: detailUrl(id) };
}
