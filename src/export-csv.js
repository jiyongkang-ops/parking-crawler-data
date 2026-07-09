// 料金CSVの書き出し（生データ保持）-----------------------------------------
// data/*.jsonl の最新スナップショットを data/parking-latest.csv に出力する。
// 料金は円/時などに正規化せず、取得したままの生データを文字列で保持する。
// （後で必要に応じて src/normalize.js 等で計算する前提）
//
//   node src/export-csv.js

import fs from "node:fs";
import path from "node:path";

const DATA_FILES = fs
  .readdirSync(path.resolve("data"))
  .filter((f) => /^prices.*\.jsonl$/.test(f))
  .map((f) => `data/${f}`);
const OUT = "data/parking-latest.csv";

const OP = {
  npc: "NPC", repark: "三井のリパーク", times: "タイムズ",
  mkp: "名鉄協商", navipark: "ナビパーク", ecolo: "エコロパーク", thepark: "ザ・パーク",
};

// 生の時間帯単価を可読テキストに（計算はしない）
// 例: "月～金 08:00-20:00 20分220円 ; 20:00-08:00 60分110円"
function unitText(rec) {
  return (rec.unitCharges ?? [])
    .map((u) => [u.scope, u.timeRange, `${u.perMinutes}分${u.amountYen}円`].filter(Boolean).join(" "))
    .join(" ; ");
}

// 生の最大料金を可読テキストに（計算・分類はしない）
// 例: "全日 入庫後24時間以内 1400円 ; 全日 20:00～8:00以内 500円"
function maxText(rec) {
  return (rec.maxFees ?? [])
    .map((m) => [m.scope, m.condition, `${m.amountYen}円`].filter(Boolean).join(" "))
    .join(" ; ");
}

function loadLatest() {
  const latest = new Map();
  for (const f of DATA_FILES) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) continue;
    for (const line of fs.readFileSync(abs, "utf8").split("\n").filter(Boolean)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      const k = `${r.operator}:${r.parkId}`;
      const prev = latest.get(k);
      if (!prev || new Date(r.fetchedAt) >= new Date(prev.fetchedAt)) latest.set(k, r);
    }
  }
  return [...latest.values()];
}

function csvCell(v) {
  if (v == null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function main() {
  const lots = loadLatest();
  const header = [
    "事業者", "物件名", "都道府県", "住所", "収容台数",
    "時間帯料金(生)", "最大料金(生)", "営業時間", "満空",
    "緯度", "経度", "取得日時", "URL",
  ];
  const rows = lots.map((r) => {
    const pref = (r.address ?? "").match(/^(.+?[都道府県])/)?.[1] ?? "";
    return [
      OP[r.operator] ?? r.operator, r.name, pref, r.address, r.capacity,
      unitText(r), maxText(r), r.openingHours, r.fullEmptyStatus,
      r.lat, r.lng, r.fetchedAt, r.sourceUrl,
    ].map(csvCell).join(",");
  });
  // Excel 用に BOM 付き UTF-8
  const csv = "﻿" + [header.join(","), ...rows].join("\n") + "\n";
  fs.writeFileSync(path.resolve(OUT), csv);
  console.log(`CSV書き出し: ${OUT} | ${lots.length}物件`);
}

main();
