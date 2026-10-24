// run.js まわりの残りの直しのテスト（npm test）。事業者サイトには繋がない（fetch を差し替え、決まったページを返す）。
// 2026-10-18 の点検（2回目）で見つかったこと:
//   (1a) 後から読めた住所を料金の記録に1回だけ残す条件の「住所らしい」がゆるく（都道府県市区町村郡の字が1つでもあれば住所）、
//        タイムズで題名のかっこを住所と取り違えた「京都市総合教育センター」「さがみ信用金庫緑町支店」なども「もう住所がある」と
//        みなして、正しい住所が読めても記録に残らなかった（5件）。途中で切れた住所（「北海道札幌市白石区本通（北」34件）も同じ
//   (1b) タイムズの「ただいま大変混み合っております」のページ（HTTP 200）に付けた e.transient を run.js が使っておらず、
//        取りに行った扱いで時刻を進めていた（1巡後ろへ回る）。不調の打ち切りも、parse の前に数え直していた
//   (2)  health の行に、失敗の種類（kind）と状態コードの件数（statusCounts）が無く、「断られている」と「一時的な失敗」を見分けられなかった
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gapFilled, looksLikeAddress } from "../src/record-gap.js";
import { isAddressLike, isTruncatedAddress } from "../src/address-like.js";
import { kindOfStatus, kindOfFetch, kindOfText, dominantKind, makeCounter, countStatus, KINDS } from "../src/health-kind.js";
import { parseTimesDetail } from "../src/times.js";
import { listHash } from "../src/repark-enumerate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** run.js を別のプロセスで通しで動かす（test/crawl-core.test.js と同じ作り）。fetch は routes で差し替え、呼んだ URL を控える。
 *  routes の値: { status, body, location } か { throw: "ECONNREFUSED" }。"*robots" は robots.txt の既定、"*" はほかの既定 */
