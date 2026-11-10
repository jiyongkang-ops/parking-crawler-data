// 台数を読む（2026-11-10 本人指示「できるところは全て実施して」）。事業者サイトには繋がない（取得は偽物に差し替える）。
//   ・ナビパーク: 今も毎回読んでいる詳細ページの「時間貸区画 N台」（読み込みは増やさない）
//   ・GSパーク・三菱地所パークス: 一覧には台数が無いので、一覧を取り終えたあとに詳細ページを月1回だけ読み、控えから記録に付ける
//   ・料金が変わっていなくても、台数が初めて入った物件は記録に1回だけ足す（record-gap.js）
// 見本は test/fixtures/caps/（2026-11-10 に1枚ずつ取った詳細ページの、台数の部分だけ）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, runCrawl } from "./run-crawl.js";
import { parseNaviparkDetail } from "../src/navipark.js";
import { gsparkCapOf, mecparksCapOf, loadCaps, saveCaps, applyCap, dueIds, refreshCaps, CAP_UNREADABLE_STOP, CAP_FAIL_STOP } from "../src/detail-caps.js";
import { gapFilled } from "../src/record-gap.js";
import { areaListUrl } from "../src/gspark.js";
import { listUrl, detailUrl as mecDetailUrl } from "../src/mecparks.js";

const FX = path.join(ROOT, "test/fixtures/caps");
const fx = (f) => fs.readFileSync(path.join(FX, f), "utf8");
const DAY = 864e5;

test("ナビパーク: 詳細ページの「時間貸区画」を台数にする（その他区画は入れない・0台や読めないときは null）", () => {
  assert.equal(parseNaviparkDetail(fx("navipark-N02468.html"), { code: "N02468" }).capacity, 4);
  const t = (a, b) => `<table><tr><th>時間貸区画</th><td>${a}</td><th>その他区画</th><td>${b}</td></tr></table>`;
  assert.equal(parseNaviparkDetail(t("１２台", "3台")).capacity, 12);      // 全角の数字
  assert.equal(parseNaviparkDetail(t("0台", "20台")).capacity, null);      // 時間貸しが0台（月極だけ）
  assert.equal(parseNaviparkDetail(t("-", "0台")).capacity, null);
  assert.equal(parseNaviparkDetail("<table><tr><th>その他区画</th><td>8台</td></tr></table>").capacity, null);
  assert.equal(parseNaviparkDetail("").capacity, null);
});

test("GSパーク・三菱地所パークス: 詳細ページの台数を読む", () => {
  assert.equal(gsparkCapOf(fx("gspark-929-3.html")), 5);
  assert.equal(mecparksCapOf(fx("mecparks-28514.html")), 185);
  assert.equal(gsparkCapOf("<tr><th>台数</th><td>２０台</td></tr>"), 20);
  assert.equal(gsparkCapOf("<tr><th>台数</th><td>-</td></tr>"), null);
  assert.equal(gsparkCapOf("<p>メンテナンス中です</p>"), null);
  assert.equal(mecparksCapOf('<div class="a">収容台数</div>\n<div class="b">0台</div>'), null);
  assert.equal(mecparksCapOf(""), null);
});

test("台数が初めて入った物件は、料金が同じでも1回だけ記録に足す（値が変わっただけ・無くなっただけでは足さない）", () => {
  const base = { operator: "gspark", parkId: "1", name: "P", address: "東京都千代田区鍛冶町2-1-3", lat: null, lng: null, capacity: null };
  assert.equal(gapFilled(base, { ...base, capacity: 5 }), "台数");
  assert.equal(gapFilled({ ...base, capacity: 0 }, { ...base, capacity: 5 }), "台数");
  assert.equal(gapFilled({ ...base, capacity: 5 }, { ...base, capacity: 6 }), null);
  assert.equal(gapFilled({ ...base, capacity: 5 }, { ...base, capacity: null }), null);
  assert.equal(gapFilled(base, { ...base, capacity: null }), null);
  // 満空のある社（座標を見ない社）でも台数は足す
  assert.equal(gapFilled({ ...base, operator: "npc" }, { ...base, operator: "npc", capacity: 3 }, { coords: false }), "台数");
});

test("控え: 一覧の物件に台数を付ける・番の来た物件（控えに無い → 30日たった古い順）", () => {
  const now = Date.parse("2026-11-10T00:00:00Z");
  const caps = new Map([
    ["a", { c: 5, at: new Date(now - 3 * DAY).toISOString() }],
    ["b", { c: 7, at: new Date(now - 40 * DAY).toISOString() }],
    ["c", { c: null, at: new Date(now - 31 * DAY).toISOString() }],
  ]);
  const rec = { parkId: "a", capacity: null };
  assert.equal(applyCap(rec, caps), true);
  assert.equal(rec.capacity, 5);
  assert.equal(applyCap({ parkId: "a", capacity: 9 }, caps), false);   // 一覧に台数があればそちら
  assert.equal(applyCap({ parkId: "c", capacity: null }, caps), false);
  assert.equal(applyCap({ parkId: "z", capacity: null }, caps), false);
  assert.deepEqual(dueIds(["a", "b", "c", "x", "y", "x"], caps, { now }), ["x", "y", "b", "c"]);
  assert.deepEqual(dueIds(["a", "b", "c", "x", "y"], caps, { now, limit: 3 }), ["x", "y", "b"]);
  assert.deepEqual(dueIds(["a"], caps, { now }), []);
});

