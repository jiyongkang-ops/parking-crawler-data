// 一覧の取りこぼしを直したぶんのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える・保存したページを使う）。
// 2026-11-02:
//   ・NTTル・パルク: ?start= はページ番号なのに件数と読み違え、1ページ目と20ページ目の40件で止めていた（全24ページ・471件）。
//     40ページ目の 403 は、最後のページを超えたときのサイトのエラー画面だった。座標は schema.org の世界測地系を読む
//   ・JQパークス: 大分・長崎の駅（トップでは先頭に / の無い相対リンク）を拾っていなかった。駅の一覧の2ページ目以降も読んでいなかった。
//     一覧の座標（makePin）と「時間貸OK」の印を記録に残す
// test/fixtures/ の HTML は 2026-11-01 に当社の UA で取ったページ（調査の控え）
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
const { getAllLeparcIds, parseLeparcIds, parsePageState, parseDeclaredCount, listUrl } = await import("../src/leparc-enumerate.js");
const { parseLeparcDetail, parseLeparcGeo } = await import("../src/leparc.js");
const { getAllJqparksIds, parseTopTotal, parseStationNames, parsePrefLinks, parseCityLinks, parseStationPage, stationListUrl, lotsFileOf } =
  await import("../src/jqparks-enumerate.js");
const { parseJqparksDetail } = await import("../src/jqparks.js");
config.minDelayMs = 0;   // テストでは待たない

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "test/fixtures");
const fixture = (f) => fs.readFileSync(path.join(FIX, f), "utf8");
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** 差し替えた取得（getAll…Ids の fetcher）。url → 本文（文字列）または { status, body, throw }。呼ばれた URL を控える */
function stubFetcher(routes) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const r = routes[url] ?? { status: 404, body: "" };
    if (r.throw) { const e = new TypeError("fetch failed"); e.cause = { code: r.throw }; throw e; }
    const body = typeof r === "string" ? r : r.body ?? "";
    const status = typeof r === "string" ? 200 : r.status;
    return { ok: status >= 200 && status < 300, status, html: body };
  };
  return { fetcher, calls };
}

// ---- NTTル・パルク ----

const L = "https://sasp.mapion.co.jp/b/leperc/attr/";
/** 一覧の1ページ（本物と同じ書き方の pageState・件数・物件リンク） */
const leparcPage = (nowPage, endPage, declared, from, n) =>
  `<script>window.pageState = {pageType: 'attr', nowPage: ${nowPage}, endPage: ${endPage}};</script>` +
  `<p><span class="num">${declared}</span>件の店舗を表示</p>` +
  Array.from({ length: n }, (_, i) => `<a href="/b/leperc/info/NRP${String(from + i).padStart(5, "0")}/?type=coin">x</a>`).join("");

test("ル・パルクの一覧のページ（保存したページ）: 1ページ目は全24ページ・471件・20件、24ページ目は11件、40ページ目はエラー画面", () => {
  const p1 = fixture("leparc/attr-page1.html");
  assert.deepEqual(parsePageState(p1), { pageType: "attr", nowPage: 1, endPage: 24 });
  assert.equal(parseDeclaredCount(p1), 471);
  assert.equal(parseLeparcIds(p1).length, 20);
  const p24 = fixture("leparc/attr-page24.html");
  assert.deepEqual(parsePageState(p24), { pageType: "attr", nowPage: 24, endPage: 24 });
  assert.equal(parseLeparcIds(p24).length, 11);
  // 最後のページを超えたページは、サイトのエラー画面（EX002）。当ボットを断る答えではない
  const err = fixture("leparc/attr-page40-error.html");
  assert.deepEqual(parsePageState(err), { pageType: "error", nowPage: null, endPage: null });
  assert.equal(parseLeparcIds(err).length, 0);
  assert.match(err, /EX002/);
  // ?start= はページ番号。1ページ目は ?start なし
  assert.equal(listUrl(1), L);
  assert.equal(listUrl(2), `${L}?start=2`);
  assert.equal(listUrl(24), `${L}?start=24`);
});

