// 巡回の失敗の扱いのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える）。
// 2026-10-18 の点検で見つかったことを直したぶん:
//   ・403 で断られているスペース二十四・小田急パーキングに毎回一覧を取りに行っていた。ルパルクも 403 と分かっている3ページ目を叩いていた
//   ・robots.txt に届かない（相手先が落ちている）ときも「制限なし」として本ページを取りに行き、エコロでは45分間に257回送っていた。
//     robots.txt が 403（断られている）でも本ページを送っていた
//   ・404 で寝かせた物件が一律30日で一斉に起き、リパークで2回の巡回に962件の 404 をまとめて投げていた。
//     一覧が1件変わるだけで寝かせた物件を全部起こしていた（あなぶきパークで68件）
//   ・名鉄協商の552件（一覧の22%）は掲載終了で /misc/404.php へ転送されていたのに、転送先を読んで「名前なし」で黙って飛ばし、
//     毎回取りに行っていた
//   ・料金の記録は料金が変わったときしか書かないので、あとで読めた住所・名前・座標が記録に入らなかった（エコロの76件は住所が一度も無い）
// 2回目の点検（同じ日）で見つかったこと:
//   ・カーシェアーズは robots.txt に届かないと残りの一覧を全部「済み」にし、見なかった全ステーションに gone を書いていた
//   ・ナビパークは robots.txt に届かないと0件の一覧を書いて7日間止まり、health は成功のままだった
//   ・転送・404 による閉鎖が一斉に起きる（先方のサイトの作り替え・保守）と、その回に取った物件が全部寝かされる
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";

// 一覧の作り直しは1回の実行で2件までに抑えてあるので、テストでは外す（読み込む前に決める必要がある）
process.env.LIST_REFRESH_MAX = "1000";
const { getAllLeparcIds } = await import("../src/leparc-enumerate.js");
const { parseMkpDetail, isClosedRedirect: isMkpClosedRedirect } = await import("../src/mkp.js");
const { gapFilled, looksLikeAddress } = await import("../src/record-gap.js");
const { parseEcoloDetail } = await import("../src/ecolo.js");
const { politeFetch, fetchErrorText, _resetRobotsCache } = await import("../src/polite-fetch.js");
const { isTransient, listHash, goneMsOf, unparkGone, countLive, pickRolling, parkIdsFromSitemap, makeMassGone } = await import("../src/repark-enumerate.js");
const { getAllNaviparkCodes } = await import("../src/navipark-enumerate.js");
const { getAllKyotechIds } = await import("../src/kyotech-enumerate.js");
config.minDelayMs = 0;   // テストでは待たない

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 差し替えた fetch（このプロセスの中だけ）。url → 本文（文字列）または { status, body, location, throw }。呼ばれた URL を控える */
function stubFetch(routes, fallback = { status: 404 }) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    let r = routes[u] ?? (u.endsWith("/robots.txt") ? "" : fallback);
    if (typeof r === "function") r = r(u);
    if (r && r.throw) { const e = new TypeError("fetch failed"); e.cause = { code: r.throw }; throw e; }
    const body = typeof r === "string" ? r : r.body ?? "";
    const status = typeof r === "string" ? 200 : r.status;
    return { ok: status >= 200 && status < 300, status, text: async () => body,
      headers: { get: (k) => (k.toLowerCase() === "location" && typeof r === "object" ? r.location ?? null : null) } };
  };
  return calls;
}

/** run.js を別のプロセスで通しで動かす。fetch は routes で差し替える（どの URL を呼んだかを控える）。
 *  files … 作業ディレクトリに置くファイル（data/… の相対パス → 中身）。戻り値は { calls, health, log, dir }。
 *  script … 動かす本体（既定は run.js。carshares.js も同じ形で試す）。status … 終了コードの見込み */
function runCrawl({ env = {}, routes = {}, files = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-core-")), script = "src/run.js", status = 0 }) {
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
  // 転送は redirect: "manual" でなければ本物の fetch と同じく追う
  if (r.status >= 300 && r.status < 400 && r.location && opts?.redirect !== "manual") return stub(new URL(r.location, u).href, opts);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "",
    headers: { get: (k) => (k.toLowerCase() === "location" ? r.location ?? null : null) } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, script)], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, status, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const hf = path.join(dir, "data/health/test.json");
  const health = fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, "utf8")).targets : null;
  return { calls, health, log, dir };
}

// ---- 1. 断られている2社を止める ----

test("止めている社（スペース二十四・小田急）には一覧も詳細も robots.txt も取りに行かず、health は ok:false の「停止中」", () => {
  const { calls, health } = runCrawl({ env: { CRAWL_ONLY: "space24,odakyu" },
    // 前の一覧と状態がある（＝止めていなければ詳細を取りに行く）ときでも、1回も呼ばない
    files: { "data/space24-ids.txt": "5398\n", "data/space24-ids.txt.fetched": new Date().toISOString(),
      "data/odakyu-ids.txt": "1\n", "data/odakyu-ids.txt.fetched": new Date().toISOString() } });
  assert.deepEqual(calls, []);
  assert.deepEqual(health.map((t) => [t.op, t.label, t.ok, t.n]), [
    ["space24", "スペース二十四", false, 0],
    ["odakyu", "小田急パーキング", false, 0],
  ]);
  for (const t of health) assert.match(t.reason, /^停止中: 2026-10 先方が403で拒否/);
});

