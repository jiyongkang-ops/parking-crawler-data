// システムパーク: エリアタブ（index.php?cat=N）を巡回して物件IDを列挙 --------
// タブの cat 値は一覧ページ自身に列挙されているので、まず cat=1 を取ってタブを拾い、
// 残りのタブを順に巡る（現状 9 タブ）。
import fs from "node:fs";
import { politeFetch } from "./polite-fetch.js";

const LIST_URL = (cat) => `https://systempark.biz/jisseki/index.php?cat=${cat}`;

export async function getAllSystemparkIds({ cacheFile, cacheMs = 7 * 864e5 } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) {
    const age = Date.now() - fs.statSync(cacheFile).mtimeMs;
    if (age < cacheMs) return fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean);
  }
  const ids = new Set();
  const first = await politeFetch(LIST_URL(1));
  if (!first.ok) throw new Error(`システムパーク一覧取得失敗: HTTP ${first.status}`);
  const collect = (html) => {
    for (const m of html.matchAll(/detail\.php\?id=(\d+)/g)) ids.add(m[1]);
  };
  collect(first.html);

  const cats = [...new Set([...first.html.matchAll(/index\.php\?cat=(\d+)/g)].map((m) => m[1]))]
    .filter((c) => c !== "1")
    .sort((a, b) => Number(a) - Number(b));

  for (const cat of cats) {
    const res = await politeFetch(LIST_URL(cat));
    if (!res.ok) continue;
    collect(res.html);
  }

  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  if (!list.length) throw new Error("システムパーク一覧の解析結果が0件（ページ構造変更の可能性）");
  if (cacheFile) fs.writeFileSync(cacheFile, list.join("\n") + "\n");
  return list;
}
