// パークネットの市区一覧のページ送りのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える）。
// 2026-10-18 の点検で見つかったこと: 市区一覧は10件ずつのページ送りなのに1ページ目しか取っておらず、
// 10件を超える10市区（札幌市中央区 59件・大阪市北区 15件など）は毎回10件で止まっていた。
// ページはサイトの作り（list_box・「該当した駐車場：<strong>N</strong>件」・page_list_link）を写して組み立てる。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";

const { cityListUrl, parseParknetList, parseParknetTotal, parsePagerOffsets, PARKNET_MAX_PAGES } = await import("../src/parknet.js");
const { crawlParknetCity, crawlParknetCities, parknetHealth } = await import("../src/parknet-enumerate.js");
const { _resetRobotsCache } = await import("../src/polite-fetch.js");
config.minDelayMs = 0;   // テストでは待たない

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROBOTS = "https://parknet.shinmaywa.co.jp/robots.txt";
const ROBOTS_BODY = "User-agent: *\nDisallow: /\nAllow: /parknet/\n";   // 2026-10-18 の本物と同じ規則

// ---- サイトの作りを写したページ ----
const lotHtml = (id, i) => `<div class="list_box">
  <!-- ////////// START list_box ////////// -->
  <p class="list_name_box"><a href="./detail_${id}.html"><span class="list_name">パークネット試し${i}</span></a></p>
  <dl><dt>住所</dt><dd><span class="address_detail">北海道札幌市中央区南${i}条西1丁目</span></dd></dl>
  <dl><dt>台数</dt><dd><span class="daisu">${(i % 20) + 3}台</span></dd></dl>
  <div class="area_alltime"><ul><li><span class="d_start_time">00:00</span>～<span class="d_end_time">24:00</span>
    <span class="kizami">30分</span><span class="rate">${200 + (i % 3) * 100}円</span></li></ul></div>
  <div class="area_max_rate"><ul><li><span class="max_time">24時間最大</span><span class="rate">${600 + i}円</span></li></ul></div>
  </div><!-- /.list_box-->`;
/** total 件の市区の、offset から10件のページ。ids … 物件番号の並び（既定は j9000〜） */
function cityPage({ total, offset = 0, ids = null, showTotal = true, showPager = true }) {
  const all = ids ?? Array.from({ length: total }, (_, i) => `j${9000 + i}`);
  const lots = all.slice(offset, offset + 10).map((id, k) => lotHtml(id, offset + k + 1)).join("\n");
  const pager = [];
  for (let o = 0; o < total; o += 10) {
    const label = `${o + 1}～${o + 10}`;
    pager.push(o === offset ? `<li class="page_view_list">${label}</li>`
      : `<li><a href="/parknet/search/parking.php?search=1&amp;offset=${o}">${label}</a></li>`);
  }
  return `<html><body>
  <div class="search_list_kensu">${showTotal ? `<p class="kensu">該当した駐車場：<strong>${total}</strong>件</p>` : ""}</div>
  <div class="search_list">${lots}
  ${showPager && total > 10 ? `<div class="page_list_link">\n    <ul>\n${pager.join("\n")}\n</ul>\n</div>` : ""}
  <div class="area_btn noline"><ul><li class="back"><a href="./city_list_01.html">戻る</a></li></ul></div>
  </div></body></html>`;
}

/** 差し替えた fetch（このプロセスの中だけ）。url → 本文または { status, body, throw }。呼ばれた URL を控える */
function stubFetch(routes, fallback = { status: 404 }) {
  _resetRobotsCache();
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    let r = routes[u] ?? (u === ROBOTS ? ROBOTS_BODY : fallback);
    if (r && r.throw) { const e = new TypeError("fetch failed"); e.cause = { code: r.throw }; throw e; }
    const body = typeof r === "string" ? r : r.body ?? "";
    const status = typeof r === "string" ? 200 : r.status;
    return { ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: () => null } };
  };
  return calls;
}
/** total 件の市区の全ページを routes に入れる */
function cityRoutes(prefCd, city, total, opts = {}) {
  const routes = {};
  for (let o = 0; o < Math.max(total, 1); o += 10) routes[cityListUrl(prefCd, city, o)] = cityPage({ total, offset: o, ...opts });
  return routes;
}
const pagesOf = (calls) => calls.filter((u) => u !== ROBOTS);

