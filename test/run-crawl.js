// run.js を別のプロセスで通しで動かす道具（test/runjs.test.js・crawl-core.test.js と同じ作り。2026-11-02 に新しい2社のテスト用に切り出した）。
// fetch は routes で差し替え、呼んだ URL を控える。事業者サイトには繋がない。
//   routes の値: { status, body, location } か { throw: "ECONNREFUSED" }。"*robots" は robots.txt の既定、"*" はほかの既定
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function runCrawl({ env = {}, routes = {}, files = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), "runcrawl-")), status = 0 }) {
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
    env: { ...process.env, CRAWL_HOLD: "off", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, status, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const hf = path.join(dir, "data/health/test.json");
  const health = fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, "utf8")).targets : null;
  const pf = path.join(dir, "data/prices-test.jsonl");
  const rows = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { calls, health, log, dir, rows, pages: calls.filter((u) => !u.endsWith("/robots.txt")) };
}