function runCrawl({ env = {}, routes = {}, files = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), "runjs-")), status = 0 }) {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  const routesFile = path.join(dir, "routes.json");
  const callsFile = path.join(dir, "calls.txt");
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  fs.writeFileSync(callsFile, "");
  const preload = path.join(dir, "stub.mjs");
  fs.writeFileSync(preload, `
import fs from "node:fs";
import { config } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)};
config.minDelayMs = 0; config.timesMinDelayMs = 0;
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"));
globalThis.fetch = async function stub(url, opts) {
  const u = String(url);
  fs.appendFileSync(${JSON.stringify(callsFile)}, u + "\\n");
  let r = routes[u];
  if (r === undefined) r = u.endsWith("/robots.txt") ? (routes["*robots"] ?? { status: 404 }) : (routes["*"] ?? { status: 404 });
  if (r.throw) { const e = new TypeError("fetch failed"); e.cause = { code: r.throw }; throw e; }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "",
    headers: { get: (k) => (k.toLowerCase() === "location" ? r.location ?? null : null) } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, status, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const hf = path.join(dir, "data/health/test.json");
  const health = fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, "utf8")).targets : null;
  return { calls, health, log, dir, detail: calls.filter((u) => !u.endsWith("/robots.txt")) };
}
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const rowsOf = (dir) => fs.readFileSync(path.join(dir, "data/prices-test.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ---- タイムズの偽のページ ----
const TU = (n) => `https://times-info.net/P13-tokyo/C101/park-detail-BUK${String(n).padStart(7, "0")}/`;
const SUFFIX = "の時間貸駐車場・満車/空車・料金情報 ｜タイムズ駐車場検索";
/** タイムズの詳細ページ（題名・見出し・本文の住所の行・料金・本駐車場の満空）。address を本文の住所の行に入れる */
function timesPage(n, { name = `タイムズテスト${n}`, address = "東京都千代田区丸の内1-1" } = {}) {
  const buk = `BUK${String(n).padStart(7, "0")}`;
  const m = address.match(/^(東京都|北海道|京都府|大阪府|.{2,3}県)(.+?[市区町村郡])(.*)$/) ?? [null, "", "", address];
  return `<html><head><title>${name}（${address}）${SUFFIX}</title></head><body><h1 class="c-topInfo_ttl">${name}</h1>
<p class="p-basicInfo_table_td_address"><span class="p-basicInfo_table_td_address_txt"><span itemprop="addressRegion">${m[1]}</span><span itemprop="addressLocality">${m[2]}</span><span itemprop="streetAddress">${m[3]}</span></span></p>
<p>駐車場台数10台</p>
<!--▼▼▼全日の通常料金▼▼▼--><p class="c-ulTable_items_list_txt">00:00-00:00 30分 300円</p>
<li class="s_areaBukListItem"><a href="/P13-tokyo/C101/park-detail-${buk}/"><p><span>1</span> ${name}</p><div class="s_bukIcon">0</div><p>本駐車場</p></a></li>
</body></html>`;
}
const BUSY = `<html><head><title>ただいま大変混み合っております</title></head><body><h1>ただいま大変混み合っております</h1></body></html>`;
const ROBOTS_OK = { status: 200, body: "User-agent: *\nAllow: /\n" };
/** タイムズの一覧（作ったばかり）と状態ファイル。状態は古い順 */
function timesFiles(n, extra = {}) {
  const list = Array.from({ length: n }, (_, i) => TU(i + 1));
  const state = { _list: listHash(list) };
  list.forEach((u, i) => { state[u] = `${new Date(Date.now() - (30 - i) * 864e5).toISOString()}|0`; });
  return { list, state, files: {
    "data/times-park-urls.txt": list.join("\n") + "\n", "data/times-park-urls.txt.fetched": new Date().toISOString(),
    "data/times-crawl-state.json": JSON.stringify(state), ...extra } };
}

// ==== (1a) 住所の補記の条件をタイムズの読み取りと同じ厳しさにする ====

test("住所らしさ: タイムズの読み取りと同じ判定。施設名・階の名前は住所とみなさない", () => {
  // 1回目の点検で補記されなかった5件（題名のかっこを住所と取り違えていたもの）
  for (const s of ["京都市総合教育センター", "西宮市立北口", "さがみ信用金庫緑町支店", "さがみ信用金庫寿町支店", "ヴィナシス金町パーキング",
    "上層階", "平面", "第２", "B1", "南", "", null, undefined, "エコロパーク"]) {
    assert.equal(looksLikeAddress(s), false, String(s));
  }
  for (const s of ["北海道札幌市中央区", "北海道札幌市中央区北３条東1-1", "奈良市大森町44", "姫路市伊伝居123", "東京都墨田区押上3-2-1",
    "札幌市中央区北3条西2", "京都府京都市上京区栄町", "長野県北佐久郡軽井沢町大字軽井沢（大字） 旧軽井沢471"]) {
    assert.equal(looksLikeAddress(s), true, s);
  }
  assert.equal(looksLikeAddress, isAddressLike);                 // times.js と同じもの（src/address-like.js）
  assert.equal(isTruncatedAddress("北海道札幌市白石区本通（北"), true);
  assert.equal(isTruncatedAddress("埼玉県川越市鶴馬（大字"), true);
  assert.equal(isTruncatedAddress("北海道札幌市白石区本通（北）16丁目南6-1"), false);
  assert.equal(isTruncatedAddress("東京都千代田区丸の内1-1"), false);
});

test("補記の条件: 施設名だった住所・途中で切れた住所から、完全な住所に変わったら1回だけ足す", () => {
  const fee = { unitCharges: [{ scope: "全日", timeRange: "00:00-00:00", perMinutes: 30, amountYen: 300 }], maxFees: [] };
  const base = { operator: "times", parkId: "BUK0068461", name: "タイムズ京都市総合教育センター", lat: null, lng: null, ...fee };
  const good = "京都府京都市下京区下之町11-1";
  for (const bad of ["京都市総合教育センター", "西宮市立北口", "さがみ信用金庫緑町支店", "さがみ信用金庫寿町支店", "ヴィナシス金町パーキング"]) {
    assert.equal(gapFilled({ ...base, address: bad }, { ...base, address: good }, { coords: false }), "住所", bad);
  }
  // 途中で切れた住所 → 完全な住所: 足す。足したあと（前の行が完全な住所）は足さない
  const cut = "北海道札幌市白石区本通（北", full = "北海道札幌市白石区本通（北）16丁目南6-1";
  assert.equal(gapFilled({ ...base, address: cut }, { ...base, address: full }, { coords: false }), "住所");
  assert.equal(gapFilled({ ...base, address: full }, { ...base, address: full }, { coords: false }), null);
  // 切れたまま・切れた住所に変わった・施設名のまま・住所らしい→住所らしい（値が変わっただけ）は足さない
  assert.equal(gapFilled({ ...base, address: cut }, { ...base, address: cut }, { coords: false }), null);
  assert.equal(gapFilled({ ...base, address: full }, { ...base, address: cut }, { coords: false }), null);
  assert.equal(gapFilled({ ...base, address: "京都市総合教育センター" }, { ...base, address: "京都市総合教育センター" }, { coords: false }), null);
  assert.equal(gapFilled({ ...base, address: "上層階" }, { ...base, address: null }, { coords: false }), null);
  assert.equal(gapFilled({ ...base, address: "奈良市大森町44" }, { ...base, address: "奈良県奈良市大森町44" }), null);
});

test("通しの巡回: 施設名だった住所・途中で切れた住所は、正しく読めた回に1回だけ料金の記録に足す（2回目は足さない）", () => {
  const { list, files } = timesFiles(3);
  const pages = [
    timesPage(1, { name: "タイムズ京都市総合教育センター", address: "京都府京都市下京区下之町11-1" }),
    timesPage(2, { name: "タイムズ本通北", address: "北海道札幌市白石区本通（北）16丁目南6-1" }),
    timesPage(3, { name: "タイムズふつう", address: "東京都千代田区丸の内1-1" }),
  ];
  // 前の記録: 1は施設名、2は途中で切れた住所、3は正しい住所（料金は同じ）
  const prevAddr = ["京都市総合教育センター", "北海道札幌市白石区本通（北", "東京都千代田区丸の内1-1"];
  const prev = pages.map((p, i) => ({ ...parseTimesDetail(p, { url: list[i] }), address: prevAddr[i], fetchedAt: "2026-07-01T00:00:00.000Z" }));
  for (const r of prev) { delete r.nearbyVacancy; }
  files["data/prices-test.jsonl"] = prev.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const routes = { "*robots": ROBOTS_OK, ...Object.fromEntries(list.map((u, i) => [u, { status: 200, body: pages[i] }])) };
  const r1 = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes });
  const rows = rowsOf(r1.dir);
  assert.equal(rows.length, 5);                                   // 前の3行＋補記2行（3は足さない）
  assert.deepEqual(rows.slice(3).map((r) => [r.parkId, r.address, r.changedFromPrev]), [
    ["BUK0000001", "京都府京都市下京区下之町11-1", undefined],
    ["BUK0000002", "北海道札幌市白石区本通（北）16丁目南6-1", undefined],
  ]);
  assert.match(r1.log, /\[FILLED\] times:BUK0000001 .*住所が読めたので記録に足す/);
  assert.match(r1.log, /変動0 \/ 追記2行（うち名前・住所・座標の補記2行）/);
  // 状態の日付を古くして、同じ作業場所でもう1回（全件をまた取る）。もう足さない
  const st = readJson(r1.dir, "data/times-crawl-state.json");
  for (const u of list) st[u] = `2026-07-01T00:00:00.000Z|0`;
  fs.writeFileSync(path.join(r1.dir, "data/times-crawl-state.json"), JSON.stringify(st));
  const r2 = runCrawl({ env: { CRAWL_ONLY: "times" }, routes, dir: r1.dir });
  assert.equal(r2.detail.length, 3);
  assert.equal(rowsOf(r1.dir).length, 5);
  assert.match(r2.log, /追記0行/);
});