test("ルパルクの一覧は2ページ（start=0・20）で止め、403 と分かっている3ページ目（start=40）は取りに行かない", async () => {
  const L = "https://sasp.mapion.co.jp/b/leperc/attr/";
  const page = (from) => Array.from({ length: 20 }, (_, i) => `<a href="/b/leperc/info/NRP${String(from + i).padStart(5, "0")}/">x</a>`).join("");
  const calls = stubFetch({ [L]: page(1), [`${L}?start=20`]: page(21), [`${L}?start=40`]: page(41), [`${L}?start=60`]: page(61) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leparc-"));
  const ids = await getAllLeparcIds({ cacheFile: path.join(dir, "leparc-ids.txt") });
  assert.equal(ids.length, 40);
  assert.deepEqual(calls.filter((u) => !u.endsWith("/robots.txt")), [L, `${L}?start=20`]);
});

// ---- 2. robots.txt の扱い ----

test("robots.txt に届かない（通信の失敗）なら本ページは送らず transient。原因の符号も分かる", async () => {
  _resetRobotsCache();
  const O = "https://down.example";
  const calls = stubFetch({ [`${O}/robots.txt`]: { throw: "ECONNREFUSED" }, [`${O}/p/1`]: "page" });
  const r = await politeFetch(`${O}/p/1`);
  assert.equal(r.ok, false);
  assert.equal(r.transient, true);
  assert.equal(r.skippedReason, "robots.txt に届かない（相手先の障害の可能性）");
  assert.match(r.robotsError, /ECONNREFUSED/);
  assert.equal(isTransient(r), true);                       // 不調として数える（取り直しの印・打ち切り）
  // 同じ origin の2件目は robots.txt も本ページも送らない（10分は見送る）
  const r2 = await politeFetch(`${O}/p/2`);
  assert.equal(r2.transient, true);
  assert.deepEqual(calls, [`${O}/robots.txt`]);
});

test("robots.txt が 5xx・429 なら transient、401・403 なら blocked、404 は制限なし", async () => {
  _resetRobotsCache();
  const route = (st) => ({ status: st, body: "x" });
  const calls = stubFetch({
    "https://a500.example/robots.txt": route(500), "https://a503.example/robots.txt": route(503), "https://a429.example/robots.txt": route(429),
    "https://a403.example/robots.txt": route(403), "https://a401.example/robots.txt": route(401),
    "https://a404.example/robots.txt": route(404), "https://a404.example/p": "ok-page",
    "https://a410.example/robots.txt": route(410), "https://a410.example/p": "ok-page",
  }, "page");
  for (const h of ["a500", "a503", "a429"]) {
    const r = await politeFetch(`https://${h}.example/p`);
    assert.equal(r.transient, true, h);
    assert.equal(r.blocked, undefined, h);
  }
  for (const h of ["a403", "a401"]) {
    const r = await politeFetch(`https://${h}.example/p`);
    assert.equal(r.blocked, true, h);
    assert.equal(r.ok, false);
    assert.match(r.skippedReason, /robots\.txt が HTTP 40[13]（断られている）/);
    assert.equal(isTransient(r), false);                    // 不調ではなく「断られている」（run.js はすぐ打ち切る）
  }
  for (const h of ["a404", "a410"]) {
    const r = await politeFetch(`https://${h}.example/p`);
    assert.equal(r.ok, true, h);
    assert.equal(r.html, "ok-page");
  }
  // 本ページを送ったのは 404・410 の社だけ
  assert.deepEqual(calls.filter((u) => !u.endsWith("/robots.txt")), ["https://a404.example/p", "https://a410.example/p"]);
});

test("robots.txt に届かなかった origin は10分たてば robots.txt から取り直す（それまでは送らない）", async () => {
  _resetRobotsCache();
  const O = "https://flaky.example";
  let up = false;
  const calls = stubFetch({ [`${O}/robots.txt`]: () => (up ? "User-agent: *\nDisallow: /admin/\n" : { throw: "UND_ERR_CONNECT_TIMEOUT" }), [`${O}/p`]: "page" });
  const realNow = Date.now;
  try {
    assert.equal((await politeFetch(`${O}/p`)).transient, true);
    up = true;
    Date.now = () => realNow() + 9 * 60_000;                 // 9分後: まだ見送る（robots.txt も取らない）
    assert.equal((await politeFetch(`${O}/p`)).transient, true);
    assert.equal(calls.length, 1);
    Date.now = () => realNow() + 11 * 60_000;                // 11分後: 取り直して、届けば本ページを取る
    const r = await politeFetch(`${O}/p`);
    assert.equal(r.ok, true);
    assert.deepEqual(calls, [`${O}/robots.txt`, `${O}/robots.txt`, `${O}/p`]);
    // 取れた robots.txt の規則は今までどおり守る
    assert.match((await politeFetch(`${O}/admin/x`)).skippedReason, /Disallow/);
    assert.equal(calls.length, 3);
  } finally { Date.now = realNow; }
});

test("fetch の例外に原因の符号を添える", () => {
  const e = new TypeError("fetch failed"); e.cause = { code: "ENOTFOUND" };
  assert.equal(fetchErrorText(e), "fetch failed（ENOTFOUND）");
  const t = new Error("The operation was aborted due to timeout"); t.name = "TimeoutError";
  assert.equal(fetchErrorText(t), "The operation was aborted due to timeout（TIMEOUT）");
  assert.equal(fetchErrorText(new Error("x")), "x");
  const a = new TypeError("fetch failed"); a.cause = { errors: [{ code: "ECONNREFUSED" }, { code: "ECONNREFUSED" }] };
  assert.equal(fetchErrorText(a), "fetch failed（ECONNREFUSED）");
  const b = new TypeError("fetch failed"); b.cause = new Error("bad port");
  assert.equal(fetchErrorText(b), "fetch failed（bad port）");
});

const TU = (n) => `https://times-info.net/P13-tokyo/C101/park-detail-BUK${String(n).padStart(7, "0")}/`;
/** タイムズの一覧（作ったばかり）と状態ファイル。状態は古い順に並べる */
function timesFiles(n) {
  const list = Array.from({ length: n }, (_, i) => TU(i + 1));
  const state = { _list: listHash(list) };
  list.forEach((u, i) => { state[u] = `${new Date(Date.now() - (30 - i) * 864e5).toISOString()}|0`; });
  return { list, state, files: {
    "data/times-park-urls.txt": list.join("\n") + "\n", "data/times-park-urls.txt.fetched": new Date().toISOString(),
    "data/times-crawl-state.json": JSON.stringify(state) } };
}

test("通しの巡回: 相手先が落ちている（robots.txt に届かない）と robots.txt の1回だけで止め、状態の日付は進めず health は ok:false", () => {
  const { state, files } = timesFiles(12);
  const { calls, health, dir } = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes: { "*robots": { throw: "ECONNREFUSED" }, "*": { status: 200, body: "x" } } });
  assert.deepEqual(calls, ["https://times-info.net/robots.txt"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "data/times-crawl-state.json"), "utf8")), state);
  assert.equal(health.length, 1);
  assert.equal(health[0].ok, false);
  assert.equal(health[0].kind, "network");                     // 届かない（以前は unreachable と書いていた。health-kind.js）
  assert.deepEqual(health[0].statusCounts, {});                 // 本ページは1件も送っていない
  assert.match(health[0].reason, /robots\.txt に届かない.*ECONNREFUSED/);
});

