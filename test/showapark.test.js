// ショウワパーク（2026-11-02 追加）のテスト（npm test）。事業者サイトには繋がない。
// fixtures は 2026-11-01〜02 に節度ある取得（当社の UA・4秒以上の間隔）で保存した公開ページから、要る部分だけを切り出したもの。
// あわせて run.js の「記録しない物件（parse が { skip } を返す）」の扱いも、通しの巡回で確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";
import { parseShowaparkDetail, normalizeBaseFee, normalizeMaxFee, detailUrl } from "../src/showapark.js";
import { parsePrefLinks, firstCityCode, parseParkingList, isBicycleLot, getAllShowaparkIds, TOP_URL } from "../src/showapark-enumerate.js";
import { _resetRobotsCache } from "../src/polite-fetch.js";
import { detailUrl as yparkUrl } from "../src/ypark.js";

config.minDelayMs = 0;   // テストでは待たない
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = path.join(ROOT, "test/fixtures/showapark");
const fx = (f) => fs.readFileSync(path.join(FX, f), "utf8");
const detail = (id) => parseShowaparkDetail(fx(`detail-${id}.html`), { id });

// studio-index.mjs（分析リポジトリ）の offDay と同じ判定。平日以外だけに効く上限か
const offDay = (m) => /土|日曜|日祝|祝|休日/.test(m.scope ?? "") && !/全日|平日|月/.test(m.scope ?? "");

// ---- 一覧 ----

test("一覧: /parking/ の都道府県のリンク19件と件数（計737件）を読む", () => {
  const prefs = parsePrefLinks(fx("parking.html"));
  assert.equal(prefs.length, 19);
  assert.equal(prefs.reduce((a, p) => a + p.count, 0), 737);
  assert.deepEqual(prefs.find((p) => p.pref === "13"), { pref: "13", name: "東京都", count: 141 });
  assert.deepEqual(prefs.find((p) => p.pref === "27"), { pref: "27", name: "大阪府", count: 163 });
  // 件数が「-件」の県（リンク無し）は入らない
  assert.equal(prefs.some((p) => p.name === "青森県"), false);
});

test("一覧: 都道府県のページから最初の市区のコードを読む", () => {
  assert.equal(firstCityCode(fx("pref-27.html")), "27141");
  assert.equal(firstCityCode(fx("pref-13.html")), "13101");
  assert.equal(firstCityCode("<html>作りが変わった</html>"), null);
});

test("一覧: 市区のページの parking_list に県の全件。駐輪場は名前で外し、「併設駐車場」は残す", () => {
  const rows = parseParkingList(fx("city-13103.html"));
  assert.equal(rows.length, 141);   // 東京都(141件) と同じ
  const shinbashi = rows.find((r) => r.id === "3483");
  assert.equal(shinbashi.name, "ショウワパーク新橋2丁目");
  assert.ok(Math.abs(shinbashi.lat - 35.666881) < 1e-5 && Math.abs(shinbashi.lng - 139.754881) < 1e-5);
  assert.equal(shinbashi.pref, "東京都");
  const bikes = rows.filter(isBicycleLot).map((r) => r.id).sort();
  assert.deepEqual(bikes, ["3147", "3229", "3449", "6", "7"]);   // 「駐輪場」が名前にある5件
  assert.equal(isBicycleLot(rows.find((r) => r.id === "3")), false);   // パーク保谷（自転車・バイク併設駐車場）は一覧では残す
  // 大阪は163件のうち駐輪場10件（「パーク今福鶴見（自転車・バイク併設駐輪場）」を含む）
  const osaka = parseParkingList(fx("city-27141.html"));
  assert.equal(osaka.length, 163);
  assert.equal(osaka.filter(isBicycleLot).length, 10);
  // 物件のページにも県の全件が入っている（兵庫28件）
  assert.equal(parseParkingList(fx("detail-3092.html")).length, 28);
  assert.equal(parseParkingList("<html></html>"), null);
});

