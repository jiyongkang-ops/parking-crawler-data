// NTTル・パルク: attr 一覧から NRP ID を列挙 -----------------------------------
// 【制約】一覧の3ページ目以降（?start=40〜）はサイト側が 403 を返す（Cookie/Referer
// を付けても同じ）。連続取得を拒否する意思表示とみなし、取得できる 2ページ＝
// 上位40件のみを対象とする（全475件の一部）。総当たりでのID推測は行わない。
import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import { politeFetch } from "./polite-fetch.js";

// 取りに行くのは start=0・20 の2ページだけ。3ページ目（start=40）以降は 403 と分かっているので送らない。
// 以前はループが start<2000 のままで、7日ごとの一覧の作り直しのたびに 403 の3ページ目を1回叩いていた（2026-10-18）
export const MAX_START = 40;
const LIST_URL = (start) => start === 0 ? "https://sasp.mapion.co.jp/b/leperc/attr/" : `https://sasp.mapion.co.jp/b/leperc/attr/?start=${start}`;

export async function getAllLeparcIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    if (cacheFresh(cacheFile, cacheMs)) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const ids = new Set();
  for (let start = 0; start < MAX_START; start += 20) {
    const res = await politeFetch(LIST_URL(start));
    if (!res.ok) break;
    const found = [...res.html.matchAll(/\/b\/leperc\/info\/(NRP\d+)\//g)].map((m) => m[1]);
    const before = ids.size;
    found.forEach((x) => ids.add(x));
    if (found.length === 0 || ids.size === before) break; // 末尾（新規なし）
  }
  const list = [...ids].sort();
  if (!list.length) throw new Error("ル・パルク一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  if (cacheFile) markFetched(cacheFile);
  return list;
}