test("通しの巡回: robots.txt が 403 ならすぐ打ち切り、本ページは送らない", () => {
  const { state, files } = timesFiles(12);
  const { calls, health, dir } = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes: { "*robots": { status: 403 }, "*": { status: 200, body: "x" } } });
  assert.deepEqual(calls, ["https://times-info.net/robots.txt"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "data/times-crawl-state.json"), "utf8")), state);
  assert.equal(health[0].ok, false);
  assert.equal(health[0].kind, "blocked");
  assert.match(health[0].reason, /robots\.txt が HTTP 403（断られている）/);
});

test("通しの巡回: 本ページが全部 503 なら8件で打ち切り、8件は次の回に取り直す印だけ付く", () => {
  const { list, state, files } = timesFiles(12);
  const { calls, health, dir } = runCrawl({ env: { CRAWL_ONLY: "times" }, files,
    routes: { "*robots": { status: 200, body: "User-agent: *\nAllow: /\n" }, "*": { status: 503, body: "busy" } } });
  const detail = calls.filter((u) => !u.endsWith("/robots.txt"));
  assert.deepEqual(detail, list.slice(0, 8));
  const after = JSON.parse(fs.readFileSync(path.join(dir, "data/times-crawl-state.json"), "utf8"));
  for (const u of list.slice(0, 8)) assert.equal(after[u], `${state[u]}|r`);   // 日付は進めない
  for (const u of list.slice(8)) assert.equal(after[u], state[u]);
  assert.equal(health[0].ok, false);
  assert.equal(health[0].kind, "network");                     // 5xx の不調（以前は transient と書いていた。health-kind.js）
  assert.deepEqual(health[0].statusCounts, { 503: 8 });
  assert.match(health[0].reason, /8件続けて取れず。最後は HTTP 503/);
});

// ---- 3. 404 の一斉取り直しをならす ----

test("寝かせる期間は番号ごとに30〜60日に散り、同じ回に寝かせた964件が1日あたり約30件・1時間あたり数件ずつ起きる", () => {
  // 10/12 に寝かせたリパークの964件と同じ形の番号
  const ids = Array.from({ length: 964 }, (_, i) => `REP${String(10000 + i * 97).padStart(7, "0")}`);
  const days = ids.map((id) => goneMsOf(id) / 864e5);
  for (const d of days) assert.ok(d >= 30 && d <= 60, String(d));
  assert.equal(goneMsOf(ids[0]), goneMsOf(ids[0]));          // 毎回同じ（番号だけで決まる）
  const perDay = new Map(), perHour = new Map();
  for (const d of days) {
    perDay.set(Math.floor(d), (perDay.get(Math.floor(d)) ?? 0) + 1);
    perHour.set(Math.round(d * 24), (perHour.get(Math.round(d * 24)) ?? 0) + 1);
  }
  assert.ok(perDay.size >= 30);                               // 30日に散る（一律30日なら964件が1日・1時間に来る）
  assert.ok(Math.max(...perDay.values()) <= 60, `1日の最大 ${Math.max(...perDay.values())}件`);
  assert.ok(Math.max(...perHour.values()) <= 8, `1時間の最大 ${Math.max(...perHour.values())}件`);
  // 寝かせた日から30日と1時間たっても、起きるのは最初の1時間ぶんだけ
  const at = "2026-10-12T02:00:00.000Z";
  const state = Object.fromEntries(ids.map((id) => [id, `GONE|${at}`]));
  const after = Date.parse(at) + 30 * 864e5 + 3600e3;
  const woken = ids.filter((id) => goneMsOf(id) <= 30 * 864e5 + 3600e3).length;
  assert.ok(woken <= 8, `${woken}件`);
  assert.equal(countLive(ids, state, after), woken);
  assert.equal(pickRolling(ids, state, 2000, { at: new Date(after).toISOString() }).length, woken);
  // 60日と1時間たてば全部起きる
  assert.equal(countLive(ids, state, Date.parse(at) + 60 * 864e5 + 3600e3), ids.length);
});

test("一覧に新しく載った番号だけを起こし、前から載っている寝かせた物件は起こさない", () => {
  const G = "GONE|2026-10-12T00:00:00.000Z";
  const prev = ["A", "B", "C"];
  const now = ["A", "B", "C", "D", "E"];
  const state = { _list: listHash(prev), A: "2026-10-17T00:00:00.000Z", B: G, D: G };
  assert.equal(unparkGone(state, now, prev), 1);              // D だけ（B は前から載っている）
  assert.equal(state.B, G);
  assert.equal(state.D, undefined);
  assert.equal(state._list, listHash(now));
  assert.equal(unparkGone(state, now, prev), 0);              // 同じ一覧ではもう起こさない
  // 前の一覧が分からなければ起こさない（期限が切れれば普通に戻る）
  const s2 = { _list: listHash(prev), B: G, D: G };
  assert.equal(unparkGone(s2, now, null), 0);
  assert.equal(s2.D, G);
  // 初回（指紋が無い）は控えるだけ
  const s3 = { D: G };
  assert.equal(unparkGone(s3, now, prev), 0);
  assert.equal(s3.D, G);
});

