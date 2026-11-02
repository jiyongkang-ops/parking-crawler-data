// 東洋カーマックス（carmax-parking.jp）詳細ページのパーサ ----------------------------------------------------
// 一覧（/search/aN/pf0/…/pM/。関東・中部・近畿・四国で約1,170件）から /detail/<管理番号>/ を集め（carmax-enumerate.js）、
// 詳細ページを1件ずつ取る。詳細は <table class="s_clear"> の th/td 対に 駐車場名 / 収容台数 / 住所 / クレジット / 料金 があり、
// 座標は地図の iframe（maps.google.com/?q=緯度,経度）にある。サイトは http だけ。/detail/1NU は 301 で /detail/1NU/ に飛ぶので、
// 末尾の / を付けて取る（付けないと毎回1回余分に取る）。robots.txt は「Disallow:」（空）で全部許可（2026-11-01 確認）。
//
// 料金欄の例:
//   【最大料金】<br />(全日) 入庫後3時間以内 ￥600 <br /><br />【通常料金】<br />(全日) 00:00-24:00 ￥200 20分
//   【最大料金】<br />(土日祝) 昼間最大8：00-20：00 ￥1000 ※繰り返しあり<br />(全日) 夜間最大20：00-翌8：00 ￥200 …
//   【通常料金】<br />(月-金) 08:00-15:00 ￥300 30分 <br />15:00-20:00 ￥100 30分 <br />(土日祝) 08:00-20:00 ￥100 20分 <br />(夜間) 20:00-08:00 ￥100 60分
// 金額が先（「￥200 20分」）・曜日の区分が「(月-金)」のかっこ書きで、共通の parseFeeBlock（jp-fee-text.js）にそのまま渡すと
// 単価も上限も1つも読めない（2026-11-01 見直し）。ここで「【月-金】08:00-15:00 30分300円」の形に直してから渡す（normalizeCarmaxFee）。

import { parseFeeBlock } from "./jp-fee-text.js";
import { decodeEntities } from "./zenkaku.js";

const BASE = "http://www.carmax-parking.jp";

export function detailUrl(id) {
  return `${BASE}/detail/${id}/`;
}

// 二輪・自転車の言葉（名前・料金の行）
export const BIKE = /駐輪|自転車|原付|原動機|バイク|二輪|サイクル/;

const text = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " "))
  .normalize("NFKC").replace(/[〜∼]/g, "~").replace(/\s+/g, " ").trim();
// 名前・住所の半角カナ（「ODD江戸堀ﾊﾟｰｷﾝｸﾞ」「大阪ｼﾃｨ信金」）だけを全角にする。ほかの文字は書かれたまま
export const fullKana = (s) => String(s ?? "").replace(/[\uFF61-\uFF9F]+/g, (m) => m.normalize("NFKC"));

// セルの文字（タグを落とし、実体参照を戻して空白を畳む。半角カナだけ全角）。無ければ null
const plain = (h) => (h == null ? null : fullKana(decodeEntities(h.replace(/<[^>]+>/g, " ")).replace(/[\s　]+/g, " ").trim()) || null);

