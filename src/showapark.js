// ショウワパーク（ショウワ電技研 shouwapark.co.jp）詳細ページのパーサ（2026-11-02） --------
// WordPress。物件は /parking_detail/{番号}/ 。表の th/td 対に 収容台数 / 基本料金 / 最大料金 が入る。
//   基本料金: <p>ごとに「全日&nbsp;0:00～24:00<br>10分／400円」（曜日の見出し「全日」「（月～金）」「（土日祝）」は無いこともある）
//   最大料金: <span class="ari"> の中に「（月～土）<br>入庫後6時間　3800円<br>（日・祝）<br>…<br>（全日）<br>19:00～8:00　1000円」。
//             最大料金の無い物件は <span class="nashi">なし</span>。後ろの「繰り返し○／×」は料金ではない
// 所在地は <p class="address">所在地：…</p>、緯度経度は地図の初期位置 new google.maps.LatLng("35.66…","139.75…")。
// 書き方は jp-fee-text.js の parseFeeBlock に近いので、ここで見出しと1行の形だけそろえてから渡す（jp-fee-text.js は変えない）。
// robots.txt の Disallow は /_wp_sys/wp-admin/ のみ。
//
// 記録しない物件（{ skip: 理由 } を返す。run.js が料金を書かずに寝かせる）:
//   ・基本料金の欄が空（月極だけ・時間貸しをやめた物件）。料金の無い行を書くと、Advisor が同じ場所の Parkopedia の
//     料金のある物件を重複として落としてしまう
//   ・駐輪場。名前に「駐輪場」がある物件は一覧の段階で外している（showapark-enumerate.js）。名前に「駐輪場」が無くても、
//     備考の「自転車N台、バイクN台」の合計が収容台数と同じなら車の区画が無いので外す
//     （パーク保谷（自転車・バイク併設駐車場）は 32台＝自転車30台・バイク2台・360分100円。2026-11-01 のページで確かめた）

import { han, strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://www.shouwapark.co.jp/parking_detail/";

export function detailUrl(id) {
  return `${BASE}${id}/`;
}

function cell(html, label) {
  const m = html.match(new RegExp(`<th[^>]*>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : null;
}

// 行頭の曜日の見出しを parseFeeBlock の見出し（【…】）にそろえる。「（月～土）」「(土日祝)」「全日」
const SCOPE_RE = /^[（(]\s*([^）)]*?(?:月|火|水|木|金|土|日|祝|平日|全日)[^）)]*?)\s*[）)]\s*|^(全日|平日|土日祝|土・日・祝|日祝)(?=\s|$)\s*/;

/** 基本料金の欄 → parseFeeBlock に渡す行（<br> 区切り）。
 *  1つの <p> が「見出し・時間帯」と「N分／M円」の2行に分かれているので、1行にまとめる（分けたままだと時間帯が単価に付かない） */
export function normalizeBaseFee(td) {
  const blocks = String(td ?? "").split(/<\/p>/i).map((b) => strip(b.replace(/&nbsp;/g, " ").replace(/<br\s*\/?>/gi, " "))).filter(Boolean);
  return blocks.map((b) => {
    const m = b.match(SCOPE_RE);
    return m ? `【${m[1] ?? m[2]}】${b.slice(m[0].length)}` : b;
  }).join("<br>");
}

/** 最大料金の欄 → parseFeeBlock(…, "max") に渡す行。<span class="ari"> の中だけを見る（「繰り返し○」は料金ではない）。
 *  最大料金が無い（<span class="nashi">なし</span>）・欄が無いときは "" */
export function normalizeMaxFee(td) {
  const span = String(td ?? "").match(/<span class="ari">([\s\S]*?)<\/span>/);
  if (!span) return "";
  return span[1].split(/<br\s*\/?>/i).map((l) => strip(l.replace(/&nbsp;/g, " "))).filter(Boolean).map((l) => {
    const m = l.match(SCOPE_RE);
    if (!m) return l;
    const rest = l.slice(m[0].length).trim();
    return `【${m[1] ?? m[2]}】${rest}`;
  }).join("<br>");
}

/** 備考の「自転車30台、バイク2台」から、自転車とバイクの台数の合計（書いていなければ 0） */
function twoWheelCount(bikou) {
  const t = han(strip(bikou ?? ""));
  let n = 0;
  for (const m of t.matchAll(/(?:自転車|バイク|原付|自動二輪)\s*(\d+)\s*台/g)) n += Number(m[1]);
  return n;
}

export function parseShowaparkDetail(html, { id, label } = {}) {
  const pid = String(id);
  const name = strip((html.match(/<h1 class="hdg-1">([\s\S]*?)<\/h1>/) || [])[1] ?? "") || null;

  const addrRaw = (html.match(/<p class="address">([\s\S]*?)<\/p>/) || [])[1];
  const address = addrRaw ? strip(addrRaw).replace(/^所在地\s*[:：]\s*/, "") || null : null;

  let lat = null, lng = null;
  const ll = html.match(/LatLng\(\s*"(-?[\d.]+)"\s*,\s*"(-?[\d.]+)"\s*\)/);
  if (ll) { lat = Number(ll[1]); lng = Number(ll[2]); }

  const capCell = cell(html, "収容台数");
  const capacity = capCell ? Number((han(strip(capCell)).match(/(\d+)/) || [])[1]) || null : null;

  const baseCell = cell(html, "基本料金");
  // 基本料金の欄そのものが無いのは、ページの作りが変わったとき。料金が無いとみなして寝かせると全件が消えるので、読めないことにする
  if (name && baseCell == null) throw new Error("基本料金の欄が無い（ページの作りが変わった見込み）");

  if (name && /駐輪場/.test(name)) return { skip: "駐輪場" };
  const bikou = (html.match(/<div class="bikou[^"]*">([\s\S]*?)<\/div>/) || [])[1];
  const two = twoWheelCount(bikou);
  if (capacity && two >= capacity) return { skip: `駐輪場（備考に自転車・バイク${two}台。収容台数${capacity}台）` };

  const base = normalizeBaseFee(baseCell);
  const { unitCharges } = parseFeeBlock(base);
  if (name && !unitCharges.length) return { skip: "時間貸しの料金が無い（月極だけの見込み）" };
  const { maxFees } = parseFeeBlock(normalizeMaxFee(cell(html, "最大料金")), "max");

  return {
    operator: "showapark",
    parkId: pid,
    label: label ?? null,
    name,
    address,
    lat,
    lng,
    capacity,
    openingHours: null, // 入出庫できる時間の欄は無い
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(pid),
  };
}