test("通しの巡回: 一覧を作り直す前のファイルと比べ、新しく載った寝かせた物件だけを起こす（リパークは sitemap の XML から読む）", () => {
  const xml = (ids) => `<urlset>${ids.map((i) => `<url><loc>https://www.repark.jp/parking_user/time/result/detail/?park=${i}</loc></url>`).join("")}</urlset>`;
  assert.deepEqual(parkIdsFromSitemap(xml(["REP0000001", "REP0000002"])), ["REP0000001", "REP0000002"]);
  const prev = ["REP0000001", "REP0000002", "REP0000003"];
  const now = ["REP0000001", "REP0000002", "REP0000003", "REP0000004"];
  const G = `GONE|${new Date(Date.now() - 864e5).toISOString()}`;
  const state = { _list: listHash(prev), REP0000001: new Date().toISOString() + "|0", REP0000002: new Date().toISOString() + "|0", REP0000003: G, REP0000004: G };
  const { calls, dir, log } = runCrawl({ env: { CRAWL_ONLY: "repark", ROLLING_PER_RUN: "5" },
    files: { "data/repark-sitemap.xml": xml(prev), "data/repark-crawl-state.json": JSON.stringify(state) },   // .fetched が無い＝作り直す
    routes: { "https://www.repark.jp/sitemap_park.xml": { status: 200, body: xml(now) }, "*": { status: 404 } } });
  assert.match(log, /一覧に新しく載った1件は寝かせていたので起こす/);
  const after = JSON.parse(fs.readFileSync(path.join(dir, "data/repark-crawl-state.json"), "utf8"));
  assert.equal(after.REP0000003, G);                          // 前から載っている → 起こさない（取りに行かない）
  assert.ok(!calls.some((u) => u.includes("REP0000003")));
  assert.ok(calls.some((u) => u.includes("REP0000004")));     // 新しく載った → 起こして確かめる（404 なので寝かせ直す）
  assert.match(after.REP0000004, /^GONE\|/);
});

// ---- 4. 名鉄協商の名前が読めない552件 ----

/** 名鉄協商の詳細ページ（JSON-LD と料金表だけ）。name が空なら掲載終了の雛形（2026-10-18 に見た 302 の本文と同じ形） */
const mkpPage = (name, { lat = 35.1, lng = 136.9, addr = "愛知県名古屋市中区栄1-1" } = {}) => `<html><head>
<script type="application/ld+json">{"@type":"ParkingFacility","name":"名鉄協商パーキング ${name}","address":{"streetAddress":"${addr}"},
"geo":{"latitude":${lat},"longitude":${lng}}}</script></head><body><h1>${name}</h1>
<div class="box_price"><table class="tbl_basic"><tr><th></th><th>通常料金</th><th>最大料金</th></tr>
<tr><td>全日</td><td><p>00:00 - 24:00 30分 200円</p></td><td><p>入庫より24時間まで 800円</p></td></tr></table></div></body></html>`;

test("名鉄協商: /misc/404.php への転送は掲載終了。社名だけ・座標 0 の雛形は物件として読まない", () => {
  assert.equal(isMkpClosedRedirect("../../../misc/404.php"), true);   // 実際の Location
  assert.equal(isMkpClosedRedirect("https://mkp.jp/misc/404.php"), true);
  assert.equal(isMkpClosedRedirect("https://mkp.jp/search/detail/001145-2"), false);
  assert.equal(isMkpClosedRedirect(null), false);
  const closed = parseMkpDetail(mkpPage("", { lat: "0.000000", lng: "0.000000", addr: "" }), { id: "001145-0" });
  assert.equal(closed.name, null);
  assert.equal(closed.lat, null);
  const live = parseMkpDetail(mkpPage("栄第3"), { id: "001102-2" });
  assert.equal(live.name, "名鉄協商パーキング 栄第3");
  assert.equal(live.lat, 35.1);
  assert.equal(live.unitCharges.length, 1);
});

test("通しの巡回: 名鉄協商の掲載終了（302 → /misc/404.php）は 404 と同じく寝かせ、名前が読めない物件は番号と件数を残す", () => {
  const D = (id) => `https://mkp.jp/search/detail/${id}`;
  const ids = ["001145-0", "001102-2", "009999-0"];
  const { calls, health, dir, log } = runCrawl({ env: { CRAWL_ONLY: "mkp" },
    files: { "data/mkp-ids.txt": ids.join("\n") + "\n", "data/mkp-ids.txt.fetched": new Date().toISOString() },
    routes: {
      [D("001145-0")]: { status: 302, location: "../../../misc/404.php", body: mkpPage("", { lat: 0, lng: 0, addr: "" }) },
      "https://mkp.jp/misc/404.php": { status: 200, body: "<html><h1></h1>ページが見つかりません</html>" },
      [D("001102-2")]: { status: 200, body: mkpPage("吉浜") },
      [D("009999-0")]: { status: 200, body: "<html><body>作りの違うページ</body></html>" },
    } });
  assert.ok(!calls.includes("https://mkp.jp/misc/404.php"));   // 転送は追わない（転送先を取りに行く1回も減る）
  const st = JSON.parse(fs.readFileSync(path.join(dir, "data/mkp-crawl-state.json"), "utf8"));
  assert.match(st["001145-0"], /^GONE\|/);
  assert.doesNotMatch(st["001102-2"], /^GONE/);
  assert.doesNotMatch(st["009999-0"], /^GONE/);                // 中身を確かめていないものは寝かせない
  assert.match(log, /\[gone\] 001145-0 → \.\.\/\.\.\/\.\.\/misc\/404\.php/);
  assert.match(log, /\[no name\] 009999-0: 名前が読めない（HTTP 200/);
  assert.deepEqual([health[0].ok, health[0].n, health[0].tried, health[0].noName], [true, 1, 3, 1]);
});

// ---- 5. 後から読めた住所・名前・座標を記録に残す ----

test("補記の条件: 前に無かった名前・住所らしい住所・（満空の無い社だけ）座標が入ったときだけ", () => {
  const fee = { unitCharges: [], maxFees: [{ scope: "全日", condition: "24時間", amountYen: 800 }] };
  const base = { operator: "ecolo", parkId: "9649", name: "P", address: null, lat: null, lng: null, ...fee };
  assert.equal(gapFilled(base, { ...base, address: "奈良県奈良市学園北2-1-15" }), "住所");
  assert.equal(gapFilled({ ...base, name: null }, { ...base, name: "P" }), "名前");
  assert.equal(gapFilled({ ...base, address: "コインパーキング" }, { ...base, address: "奈良市大森町44" }), "住所");   // 住所らしくない → 住所らしい
  assert.equal(gapFilled({ ...base, address: "奈良市大森町44" }, { ...base, address: "奈良県奈良市大森町44" }), null);   // 値が変わっただけ
  assert.equal(gapFilled(base, { ...base, lat: 35.1, lng: 136.9 }), "座標");
  assert.equal(gapFilled(base, { ...base, lat: 35.1, lng: 136.9 }, { coords: false }), null);   // 満空のある社は座標を見ない
  assert.equal(gapFilled({ ...base, lat: 0, lng: 0 }, { ...base, lat: 35.1, lng: 136.9 }), "座標");   // 0,0 は「無い」
  assert.equal(gapFilled(base, { ...base, address: "", lat: 0, lng: 0 }), null);
  assert.equal(gapFilled(null, base), null);                    // 初めての物件は「新規」で書く（ここでは数えない）
  assert.equal(looksLikeAddress("北海道札幌市中央区"), true);
  assert.equal(looksLikeAddress("エコロパーク"), false);
});