/** 偽の取得。答えの表（URL → { status, body } か "throw"）と、呼ばれた URL の控え */
function fakeFetch(table, dflt = { status: 200, body: "" }) {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    const r = table[url] ?? dflt;
    if (r === "throw") { const e = new TypeError("fetch failed"); e.cause = { code: "ECONNRESET" }; throw e; }
    return { ok: r.status >= 200 && r.status < 300, status: r.status, html: r.body ?? "", ...(r.extra ?? {}) };
  };
  f.calls = calls;
  return f;
}
const quiet = { log() {}, warn() {}, error() {} };
const urlOf = (id) => `https://example.test/p/${id}`;
const capPage = (n) => `<tr><th>台数</th><td>${n}台</td></tr>`;

test("詳細の取り方: 読めたら控えに入れる・閉鎖（404）と台数の無いページは時刻だけ進める・取れない答えは進めない", async () => {
  const caps = new Map([["gone", { c: 3, at: "2026-01-01T00:00:00Z" }]]);
  const f = fakeFetch({ [urlOf("ok")]: { status: 200, body: capPage(8) }, [urlOf("gone")]: { status: 404 },
    [urlOf("nocap")]: { status: 200, body: "<p>台数の無いページ</p>" }, [urlOf("err")]: { status: 503 } });
  const sum = await refreshCaps({ ids: ["ok", "gone", "nocap", "err"], caps, urlOf, capOf: gsparkCapOf, fetchPage: f, log: quiet });
  assert.deepEqual([sum.tried, sum.got, sum.unreadable, sum.failed, sum.stop], [4, 1, 1, 1, null]);
  assert.equal(caps.get("ok").c, 8);
  assert.deepEqual([caps.get("gone").c, caps.get("gone").gone], [3, 404]);   // 前の台数は残す
  assert.equal(caps.get("nocap").c, null);
  assert.equal(caps.has("err"), false);                                        // 次の回にまた取る
});

test("詳細の取り方: robots.txt で断られたら止める（時刻は進めない）。上限の件数まで", async () => {
  const caps = new Map();
  const f = fakeFetch({}, { status: null, extra: { blocked: true, skippedReason: "robots.txt で断られた" } });
  const sum = await refreshCaps({ ids: ["a", "b", "c"], caps, urlOf, capOf: gsparkCapOf, fetchPage: f, log: quiet });
  assert.deepEqual([sum.tried, sum.stop, caps.size, f.calls.length], [1, "robots.txt で断られた", 0, 1]);
  const g = fakeFetch({}, { status: 200, body: capPage(2) });
  const s2 = await refreshCaps({ ids: ["a", "b", "c", "d"], caps, urlOf, capOf: gsparkCapOf, fetchPage: g, log: quiet, limit: 2 });
  assert.deepEqual([s2.tried, g.calls.length, caps.size], [2, 2, 2]);
});

test("詳細の取り方: 台数の読めないページが続いたら告知とみなし、続いた分は控えに書かずに止める", async () => {
  const ids = Array.from({ length: CAP_UNREADABLE_STOP + 5 }, (_, i) => `n${i}`);
  const caps = new Map();
  const f = fakeFetch({ [urlOf("n0")]: { status: 200, body: capPage(4) } }, { status: 200, body: "<p>ただいまメンテナンス中です</p>" });
  const sum = await refreshCaps({ ids, caps, urlOf, capOf: gsparkCapOf, fetchPage: f, log: quiet });
  assert.match(sum.stop, /読めないページが10件続いた/);
  assert.equal(sum.tried, 1 + CAP_UNREADABLE_STOP);
  assert.deepEqual([...caps.keys()], ["n0"]);   // 読めた1件だけ
});

test("詳細の取り方: 取れない答え（5xx・例外）が続いたら止める", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => `e${i}`);
  const f = fakeFetch({ [urlOf("e1")]: "throw" }, { status: 502 });
  const sum = await refreshCaps({ ids, caps: new Map(), urlOf, capOf: gsparkCapOf, fetchPage: f, log: quiet });
  assert.equal(sum.tried, CAP_FAIL_STOP);
  assert.match(sum.stop, /取れない答えが5件続いた/);
});

