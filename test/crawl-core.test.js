// 巡回の失敗の扱いのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える）。
// 2026-10-18 の点検で見つかったことを直したぶん:
//   ・403 で断られているスペース二十四・小田急パーキングに毎回一覧を取りに行っていた。ルパルクも 403 と分かっている3ページ目を叩いていた
//   ・robots.txt に届かない（相手先が落ちている）ときも「制限なし」として本ページを取りに行き、エコロでは45分間に257回送っていた。
//     robots.txt が 403（断られている）でも本ページを送っていた
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
const { politeFetch, fetchErrorText, _resetRobotsCache } = await import("../src/polite-fetch.js");
const { isTransient, listHash } = await import("../src/repark-enumerate.js");
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
function runCrawl({ env = {}, routes = {}, files = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-core-"));
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
globalThis.fetch = async (url) => {
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
