// タイムズ全物件の列挙 -----------------------------------------------------
// 物件一覧は sitemap（index → 子3ファイル）に直接掲載されている。
// 抽出した個別物件URL一覧をローカルにキャッシュ（12MB級の生XMLは保持しない）。
// 巡回状態の管理は repark-enumerate の汎用関数を共用する。

import fs from "node:fs";
import { cacheFresh, markFetched, cacheAgeMs } from "./cache-age.js";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const SITEMAP_INDEX = "https://times-info.net/parkdetails_index.xml";
const DETAIL_RE = /https:\/\/times-info\.net\/P\d+-[a-z]+\/C\d+\/park-detail-BUK\d+\//g;
/** 作り直した一覧が前の一覧のこの割合より少なければ、作り直しの失敗とみなす。
 *  実績（2026-07〜10 の6回）: いちばん減った回でも1週間で44件（0.2%）。子 sitemap が1つ欠けると約3分の1が減る */
const MIN_RATIO = 0.9;
/** 前の一覧を使い続けてよい長さ。これを過ぎたら巡回は続けつつ、health で知らせる（run.js） */
const STALE_WARN_MS = 14 * 864e5;

const readList = (abs) => fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);

// sitemap から個別物件URLを集める。子 sitemap が1つでも取れなければ失敗にする
// （以前は飛ばして続け、欠けた一覧を「作り直した」と記録していた。そうなると7日間は約3分の1の物件を回らない）
async function fetchList(fetcher) {
  const idxRes = await fetcher(SITEMAP_INDEX);
  if (idxRes.skippedReason) throw new Error(`sitemap index: ${idxRes.skippedReason}`);
  if (!idxRes.ok) throw new Error(`sitemap index HTTP ${idxRes.status}`);
  const childUrls = [...idxRes.html.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  if (!childUrls.length) throw new Error("sitemap index に子 sitemap がありません（ページの作りの変更の可能性）");

  const urls = new Set();
  for (const child of childUrls) {
    const res = await fetcher(child);
    if (!res.ok || res.skippedReason) throw new Error(`子sitemap取得失敗: ${child}（${res.skippedReason ?? "HTTP " + res.status}）`);
    for (const m of res.html.matchAll(DETAIL_RE)) urls.add(m[0]);
  }
  return [...urls];
}

// 個別物件URL一覧を返す（キャッシュ優先）。
// 作り直しに失敗したら、前の一覧があればそれを使い続ける（.fetched は進めないので、次の回にまた作り直す）。
// 以前は sitemap の取得に失敗すると例外でタイムズの回がまるごと止まっていた。
// 前の一覧を使ったときは返す配列に staleReason を付ける（長く作り直せていないときだけ。run.js が health に出す）。
// fetcher はテスト用（既定は polite-fetch）。
export async function getAllParkUrls({ cacheFile, cacheMs, fetcher = politeFetch }) {
  const abs = path.resolve(cacheFile);
  if (cacheFresh(abs, cacheMs)) return readList(abs);
  const old = fs.existsSync(abs) ? readList(abs) : null;
  let list;
  try {
    list = await fetchList(fetcher);
    if (old && list.length < old.length * MIN_RATIO) {
      throw new Error(`一覧が ${old.length}件 → ${list.length}件に減った（${Math.round(MIN_RATIO * 100)}%未満は作り直しの失敗とみなす）`);
    }
  } catch (e) {
    if (!old?.length) throw e;
    const ageMs = cacheAgeMs(abs);
    console.warn(`::warning::[times] 一覧を作り直せなかったので、前の一覧（${old.length}件・${Number.isFinite(ageMs) ? `${(ageMs / 864e5).toFixed(0)}日前` : "取得日不明"}）を使う: ${e.message}`);
    if (!(ageMs < STALE_WARN_MS)) old.staleReason = `一覧を作り直せていない（${Number.isFinite(ageMs) ? `${(ageMs / 864e5).toFixed(0)}日前の一覧` : "取得日不明"}）: ${e.message}`;
    return old;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  markFetched(abs);
  return list;
}
