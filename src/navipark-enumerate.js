// ナビパーク 全物件の列挙 --------------------------------------------------
// sitemap が無いため、エリア階層を辿って物件コードを収集する：
//   searchAreaList-{都道府県1..47} → parkingList-{都道府県}-{市区} → parkingDetail/{code}.html
// 収集した code 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。

import fs from "node:fs";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const ORIGIN = "https://www.navipark1.com";

export async function getAllNaviparkCodes({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  if (fs.existsSync(abs) && Date.now() - fs.statSync(abs).mtimeMs < cacheMs) {
    return fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);
  }

  const codes = new Set();
  for (let pref = 1; pref <= 47; pref++) {
    let areaRes;
    try {
      areaRes = await politeFetch(`${ORIGIN}/searchAreaList-${pref}/`);
    } catch { continue; }
    if (!areaRes.ok || areaRes.skippedReason) continue;
    // 市区リストURL: parkingList-{pref}-{city}
    const cities = [...new Set(
      [...areaRes.html.matchAll(/parkingList-(\d+)-(\d+)/g)].map((m) => `${m[1]}-${m[2]}`)
    )];
    for (const c of cities) {
      let listRes;
      try {
        listRes = await politeFetch(`${ORIGIN}/parkingList-${c}/`);
      } catch { continue; }
      if (!listRes.ok || listRes.skippedReason) continue;
      for (const m of listRes.html.matchAll(/parkingDetail\/([A-Za-z0-9]+)\.html/g)) {
        codes.add(m[1]);
      }
    }
  }

  const list = [...codes];
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  return list;
}