test("ル・パルクの一覧は ?start をページ番号として最後のページ（endPage）まで取り、その先は取りに行かない", async () => {
  const { fetcher, calls } = stubFetcher({
    [L]: leparcPage(1, 3, 50, 1, 20), [`${L}?start=2`]: leparcPage(2, 3, 50, 21, 20), [`${L}?start=3`]: leparcPage(3, 3, 50, 41, 10),
    [`${L}?start=4`]: leparcPage(4, 3, 50, 0, 0), [`${L}?start=40`]: { status: 403, body: "EX002" },
  });
  const dir = tmpDir("leparc-");
  const file = path.join(dir, "leparc-ids.txt");
  const ids = await getAllLeparcIds({ cacheFile: file, fetcher });
  assert.equal(ids.length, 50);
  assert.deepEqual(calls, [L, `${L}?start=2`, `${L}?start=3`]);
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 50);
  assert.ok(fs.existsSync(`${file}.fetched`));
  assert.equal(ids.listNote, undefined);
  assert.equal(ids.staleReason, undefined);
});

test("ル・パルクの一覧は endPage が読めなくても、新しい物件の無いページで止まる（上限40ページ）", async () => {
  const routes = { [L]: "<span class=\"num\">40</span>件" + leparcPage(1, 0, 40, 1, 20).replace(/window\.pageState[^;]*;/, ""),
    [`${L}?start=2`]: leparcPage(2, 0, 40, 21, 20), [`${L}?start=3`]: leparcPage(3, 0, 40, 0, 0) };
  const { fetcher, calls } = stubFetcher(routes);
  const ids = await getAllLeparcIds({ cacheFile: path.join(tmpDir("leparc-"), "leparc-ids.txt"), fetcher });
  assert.equal(ids.length, 40);
  assert.deepEqual(calls, [L, `${L}?start=2`, `${L}?start=3`]);
});

test("ル・パルクの一覧の途中のページが取れなければ上書きせず、前の一覧と合わせて回す（取得日は進めない）", async () => {
  const dir = tmpDir("leparc-");
  const file = path.join(dir, "leparc-ids.txt");
  const prev = ["NRP00001", "NRP09999"];
  fs.writeFileSync(file, prev.join("\n") + "\n");
  const stamp = new Date(Date.now() - 8 * 864e5).toISOString();   // 8日前（作り直しの時期・14日より前）
  fs.writeFileSync(`${file}.fetched`, stamp);
  const { fetcher, calls } = stubFetcher({ [L]: leparcPage(1, 3, 50, 1, 20), [`${L}?start=2`]: { status: 500 }, [`${L}?start=3`]: leparcPage(3, 3, 50, 41, 10) });
  const ids = await getAllLeparcIds({ cacheFile: file, fetcher });
  assert.deepEqual(calls, [L, `${L}?start=2`]);                    // 取れないページの先には進まない
  assert.equal(ids.length, 21);                                     // 1ページ目の20件＋前の一覧にだけある NRP09999
  assert.ok(ids.includes("NRP09999"));
  assert.match(ids.listNote, /2ページ目が HTTP 500/);
  assert.equal(ids.staleReason, undefined);
  assert.deepEqual(fs.readFileSync(file, "utf8").split("\n").filter(Boolean), prev);   // 上書きしていない
  assert.equal(fs.readFileSync(`${file}.fetched`, "utf8"), stamp);                       // 取得日は進めない
});