function cell(html, th) {
  const m = html.match(new RegExp(`<th>\\s*${th}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : null;
}

// 行頭の「(月-金)」「(全日(一般))」→ 区分の見出し。中の言葉で次のように扱う（2026-11-02）
//   「夜間」「昼間」「全日夜間」… 曜日ではなく時間帯の名前なので、区分は全日にして名前は行に残す
//   「全日(一般)」… 一般の利用者の料金。全日とする
//   「全日(外来)」「全日(お見舞い)」… 病院の駐車場の特別な人の料金。相場に使わないので、次の見出しまで読み飛ばす
const HEAD = /^\(([^()]*(?:\([^()]*\)[^()]*)*)\)\s*/;
function headOf(inner) {
  const sub = inner.match(/\(([^()]*)\)/);
  const base = inner.replace(/\([^()]*\)/g, "").trim();
  if (sub && !/一般/.test(sub[1])) return { skip: true };
  const band = base.match(/^(全日)?(夜間|昼間)$/);
  if (band) return { scope: "全日", prefix: band[2] };
  return { scope: base || "全日", prefix: "" };
}

/** 料金欄（<th>料金</th> の <td> の中身）→ parseFeeBlock に渡す行（<br> 区切り） */
export function normalizeCarmaxFee(html) {
  const out = [];
  let skip = false;       // 特別な人の区分（外来・お見舞い）を読み飛ばし中
  let dropNext = false;   // 「左:車/右:バイク」の行の次の行（バイクの料金）を捨てる
  for (const raw of String(html ?? "").split(/<br\s*\/?\s*>/i)) {
    let t = text(raw);
    if (!t || /^※/.test(t)) continue;
    // 料金の種類の見出し（【最大料金】【通常料金】）はそのまま。読み飛ばしも終える
    if (/^【[^】]*】$/.test(t)) { out.push(t); skip = false; dropNext = false; continue; }
    const hd = t.match(HEAD);
    if (hd) {
      const h = headOf(hd[1]);
      t = t.slice(hd[0].length).trim();
      if (h.skip) { skip = true; continue; }
      skip = false;
      t = `【${h.scope}】${h.prefix ? `${h.prefix} ` : ""}${t}`;
    } else if (dropNext) { dropNext = false; continue; }
    if (skip) continue;
    // 「左:車/右:バイク 00:00-24:00 ￥500 60分」の次の行はバイクの料金
    if (/左\s*:\s*車\s*\/\s*右\s*:\s*バイク/.test(t)) { dropNext = true; t = t.replace(/左\s*:\s*車\s*\/\s*右\s*:\s*バイク/, " "); }
    if (BIKE.test(t)) continue;
    t = t.replace(/※\s*(?:く|繰)り返しあり/g, " ").replace(/(【[^】]*】)\s*車\s+/, "$1");
    // 「20:00-翌8:00」の「翌」を外す（extractTimeRange が読めるように）
    t = t.replace(/(\d{1,2}:\d{2})\s*[-~]\s*翌\s*(\d{1,2}:\d{2})/g, "$1-$2");
    // 金額が先の単価「￥200 20分」「￥200/20分」「￥200 1時間」→「20分200円」
    t = t.replace(/[¥￥\\]\s*([\d,]+)\s*\/?\s*(\d+)\s*分/g, "$2分$1円");
    t = t.replace(/[¥￥\\]\s*([\d,]+)\s*\/?\s*(\d+)\s*時間/g, (_, y, h) => `${+h * 60}分${y}円`);
    t = t.replace(/[¥￥\\]\s*([\d,]+)/g, "$1円");
    // 「09:00-15:00/15:00-22:00 200円 60分」は2つの時間帯に同じ単価。行を2つに分ける
    const two = t.match(/^(【[^】]*】)?\s*(\d{1,2}:\d{2}-\d{1,2}:\d{2})\s*\/\s*(\d{1,2}:\d{2}-\d{1,2}:\d{2})\s+(.*)$/);
    if (two) { out.push(`${two[1] ?? ""}${two[2]} ${two[4]}`, `${two[3]} ${two[4]}`); continue; }
    out.push(t.replace(/\s+/g, " ").trim());
  }
  return out.join("<br>");
}

export function parseCarmaxFee(html) {
  return parseFeeBlock(normalizeCarmaxFee(html));
}

/** 記録しない物件の理由（2026-11-02）。記録するなら null
 *  ・駐輪場・バイク（一覧の段階でも外すが、名前が変わったときのため）
 *  ・近日オープン
 *  ・時間貸しの料金の文が無い（月極だけ・料金の欄が空）。料金の無い物件を記録すると、Advisor が同じ名前の料金つきの Parkopedia の物件を落とす */
export function excludeReason({ name, feeText, unitCharges }) {
  if (BIKE.test(name ?? "")) return "駐輪場・バイク";
  if (/近日|オープン予定|OPEN予定|開業予定|準備中/i.test(`${name ?? ""} ${feeText ?? ""}`)) return "近日オープン";
  if (!unitCharges.length) return /月極/.test(feeText ?? "") ? "月極だけ" : "時間貸しの料金の文が無い";
  return null;
}

/** 詳細ページ → 正規化レコード。記録しない物件は { operator, parkId, name, excluded: 理由 } を返す（run.js が記録せずに数える） */
export function parseCarmaxDetail(html, { id, label } = {}) {
  const name = plain(cell(html, "駐車場名"));
  const address = plain(cell(html, "住所"));
  const capCell = cell(html, "収容台数");
  const capacity = capCell ? Number((text(capCell).match(/(\d+)/) || [])[1]) || null : null;
  let lat = null, lng = null;
  const q = html.match(/maps\.google\.com\/\?q=(-?[\d.]+),\s*(-?[\d.]+)/);
  if (q) { lat = Number(q[1]); lng = Number(q[2]); }
  const feeCell = cell(html, "料金");
  const { unitCharges, maxFees } = feeCell ? parseCarmaxFee(feeCell) : { unitCharges: [], maxFees: [] };
  const excluded = name ? excludeReason({ name, feeText: feeCell ? text(feeCell) : "", unitCharges }) : null;
  if (excluded) return { operator: "carmax", parkId: String(id), name, excluded };
  return {
    operator: "carmax",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat,
    lng,
    capacity,
    openingHours: null, // 入出庫の時間の欄は無い
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(id),
  };
}