/** fetch を差し替える（このプロセスの中だけ）。url → 本文（文字列）か { status }。呼んだ URL を控える */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const r = routes[u] ?? (u.endsWith("/robots.txt") ? { status: 200, body: "User-agent: *\nDisallow: /_wp_sys/wp-admin/\n" } : { status: 404 });
    const body = typeof r === "string" ? r : r.body ?? "";
    const status = typeof r === "string" ? 200 : r.status;
    return { ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: () => null } };
  };
  return calls;
}
const O = "https://www.shouwapark.co.jp";
// 東京の最初の市区は 13101。市区のページはどれも県の全件を持つので、保存した 13103 の中身を返す
const ROUTES = {
  [`${O}/parking_search/pref/13/`]: fx("pref-13.html"), [`${O}/parking_search/city/13101/`]: fx("city-13103.html"),
  [`${O}/parking_search/pref/27/`]: fx("pref-27.html"), [`${O}/parking_search/city/27141/`]: fx("city-27141.html"),
};
// /parking/ のうち東京・大阪の2行だけを残したもの（件数どおり全件がそろう場合）
const TOP2 = fx("parking.html").split("\n").filter((l) => !/parking_search\/pref\//.test(l) || /pref\/(13|27)\//.test(l)).join("\n");

test("一覧の作り直し: 県ごとに県のページ・市区のページの2枚。駐輪場を外して書き、取得日を付ける", async () => {
  _resetRobotsCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showapark-"));
  const cacheFile = path.join(dir, "showapark-ids.txt");
  const calls = stubFetch({ [TOP_URL]: TOP2, ...ROUTES });
  const ids = await getAllShowaparkIds({ cacheFile });
  assert.equal(ids.length, 141 - 5 + 163 - 10);
  assert.ok(ids.includes("3483") && ids.includes("3") && !ids.includes("6"));
  assert.equal(ids.listNote, undefined);
  assert.equal(fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean).length, ids.length);
  assert.ok(fs.existsSync(`${cacheFile}.fetched`));
  // robots.txt・/parking/・県2枚・市区2枚。物件のページはまだ取らない
  assert.deepEqual(calls, [`${O}/robots.txt`, TOP_URL, `${O}/parking_search/pref/13/`, `${O}/parking_search/city/13101/`,
    `${O}/parking_search/pref/27/`, `${O}/parking_search/city/27141/`]);
});

test("一覧の作り直し: 一部の県が取れなければ、前の一覧があれば前の一覧で回し、取得日を進めない（次の回に作り直す）", async () => {
  _resetRobotsCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showapark-"));
  const cacheFile = path.join(dir, "showapark-ids.txt");
  stubFetch({ [TOP_URL]: fx("parking.html"), ...ROUTES });   // 19県のうち東京・大阪だけ取れる
  // 前の一覧が無い: 取れた分で書くが、取得日は付けない
  const first = await getAllShowaparkIds({ cacheFile });
  assert.equal(first.length, 289);
  assert.match(first.listNote, /一覧の一部が取れず: 北海道（HTTP 404）/);
  assert.equal(fs.existsSync(`${cacheFile}.fetched`), false);
  // 前の一覧がある: 前の一覧を返す（欠けた一覧で上書きしない）
  _resetRobotsCache();
  fs.writeFileSync(cacheFile, "1\n2\n3\n");
  const second = await getAllShowaparkIds({ cacheFile });
  assert.deepEqual([...second], ["1", "2", "3"]);
  assert.match(second.listNote, /前の一覧で回した/);
  assert.equal(fs.readFileSync(cacheFile, "utf8"), "1\n2\n3\n");
});

test("一覧の作り直し: 県の件数と一覧の件数が違えば listNote に残す。都道府県が0件なら例外", async () => {
  _resetRobotsCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "showapark-"));
  stubFetch({ [TOP_URL]: TOP2.replace("東京都(141件)", "東京都(150件)"), ...ROUTES });
  const ids = await getAllShowaparkIds({ cacheFile: path.join(dir, "ids.txt") });
  assert.match(ids.listNote, /県の件数と一覧が合わない: 東京都 141\/150件/);
  _resetRobotsCache();
  stubFetch({ [TOP_URL]: "<html>作りが変わった</html>" });
  await assert.rejects(getAllShowaparkIds({ cacheFile: path.join(dir, "ids2.txt") }), /都道府県が0件/);
});

// ---- 物件のページ ----

