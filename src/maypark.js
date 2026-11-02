// MAYパーク（日本メカトロニクス / aaa-mtc.jp）一覧直載型パーサ --------------------------------------------
// https://aaa-mtc.jp/may/index.html の1ページ（Shift_JIS・約380KB）に、愛知・岐阜・三重・静岡・滋賀の全物件が載る（2026-11-01 で193区画）。
// 1物件＝<div class="box011 …"> の表1つ。名前は <span class="wcfontsize5 …">、住所はその下の <div>、
// 台数は <td width="150"> の「N台」、料金は <td width="240"> の <br> 区切りの自由文。座標は無い
// （住所から引く。解析リポジトリの geocode-lots。タイムズと同じ流れ）。番号も無いので、名前を parkId にする。
// 約50区画は駐輪場・バイク・月極専用なので記録しない（下の excludeReason）。
// robots.txt は https://aaa-mtc.jp/ への 302 で HTML が返る＝決まりなし（polite-fetch の getRobots は「無い」と同じに扱う）。
//
// 料金の書き方は金額が先（「100円/30分　700円/昼間」）で、共通の parseFeeBlock（jp-fee-text.js）にそのまま渡すと
// 「30分700円」「最大100円」と読み違える（0件にならないので、0件の歯止めでは気づけない。2026-11-01 見直し）。
// ここで parseFeeBlock の読める形（「30分100円 昼間最大700円」）に直してから渡す（normalizeMayFee）。jp-fee-text.js は変えない。

import { parseFeeBlock } from "./jp-fee-text.js";
import { decodeEntities } from "./zenkaku.js";
import { isAddressLike } from "./address-like.js";

const PAGE_URL = "https://aaa-mtc.jp/may/index.html";
// ページの文字コード。politeFetch の encoding に渡す（既定の UTF-8 で読むと文字化けして0件になる）
export const ENCODING = "shift_jis";

export function listUrl() {
  return PAGE_URL;
}

// エリアの見出し（<h3 class="title02">愛知エリア</h3>）→ 都道府県。住所に都道府県が無いので頭に足す（座標を引くときに他県の同じ地名に当てない）
const PREF_OF_AREA = { 愛知: "愛知県", 岐阜: "岐阜県", 三重: "三重県", 静岡: "静岡県", 滋賀: "滋賀県" };

// タグを落とした1行（実体参照を戻し、全角英数・かっこ・チルダを半角へ。NFKC）
const text = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " "))
  .normalize("NFKC").replace(/[〜∼]/g, "~").replace(/\s+/g, " ").trim();
const linesOfHtml = (html) => String(html ?? "").split(/<br\s*\/?\s*>|<\/?p[^>]*>|<\/?div[^>]*>/i).map(text);
// 名前は書かれたまま（全角の数字・かっこ・「Ⅰ」を変えない）。parkId にもするので、読み方を変えると別の物件になる
const nameText = (s) => decodeEntities(String(s ?? "").replace(/<[^>]+>/g, " ")).replace(/[\s　]+/g, " ").trim();

// 二輪・自転車の言葉。名前・台数・料金の行に出たら、その物件・その行から先は四輪ではない
const BIKE = /駐輪|自転車|原付|原動機|バイク|二輪|サイクル/;
// 月極・定期の行（時間貸しの料金ではない）
const MONTHLY = /月極|定期|[ヶか]月|\/月|募集/;
// 曜日の区分の見出し。行頭に単独、または「<平日>」「〈全日〉」「【全日】」「(平日)」の形で出る
const DAY_WORD = "平日|全日|通常日?|土日祝日?(?:縁日\\(\\d+日\\))?|土日|日祝|土・日(?:・祝)?|土 日|月[~\\-]金|月[~\\-]土|火水金土|月・木・日・祝";
const HEAD_BRACKET = new RegExp(`^[<〈【(]\\s*(${DAY_WORD})\\s*[>〉】)]\\s*`);
const HEAD_BARE = new RegExp(`^(${DAY_WORD})(?=\\s|\\d|$)\\s*`);
// 特別な日・特別な人の料金（年末年始・イベント開催日・ホテルの宿泊客）。相場には使わないので、次の見出しまで読み飛ばす
const SPECIAL = /特別日|年末年始|イベント開催日|お客様|宿泊/;
// 区画の番号つきの行（「No.8~No.19のみ 1,200円/24H」「N0.15~17」）。一部の区画だけの料金なので物件の料金にしない
const PARTIAL = /N[oO0]\.?\s*\d|車室のみ|のみ\s*[\d,]+\s*円/;
// 車の大きさ。普通車の料金だけを採る（軽・小型は安いことが多く、混ぜると相場が下がる）
const SMALL_HEAD = /^(?:\((?:軽|小|小型)\)|(?:軽|小型)(?:自動車|車)?\s*[: ]|軽自動車|小型車)/;
const NORMAL_HEAD = /^(?:\((?:普|普通)\)|普通(?:自動車|車)?\s*[: ]?)/;