test("ル・パルクの一覧が表示の件数の9割に届かなければ上書きしない。前の一覧が14日より古ければ staleReason", async () => {
  const dir = tmpDir("leparc-");
  const file = path.join(dir, "leparc-ids.txt");
  fs.writeFileSync(file, "NRP00001\n");
  fs.writeFileSync(`${file}.fetched`, new Date(Date.now() - 20 * 864e5).toISOString());
  // 1ページ目だけ（全1ページ）で20件なのに、表示は471件
  const { fetcher } = stubFetcher({ [L]: leparcPage(1, 1, 471, 1, 20) });
  const ids = await getAllLeparcIds({ cacheFile: file, fetcher });
  assert.equal(ids.length, 20);
  assert.match(ids.staleReason, /一覧を作り直せていない.*表示471件/);
  assert.deepEqual(fs.readFileSync(file, "utf8").split("\n").filter(Boolean), ["NRP00001"]);
});

test("ル・パルクの一覧が1件も取れず、前の一覧も無ければ例外（0件の一覧を書かない）", async () => {
  const { fetcher } = stubFetcher({ [L]: { status: 503 } });
  const file = path.join(tmpDir("leparc-"), "leparc-ids.txt");
  await assert.rejects(getAllLeparcIds({ cacheFile: file, fetcher }), /1ページ目が HTTP 503/);
  assert.equal(fs.existsSync(file), false);
});

test("ル・パルクの詳細ページの座標は schema.org の世界測地系を読む（ページの JSON の latitude は旧日本測地系なので使わない）", () => {
  const html = fixture("leparc/detail-NRP00188.html");
  const r = parseLeparcDetail(html, { id: "NRP00188" });
  assert.equal(r.name, "NTTル・パルク松戸第1駐車場");
  assert.equal(r.lat, 35.789208);
  assert.equal(r.lng, 139.893081);
  // ページの JSON（旧日本測地系 35.78597…）は読んでいない
  assert.match(html, /"latitude":"35\.78597/);
  assert.equal(r.unitCharges.length, 2);
  assert.equal(r.maxFees.length, 2);
  // 座標が無い・日本の外なら null
  assert.deepEqual(parseLeparcGeo("<div>座標なし</div>"), { lat: null, lng: null });
  assert.deepEqual(parseLeparcGeo('<div itemprop="geo" itemscope itemtype="https://schema.org/GeoCoordinates"><meta itemprop="latitude" content="0"><meta itemprop="longitude" content="0"></div>'),
    { lat: null, lng: null });
});

// ---- JQパークス ----

const JQ = "https://www.parking-kyushu.jp";
const enc = encodeURIComponent;

test("JQパークスのトップ（保存したページ）: 合計746件・7県・相対リンクの大分・長崎の駅も拾う", () => {
  const top = fixture("jqparks/top.html");
  assert.equal(parseTopTotal(top), 746);
  assert.deepEqual(parsePrefLinks(top), ["福岡県", "佐賀県", "長崎県", "大分県", "熊本県", "宮崎県", "鹿児島県"]);
  const st = parseStationNames(top);
  // 以前の拾い方（href="/station/…" だけ）では大分・長崎の駅が1つも無かった
  const before = new Set([...top.matchAll(/href="\/station\/([^"/]+)/g)].map((m) => m[1]));
  for (const s of ["大分駅", "浦上駅", "長崎駅", "諫早駅"]) {
    assert.ok(st.includes(s), s);
    assert.equal(before.has(s), false, s);
  }
  assert.ok(st.includes("博多駅"));
  assert.equal(new Set(st).size, st.length);   // 駅名で重複なし（タブ違いの同じ駅は1つ）
});

test("JQパークスの県・市区ページ（保存したページ）: 県 → 市区、市区 → 駅", () => {
  const cities = parseCityLinks(fixture("jqparks/city-oita.html")).filter(([p]) => p === "大分県");
  assert.equal(cities.length, 13);
  assert.ok(cities.some(([, c]) => c === "大分市"));
  assert.deepEqual(parseStationNames(fixture("jqparks/city-oita-oita.html")),
    ["賀来駅", "幸崎駅", "高城駅", "坂ノ市駅", "大在駅", "大分駅", "滝尾駅", "中判田駅", "鶴崎駅", "南大分駅"]);
});