// ---- 読み取り ----

test("市区の URL: 1ページ目は以前と同じ（料金の記録の _requestUrl を変えない）、2ページ目からは &offset=10・20…", () => {
  assert.equal(cityListUrl("01", "札幌市中央区"),
    "https://parknet.shinmaywa.co.jp/parknet/search/list.html?pref_cd=01&city=%E6%9C%AD%E5%B9%8C%E5%B8%82%E4%B8%AD%E5%A4%AE%E5%8C%BA");
  assert.equal(cityListUrl("01", "札幌市中央区", 0), cityListUrl("01", "札幌市中央区"));
  assert.equal(cityListUrl("27", "大阪市北区", 10),
    "https://parknet.shinmaywa.co.jp/parknet/search/list.html?pref_cd=27&city=%E5%A4%A7%E9%98%AA%E5%B8%82%E5%8C%97%E5%8C%BA&offset=10");
});

test("総件数（該当した駐車場：N件）とページ送りの offset を読む。無ければ null・空", () => {
  const html = cityPage({ total: 59, offset: 10 });
  assert.equal(parseParknetTotal(html), 59);
  assert.deepEqual(parsePagerOffsets(html), [0, 20, 30, 40, 50]);   // 今のページ（10）はリンクでない
  assert.equal(parseParknetTotal('<p class="kensu">該当した駐車場：<strong>1,234</strong>件</p>'), 1234);
  assert.equal(parseParknetTotal("<p>見つかりませんでした</p>"), null);
  assert.deepEqual(parsePagerOffsets(cityPage({ total: 7 })), []);
  assert.equal(parseParknetList(html).length, 10);
  assert.equal(parseParknetList(html)[0].parkId, "j9010");
});

// ---- 市区を最後のページまで取る ----

test("10件を超える市区は最後のページまで取る（59件 → 6ページ・59件、重なり無し）", async () => {
  const calls = stubFetch(cityRoutes("01", "札幌市中央区", 59));
  const got = [];
  const r = await crawlParknetCity("01", "札幌市中央区", { onPage: (recs, url) => got.push(...recs.map((x) => `${x.parkId}@${url}`)) });
  assert.deepEqual(pagesOf(calls), [0, 10, 20, 30, 40, 50].map((o) => cityListUrl("01", "札幌市中央区", o)));
  assert.equal(r.pages, 6);
  assert.equal(r.total, 59);
  assert.equal(r.got, 59);
  assert.equal(new Set(got.map((x) => x.split("@")[0])).size, 59);
  assert.ok(got[0].endsWith(cityListUrl("01", "札幌市中央区")));                  // 1ページ目の物件は1ページ目の URL
  assert.ok(got[58].endsWith(cityListUrl("01", "札幌市中央区", 50)));
  assert.equal(r.failed, null);
  assert.equal(r.capped, false);
});

test("10件以下の市区は1ページだけ（リクエストは増えない）。ちょうど10件・ちょうど20件も余分に取りに行かない", async () => {
  for (const [total, want] of [[3, 1], [10, 1], [11, 2], [20, 2], [0, 1]]) {
    const calls = stubFetch(cityRoutes("13", "台東区", total));
    const r = await crawlParknetCity("13", "台東区", { onPage: () => {} });
    assert.equal(pagesOf(calls).length, want, `${total}件`);
    assert.equal(r.got, total);
  }
});

