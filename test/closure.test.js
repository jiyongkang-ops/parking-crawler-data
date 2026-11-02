// 一覧から消えた物件の扱い・NPC の上限・毎時の回の予算のテスト（npm test）。事業者サイトには繋がない（fetch を差し替え、決まったページを返す）。
// 2026-11-02 の点検で見つかったこと:
//   C3・fresh-7  巡回型で一覧から消えた物件を確かめに行くのはタイムズだけで、ナビパーク・キョウテクなどでは閉鎖（404）の印が付かないまま残っていた
//   C5・fresh-8  一覧型（NPC・ザ・パーク・GSパーク・パークネット・エムデン）には物件ごとの記録が無く、一覧から消えた物件も毎日確かめた扱いだった
//   C4           NPC の一括取得の上限（2,000件）に当たっても health は成功のままだった
//   pipeline-01  毎時の回の取得の予算が、取り出しの遅れに関係なく50分だった
//   pipeline-09  crawl-npc.yml の1回目が毎時の回の NPC の取得と同じ分の重複だった
// NPC の見本（test/fixtures/npc-location-sample.json）は 11/1 に保存した location.json の先頭3件（件数の欄だけ3件に直した）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { updateListState, recordListState, noteListState, listStateFiles, LIST_KEEP_RATIO } from "../src/list-state.js";
import { npcCapOf, NPC_LIMIT, locationUrl, JAPAN_BBOX } from "../src/npc.js";
import { confirmsDropped } from "../src/repark-enumerate.js";
import { deadlineOf, budgetUntil } from "../src/run-budget.js";
import { searchUrl as theparkUrl } from "../src/thepark.js";
import { areaListUrl } from "../src/gspark.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NPC_SAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, "test/fixtures/npc-location-sample.json"), "utf8"));
const NPC_URL = locationUrl(JAPAN_BBOX, { limit: NPC_LIMIT });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "closure-"));
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const quiet = { log() {}, warn() {} };

/** run.js を別のプロセスで通しで動かす（test/crawl-core.test.js と同じ作り）。fetch は routes で差し替え、呼んだ URL を控える */
function runCrawl({ env = {}, routes = {}, files = {}, dir = tmp(), status = 0 }) {
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
  if (r.status >= 300 && r.status < 400 && r.location && opts?.redirect !== "manual") return stub(new URL(r.location, u).href, opts);
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "",
    headers: { get: (k) => (k.toLowerCase() === "location" ? r.location ?? null : null) } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_HOLD: "off", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl",
      REPARK_MAP_MAX_REQUESTS: "0", PAGE_CACHE_MS: "0", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, status, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const hf = path.join(dir, "data/health/test.json");
  const health = fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, "utf8")).targets : null;
  return { calls, health, log, dir };
}

// ---- 1. 一覧型の物件ごとの記録（src/list-state.js） ----

test("一覧を全部取れた回: 載っていた物件に今日の日付、一覧から消えた物件は前の日付のまま。今の一覧は1行1件・番号の順", () => {
  const dir = tmp();
  const r1 = updateListState("thepark", ["3", "2", "4"], { dir, today: "2026-10-30" });
  assert.deepEqual([r1.written, r1.n, r1.prev, r1.added, r1.dropped], [true, 3, 0, 0, 0]);
  assert.deepEqual(readJson(dir, "thepark-crawl-state.json"), { 2: "2026-10-30", 3: "2026-10-30", 4: "2026-10-30" });
  assert.equal(fs.readFileSync(path.join(dir, "thepark-ids.txt"), "utf8"), "2\n3\n4\n");
  // 次の日に「4」が消え、「5」が新しく載った
  const r2 = updateListState("thepark", ["2", "3", "5"], { dir, today: "2026-10-31" });
  assert.deepEqual([r2.written, r2.n, r2.prev, r2.added, r2.dropped], [true, 3, 3, 1, 1]);
  assert.deepEqual(readJson(dir, "thepark-crawl-state.json"), { 2: "2026-10-31", 3: "2026-10-31", 4: "2026-10-30", 5: "2026-10-31" });
  assert.equal(fs.readFileSync(path.join(dir, "thepark-ids.txt"), "utf8"), "2\n3\n5\n");
});

