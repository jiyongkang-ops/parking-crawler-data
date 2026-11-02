// 三菱地所パークス（Parking NAVI・parkingnavi.jp）の一覧ページのパーサ（2026-11-02 追加） -------------------------
// 時間貸しの一覧 search_result.php?type=1&area={都道府県}(&city={市区}) の HTML に、物件ごとのデータが
//   var customdata = [{ pid, pname, addr, lat, long, ptype, time, timem, climit, bhours, … }];
// の形でそのまま入っている。詳細ページ（details.php）を回らなくても、料金・最大料金・座標がそろう。
//   ptype … 3=平面（PARKS PARK・PEN・ミウラなど） 1=施設（ビル駐車場） 4=バイク 5=駐輪場
//   time  … 「【全日】<br/>8:00～20:00 300円 / 15分<br/>【全日】<br/>20:00～8:00 100円 / 60分」
//   timem … 「【昼間最大料金】<br/>月曜～土曜日(祝日除く) 8:00～20:00  2800円 (繰り返し可)<br/>【昼間最大料金】<br/>日曜日・祝日 …」
// 1ページは最大100件で、それより多い所（東京都）は市区ごとに取る（mecparks-enumerate.js）。
// 今は平面（ptype=3）だけを記録する。施設（ビル駐車場）を最大料金の相場に入れるかは本人の判断待ち（2026-11-02）。
// robots.txt は BUbiNG・dotbot だけが Disallow: /（ほかは制限なし）。
//
// 料金の文は、曜日の区分が見出し（【…最大料金】）ではなく次の行の頭（「月曜～土曜日(祝日除く)」「日曜日・祝日」など）に
// 書かれる。そのまま parseFeeBlock に渡すと、見出しで曜日が「全日」に戻り、月～土の2,800円と日祝の1,000円が両方「全日」に
// なって、昼の最大が安い日祝の額で読まれる（2026-11-01 の点検）。そこで1組（見出し＋行）ずつ、
// 「【曜日】種類 時間帯 金額」の1行に並べ替えてから parseFeeBlock に渡す。単価も「300円 / 15分」を「15分300円」に並べ替える。

import { parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://parkingnavi.jp";
export const MECPARKS_LIST_CAP = 100;   // 一覧1ページに載る上限（これに達したら市区・町丁へ下りる）

export function listUrl(pref, { city = null, town = null } = {}) {
  return `${BASE}/search_result.php?type=1&area=${pref}${city ? `&city=${city}` : ""}${town ? `&town=${town}` : ""}`;
}
/** 都道府県の市区の一覧（pref だけ）と、市区の町丁の一覧（city あり）のページ */
export function areaUrl(pref, city = null) {
  return `${BASE}/area.php?type=time&pref=${pref}${city ? `&city=${city}` : ""}`;
}
export function detailUrl(pid) {
  return `${BASE}/details.php?parking_id=${pid}&page=time`;
}

/** 一覧ページ → customdata の配列。customdata が無い・読めないときは null（ページの作りの変更） */
export function parseCustomdata(html) {
  const m = String(html ?? "").match(/var\s+customdata\s*=\s*(\[[\s\S]*?\]);\s*\n/);
  if (!m) return null;
  try { const a = JSON.parse(m[1]); return Array.isArray(a) ? a : null; } catch { return null; }
}
/** 一覧ページの件数（var parkingCount = N）。無ければ null */
export function parseParkingCount(html) {
  const m = String(html ?? "").match(/var\s+parkingCount\s*=\s*(\d+)/);
  return m ? Number(m[1]) : null;
}
/** area.php?type=time&pref=N → 市区のコード */
export function parseCityCodes(html, pref) {
  return [...new Set([...String(html ?? "").matchAll(new RegExp(`area\\.php\\?type=time&(?:amp;)?pref=${pref}&(?:amp;)?city=(\\d+)`, "g"))].map((m) => m[1]))];
}
/** area.php?type=time&pref=N&city=C → 町丁のコード */
export function parseTownCodes(html, pref, city) {
  return [...new Set([...String(html ?? "").matchAll(new RegExp(`search_result\\.php\\?type=1&(?:amp;)?area=${pref}&(?:amp;)?city=${city}&(?:amp;)?town=(\\d+)`, "g"))].map((m) => m[1]))];
}

// ---- 料金の文の並べ替え ----

/** 料金の文 → [{ head, text }]。見出し（【…】）と、その下の行を組にする。行の中の改行（\r\n）は空白にする */
function pairs(html) {
  const out = [];
  let head = null;
  for (const raw of String(html ?? "").split(/<br\s*\/?>/i)) {
    const line = raw.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
    if (!line) continue;
    const m = line.match(/^【([^】]*)】\s*(.*)$/);
    if (m) { head = m[1].trim(); if (m[2]) out.push({ head, text: m[2] }); continue; }
    out.push({ head, text: line });
  }
  return out;
}

/** 見出しの頭の車種（「自動車・全日」「バイク・宿泊料金」）を分ける。車種の無い見出しは自動車 */
function vehicleOf(head) {
  const m = String(head ?? "").match(/^(自動車|バイク|自転車|原付)(?:・|$)/);
  return { vehicle: m ? m[1] : "自動車", rest: m ? String(head).slice(m[0].length).trim() : String(head ?? "").trim() };
}

// 行の頭に書かれる曜日の区分。「全日」「月～金(祝日除く)」「月曜～土曜日(祝日除く)」「月曜～土曜日」「土日祝」「日曜日・祝日」
// 「月～金」「全日(祝日除く)」「特定日 7～8月」など（2026-11-01 時点で11通り以上）。
// 特定日は「7～8月」を区分に入れない（「月」の字で平日の区分と読まれる。pricing-model.mjs の scopeOk）
const NOHOL = "(?:\\s*[（(]祝日除く[)）])?";
const DAY_RE = new RegExp(`^(全日${NOHOL}|平日${NOHOL}|土日祝日?|土日|日祝日?|日曜日?・祝日?|土曜日?${NOHOL}|日曜日?|祝日|` +
  `月曜?日?[～~]金曜?日?${NOHOL}|月曜?日?[～~]土曜?日?${NOHOL}|特定日)(?=\\s|$)`);
function splitDay(text) {
  const m = text.match(DAY_RE);
  if (!m) return { scope: null, rest: text };
  return { scope: m[1].replace(/\s+/g, ""), rest: text.slice(m[0].length).trim() };
}

// 最大料金の見出し → 種類の言葉（parseFeeBlock と studio-index.mjs の bandOf が読む）
function kindOf(rest) {
  if (/24時間/.test(rest)) return "24時間最大";
  if (/当日/.test(rest)) return "当日最大";
  if (/昼間/.test(rest)) return "昼間最大";
  if (/夜間/.test(rest)) return "夜間最大";
  const h = rest.match(/(\d+)\s*時間/);
  if (h) return `${h[1]}時間最大`;
  return "";   // 【最大料金】【自動車】… 種類は行の中の「4時間最大」「22:00～8:00」で決まる
}

/** 単価の行 → parseFeeBlock が読める形（「8:00～20:00 300円 / 15分」→「8:00～20:00 15分300円」）。記録しない行は null */
export function normalizeUnitLine(text) {
  let t = String(text ?? "").trim();
  // 「最初の 1時間 600円」「最初の 2時間 無料」は最初だけの料金（そのあとの「以降 300円 / 30分」を単価にする）
  // 「1000円 / 1泊」「宿泊駐車利用」は泊まりの料金、「10時間まで 150円」は駐輪場の上限で、どれも時間あたりの単価ではない
  if (/最初の|泊|まで|^(バイク|自転車|原付)/.test(t)) return null;
  t = t.replace(/^以降[、,]?\s*/, "").replace(/翌\s*/g, "");
  // 「300円 / 15分」「100円 / 1時間」「100円 / 60」（単位なしは分。2026-11-01 時点で1件）
  t = t.replace(/([\d,]+)\s*円\s*[\/／]\s*(\d+)\s*(分|時間)?/g, (_, yen, n, unit) => `${n}${unit ?? "分"}${yen}円`);
  // 「1000円 / 24時間」「24時間 200円」は1日ごとの料金で、時間あたりの単価ではない。単価にすると 42円/時 のように
  // 周辺の単価の相場を下げるので記録しない（車の物件では大阪市福島区海老江5丁目・みさき公園駅前の2件。2026-11-02）
  const per = t.match(/(\d+)\s*(分|時間)\s*[\d,]+\s*円/);
  if (per && Number(per[1]) * (per[2] === "時間" ? 60 : 1) >= 1440) return null;
  return /円/.test(t) ? t : null;
}

// 最大料金の行のうち、記録しないもの。事前購入の1日パス・月極のパス・泊まりの客だけの料金・小型車の区画だけの料金
const MAX_SKIP_RE = /パス|事前購入|宿泊|ホテル|小型車|軽自動車|軽車室/;

/** 最大料金の1組（見出し・行）→ parseFeeBlock が読める1行（「【月曜～土曜日(祝日除く)】昼間最大 8:00～20:00 2800円」）。記録しないときは null */
export function normalizeMaxPair(head, text) {
  const { vehicle, rest } = vehicleOf(head);
  if (vehicle !== "自動車" || /宿泊/.test(rest)) return null;
  let t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!/円/.test(t) || MAX_SKIP_RE.test(t)) return null;
  const { scope, rest: body0 } = splitDay(t);
  let body = body0
    // 車室ごとの上限（「1～8・11～20番車室」「1･2番車室」）。区画の注記で、料金の種類ではない
    .replace(/[／\/]?\s*[\d０-９,，・･～~\-]+\s*番車室(?:のみ)?/g, " ")
    // 「(繰り返し可)」「(一回限り)」は金額の後ろにあるので条件には入らないが、念のため落とす
    .replace(/[（(](?:繰り返し可|一回限り)[)）]/g, " ")
    .replace(/最大料金/g, "最大")
    .replace(/\s+/g, " ").trim();
  // 行の中に「5時間最大」「3時間まで」「24時間最大」があれば、それが種類（見出しの「当日最大」より細かい）
  const own = /\d+\s*時間\s*(?:最大|まで)/.test(body);
  const kind = own ? "" : kindOf(rest);
  const line = `${kind} ${body}`.trim();
  return `【${scope ?? "全日"}】${line}`;
}