test("途中のページが取れない（503）ときは、そこまでの物件を渡してその市区だけ止める。取れなかったページの先へは行かない", async () => {
  const routes = cityRoutes("01", "札幌市中央区", 59);
  routes[cityListUrl("01", "札幌市中央区", 30)] = { status: 503, body: "busy" };
  const calls = stubFetch(routes);
  const got = [];
  const r = await crawlParknetCity("01", "札幌市中央区", { onPage: (recs) => got.push(...recs) });
  assert.deepEqual(pagesOf(calls), [0, 10, 20, 30].map((o) => cityListUrl("01", "札幌市中央区", o)));
  assert.equal(got.length, 30);          // 1〜3ページ目は渡し済み（捨てない）
  assert.equal(r.pages, 3);
  assert.equal(r.failed.offset, 30);
  assert.equal(r.failed.why, "HTTP 503");
  assert.equal(r.failed.res.status, 503); // 失敗の種類を呼ぶ側で決められるように、答えそのものも渡す
  assert.equal(r.stop, null);            // パークネットごとは止めない（次の市区へ進む）
});

test("onFetch には取りに行ったページごとの答えが来る（例外のときは null）。HTTP の状態を数えるのに使う", async () => {
  const routes = cityRoutes("01", "札幌市中央区", 59);
  routes[cityListUrl("01", "札幌市中央区", 20)] = { throw: "ECONNRESET" };
  stubFetch(routes);
  const seen = [];
  const r = await crawlParknetCity("01", "札幌市中央区", { onPage: () => {}, onFetch: (res, url) => seen.push([res?.status ?? null, url]) });
  assert.deepEqual(seen, [[200, cityListUrl("01", "札幌市中央区", 0)], [200, cityListUrl("01", "札幌市中央区", 10)],
    [null, cityListUrl("01", "札幌市中央区", 20)]]);
  assert.equal(r.failed.res, null);
  assert.equal(r.got, 20);
});

test("途中のページで通信が切れたときも同じ（原因の符号を残す）", async () => {
  const routes = cityRoutes("27", "大阪市北区", 15);
  routes[cityListUrl("27", "大阪市北区", 10)] = { throw: "ECONNRESET" };
  stubFetch(routes);
  const got = [];
  const r = await crawlParknetCity("27", "大阪市北区", { onPage: (recs) => got.push(...recs) });
  assert.equal(got.length, 10);
  assert.equal(r.failed.offset, 10);
  assert.match(r.failed.why, /ECONNRESET/);
});

test("1市区のページ数には上限がある（既定10ページ＝100件）。上限に当たったら capped で知らせる", async () => {
  const calls = stubFetch(cityRoutes("13", "台東区", 150));
  const r = await crawlParknetCity("13", "台東区", { onPage: () => {} });
  assert.equal(PARKNET_MAX_PAGES, 10);
  assert.equal(pagesOf(calls).length, 10);
  assert.equal(r.got, 100);
  assert.equal(r.capped, true);
  // ちょうど上限で終わる市区は capped にしない
  stubFetch(cityRoutes("13", "台東区", 100));
  assert.equal((await crawlParknetCity("13", "台東区", { onPage: () => {} })).capped, false);
});

test("offset が効かず1ページ目と同じ物件が返ったら（サイトの作りの変更）、2ページ目で止める", async () => {
  const routes = {};
  const first = cityPage({ total: 59 });
  for (let o = 0; o < 60; o += 10) routes[cityListUrl("01", "札幌市中央区", o)] = first;
  const calls = stubFetch(routes);
  const got = [];
  const r = await crawlParknetCity("01", "札幌市中央区", { onPage: (recs) => got.push(...recs) });
  assert.equal(pagesOf(calls).length, 2);
  assert.equal(got.length, 10);
  assert.equal(r.dup, true);
});

