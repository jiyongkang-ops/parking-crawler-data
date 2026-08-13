// エムデン・テクノパーキング（m-dentechno.co.jp）一覧直載型パーサ -------------
// https://m-dentechno.co.jp/yourtown/ の1ページに全物件（約390件）が載る。
// <section class="area_col"> がエリア単位、<h2 id="xxx_area"> がエリア名、
// <div class="data"><table> の各 <tr> が1物件で
//   [名前, 住所, 駐車台数, 駐車料金] の4セル。列挙モジュールは不要。
// 料金表記の例（全角ｈ・全角数字混在）:
//   "60分100円・12ｈ500円"
//   "60分100円・24ｈ500円 20-8時（12ｈ300円）"
//   "0-8時（120分100円）・8-24時（60分100円）・20-8時（400円）"
//   "2時間100円・24ｈ400円"
// robots.txt は /M_den/wp-admin/ のみ Disallow。

import { textOf, toHalfWidth, yen } from "./zenkaku.js";

const PAGE_URL = "https://m-dentechno.co.jp/yourtown/";

export function listUrl() {
  return PAGE_URL;
}

// "20-8時" / "0-8時" → "20:00-8:00"
function hourRange(a, b) {
  return `${Number(a)}:00-${Number(b)}:00`;
}

// 括弧なしの料金断片（例 "60分100円" / "12h500円" / "2時間100円" / "400円"）を解釈する。
// timeRange が与えられた場合はその時間帯に属する料金として扱う。
function parseFragment(frag, timeRange, out) {
  const t = toHalfWidth(frag);
  let hit = false;

  // 単価: N分M円 / N時間M円（ただし "12時間500円" のような打切りと紛れるため
  // 「時間」表記は 1〜3時間までを単価とみなす。それ以上は最大料金扱い）
  for (const m of t.matchAll(/(\d+)\s*分\s*([\d,]+)\s*円/g)) {
    out.unitCharges.push({
      scope: "全日",
      timeRange: timeRange ?? "全日",
      perMinutes: Number(m[1]),
      amountYen: yen(m[2]),
    });
    hit = true;
  }
  for (const m of t.matchAll(/(\d+)\s*時間\s*([\d,]+)\s*円/g)) {
    const hours = Number(m[1]);
    if (hours <= 3) {
      out.unitCharges.push({
        scope: "全日",
        timeRange: timeRange ?? "全日",
        perMinutes: hours * 60,
        amountYen: yen(m[2]),
      });
    } else {
      out.maxFees.push({
        scope: "全日",
        condition: [timeRange, `${hours}時間最大`].filter(Boolean).join(" "),
        amountYen: yen(m[2]),
      });
    }
    hit = true;
  }

  // 打切り: Nh M円（ｈ/h/H いずれも半角化済み）
  for (const m of t.matchAll(/(\d+)\s*h\s*([\d,]+)\s*円/gi)) {
    out.maxFees.push({
      scope: "全日",
      condition: [timeRange, `${Number(m[1])}時間最大`].filter(Boolean).join(" "),
      amountYen: yen(m[2]),
    });
    hit = true;
  }

  if (hit) return;

  // 上記に当たらず金額だけ（例 "20-8時（400円）"）→ その時間帯の最大料金
  const only = t.match(/([\d,]+)\s*円/);
  if (only) {
    out.maxFees.push({
      scope: "全日",
      condition: timeRange ? `${timeRange} 最大` : "最大",
      amountYen: yen(only[1]),
    });
  }
}

// 駐車料金セル全体 → { unitCharges, maxFees }
export function parseMdenFee(raw) {
  const out = { unitCharges: [], maxFees: [] };
  let t = toHalfWidth(textOf(raw) || "");
  if (!t) return out;

  // 1) 「H-H時（...）」の時間帯ブロックを先に切り出す
  const blockRe = /(\d{1,2})\s*時?\s*-\s*(\d{1,2})\s*時\s*\(([^)]*)\)/g;
  let m;
  const consumed = [];
  while ((m = blockRe.exec(t)) !== null) {
    parseFragment(m[3], hourRange(m[1], m[2]), out);
    consumed.push([m.index, m.index + m[0].length]);
  }
  // 2) 残り（時間帯指定なし）を解釈
  let rest = "";
  let cursor = 0;
  for (const [s, e] of consumed) {
    rest += t.slice(cursor, s) + "・";
    cursor = e;
  }
  rest += t.slice(cursor);

  for (const frag of rest.split(/[・,、]|\s{2,}/)) {
    if (!frag.trim()) continue;
    parseFragment(frag, null, out);
  }
  return out;
}

// 一覧HTML → レコード配列
export function parseMdenList(html) {
  const records = [];
  const seen = new Map(); // parkId 重複回避
  const sections = html.match(/<section class="area_col">[\s\S]*?<\/section>/g) || [];

  for (const sec of sections) {
    const h2 = sec.match(/<h2[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/h2>/);
    const areaId = h2 ? h2[1] : "";

    for (const dataDiv of sec.match(/<div class="data">[\s\S]*?<\/div>/g) || []) {
      for (const tr of dataDiv.match(/<tr>[\s\S]*?<\/tr>/g) || []) {
        const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => textOf(x[1]));
        if (tds.length < 4) continue;
        const [name, address, capRaw, feeRaw] = tds;
        if (!name) continue;

        const capacity = Number((toHalfWidth(capRaw || "").match(/(\d+)/) || [])[1]) || null;
        const { unitCharges, maxFees } = parseMdenFee(feeRaw);

        // 物件IDが振られていないため、名称を安定IDとして使う（重複時は連番を付す）
        let parkId = name.replace(/\s+/g, "");
        if (seen.has(parkId)) {
          const n = seen.get(parkId) + 1;
          seen.set(parkId, n);
          parkId = `${parkId}-${n}`;
        } else {
          seen.set(parkId, 1);
        }

        records.push({
          operator: "mden",
          parkId,
          label: null, // エリア名(areaName)は sourceUrl のアンカーで判別できるため未使用
          name,
          address: address || null,
          lat: null,
          lng: null,
          capacity,
          openingHours: null,
          unitCharges,
          maxFees,
          sourceUrl: areaId ? `${PAGE_URL}#${areaId}` : PAGE_URL,
        });
      }
    }
  }
  return records;
}