test("JQパークスの駅の一覧（保存したページ）: 合計の件数・座標（makePin）・時間貸OK の印", () => {
  const oita = parseStationPage(fixture("jqparks/s-oita-p1.html"));
  assert.equal(oita.total, 19);                // 19件中の1ページ目（10件）
  assert.equal(oita.ids.length, 10);
  assert.deepEqual(oita.lots.get("60610001"), { lat: 33.233719, lng: 131.605417, hourlyOk: true });
  assert.deepEqual(oita.lots.get("94289352"), { lat: 33.214338, lng: 131.586093, hourlyOk: true });
  // 2ページ目（博多駅 16件中の6件）。月極だけの物件（icon_00.gif）は hourlyOk:false で残す
  const hakata2 = parseStationPage(fixture("jqparks/s-hakata-p2.html"));
  assert.equal(hakata2.total, 16);
  assert.equal(hakata2.ids.length, 6);
  assert.equal([...hakata2.lots.values()].filter((v) => v.hourlyOk === false).length, 2);
  assert.equal(hakata2.lots.size, 6);
  // 10件以下の駅（佐賀駅 9件）。ページ送りは無い
  const saga = parseStationPage(fixture("jqparks/s-saga.html"));
  assert.equal(saga.total, 9);
  assert.equal(saga.ids.length, 9);
  assert.equal([...saga.lots.values()].filter((v) => v.hourlyOk === false).length, 4);
  for (const v of saga.lots.values()) assert.ok(v.lat > 33 && v.lat < 34 && v.lng > 130 && v.lng < 131);
  // 駅の一覧は転送先の /s/ を直接取る
  assert.equal(stationListUrl("大分駅"), `${JQ}/s/?m=1&w=${enc("大分駅")}`);
  assert.equal(stationListUrl("大分駅", 2), `${JQ}/s/?m=1&w=${enc("大分駅")}&p=2`);
});

/** 駅の一覧の1ページ（本物と同じ書き方）。lots … [コード, 緯度, 経度, 時間貸OK] */
const jqStationPage = (total, page, lots) =>
  lots.map(([c, la, ln], i) => `makePin(${la}, ${ln},'${String(i + 1).padStart(2, "0")}','JQParksテスト${c}','${c}');`).join("\n") +
  "\nfunction makePin(lat,lon,number,name,code){ location.href='/number/'+code }\n" +
  lots.map(([c, , , h]) => `<tr height="30" id="t${c}"><td><a href="/number/${c}"><strong>テスト</strong></a></td>` +
    `<td><img src="/img/${h ? "icon_01.png" : "icon_00.gif"}" width="30" height="30" alt="時間貸OK" /><img src="/img/icon_02.png" width="30" height="30" alt="月極OK" /></td></tr>`).join("\n") +
  `<div class="parking_page">合計：<strong>${total}</strong>件中<strong> - ${page}</strong> ページ目を表示</div>`;

