// 巡回が途中で落ちた・止められたときの後始末のテスト（npm test）。事業者サイトには繋がない
// （run.js を動かすテストは fetch を差し替え、決まったページを返す。呼ばれた URL は数えるだけ）。
// 2026-10-18 点検の指摘:
//   - 落ちた回の health が、落ちるまでに済んだ事業者だけで前の回の行を置き換えていた → 前の回の行と at を残し、「巡回全体 NG」だけを足す
//   - 時間切れ・取り消しで止められても node が残っていた → ワークフローは exec node src/run.js。SIGINT で巡回状態と health を書いて終わる
//   - 巡回状態を書いている途中で止められると壊れた JSON が残った → 一時ファイルに書いてから置き換える
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFileAtomic } from "../src/write-atomic.js";
import { loadCrawlState, flushCrawlStates } from "../src/repark-enumerate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = path.join(ROOT, "src/run.js");
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "crawl-stop-"));

// fetch の差し替え。外へは出さず、決まったタイムズの詳細ページを返す（呼ばれた URL は FAKE_LOG に残す）。
// 待ち時間も短くする（本物は6秒）。STOP_AFTER 件取ったら、自分の pid を STOP_PID_FILE に書いて合図する
const STUB = `
import fs from "node:fs";
const { config } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)});
config.minDelayMs = 40; config.timesMinDelayMs = 40;
let n = 0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  fs.appendFileSync(process.env.FAKE_LOG, u.href + "\\n");
  if (u.pathname === "/robots.txt") return new Response("User-agent: *\\nAllow: /\\n", { status: 200 });
  const buk = (u.pathname.match(/BUK\\d+/) || ["BUK0"])[0];
  const page = \`<html><head><title>テスト\${buk}（東京都千代田区1-1）の時間貸駐車場｜タイムズ駐車場検索</title></head><body>
<h1>テスト\${buk}</h1><p>駐車場台数10台</p>
<!--▼▼▼全日の通常料金▼▼▼--><p class="c-ulTable_items_list_txt">00:00-00:00 30分 300円</p>
<li class="s_areaBukListItem"><a href="/P13-tokyo/C101/park-detail-\${buk}/"><p><span>1</span> テスト\${buk}</p><div class="s_bukIcon">0</div><p>本駐車場</p></a></li>
</body></html>\`;
  if (++n === Number(process.env.STOP_AFTER)) fs.writeFileSync(process.env.STOP_PID_FILE, String(process.pid));
  return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};
`;

function runCrawl(dir, env) {
  const stub = path.join(dir, "stub.mjs");
  fs.writeFileSync(stub, STUB);
  const child = spawn(process.execPath, ["--import", pathToFileURL(stub).href, RUN], {
    cwd: dir, env: { ...process.env, FAKE_LOG: path.join(dir, "fetch.log"), STOP_PID_FILE: path.join(dir, "stop.pid"), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const done = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal, out })));
  return { child, done };
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean) : []);

// extra2 と同じ並び（スペース二十四は前の回も NG、ほかは ok）の前の回の health
const PREV = {
  at: "2026-10-17T03:00:00.000Z", workflow: "crawl-extra2", only: "space24,jqparks,parknet",
  targets: [
    { op: "space24", label: "スペース二十四", ok: false, n: 0, reason: "500件取りに行って0件" },
    { op: "jqparks", label: "JQパークス", ok: true, n: 400, reason: null },
    { op: "parknet", label: "パークネット", ok: true, n: 1200, reason: null },
  ],
};
// 途中の例外を起こす回（一覧はキャッシュから読むので取りに行かない。巡回を始める前の設定の確かめで例外になる）
function setupThrow(dir, prev) {
  fs.mkdirSync(path.join(dir, "data/health"), { recursive: true });
  fs.writeFileSync(path.join(dir, "data/jqparks-ids.txt"), "1001\n1002\n");
  fs.writeFileSync(path.join(dir, "data/jqparks-ids.txt.fetched"), new Date().toISOString());
  if (prev) fs.writeFileSync(path.join(dir, "data/health/crawl-extra2.json"), JSON.stringify(prev));
}
const THROW_ENV = { CRAWL_ONLY: "jqparks", OUT_FILE: "data/prices-extra2.jsonl", HEALTH_NAME: "crawl-extra2", ROLLING_PASS_GAP_MIN: "abc" };

