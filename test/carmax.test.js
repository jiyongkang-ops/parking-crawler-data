// 東洋カーマックス（carmax-parking.jp）のテスト（npm test）。事業者サイトには繋がない（保存したページと、差し替えた fetch を使う）。
// 2026-11-02 追加。見本は 2026-11-01 に当ボットで取ったページ（test/fixtures/carmax/）。
// 共通の parseFeeBlock は金額が先の「￥200 20分」と「(月-金)」の区分を読めず、単価も上限も0件だった（2026-11-01 見直し）。
// carmax.js で読める形に直してから渡す。料金の文の無い物件・駐輪場・近日オープンは記録しない（run.js の excluded）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseFeeBlock } from "../src/jp-fee-text.js";

process.env.LIST_REFRESH_MAX = "99";   // 一覧の作り直しの回数の絞りを外す（cache-age.js は読み込んだときに決まる）
const { parseCarmaxDetail, normalizeCarmaxFee, detailUrl, fullKana } = await import("../src/carmax.js");
const { parseAreas, parseListPage, walkCarmaxList, getAllCarmaxIds, areaPageUrl, SEARCH_URL } = await import("../src/carmax-enumerate.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = path.join(ROOT, "test/fixtures/carmax");
const fx = (f) => fs.readFileSync(path.join(FX, f), "utf8");
const detail = (id) => parseCarmaxDetail(fx(`detail-${id}.html`), { id });
const feeCell = (html) => html.match(/<th>料金<\/th><td>([\s\S]*?)<\/td>/)[1];
const U = (scope, timeRange, perMinutes, amountYen) => ({ scope, timeRange, perMinutes, amountYen });
const M = (scope, condition, amountYen) => ({ scope, condition, amountYen });

// ---- 料金の読み取り（実物の14件のうち、書き方の違う物件） ----

test("料金: 今の parseFeeBlock にそのまま渡すと0件。直してから渡すと読める（松戸第3: 入庫後3時間の上限）", () => {
  const raw = feeCell(fx("detail-1NU.html"));
  assert.deepEqual(parseFeeBlock(raw), { unitCharges: [], maxFees: [] });   // 見直しで確かめた0件
  const r = detail("1NU");
  assert.equal(r.name, "松戸第3駐車場");
  assert.equal(r.address, "千葉県松戸市本町17番2");
  assert.equal(r.capacity, 2);
  assert.deepEqual([r.lat, r.lng], [35.78532, 139.89876]);
  assert.equal(r.sourceUrl, "http://www.carmax-parking.jp/detail/1NU/");
  assert.deepEqual(r.unitCharges, [U("全日", "0:00-24:00", 20, 200)]);
  // 「入庫後3時間以内」は3時間の上限（24時間の最大として読まない。studio-index の bandOf では dur:3）
  assert.deepEqual(r.maxFees, [M("全日", "入庫後3時間以内", 600)]);
});

test("料金: 平日と土日祝で上限が違う（月-土 / 日祝）。区分はページのとおりに残す", () => {
  // 八丁堀2丁目: 月-土 入庫後4時間 1,900円・日祝 入庫後12時間 1,200円
  const a = detail("1MM");
  assert.deepEqual(a.unitCharges, [U("全日", "0:00-24:00", 15, 400)]);
  assert.deepEqual(a.maxFees, [M("月-土", "入庫後4時間以内", 1900), M("日祝", "入庫後12時間以内", 1200)]);
  // 永代1丁目: 月-土 24時間 1,500円・日祝 24時間 1,000円・全日 夜間 400円
  const b = detail("1NP");
  assert.deepEqual(b.maxFees, [M("月-土", "入庫後24時間以内", 1500), M("日祝", "入庫後24時間以内", 1000), M("全日", "19:00-8:00 最大", 400)]);
  assert.deepEqual(b.unitCharges, [U("全日", "8:00-19:00", 30, 200), U("全日", "19:00-8:00", 60, 100)]);
  // ODD江戸堀: 「入庫後24時間最大」と単価の区分（月～土 / 日祝）
  const c = detail("783");
  assert.deepEqual(c.maxFees, [M("月-土", "入庫から24時間以内最大", 2400), M("日祝", "入庫から24時間以内最大", 1000)]);
  assert.deepEqual(c.unitCharges, [U("月~土", "8:00-22:00", 10, 300), U("月~土", "22:00-8:00", 60, 100),
    U("日祝", "8:00-22:00", 60, 300), U("日祝", "22:00-8:00", 60, 100)]);
});

test("料金: 昼間・夜間の上限。「(土日祝) 昼間最大」は土日祝のまま、「(夜間)」は区分ではなく時間帯の名前（全日）", () => {
  // 大阪シティ信金生野: 平日に昼間の上限が無く、土日祝だけにある（Advisor は平日の上限が無いときだけ土日祝の上限を使う。報告に載せた）
  const r = detail("0IE");
  assert.deepEqual(r.maxFees, [M("土日祝", "8:00-20:00 最大", 1000), M("全日", "20:00-8:00 最大", 200)]);   // 「20:00-翌8:00」の翌を外して読む
  assert.deepEqual(r.unitCharges, [U("月-金", "8:00-15:00", 30, 300), U("月-金", "15:00-20:00", 30, 100),
    U("土日祝", "8:00-20:00", 20, 100), U("全日", "20:00-8:00", 60, 100)]);
  // 中央2丁目（横浜）: 全日の昼・夜の上限（全角コロン）
  const h = detail("1HN");
  assert.deepEqual(h.maxFees, [M("全日", "8:00-20:00 最大", 1100), M("全日", "20:00-8:00 最大", 300)]);
  // 静岡馬場町: 24時間の上限と「18:00～8:00」の夜間の上限
  assert.deepEqual(detail("1SR").maxFees, [M("全日", "入庫後24時間以内", 1200), M("全日", "18:00-8:00 最大", 300)]);
  // 西宮神楽町: 「24時間最大 ￥1500 ※くり返しあり」
  assert.deepEqual(detail("0QA").maxFees, [M("全日", "24時間最大", 1500)]);
});

test("料金: 上限の無い物件（【最大料金】が空）と、「09:00-15:00/15:00-22:00」の2つの時間帯", () => {
  const k = detail("668");   // 紀陽銀行東和歌山: 上限なし・(全日夜間) は全日
  assert.deepEqual(k.maxFees, []);
  assert.deepEqual(k.unitCharges, [U("平日", "9:00-15:00", 30, 200), U("平日", "15:00-22:00", 30, 100),
    U("土日祝", "9:00-22:00", 60, 200), U("全日", "22:00-9:00", 60, 100)]);
  const t = detail("746");   // 徳島: 2つの時間帯を1行ずつに分ける
  assert.deepEqual(t.unitCharges, [U("平日", "9:00-15:00", 60, 200), U("平日", "15:00-22:00", 60, 200),
    U("土日祝", "9:00-22:00", 60, 200), U("全日", "22:00-9:00", 60, 100)]);
  assert.deepEqual(t.maxFees, [M("全日", "24時間最大", 900)]);
});

test("料金: 病院の駐車場は一般の車の料金だけ（バイク・外来・お見舞いの料金は採らない）", () => {
  const r = detail("1ST");   // 野村病院第1
  assert.deepEqual(r.unitCharges, [U("全日", "0:00-24:00", 60, 500)]);
  assert.deepEqual(r.maxFees, [M("全日", "入庫後24時間以内", 1800)]);
  assert.match(normalizeCarmaxFee(feeCell(fx("detail-1ST.html"))), /^【最大料金】<br>【全日】入庫後24時間以内 1800円<br>【通常料金】<br>【全日】 ?00:00-24:00 60分500円$/);
});

test("名前・住所: 半角カナだけ全角にする（ODD江戸堀ﾊﾟｰｷﾝｸﾞ → ODD江戸堀パーキング）", () => {
  assert.equal(detail("783").name, "ODD江戸堀パーキング");
  assert.equal(detail("0IE").name, "大阪シティ信金生野駐車場");
  assert.equal(fullKana("ODD江戸堀ﾊﾟｰｷﾝｸﾞ２"), "ODD江戸堀パーキング２");   // 全角の数字などは変えない
  assert.equal(detailUrl("1NU"), "http://www.carmax-parking.jp/detail/1NU/");   // 末尾の / を付ける（付けないと 301 で1回余分）
});

// ---- 記録しない物件 ----

const withFee = (fee, name = "松戸第3駐車場") => fx("detail-1NU.html")
  .replace(/<th>料金<\/th><td>[\s\S]*?<\/td>/, `<th>料金</th><td>${fee}</td>`)
  .replace(/<th>駐車場名<\/th><td>[^<]*<\/td>/, `<th>駐車場名</th><td>${name}</td>`);

test("記録しない: 料金の文が無い・月極だけ・駐輪場・近日オープン。記録する物件には excluded が無い", () => {
  const ex = (html) => parseCarmaxDetail(html, { id: "X1" }).excluded ?? null;
  assert.equal(ex(withFee("【最大料金】<br /><br />【通常料金】<br /><br />※情報が変更されている場合も…")), "時間貸しの料金の文が無い");
  assert.equal(ex(withFee("【月極】<br />月極 ￥15000<br />")), "月極だけ");
  assert.equal(ex(withFee("【通常料金】<br />(全日) 00:00-24:00 ￥100 60分", "月島第2駐輪場（バイク）")), "駐輪場・バイク");
  assert.equal(ex(withFee("【通常料金】<br />(全日) 00:00-24:00 ￥200 20分", "新宿5丁目駐車場（近日OPEN）")), "近日オープン");
  const r = parseCarmaxDetail(withFee("【通常料金】<br />(全日) 00:00-24:00 ￥200 20分"), { id: "X1" });
  assert.equal(r.excluded, undefined);
  assert.deepEqual(r.unitCharges, [U("全日", "0:00-24:00", 20, 200)]);
  assert.deepEqual(Object.keys(r), ["operator", "parkId", "label", "name", "address", "lat", "lng", "capacity", "openingHours", "unitCharges", "maxFees", "sourceUrl"]);
});

// ---- 一覧 ----

test("一覧: エリアのリンク・ヒット数・ページ送り・行（管理番号と名前）を読む", () => {
  assert.deepEqual(parseAreas(fx("search-top.html")), ["a7", "a5", "a4", "a3"]);
  const p1 = parseListPage(fx("list-a3-p1.html"));
  assert.equal(p1.hits, 559);
  assert.equal(p1.rows.length, 20);
  assert.equal(p1.maxPage, 28);
  assert.deepEqual(p1.rows[0], { id: "1GL", name: "市川八幡第二駐輪場" });
  assert.deepEqual(p1.rows.find((r) => r.id === "1NU"), { id: "1NU", name: "松戸第3駐車場" });
  const last = parseListPage(fx("list-a3-p28.html"));   // 最後のページは19件（27×20＋19＝559）
  assert.equal(last.rows.length, 19);
  assert.equal(parseListPage(fx("list-a5-p1.html")).hits, 591);
  assert.deepEqual(parseListPage(fx("list-a7-p1.html")).rows, [{ id: "746", name: "徳島駐車場" }]);
  assert.equal(areaPageUrl("a3", 1), "http://www.carmax-parking.jp/search/a3/pf0/s0/p1/");
  assert.equal(areaPageUrl("a3", 2), "http://www.carmax-parking.jp/search/a3/pf0/sa2/p2/");
});

// 本物の一覧のページを型にして、ヒット数と行を差し替えたページ
const listPage = (hits, rows) => fx("list-a3-p1.html")
  .replace(/検索ヒット数：\d+件/, `検索ヒット数：${hits}件`)
  .replace(/<tbody>[\s\S]*?<\/tbody>/, `<tbody>\n${rows.map(([id, name]) =>
    `<tr><td title="駐車場名">${name}</td><td title="住所">東京都中央区1-1</td><td title="収容台数">3台</td><td title="クレジット">不可</td><td><a href="/detail/${id}"><span>${name}</span>詳細</a></td></tr>`).join("\n")}\n</tbody>`);
const topWith = (areas) => fx("search-top.html").replace(/<li><a href="\/search\/a\d+\/pf0\/s0\/p1\/">[\s\S]*?<\/li>\n?/g, "")
  .replace("</ul>", `${areas.map((a) => `<li><a href="/search/${a}/pf0/s0/p1/"><img src="/images/x.png" alt="x" /></a></li>`).join("\n")}</ul>`);
/** 45件（3ページ）のエリア a3 と、本物の四国（1件）。番号は Z00〜Z44、Z03・Z17 は駐輪場 */
function site({ fail = null } = {}) {
  const rows = Array.from({ length: 45 }, (_, i) => [`Z${String(i).padStart(2, "0")}`, i === 3 || i === 17 ? `テスト${i}駐輪場` : `テスト${i}駐車場`]);
  const pages = { [SEARCH_URL]: topWith(["a7", "a3"]), [areaPageUrl("a7", 1)]: fx("list-a7-p1.html") };
  for (let p = 1; p <= 3; p++) pages[areaPageUrl("a3", p)] = listPage(45, rows.slice((p - 1) * 20, p * 20));
  const calls = [];
  const fetcher = async (u) => {
    calls.push(u);
    if (u === fail) return { ok: false, status: 503, html: "" };
    return pages[u] ? { ok: true, status: 200, html: pages[u] } : { ok: false, status: 404, html: "" };
  };
  return { fetcher, calls };
}
const tmpList = (lines, fetchedAt) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "carmax-list-")), "carmax-ids.txt");
  if (lines) fs.writeFileSync(f, lines.join("\n") + "\n");
  if (fetchedAt) fs.writeFileSync(`${f}.fetched`, fetchedAt);
  return f;
};

