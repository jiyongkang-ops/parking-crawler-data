// エコロパーク（エコロシティ / service.ecolocity.co.jp）詳細ページのパーサ ---
// 料金はサーバ描画の静的HTML。基本情報テーブル（c-table）の各セルに th/td 対で入る。
//   台数 → 収容台数、料金 → <br>区切りで料金行（多くは「最大」料金）。
//   住所は地図iframeの q= パラメータから取得（詳細ページに住所行が無いため）。
// robots.txt は制限なし（空）。列挙は先方のサイトマップ（ecolo-enumerate）。
// 閉じた物件は 404 ではなく 301 でトップへ転送される（run.js の goneOnRedirect で閉鎖として扱う）。

const BASE = "https://service.ecolocity.co.jp/park/coin-parking/";

export function detailUrl(id) {
  return `${BASE}${id}/`;
}

/** 物件ページを取ったときの転送が「閉鎖（掲載終了）」か。
 *  閉じた物件は 301 で / や /park/ へ飛ばされる（2026-10-18 に 6672→/、9345→/park/ を確認）。
 *  別の物件ページへの転送や、転送先が無いときは閉鎖と決めつけない（番号の付け替えやサイトの引っ越しで
 *  全件を寝かせないため） */
export function isClosedRedirect(location) {
  return !!location && !/\/coin-parking\/\d+\/?(\?|$)/.test(location);
}

function cellText(html, thLabel) {
  const re = new RegExp(`<th>\\s*${thLabel}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

function parseFeeLine(line) {
  const text = line.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const am = text.match(/([\d,]+)\s*円/);
  if (!am) return null;
  const amountYen = Number(am[1].replace(/,/g, ""));
  // 単位料金（N分 M円）
  const um = text.match(/(\d+)\s*分\s*[\/／]?\s*([\d,]+)\s*円/);
  if (um) {
    const pre = text.slice(0, um.index).trim();
    return { kind: "unit", scope: pre.split(/\s+/)[0] || "全日", timeRange: pre.split(/\s+/).slice(1).join(" ") || "全日", perMinutes: Number(um[1]), amountYen: Number(um[2].replace(/,/g, "")) };
  }
  // 最大料金 or その他（金額のみ）
  const pre = text.slice(0, am.index).replace(/最大/g, " ").replace(/\s+/g, " ").trim();
  const tokens = pre.split(/\s+/).filter(Boolean);
  return { kind: "max", scope: tokens[0] || "全日", condition: tokens.slice(1).join(" "), amountYen };
}

export function parseEcoloDetail(html, { id, label } = {}) {
  // 物件ページの見出し（p-coin-parking-detail__title）が無いページは物件ではない（閉鎖でトップへ転送された等）。
  // 以前は他の見出しや <title> に逃げていたため、トップの題「コインパーキング・駐車場経営ならエコロパーク」を
  // 物件名として、料金が空の行を24件書いていた（2026-10-18）。名前を null にして記録しない
  // 見出しの書き方だけが変わったときに全件を落とさないよう、料金の欄があるページに限って他の見出しも使う
  const h1 = (html.match(/<h1[^>]*p-coin-parking-detail__title[^>]*>([\s\S]*?)<\/h1>/) || [])[1]
    ?? (cellText(html, "料金") != null ? (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] : undefined);
  const name = (h1 ? h1.replace(/<[^>]+>/g, "").trim() : "") || null;

  // 住所: 地図iframe q="{名称},{住所}"
  let address = null;
  const q = html.match(/maps\/embed[^"']*?q=([^"'&]+)/);
  if (q) {
    const dec = decodeURIComponent(q[1]);
    const am = dec.match(/([^,]*[都道府県][^,]+)$/);
    address = am ? am[1].trim() : null;
  }

  const capCell = cellText(html, "台数");
  const capacity = capCell ? Number((capCell.replace(/<[^>]+>/g, "").match(/(\d+)\s*台/) || [])[1]) || null : null;

  const unitCharges = [];
  const maxFees = [];
  const feeCell = cellText(html, "料金");
  if (feeCell) {
    for (const line of feeCell.split(/<br\s*\/?>/i)) {
      const f = parseFeeLine(line);
      if (!f) continue;
      if (f.kind === "unit") unitCharges.push({ scope: f.scope, timeRange: f.timeRange, perMinutes: f.perMinutes, amountYen: f.amountYen });
      else maxFees.push({ scope: f.scope, condition: f.condition, amountYen: f.amountYen });
    }
  }

  return {
    operator: "ecolo",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat: null,
    lng: null,
    capacity,
    openingHours: /24時間入出庫可/.test(html) ? "24時間" : null,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}
