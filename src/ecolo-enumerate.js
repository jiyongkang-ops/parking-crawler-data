// エコロパーク 全物件の列挙 ------------------------------------------------
// 先方が公開しているサイトマップ（/sitemap.xml → park_coin-parking-sitemap*.xml、1本1,000件）から
// 物件ID（/coin-parking/{id}/）を集める。5リクエストほどで全件がそろう。
//
// 以前はエリアページ（約198件）の1ページ目だけを読んでいた。エリアページは1ページ10件で
// ?paged=2… に続くため、各エリアの10件しか取れず、全3,945件のうち1,032件しか巡回していなかった
// （市区ごとの一覧の件数がちょうど10件で頭打ち。墨田区は2ページ目の10件が1件も一覧に無かった）。
// しかも1ページ目の並び順が 7月→9月で変わり、7月の一覧にあった約480件が一覧から外れて
// 9/13 を最後に取りに行かれなくなった（469件はサイトマップに載っており営業中。2026-10-18 確認）。
// サイトマップが取れないときだけ、エリアページをページ送りまで辿る（予備）。
// 収集した ID 一覧をローカルキャッシュ。巡回状態は repark-enumerate の汎用関数を共用。

import fs from "node:fs";
import { cacheFresh, markFetched } from "./cache-age.js";
import path from "node:path";
import { politeFetch } from "./polite-fetch.js";

const ORIGIN = "https://service.ecolocity.co.jp";
const SITEMAP_INDEX = `${ORIGIN}/sitemap.xml`;
const TOP = `${ORIGIN}/park/coin-parking/`;
const AREA_RE = /coin-parking\/area\/([^"'\/]+)\//g;
const ID_RE = /coin-parking\/(\d+)\//g;
// 1エリアで辿るページの上限（10件/ページ）。いちばん多いエリアでも数十ページの見込み。止まらない事故の歯止め
const MAX_AREA_PAGES = 80;

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

/** エリアページに「次のページ」があるか */
export function hasNextPage(html) {
  return /c-pager__item -next/.test(String(html));
}

async function fromSitemap() {
  const idx = await politeFetch(SITEMAP_INDEX);
  if (idx.skippedReason) throw new Error(`サイトマップ: ${idx.skippedReason}`);
  if (!idx.ok) throw new Error(`サイトマップ HTTP ${idx.status}`);
  const subs = parseSitemapIndex(idx.html);
  if (!subs.length) throw new Error("サイトマップに時間貸し物件の束がありません");
  const ids = new Set();
  for (const u of subs) {
    const res = await politeFetch(u);
    // 1本でも欠けると、その束の物件がまとめて「一覧に無い」になる。欠けたまま使わない
    if (res.skippedReason) throw new Error(`${u}: ${res.skippedReason}`);
    if (!res.ok) throw new Error(`${u} HTTP ${res.status}`);
    for (const id of parseIds(res.html)) ids.add(id);
  }
  console.log(`[エコロパーク] サイトマップ${subs.length}本から${ids.size}件`);
  return [...ids];
}

async function fromAreaPages() {
  const top = await politeFetch(TOP);
  if (top.skippedReason) throw new Error(`ecolo top: ${top.skippedReason}`);
  if (!top.ok) throw new Error(`ecolo top HTTP ${top.status}`);
  const areas = [...new Set([...top.html.matchAll(AREA_RE)].map((m) => m[1]))];
  const ids = new Set();
  let pages = 0;
  for (const area of areas) {
    // 1ページ10件。「次のページ」が無くなるまで辿る（以前は1ページ目だけで、各エリア10件で止まっていた）
    for (let page = 1; page <= MAX_AREA_PAGES; page++) {
      const url = page === 1 ? `${TOP}area/${area}/` : `${TOP}area/${area}/?paged=${page}`;
      let res;
      try { res = await politeFetch(url); } catch { break; }
      pages++;
      if (!res.ok || res.skippedReason) break;
      const found = parseIds(res.html);
      for (const id of found) ids.add(id);
      if (!found.length || !hasNextPage(res.html)) break;
    }
  }
  console.log(`[エコロパーク] エリア${areas.length}件・${pages}ページから${ids.size}件（サイトマップの代わり）`);
  return [...ids];
}

export async function getAllEcoloIds({ cacheFile, cacheMs }) {
  const abs = path.resolve(cacheFile);
  const prev = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8").split("\n").filter(Boolean) : [];
  if (cacheFresh(abs, cacheMs)) {
    if (!prev.length) throw new Error("一覧がまだありません（この回は作り直しを見送り）");
    return prev;
  }

  // 取り直しが途中で欠けて極端に少ないときは、前の一覧を使い続ける（取得日も進めず、次の回にやり直す）。
  // 欠けた一覧で上書きすると、外れた物件が取りに行かれなくなる（今回の取り残しと同じことが起きる）
  const enough = (list) => list.length > 0 && list.length >= prev.length * 0.5;
  let list = [];
  try { list = await fromSitemap(); } catch (e) { console.warn(`[エコロパーク] サイトマップが使えません: ${e.message}`); }
  if (!enough(list)) {
    if (list.length) console.warn(`[エコロパーク] サイトマップが${list.length}件と少ない（前回${prev.length}件）。エリアページで数え直します`);
    try { list = await fromAreaPages(); } catch (e) { console.warn(`[エコロパーク] エリアページも使えません: ${e.message}`); list = []; }
  }
  if (!enough(list)) {
    if (!prev.length) throw new Error(`一覧が取れませんでした（${list.length}件）`);
    console.warn(`[エコロパーク] 一覧が${list.length}件と少ない（前回${prev.length}件）。前の一覧を使います`);
    return prev;
  }

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, list.join("\n") + "\n");
  markFetched(abs);
  return list;
}
