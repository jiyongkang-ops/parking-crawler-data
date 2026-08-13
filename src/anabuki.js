// あなぶきパーク（穴吹ハウジングサービス）詳細ページのパーサ -----------------
// https://www.anabuki-housing.co.jp/park/hourly/entry-{id}.html
// 料金・住所ともサーバ描画の静的HTML。詳細ページ内の
//   <table class="SearchContents-List_Head-Table"> の th/td 対に
//   住所 / 営業時間 / 収容台数 / 形態 / 料金 / 打ち切り料金 / その他 が入る。
// 料金は「20分/100円（8：00～20：00）」、打ち切り料金は
//   「平日昼間最大（8：00～20：00）900円打ち切り（繰り返し）」形式（全角混じり）。
// robots.txt は Allow: / のみ（制限なし）。apex ドメインに A レコードが無いため
// 必ず www 付きで参照すること。

import { linesOf, scopeOf, textOf, timeRangeOf, toHalfWidth, yen } from "./zenkaku.js";

const BASE = "https://www.anabuki-housing.co.jp/park/hourly/";

export function detailUrl(id) {
  return `${BASE}entry-${id}.html`;
}

function cell(html, label) {
  const re = new RegExp(
    `<th[^>]*SearchContents-List_Head-Table_Head[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

// 「20分/100円（8:00~20:00）」→ unitCharge。平日/土日祝の接頭辞にも対応。
function parseUnitLine(line) {
  const t = toHalfWidth(line);
  const m = t.match(/(\d+)\s*分\s*[\/]\s*([\d,]+)\s*円/);
  if (!m) return null;
  return {
    scope: scopeOf(t),
    timeRange: timeRangeOf(t) ?? "全日",
    perMinutes: Number(m[1]),
    amountYen: yen(m[2]),
  };
}

// 「平日昼間最大（8:00~20:00）900円打ち切り（繰り返し）」→ maxFee。
function parseMaxLine(line) {
  const t = toHalfWidth(line);
  const m = t.match(/([\d,]+)\s*円/);
  if (!m) return null;
  const scope = scopeOf(t);
  // 金額より前を条件文とし、曜日区分の語だけ落とす（時間帯表記は残す）。
  const tr = timeRangeOf(t);
  let condition = t
    .slice(0, m.index)
    .replace(/平日|土日祝|土・日・祝|日祝|土日/g, "")
    .replace(/[()]/g, " ")
    .replace(/\d{1,2}:\d{2}\s*[~\-]\s*\d{1,2}:\d{2}/, tr ?? "") // 時間帯表記を正規形へ
    .replace(/\s+/g, " ")
    .trim();
  if (tr && !/\d{1,2}:\d{2}-\d{1,2}:\d{2}/.test(condition)) condition = `${condition} ${tr}`.trim();
  return { scope, condition: condition || "最大", amountYen: yen(m[1]) };
}

export function parseAnabukiDetail(html, { id, label } = {}) {
  // 名称: <h2 class="...Headline"> の中の <span class="...Label">都道府県</span> を除いた部分
  const h2 = (html.match(/<h2[^>]*SearchContents-List_Head_Headline"[^>]*>([\s\S]*?)<\/h2>/) || [])[1];
  let name = null;
  if (h2) {
    name = textOf(h2.replace(/<span[^>]*Headline_Label[^>]*>[\s\S]*?<\/span>/, ""));
  }
  if (!name) {
    const title = (html.match(/<title>([^<]*)/) || [])[1] || "";
    name = textOf(title.split("|")[0]) || null;
  }

  const address = textOf(cell(html, "住所")) || null;
  const openingHours = textOf(cell(html, "営業時間")) || null;
  const capText = textOf(cell(html, "収容台数"));
  const capacity = capText ? Number((capText.match(/(\d+)\s*台/) || [])[1]) || null : null;

  const unitCharges = [];
  for (const line of linesOf(cell(html, "料金"))) {
    const u = parseUnitLine(line);
    if (u) unitCharges.push(u);
  }

  const maxFees = [];
  for (const line of linesOf(cell(html, "打ち切り料金"))) {
    const f = parseMaxLine(line);
    if (f) maxFees.push(f);
  }
  // 「料金」欄に最大料金が混ざる物件もあるので拾っておく（単価行は除く）。
  for (const line of linesOf(cell(html, "料金"))) {
    if (parseUnitLine(line)) continue;
    if (!/最大|打ち切り|24時間/.test(line)) continue;
    const f = parseMaxLine(line);
    if (f) maxFees.push(f);
  }

  return {
    operator: "anabuki",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat: null,
    lng: null,
    capacity,
    openingHours,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}