test("総件数が読めないときはページ送りのリンクで次を決め、どちらも無ければ1ページで止める（以前と同じ）", async () => {
  let calls = stubFetch(cityRoutes("01", "函館市", 25, { showTotal: false }));
  let r = await crawlParknetCity("01", "函館市", { onPage: () => {} });
  assert.equal(pagesOf(calls).length, 3);
  assert.equal(r.got, 25);
  assert.equal(r.total, null);
  calls = stubFetch(cityRoutes("01", "函館市", 25, { showTotal: false, showPager: false }));
  r = await crawlParknetCity("01", "函館市", { onPage: () => {} });
  assert.equal(pagesOf(calls).length, 1);
  assert.equal(r.got, 10);
});

test("robots.txt が 403 なら本ページは送らずに stop（blocked）を返す", async () => {
  const calls = stubFetch({ [ROBOTS]: { status: 403 }, ...cityRoutes("01", "札幌市中央区", 59) });
  const r = await crawlParknetCity("01", "札幌市中央区", { onPage: () => assert.fail("渡さない") });
  assert.deepEqual(calls, [ROBOTS]);
  assert.equal(r.stopKind, "blocked");
  assert.equal(r.stopRes.blocked, true);
  assert.match(r.stop, /robots\.txt が HTTP 403/);
});

test("2ページ目以降が0件のページで返ったら（総件数は読めている）、short で知らせる。dup・failed・capped は立てない", async () => {
  // 総件数59と出ているのに、2ページ目から空の一覧が返る（offset が効かなくなって空のページを返す形）
  let calls = stubFetch(cityRoutes("01", "札幌市中央区", 59, { ids: Array.from({ length: 10 }, (_, i) => `j${8000 + i}`) }));
  let r = await crawlParknetCity("01", "札幌市中央区", { onPage: () => {} });
  assert.equal(pagesOf(calls).length, 2);          // 空のページの先へは行かない
  assert.equal(r.total, 59);
  assert.equal(r.got, 10);
  assert.equal(r.short, true);
  assert.equal(r.dup, false);
  assert.equal(r.failed, null);
  assert.equal(r.capped, false);
  // 総件数40・実際は25件で、4ページ目が空（点検の試しと同じ形）
  calls = stubFetch(cityRoutes("13", "台東区", 40, { ids: Array.from({ length: 25 }, (_, i) => `j${7000 + i}`) }));
  r = await crawlParknetCity("13", "台東区", { onPage: () => {} });
  assert.equal(pagesOf(calls).length, 4);
  assert.equal(r.got, 25);
  assert.equal(r.short, true);
});

test("総件数どおりに取れたとき・総件数が読めないとき・取れなかった／上限／dup のときは short にしない（そちらで知らせる）", async () => {
  stubFetch(cityRoutes("01", "札幌市中央区", 59));
  assert.equal((await crawlParknetCity("01", "札幌市中央区", { onPage: () => {} })).short, false);
  stubFetch(cityRoutes("01", "函館市", 25, { showTotal: false, ids: Array.from({ length: 12 }, (_, i) => `j${6000 + i}`) }));
  assert.equal((await crawlParknetCity("01", "函館市", { onPage: () => {} })).short, false);   // 総件数が無ければ比べられない
  const routes = cityRoutes("01", "札幌市中央区", 59);
  routes[cityListUrl("01", "札幌市中央区", 30)] = { status: 503, body: "busy" };
  stubFetch(routes);
  let r = await crawlParknetCity("01", "札幌市中央区", { onPage: () => {} });
  assert.ok(r.failed);
  assert.equal(r.short, false);
  stubFetch(cityRoutes("13", "台東区", 150));
  r = await crawlParknetCity("13", "台東区", { onPage: () => {} });
  assert.equal(r.capped, true);
  assert.equal(r.short, false);
  const same = cityPage({ total: 59, offset: 0 });
  stubFetch(Object.fromEntries([0, 10, 20, 30, 40, 50].map((o) => [cityListUrl("01", "札幌市中央区", o), same])));
  r = await crawlParknetCity("01", "札幌市中央区", { onPage: () => {} });
  assert.equal(r.dup, true);
  assert.equal(r.short, false);
});

