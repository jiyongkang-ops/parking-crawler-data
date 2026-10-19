// エコロパーク 全物件の列挙 ------------------------------------------------
// 先方が公開しているサイトマップ（/sitemap.xml → park_coin-parking-sitemap*.xml、1本1,000件）から
// 物件ID（/coin-parking/{id}/）を集める。5リクエストほどで全件がそろう。
//
// 以前はエリアページ（約198件）の1ページ目だけを読んでいた。エリアページは1ページ10件で
// ?paged=2… に続くため、各エリアの10件しか取れず、全3,945件のうち1,032件しか巡回していなかった
// （市区ごとの一覧の件数がちょうど10件で頭打ち。墨田区は2ページ目の10件が1件も一覧に無かった）。
// しかも1ページ目の並び順が 7月→9月で変わり、7月の一覧にあった約480件が一覧から外れて
// 9/13 を最後に取りに行かれなくなった（469件はサイトマップに載っており営業中。2026-10-18 確認）。
//
// サイトマップが取れないとき（401・403・429・5xx・robots.txt で見送り・通信の失敗など）は、別の経路を探さない
// （config.js の方針「取り直しを試す手段（別の経路など）は作らない」）。以前はエリアページをページ送りまで辿る予備の道に入り、
// 断られている・苦しいときに数百回送るところだった（2026-10-19 の最終点検）。前の一覧を使い続け、
// 失敗の時刻と理由を <一覧>.failed に残して20時間は作り直しを試さない（ナビパーク navipark-enumerate.js と同じ形）。
// 前の一覧が古いまま14日を超えたら staleReason を付けて health で知らせる（times-enumerate.js と同じ形）。
// 前の一覧も無ければ例外にする（空の一覧で巡回しない）。
// 収集した ID 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。

import fs from "node:fs";
import { cacheFresh, markFetched, cacheAgeMs, readFailStamp, writeFailStamp, clearFailStamp } from "./cache-age.js";
import path from "node:path";
import { politeFetch, failText } from "./polite-fetch.js";

const ORIGIN = "https://service.ecolocity.co.jp";
const SITEMAP_INDEX = `${ORIGIN}/sitemap.xml`;
const ID_RE = /coin-parking\/(\d+)\//g;
/** 取り直した一覧が前の一覧のこの割合より少なければ、作り直しの失敗とみなす（束が欠けた・中身が途中で切れたなど） */
const MIN_RATIO = 0.5;
/** 前の一覧を使い続けてよい長さ。これを過ぎたら staleReason を付けて知らせる（run.js が health に ok:false で出す） */
const STALE_WARN_MS = 14 * 864e5;
/** 作り直しに失敗したあと、次に作り直しを試すまでの間（1日3回の回のうち、おおむね1日1回にする） */
const RETRY_AFTER_FAIL_MS = 20 * 3600e3;

const readList = (abs) => fs.readFileSync(abs, "utf8").split("\n").filter(Boolean);

/** サイトマップの索引から、時間貸し物件の束（park_coin-parking-sitemap*.xml）の URL を取り出す */
export function parseSitemapIndex(xml) {
  const re = /<loc>\s*([^<\s]*\/park_coin-parking-sitemap\d*\.xml)\s*<\/loc>/g;
  return [...new Set([...String(xml).matchAll(re)].map((m) => m[1]))]
    .filter((u) => u.startsWith(`${ORIGIN}/`));   // よそのホストは辿らない
}

/** 本文から物件ID（/coin-parking/{数字}/）を重複なく取り出す */
export function parseIds(text) {
  return [...new Set([...String(text).matchAll(ID_RE)].map((m) => m[1]))];
}