test("詳細: 新橋2丁目（全日10分400円・月～土と日・祝で入庫後6時間の上限が違う・全日の夜間）", () => {
  const r = detail(3483);
  assert.equal(r.operator, "showapark");
  assert.equal(r.parkId, "3483");
  assert.equal(r.name, "ショウワパーク新橋2丁目");
  assert.equal(r.address, "東京都港区新橋2-12-9");
  assert.equal(r.lat, 35.666881);
  assert.equal(r.lng, 139.754881);
  assert.equal(r.capacity, 1);
  assert.equal(r.sourceUrl, detailUrl(3483));
  assert.deepEqual(r.unitCharges, [{ scope: "全日", timeRange: "0:00-24:00", perMinutes: 10, amountYen: 400 }]);
  assert.deepEqual(r.maxFees, [
    { scope: "月~土", condition: "入庫から6時間以内", amountYen: 3800 },
    { scope: "日・祝", condition: "入庫から6時間以内", amountYen: 2000 },
    { scope: "全日", condition: "19:00-8:00 最大", amountYen: 1000 },
  ]);
  // 日・祝の上限は平日の上限として扱われない（offDay）。月～土は平日に効く
  assert.deepEqual(r.maxFees.map(offDay), [false, true, false]);
});

test("詳細: 藤棚町1丁目（時間帯で単価が違う・入庫後24時間と夜間の上限。曜日の見出し無し）", () => {
  const r = detail(3152);
  assert.deepEqual(r.unitCharges, [
    { scope: "全日", timeRange: "8:00-18:00", perMinutes: 20, amountYen: 200 },
    { scope: "全日", timeRange: "18:00-8:00", perMinutes: 60, amountYen: 100 },
  ]);
  assert.deepEqual(r.maxFees, [
    { scope: "全日", condition: "入庫から24時間以内", amountYen: 1100 },
    { scope: "全日", condition: "18:00-8:00 最大", amountYen: 400 },
  ]);
});

test("詳細: 中華街（基本料金も月～金と土日祝で違う。「※№14～22のみ」の注記の行は料金にせず、上限は両方残す）", () => {
  const r = detail(3200);
  assert.deepEqual(r.unitCharges, [
    { scope: "月~金", timeRange: "0:00-24:00", perMinutes: 20, amountYen: 300 },
    { scope: "土日祝", timeRange: "0:00-24:00", perMinutes: 30, amountYen: 500 },
  ]);
  assert.deepEqual(r.maxFees.map((m) => [m.scope, m.amountYen]), [["月~金", 1200], ["月~金", 1000], ["土日祝", 2200], ["土日祝", 2100]]);
  assert.ok(r.maxFees.every((m) => m.condition === "入庫から6時間以内"));
});

test("詳細: 曜日で違う24時間の上限（新横浜篠原口第1）・日祝の昼の上限（上本町9丁目）・夜間だけ（博多駅南）・12時間（厚木南口）", () => {
  assert.deepEqual(detail(385).maxFees, [
    { scope: "月~金", condition: "入庫から24時間以内", amountYen: 1400 },
    { scope: "土日祝", condition: "入庫から24時間以内", amountYen: 1500 },
  ]);
  assert.deepEqual(detail(3355).maxFees, [
    { scope: "月~土", condition: "8:00-20:00 最大", amountYen: 1600 },
    { scope: "日祝", condition: "8:00-20:00 最大", amountYen: 800 },
    { scope: "全日", condition: "20:00-8:00 最大", amountYen: 300 },
  ]);
  const hakata = detail(3365);
  assert.equal(hakata.name, "パーク博多駅南");   // 社名の無い「パーク◯◯」もそのまま
  assert.deepEqual(hakata.unitCharges, [{ scope: "全日", timeRange: "0:00-24:00", perMinutes: 40, amountYen: 200 }]);
  assert.deepEqual(hakata.maxFees, [{ scope: "全日", condition: "22:00-9:00 最大", amountYen: 400 }]);
  assert.deepEqual(detail(257).maxFees, [{ scope: "全日", condition: "入庫から12時間以内", amountYen: 700 }]);
});

test("詳細: 「（祝日）」の夜間の上限は祝日のものとして持つ（常盤台。全日に直さない）", () => {
  const r = detail(921);
  assert.deepEqual(r.maxFees, [
    { scope: "全日", condition: "8:00-18:00 最大", amountYen: 1200 },
    { scope: "祝日", condition: "18:00-8:00 最大", amountYen: 300 },
  ]);
  assert.equal(offDay(r.maxFees[1]), true);
});