test("エコロの住所: 地図の無いページは住所欄から、地図の q= に都道府県名が無ければ「名称,」のあとを読む", () => {
  const head = `<p class="p-coin-parking-detail__address"> 〒630-8131 奈良県奈良市大森町44</p>
<div class="p-coin-parking-detail__title-wrap"><h1 class="p-coin-parking-detail__title">エコロパーク 奈良市大森町第1駐車場</h1></div>`;
  const fee = `<table><tr><th>料金</th><td>全日 最大 24時間 600円</td></tr></table>`;
  assert.equal(parseEcoloDetail(head + fee, { id: "9802" }).address, "奈良県奈良市大森町44");
  const map = (q) => `<h1 class="p-coin-parking-detail__title">エコロパーク 姫路伊伝居第1駐車場</h1>${fee}
<iframe src="https://www.google.com/maps/embed/v1/place?key=x&q=${encodeURIComponent(q)}"></iframe>`;
  assert.equal(parseEcoloDetail(map("エコロパーク 姫路伊伝居第1駐車場,姫路市伊伝居123"), { id: "9960" }).address, "姫路市伊伝居123");
  assert.equal(parseEcoloDetail(map("エコロパーク サウンドおしあげ,東京都墨田区押上3-2-1"), { id: "5563" }).address, "東京都墨田区押上3-2-1");
  assert.equal(parseEcoloDetail(map("エコロパーク どこか"), { id: "1" }).address, null);
});