test("同じ日に何回取っても（毎時の NPC）ファイルの中身は変わらない（毎時のコミットを増やさない）", () => {
  const dir = tmp();
  const { stateFile, idsFile } = listStateFiles("npc", dir);
  updateListState("npc", ["B", "A"], { dir, today: "2026-11-01" });
  const before = [fs.readFileSync(stateFile, "utf8"), fs.readFileSync(idsFile, "utf8")];
  updateListState("npc", ["A", "B"], { dir, today: "2026-11-01" });
  assert.deepEqual([fs.readFileSync(stateFile, "utf8"), fs.readFileSync(idsFile, "utf8")], before);
});

test("今の一覧が前の一覧の9割に満たない回は書かず、理由を返す。一覧のファイルを消すと次から書き直す", () => {
  const dir = tmp();
  const ids = Array.from({ length: 100 }, (_, i) => `P${String(i).padStart(3, "0")}`);
  updateListState("mden", ids, { dir, today: "2026-10-30" });
  const r = updateListState("mden", ids.slice(0, 89), { dir, today: "2026-10-31" });
  assert.equal(LIST_KEEP_RATIO, 0.9);
  assert.deepEqual([r.written, r.n, r.prev], [false, 89, 100]);
  assert.match(r.reason, /9割|90%/);
  assert.equal(readJson(dir, "mden-crawl-state.json").P000, "2026-10-30");   // 進めていない
  // ちょうど9割なら書く
  assert.equal(updateListState("mden", ids.slice(0, 90), { dir, today: "2026-10-31" }).written, true);
  // 人が確かめて一覧を消したら、減った一覧で書き直す（前の日付は残す）
  fs.rmSync(listStateFiles("mden", dir).idsFile);
  assert.equal(updateListState("mden", ids.slice(0, 10), { dir, today: "2026-11-01" }).written, true);
  const st = readJson(dir, "mden-crawl-state.json");
  assert.deepEqual([st.P000, st.P050, st.P099], ["2026-11-01", "2026-10-31", "2026-10-30"]);
});

test("0件の一覧は書かない。空・改行入りの番号は入れず、日付でない前の値は引き継がない", () => {
  const dir = tmp();
  assert.equal(updateListState("gspark", [], { dir, today: "2026-11-01" }).written, false);
  assert.equal(fs.existsSync(listStateFiles("gspark", dir).stateFile), false);
  fs.writeFileSync(listStateFiles("gspark", dir).stateFile, JSON.stringify({ old: "2026-09-01", bad: "GONE|2026-09-01T00:00:00Z", num: 3 }));
  updateListState("gspark", ["961", " 900 ", "", null, "a\nb", "929-3"], { dir, today: "2026-11-01" });
  assert.deepEqual(readJson(dir, "gspark-crawl-state.json"), { 900: "2026-11-01", "929-3": "2026-11-01", 961: "2026-11-01", old: "2026-09-01" });
  assert.throws(() => updateListState("gspark", ["1"], { dir, today: "2026-11-01T00:00:00Z" }));
});

test("書く回でない（料金を書かない crawl-npc.yml）・全部は取れていない回は、何も書かない", () => {
  const dir = tmp();
  assert.equal(recordListState("npc", ["A"], { complete: true, writer: false, dir, log: quiet }), null);
  assert.equal(recordListState("npc", ["A"], { complete: false, writer: true, dir, log: quiet }), null);
  assert.equal(fs.existsSync(listStateFiles("npc", dir).stateFile), false);
  assert.equal(recordListState("npc", ["A"], { complete: true, dir, log: quiet, today: "2026-11-01" }).written, true);
});