// ==== (1b) 混み合いのページは「取りに行った」扱いにせず、不調として数える ====

test("通しの巡回: 混み合いのページは時刻を進めず次の回に取り直し、記録にも書かない。続けば8件で打ち切る", () => {
  const { list, state, files } = timesFiles(12);
  const r = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes: { "*robots": ROBOTS_OK, "*": { status: 200, body: BUSY } } });
  assert.deepEqual(r.detail, list.slice(0, 8));                  // 以前は12件とも取りに行き、全部の時刻を進めていた
  const after = readJson(r.dir, "data/times-crawl-state.json");
  for (const u of list.slice(0, 8)) assert.equal(after[u], `${state[u]}|r`);   // 日付は進めず、取り直しの印だけ
  for (const u of list.slice(8)) assert.equal(after[u], state[u]);
  assert.ok(!fs.existsSync(path.join(r.dir, "data/prices-test.jsonl")) || rowsOf(r.dir).length === 0);
  const h = r.health[0];
  assert.deepEqual([h.ok, h.n, h.tried, h.busy, h.kind], [false, 0, 8, 8, "network"]);
  assert.deepEqual(h.statusCounts, { 200: 8 });
  assert.match(h.reason, /8件続けて取れず。最後は 混み合いのページ/);
  assert.match(r.log, /相手先の不調で取れなかった8件は、次の回に取り直す（うち混み合いのページ8件）/);
  // 次の回: 先方が戻れば、印の付いた8件を先に取り直す（1巡後ろへ回さない）
  const pages = Object.fromEntries(list.map((u, i) => [u, { status: 200, body: timesPage(i + 1) }]));
  const r2 = runCrawl({ env: { CRAWL_ONLY: "times" }, routes: { "*robots": ROBOTS_OK, ...pages }, dir: r.dir });
  assert.deepEqual(r2.detail.slice(0, 8), list.slice(0, 8));
  const after2 = readJson(r.dir, "data/times-crawl-state.json");
  for (const u of list.slice(0, 8)) assert.ok(!after2[u].endsWith("|r") && Date.parse(after2[u].split("|")[0]) > Date.now() - 600e3, after2[u]);
  assert.deepEqual([r2.health[0].ok, r2.health[0].n], [true, 12]);
});

