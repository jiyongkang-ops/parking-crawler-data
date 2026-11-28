// 東京（Cloud Build）で巡回する手順のテスト（2026-11-28。npm test）。相手先には繋がない（fetch を差し替える）。
//   scripts/tokyo-prepare.sh … 送るのは巡回の中身と対象の社の状態だけ（ほかの社のファイル・大きいデータは送らない）
//   scripts/tokyo-crawl.sh   … 東京の中で src/run.js を動かし、持ち帰るもの（料金の記録・health・対象の社の状態・ログ）だけを tgz にする。
//                              巡回が失敗しても 0 で終え、失敗の理由（health）を持ち帰る。data/priority-lots.json は持ち帰らない
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SITEMAP_INDEX } from "../src/coinpark.js";
import { LIST_URL as PJ_LIST, detailUrl as pjUrl, parseParkjapanList } from "../src/parkjapan.js";
import { INDEX_URL as P1_INDEX, parseIndex, parseAreaList } from "../src/park1st.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fx = (f) => fs.readFileSync(path.join(ROOT, "test/fixtures/more", f), "utf8");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** リポジトリの写し（巡回の中身＋偽の data）を作る */
function fakeRepo() {
  const repo = tmp("tokyo-repo-");
  for (const f of ["src", "config.js", "package.json", "package-lock.json", "scripts", "cloudbuild-tokyo.yaml"]) {
    fs.cpSync(path.join(ROOT, f), path.join(repo, f), { recursive: true });
  }
  const put = (f, body) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), body); };
  put("data/coinpark-crawl-state.json", "{}\n");
  put("data/park1st-ids.txt.failed", "x\n");
  put("data/tobupark-ids.txt", "1\n");              // 対象外の社
  put("data/prices-extra.jsonl", "{}\n");           // ほかの巡回の記録
  put("data/vacancy-2026-11-28.jsonl", "{}\n");     // 大きいデータ
  put("data/priority-lots.json", '{"byOp":{}}\n');  // 読むだけ（持ち帰らない）
  put("data/health/crawl-extra.json", "{}\n");
  return repo;
}

function prepare(repo, env = {}) {
  const dest = tmp("tokyo-src-");
  const p = spawnSync("bash", ["scripts/tokyo-prepare.sh", dest], { cwd: repo, encoding: "utf8", env: { ...process.env, ...env } });
  return { p, dest, files: listFiles(dest) };
}
const listFiles = (dir) => {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); e.isDirectory() ? walk(f) : out.push(path.relative(dir, f)); } };
  walk(dir);
  return out.sort();
};

/** 送り先のフォルダで tokyo-crawl.sh を動かす（npm ci はとばし、node_modules はこのリポジトリのものを使う） */
function crawlIn(dest, routes) {
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dest, "node_modules"));
  const routesFile = path.join(dest, "routes.json"), stub = path.join(dest, "stub.mjs");
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  fs.writeFileSync(stub, `
import fs from "node:fs";
import { config } from ${JSON.stringify(pathToFileURL(path.join(dest, "config.js")).href)};
config.minDelayMs = 0; config.coinparkMinDelayMs = 0;
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"));
globalThis.fetch = async function stub(url) {
  const u = String(url);
  let r = routes[u];
  if (r === undefined) r = u.endsWith("/robots.txt") ? (routes["*robots"] ?? { status: 404 }) : (routes["*"] ?? { status: 404 });
  if (r.throw) { const e = new TypeError("fetch failed"); e.cause = { code: r.throw }; throw e; }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "", headers: { get: () => null } };
};
`);
  const p = spawnSync("bash", ["scripts/tokyo-crawl.sh"], {
    cwd: dest, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, TOKYO_SKIP_NPM: "1", NODE_OPTIONS: `--import ${pathToFileURL(stub).href}`, CRAWL_HOLD: "off", ROLLING_PASSES: "1", ROLLING_PER_RUN: "10" },
  });
  const out = tmp("tokyo-out-");
  const tgz = path.join(dest, "tokyo-out.tgz");
  if (fs.existsSync(tgz)) spawnSync("tar", ["xzf", tgz, "-C", out]);
  return { p, out, files: listFiles(out), log: `${p.stdout}\n${p.stderr}` };
}

