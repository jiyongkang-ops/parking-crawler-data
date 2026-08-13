// タマパーク（tamapark.co.jp / 町田中心 約350件）詳細ページのパーサ ------------
// 一覧 /parking/ に全物件リンク（日本語スラッグ）。詳細は WordPress ページ。
// 料金は table.p-price-table。rowspan で「料金形態（基本料金/最大料金）」「曜日」を
// まとめているため、行を上から走査して直近のセクション・曜日を引き継ぐ。
//   基本料金: [時間帯][料金][備考=N分]  例: 8：00-18：00 / 100円 / 30分
//   最大料金: [条件][料金]              例: 駐車後24時間最大 / 700円
// 台数・住所は本文の <h2>所在地</h2> と 設備テーブル（台数）から取る。

export function detailUrl(slug) {
  return `https://www.tamapark.co.jp/parking/${encodeURIComponent(slug)}/`;
}

const z2h = (s) => (s ?? "")
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/：/g, ":").replace(/～/g, "~");
const txt = (s) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

export function parseTamaparkDetail(html, { id } = {}) {
  // h1 は会社名（株式会社タマパーク）が入るため、title の「｜」より前を物件名とする
  const title = (html.match(/<title>([^<|｜]+)/) || [])[1] || "";
  const name = title.trim() || txt((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]) || String(id);
  const addrM = html.match(/<h2>\s*所在地\s*<\/h2>\s*<p>([\s\S]*?)<\/p>/);
  const address = addrM ? txt(addrM[1]) : null;
  const capM = html.match(/台数\s*<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/);
  const capacity = capM ? Number((txt(capM[1]).match(/(\d+)/) || [])[1]) || null : null;

  const unitCharges = [];
  const maxFees = [];
  const tbl = html.match(/<table class="[^"]*p-price-table[^"]*">([\s\S]*?)<\/table>/);
  if (tbl) {
    let section = null, scope = "全日";
    for (const row of tbl[1].split(/<tr>/).slice(1)) {
      const secM = row.match(/<th[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/);
      if (secM) section = txt(secM[1]);
      const wk = row.match(/<span class="p-week">([\s\S]*?)<\/span>/);
      if (wk && txt(wk[1])) scope = txt(wk[1]);
      // 曜日セル（p-week を含む td）を除いた実データ列
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)]
        .map((m) => m[1]).filter((c) => !/p-week/.test(c)).map((c) => z2h(txt(c)));
      if (!cells.length || cells.every((c) => !c)) continue;
      if (section === "基本料金") {
        const [range, fee, unit] = cells;
        const amt = Number((String(fee).match(/([\d,]+)/) || [])[1]?.replace(/,/g, ""));
        const per = Number((String(unit).match(/(\d+)\s*分/) || [])[1]);
        if (amt && per) {
          const rg = String(range).match(/(\d{1,2}:\d{2})\s*[-~〜]\s*(\d{1,2}:\d{2})/);
          unitCharges.push({ scope, timeRange: rg ? `${rg[1]}-${rg[2]}` : "00:00-24:00", perMinutes: per, amountYen: amt });
        } else if (amt && range) {
          // 単位（N分）が無い定額型（例: 駐車後2時間まで 400円）は打切り料金として扱う
          maxFees.push({ scope, condition: String(range), amountYen: amt });
        }
      } else if (section === "最大料金") {
        const [cond, fee] = cells;
        const amt = Number((String(fee).match(/([\d,]+)/) || [])[1]?.replace(/,/g, ""));
        if (amt && cond) maxFees.push({ scope, condition: String(cond), amountYen: amt });
      }
    }
  }
  return { operator: "tamapark", parkId: String(id), label: null, name, address,
    lat: null, lng: null, capacity, openingHours: null,
    unitCharges, maxFees, sourceUrl: detailUrl(id) };
}
