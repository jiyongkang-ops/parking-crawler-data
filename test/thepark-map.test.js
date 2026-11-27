// ザ・パークを地図の口で読む（2026-11-27 本人「ザ・パークの地図用の口も作って」）。
// 偽の地図の口: 範囲の中の駐車場を、範囲の真ん中に近い順に最大100件返す（本物と同じ決まり）。
// fetch は test/run-crawl.js で差し替える（事業者サイトには繋がない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCrawl } from "./run-crawl.js";
import { listUrl, mapUrl, splitBox, MAP_CAP, JAPAN_BOX, parseTheparkMap } from "../src/thepark.js";
import { readProgress } from "../src/list-progress.js";

const ENV = { CRAWL_ONLY: "thepark", PAGE_CACHE_MS: "0", RETRY_WAITS_MS: "0,0" };
const today = new Date().toISOString().slice(0, 10);

/** 駐車場 n 件（東京・大阪・福岡のまわりに散らす。番号 TP-00001…） */
function lotsOf(n) {
  const centers = [[35.68, 139.76], [34.70, 135.50], [33.59, 130.40]];
  return Array.from({ length: n }, (_, i) => {
    const [la, ln] = centers[i % 3];
    const k = Math.floor(i / 3);
    return { id: String(i + 1), facility_id: `TP-${String(i + 1).padStart(5, "0")}`, name: `ザ・パークテスト${i + 1}`,
      prefecture_name: "東京都", city_name: "千代田区", address1: `${i + 1}`,
      latitude: +(la + ((k * 37) % 100) * 0.003).toFixed(6), longitude: +(ln + ((k * 61) % 100) * 0.003).toFixed(6),
      parking_lot_capacity: 5, use_in_website: true, emergency_contact: "000-0000-0000",
      fee_info: { left_label: "全日", normal_left_value: "オールタイム　30分　100円", max_left_value: "なし" } };
  });
}
/** 範囲の答え（真ん中に近い順に最大100件） */
function answer(lots, [n, w, s, e]) {
  const cLat = (n + s) / 2, cLng = (w + e) / 2;
  return lots.filter((p) => p.latitude <= n && p.latitude >= s && p.longitude >= w && p.longitude <= e)
    .sort((a, b) => (a.latitude - cLat) ** 2 + (a.longitude - cLng) ** 2 - ((b.latitude - cLat) ** 2 + (b.longitude - cLng) ** 2))
    .slice(0, MAP_CAP);
}
/** 地図の口を全国から分けて読んだときの、範囲ごとの答え（routes）と読む順の範囲 */
function mapRoutes(lots) {
  const routes = {}, boxes = [], queue = [JAPAN_BOX];
  while (queue.length) {
    const b = queue.shift();
    const a = answer(lots, b);
    routes[mapUrl(b)] = { status: 200, body: JSON.stringify(a) };
    boxes.push(b);
    if (a.length >= MAP_CAP) queue.push(...splitBox(b));
  }
  return { routes, boxes };
}
/** 一覧の口（1ページ10件） */
function pageRoutes(lots, total = lots.length) {
  const pages = Math.max(1, Math.ceil(total / 10)), routes = {};
  for (let n = 0; n < pages; n++)
    routes[listUrl(n)] = { status: 200, body: JSON.stringify({ pagination: { size: 10, total_elements: total, total_pages: pages, number: n },
      data: lots.slice(n * 10, n * 10 + 10) }) };
  return routes;
}
const mapCalls = (r) => r.calls.filter((u) => u.includes("/hourly/map?"));
const listCalls = (r) => r.calls.filter((u) => u.includes("/hourly?number="));
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "data/thepark-crawl-state.json"), "utf8"));