/** time・timem → { unitCharges, maxFees }。曜日は見出しか行の頭から取り、区分（scope）に入れる */
export function parseMecparksFees(time, timem) {
  const unitLines = [];
  for (const { head, text } of pairs(time)) {
    const { vehicle, rest } = vehicleOf(head);
    if (vehicle !== "自動車") continue;
    const t = normalizeUnitLine(text);
    if (!t) continue;
    // 【昼間】【夜間】【全日】は時間帯の見出しで、曜日の区分ではない（時間帯は行に書いてある）
    const scope = !rest || /^(全日|昼間|夜間)$/.test(rest) ? "全日" : rest;
    unitLines.push(`【${scope}】${t}`);
  }
  const maxLines = [];
  for (const { head, text } of pairs(timem)) {
    const l = normalizeMaxPair(head, text);
    if (l) maxLines.push(l);
  }
  // 単価の文からは単価だけを採る（読み残した金額を最大料金にしない）
  const { unitCharges } = parseFeeBlock(unitLines.join("\n"));
  const { maxFees } = parseFeeBlock(maxLines.join("\n"), "max");
  return { unitCharges, maxFees };
}

// ---- 1物件 ----

/** 記録しない理由。記録するなら null。
 *  施設（ptype=1）… ビル駐車場。最大料金の相場に入れるかは本人の判断待ちなので、今は外す（2026-11-02）
 *  バイク（4）・駐輪場（5）… 四輪の相場ではない
 *  名前に「（月極）」… 月極だけの物件
 *  時間料金の文が無い … 料金の無いクロールの物件があると、Advisor が同じ場所の Parkopedia の物件（料金あり）を
 *    重複として落とし、相場から料金が消える */
export function skipReasonOf(p) {
  const ptype = String(p?.ptype ?? "");
  if (ptype === "4") return "バイク";
  if (ptype === "5") return "駐輪場";
  if (ptype !== "3") return ptype === "1" ? "施設" : `種類${ptype || "なし"}`;
  if (/駐輪|バイク|自転車/.test(p?.pname ?? "")) return "駐輪場";
  if (/[（(]月極[)）]/.test(p?.pname ?? "")) return "月極";   // 「PEN鎌ケ谷市鎌ケ谷三本椚パーキング（月極）」。時間料金の文も無い
  if (/近日\s*(?:OPEN|オープン|開業)|OPEN予定|オープン予定/i.test(`${p?.pname ?? ""} ${p?.pr ?? ""}`)) return "近日オープン";
  return null;
}

/** customdata の1件 → 記録の形。記録しない物件は null（理由は skipReasonOf） */
export function parseMecparksLot(p, { label = null } = {}) {
  if (!p?.pid || skipReasonOf(p)) return null;
  const { unitCharges, maxFees } = parseMecparksFees(p.time, p.timem);
  if (!unitCharges.length) return null;   // 時間料金の文が無い（月極だけ・料金の載っていない物件）
  const lat = Number(p.lat), lng = Number(p.long);
  const hours = String(p.bhours ?? "").replace(/\s+/g, " ").trim();
  return {
    operator: "mecparks",
    parkId: String(p.pid),
    label,
    name: String(p.pname ?? "").replace(/[\s　]+/g, " ").trim() || null,
    address: String(p.addr ?? "").replace(/[\s　]+/g, " ").trim() || null,
    lat: Number.isFinite(lat) && lat !== 0 ? lat : null,
    lng: Number.isFinite(lng) && lng !== 0 ? lng : null,
    capacity: null,   // 一覧には台数が無い（詳細ページにはあるが、物件ごとに1回ずつ取ることになるので取らない）
    openingHours: hours || null,
    unitCharges,
    maxFees,
    sourceUrl: detailUrl(p.pid),
  };
}

/** 一覧ページ → { records, skipped: { 理由: 件数 }, rows: 一覧の件数, count: ページが言う件数, broken: 読めなかった } */
export function parseMecparksList(html, { label = null } = {}) {
  const arr = parseCustomdata(html);
  const count = parseParkingCount(html);
  if (!arr) return { records: [], skipped: {}, rows: 0, count, broken: true };
  const records = [];
  const skipped = {};
  for (const p of arr) {
    const why = skipReasonOf(p) ?? (p?.pid ? null : "番号なし");
    const rec = why ? null : parseMecparksLot(p, { label });
    if (rec) records.push(rec);
    else { const k = why ?? "料金なし"; skipped[k] = (skipped[k] ?? 0) + 1; }
  }
  return { records, skipped, rows: arr.length, count, broken: false };
}