test("通しの巡回: 混み合いのページは打ち切りの数を数え直さない（503 の間に1件挟まっても8件で止める）", () => {
  const { list, files } = timesFiles(12);
  const routes = { "*robots": ROBOTS_OK, "*": { status: 200, body: timesPage(99) } };
  list.slice(0, 4).concat(list.slice(5, 8)).forEach((u) => { routes[u] = { status: 503 }; });
  routes[list[4]] = { status: 200, body: BUSY };
  const r = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes });
  // 以前は混み合いのページ（HTTP 200）で parse の前に数え直していたので止まらず、12件とも取りに行っていた
  assert.deepEqual(r.detail, list.slice(0, 8));
  assert.deepEqual([r.health[0].kind, r.health[0].busy], ["network", 1]);
  assert.deepEqual(r.health[0].statusCounts, { 200: 1, 503: 7 });
  assert.match(r.health[0].reason, /8件続けて取れず。最後は HTTP 503/);
});

test("通しの巡回: 混み合いのページが1件だけなら止めず、その物件だけ次の回に取り直す（ほかはいつもどおり）", () => {
  const { list, state, files } = timesFiles(5);
  const routes = { "*robots": ROBOTS_OK, ...Object.fromEntries(list.map((u, i) => [u, { status: 200, body: timesPage(i + 1) }])) };
  routes[list[2]] = { status: 200, body: BUSY };
  const r = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes });
  assert.equal(r.detail.length, 5);
  const after = readJson(r.dir, "data/times-crawl-state.json");
  assert.equal(after[list[2]], `${state[list[2]]}|r`);
  assert.equal(rowsOf(r.dir).length, 4);                          // 混み合いのページは記録に書かない
  const h = r.health[0];
  assert.deepEqual([h.ok, h.n, h.tried, h.busy, h.kind], [true, 4, 5, 1, undefined]);   // 取れた行に kind は付けない
  assert.deepEqual(h.statusCounts, { 200: 5 });
});

// ==== (2) health の種類（kind）と状態コードの件数（statusCounts） ====

