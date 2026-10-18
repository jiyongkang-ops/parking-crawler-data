// ナビパーク 全物件の列挙 --------------------------------------------------
// sitemap が無いため、エリア階層を辿って物件コードを収集する：
//   searchAreaList-{都道府県1..47} → parkingList-{都道府県}-{市区} → parkingDetail/{code}.html
// 収集した code 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。
//
// robots.txt に届かない・断られているときは作り直さずに例外にする（run.js が health に ok:false で出す）。
// robots.txt に届かないとき本ページを送らなくした直し（polite-fetch.js）のあと、ここはページごとに飛ばして続ける作りのままだったので、
// 47都道府県を全部飛ばして0件の一覧を書き、取得日も進めていた。そうなると7日間ナビパーク（約1,300件）を1件も回らず、
// health も「取る物件が無い＝成功」になる（2026-10-18 の点検の試しで分かった。本番では起きていない）。
// 取れた一覧が前の一覧の半分未満なら、前の一覧を使い続ける（keepPrevIfShrunk。取得日は進めない）。

import fs from "node:fs";
import { cacheFresh, markFetched, keepPrevIfShrunk } from "./cache-age.js";
import path from "node:path";
import { politeFetch, throwIfRobotsSkipped } from "./polite-fetch.js";

const ORIGIN = "https://www.navipark1.com";

export async function getAllNaviparkCodes({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  const prev = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").split("\n").filter(Boolean) : [];
  // 前の一覧が空なら、取得日が新しくても作り直す（空の一覧で7日間何もしないことにしない）
  if (prev.length && cacheFresh(abs, cacheMs)) return prev;

  const codes = new Set();
  let failed = 0;
  for (let pref = 1; pref <= 47; pref++) {
    let areaRes;
    try {
      areaRes = await politeFetch(`${ORIGIN}/searchAreaList-${pref}/`);
    } catch { failed++; continue; }
    // robots.txt で断られた・届かないときは、残りのページも同じ答えなので作り直しをやめる
    throwIfRobotsSkipped(areaRes, "ナビパーク");
    if (!areaRes.ok || areaRes.skippedReason) { failed++; continue; }
    // 市区リストURL: parkingList-{pref}-{city}
    const cities = [...new Set(
      [...areaRes.html.matchAll(/parkingList-(\d+)-(\d+)/g)].map((m) => `${m[1]}-${m[2]}`)
    )];
    for (const c of cities) {
      let listRes;
      try {
        listRes = await politeFetch(`${ORIGIN}/parkingList-${c}/`);
      } catch { failed++; continue; }
      throwIfRobotsSkipped(listRes, "ナビパーク");
      if (!listRes.ok || listRes.skippedReason) { failed++; continue; }
      for (const m of listRes.html.matchAll(/parkingDetail\/([A-Za-z0-9]+)\.html/g)) {
        codes.add(m[1]);
      }
    }
  }

  const list = [...codes];
  if (failed) console.warn(`[ナビパーク] 一覧の作り直しで取れなかったページ ${failed}件`);
  const kept = keepPrevIfShrunk("ナビパーク", list, prev);
  if (kept) return kept;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  markFetched(abs);
  return list;
}
