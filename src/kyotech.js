// キョウテク（kte.ne.jp / 京都・大阪中心 約750件）詳細ページのパーサ ---------
// 一覧 https://kte.ne.jp/parking/ に全物件のリンク（スラッグURL）が載る。
// 詳細: dl.page-info（住所/営業時間/時間貸自動車収容台数）＋ price-list
//   （price-list-title=昼間料金/夜間料金/最大料金、column: sales=時間帯, time=N分, cost=M円）
// robots.txt 制限なし。

export function detailUrl(id) {
  return `https://kte.ne.jp/parking/${encodeURIComponent(id)}/`;
}

function dd(html, dtLabel) {
  const re = new RegExp(`<dt>\\s*${dtLabel}\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>`);
  const m = html.match(re);
  return m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : null;
}

export function parseKyotechDetail(html, { id } = {}) {
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const title = (html.match(/<title>([^<|]+)/) || [])[1] || "";
  const name = (h1 ? h1.replace(/<[^>]+>/g, "").trim() : title.trim()) || id || null;
  const address = dd(html, "住所");
  const capText = dd(html, "時間貸自動車収容台数");
  const capacity = capText ? Number((capText.match(/(\d+)/) || [])[1]) || null : null;

  const unitCharges = [];
  const maxFees = [];
  // price-list-title と続く price-list-column を対で読む
  const re = /price-list-title"?>([\s\S]*?)<\/div>\s*<div class="price-list-column">([\s\S]*?)<\/div>\s*<\/div>|price-list-title"?>([\s\S]*?)<\/div>\s*<div class="price-list-column">([\s\S]*?)(?=<div class="price-list-title|<\/div>\s*<\/div>)/g;
  // シンプルに: title と column を順に並べて対応づける
  const titles = [...html.matchAll(/price-list-title[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
  const columns = [...html.matchAll(/price-list-column[^>]*>([\s\S]*?)(?=<div class="price-list-title|<\/div>\s*(?:<div class="price-list-haed|<\/div>))/g)]
    .map((m) => m[1]);
  for (let i = 0; i < Math.min(titles.length, columns.length); i++) {
    const label = titles[i];
    const col = columns[i].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const range = (col.match(/(\d{1,2}:\d{2}\s*[～~〜-]\s*\d{1,2}:\d{2})/) || [])[1] || "";
    const timeRange = range.replace(/[～~〜]/g, "-").replace(/\s+/g, "");
    const per = col.match(/(\d+)\s*分/);
    const amt = col.match(/([\d,]+)\s*円/);
    if (!amt) continue;
    const amountYen = Number(amt[1].replace(/,/g, ""));
    if (/最大/.test(label)) {
      maxFees.push({ scope: "全日", condition: `${label}${timeRange ? " " + timeRange : ""}`.trim(), amountYen });
    } else if (per) {
      unitCharges.push({ scope: "全日", timeRange: timeRange || "00:00-24:00", perMinutes: Number(per[1]), amountYen });
    } else {
      // 「1回 500円」等はその他扱い（最大として保持）
      maxFees.push({ scope: "全日", condition: `${label} ${col.replace(amt[0], "").trim()}`.trim(), amountYen });
    }
  }
  return { operator: "kyotech", parkId: id, label: null, name, address,
    lat: null, lng: null, capacity, openingHours: dd(html, "営業時間"),
    unitCharges, maxFees, sourceUrl: detailUrl(id) };
}
