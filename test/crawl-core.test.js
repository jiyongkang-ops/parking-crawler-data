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
const { isTransient, listHash, goneMsOf, unparkGone, countLive, pickRolling, parkIdsFromSitemap } = await import("../src/repark-enumerate.js");
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
 *  files … 作業ディレクトリに置くファイル（data/… の相対パス → 中身）。戻り値は { calls, health, log, dir } */
function runCrawl({ env = {}, routes = {}, files = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-core-")) }) {
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
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, 0, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const health = JSON.parse(fs.readFileSync(path.join(dir, "data/health/test.json"), "utf8")).targets;
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
  assert.equal(health[0].kind, "unreachable");
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
  assert.equal(health[0].kind, "transient");
  assert.match(health[0].reason, /8件続けて取れず。最後は HTTP 503/);
});

// ---- 3. 404 の一斉取り直しをならす ----

test("寝かせる期間は番号ごとに30〜60日に散り、同じ日に寝かせた964件が1日あたり約30件ずつ起きる", () => {
  // 10/12 に寝かせたリパークの964件と同じ形の番号
  const ids = Array.from({ length: 964 }, (_, i) => `REP${String(10000 + i * 97).padStart(7, "0")}`);
  const days = ids.map((id) => goneMsOf(id) / 864e5);
  for (const d of days) assert.ok(Number.isInteger(d) && d >= 30 && d <= 60, String(d));
  assert.equal(goneMsOf(ids[0]), goneMsOf(ids[0]));          // 毎回同じ（番号だけで決まる）
  const perDay = new Map();
  for (const d of days) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  assert.equal(perDay.size, 31);                              // 31日に散る
  assert.ok(Math.max(...perDay.values()) <= 60, `1日の最大 ${Math.max(...perDay.values())}件`);   // 一律30日なら964件が1日に来る
  // 寝かせた日から30日たっても、起きるのは30日の組だけ
  const at = "2026-10-12T02:00:00.000Z";
  const state = Object.fromEntries(ids.map((id) => [id, `GONE|${at}`]));
  const after30 = Date.parse(at) + 30 * 864e5 + 3600e3;
  assert.equal(countLive(ids, state, after30), perDay.get(30));
  const picked = pickRolling(ids, state, 2000, { at: new Date(after30).toISOString() });
  assert.equal(picked.length, perDay.get(30));
  // 61日たてば全部起きる
  assert.equal(countLive(ids, state, Date.parse(at) + 61 * 864e5), ids.length);
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
