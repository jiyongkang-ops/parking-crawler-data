// 巡回の失敗の扱いのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える）。
// 2026-10-18 の点検で見つかったことを直したぶん:
//   ・403 で断られているスペース二十四・小田急パーキングに毎回一覧を取りに行っていた。ルパルクも 403 と分かっている3ページ目を叩いていた
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