test("通しの巡回: 住所が後から読めたら1回だけ記録に足し（changedFromPrev なし・変動に数えない）、2回目は足さない", () => {
  const E = "https://service.ecolocity.co.jp/park/coin-parking/9649/";
  const page = `<p class="p-coin-parking-detail__address"> 〒631-0036 奈良県奈良市学園北2-1-15</p>
<h1 class="p-coin-parking-detail__title">エコロパーク 学園北2丁目第1駐車場</h1>
<table><tr><th>台数</th><td>13台</td></tr><tr><th>料金</th><td>全日 最大 24時間 600円</td></tr></table>`;
  const rec = parseEcoloDetail(page, { id: "9649" });
  const prev = { ...rec, address: null, fetchedAt: "2026-07-01T00:00:00.000Z" };   // 7/1 の記録（住所なし・料金は同じ）
  const files = { "data/ecolo-ids.txt": "9649\n", "data/ecolo-ids.txt.fetched": new Date().toISOString(),
    "data/prices-test.jsonl": JSON.stringify(prev) + "\n" };
  const routes = { [E]: { status: 200, body: page } };
  const r1 = runCrawl({ env: { CRAWL_ONLY: "ecolo" }, files, routes });
  const rows = () => fs.readFileSync(path.join(r1.dir, "data/prices-test.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows().length, 2);
  assert.equal(rows()[1].address, "奈良県奈良市学園北2-1-15");
  assert.equal(rows()[1].changedFromPrev, undefined);
  assert.match(r1.log, /\[FILLED\] ecolo:9649 .*住所が読めたので記録に足す/);
  assert.match(r1.log, /変動0 \/ 追記1行（うち名前・住所・座標の補記1行）/);
  const r2 = runCrawl({ env: { CRAWL_ONLY: "ecolo" }, routes, dir: r1.dir });   // 同じ作業場所でもう1回
  assert.equal(r2.calls.filter((u) => u === E).length, 1);
  assert.equal(rows().length, 2);                                // 2回目は足さない
  assert.match(r2.log, /追記0行/);
});

// ---- 6. 2回目の点検の指摘 ----

const CS = "https://www.carshares.jp";
const csStation = (i, p) => ({ k: `mitsui:${i}`, n: `S${i}`, a: null, la: 35, ln: 139, cars: 1, cls: {}, path: p, at: "2026-10-13T00:00:00.000Z" });
const csPage = (i) => `<h1 class="mainTitle01">S${i}</h1><a href="/reserve/?station_id=${i}">予約</a>このステーションのクルマ（1台）
<meta itemprop="latitude" content="35"><meta itemprop="longitude" content="139">料金プランの詳細`;
const csFiles = (rows, state) => ({ "data/carshares-crawl-state.json": JSON.stringify(state),
  "data/carshare-mitsui.jsonl": rows.map((r) => JSON.stringify(r)).join("\n") + "\n" });
const readText = (dir, f) => fs.readFileSync(path.join(dir, f), "utf8");

test("カーシェアーズ: 巡の途中で robots.txt が 503 なら、そのページを列に戻して打ち切る（gone を書かない・列は減らない・終了コード 1）", () => {
  // 巡の途中（一覧の残り30・全20ステーションのうち8を見た）
  const rows = Array.from({ length: 20 }, (_, i) => csStation(i + 1, `/station/tokyo/c${i % 4}/s${i + 1}/`));
  const state = { cycleStart: "2026-10-20T00:00:00.000Z", cycleEnd: null, queue: Array.from({ length: 30 }, (_, i) => `/station/tokyo/c${i}/`),
    done: ["/station/tokyo/"], seen: rows.slice(0, 8).map((r) => r.k) };
  const files = csFiles(rows, state);
  const r = runCrawl({ script: "src/carshares.js", status: 1, env: { CARSHARE_DELAY_MS: "0" }, files,
    routes: { "*robots": { status: 503 }, "*": { status: 200, body: "<html></html>" } } });
  assert.deepEqual(r.calls, [`${CS}/robots.txt`]);                       // 本ページは1回も送らない
  assert.equal(readText(r.dir, "data/carshare-mitsui.jsonl"), files["data/carshare-mitsui.jsonl"]);   // gone の行は0件
  const after = JSON.parse(readText(r.dir, "data/carshares-crawl-state.json"));
  assert.deepEqual(after.queue, state.queue);                            // 列は減らない（見送ったページも先頭に戻す）
  assert.deepEqual(after.done, state.done);
  assert.deepEqual(after.seen, state.seen);
  assert.equal(after.cycleEnd, null);
  assert.doesNotMatch(r.log, /1巡終わり/);
  assert.match(r.log, /robots\.txt に届かない（相手先の障害の可能性）（HTTP 503）。この回は打ち切り/);
  assert.match(r.log, /取得 0ページ.*残りの一覧 30・打ち切り: robots\.txt に届かない/);
});

test("カーシェアーズ: 不調で取れないページは1回だけ列の最後で取り直し、2回とも取れなければその下のステーションは gone にしない", () => {
  const rows = [csStation(1, "/station/tokyo/a/s1/"), csStation(2, "/station/tokyo/a/s2/"), csStation(3, "/station/tokyo/b/s3/"),
    csStation(4, "/station/tokyo/b/s4/"), csStation(5, "/station/osaka/c/s5/"), csStation(6, "/station/osaka/c/s6/")];
  const state = { cycleStart: "2026-10-20T00:00:00.000Z", cycleEnd: null,
    queue: ["/station/tokyo/a/", "/station/tokyo/b/", "/station/osaka/c/"], done: ["/station/"], seen: [] };
  const r = runCrawl({ script: "src/carshares.js", env: { CARSHARE_DELAY_MS: "0" }, files: csFiles(rows, state), routes: {
    [`${CS}/robots.txt`]: { status: 200, body: "User-agent: *\nDisallow: /pdf/\n" },
    [`${CS}/station/tokyo/a/`]: { status: 200, body: '<a href="/station/tokyo/a/s1/">S1</a>' },   // s2 は載っていない＝無くなった
    [`${CS}/station/tokyo/a/s1/`]: { status: 200, body: csPage(1) },
    [`${CS}/station/tokyo/b/`]: { status: 503, body: "busy" },                                   // 2回とも取れない
    [`${CS}/station/osaka/c/`]: { status: 404 },                                                 // 一覧ごと無くなった
  } });
  assert.deepEqual(r.calls.filter((u) => !u.endsWith("/robots.txt")).map((u) => u.slice(CS.length)),
    ["/station/tokyo/a/", "/station/tokyo/b/", "/station/osaka/c/", "/station/tokyo/a/s1/", "/station/tokyo/b/"]);
  const gone = readText(r.dir, "data/carshare-mitsui.jsonl").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.gone).map((x) => x.k);
  assert.deepEqual(gone.sort(), ["mitsui:2", "mitsui:5", "mitsui:6"]);  // 3・4（取れなかった b の下）は書かない
  const after = JSON.parse(readText(r.dir, "data/carshares-crawl-state.json"));
  assert.ok(after.cycleEnd);
  assert.deepEqual([after.lastCycle.gone, after.lastCycle.failedPages, after.lastCycle.kept], [3, 1, 2]);
  assert.deepEqual([after.retried, after.failed], [[], []]);             // 次の巡には持ち越さない
  assert.match(r.log, /取れなかった1ページの下の2件は、無くなったとしない/);
});

test("カーシェアーズ: 不調が続いたら打ち切り、1巡終わりにしない（終了コード 1）", () => {
  const rows = [csStation(1, "/station/tokyo/a/s1/")];
  const queue = ["/station/p1/", "/station/p2/", "/station/p3/", "/station/p4/"];
  const r = runCrawl({ script: "src/carshares.js", status: 1, env: { CARSHARE_DELAY_MS: "0", CARSHARE_BREAKER: "3" },
    files: csFiles(rows, { cycleStart: "2026-10-20T00:00:00.000Z", cycleEnd: null, queue, done: [], seen: [] }),
    routes: { "*robots": { status: 200, body: "" }, "*": { status: 502 } } });
  assert.equal(r.calls.filter((u) => !u.endsWith("/robots.txt")).length, 3);
  const after = JSON.parse(readText(r.dir, "data/carshares-crawl-state.json"));
  assert.deepEqual(after.queue, ["/station/p3/", "/station/p4/", "/station/p1/", "/station/p2/"]);
  assert.equal(after.cycleEnd, null);
  assert.equal(readText(r.dir, "data/carshare-mitsui.jsonl").split("\n").filter(Boolean).length, 1);   // gone は書かない
  assert.match(r.log, /相手先の不調（3ページ続けて取れず。最後は HTTP 502）。この回は打ち切り/);
});

/** ナビパークの一覧（前の一覧 n 件。取得日は8日前＝作り直す時期） */
function naviFiles(n) {
  const codes = Array.from({ length: n }, (_, i) => `N${String(i + 1).padStart(4, "0")}`);
  const fetched = new Date(Date.now() - 8 * 864e5).toISOString();
  return { codes, fetched, files: { "data/navipark-codes.txt": codes.join("\n") + "\n", "data/navipark-codes.txt.fetched": fetched } };
}

test("ナビパーク: robots.txt が 503 なら一覧を作り直さない（上書きしない・取得日を進めない）。health は ok:false", () => {
  const { files, fetched } = naviFiles(12);
  const r = runCrawl({ env: { CRAWL_ONLY: "navipark" }, files, routes: { "*robots": { status: 503 }, "*": { status: 200, body: "<html></html>" } } });
  assert.deepEqual(r.calls, ["https://www.navipark1.com/robots.txt"]);
  assert.equal(readText(r.dir, "data/navipark-codes.txt"), files["data/navipark-codes.txt"]);
  assert.equal(readText(r.dir, "data/navipark-codes.txt.fetched"), fetched);
  assert.equal(r.health.length, 1);
  assert.deepEqual([r.health[0].op, r.health[0].ok, r.health[0].n], ["navipark", false, 0]);
  assert.match(r.health[0].reason, /^一覧: ナビパーク: robots\.txt に届かない（相手先の障害の可能性）（HTTP 503）/);
});

test("ナビパーク: 取れた一覧が前の一覧の半分未満なら前の一覧を使い（取得日は進めない）、health で知らせる。0件で前も無ければ失敗", async () => {
  const N = "https://www.navipark1.com";
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "navi-"));
  const cacheFile = path.join(dir, "navipark-codes.txt");
  const prev = Array.from({ length: 10 }, (_, i) => `P${i}`);
  fs.writeFileSync(cacheFile, prev.join("\n") + "\n");
  const routes = (codes) => ({ [`${N}/searchAreaList-13/`]: '<a href="/parkingList-13-101/">千代田区</a>',
    [`${N}/parkingList-13-101/`]: codes.map((c) => `<a href="/parkingDetail/${c}.html">x</a>`).join("") });
  _resetRobotsCache();
  stubFetch(routes(["P1", "P2"]));                                          // 2件だけ（ほかの県は 404）
  const got = await getAllNaviparkCodes({ cacheFile, cacheMs: 7 * 864e5 });
  assert.deepEqual([...got], prev);
  assert.match(got.staleReason, /一覧を作り直せていない: 一覧が2件しか取れなかった（前回10件）/);
  assert.equal(fs.readFileSync(cacheFile, "utf8"), prev.join("\n") + "\n");
  assert.equal(fs.existsSync(`${cacheFile}.fetched`), false);               // 取得日は進めない＝次の回に作り直す
  // 半分以上取れれば書き直す
  _resetRobotsCache();
  stubFetch(routes(["P1", "P2", "P3", "P4", "P5", "NEW"]));
  const ok = await getAllNaviparkCodes({ cacheFile, cacheMs: 7 * 864e5 });
  assert.deepEqual(ok, ["P1", "P2", "P3", "P4", "P5", "NEW"]);
  assert.equal(ok.staleReason, undefined);
  assert.ok(fs.existsSync(`${cacheFile}.fetched`));
  // 前の一覧も無く0件なら失敗（空の一覧は書かない）
  const empty = path.join(dir, "empty.txt");
  _resetRobotsCache();
  stubFetch({});
  await assert.rejects(getAllNaviparkCodes({ cacheFile: empty, cacheMs: 7 * 864e5 }), /一覧が0件しか取れなかった（前回0件）/);
  assert.equal(fs.existsSync(empty), false);
});

