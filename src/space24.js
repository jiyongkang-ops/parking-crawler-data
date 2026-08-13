// スペース二十四（space24.co.jp / 全国 約1,500件）詳細ページのパーサ ----------
// 一覧 /parkings?page=1..150（10件/頁）に詳細リンク。詳細 /parkings/detail/{id}。
// 詳細は table.map-data-table（駐車場名 / 住所 / 収容台数 / 駐車料金）。
// 駐車料金は「（月～金）」等のスコープ見出し＋<br>区切りの明細:
//   08:00～19:00 10分100円 時間内最大1100円
// 「時間内最大」はその時間帯に閉じた最大料金なので condition に時間帯を残す。

const BASE = "https://space24.co.jp";

export function detailUrl(id) {
  return `${BASE}/parkings/detail/${id}`;
}

const z2h = (s) => (s ?? "")
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/：/g, ":").replace(/～/g, "～");

function cell(html, thLabel) {
  const re = new RegExp(`<th>\\s*${thLabel}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

export function parseSpace24Detail(html, { id } = {}) {
  const nameRaw = cell(html, "駐車場名");
  const name = nameRaw ? nameRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  const addrRaw = cell(html, "住所");
  const address = addrRaw ? addrRaw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
  const capRaw = cell(html, "収容台数");
  const capacity = capRaw ? Number((capRaw.match(/(\d+)/) || [])[1]) || null : null;

  const unitCharges = [];
  const maxFees = [];
  const feeRaw = cell(html, "駐車料金") ?? "";
  let scope = "全日";
  for (const seg of feeRaw.split(/<br\s*\/?>/i)) {
    const line = z2h(seg.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    if (!line) continue;
    // スコープ見出し（（月～金）など。行が括弧のみで構成される場合）
    const sc = line.match(/^[（(]([^）)]+)[）)]$/);
    if (sc) { scope = sc[1].trim(); continue; }
    // 時間帯
    const rg = line.match(/(\d{1,2}:\d{2})\s*[～~〜-]\s*(\d{1,2}:\d{2})/);
    const timeRange = rg ? `${rg[1]}-${rg[2]}` : "00:00-24:00";
    // 単価（N分M円）
    const unit = line.match(/(\d+)\s*分\s*([\d,]+)\s*円/);
    if (unit) unitCharges.push({ scope, timeRange, perMinutes: Number(unit[1]), amountYen: Number(unit[2].replace(/,/g, "")) });
    // 最大料金（時間内最大X円 / 最大X円 / 24時間最大X円）
    const mx = line.match(/(?:時間内)?最大\s*([\d,]+)\s*円/);
    if (mx) {
      const cond = /時間内最大/.test(line) && rg ? `時間内最大 ${timeRange}` : "最大";
      maxFees.push({ scope, condition: cond, amountYen: Number(mx[1].replace(/,/g, "")) });
    }
  }
  return { operator: "space24", parkId: String(id), label: null, name, address,
    lat: null, lng: null, capacity, openingHours: null,
    unitCharges, maxFees, sourceUrl: detailUrl(id) };
}