// サイトマップから物件IDを集める。索引か束が1本でも取れなければ失敗にする
async function fromSitemap(fetcher) {
  const idx = await fetcher(SITEMAP_INDEX);
  if (!idx.ok || idx.skippedReason) throw new Error(`サイトマップ: ${failText(idx)}`);
  const subs = parseSitemapIndex(idx.html);
  if (!subs.length) throw new Error("サイトマップに時間貸し物件の束がありません（ページの作りの変更の可能性）");
  const ids = new Set();
  for (const u of subs) {
    const res = await fetcher(u);
    // 1本でも欠けると、その束の物件がまとめて「一覧に無い」になる。欠けたまま使わない
    if (!res.ok || res.skippedReason) throw new Error(`${u}: ${failText(res)}`);
    for (const id of parseIds(res.html)) ids.add(id);
  }
  if (!ids.size) throw new Error("サイトマップに物件が1件もありません（ページの作りの変更の可能性）");
  console.log(`[エコロパーク] サイトマップ${subs.length}本から${ids.size}件`);
  return [...ids];
}

// 物件ID一覧を返す（キャッシュ優先）。
// 作り直しに失敗したら、前の一覧があればそれを使い続ける（.fetched は進めない。次に試すのは RETRY_AFTER_FAIL_MS あと）。
// 前の一覧が無いときだけ例外にする。長く作り直せていないときは返す配列に staleReason を付ける（health は ok:false）。
// それより短いあいだは listNote を付ける（health の reason に出す。ok は true のまま）。
// fetcher はテスト用（既定は polite-fetch）。
export async function getAllEcoloIds({ cacheFile, cacheMs, fetcher = politeFetch }) {
  const abs = path.resolve(cacheFile);
  const prev = fs.existsSync(abs) ? readList(abs) : [];
  if (cacheFresh(abs, cacheMs)) {
    if (!prev.length) throw new Error("一覧がまだありません（この回は作り直しを見送り）");
    return prev;
  }
  const useOld = (why) => {
    const ageMs = cacheAgeMs(abs);
    const age = Number.isFinite(ageMs) ? `${(ageMs / 864e5).toFixed(0)}日前` : "取得日不明";
    console.warn(`::warning::[エコロパーク] 一覧を作り直せなかったので、前の一覧（${prev.length}件・${age}）を使う: ${why}`);
    if (!(ageMs < STALE_WARN_MS)) prev.staleReason = `一覧を作り直せていない（前の一覧は${age}）: ${why}`;
    else prev.listNote = `一覧を作り直せず、前の一覧（${prev.length}件・${age}）を使っている: ${why}`;
    return prev;
  };

  // 前回の作り直しが失敗して間もないなら、この回は試さない
  const failed = prev.length ? readFailStamp(abs) : null;
  if (failed) {
    const since = Date.now() - failed.at;
    if (since < RETRY_AFTER_FAIL_MS) {
      console.log(`[エコロパーク] 前回の作り直しが ${(since / 3600e3).toFixed(1)}時間前に失敗したので、この回は試さない（${RETRY_AFTER_FAIL_MS / 3600e3}時間あける）`);
      return useOld(`前回の失敗: ${failed.why}`);
    }
  }

  let list;
  try {
    list = await fromSitemap(fetcher);
    // 取り直しが途中で欠けて極端に少ないときは、前の一覧を使い続ける。
    // 欠けた一覧で上書きすると、外れた物件が取りに行かれなくなる（今回の取り残しと同じことが起きる）
    if (prev.length && list.length < prev.length * MIN_RATIO) {
      throw new Error(`一覧が ${prev.length}件 → ${list.length}件に減った（${Math.round(MIN_RATIO * 100)}%未満は作り直しの失敗とみなす）`);
    }
  } catch (e) {
    const why = e?.message ?? String(e);
    if (!prev.length) throw new Error(`一覧が取れませんでした: ${why}`);
    writeFailStamp(abs, why, (failed?.count ?? 0) + 1);
    return useOld(why);
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  markFetched(abs);
  clearFailStamp(abs);   // 失敗の記録は、作り直せたら消す
  return list;
}