/** トップ → 2県 → 3市区 → 駅（博多駅は12件で2ページ、大分駅・浦上駅は1ページ）。合計25件 */
function jqRoutes(overrides = {}) {
  const lot = (i) => [String(19000000 + i), (33 + i / 1000).toFixed(6), (130 + i / 1000).toFixed(6), i % 5 !== 0];
  const lots = Array.from({ length: 25 }, (_, i) => lot(i + 1));
  return {
    [`${JQ}/`]: `<a href="/city/福岡県">福岡</a><a href="/city/大分県">大分</a>` +
      `<area href="/station/博多駅/fuk" /><area href="/station/博多駅/fukuoka" /><area href="station/大分駅/oita" />` +
      `<td align="center">(13件)</td><strong>合計</strong></td><td align="center">25件</td>`,
    [`${JQ}/city/${enc("福岡県")}`]: `<a href="/city/福岡県/福岡市博多区">博多区</a><a href="/city/大分県">大分</a>`,
    [`${JQ}/city/${enc("大分県")}`]: `<a href="/city/大分県/大分市">大分市</a><a href="/city/長崎県/長崎市">別の県</a>`,
    [`${JQ}/city/${enc("福岡県")}/${enc("福岡市博多区")}`]: `<a href="/station/博多駅">博多駅</a>`,
    [`${JQ}/city/${enc("大分県")}/${enc("大分市")}`]: `<a href="/station/大分駅">大分駅</a><a href="/station/浦上駅">浦上駅</a>`,
    [stationListUrl("博多駅")]: jqStationPage(12, 1, lots.slice(0, 10)),
    [stationListUrl("博多駅", 2)]: jqStationPage(12, 2, lots.slice(10, 12)),
    [stationListUrl("大分駅")]: jqStationPage(8, 1, lots.slice(12, 20)),
    [stationListUrl("浦上駅")]: jqStationPage(5, 1, lots.slice(20, 25)),
    ...overrides,
  };
}

test("JQパークスの一覧は県 → 市区 → 駅をたどり、駅ごとに /s/ を直接・2ページ目以降も取る。座標と時間貸の印を控えに残す", async () => {
  const { fetcher, calls } = stubFetcher(jqRoutes());
  const dir = tmpDir("jqparks-");
  const file = path.join(dir, "jqparks-ids.txt");
  const ids = await getAllJqparksIds({ cacheFile: file, fetcher, log: () => {} });
  assert.equal(ids.length, 25);
  assert.deepEqual(calls, [
    `${JQ}/`, `${JQ}/city/${enc("福岡県")}`, `${JQ}/city/${enc("大分県")}`,
    `${JQ}/city/${enc("福岡県")}/${enc("福岡市博多区")}`, `${JQ}/city/${enc("大分県")}/${enc("大分市")}`,   // 別の県の市区（長崎市）はその県で取る
    stationListUrl("博多駅"), stationListUrl("博多駅", 2), stationListUrl("大分駅"), stationListUrl("浦上駅"),
  ]);
  assert.equal(calls.some((u) => u.includes("/station/")), false);   // 302 で2回取る /station/ は使わない
  assert.equal(ids.listNote, undefined);
  // 座標と時間貸の印（listMeta と控えのファイル）
  assert.deepEqual(ids.listMeta.get("19000001"), { lat: 33.001, lng: 130.001, hourlyOk: true });
  assert.equal(ids.listMeta.get("19000005").hourlyOk, false);   // 月極だけの物件も一覧に残す
  assert.ok(ids.includes("19000005"));
  assert.equal(lotsFileOf(file), path.join(dir, "jqparks-lots.json"));
  const saved = JSON.parse(fs.readFileSync(path.join(dir, "jqparks-lots.json"), "utf8"));
  assert.equal(Object.keys(saved).length, 25);
  assert.deepEqual(saved["19000011"], { lat: 33.011, lng: 130.011, hourlyOk: true });   // 博多駅の2ページ目
  assert.ok(fs.existsSync(`${file}.fetched`));
  // 2回目は控えから（取りに行かない）。座標と印も控えから読む
  const again = await getAllJqparksIds({ cacheFile: file, fetcher, log: () => {} });
  assert.equal(calls.length, 9);
  assert.equal(again.length, 25);
  assert.deepEqual(again.listMeta.get("19000005"), { lat: 33.005, lng: 130.005, hourlyOk: false });
});

test("JQパークスの一覧が表示の合計の9割に届かなければ listNote で知らせる（一覧は使う）", async () => {
  const routes = jqRoutes();
  routes[`${JQ}/`] = routes[`${JQ}/`].replace("25件", "40件");
  const { fetcher } = stubFetcher(routes);
  const ids = await getAllJqparksIds({ cacheFile: path.join(tmpDir("jqparks-"), "jqparks-ids.txt"), fetcher, log: () => {} });
  assert.equal(ids.length, 25);
  assert.match(ids.listNote, /駅の一覧で見つかったのは25件（トップの表示は40件）/);
});