test("市区をまとめて取る: 市区ごとの印を集め、health の補足（extra と reason）に shortCities などを残す。ok の決め方は以前と同じ", async () => {
  const routes = {
    ...cityRoutes("01", "札幌市中央区", 59, { ids: Array.from({ length: 10 }, (_, i) => `ja${i}`) }),   // 2ページ目が空 → short
    ...cityRoutes("27", "大阪市北区", 15, { ids: Array.from({ length: 15 }, (_, i) => `jb${i}`) }),
    ...cityRoutes("13", "台東区", 23, { ids: Array.from({ length: 23 }, (_, i) => `jc${i}`) }),
  };
  routes[cityListUrl("13", "台東区", 10)] = { status: 500, body: "error" };   // 台東区は2ページ目から取れない
  routes[cityListUrl("30", "和歌山市", 0)] = { throw: "ECONNRESET" };         // 和歌山市は1ページ目から取れない
  stubFetch(routes);
  const recs = [], fetched = [];
  const quiet = { log() {}, warn() {}, error() {} };
  const sum = await crawlParknetCities(["01	札幌市中央区", "27	大阪市北区", "13	台東区", "30	和歌山市", "", "壊れた行"],
    { onRecord: (rec) => recs.push(rec), onFetch: (res) => fetched.push(res?.status ?? null), log: quiet });
  assert.equal(sum.count, 10 + 15 + 10);
  assert.equal(recs.length, sum.count);
  assert.equal(recs.find((x) => x.parkId === "jb12")._requestUrl, cityListUrl("27", "大阪市北区", 10));
  assert.deepEqual(sum.shortCities, ["札幌市中央区"]);
  assert.deepEqual(sum.partialCities, ["台東区"]);
  assert.deepEqual(sum.failedCities, ["和歌山市"]);
  assert.deepEqual(sum.failures.map((f) => [f.city, f.res?.status ?? null]), [["台東区", 500], ["和歌山市", null]]);
  assert.deepEqual(fetched, [200, 200, 200, 200, 200, 500, null]);
  const h = parknetHealth(sum);
  assert.equal(h.ok, true);
  assert.equal(h.n, 35);
  assert.equal(h.reason, "取れなかった市区1・途中のページから取れなかった市区1・総件数より少なかった市区1");
  assert.deepEqual(h.extra, { pages: 5, failedCities: ["和歌山市"], partialCities: ["台東区"], shortCities: ["札幌市中央区"] });
  // 打ち切り・0件のときは以前と同じ（ok:false）
  assert.deepEqual(parknetHealth({ ...sum, stop: "robots.txt が HTTP 403", stopKind: "blocked" }).ok, false);
  assert.equal(parknetHealth({ ...sum, stop: "robots.txt が HTTP 403", stopKind: "blocked" }).extra.kind, "blocked");
  const empty = parknetHealth({ count: 0, pages: 0, stop: null, stopKind: null, failedCities: [], partialCities: [], cappedCities: [], dupCities: [], shortCities: [] });
  assert.deepEqual([empty.ok, empty.reason, empty.extra], [false, "0件", { pages: 0 }]);
});

// ---- run.js を通しで動かす ----