test("書くのを止めた回は health の行を ok:false（stale-list）にする。書いた回・書く回でない回は変えない", () => {
  const row = { op: "thepark", ok: true, n: 50, reason: null };
  assert.equal(noteListState({ ...row }, null).ok, true);
  assert.equal(noteListState({ ...row }, { written: true, n: 50 }).ok, true);
  const r = noteListState({ ...row }, { written: false, n: 50, prev: 100, reason: "減りすぎ" });
  assert.deepEqual([r.ok, r.kind, r.reason, r.list], [false, "stale-list", "減りすぎ", { n: 50, prev: 100 }]);
});

// ---- 2. NPC の一括取得の上限（npc.js の npcCapOf） ----

test("NPC の上限: 11/1 の答え（全1,760件・1ページ）は何も出さない。1,900件以上は「近い」、先方がまだあると答えたら「当たった」", () => {
  const real = { total: 1760, pagination: { current_page: 1, last_page: 1, per_page: 2000, total: 1760 } };
  assert.deepEqual(npcCapOf(real, 1760), { limit: 2000, total: 1760, n: 1760, over: false, near: false, reason: null });
  const near = npcCapOf({ total: 1950, pagination: { last_page: 1, per_page: 2000 } }, 1950);
  assert.deepEqual([near.over, near.near], [false, true]);
  assert.match(near.reason, /上限（2000件）に近い（1950件）/);
  const over = npcCapOf({ total: 2100, pagination: { last_page: 2, per_page: 2000 } }, 2000);
  assert.deepEqual([over.over, over.near], [true, false]);
  assert.match(over.reason, /全2100件のうち2000件だけ返った/);
  assert.equal(npcCapOf({ pagination: { last_page: 2 } }, 1500).over, true);   // total が無くても次のページがあれば欠けている
  assert.equal(npcCapOf(null, 2000).over, true);                                // 何も読めないのに上限ちょうど
  assert.equal(npcCapOf(null, 1700).over, false);
});