test("詳細: ほかの書き方（全日・入庫後24時間だけ／時間帯ごとの単価と全日の見出し）", () => {
  assert.deepEqual(detail(3515).maxFees, [{ scope: "全日", condition: "入庫から24時間以内", amountYen: 900 }]);
  const r = detail(3092);
  assert.equal(r.address, "兵庫県神戸市東灘区住吉本町3-306-1");
  assert.deepEqual(r.unitCharges.map((u) => [u.timeRange, u.perMinutes, u.amountYen]), [["8:00-20:00", 30, 200], ["20:00-8:00", 60, 100]]);
  assert.deepEqual(r.maxFees.map((m) => [m.scope, m.condition, m.amountYen]), [["全日", "入庫から24時間以内", 1000], ["全日", "20:00-8:00 最大", 400]]);
  assert.equal(detail(3228).maxFees.length, 2);
  assert.equal(detail(3335).unitCharges.length, 2);
});

test("詳細: 記録しない物件（備考で自転車・バイクだけと分かる・基本料金が空・名前に駐輪場）", () => {
  // パーク保谷（自転車・バイク併設駐車場）: 32台＝備考の「自転車30台、バイク2台」。360分100円は自転車の料金
  assert.match(detail(3).skip, /駐輪場（備考に自転車・バイク32台。収容台数32台）/);
  // パーク城東蒲生: 基本料金が空（最大料金の欄は自転車・バイクの料金）
  assert.match(detail(3177).skip, /時間貸しの料金が無い/);
  // 名前に駐輪場（一覧で外しているが、詳細でも外す）
  const bike = fx("detail-3515.html").replace("ショウワパーク弁天町駅前", "ショウワパーク弁天町駅前駐輪場");
  assert.equal(parseShowaparkDetail(bike, { id: 1 }).skip, "駐輪場");
  // 最大料金の欄が「なし」の車の駐車場は記録する（上限なし）
  const nashi = fx("detail-3515.html").replace(/<span class="ari">[\s\S]*?<\/span>/, '<span class="nashi">なし</span>');
  const r = parseShowaparkDetail(nashi, { id: 3515 });
  assert.equal(r.skip, undefined);
  assert.deepEqual(r.maxFees, []);
  assert.equal(r.unitCharges.length, 1);
});

test("詳細: 基本料金の欄そのものが無いのはページの作りの変更なので、記録しない物件にせず読めないことにする", () => {
  const broken = fx("detail-3483.html").replace(/<th>基本料金<\/th>/, "<th>料金</th>");
  assert.throws(() => parseShowaparkDetail(broken, { id: 3483 }), /基本料金の欄が無い/);
});

test("料金の整え方: <p> の見出し・時間帯・単価を1行に、（月～土）を【月~土】に", () => {
  assert.equal(normalizeBaseFee("<p>\n全日&nbsp;\n0:00～24:00<br>\n10分／400円\n</p>\n"), "【全日】0:00~24:00 10分／400円");
  assert.equal(normalizeBaseFee("<p>（土日祝）&nbsp;0:00～24:00<br>30分／500円</p><p>8:00～18:00<br>20分／200円</p>"),
    "【土日祝】0:00~24:00 30分／500円<br>8:00~18:00 20分／200円");
  assert.equal(normalizeMaxFee('<span class="ari">（月～土）<br />\n入庫後6時間　3800円</span><br>繰り返し○'), "【月~土】<br>入庫後6時間 3800円");
  assert.equal(normalizeMaxFee('<span class="nashi">なし</span><br>繰り返し×'), "");
});

// ---- run.js の通しの巡回（記録しない物件の扱い） ----

