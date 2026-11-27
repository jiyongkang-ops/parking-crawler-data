// 2026-11-27 に足した社（コインパーク・パークジャパン・フルーツパーク・いずみパーキング・TOBU PARK・ユアーズ・京成パーク・Park1st.）の
// 料金の文を、共通の parseFeeBlock（jp-fee-text.js）が読める形に寄せる小さな道具。jp-fee-text.js は変えない
// （ほかの社の読み方が変わらないように）。
//   「200円/30分」      → 「30分200円」（金額が先の書き方。TOBU PARK）
//   「60分／220円」     → そのまま読める（parseFeeBlock は「分」と「円」の間の / を許す）
//   「最初の60分 400円」「以降30分毎 200円」→「60分400円」「30分200円」（Park1st.）
//   「8-19時」          → 「8:00-19:00」（フルーツパーク）
//   「18:00～翌8:00」   → 「18:00~8:00」（「翌」があると時間帯が読めない）
import { han, strip, parseFeeBlock } from "./jp-fee-text.js";

export function tidyFee(s) {
  return han(String(s ?? ""))
    .replace(/&nbsp;/g, " ")
    .replace(/[（]/g, "(").replace(/[）]/g, ")")
    .replace(/([\d,]+)\s*円\s*[\/／]\s*(\d+)\s*分/g, "$2分$1円")
    .replace(/([\d,]+)\s*円\s*[\/／]\s*(\d+)\s*時間/g, "$2時間$1円")
    .replace(/翌\s*/g, "")
    .replace(/(?:最初の|以降|以後)\s*(\d+)\s*分\s*(?:毎|ごと)?/g, "$1分")
    .replace(/(\d+)\s*分\s*(?:毎|ごと)(?=\s*[\d,]+\s*円)/g, "$1分")
    .replace(/(?<![\d:])(\d{1,2})\s*[-~]\s*(\d{1,2})\s*時(?!間)/g, "$1:00-$2:00");
}

/** 1つの区分（scope）の料金の文 → { unitCharges, maxFees }。section が "max" なら全部を最大料金として読む */
export function feeOf(text, { scope = "全日", section = null } = {}) {
  const r = parseFeeBlock(tidyFee(text), section);
  return {
    unitCharges: r.unitCharges.map((u) => ({ ...u, scope })),
    maxFees: r.maxFees.map((m) => ({ ...m, scope })),
  };
}

/** feeOf の結果を足し合わせる */
export function mergeFees(list) {
  return { unitCharges: list.flatMap((x) => x.unitCharges), maxFees: list.flatMap((x) => x.maxFees) };
}

/** 曜日の区分の名前をそろえる（【月～金】→ 月~金・「平日」→ 平日）。見当たらなければ null */
export function scopeOf(label) {
  const t = han(strip(label)).replace(/[【】\[\]]/g, " ").replace(/\s+/g, "").replace(/月[-ー−~]金/g, "月~金").replace(/月[-ー−~]土/g, "月~土");
  const m = t.match(/(全日|毎日|平日|月~金|月~土|月~日|土日祝日?|土日祝|土曜|日曜|日祝|日・?祝|土・?日・?祝|休日|祝日|土日)/);
  return m ? m[1].replace(/・/g, "") : null;
}

/** 行だけで曜日の区分を表す行か（「月-金」「土日祝」「【平日】」など）。そうなら区分の名前、違えば null */
export function scopeLine(text) {
  const t = han(strip(text)).replace(/[【】\[\]<>＜＞()（）:：\s]/g, "");
  if (!t || t.length > 8 || /\d|円|分|時/.test(t)) return null;
  return scopeOf(t);
}

/** 料金の文の行の並び → { unitCharges, maxFees }。
 *  ・行だけの曜日の区分（「月-金」「土日祝」）はそのあとの行の区分にする
 *  ・「最大」「打切」の入った行は最大料金として読む（「最大料金5時間1,000円」を「5時間1,000円」の単価と読まない）
 *  ・section に "max" を渡すと全部の行を最大料金として読む（いずみパーキングの【打切り・前払い設定など】の欄）
 *  ・※ で始まる行は注意書きとして飛ばす */
export function feeFromLines(lines, { scope: scope0 = "全日", section = null } = {}) {
  let scope = scope0;
  const parts = [];
  for (const raw of lines) {
    const t = tidyFee(strip(raw)).trim();
    if (!t) continue;
    const sc = scopeLine(t);
    if (sc) { scope = sc; continue; }
    if (/^[※*＊□■◆●]/.test(t)) continue;
    parts.push(feeOf(t, { scope, section: section ?? (/最大|打切|打ち切|上限/.test(t) ? "max" : null) }));
  }
  return mergeFees(parts);
}

/** HTML の料金の欄を行に分ける（<br>・<p>・<li>・改行） */
export function linesOf(html) {
  return String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ").split(/<br\s*\/?>|<\/p>|<\/li>|<\/div>|\r?\n/i).map((x) => strip(x)).filter(Boolean);
}

/** 表の th と td の組（<th>ラベル</th><td>中身</td>）→ [ラベル（文字）, 中身（HTML）] の並び */
export function pairs(html) {
  const out = [];
  for (const m of String(html ?? "").matchAll(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) out.push([strip(m[1]), m[2]]);
  return out;
}

/** ラベルで表の中身（HTML）を引く（最初に見つかったもの） */
export function cellOf(html, re) {
  const hit = pairs(html).find(([k]) => re.test(k));
  return hit ? hit[1] : null;
}

/** 「22台」「４台」「[車: 5台]」→ 数。読めなければ null */
export function capOf(s) {
  const m = han(strip(s ?? "")).replace(/,/g, "").match(/(\d+)\s*台/);
  return m ? Number(m[1]) || null : null;
}

const inJapan = (lat, lng) => lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154;

/** 位置（緯度・経度）。Google マップの埋め込み（pb の !3d緯度!2d経度・q=緯度,経度）・data-lat/data-lng・LatLng(緯度,経度) のどれか。
 *  日本の外・0 なら null */
export function latLngOf(html) {
  const s = String(html ?? "");
  const tries = [
    () => { const a = s.match(/!3d(-?[\d.]+)/), b = s.match(/!2d(-?[\d.]+)/); return a && b ? [a[1], b[1]] : null; },
    () => { const m = s.match(/maps[^"']*?(?:[?&]|&amp;)(?:q|ll)=(-?[\d.]+)\s*,\s*(-?[\d.]+)/); return m ? [m[1], m[2]] : null; },
    () => { const m = s.match(/data-lat="(-?[\d.]+)"\s+data-lng="(-?[\d.]+)"/); return m ? [m[1], m[2]] : null; },
    () => { const m = s.match(/center="(-?[\d.]+)\s*,\s*(-?[\d.]+)"/); return m ? [m[1], m[2]] : null; },
  ];
  for (const t of tries) {
    const v = t();
    if (!v) continue;
    const lat = Number(v[0]), lng = Number(v[1]);
    if (Number.isFinite(lat) && Number.isFinite(lng) && inJapan(lat, lng)) return { lat, lng };
  }
  return { lat: null, lng: null };
}

/** 営業時間の文 → "24時間" か文のまま（空なら null） */
export function hoursOf(s) {
  const t = strip(s ?? "");
  if (!t || t === "-") return null;
  return /24\s*時間/.test(t) ? "24時間" : t;
}

/** sitemap の <loc>（CDATA でも）を全部 */
export function sitemapLocs(xml) {
  return [...String(xml ?? "").matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)\s*(?:\]\]>)?\s*<\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
}