test("通しの巡回（NPC）: 一覧を全部取れた回は npc-crawl-state.json と npc-ids.txt を書く。番号は料金の記録の parkId と同じ", () => {
  const r = runCrawl({ env: { CRAWL_ONLY: "npc" }, routes: { [NPC_URL]: { status: 200, body: JSON.stringify(NPC_SAMPLE) } } });
  const ids = fs.readFileSync(path.join(r.dir, "data/npc-ids.txt"), "utf8").split("\n").filter(Boolean);
  const rows = fs.readFileSync(path.join(r.dir, "data/prices-test.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(ids, rows.map((x) => x.parkId).sort());
  assert.deepEqual(ids, ["OY00020000", "OY00330000", "OY00340000"]);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(Object.values(readJson(r.dir, "data/npc-crawl-state.json")), [today, today, today]);
  assert.deepEqual([r.health[0].ok, r.health[0].n, r.health[0].reason], [true, 3, null]);
});

test("通しの巡回（NPC）: 料金を書かない回（crawl-npc.yml）は書かない。1回目を取らない設定なら location.json は1回だけ", () => {
  const r = runCrawl({ env: { CRAWL_ONLY: "npc", VACANCY_ONLY: "1", NPC_REPEAT: "2", NPC_INTERVAL_MIN: "0", NPC_SKIP_FIRST: "1" },
    routes: { [NPC_URL]: { status: 200, body: JSON.stringify(NPC_SAMPLE) } } });
  assert.equal(r.calls.filter((u) => u === NPC_URL).length, 1);
  assert.deepEqual(r.health.map((t) => t.label), ["NPC全国 2/2"]);
  assert.equal(fs.existsSync(path.join(r.dir, "data/npc-crawl-state.json")), false);
  assert.equal(fs.existsSync(path.join(r.dir, "data/npc-ids.txt")), false);
  // 1回だけ取る設定（NPC_REPEAT=1）では、NPC_SKIP_FIRST があっても取る
  const r1 = runCrawl({ env: { CRAWL_ONLY: "npc", VACANCY_ONLY: "1", NPC_SKIP_FIRST: "1" }, routes: { [NPC_URL]: { status: 200, body: JSON.stringify(NPC_SAMPLE) } } });
  assert.equal(r1.calls.filter((u) => u === NPC_URL).length, 1);
});

test("通しの巡回（NPC）: 上限に当たった回は health が ok:false（stale-list）で、物件ごとの記録は進めない", () => {
  const files = { "data/npc-crawl-state.json": JSON.stringify({ OY00330000: "2026-10-01" }), "data/npc-ids.txt": "OY00330000\n" };
  const body = JSON.stringify({ ...NPC_SAMPLE, total: 2100, pagination: { ...NPC_SAMPLE.pagination, last_page: 2, total: 2100 } });
  const r = runCrawl({ env: { CRAWL_ONLY: "npc" }, files, routes: { [NPC_URL]: { status: 200, body } } });
  assert.deepEqual([r.health[0].ok, r.health[0].kind, r.health[0].cap], [false, "stale-list", { limit: 2000, total: 2100 }]);
  assert.match(r.health[0].reason, /上限（2000件）に当たった/);
  assert.match(r.log, /::warning::\[NPC全国\]/);
  assert.deepEqual(readJson(r.dir, "data/npc-crawl-state.json"), { OY00330000: "2026-10-01" });
});

test("通しの巡回（ザ・パーク）: 一覧から消えた物件は前の日付のまま、取れなかった回は何も変えない", () => {
  const list = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: `ザ・パークテスト${i + 1}` }));
  const files = { "data/thepark-crawl-state.json": JSON.stringify({ 99: "2026-09-01" }), "data/thepark-ids.txt": "99\n" };
  const r = runCrawl({ env: { CRAWL_ONLY: "thepark" }, files, routes: { [theparkUrl()]: { status: 200, body: JSON.stringify(list) } } });
  const st = readJson(r.dir, "data/thepark-crawl-state.json");
  assert.equal(st["99"], "2026-09-01");
  assert.equal(st["1"], new Date().toISOString().slice(0, 10));
  assert.equal(Object.keys(st).length, 21);
  // 次の回は 500 で取れない → 記録はそのまま
  const before = fs.readFileSync(path.join(r.dir, "data/thepark-crawl-state.json"), "utf8");
  const r2 = runCrawl({ env: { CRAWL_ONLY: "thepark" }, dir: r.dir, routes: { [theparkUrl()]: { status: 500 } } });
  assert.equal(r2.health[0].ok, false);
  assert.equal(fs.readFileSync(path.join(r.dir, "data/thepark-crawl-state.json"), "utf8"), before);
  // 一覧が半分に減った回は書かず、health で知らせる
  const r3 = runCrawl({ env: { CRAWL_ONLY: "thepark" }, dir: r.dir, routes: { [theparkUrl()]: { status: 200, body: JSON.stringify(list.slice(0, 10)) } } });
  assert.deepEqual([r3.health[0].ok, r3.health[0].kind, r3.health[0].list], [false, "stale-list", { n: 10, prev: 20 }]);
  assert.equal(fs.readFileSync(path.join(r.dir, "data/thepark-crawl-state.json"), "utf8"), before);
});

/** GSパークのエリア一覧のページ（物件の表を ids の数だけ。next … 次のページがあるか） */
const gsPage = (ids, next = false) => ids.map((id) => `<table class="result_list"><tr><td><a href="https://www.gs-park.com/time_parking/${id}/">GSパーク${id}</a></td></tr>`
  + `<tr><th>所在地</th><td>東京都千代田区</td></tr></table>`).join("") + (next ? '<a class="next page-numbers" href="#">次</a>' : "");