test("一覧: ヒット数からページ数を出して最後のページまで取り、駐輪場を外して書く", async () => {
  const { fetcher, calls } = site();
  const w = await walkCarmaxList({ fetcher });
  assert.equal(w.hits, 46);
  assert.equal(w.rows.length, 46);
  assert.deepEqual(w.missing, []);
  assert.deepEqual(calls, [SEARCH_URL, areaPageUrl("a7", 1), areaPageUrl("a3", 1), areaPageUrl("a3", 2), areaPageUrl("a3", 3)]);
  const f = tmpList(null, null);
  const ids = await getAllCarmaxIds({ cacheFile: f, fetcher: site().fetcher });
  assert.equal(ids.length, 44);                       // 46件から駐輪場2件を外す
  assert.ok(!ids.includes("Z03") && !ids.includes("Z17") && ids.includes("746"));
  assert.deepEqual(fs.readFileSync(f, "utf8").split("\n").filter(Boolean), [...ids]);
  assert.ok(fs.existsSync(`${f}.fetched`));
  assert.deepEqual(ids.listInfo, { hits: 46, rows: 46, bikes: 2 });
  // 7日以内なら取りに行かない
  const again = site();
  assert.deepEqual(await getAllCarmaxIds({ cacheFile: f, fetcher: again.fetcher }), [...ids]);
  assert.deepEqual(again.calls, []);
});