test("送るもの: 巡回の中身と対象の社の状態だけ（ほかの社・ほかの巡回の記録・満空は送らない）", () => {
  const { p, files } = prepare(fakeRepo());
  assert.equal(p.status, 0, p.stderr);
  assert.ok(files.includes("src/run.js") && files.includes("config.js") && files.includes("package-lock.json"));
  assert.ok(files.includes("scripts/tokyo-crawl.sh") && files.includes("cloudbuild-tokyo.yaml"));
  assert.deepEqual(files.filter((f) => f.startsWith("data/")), ["data/coinpark-crawl-state.json", "data/park1st-ids.txt.failed", "data/priority-lots.json"]);
  assert.ok(!files.some((f) => f.startsWith("test/") || f.startsWith(".github/")));
});

test("送るもの: 社の名前に変な文字があれば止める", () => {
  const { p } = prepare(fakeRepo(), { TOKYO_OPS: "coinpark,../x" });
  assert.notEqual(p.status, 0);
});

test("東京の中の巡回: 3社を取り、持ち帰るのは料金の記録・health・3社の状態・ログだけ", () => {
  const { dest } = prepare(fakeRepo());
  const cpUrl = "https://www.coinpark.info/%e3%81%82/";
  const p1Area = parseIndex(fx("park1st-index.html"))[0];
  const p1Url = parseAreaList(fx("park1st-list.html"))[0];
  const pjIds = parseParkjapanList(fx("parkjapan-list.html")).map((x) => x.id);
  const ok = (body) => ({ status: 200, body });
  const routes = {
    [SITEMAP_INDEX]: ok("<sitemapindex><sitemap><loc>https://www.coinpark.info/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>"),
    "https://www.coinpark.info/wp-sitemap-posts-post-1.xml": ok(`<urlset><url><loc>${cpUrl}</loc></url></urlset>`),
    [cpUrl]: ok(fx("coinpark-a3635.html")),
    [PJ_LIST]: ok(fx("parkjapan-list.html")),
    ...Object.fromEntries(pjIds.map((id) => [pjUrl(id), ok(fx("parkjapan-1000021.html"))])),
    [P1_INDEX]: ok(fx("park1st-index.html")), [p1Area]: ok(fx("park1st-list.html")), [p1Url]: ok(fx("park1st-79.html")),
  };
  for (const a of parseIndex(fx("park1st-index.html")).slice(1)) routes[a] = ok("<p>なし</p>");
  const r = crawlIn(dest, routes);
  assert.equal(r.p.status, 0, r.log);
  assert.ok(r.files.includes("data/prices-tokyo.jsonl"), r.log);
  assert.ok(r.files.includes("data/health/crawl-tokyo.json"));
  assert.ok(r.files.includes("data/tokyo-run.log"));
  assert.ok(r.files.includes("data/parkjapan-lots.tsv"));
  for (const op of ["coinpark", "parkjapan", "park1st"]) assert.ok(r.files.includes(`data/${op}-crawl-state.json`), op);
  assert.ok(!r.files.includes("data/priority-lots.json"));   // 毎時の crawl.yml が書くもの。古い写しで上書きしない
  assert.ok(r.files.every((f) => /^data\/((coinpark|parkjapan|park1st)-|prices-tokyo\.jsonl$|health\/crawl-tokyo\.json$|tokyo-run\.log$)/.test(f)), r.files.join(" "));
  const health = JSON.parse(fs.readFileSync(path.join(r.out, "data/health/crawl-tokyo.json"), "utf8"));
  assert.equal(health.workflow, "crawl-tokyo");
  const byOp = Object.fromEntries(health.targets.map((h) => [h.op, h]));
  for (const op of ["coinpark", "parkjapan", "park1st"]) assert.equal(byOp[op]?.ok, true, `${op}: ${byOp[op]?.reason}`);
  const rows = fs.readFileSync(path.join(r.out, "data/prices-tokyo.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual([...new Set(rows.map((x) => x.operator))].sort(), ["coinpark", "park1st", "parkjapan"]);
});

test("東京の中の巡回: つながらなくても 0 で終え、失敗の理由（health）を持ち帰る", () => {
  const { dest } = prepare(fakeRepo());
  const r = crawlIn(dest, { "*robots": { throw: "UND_ERR_CONNECT_TIMEOUT" }, "*": { throw: "UND_ERR_CONNECT_TIMEOUT" } });
  assert.equal(r.p.status, 0, r.log);
  const health = JSON.parse(fs.readFileSync(path.join(r.out, "data/health/crawl-tokyo.json"), "utf8"));
  assert.ok(health.targets.length >= 3 && health.targets.every((h) => h.ok === false), JSON.stringify(health.targets));
});