test("通しの巡回（GSパーク）: 全部のエリアを最後のページまで取れた回だけ書く。途中のページが取れなかった回は進めない", () => {
  const files = { "data/gspark-areas.txt": "e0101\ne0102\n", "data/gspark-areas.txt.fetched": new Date().toISOString() };
  const ok = { [areaListUrl("e0101")]: { status: 200, body: gsPage(["900", "929-3"], true) }, [areaListUrl("e0101", 2)]: { status: 200, body: gsPage(["961"]) },
    [areaListUrl("e0102")]: { status: 200, body: gsPage(["970"]) } };
  const r = runCrawl({ env: { CRAWL_ONLY: "gspark" }, files, routes: ok });
  assert.equal(fs.readFileSync(path.join(r.dir, "data/gspark-ids.txt"), "utf8"), "900\n929-3\n961\n970\n");
  const before = fs.readFileSync(path.join(r.dir, "data/gspark-crawl-state.json"), "utf8");
  // 2ページ目が 500 → health は今までどおり成功だが、一覧は欠けているので記録は進めない
  const r2 = runCrawl({ env: { CRAWL_ONLY: "gspark" }, dir: r.dir, routes: { ...ok, [areaListUrl("e0101", 2)]: { status: 500 } } });
  assert.equal(r2.health[0].ok, true);
  assert.equal(fs.readFileSync(path.join(r.dir, "data/gspark-crawl-state.json"), "utf8"), before);
  assert.match(r2.log, /一覧を全部は取れなかったので/);
});

// ---- 3. 巡回型で一覧から消えた物件を確かめる（confirmsDropped） ----

test("一覧から消えた物件を確かめる社: 既定で全社。ル・パルク（false）・エコロ（recheckDropped）・保留中の回は確かめない", () => {
  assert.equal(confirmsDropped({ op: "navipark" }), true);
  assert.equal(confirmsDropped({ op: "times", confirmDropped: true }), true);
  assert.equal(confirmsDropped({ op: "leparc", confirmDropped: false }), false);
  assert.equal(confirmsDropped({ op: "ecolo", recheckDropped: true }), false);
  assert.equal(confirmsDropped({ op: "kintetsu" }, { hold: { until: "2026-11-24" } }), false);
});

/** キョウテクの一覧（作り直したばかり）と、一覧から消えた物件を含む状態ファイル */
function kyotechFiles(dropped) {
  const list = ["a-park", "b-park"];
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  const state = Object.fromEntries([...list, ...dropped].map((id) => [id, `${old}|0`]));
  return { list, files: {
    "data/kyotech-ids.txt": list.join("\n") + "\n", "data/kyotech-ids.txt.fetched": new Date(Date.now() - 864e5).toISOString(),
    "data/kyotech-crawl-state.json": JSON.stringify(state) } };
}
const KT = (id) => `https://kte.ne.jp/parking/${encodeURIComponent(id)}/`;

test("通しの巡回（キョウテク）: 一覧から消えた物件を1回だけ取りに行き、404 なら GONE、まだ載っていれば GONE にしない", () => {
  const { files } = kyotechFiles(["gone-park", "alive-park"]);
  const routes = { [KT("gone-park")]: { status: 404 }, [KT("alive-park")]: { status: 200, body: "<html></html>" }, "*": { status: 200, body: "<html></html>" } };
  const r = runCrawl({ env: { CRAWL_ONLY: "kyotech" }, files, routes });
  const st = readJson(r.dir, "data/kyotech-crawl-state.json");
  assert.ok(String(st["gone-park"]).startsWith("GONE|"));
  assert.ok(!String(st["alive-park"]).startsWith("GONE|"));
  assert.equal(r.calls.filter((u) => u === KT("gone-park") || u === KT("alive-park")).length, 2);
  assert.match(r.log, /一覧から消えた2件のうち、閉鎖（404）だった1件に印を付けた/);
  // 次の回（一覧は同じ）は、確かめた物件をもう取りに行かない
  const r2 = runCrawl({ env: { CRAWL_ONLY: "kyotech" }, dir: r.dir, routes });
  assert.equal(r2.calls.filter((u) => u === KT("gone-park") || u === KT("alive-park")).length, 0);
});

// ル・パルクは一覧を全ページたどるようになった（2026-11-02 lists）ので、一覧から外れた物件もほかの社と同じく1回だけ確かめに行く
test("通しの巡回（ル・パルク）: 全件の一覧から外れた物件も、ほかの社と同じく詳細ページを1回確かめに行く", () => {
  const old = new Date(Date.now() - 40 * 864e5).toISOString();
  const files = { "data/leparc-ids.txt": "NRP00001\n", "data/leparc-ids.txt.fetched": new Date(Date.now() - 864e5).toISOString(),
    "data/leparc-crawl-state.json": JSON.stringify({ NRP00001: `${old}|0`, NRP00185: `${old}|0` }) };
  const r = runCrawl({ env: { CRAWL_ONLY: "leparc" }, files, routes: { "*": { status: 200, body: "<html></html>" } } });
  assert.ok(r.calls.some((u) => u.includes("NRP00185")), r.calls.join("\n"));
  assert.ok(r.calls.some((u) => u.includes("NRP00001")));
});