test("一覧: 途中のページが取れなければ、前の一覧を使い（取得日は進めない）、listNote で知らせる。前の一覧が無ければ欠けた一覧を使って次の回に作り直す", async () => {
  const eightDaysAgo = new Date(Date.now() - 8 * 864e5).toISOString();
  const prev = ["P1", "P2", "P3"];
  const f = tmpList(prev, eightDaysAgo);
  const ids = await getAllCarmaxIds({ cacheFile: f, fetcher: site({ fail: areaPageUrl("a3", 2) }).fetcher });
  assert.deepEqual([...ids], prev);
  assert.match(ids.listNote, /前の一覧（3件）を使っている: 取れなかったページ: a3 2ページ目（HTTP 503）/);
  assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);
  const f2 = tmpList(null, null);
  const first = await getAllCarmaxIds({ cacheFile: f2, fetcher: site({ fail: areaPageUrl("a3", 3) }).fetcher });
  assert.equal(first.length, 39);                     // 1ページ目・四国の分（駐輪場2件を除く）
  assert.match(first.listNote, /次の回に作り直す/);
  assert.equal(fs.existsSync(`${f2}.fetched`), false);
});

test("一覧: robots.txt で断られた・届かないときは「0件」と取り違えずに例外にする", async () => {
  const fetcher = async () => ({ ok: false, blocked: true, status: 403, skippedReason: "robots.txt が HTTP 403（断られている）" });
  await assert.rejects(walkCarmaxList({ fetcher }), /東洋カーマックス一覧: robots\.txt が HTTP 403/);
  const top = async (u) => (u === SEARCH_URL ? { ok: true, status: 200, html: "<html>作りが変わった</html>" } : { ok: false, status: 404 });
  await assert.rejects(walkCarmaxList({ fetcher: top }), /エリアが0件/);
});