test("health の種類: 状態コード・取得の結果・文から決める", () => {
  assert.deepEqual(KINDS, ["paused", "blocked", "rate", "network", "maintenance", "parse", "stale-list", "mass-gone"]);
  assert.deepEqual([200, 204, 301, 302, 400, 401, 403, 404, 410, 429, 500, 502, 503].map(kindOfStatus),
    [null, null, "parse", "parse", "parse", "blocked", "blocked", "parse", "parse", "rate", "network", "network", "network"]);
  assert.equal(kindOfFetch(null), "network");
  assert.equal(kindOfFetch({ ok: false, blocked: true, status: 403, skippedReason: "robots.txt が HTTP 403（断られている）" }), "blocked");
  assert.equal(kindOfFetch({ ok: false, transient: true, status: null, robotsError: "fetch failed（ECONNREFUSED）" }), "network");
  assert.equal(kindOfFetch({ ok: false, transient: true, status: null, robotsError: "HTTP 503" }), "network");
  assert.equal(kindOfFetch({ ok: false, transient: true, status: null, robotsError: "HTTP 429" }), "rate");
  assert.equal(kindOfFetch({ ok: false, skippedReason: "robots.txt で Disallow: /x" }), "blocked");
  assert.equal(kindOfFetch({ ok: true, status: 200 }), null);
  assert.equal(kindOfText("停止中: 2026-10 先方が403で拒否"), "paused");
  assert.equal(kindOfText("スペース24一覧の取得に失敗: HTTP 403"), "blocked");
  assert.equal(kindOfText("一覧取得失敗: robots.txt が HTTP 401（断られている）"), "blocked");
  assert.equal(kindOfText("sitemap HTTP 429"), "rate");
  assert.equal(kindOfText("一覧取得失敗: robots.txt に届かない（相手先の障害の可能性）（HTTP 429）"), "rate");
  assert.equal(kindOfText("一覧取得失敗: robots.txt に届かない（相手先の障害の可能性）（HTTP 503）"), "network");
  assert.equal(kindOfText("fetch failed（ECONNREFUSED）"), "network");
  assert.equal(kindOfText("The operation was aborted due to timeout（TIMEOUT）"), "network");
  assert.equal(kindOfText("sitemap HTTP 502"), "network");
  assert.equal(kindOfText("京王コインパーク一覧の解析結果が0件（ページ構造変更の可能性）"), "parse");
  assert.equal(kindOfText("一覧が 22000件 → 100件に減った（90%未満は作り直しの失敗とみなす）"), null);   // 「100件」は0件ではない
  assert.equal(kindOfText("一覧がまだありません（この回は作り直しを見送り）"), null);
  assert.equal(dominantKind({ network: 3, parse: 5 }), "parse");
  assert.equal(dominantKind({ network: 4, blocked: 4 }), "blocked");   // 同じ数なら手を打つべきほう
  assert.equal(dominantKind({}), null);
  const c = makeCounter();
  countStatus(c, { ok: true, status: 200 }); countStatus(c, { ok: false, status: 403 }); countStatus(c, null);
  countStatus(c, { ok: false, blocked: true, skippedReason: "x" }); countStatus(c, { ok: false, skippedReason: "Disallow" });
  assert.deepEqual(c.toJSON(), { 200: 1, 403: 1, network: 1 });   // robots.txt で見送った分（送っていない）は数えない
});

/** タイムズの12件を、本ページの答え route で通しに巡回した health の1行 */
const timesHealth = (route, robots = ROBOTS_OK) => {
  const { files } = timesFiles(12);
  return runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes: { "*robots": robots, "*": route } });
};

test("通しの巡回の health: 403 が続いて打ち切ったら blocked、429 なら rate、通信の失敗なら network（件数つき）", () => {
  const b = timesHealth({ status: 403 });
  assert.deepEqual([b.health[0].ok, b.health[0].kind, b.health[0].statusCounts], [false, "blocked", { 403: 8 }]);
  const r = timesHealth({ status: 429 });
  assert.deepEqual([r.health[0].kind, r.health[0].statusCounts], ["rate", { 429: 8 }]);
  const n = timesHealth({ throw: "ECONNRESET" });
  assert.deepEqual([n.health[0].kind, n.health[0].statusCounts], ["network", { network: 8 }]);
  assert.match(n.health[0].reason, /8件続けて取れず。最後は fetch failed（ECONNRESET）/);
  // robots.txt が 429 なら本ページは送らず rate、401 なら blocked
  const rr = timesHealth({ status: 200, body: "x" }, { status: 429 });
  assert.deepEqual([rr.detail.length, rr.health[0].kind, rr.health[0].statusCounts], [0, "rate", {}]);
  assert.match(rr.health[0].reason, /robots\.txt に届かない.*HTTP 429/);
  const rb = timesHealth({ status: 200, body: "x" }, { status: 401 });
  assert.deepEqual([rb.detail.length, rb.health[0].kind], [0, "blocked"]);
});