// ---- 4. 毎時の回の予算（src/run-budget.js） ----

test("予算: 次の時の02分までに終える。08〜12分に始まる回は50分のまま、遅く始まった回だけ縮む（下限5分）", () => {
  const H = Date.UTC(2026, 10, 1, 3);   // 12:00 JST
  const at = (m, s = 0) => H + m * 60e3 + s * 1e3;
  assert.equal(deadlineOf(at(8), "2"), H + 3600e3 + 120e3);
  assert.equal(deadlineOf(at(0), "2"), H + 3600e3 + 120e3);
  assert.equal(deadlineOf(at(59, 59), "2"), H + 3600e3 + 120e3);
  for (const v of [undefined, "", "x", "60", "-1"]) assert.equal(deadlineOf(at(8), v), null);
  const dl = deadlineOf(at(8), "2");
  assert.equal(budgetUntil(50, { startMs: at(8, 30), deadlineMs: dl }), 50);
  assert.equal(budgetUntil(50, { startMs: at(12), deadlineMs: dl }), 50);
  assert.equal(budgetUntil(50, { startMs: at(15, 40), deadlineMs: dl }), 46);
  assert.equal(budgetUntil(50, { startMs: at(58), deadlineMs: dl }), 5);
  assert.equal(budgetUntil(50, { startMs: at(8), deadlineMs: null }), 50);
  assert.equal(budgetUntil(3, { startMs: at(58), deadlineMs: dl }), 3);   // もとの予算が下限より短ければそのまま
});

test("通しの巡回: ROLLING_END_BY_MIN があると、次の時のその分までに収まるよう予算を縮める（無ければ縮めない）", () => {
  const { files } = kyotechFiles([]);
  const routes = { "*": { status: 200, body: "<html></html>" } };
  // 予算200分は次の時の02分（今から最長62分）より必ず長いので、縮む
  const r = runCrawl({ env: { CRAWL_ONLY: "kyotech", ROLLING_BUDGET_MIN: "200", ROLLING_END_BY_MIN: "2" }, files, routes });
  const m = r.log.match(/予算を200分から(\d+)分に縮める/);
  assert.ok(m, r.log);
  assert.ok(Number(m[1]) >= 5 && Number(m[1]) <= 62, m[1]);
  assert.match(r.log, new RegExp(`予算${m[1]}分で`));
  const r2 = runCrawl({ env: { CRAWL_ONLY: "kyotech", ROLLING_BUDGET_MIN: "200" }, files, routes });
  assert.doesNotMatch(r2.log, /予算を200分から/);
  assert.match(r2.log, /予算200分で/);
});

test("ワークフロー: 毎時の回だけが予算を縮め、NPC の物件ごとの記録をコミットする。crawl-npc.yml は1回目を取らない", () => {
  const hourly = fs.readFileSync(path.join(ROOT, ".github/workflows/crawl.yml"), "utf8");
  const npc = fs.readFileSync(path.join(ROOT, ".github/workflows/crawl-npc.yml"), "utf8");
  assert.match(hourly, /ROLLING_END_BY_MIN: "2"/);
  assert.match(hourly, /git add data\/npc-crawl-state\.json data\/npc-ids\.txt/);
  assert.doesNotMatch(hourly, /VACANCY_ONLY/);   // 料金を書く回＝物件ごとの記録を書く回
  assert.match(npc, /VACANCY_ONLY: "1"/);
  assert.match(npc, /NPC_SKIP_FIRST: "1"/);
  assert.doesNotMatch(npc, /ROLLING_END_BY_MIN/);
});