test("JQパークスの駅のページが少し取れなくても作り直しは成功にし、前の一覧の物件を残す", async () => {
  const dir = tmpDir("jqparks-");
  const file = path.join(dir, "jqparks-ids.txt");
  fs.writeFileSync(file, "19000021\n18999999\n");
  fs.writeFileSync(path.join(dir, "jqparks-lots.json"), JSON.stringify({ 18999999: { lat: 32.75, lng: 129.87, hourlyOk: true } }));
  const { fetcher } = stubFetcher(jqRoutes({ [stationListUrl("浦上駅")]: { status: 500 } }));
  const ids = await getAllJqparksIds({ cacheFile: file, fetcher, log: () => {} });
  assert.equal(ids.length, 22);                       // 取れた20件＋前の一覧の2件（取れなかった浦上駅の 19000021 と 18999999）
  assert.ok(ids.includes("18999999"));
  assert.ok(ids.includes("19000021"));
  assert.deepEqual(ids.listMeta.get("18999999"), { lat: 32.75, lng: 129.87, hourlyOk: true });
  assert.match(ids.listNote, /取れなかったページ1件.*浦上駅.*HTTP 500/);
  assert.ok(fs.readFileSync(file, "utf8").includes("18999999"));
});

test("JQパークスのトップが取れなければ前の一覧を使い、20時間は作り直しを試さない。前の一覧も無ければ例外", async () => {
  const dir = tmpDir("jqparks-");
  const file = path.join(dir, "jqparks-ids.txt");
  fs.writeFileSync(file, "19000001\n");
  fs.writeFileSync(`${file}.fetched`, new Date(Date.now() - 8 * 864e5).toISOString());
  const { fetcher, calls } = stubFetcher({ [`${JQ}/`]: { status: 503 } });
  const ids = await getAllJqparksIds({ cacheFile: file, fetcher, log: () => {} });
  assert.deepEqual([...ids], ["19000001"]);
  assert.match(ids.listNote, /JQパークス トップ取得失敗: HTTP 503/);
  assert.ok(fs.existsSync(`${file}.failed`));
  const again = await getAllJqparksIds({ cacheFile: file, fetcher, log: () => {} });
  assert.equal(calls.length, 1);                       // 2回目は試さない
  assert.match(again.listNote, /前回の失敗/);
  await assert.rejects(getAllJqparksIds({ cacheFile: path.join(tmpDir("jqparks-"), "jqparks-ids.txt"), fetcher, log: () => {} }), /トップ取得失敗/);
});

test("JQパークスの駅のページが続けて取れなければ途中でやめ、前の一覧と取れた分を合わせて回す（上書きしない）", async () => {
  const dir = tmpDir("jqparks-");
  const file = path.join(dir, "jqparks-ids.txt");
  fs.writeFileSync(file, "18999999\n");
  fs.writeFileSync(`${file}.fetched`, new Date(Date.now() - 8 * 864e5).toISOString());
  const lots = Array.from({ length: 8 }, (_, i) => `<a href="/station/駅${i}">x</a>`).join("");
  const routes = jqRoutes({ [`${JQ}/city/${enc("大分県")}/${enc("大分市")}`]: lots });
  for (let i = 0; i < 8; i++) routes[stationListUrl(`駅${i}`)] = { throw: "ECONNRESET" };
  const { fetcher, calls } = stubFetcher(routes);
  const ids = await getAllJqparksIds({ cacheFile: file, fetcher, log: () => {} });
  assert.equal(calls.filter((u) => u.includes("/s/")).length, 2 + 1 + 5);   // 博多駅の2ページ・大分駅・続けて5回失敗したところでやめる
  assert.ok(ids.includes("18999999"));
  assert.ok(ids.includes("19000001"));
  assert.match(ids.listNote, /取れないページが5回続いた/);
  assert.deepEqual(fs.readFileSync(file, "utf8").split("\n").filter(Boolean), ["18999999"]);
});