// 「8~18時」「15~翌8時」「8時30分~15時30分」→「8時~18時」の形（jp-fee-text の extractTimeRange が読める形）。
// 始まりと終わりが同じ（「9~翌9時」）は丸1日なので「24時間」にする（「500円/(9~翌9時)最大」→ 24時間の上限）
function hourRange(t) {
  return t.replace(/(?<![\d.,])(\d{1,2})(?:\s*時(?:\s*(\d{1,2})\s*分)?)?\s*~\s*翌?\s*(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/g,
    (_, a, am, b, bm) => {
      if (+a === +b && +(am ?? 0) === +(bm ?? 0)) return "24時間";
      return `${+a}時${am ? `${+am}分` : ""}~${+b}時${bm ? `${+bm}分` : ""}`;
    });
}

// 1行の金額先行の書き方を、parseFeeBlock の読める形に直す
function rewriteLine(t0) {
  let t = t0;
  // 「600円/24H」「1,800円/24h」は24時間の最大。「24h最大800円」「入庫~24h」の h も「時間」にする
  t = t.replace(/([\d,]+)\s*円\s*\/\s*24\s*(?:[hH]|時間)(?![a-zA-Z])\s*(?:最大)?/g, "24時間最大$1円");
  t = t.replace(/24\s*[hH](?![a-zA-Z])/g, "24時間");
  t = hourRange(t);
  t = t.replace(/[()]\s*(\d{1,2}時(?:\d{1,2}分)?~\d{1,2}時(?:\d{1,2}分)?|24時間)\s*[()]/g, " $1 ");   // 「(9~15時)」のかっこを外す
  // 単価: 「100円/30分」「100円/4時間」→「30分100円」「240分100円」
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(\d+)\s*分/g, "$2分$1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(?!24\s*時間)(\d+)\s*時間(?!\s*最大)/g, (_, y, h) => `${+h * 60}分${y}円`);
  // 最大料金
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(\d+)\s*[hH]/g, "$2時間最大$1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(\d+)\s*時間最大/g, "$2時間最大$1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(昼間|夜間)(?:最大)?/g, "$2最大$1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*最大/g, "最大$1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(当日[^円]*?)(?:最大)?$/g, "$2最大$1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(入庫[^円]*)$/g, "$2 $1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(24時間)\s*(?:最大)?/g, "$2最大$1円");
  t = t.replace(/([\d,]+)\s*円\s*\/\s*(\d{1,2}時(?:\d{1,2}分)?~\d{1,2}時(?:\d{1,2}分)?)\s*(?:最大)?/g, "$2 最大$1円");
  // 金額の後ろに時間帯と次の金額が続く（「30分100円 18時~8時 夜間最大200円」）ときは、時間帯の前で行を分ける。
  // parseFeeBlock は1行の時間帯を、その行の単価すべてに付けるため（30分100円 が夜間だけの単価になる）。
  // 時間帯で終わる行（「60分200円 9時~18時」）は、その時間帯の単価なので分けない
  return t.replace(/\s+/g, " ").trim().replace(/円\s+(?=\d{1,2}時(?:\d{1,2}分)?~\d{1,2}時(?:\d{1,2}分)?\s*\S*\d\s*円)/g, "円\n");
}

/** MAYパークの料金欄（<td width="240"> の中身）→ parseFeeBlock に渡す行（<br> 区切り）。
 *  opts.firstLineOnly … 車とバイク・自転車が同じ物件で、料金の行に車種が書かれていないとき（台数の欄と同じ並びで
 *  1行目が車）。1行目だけを採る */