/** run.js を別のプロセスで通しで動かす（test/crawl-core.test.js と同じ作り）。fetch は routes で差し替え、呼んだ URL を控える */
function runCrawl({ env = {}, routes = {}, files = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), "showapark-run-")) }) {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  const routesFile = path.join(dir, "routes.json");
  const callsFile = path.join(dir, "calls.txt");
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
  let r = routes[u];
  if (r === undefined) r = u.endsWith("/robots.txt") ? { status: 404 } : { status: 404 };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "", headers: { get: () => null } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_HOLD: "off", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, 0, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const health = JSON.parse(fs.readFileSync(path.join(dir, "data/health/test.json"), "utf8")).targets;
  const out = path.join(dir, "data/prices-test.jsonl");
  const rows = fs.existsSync(out) ? fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const stateOf = (op) => JSON.parse(fs.readFileSync(path.join(dir, `data/${op}-crawl-state.json`), "utf8"));
  return { calls, health, log, dir, rows, stateOf, state: stateOf(env.CRAWL_ONLY.split(",")[0]) };
}
const listFiles = (ids, state = null) => ({
  "data/showapark-ids.txt": ids.join("\n") + "\n", "data/showapark-ids.txt.fetched": new Date().toISOString(),
  ...(state ? { "data/showapark-crawl-state.json": JSON.stringify(state) } : {}),
});

test("通しの巡回: 記録しない物件は料金を書かずに寝かせ（GONE）、health に件数を残す。成功の回のまま", () => {
  const r = runCrawl({ env: { CRAWL_ONLY: "showapark" }, files: listFiles(["3483", "3", "3177", "3200"]),
    routes: Object.fromEntries([3483, 3, 3177, 3200].map((id) => [detailUrl(id), { status: 200, body: fx(`detail-${id}.html`) }])) });
  assert.deepEqual(r.rows.map((x) => x.parkId).sort(), ["3200", "3483"]);   // 保谷・城東蒲生は書かない
  assert.ok(r.rows.every((x) => x.operator === "showapark" && x.unitCharges.length > 0));
  assert.match(r.state["3"], /^GONE\|/);
  assert.match(r.state["3177"], /^GONE\|/);
  assert.doesNotMatch(r.state["3483"], /^GONE/);
  const h = r.health.find((x) => x.op === "showapark");
  assert.equal(h.ok, true);
  assert.equal(h.n, 2);
  assert.equal(h.skipped, 2);
  assert.match(r.log, /\[skip\] 3: 駐輪場/);
  // 寝かせた物件は次の回に取りに行かない
  const again = runCrawl({ env: { CRAWL_ONLY: "showapark" }, dir: r.dir, files: { "data/showapark-ids.txt.fetched": new Date().toISOString() },
    routes: Object.fromEntries([3483, 3, 3177, 3200].map((id) => [detailUrl(id), { status: 200, body: fx(`detail-${id}.html`) }])) });
  assert.equal(again.calls.filter((u) => /parking_detail\/(3|3177)\//.test(u)).length, 0);
});

test("通しの巡回: 前は取れていた物件が一斉に「記録しない物件」になったら、ページの作りの変更とみなして印を戻し打ち切る", () => {
  const ids = Array.from({ length: 6 }, (_, i) => String(9001 + i));
  const old = new Date(Date.now() - 3 * 864e5).toISOString();
  const state = Object.fromEntries(ids.map((id) => [id, old]));
  // どの物件も基本料金の欄が空になった（月極だけに見える）
  const empty = fx("detail-3483.html").replace(/(<th>基本料金<\/th>\s*<td>)[\s\S]*?(<\/td>)/, "$1$2");
  const r = runCrawl({ env: { CRAWL_ONLY: "showapark", MASS_GONE_STREAK: "3" }, files: listFiles(ids, state),
    routes: Object.fromEntries(ids.map((id) => [detailUrl(id), { status: 200, body: empty }])) });
  assert.ok(ids.every((id) => !String(r.state[id]).startsWith("GONE")), JSON.stringify(r.state));
  const h = r.health.find((x) => x.op === "showapark");
  assert.equal(h.ok, false);
  assert.equal(h.kind, "mass-gone");
  assert.equal(r.rows.length, 0);
});

test("通しの巡回: ユアー・パーキングは自動では取りに行かない（2026-11-09。人が置いた一覧を import-ypark.yml で取り込む）", () => {
  // 以前はここで物件の JSON（setparkinfo）を巡回していたが、waxds.com はクラウドからのアクセスを止めていて一度も取れず、
  // ほかの回線から自動で取るのは回り込みになるので、巡回の表から外した。取り込みの確かめは test/ypark.test.js
  const r = runCrawl({ env: { CRAWL_ONLY: "ypark" }, files: { "data/ypark-ids.txt": "11337\n10880\n", "data/ypark-crawl-state.json": "{}" }, routes: {} });
  assert.deepEqual(r.calls, []);
  assert.deepEqual(r.rows, []);
});
