// 日本のコインパーキング事業者に共通する「自由テキストの料金表記」パーサ ----
// セイワパーク / システムパーク / コムパーク / 京王コインパーク / 小田急パーキング は
// いずれも料金を <br> 区切りの自由文で持つ。書式の癖はほぼ同じなので共通化する。
//   「8時～20時　30分100円」          → 単位料金
//   「8:00～20:00 20分/100円」        → 単位料金（"/" 区切り）
//   「1時間300円」                     → 単位料金（60分換算）
//   「24時間最大　600円」              → 最大料金
//   「入庫から24時間まで　2000円」     → 最大料金
//   「19時～8時　60分100円　最大500円」→ 1行に単位料金と最大料金が同居
//   「【月～金】」《通常料金》《最大料金》→ 区分の見出し
//   「8時～20時　最大料金なし」        → 最大料金は無し（同じ行の単位料金は活かす）
// 全角数字（０-９）・全角コロン（：）・全角チルダ（～）・全角スペースは半角へ正規化する。

export function han(s) {
  return String(s)
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ":")
    .replace(/，/g, ",")
    .replace(/[〜～]/g, "~")
    .replace(/　/g, " ");
}

// タグを落として1行のプレーンテキストにする
export function strip(s) {
  return han(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

// "8時～20時" / "8:00～20:00" / "8時30分～20時" → "8:00-20:00" 形式
// ※「8時～20時 60分200円」の "60分" を終了時刻の分と誤読しないよう、
//   分は「時」の直後（空白なし）にある場合だけ拾う。
export function extractTimeRange(text) {
  let m = text.match(/(\d{1,2}):(\d{2})\s*[~\-−]\s*(\d{1,2}):(\d{2})/);
  if (m) return `${+m[1]}:${m[2]}-${+m[3]}:${m[4]}`;
  m = text.match(/(\d{1,2})\s*時(?:(\d{1,2})\s*分)?\s*[~\-−]\s*(\d{1,2})\s*時(?:(\d{1,2})\s*分)?/);
  if (m) return `${+m[1]}:${(m[2] ?? "0").padStart(2, "0")}-${+m[3]}:${(m[4] ?? "0").padStart(2, "0")}`;
  return null;
}

const yen = (s) => Number(String(s).replace(/,/g, ""));

// 1行から料金を全て拾う。section === "max" の間は単位料金として解釈しない。
function parseFeeLine(rawLine, scope, section) {
  let text = strip(rawLine);
  const out = { scope, section, unitCharges: [], maxFees: [] };
  if (!text) return out;

  // 行頭の見出し。【最大料金】《最大料金》は料金種別、【月～金】【土日祝】は曜日区分。
  const head = text.match(/^[【《]([^】》]+)[】》]/);
  if (head) {
    const h = head[1];
    // 料金種別の見出しが来たら曜日区分は全日に戻す（【土日祝】…【最大料金】の並びで
    // 最大料金が土日祝限定と誤解されるのを防ぐ）
    if (/最大|打切|打ち切/.test(h)) { out.section = section = "max"; out.scope = scope = "全日"; }
    else if (/通常|基本|時間貸|時間割/.test(h)) { out.section = section = "unit"; out.scope = scope = "全日"; }
    else out.scope = scope = h;
    text = text.slice(head[0].length).trim();
  }
  if (!text || /^[※*＊○●◯]/.test(text)) return out; // 注記・小見出し

  text = text.replace(/最大料金\s*(?:は)?\s*なし|最大\s*なし|設定\s*なし/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return out;

  const timeRange = extractTimeRange(text);
  const consumed = []; // 単位料金として使った金額の位置

  if (section !== "max") {
    for (const m of text.matchAll(/(\d+)\s*分\s*[\/／]?\s*([\d,]+)\s*円/g)) {
      out.unitCharges.push({ scope, timeRange: timeRange ?? "全日", perMinutes: Number(m[1]), amountYen: yen(m[2]) });
      consumed.push([m.index, m.index + m[0].length]);
    }
    if (!out.unitCharges.length) {
      // 「1時間300円」。「3時間まで 800円」は間に語が入るので該当しない。
      for (const m of text.matchAll(/(\d+)\s*時間\s*[\/／]?\s*([\d,]+)\s*円/g)) {
        out.unitCharges.push({ scope, timeRange: timeRange ?? "全日", perMinutes: Number(m[1]) * 60, amountYen: yen(m[2]) });
        consumed.push([m.index, m.index + m[0].length]);
      }
    }
  }

  for (const m of text.matchAll(/([\d,]+)\s*円/g)) {
    if (consumed.some(([a, b]) => m.index >= a && m.index < b)) continue;
    const before = text.slice(0, m.index)
      .replace(/(\d+)\s*(?:分|時間)\s*[\/／]?\s*[\d,]+\s*円/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      // normalize.js が「N時間以内」を duration/d24h と読めるよう表記を寄せる
      .replace(/(\d+)\s*時間\s*まで/g, "$1時間以内")
      .replace(/入庫\s*(?:から|後)?\s*(\d+)\s*時間(?!\s*以)/g, "入庫から$1時間以内");
    // 時間帯だけが手掛かりのときは "18:00-8:00 最大" の形にして下流の判定を助ける
    const condition = timeRange && !/24\s*時間|当日|[1１]日|以内|まで/.test(before)
      ? `${timeRange} 最大`
      : (before || "最大");
    out.maxFees.push({ scope, condition, amountYen: yen(m[1]) });
  }
  return out;
}

// 料金テキスト（<br> や改行区切り）→ { unitCharges, maxFees }
// section に "max" を渡すと全行を最大料金として解釈する。
export function parseFeeBlock(html, section = null) {
  const unitCharges = [];
  const maxFees = [];
  let scope = "全日";
  let sec = section;
  for (const line of String(html).split(/<br\s*\/?>|<\/p>|\r?\n/i)) {
    const r = parseFeeLine(line, scope, sec);
    scope = r.scope;
    sec = r.section;
    unitCharges.push(...r.unitCharges);
    maxFees.push(...r.maxFees);
  }
  return { unitCharges, maxFees };
}