test("地図の口: 100件返った範囲を4つに分けて全国を読み、最後に一覧の1ページ目で件数を確かめる", () => {
  const lots = lotsOf(330);
  lots[5].use_in_website = false;                       // サイトに出さない物件は記録しない
  const { routes, boxes } = mapRoutes(lots);
  const r = runCrawl({ env: ENV, routes: { ...routes, ...pageRoutes(lots) } });
  assert.deepEqual(mapCalls(r), boxes.map(mapUrl));
  assert.deepEqual(listCalls(r), [listUrl(0)]);         // 一覧の口は件数を確かめる1回だけ
  // 回数は駐車場の散らばり方で決まる（見本の330件では一覧の口の33ページより多いが、本物の3,811件の座標で数えると約230回・一覧の口は約440ページ）
  assert.deepEqual([r.health[0].ok, r.health[0].n, r.health[0].mode, r.health[0].excluded], [true, 329, "map", 1]);
  assert.equal(Object.values(state(r.dir)).filter((d) => d === today).length, 329);
  assert.equal(fs.existsSync(path.join(r.dir, "data/thepark-list-progress.json")), false);
  // 緊急連絡先などの項目は記録に入れない
  assert.doesNotMatch(fs.readFileSync(path.join(r.dir, "data/prices-test.jsonl"), "utf8"), /000-0000-0000|emergency/);
});

test("地図の口: 取れない範囲は飛ばして最後に読み直す。続けて2か所取れなければ止めて、次の回は残りの範囲から", () => {
  const lots = lotsOf(330);
  const { routes, boxes } = mapRoutes(lots);
  const all = { ...routes, ...pageRoutes(lots) };
  const [b1, b2] = [boxes[1], boxes[2]];
  const r1 = runCrawl({ env: ENV, routes: { ...all, [mapUrl(b1)]: { status: 500 }, [mapUrl(b2)]: { status: 503 } } });
  assert.equal(r1.health[0].ok, false);
  assert.match(r1.health[0].reason, /地図の口（2回目）: HTTP 503.*続きは次の回に残りの範囲から/);
  const p = readProgress(path.join(r1.dir, "data/thepark-list-progress.json"));
  assert.equal(p.mode, "map");
  assert.deepEqual(p.skippedBoxes, [b1]);
  assert.equal(p.queue[0].join(), b2.join());
  // 次の回: 残りの範囲から読み、飛ばした範囲は最後に読む。全国の範囲は読み直さない
  const r2 = runCrawl({ env: ENV, dir: r1.dir, routes: all });
  assert.ok(!mapCalls(r2).includes(mapUrl(JAPAN_BOX)));
  assert.ok(mapCalls(r2).indexOf(mapUrl(b1)) > mapCalls(r2).indexOf(mapUrl(b2)));   // 飛ばした範囲は後で読む
  assert.deepEqual([r2.health[0].ok, r2.health[0].n], [true, 330]);
  assert.match(r2.log, /前の回の続きから読む（地図の口）/);
});

test("地図の口が無い（404）・件数が一覧と合わないときは、一覧の口で読み直す", () => {
  const lots = lotsOf(60);
  const r = runCrawl({ env: ENV, routes: { ...pageRoutes(lots), [mapUrl(JAPAN_BOX)]: { status: 404 } } });
  assert.deepEqual([r.health[0].ok, r.health[0].n, r.health[0].mode], [true, 60, "pages"]);
  assert.match(r.log, /::warning::\[thepark\] 地図の口: HTTP 404。一覧の口で読み直す/);
  // 地図に出ない（座標の無い）物件があって、一覧より少ない
  const noGeo = lotsOf(60).map((p, i) => (i < 5 ? { ...p, latitude: null, longitude: null } : p));
  const { routes } = mapRoutes(noGeo.filter((p) => p.latitude));
  const r2 = runCrawl({ env: ENV, routes: { ...routes, ...pageRoutes(noGeo) } });
  assert.match(r2.log, /地図の口で読めたのは55件.*一覧は60件。一覧の口で読み直す/);
  assert.deepEqual([r2.health[0].ok, r2.health[0].n, r2.health[0].mode], [true, 60, "pages"]);
});

test("地図の口の答えを読む: 配列でも { data } でもよい。形が違えば null", () => {
  const lots = lotsOf(3);
  assert.equal(parseTheparkMap(JSON.stringify(lots)).records.length, 3);
  assert.equal(parseTheparkMap({ data: lots }).listed, 3);
  assert.equal(parseTheparkMap("<html></html>"), null);
  assert.equal(parseTheparkMap({ foo: 1 }), null);
});