test("一覧が0件の回は health を ok:false にする（取る物件が無い＝成功にしない）", () => {
  // リパークの sitemap が作りの変更で0件になった。前の一覧も無いので失敗にする
  const r = runCrawl({ env: { CRAWL_ONLY: "repark" },
    routes: { "https://www.repark.jp/sitemap_park.xml": { status: 200, body: "<urlset></urlset>" } } });
  assert.equal(r.health[0].ok, false);
  assert.match(r.health[0].reason, /一覧が0件しか取れなかった（前回0件）/);
  assert.equal(fs.existsSync(path.join(r.dir, "data/repark-sitemap.xml")), false);
});

test("一覧の取得失敗の理由: robots.txt で見送ったときは「HTTP null」ではなく見送りの理由を出す", async () => {
  _resetRobotsCache();
  stubFetch({ "https://kte.ne.jp/robots.txt": { status: 503 } });
  await assert.rejects(getAllKyotechIds({}), /一覧取得失敗: robots\.txt に届かない（相手先の障害の可能性）（HTTP 503）/);
});

test("一斉の閉鎖の歯止め: 前は生きていた物件の閉鎖が min 件以上かつ答えた数の半分以上で止め、この回の印を全部前の値に戻す", () => {
  const g = makeMassGone({ min: 3, ratio: 0.5 });
  const state = { a: "t1", b: "t2", c: "t3", d: undefined, e: "GONE|old" };
  for (let i = 0; i < 3; i++) g.answered();
  assert.equal(g.closed("a", state.a), false);                             // 1件
  assert.equal(g.closed("d", undefined, false), false);                    // 初めての物件は数えない
  assert.equal(g.closed("e", state.e, false), false);                      // 寝かせた物件の起き抜けも数えない
  assert.equal(g.closed("b", state.b), false);                             // 2件
  for (const k of ["a", "b", "c", "d", "e"]) state[k] = "GONE|now";
  g.answered();
  assert.equal(g.closed("c", "t3"), true);                                 // 3件・答えた4件の75%
  assert.deepEqual(g.stats, { answered: 4, closed: 3, marked: 5 });
  assert.equal(g.restore(state), 5);                                       // 数えなかった分も戻す
  assert.deepEqual(state, { a: "t1", b: "t2", c: "t3", e: "GONE|old" });
  // 割合が足りなければ止めない
  const h = makeMassGone({ min: 3, ratio: 0.5 });
  for (let i = 0; i < 10; i++) h.answered();
  for (const id of ["a", "b", "c", "d"]) assert.equal(h.closed(id, "t"), false);   // 4件・10件中40%
});

const MK = (id) => `https://mkp.jp/search/detail/${id}`;
/** 名鉄協商の一覧 n 件と、全件「前は取れていた」状態（古い順） */
function mkpFiles(n) {
  const ids = Array.from({ length: n }, (_, i) => `00${String(1000 + i)}-0`);
  const state = { _list: listHash(ids), ...Object.fromEntries(ids.map((id, i) => [id, new Date(Date.now() - (n - i) * 3600e3).toISOString()])) };
  return { ids, state, files: { "data/mkp-ids.txt": ids.join("\n") + "\n", "data/mkp-ids.txt.fetched": new Date().toISOString(),
    "data/mkp-crawl-state.json": JSON.stringify(state) } };
}

test("通しの巡回: 全ページが /misc/404.php へ転送される（作り替え・保守）と、30件で止めて閉鎖の印を戻す。health は mass-gone", () => {
  const { ids, state, files } = mkpFiles(45);
  const r = runCrawl({ env: { CRAWL_ONLY: "mkp", ROLLING_PER_RUN: "45" }, files,
    routes: { "*": { status: 302, location: "../../../misc/404.php" } } });
  assert.equal(r.calls.filter((u) => !u.endsWith("/robots.txt")).length, 30);   // 30件目で止める（残り15件は送らない）
  assert.deepEqual(JSON.parse(readText(r.dir, "data/mkp-crawl-state.json")), state);   // 印は全部戻す（日付も進めない）
  assert.equal(r.health[0].ok, false);
  assert.equal(r.health[0].kind, "mass-gone");
  assert.equal(r.health[0].restored, 30);
  assert.match(r.health[0].reason, /閉鎖とみなした物件が多すぎる（前は取れていた物件30件のうち30件が 404・掲載終了の転送）。.*閉鎖の印30件を戻して打ち切り/);
  assert.ok(!r.calls.includes(MK(ids[30])));
});