test("JQパークスの詳細の記録に、一覧で読んだ座標と時間貸の印を入れる。一覧に無ければ null", () => {
  const html = `<table><tr><td>駐車場名</td><td><img src="/img/spacer.gif"></td><td>JQParks博多駅前4丁目</td></tr>
<tr><td>所在地</td><td>福岡県福岡市博多区博多駅前4-1</td></tr>
<tr><td>時間貸料金<br />(税込)</td><td>全日 8時～20時：30分200円／最大800円</td></tr></table>`;
  const r = parseJqparksDetail(html, { id: "19022140", listMeta: { lat: 33.58346, lng: 130.419944, hourlyOk: true } });
  assert.equal(r.name, "JQParks博多駅前4丁目");
  assert.equal(r.lat, 33.58346);
  assert.equal(r.lng, 130.419944);
  assert.equal(r.hourlyOk, true);
  assert.equal(r.maxFees[0].amountYen, 800);
  const none = parseJqparksDetail(html, { id: "19022140" });
  assert.deepEqual([none.lat, none.lng, none.hourlyOk], [null, null, null]);
  // 月極だけの物件（時間貸料金の行が無い）も記録は作り、印は false のまま
  const monthly = parseJqparksDetail(html.replace(/<tr><td>時間貸料金[\s\S]*?<\/tr>/, ""), { id: "1", listMeta: { lat: 33.1, lng: 130.1, hourlyOk: false } });
  assert.equal(monthly.name, "JQParks博多駅前4丁目");
  assert.equal(monthly.hourlyOk, false);
  assert.deepEqual(monthly.unitCharges, []);
});

test("run.js: JQパークスの記録に一覧の座標・時間貸の印が入る。座標の無い前の記録には1回だけ足す", () => {
  const dir = tmpDir("jqparks-run-");
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  w("data/jqparks-ids.txt", "19022140\n");
  w("data/jqparks-ids.txt.fetched", new Date().toISOString());
  w("data/jqparks-lots.json", JSON.stringify({ 19022140: { lat: 33.58346, lng: 130.419944, hourlyOk: true } }));
  const detail = `<table><tr><td>駐車場名</td><td>JQParks博多駅前4丁目</td></tr><tr><td>所在地</td><td>福岡県福岡市博多区博多駅前4-1</td></tr>
<tr><td>時間貸料金</td><td>全日 8時～20時：30分200円／最大800円</td></tr></table>`;
  // 前の記録（座標なし・料金は同じ）
  const prevRec = parseJqparksDetail(detail, { id: "19022140" });
  w("data/prices-test.jsonl", JSON.stringify({ ...prevRec, fetchedAt: "2026-10-30T00:00:00.000Z" }) + "\n");
  const preload = path.join(dir, "stub.mjs");
  w("stub.mjs", `
import { config } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)};
config.minDelayMs = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/robots.txt")) return new Response("User-agent: *\\nAllow: /\\n", { status: 200 });
  if (u === ${JSON.stringify(`${JQ}/number/19022140`)}) return new Response(${JSON.stringify(detail)}, { status: 200 });
  return new Response("", { status: 404 });
};`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_ONLY: "jqparks", CRAWL_HOLD: "off", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl" },
  });
  assert.equal(p.status, 0, `${p.stdout}\n${p.stderr}`);
  const rows = fs.readFileSync(path.join(dir, "data/prices-test.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);   // 料金は同じでも、座標が新しく読めたので1回だけ足す（record-gap.js）
  assert.deepEqual([rows[1].lat, rows[1].lng, rows[1].hourlyOk], [33.58346, 130.419944, true]);
  assert.equal(rows[1].changedFromPrev, undefined);
});