export function normalizeMayFee(html, { firstLineOnly = false } = {}) {
  const out = [];
  let skip = null;          // 読み飛ばし中の理由（"special" | "small" | "bike" | "group"）
  let scope = null;         // いまの曜日の区分（行の後ろの「・土日祝」で一時的に変えたあと戻すため）
  let groups = 0;           // 区画の組の見出し（「No.1・2」「N0.3~14」）の数。2つ目からは読まない
  for (let t of linesOfHtml(html)) {
    if (!t || /^※|^\(※/.test(t)) continue;
    // 区画の組の見出しだけの行
    if (/^N[oO0]\.?\s*\d+(?:\s*[・~,、]\s*(?:N[oO0]\.?\s*)?\d+)*$/.test(t)) {
      if (++groups >= 2) skip = "group";
      continue;
    }
    if (skip === "group") continue;
    // 曜日の見出し（次の見出しまでの読み飛ばしを終える）
    const hd = t.match(HEAD_BRACKET) ?? t.match(HEAD_BARE);
    if (hd) {
      const word = hd[1];
      t = t.slice(hd[0].length).trim();
      if (/^通常/.test(word)) { scope = "全日"; skip = null; out.push("【全日】"); }
      else { scope = word; skip = null; out.push(`【${word}】`); }
      if (!t) continue;
    }
    // 特別な日・特別な人の見出し（【イベント開催日】・特別日・ご宿泊のお客様）。次の曜日の見出しまで読まない
    if (SPECIAL.test(t)) { skip = "special"; continue; }
    // 車の大きさ
    if (NORMAL_HEAD.test(t)) { t = t.replace(NORMAL_HEAD, "").trim(); if (skip === "small") skip = null; }
    else if (SMALL_HEAD.test(t)) { skip = "small"; continue; }
    if (skip) continue;
    if (BIKE.test(t)) { skip = "bike"; continue; }
    if (MONTHLY.test(t) || PARTIAL.test(t)) continue;
    // 行の後ろの車の大きさ（「300円/夜間最大(小)」は小型の行、「(普)」「(普通)」は印だけ外す）
    if (/\((?:小|小型|軽)\)\s*$/.test(t)) continue;
    t = t.replace(/\((?:普|普通)\)/g, " ");
    // 行の途中の軽・小型の金額（「100円/30分 軽 400円/24H」「100円/30分 (小型)500円/24H」）は外す
    t = t.replace(/(?:\((?:軽|小|小型)\)|(?:^|\s)(?:軽|小型)(?:自動車|車)?\s*[: ]?)\s*[\d,]+\s*円(?:\s*\/\s*\S+)?/g, " ");
    // 無料の時間（「入庫後15分以内無料」「入庫から30分以内/無料」「1時間無料」）と「以後」
    t = t.replace(/(?:入庫(?:から|後)?|最初の)?\s*\d+\s*(?:分|時間|[hH])\s*(?:以内)?\s*\/?\s*無料/g, " ").replace(/以後/g, " ").trim();
    if (!t || /^最初の/.test(t)) continue;
    // 行の後ろの曜日（「800円/昼間・平日」「1000円/昼間・土日祝」）。その行だけの区分にして、次の行から元に戻す
    const tail = t.match(/^(.*)・(平日|土日祝)$/);
    if (tail) {
      out.push(`【${tail[2]}】${rewriteLine(tail[1]).replace(/\n/g, "<br>")}`, `【${scope ?? "全日"}】`);
      continue;
    }
    out.push(...rewriteLine(t).split("\n"));
    if (firstLineOnly && /円/.test(t)) break;
  }
  return out.join("<br>");
}

/** 料金欄 → { unitCharges, maxFees }。同じ単価・同じ上限が2回出たら1つにする */
export function parseMayFee(html, opts) {
  const { unitCharges, maxFees } = parseFeeBlock(normalizeMayFee(html, opts));
  const uniq = (arr) => { const seen = new Set(); return arr.filter((x) => { const k = JSON.stringify(x); if (seen.has(k)) return false; seen.add(k); return true; }); };
  return { unitCharges: uniq(unitCharges), maxFees: uniq(maxFees) };
}

/** 台数の欄 → { cars（四輪の台数。読めなければ null）, bikes（二輪・自転車の台数の書きがあるか）, monthlyOnly } */
export function parseMayCapacity(html) {
  const lines = linesOfHtml(html).filter(Boolean);
  const all = lines.join(" ");
  let cars = 0, seen = false, hourly = null;
  for (const l of lines) {
    const m = l.match(/(\d[\d,]*)\s*台/);
    if (!m) continue;
    const n = Number(m[1].replace(/,/g, ""));
    if (/時間貸/.test(l)) hourly = n;
    if (BIKE.test(l) || /バス|身障者|月極|^\(/.test(l)) continue;
    cars += n; seen = true;
  }
  return { cars: hourly ?? (seen ? cars : null), bikes: BIKE.test(all), monthlyOnly: /月\s*極\s*専用/.test(all) };
}

// 住所の欄（名前の下の <div>）の行から、住所らしい1行を選ぶ。管理事務所の名前・電話番号・建物名・支店名は飛ばす
function pickAddress(lines, pref) {
  for (const l0 of lines) {
    const l = l0.split(/\s*,\s*|\s+/)[0].replace(/\([^)]*\)$/, "").trim();
    if (!l || /^\d{2,4}-\d/.test(l)) continue;
    const withPref = /^(?:北海道|東京都|京都府|大阪府|.{2,3}県)/.test(l) || !pref ? l : `${pref}${l}`;
    if (isAddressLike(withPref)) return withPref;
  }
  return null;
}

/** 記録しない物件の理由。記録するなら null（2026-11-02）
 *  ・駐輪場・バイク・自転車だけの区画（名前か台数の欄で見分ける）
 *  ・月極専用・時間貸しの料金の文が無い（料金の無い物件を記録すると、Advisor が同じ名前の料金つきの Parkopedia の物件を落とす）
 *  ・近日オープン */
export function excludeReason({ name, cap, feeText, unitCharges }) {
  if (BIKE.test(name ?? "")) return "駐輪場・バイク";
  if (cap.bikes && cap.cars == null) return "駐輪場・バイク";
  if (/近日|オープン予定|OPEN予定|開業予定|準備中/i.test(`${name ?? ""} ${feeText ?? ""}`)) return "近日オープン";
  if (cap.monthlyOnly) return "月極専用";
  if (!unitCharges.length) return "時間貸しの料金の文が無い";
  return null;
}

/** 一覧のページ → { records（記録する物件）, excluded（記録しない物件と理由）, boxes（区画の数） } */
export function parseMayList(html, { label } = {}) {
  const records = [], excluded = [];
  // エリアの見出しの位置
  const areas = [...String(html).matchAll(/<h3 class="title02">\s*([^<]*?)エリア/g)].map((m) => ({ at: m.index, pref: PREF_OF_AREA[m[1].trim()] ?? null }));
  const prefAt = (pos) => { let p = null; for (const a of areas) if (a.at < pos) p = a.pref; return p; };
  const starts = [...String(html).matchAll(/<div class="box011[^"]*">/g)].map((m) => m.index);
  const seenIds = new Map();
  for (let i = 0; i < starts.length; i++) {
    const box = html.slice(starts[i], starts[i + 1] ?? html.length).split(/<div class="(?:box01|img_box04+)[ "]/)[0];
    const nameHtml = [...box.matchAll(/<span\s+class\s*="wcfontsize5[^"]*"\s*>([\s\S]*?)<\/span>/g)].map((m) => m[1]).join(" ");
    const name = nameHtml.split(/<br\s*\/?\s*>/i).map(nameText).filter(Boolean).join(" ") || null;
    // 名前の入ったセル（td width=330/280）の、名前より後ろの行が住所の欄
    const cells = [...box.matchAll(/<td([^>]*)>([\s\S]*?)(?=<td[\s>]|<\/tr>)/g)].map((m) => ({ attr: m[1], html: m[2] }));
    const nameCell = cells.find((c) => /wcfontsize5/.test(c.html));
    const afterName = nameCell ? nameCell.html.split(/<\/span>/).slice(1).join(" ") : "";
    const address = pickAddress(linesOfHtml(afterName).filter(Boolean), prefAt(starts[i]));
    const capCell = cells.find((c) => /width="150"/.test(c.attr));
    const feeCell = cells.find((c) => /width="240"/.test(c.attr));
    const cap = parseMayCapacity(capCell?.html ?? "");
    const feeHtml = feeCell?.html ?? "";
    const feeText = linesOfHtml(feeHtml).filter(Boolean).join(" / ");
    // 車とバイク・自転車が同じ物件で、料金の行に車種の書きが無いときは1行目（車）だけ
    const firstLineOnly = cap.bikes && cap.cars != null && !BIKE.test(feeText);
    const { unitCharges, maxFees } = parseMayFee(feeHtml, { firstLineOnly });
    const why = excludeReason({ name, cap, feeText, unitCharges });
    if (why) { excluded.push({ name, reason: why }); continue; }
    // 同じ名前が2つあれば2つ目から「名前#2」（番号が無いので名前を番号にしている）
    const n = (seenIds.get(name) ?? 0) + 1;
    seenIds.set(name, n);
    records.push({
      operator: "maypark",
      parkId: n > 1 ? `${name}#${n}` : name,
      label: label ?? null,
      name,
      address,
      lat: null,
      lng: null,
      capacity: cap.cars || null,
      openingHours: null,
      unitCharges,
      maxFees,
      sourceUrl: PAGE_URL,
    });
  }
  return { records, excluded, boxes: starts.length };
}