test("途中の例外: 前の回の事業者ごとの結果と at を残し、「巡回全体 NG」だけを足す", async () => {
  const dir = tmpDir();
  setupThrow(dir, PREV);
  const r = await runCrawl(dir, THROW_ENV).done;
  assert.equal(r.code, 1, r.out);
  assert.equal(lines(path.join(dir, "fetch.log")).length, 0);   // 取りに行く前に落ちる
  const h = readJson(path.join(dir, "data/health/crawl-extra2.json"));
  assert.equal(h.at, PREV.at);                                     // at は進めない
  assert.deepEqual(h.targets.slice(0, 3), PREV.targets);           // 前の回の行はそのまま
  assert.equal(h.targets.length, 4);
  assert.equal(h.targets[3].op, "run");
  assert.equal(h.targets[3].ok, false);
  assert.match(h.targets[3].reason, /ROLLING_PASS_GAP_MIN/);
  assert.ok(Date.parse(h.failedAt) > Date.parse(PREV.at));
  assert.deepEqual(h.partial, []);

  // 続けてもう一度落ちても「巡回全体」は1行のまま（今回のものに置き換わる）
  const r2 = await runCrawl(dir, THROW_ENV).done;
  assert.equal(r2.code, 1);
  const h2 = readJson(path.join(dir, "data/health/crawl-extra2.json"));
  assert.equal(h2.at, PREV.at);
  assert.equal(h2.targets.filter((t) => t.op === "run").length, 1);
  assert.equal(h2.targets.length, 4);
});

test("途中の例外: 前の回の health が無いときは、落ちた回の時刻で「巡回全体 NG」を書く", async () => {
  const dir = tmpDir();
  setupThrow(dir, null);
  const t0 = Date.now();
  const r = await runCrawl(dir, THROW_ENV).done;
  assert.equal(r.code, 1);
  const h = readJson(path.join(dir, "data/health/crawl-extra2.json"));
  assert.ok(Date.parse(h.at) >= t0 - 1000);
  assert.deepEqual(h.targets.map((t) => [t.op, t.ok]), [["run", false]]);
});

test("止められた（SIGINT）: すぐ終わり、50件ごとの保存の前に取った物件も巡回状態に残し、health に「巡回全体 NG」を足す", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "data/health"), { recursive: true });
  const U = (i) => `https://times-info.net/P13-tokyo/C101/park-detail-BUK${String(i).padStart(7, "0")}/`;
  const list = Array.from({ length: 300 }, (_, i) => U(i + 1));
  fs.writeFileSync(path.join(dir, "data/times-park-urls.txt"), list.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "data/times-park-urls.txt.fetched"), new Date().toISOString());
  const old = new Date(Date.now() - 20 * 864e5).toISOString();
  fs.writeFileSync(path.join(dir, "data/times-crawl-state.json"), JSON.stringify(Object.fromEntries(list.map((u) => [u, `${old}|0`]))));
  const prev = { at: "2026-10-18T00:00:00.000Z", workflow: "crawl-times", only: "times", targets: [{ op: "times", label: "タイムズ", ok: true, n: 900, reason: null }] };
  fs.writeFileSync(path.join(dir, "data/health/crawl-times.json"), JSON.stringify(prev));

  const t0 = new Date().toISOString();
  const { child, done } = runCrawl(dir, { CRAWL_ONLY: "times", OUT_FILE: "data/prices-times.jsonl", HEALTH_NAME: "crawl-times",
    ROLLING_BUDGET_MIN: "90", ROLLING_PASSES: "1", ROLLING_PER_RUN: "300", STOP_AFTER: "20" });
  // 20件ほど取ったところで（50件ごとの保存より前）、node にだけ SIGINT を送る（ランナーが手順のいちばん上に送るのと同じ）
  for (let i = 0; i < 1000 && !fs.existsSync(path.join(dir, "stop.pid")); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(path.join(dir, "stop.pid")), "20件取る前に終わった");
  const sentAt = Date.now();
  child.kill("SIGINT");
  const r = await done;
  assert.ok(Date.now() - sentAt < 5000, "SIGINT のあとすぐ終わらなかった");
  assert.equal(r.code, 130, r.out);

  // 取った物件（満空の観測がある物件）は、すべて巡回状態の日付が進んでいる
  const vac = fs.readdirSync(path.join(dir, "data")).filter((f) => /^vacancy-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .flatMap((f) => lines(path.join(dir, "data", f)));
  assert.ok(vac.length >= 20 && vac.length < 50, `観測 ${vac.length}行`);
  const state = readJson(path.join(dir, "data/times-crawl-state.json"));   // 壊れていない JSON
  const advanced = list.filter((u) => String(state[u]).split("|")[0] > t0);
  assert.equal(advanced.length, vac.length);
  // 一時ファイルは残らない
  assert.deepEqual(fs.readdirSync(path.join(dir, "data")).filter((f) => f.endsWith(".tmp")), []);
  // health: 前の回の行と at を残し、「巡回全体 NG（SIGINT）」を足す
  const h = readJson(path.join(dir, "data/health/crawl-times.json"));
  assert.equal(h.at, prev.at);
  assert.deepEqual(h.targets[0], prev.targets[0]);
  assert.equal(h.targets[1].op, "run");
  assert.match(h.targets[1].reason, /SIGINT/);
  // SIGINT のあとは取りに行かない
  const nFetch = lines(path.join(dir, "fetch.log")).length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lines(path.join(dir, "fetch.log")).length, nFetch);
});

