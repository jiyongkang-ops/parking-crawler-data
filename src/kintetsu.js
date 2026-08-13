// 近鉄不動産（parking.kintetsu-re.co.jp）時間貸駐車場 詳細ページのパーサ ------
// https://parking.kintetsu-re.co.jp/hourly/detail.php?id={id}
// 全てサーバ描画。全角数字・全角コロンが多用される（例「２４時間：４００円」）。
//   <h2 class="place">名称<span>【最寄り駅】</span></h2>
//   <div class="info"><table> … 住所 / 収容台数 / 車輛制限 / 特徴 / 備考
//   <table class="fee"> … <th>平日|土日祝|最大料金</th><td>料金文</td>
//   <dl class="note"><dt>備考</dt><dd>…</dd> に日数別料金が入ることがある
// 営業時間は「特徴」リストの <li>24時間営業</li>（class="no" が付くと非該当）で判定。
// robots.txt に User-agent: * のグループは無く、当ボットに対する制限は無い。

import { linesOf, scopeOf, textOf, timeRangeOf, toHalfWidth, yen } from "./zenkaku.js";

const BASE = "https://parking.kintetsu-re.co.jp/hourly/";

export function detailUrl(id) {
  return `${BASE}detail.php?id=${id}`;
}

export function listUrl(page = 0) {
  return `${BASE}list.php?page=${page}`;
}

function infoCell(html, label) {
  const m = html.match(new RegExp(`<th>\\s*${label}\\s*</th>\\s*<td[^>]*>([\\s\\S]*?)</td>`));
  return m ? m[1] : null;
}

// 料金1行 → { unitCharges[], maxFees[] } へ追記する。
function parseFeeLine(line, scope, out) {
  const t = toHalfWidth(line);
  if (!/円/.test(t)) return;
  const tr = timeRangeOf(t);

  // 1) 単価: 「60分/100円」「30分 200円」「100円/30分」いずれも拾う
  let hitUnit = false;
  for (const m of t.matchAll(/(\d+)\s*分\s*[\/／]?\s*([\d,]+)\s*円/g)) {
    out.unitCharges.push({
      scope,
      timeRange: tr ?? "全日",
      perMinutes: Number(m[1]),
      amountYen: yen(m[2]),
    });
    hitUnit = true;
  }
  if (!hitUnit) {
    for (const m of t.matchAll(/([\d,]+)\s*円\s*[\/／]\s*(\d+)\s*分/g)) {
      out.unitCharges.push({
        scope,
        timeRange: tr ?? "全日",
        perMinutes: Number(m[2]),
        amountYen: yen(m[1]),
      });
      hitUnit = true;
    }
  }
  if (hitUnit) return;

  // 2) 最大料金: 「24時間最大料金300円」「24時間:400円」「1日(24時間)200円 2日(48時間)400円」
  const maxRe = /([^\s]*?(?:\d+\s*時間|\d+\s*日|最大|終日)[^\s]*?)\s*[:：]?\s*([\d,]+)\s*円/g;
  let hitMax = false;
  for (const m of t.matchAll(maxRe)) {
    const cond = m[1].replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    out.maxFees.push({ scope, condition: cond || "最大", amountYen: yen(m[2]) });
    hitMax = true;
  }
  if (hitMax) return;

  // 3) 金額のみ（時間帯付きなら夜間最大などの想定）
  const only = t.match(/([\d,]+)\s*円/);
  if (only) out.maxFees.push({ scope, condition: tr ?? "最大", amountYen: yen(only[1]) });
}

export function parseKintetsuDetail(html, { id, label } = {}) {
  const h2 = (html.match(/<h2 class="place">([\s\S]*?)<\/h2>/) || [])[1];
  const name = h2 ? textOf(h2.replace(/<span[\s\S]*?<\/span>/g, "")) : null;

  // 住所: 「〒518-0713<br />名張市平尾２６５０」→ 郵便番号を落として本文のみ
  let address = textOf(infoCell(html, "住所"));
  if (address) address = address.replace(/〒\s*\d{3}\s*-?\s*\d{4}/, "").replace(/\s+/g, " ").trim() || null;

  const capText = textOf(infoCell(html, "収容台数"));
  const capacity = capText ? Number((capText.match(/(\d+)\s*台/) || [])[1]) || null : null;

  // 特徴リスト: class="no" が付かない <li> が「該当あり」
  const features = (html.match(/<th>\s*特徴\s*<\/th>[\s\S]*?<ul>([\s\S]*?)<\/ul>/) || [])[1] || "";
  const has24h = /<li>\s*24時間営業\s*<\/li>/.test(features);
  const openingHours = has24h ? "24時間" : null;

  const out = { unitCharges: [], maxFees: [] };
  const feeTable = (html.match(/<table class="fee">([\s\S]*?)<\/table>/) || [])[1];
  if (feeTable) {
    for (const row of feeTable.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
      const th = textOf((row.match(/<th[^>]*>([\s\S]*?)<\/th>/) || [])[1]) || "";
      const td = (row.match(/<td[^>]*>([\s\S]*?)<\/td>/) || [])[1];
      if (!td) continue;
      const scope = scopeOf(th);
      for (const line of linesOf(td)) parseFeeLine(line, scope, out);
    }
  }

  // 「備考」欄の日数別料金（例「１日：４００円 ２日：８００円」）を最大料金として補う
  const note = (html.match(/<dl class="note">[\s\S]*?<dd>([\s\S]*?)<\/dd>/) || [])[1];
  if (note) {
    const before = out.maxFees.length;
    for (const line of linesOf(note)) parseFeeLine(line, "全日", out);
    // 備考は説明文のことも多いので、単価として誤検出した分は捨てる
    if (out.maxFees.length === before) out.maxFees.splice(before);
  }

  return {
    operator: "kintetsu",
    parkId: String(id),
    label: label ?? null,
    name,
    address,
    lat: null,
    lng: null,
    capacity,
    openingHours,
    unitCharges: out.unitCharges,
    maxFees: out.maxFees,
    sourceUrl: detailUrl(id),
  };
}

// 一覧ページ（list.php）から detail.php?id= のIDと「次へ」の有無を取り出す。
export function parseKintetsuList(html) {
  const ids = [...new Set([...html.matchAll(/detail\.php\?id=(\d+)/g)].map((m) => m[1]))];
  const next = html.match(/class="next"><a href="[^"]*page=(\d+)"/);
  return { ids, nextPage: next ? Number(next[1]) : null };
}