test("控えのファイル: 書いて読み戻せる・壊れていれば空から", () => {
  const dir = fs.mkdtempSync(path.join(ROOT, "test/.tmp-caps-"));
  try {
    const f = path.join(dir, "x-caps.json");
    saveCaps(f, new Map([["2", { c: 3, at: "2026-11-10T00:00:00.000Z" }], ["10", { c: null, at: "2026-11-10T00:00:00.000Z" }]]));
    assert.deepEqual(Object.fromEntries(loadCaps(f)), { 10: { c: null, at: "2026-11-10T00:00:00.000Z" }, 2: { c: 3, at: "2026-11-10T00:00:00.000Z" } });
    fs.writeFileSync(f, "{ broken");
    assert.equal(loadCaps(f).size, 0);
    assert.equal(loadCaps(path.join(dir, "none.json")).size, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** GSパークのエリア一覧のページ（closure.test.js と同じ形。料金の表は無し） */
const gsPage = (ids) => ids.map((id) => `<table class="result_list"><tr><td><a href="https://www.gs-park.com/time_parking/${id}/">GSパーク${id}</a></td></tr>`
  + `<tr><th>所在地</th><td>東京都千代田区鍛冶町2-1-3</td></tr></table>`).join("");
const gsDetail = (id) => `https://www.gs-park.com/time_parking/${id}/`;

test("通しの巡回（GSパーク）: 一覧のあとに詳細で台数を読み、次の回に1回だけ記録へ足す。3回目は取りに行かない", () => {
  const files = { "data/gspark-areas.txt": "e0101\n", "data/gspark-areas.txt.fetched": new Date().toISOString() };
  const routes = { [areaListUrl("e0101")]: { status: 200, body: gsPage(["900", "929-3"]) },
    [gsDetail("900")]: { status: 200, body: capPage(12) }, [gsDetail("929-3")]: { status: 200, body: fx("gspark-929-3.html") } };
  const r = runCrawl({ env: { CRAWL_ONLY: "gspark" }, files, routes });
  assert.deepEqual(r.pages, [areaListUrl("e0101"), gsDetail("900"), gsDetail("929-3")]);
  assert.deepEqual(r.rows.map((x) => [x.parkId, x.capacity]), [["900", null], ["929-3", null]]);   // 1回目は新規（台数はまだ無い）
  const caps = JSON.parse(fs.readFileSync(path.join(r.dir, "data/gspark-caps.json"), "utf8"));
  assert.deepEqual([caps["900"].c, caps["929-3"].c], [12, 5]);
  assert.deepEqual(r.health[0].caps, { tried: 2, got: 2, unreadable: 0, failed: 0, withCap: 2 });
  // 2回目: 控えの台数が付き、料金は同じでも台数が入ったので1回だけ足す。詳細は30日たっていないので取らない
  const r2 = runCrawl({ env: { CRAWL_ONLY: "gspark" }, dir: r.dir, routes });
  assert.deepEqual(r2.pages, [areaListUrl("e0101")]);
  assert.deepEqual(r2.rows.map((x) => [x.parkId, x.capacity]), [["900", null], ["929-3", null], ["900", 12], ["929-3", 5]]);
  assert.match(r2.log, /\[FILLED\] gspark:900 .*台数が読めたので記録に足す/);
  // 3回目: もう足さない
  const r3 = runCrawl({ env: { CRAWL_ONLY: "gspark" }, dir: r.dir, routes });
  assert.equal(r3.rows.length, 4);
  // CAP_PER_RUN=0 なら詳細は取りに行かない
  const r4 = runCrawl({ env: { CRAWL_ONLY: "gspark", CAP_PER_RUN: "0" }, files, routes });
  assert.deepEqual(r4.pages, [areaListUrl("e0101")]);
});

test("通しの巡回（GSパーク）: 一覧の回が打ち切りなら詳細は取りに行かない", () => {
  const files = { "data/gspark-areas.txt": "e0101\n", "data/gspark-areas.txt.fetched": new Date().toISOString() };
  const r = runCrawl({ env: { CRAWL_ONLY: "gspark" }, files, routes: { "*robots": { status: 403 } } });
  assert.equal(r.pages.some((u) => /time_parking\/\d/.test(u)), false);
  assert.equal(fs.existsSync(path.join(r.dir, "data/gspark-caps.json")), false);
});

test("通しの巡回（三菱地所パークス）: 一覧のあとに詳細で台数を読み、次の回に記録へ足す", () => {
  const lots = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/mecparks/lots.json"), "utf8"));
  const lot = lots.find((p) => p.pid === "27453");
  const list = `<html><body><script>\n    var customdata = ${JSON.stringify([lot])};\n    var parkingCount = 1;\n</script></body></html>`;
  const empty = `<html><body><script>\n    var customdata = [];\n    var parkingCount = 0;\n</script></body></html>`;
  const routes = { "*robots": { status: 200, body: "User-agent: BUbiNG\nDisallow: /\n" }, "*": { status: 200, body: empty },
    [listUrl(13)]: { status: 200, body: list }, [mecDetailUrl("27453")]: { status: 200, body: fx("mecparks-28514.html") } };
  const r = runCrawl({ env: { CRAWL_ONLY: "mecparks" }, routes });
  assert.equal(r.pages.filter((u) => u.includes("details.php")).length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(r.dir, "data/mecparks-caps.json"), "utf8"))["27453"].c, 185);
  const r2 = runCrawl({ env: { CRAWL_ONLY: "mecparks" }, dir: r.dir, routes });
  assert.equal(r2.pages.filter((u) => u.includes("details.php")).length, 0);
  assert.deepEqual(r2.rows.map((x) => x.capacity), [null, 185]);
});