/** run.js を別のプロセスで動かす（CRAWL_ONLY=parknet）。fetch は routes で差し替え、呼んだ URL を控える */
const tmpDirs = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });   // テストの一時ディレクトリを消す
function runCrawl({ routes, files, dir = null }) {
  if (!dir) { dir = fs.mkdtempSync(path.join(os.tmpdir(), "parknet-")); tmpDirs.push(dir); }
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
globalThis.fetch = async (url) => {
  const u = String(url);
  fs.appendFileSync(${JSON.stringify(callsFile)}, u + "\\n");
  const r = routes[u] ?? (u.endsWith("/robots.txt") ? { status: 200, body: ${JSON.stringify(ROBOTS_BODY)} } : { status: 404 });
  if (r.throw) { const e = new TypeError("fetch failed"); e.cause = { code: r.throw }; throw e; }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "", headers: { get: () => null } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_HOLD: "off", CRAWL_ONLY: "parknet", HEALTH_NAME: "test", OUT_FILE: "data/prices-test.jsonl" },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, 0, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const health = JSON.parse(fs.readFileSync(path.join(dir, "data/health/test.json"), "utf8")).targets;
  const rows = fs.readFileSync(path.join(dir, "data/prices-test.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { calls, health, rows, log, dir };
}
const asRoutes = (o) => Object.fromEntries(Object.entries(o).map(([u, b]) => [u, typeof b === "string" ? { status: 200, body: b } : b]));

test("通しの巡回: 10件を超える市区も全件を記録し、途中のページが取れない市区はそこまで記録して次の市区へ進む", () => {
  const cities = [["01", "札幌市中央区", 59, (i) => `ja${i}`], ["13", "台東区", 23, (i) => `jb${i}`], ["30", "和歌山市", 4, (i) => `jc${i}`]];
  const routes = {};
  for (const [p, c, n, idOf] of cities) Object.assign(routes, cityRoutes(p, c, n, { ids: Array.from({ length: n }, (_, i) => idOf(i)) }));
  routes[cityListUrl("13", "台東区", 20)] = { status: 500, body: "error" };   // 台東区の3ページ目だけ取れない
  const files = {
    "data/parknet-cities.txt": cities.map(([p, c]) => `${p}\t${c}`).join("\n") + "\n",
    "data/parknet-cities.txt.fetched": new Date().toISOString(),   // 市区の一覧は作り直さない
  };
  const { calls, health, rows } = runCrawl({ routes: asRoutes(routes), files });
  assert.equal(calls.filter((u) => u.endsWith("/robots.txt")).length, 1);
  assert.equal(pagesOf(calls).length, 6 + 3 + 1);
  assert.equal(rows.length, 59 + 20 + 4);
  assert.equal(new Set(rows.map((r) => r.parkId)).size, rows.length);
  // 1ページ目の物件の _requestUrl は以前と同じ。2ページ目からは offset 付き
  assert.equal(rows.find((r) => r.parkId === "ja0")._requestUrl, cityListUrl("01", "札幌市中央区"));
  assert.equal(rows.find((r) => r.parkId === "ja58")._requestUrl, cityListUrl("01", "札幌市中央区", 50));
  const h = health.find((t) => t.op === "parknet");
  assert.equal(h.ok, true);   // 途中のページが1つ取れなかっただけでは失敗にしない（取れた分は記録した）
  assert.equal(h.n, 83);
  assert.equal(h.pages, 9);   // 送って取れたページ（取れなかった台東区の3ページ目は数えない）
  assert.deepEqual(h.partialCities, ["台東区"]);
  assert.match(h.reason, /途中のページから取れなかった市区1/);
});

test("通しの巡回: 2回目は料金が同じなら記録を足さない（2ページ目以降の物件も同じ）", () => {
  const n = 25;
  const routes = asRoutes(cityRoutes("27", "大阪市北区", n));
  const files = { "data/parknet-cities.txt": "27\t大阪市北区\n", "data/parknet-cities.txt.fetched": new Date().toISOString() };
  const first = runCrawl({ routes, files });
  assert.equal(first.rows.length, n);
  const second = runCrawl({ routes, files: {}, dir: first.dir });
  assert.equal(second.rows.length, n);   // 増えない
  assert.equal(second.health.find((t) => t.op === "parknet").n, n);
  assert.equal(second.health.find((t) => t.op === "parknet").reason, null);
});

test("通しの巡回: robots.txt が 403 なら市区のページは1つも送らず、health は ok:false・kind blocked", () => {
  const routes = { [ROBOTS]: { status: 403 }, ...asRoutes(cityRoutes("01", "札幌市中央区", 59)) };
  const files = { "data/parknet-cities.txt": "01\t札幌市中央区\n13\t台東区\n", "data/parknet-cities.txt.fetched": new Date().toISOString(),
    "data/prices-test.jsonl": "" };
  const { calls, health, rows } = runCrawl({ routes, files });
  // 市区のページは送らない。メンテナンスかを確かめる入口（トップページ）だけ1回見る（2026-10-27）
  assert.deepEqual(calls, [ROBOTS, "https://parknet.shinmaywa.co.jp/"]);
  assert.equal(rows.length, 0);
  const h = health.find((t) => t.op === "parknet");
  assert.equal(h.ok, false);
  assert.equal(h.kind, "blocked");
  assert.match(h.reason, /robots\.txt が HTTP 403/);
});

test("通しの巡回: 2ページ目以降が空のページで返った市区は、health の shortCities と reason に出る（ok のまま）", () => {
  const routes = asRoutes(cityRoutes("01", "札幌市中央区", 59, { ids: Array.from({ length: 10 }, (_, i) => `jd${i}`) }));
  const files = { "data/parknet-cities.txt": "01\t札幌市中央区\n", "data/parknet-cities.txt.fetched": new Date().toISOString() };
  const { calls, health, rows, log } = runCrawl({ routes, files });
  assert.equal(pagesOf(calls).length, 2);
  assert.equal(rows.length, 10);
  const h = health.find((t) => t.op === "parknet");
  assert.equal(h.ok, true);
  assert.deepEqual(h.shortCities, ["札幌市中央区"]);
  assert.match(h.reason, /総件数より少なかった市区1/);
  assert.match(log, /総件数59件のうち10件しか載っていなかった/);
});

test("通しの巡回（run.js の担当と合わせた形）: health に送ったページの状態コードの数（statusCounts）が出る。ok:false のときの kind は health-kind.js の言葉", () => {
  const routes = asRoutes({ ...cityRoutes("01", "札幌市中央区", 23), ...cityRoutes("30", "和歌山市", 4) });
  routes[cityListUrl("01", "札幌市中央区", 20)] = { status: 500, body: "error" };
  routes[cityListUrl("30", "和歌山市", 0)] = { throw: "ECONNRESET" };
  const files = { "data/parknet-cities.txt": "01\t札幌市中央区\n30\t和歌山市\n", "data/parknet-cities.txt.fetched": new Date().toISOString(),
    "data/prices-test.jsonl": "" };
  const { health } = runCrawl({ routes, files });
  const h = health.find((t) => t.op === "parknet");
  assert.equal(h.ok, true);
  assert.equal(h.kind, undefined);   // ok の行には kind を付けない
  assert.deepEqual(h.statusCounts, { 200: 2, 500: 1, network: 1 });
  assert.deepEqual(h.partialCities, ["札幌市中央区"]);
  assert.deepEqual(h.failedCities, ["和歌山市"]);
  // 1件も取れず、取れなかった理由が通信の失敗だけなら kind は network
  const bad = runCrawl({ routes: { [cityListUrl("30", "和歌山市", 0)]: { status: 503, body: "busy" } }, files: { ...files, "data/parknet-cities.txt": "30\t和歌山市\n" } });
  const hb = bad.health.find((t) => t.op === "parknet");
  assert.deepEqual([hb.ok, hb.kind, hb.statusCounts], [false, "network", { 503: 1 }]);
  // robots.txt が届かない（5xx）ときは、以前の unreachable ではなく network
  const unr = runCrawl({ routes: { [ROBOTS]: { status: 503 } }, files });
  assert.equal(unr.health.find((t) => t.op === "parknet").kind, "network");
});