test("通しの巡回: 止めたときは、数えなかった物件（一覧から外れた物件など）に付けた印も戻す（エコロ: 全ページが / へ転送）", () => {
  const ids = Array.from({ length: 40 }, (_, i) => String(5000 + i));
  const dropped = Array.from({ length: 10 }, (_, i) => String(9000 + i));    // 一覧から外れた物件（いちばん古い＝先に取る）
  const state = { _list: listHash(ids),
    ...Object.fromEntries(dropped.map((id, i) => [id, new Date(Date.now() - (100 - i) * 864e5).toISOString()])),
    ...Object.fromEntries(ids.map((id, i) => [id, new Date(Date.now() - (50 - i) * 3600e3).toISOString()])) };
  const r = runCrawl({ env: { CRAWL_ONLY: "ecolo", ROLLING_PER_RUN: "50" },
    files: { "data/ecolo-ids.txt": ids.join("\n") + "\n", "data/ecolo-ids.txt.fetched": new Date().toISOString(), "data/ecolo-crawl-state.json": JSON.stringify(state) },
    routes: { "*robots": { status: 200, body: "" }, "*": { status: 301, location: "https://service.ecolocity.co.jp/" } } });
  assert.equal(r.calls.filter((u) => !u.endsWith("/robots.txt")).length, 40);   // 外れた10件＋一覧の30件で止める
  assert.deepEqual(JSON.parse(readText(r.dir, "data/ecolo-crawl-state.json")), state);
  assert.deepEqual([r.health[0].kind, r.health[0].restored], ["mass-gone", 40]);
});

test("通しの巡回: 404 が一斉に返ったときも同じく止める（転送の無い社）", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `REP${String(i + 1).padStart(7, "0")}`);
  const xml = `<urlset>${ids.map((i) => `<url><loc>https://www.repark.jp/parking_user/time/result/detail/?park=${i}</loc></url>`).join("")}</urlset>`;
  const state = { _list: listHash(ids), ...Object.fromEntries(ids.map((id, i) => [id, `${new Date(Date.now() - (50 - i) * 3600e3).toISOString()}|0`])) };
  const r = runCrawl({ env: { CRAWL_ONLY: "repark", ROLLING_PER_RUN: "40" },
    files: { "data/repark-sitemap.xml": xml, "data/repark-sitemap.xml.fetched": new Date().toISOString(), "data/repark-crawl-state.json": JSON.stringify(state) },
    routes: { "*": { status: 404 } } });
  assert.equal(r.calls.filter((u) => !u.endsWith("/robots.txt")).length, 30);
  assert.deepEqual(JSON.parse(readText(r.dir, "data/repark-crawl-state.json")), state);
  assert.equal(r.health[0].kind, "mass-gone");
});

test("通しの巡回: 寝かせた期限が切れた物件（起き抜け）がまた 404 でも一斉の閉鎖に数えず、寝かせ直す", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `REP${String(i + 1).padStart(7, "0")}`);
  const xml = `<urlset>${ids.map((i) => `<url><loc>https://www.repark.jp/parking_user/time/result/detail/?park=${i}</loc></url>`).join("")}</urlset>`;
  const old = `GONE|${new Date(Date.now() - 70 * 864e5).toISOString()}`;          // 60日を過ぎて起きている
  const state = { _list: listHash(ids), ...Object.fromEntries(ids.map((id) => [id, old])) };
  const r = runCrawl({ env: { CRAWL_ONLY: "repark", ROLLING_PER_RUN: "40" },
    files: { "data/repark-sitemap.xml": xml, "data/repark-sitemap.xml.fetched": new Date().toISOString(), "data/repark-crawl-state.json": JSON.stringify(state) },
    routes: { "*": { status: 404 } } });
  assert.equal(r.calls.filter((u) => !u.endsWith("/robots.txt")).length, 40);
  const after = JSON.parse(readText(r.dir, "data/repark-crawl-state.json"));
  for (const id of ids) assert.ok(after[id].startsWith("GONE|") && after[id] !== old, id);   // 今の日付で寝かせ直す
  assert.notEqual(r.health[0].kind, "mass-gone");
});

test("通しの巡回: 正しい閉鎖が2割ほど（名鉄協商の最初の回と同じ）なら止めず、閉鎖は寝かせる", () => {
  const { ids, files } = mkpFiles(100);
  const closed = new Set(ids.filter((_, i) => i % 9 === 0 || i % 9 === 4));   // 23件
  const routes = Object.fromEntries(ids.map((id) => [MK(id), closed.has(id) ? { status: 302, location: "../../../misc/404.php" } : { status: 200, body: mkpPage(`P${id}`) }]));
  const r = runCrawl({ env: { CRAWL_ONLY: "mkp", ROLLING_PER_RUN: "100" }, files, routes });
  const after = JSON.parse(readText(r.dir, "data/mkp-crawl-state.json"));
  assert.equal(ids.filter((id) => String(after[id]).startsWith("GONE|")).length, closed.size);
  assert.deepEqual([r.health[0].ok, r.health[0].n, r.health[0].kind], [true, 100 - closed.size, undefined]);
});

test("通しの巡回: 一覧から消えた物件の確かめ（ほとんど 404 で当たり前）は一斉の閉鎖に数えない", () => {
  const { list, state, files } = timesFiles(5);
  // 一覧から消えた35件（一覧を作る前に取ったもの）。確かめると全部 404
  const dropped = Array.from({ length: 35 }, (_, i) => TU(900 + i));
  for (const u of dropped) state[u] = `${new Date(Date.now() - 40 * 864e5).toISOString()}|0`;
  files["data/times-crawl-state.json"] = JSON.stringify(state);
  const routes = Object.fromEntries(dropped.map((u) => [u, { status: 404 }]));
  const r = runCrawl({ env: { CRAWL_ONLY: "times", ROLLING_PER_RUN: "5" }, files, routes: { ...routes, "*": { status: 200, body: "<html></html>" } } });
  const after = JSON.parse(readText(r.dir, "data/times-crawl-state.json"));
  assert.equal(dropped.filter((u) => String(after[u]).startsWith("GONE|")).length, 35);
  assert.notEqual(r.health[0].kind, "mass-gone");
  for (const u of list) assert.ok(r.calls.includes(u));                   // 一覧の物件もいつもどおり取る
});