test("巡回状態: 一時ファイルに書いてから置き換える（書けなかったら一時ファイルを残さず、前の中身のまま）", () => {
  const dir = tmpDir();
  const f = path.join(dir, "x-crawl-state.json");
  writeFileAtomic(f, JSON.stringify({ a: 1 }));
  assert.deepEqual(readJson(f), { a: 1 });
  assert.deepEqual(fs.readdirSync(dir), ["x-crawl-state.json"]);
  // 置き換え先がフォルダ（rename が失敗する）→ 例外。一時ファイルは消える
  const d = path.join(dir, "sub");
  fs.mkdirSync(d);
  fs.writeFileSync(path.join(d, "keep"), "");
  assert.throws(() => writeFileAtomic(d, "{}"));
  assert.deepEqual(fs.readdirSync(dir).sort(), ["sub", "x-crawl-state.json"]);
});

test("巡回状態: flushCrawlStates は読み込んだ状態をすべて書き出す", () => {
  const dir = tmpDir();
  const f = path.join(dir, "y-crawl-state.json");
  fs.writeFileSync(f, JSON.stringify({ a: "2026-10-01T00:00:00.000Z|0" }));
  const s = loadCrawlState(f);
  s.b = "2026-10-18T00:00:00.000Z|1";
  assert.ok(flushCrawlStates() >= 1);
  assert.deepEqual(readJson(f), { a: "2026-10-01T00:00:00.000Z|0", b: "2026-10-18T00:00:00.000Z|1" });
});

// カーシェアーズ（src/carshares.js）も同じく、止められたら状態を書いてすぐ終わる（2026-10-19 の最終点検）。
// ワークフローは exec node src/carshares.js。取りに行っている途中のページは列に戻す（済みにも数えず、落としもしない）
const CS_STUB = `
import fs from "node:fs";
let n = 0;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  fs.appendFileSync(process.env.FAKE_LOG, u.href + "\\n");
  if (u.pathname === "/robots.txt") return new Response("User-agent: *\\nDisallow: /pdf/\\n", { status: 200 });
  const i = (u.pathname.match(/s(\\d+)\\/$/) || [])[1] ?? "0";
  const page = \`<h1 class="mainTitle01">S\${i}</h1><a href="/reserve/?station_id=\${i}">予約</a>このステーションのクルマ（1台）
<meta itemprop="latitude" content="35"><meta itemprop="longitude" content="139">料金プランの詳細\`;
  if (++n === Number(process.env.STOP_AFTER)) fs.writeFileSync(process.env.STOP_PID_FILE, String(process.pid));
  return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
};
`;

test("止められた（SIGINT）: カーシェアーズも状態を書いてすぐ終わり、取りに行っている途中のページは列に戻す", async () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const paths = Array.from({ length: 100 }, (_, i) => `/station/tokyo/a/s${i + 1}/`);
  const stateFile = path.join(dir, "data/carshares-crawl-state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ cycleStart: new Date().toISOString(), cycleEnd: null, queue: paths, done: ["/station/"], seen: [] }));
  const stub = path.join(dir, "cs-stub.mjs");
  fs.writeFileSync(stub, CS_STUB);
  const child = spawn(process.execPath, ["--import", pathToFileURL(stub).href, path.join(ROOT, "src/carshares.js")], {
    cwd: dir, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FAKE_LOG: path.join(dir, "fetch.log"), STOP_PID_FILE: path.join(dir, "stop.pid"), STOP_AFTER: "20", CARSHARE_DELAY_MS: "40" },
  });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const done = new Promise((r) => child.on("exit", (code) => r({ code, out })));
  // 20ページ取ったところで（50ページごとの保存より前）、node にだけ SIGINT を送る
  for (let i = 0; i < 1000 && !fs.existsSync(path.join(dir, "stop.pid")); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fs.existsSync(path.join(dir, "stop.pid")), "20ページ取る前に終わった");
  const sentAt = Date.now();
  child.kill("SIGINT");
  const r = await done;
  assert.ok(Date.now() - sentAt < 5000, "SIGINT のあとすぐ終わらなかった");
  assert.equal(r.code, 130, r.out);
  assert.match(r.out, /SIGINT を受けました/);

  const st = readJson(stateFile);                                         // 壊れていない JSON
  const rows = lines(path.join(dir, "data/carshare-mitsui.jsonl")).map((l) => JSON.parse(l));
  const doneStations = st.done.filter((p) => p !== "/station/");
  assert.ok(doneStations.length >= 20 && doneStations.length < 50, `済み ${doneStations.length}`);
  assert.equal(rows.length, doneStations.length);                         // 書いたステーションはみな済みに入っている
  assert.equal(st.seen.length, doneStations.length);
  // 済みと列で全ページがそろう（途中のページを落とさず、二重にもしない）
  assert.deepEqual([...doneStations, ...st.queue].sort(), [...paths].sort());
  assert.equal(st.queue.filter((p) => doneStations.includes(p)).length, 0);
  assert.equal(st.cycleEnd, null);
  assert.deepEqual(fs.readdirSync(path.join(dir, "data")).filter((f) => f.endsWith(".tmp")), []);
  // SIGINT のあとは取りに行かない
  const nFetch = lines(path.join(dir, "fetch.log")).length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(lines(path.join(dir, "fetch.log")).length, nFetch);
});
