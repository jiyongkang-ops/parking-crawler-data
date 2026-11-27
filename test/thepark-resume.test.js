// ザ・パークの一覧の取り直しと続き（2026-11-27 本人「全部直して」）。
// 11/13〜11/27 は毎回どこかで1ページだけ HTTP 500 が返り、そこで打ち切って次の回はまた1ページ目から読んでいたので、
// 一度も最後まで届かなかった。5xx は待って取り直し、だめなら飛ばし、止まったら次の回にそこから続ける。
// fetch は test/run-crawl.js で差し替える（事業者サイトには繋がない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCrawl } from "./run-crawl.js";
import { listUrl } from "../src/thepark.js";
import { readProgress, writeProgress, RESUME_MS } from "../src/list-progress.js";

const ENV = { CRAWL_ONLY: "thepark", PAGE_CACHE_MS: "0", RETRY_WAITS_MS: "0,0" };
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);

/** ids を10件ずつのページにした routes */
const pagesOf = (ids, total = ids.length) => {
  const pages = Math.max(1, Math.ceil(total / 10)), routes = {};
  for (let n = 0; n < pages; n++)
    routes[listUrl(n)] = { status: 200, body: JSON.stringify({ pagination: { size: 10, total_elements: total, total_pages: pages, number: n },
      data: ids.slice(n * 10, n * 10 + 10).map((i) => ({ id: String(i), facility_id: `TP-${String(i).padStart(5, "0")}`, name: `ザ・パークテスト${i}`,
        prefecture_name: "東京都", city_name: "千代田区", address1: `${i}`, latitude: 35.6, longitude: 139.7, use_in_website: true,
        fee_info: { left_label: "全日", normal_left_value: "オールタイム　30分　100円", max_left_value: "なし" } })) }) };
  return routes;
};
const ids50 = Array.from({ length: 50 }, (_, i) => i + 1);
const proxyCalls = (r) => r.calls.filter((u) => u.includes("/proxy/")).map((u) => Number(new URL(u).searchParams.get("number")));
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "data/thepark-crawl-state.json"), "utf8"));
const progFile = (dir) => path.join(dir, "data/thepark-list-progress.json");

test("1回だけの 500 は、待って同じページを取り直す。最後まで読めれば全部取れた回", () => {
  const routes = pagesOf(ids50);
  routes[listUrl(2)] = [{ status: 500 }, routes[listUrl(2)]];
  const r = runCrawl({ env: ENV, routes });
  assert.deepEqual(proxyCalls(r), [0, 1, 2, 2, 3, 4]);
  assert.deepEqual([r.health[0].ok, r.health[0].n, r.health[0].retried], [true, 50, 1]);
  assert.equal(Object.values(readState(r.dir)).filter((d) => d === today).length, 50);
  assert.equal(fs.existsSync(progFile(r.dir)), false);
});

test("取り直してもだめなページは飛ばして先へ。最後にもう1回読んで取れれば全部取れた回", () => {
  const routes = pagesOf(ids50);
  routes[listUrl(1)] = [{ status: 500 }, { status: 503 }, { throw: "ECONNRESET" }, routes[listUrl(1)]];
  const r = runCrawl({ env: ENV, routes });
  assert.deepEqual(proxyCalls(r), [0, 1, 1, 1, 2, 3, 4, 1]);
  assert.deepEqual([r.health[0].ok, r.health[0].n], [true, 50]);
});

test("続けて2ページ取れなければ止めて、次の回はそこから続ける（飛ばしたページは最後に読む）", () => {
  const ok = pagesOf(ids50);
  const r1 = runCrawl({ env: ENV, routes: { ...ok, [listUrl(1)]: { status: 500 }, [listUrl(2)]: { status: 500 } } });
  assert.deepEqual(proxyCalls(r1), [0, 1, 1, 1, 2, 2, 2]);
  assert.deepEqual([r1.health[0].ok, r1.health[0].kind, r1.health[0].resumeAt], [false, "network", 3]);
  assert.match(r1.health[0].reason, /3ページ目: HTTP 500（10物件まで読んだ・続きは次の回に3ページ目から）/);
  assert.equal(fs.existsSync(path.join(r1.dir, "data/thepark-crawl-state.json")), false);   // 全部は取れていないので書かない
  const p = readProgress(progFile(r1.dir));
  assert.deepEqual([p.next, p.ids.length, p.pages, p.total, p.skipped], [2, 10, 5, 50, [1]]);
  // 次の回: 3ページ目から読み、最後に飛ばした2ページ目を読む。1ページ目は読み直さない
  const r2 = runCrawl({ env: ENV, dir: r1.dir, routes: ok });
  assert.deepEqual(proxyCalls(r2), [2, 3, 4, 1]);
  assert.deepEqual([r2.health[0].ok, r2.health[0].n], [true, 50]);
  assert.match(r2.log, /前の回の続きから読む: 3ページ目から/);
  assert.equal(Object.values(readState(r2.dir)).filter((d) => d === today).length, 50);
  assert.equal(fs.existsSync(progFile(r2.dir)), false);
});

test("読み始めて24時間より前の続きは使わず、1ページ目から読む", () => {
  const ok = pagesOf(ids50);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tp-resume-"));
  writeProgress(progFile(dir), { startedAt: new Date(Date.now() - RESUME_MS - 60_000).toISOString(), next: 3, pages: 5, total: 50, ids: ["TP-00001"] });
  const r = runCrawl({ env: ENV, dir, routes: ok });
  assert.deepEqual(proxyCalls(r), [0, 1, 2, 3, 4]);
  assert.equal(r.health[0].ok, true);
});

test("相手先の一時的な不調で止まっても、この回にページが進み、2日以内に全部取れていれば知らせない（ok）", () => {
  const ok = pagesOf(ids50);
  const files = { "data/thepark-crawl-state.json": JSON.stringify({ "TP-00001": yesterday }), "data/thepark-ids.txt": "TP-00001\n" };
  const r = runCrawl({ env: ENV, files, routes: { ...ok, [listUrl(3)]: { status: 500 }, [listUrl(4)]: { status: 500 } } });
  assert.deepEqual([r.health[0].ok, r.health[0].resumeAt], [true, 5]);
  assert.match(r.health[0].reason, /続きは次の回に5ページ目から/);
  // 全部取れたのが3日前なら知らせる
  const old = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  const files2 = { "data/thepark-crawl-state.json": JSON.stringify({ "TP-00001": old }), "data/thepark-ids.txt": "TP-00001\n" };
  const r2 = runCrawl({ env: ENV, files: files2, routes: { ...ok, [listUrl(3)]: { status: 500 }, [listUrl(4)]: { status: 500 } } });
  assert.equal(r2.health[0].ok, false);
});

test("robots.txt で断られた・4xx は取り直さず、すぐ止める", () => {
  const ok = pagesOf(ids50);
  const r = runCrawl({ env: ENV, routes: { ...ok, [listUrl(1)]: { status: 404 } } });
  assert.deepEqual(proxyCalls(r), [0, 1]);
  assert.equal(r.health[0].ok, false);
  assert.match(r.health[0].reason, /2ページ目: HTTP 404/);
  const rb = runCrawl({ env: ENV, routes: { ...ok, "https://www.dkparking.com/robots.txt": { status: 403 } } });
  assert.deepEqual(proxyCalls(rb), []);
  assert.deepEqual([rb.health[0].ok, rb.health[0].kind], [false, "blocked"]);
});