test("通しの巡回の health: 取れたが1件も読めなければ parse。取れた回は kind なしで statusCounts だけ", () => {
  const p = timesHealth({ status: 200, body: "<html><body>作りが変わった</body></html>" });
  assert.deepEqual([p.health[0].ok, p.health[0].tried, p.health[0].noName, p.health[0].kind, p.health[0].statusCounts],
    [false, 12, 12, "parse", { 200: 12 }]);
  const { list, files } = timesFiles(12);
  const routes = { "*robots": ROBOTS_OK, ...Object.fromEntries(list.map((u, i) => [u, { status: 200, body: timesPage(i + 1) }])) };
  for (const u of list.slice(0, 3)) routes[u] = { status: 404 };
  const ok = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes });
  assert.deepEqual([ok.health[0].ok, ok.health[0].n, ok.health[0].kind, ok.health[0].statusCounts], [true, 9, undefined, { 200: 9, 404: 3 }]);
  assert.ok(!("kind" in ok.health[0]));
  // Advisor（crawl-health）と studio-index.mjs が読む項目の形は変わらない
  for (const t of [...p.health, ...ok.health]) {
    assert.equal(typeof t.op, "string"); assert.equal(typeof t.label, "string"); assert.equal(typeof t.ok, "boolean");
    assert.equal(typeof t.n, "number"); assert.ok(t.reason === null || typeof t.reason === "string");
  }
});

const KEIO_LIST = "https://www.keiofudosan.co.jp/rent/coinpark/all/";
test("通しの巡回の health: 一覧の問題は stale-list（0件の一覧）、一覧が取れないときは断られた・届かない・読めないで分ける", () => {
  // 取得日が新しいのに中身が空の一覧（1回目の点検の nit。これまでこの分岐を通るテストが無かった）
  const empty = runCrawl({ env: { CRAWL_ONLY: "keio" },
    files: { "data/keio-ids.txt": "", "data/keio-ids.txt.fetched": new Date().toISOString() } });
  assert.deepEqual(empty.calls, []);
  assert.deepEqual([empty.health[0].ok, empty.health[0].reason, empty.health[0].kind], [false, "一覧が0件", "stale-list"]);
  const b = runCrawl({ env: { CRAWL_ONLY: "keio" }, routes: { [KEIO_LIST]: { status: 403 } } });
  assert.deepEqual([b.health[0].ok, b.health[0].kind], [false, "blocked"]);
  assert.match(b.health[0].reason, /^一覧: 京王コインパーク一覧取得失敗: HTTP 403/);
  const d = runCrawl({ env: { CRAWL_ONLY: "keio" }, routes: { "*robots": { throw: "ETIMEDOUT" } } });
  assert.deepEqual([d.calls.length, d.health[0].kind], [1, "network"]);
  const p = runCrawl({ env: { CRAWL_ONLY: "keio" }, routes: { [KEIO_LIST]: { status: 200, body: "<html>作りが変わった</html>" } } });
  assert.deepEqual([p.health[0].kind], ["parse"]);
  // GSパーク（一覧型）の一覧も同じ。robots.txt が 403 なら blocked
  const g = runCrawl({ env: { CRAWL_ONLY: "gspark" }, routes: { "*robots": { status: 403 } } });
  assert.deepEqual([g.detail.length, g.health[0].kind], [0, "blocked"]);
});

test("通しの巡回の health: 止めている社は paused、1件だけ取る社（エムデン・ザ・パーク）も種類と状態コードを付ける", () => {
  const s = runCrawl({ env: { CRAWL_ONLY: "space24,odakyu" } });
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.health.map((t) => [t.op, t.ok, t.kind]), [["space24", false, "paused"], ["odakyu", false, "paused"]]);
  const tp = runCrawl({ env: { CRAWL_ONLY: "thepark" }, routes: { "*": { status: 503 } } });
  assert.deepEqual([tp.health[0].ok, tp.health[0].kind, tp.health[0].statusCounts], [false, "network", { 503: 1 }]);
  const md = runCrawl({ env: { CRAWL_ONLY: "mden" }, routes: { "*": { status: 200, body: "<html></html>" } } });
  assert.deepEqual([md.health[0].ok, md.health[0].reason, md.health[0].kind, md.health[0].statusCounts], [false, "0件", "parse", { 200: 1 }]);
  const mx = runCrawl({ env: { CRAWL_ONLY: "mden" }, routes: { "*": { throw: "ENOTFOUND" } } });
  assert.deepEqual([mx.health[0].kind, mx.health[0].statusCounts], ["network", { network: 1 }]);
});