// ---- 巡回（run.js を別のプロセスで通しで動かす。test/runjs.test.js と同じ作り） ----

function runCrawl({ env = {}, routes = {}, files = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carmax-run-"));
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  const routesFile = path.join(dir, "routes.json"), callsFile = path.join(dir, "calls.txt");
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  fs.writeFileSync(callsFile, "");
  const preload = path.join(dir, "stub.mjs");
  fs.writeFileSync(preload, `
import fs from "node:fs";
import { config } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)};
config.minDelayMs = 0;
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"));
globalThis.fetch = async function stub(url) {
  const u = String(url);
  fs.appendFileSync(${JSON.stringify(callsFile)}, u + "\\n");
  const r = routes[u] ?? (u.endsWith("/robots.txt") ? { status: 200, body: "User-agent: *\\nSitemap: http://www.carmax-parking.jp/sitemap.xml\\nDisallow:\\n" } : { status: 404 });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "", headers: { get: () => null } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_HOLD: "off", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl", CRAWL_ONLY: "carmax", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, 0, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const health = JSON.parse(fs.readFileSync(path.join(dir, "data/health/test.json"), "utf8")).targets;
  const pf = path.join(dir, "data/prices-test.jsonl");
  const rows = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const state = JSON.parse(fs.readFileSync(path.join(dir, "data/carmax-crawl-state.json"), "utf8"));
  return { calls, health, rows, state, log };
}
const listFiles = (ids) => ({ "carmax-ids.txt": ids.join("\n") + "\n", "carmax-ids.txt.fetched": new Date().toISOString() });
const filesOf = (ids) => Object.fromEntries(Object.entries(listFiles(ids)).map(([k, v]) => [`data/${k}`, v]));

test("巡回: 料金のある物件だけ記録し、記録しない物件（月極だけ・駐輪場）は取りに行った日だけ進める。health は成功で件数を残す", () => {
  const routes = {
    [detailUrl("1NU")]: { status: 200, body: fx("detail-1NU.html") },
    [detailUrl("0IE")]: { status: 200, body: fx("detail-0IE.html") },
    [detailUrl("XM1")]: { status: 200, body: withFee("【最大料金】<br /><br />【通常料金】<br />月極のみ（空き待ち）") },
    [detailUrl("XB1")]: { status: 200, body: withFee("【通常料金】<br />(全日) 00:00-24:00 ￥100 60分", "門前仲町駐輪場") },
  };
  const { calls, health, rows, state, log } = runCrawl({ routes, files: filesOf(["0IE", "1NU", "XB1", "XM1"]) });
  assert.deepEqual(calls.filter((u) => !u.endsWith("/robots.txt")).sort(), Object.keys(routes).sort());   // 末尾の / 付きで1回ずつ
  assert.deepEqual(rows.map((r) => r.parkId).sort(), ["0IE", "1NU"]);
  assert.ok(rows.every((r) => r.operator === "carmax" && r.unitCharges.length > 0 && !("excluded" in r)));
  assert.deepEqual(Object.keys(state).filter((k) => !k.startsWith("_")).sort(), ["0IE", "1NU", "XB1", "XM1"]);
  const h = health.find((x) => x.op === "carmax");
  assert.equal(h.ok, true, log);
  assert.equal(h.label, "東洋カーマックス");
  assert.equal(h.n, 2);
  assert.equal(h.excluded, 2);
  assert.match(log, /\[skip\] XM1 松戸第3駐車場: 月極だけ（記録しない）/);
  assert.match(log, /\[skip\] XB1 門前仲町駐輪場: 駐輪場・バイク（記録しない）/);
});

test("巡回: 取った物件がすべて記録しない物件でも失敗にしない。読めないページばかりなら今までどおり失敗", () => {
  const all = runCrawl({ routes: { [detailUrl("XM1")]: { status: 200, body: withFee("") } }, files: filesOf(["XM1"]) });
  const h = all.health.find((x) => x.op === "carmax");
  assert.deepEqual([h.ok, h.n, h.excluded, h.reason], [true, 0, 1, null]);
  assert.deepEqual(all.rows, []);
  const broken = runCrawl({ routes: { [detailUrl("XX1")]: { status: 200, body: "<html>作りが変わった</html>" } }, files: filesOf(["XX1"]) });
  const b = broken.health.find((x) => x.op === "carmax");
  assert.equal(b.ok, false);
  assert.match(b.reason, /1件取りに行って0件（名前が読めない1件）/);
});
