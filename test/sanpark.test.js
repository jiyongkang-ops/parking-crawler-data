// SANパーク（sanpark.jp）の読み取り・一覧づくり・巡回のテスト（npm test。2026-11-02 追加）。事業者サイトには繋がない。
// 見本は test/fixtures/sanpark/ の実ページ（2026-11-01〜02 に取った物件ページ16件・武蔵野市と江東区の一覧・東京都の市区の選択肢。
// 物件の表・一覧の表の所だけを残した）。
// 2026-11-01 の点検の指摘: 1つの td に【月-土】【日祝】【全日】が並ぶので【の前で分ける。名前は「SANパーク」＋空白を除いた名前
// （Parkopedia と同じ形）で、「ECO〜」はそのまま・「マンスリー〜」は記録しない。「12時間最大」は24時間相当の最大にならない
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, runCrawl } from "./run-crawl.js";

// 一覧の作り直しの回数の上限（cache-age.js が読み込むときに読む）を外してから読み込む
process.env.LIST_REFRESH_MAX = "1000";
const { parseSanparkDetail, parseSanparkList, parseCityOptions, sanparkName, skipReasonOfName, sanparkFeeLines, sanparkScope,
  cityOptionsUrl, cityListUrl, detailUrl } = await import("../src/sanpark.js");
const { getAllSanparkIds } = await import("../src/sanpark-enumerate.js");

const FX = path.join(ROOT, "test/fixtures/sanpark");
const page = (city, num) => fs.readFileSync(path.join(FX, `detail-${city}-${num}.html`), "utf8");
const parse = (city, num) => parseSanparkDetail(page(city, num), { id: `${city}/${num}` });
const fees = (city, num) => {
  const r = parse(city, num);
  return { u: r.unitCharges.map((x) => [x.scope, x.timeRange, x.perMinutes, x.amountYen]), m: r.maxFees.map((x) => [x.scope, x.condition, x.amountYen]) };
};
const silent = { log() {}, warn() {}, error() {} };

test("物件ページ: 曜日ごとの最大料金（【月-土】【日祝】【全日】）を区分に分け、名前は「SANパーク」＋空白を除いた名前", () => {
  const r = parse("56fa1b050e088", "459");   // 東池袋　2（レポートに出る物件）
  assert.deepEqual({ ...r, unitCharges: undefined, maxFees: undefined }, {
    operator: "sanpark", parkId: "56fa1b050e088/459", label: null, name: "SANパーク東池袋2", address: "豊島区東池袋2-9-8",
    lat: 35.730872, lng: 139.723908, capacity: 6, openingHours: null, unitCharges: undefined, maxFees: undefined,
    sourceUrl: "https://sanpark.jp/search/56fa1b050e088/459/",
  });
  assert.deepEqual(fees("56fa1b050e088", "459"), {
    u: [["全日", "全日", 30, 300]],
    m: [["月-土", "12時間最大", 1900], ["日祝", "12時間最大", 1000], ["全日", "19:00-8:00 最大", 400]],
  });
  assert.deepEqual(fees("56efd69bb7b61", "1393").m, [["月~土", "24時間最大", 2500], ["日祝", "当日最大", 1500], ["全日", "17:00-8:00 最大", 600]]);
});

test("物件ページ: 見出しの無い項目が空白で続く形（「24時間最大1100円 夜間(19時～9時)最大450円」）は金額の後ろで分ける", () => {
  assert.deepEqual(fees("56fa1b050ef39", "1734").m, [["全日", "24時間最大", 1100], ["全日", "19:00-9:00 最大", 450]]);
  // 分けないと「3時間最大1800円」に後ろの夜間の時間帯が付き、夜間の上限1,800円と読まれていた
  assert.deepEqual(fees("56fa7ea81986b", "896").m, [["全日", "3時間最大", 1800], ["全日", "21:00-7:00 最大", 600]]);
  assert.deepEqual(fees("56fa1b050e088", "1916").m, [["全日", "8:00-18:00 最大", 2000], ["全日", "18:00-8:00 最大", 400]]);
  assert.deepEqual(fees("56fa7ea81b30b", "488").m, [["全日", "12時間最大", 1700], ["全日", "20:00-8:00 最大", 500]]);
  // 単価も時間帯ごとに分ける（「8時～21時 25分220円 21時～8時 60分110円」）
  assert.deepEqual(fees("56fa1b050ef39", "736").u, [["全日", "8:00-21:00", 25, 220], ["全日", "21:00-8:00", 60, 110]]);
  // 見出しの後ろに見出しの無い項目が続くときは、前の見出しの区分を引き継ぐ（parseFeeBlock と同じ読み方）
  assert.deepEqual(fees("56fa1b050e088", "1854").m, [["月~土", "24時間最大", 2700], ["日祝", "24時間最大", 1400], ["日祝", "19:00-8:00 最大", 500]]);
});

test("物件ページ: 平日と土日祝で単価も違う物件・車室ごとの上限・【車】【自転車】の見出し", () => {
  assert.deepEqual(fees("56efd69bb7b61", "2760"), {
    u: [["月-金", "全日", 20, 300], ["土日祝", "全日", 10, 900]],
    m: [["月-金", "8:00-18:00 最大", 3500], ["土日祝", "8:00-18:00 最大", 9000], ["全日", "18:00-8:00 最大", 500]],
  });
  // 【月～土1.3番】【月～土2番】は曜日だけを区分に残す（同じ帯の上限は低い方が効く）
  assert.deepEqual(fees("56efd69bb7b61", "2645").m, [["月~土", "当日最大", 1980], ["月~土", "当日最大", 1870], ["日祝", "当日最大", 1000], ["全日", "20:00-8:00 最大", 330]]);
  assert.deepEqual(fees("56fa7ea816b76", "464").m, [["全日", "24時間最大", 1700], ["全日", "24時間最大", 1400], ["全日", "20:00-8:00 最大", 500]]);
  // 【車】は全日、【自転車】（8時間50円）は入れない
  assert.deepEqual(fees("56efd69bb7b61", "1384"), { u: [["全日", "全日", 30, 300]], m: [["全日", "24時間最大", 1900], ["全日", "18:00-8:00 最大", 500]] });
  assert.equal(parse("56efd69bb7b61", "1384").capacity, 9);   // 「車:9台 自転車:44台 バイク:6台」の車
  assert.equal(sanparkScope("自転車"), null);
  assert.equal(sanparkScope("1-3番車室"), "全日");
  assert.equal(sanparkScope("月‐金"), "月-金");
  assert.deepEqual(sanparkFeeLines("24時間600円夜間（17時～8時）300円"), ["【全日】24時間600円", "【全日】夜間（17時~8時）300円"]);
});

test("記録しない物件: 時間料金の無い物件（月極だけ）・1日単位の料金だけ（ECO）・マンスリー・近日オープン", () => {
  assert.deepEqual(parse("56fa7ea81986b", "1761"), { skip: "時間料金なし", name: "ホワイトジュエルＫパーキング" });
  assert.deepEqual(parse("56fa7ea81b30b", "1582"), { skip: "1日単位の料金だけ", name: "ECO武蔵野吉祥寺北町 1" });
  const monthly = page("56fa1b050e088", "459").replace(/東池袋　2/g, "マンスリー巣鴨　1");
  assert.deepEqual(parseSanparkDetail(monthly, { id: "x/1" }).skip, "月極");
  const soon = page("56fa1b050e088", "459").replace('<div class="search_detail clearfix">', '<p>近日OPEN</p><div class="search_detail clearfix">');
  assert.deepEqual(parseSanparkDetail(soon, { id: "x/1" }).skip, "近日オープン");
  assert.equal(parseSanparkDetail("<html>作りが変わった</html>", { id: "x/1" }), null);   // 名前が読めない（run.js が数える）
  assert.equal(skipReasonOfName("マンスリー武蔵野境 1"), "月極");
  assert.equal(skipReasonOfName("武蔵野境 2"), null);
});

test("名前: ECO〜と自分の名前を持つ物件はそのまま、ほかは「SANパーク」＋名前（Parkopedia の「SANパーク東池袋2」と同じ形）", () => {
  assert.equal(sanparkName("東池袋　2"), "SANパーク東池袋2");
  assert.equal(sanparkName("武蔵野中町 3"), "SANパーク武蔵野中町3");
  assert.equal(sanparkName("ECO武蔵野吉祥寺北町 1"), "ECO武蔵野吉祥寺北町1");
  assert.equal(sanparkName("ホワイトジュエルＫパーキング"), "ホワイトジュエルKパーキング");
  assert.equal(parse("56fa7ea816b76", "403").name, "システムパーク中野松ヶ丘1");
  assert.equal(parse("56fa7ea81b30b", "1900").name, "SANパーク武蔵野中町3");
});

test("一覧: 市区の選択肢（中央区だけ /search/tokyo/chuo/ の形）と、市区の一覧の番号・名前・座標・該当件数", () => {
  const cities = parseCityOptions(fs.readFileSync(path.join(FX, "select-city-tokyo.html"), "utf8"));
  assert.equal(cities.length, 44);
  assert.deepEqual(cities.slice(0, 3), ["tokyo/chuo", "58e45c328faed", "56fa7ea820c11"]);
  const m = parseSanparkList(fs.readFileSync(path.join(FX, "list-musashino.html"), "utf8"));
  assert.deepEqual([m.total, m.rows.length], [30, 30]);
  assert.deepEqual(m.rows[0], { id: "56fa7ea81b30b/1582", name: "ECO武蔵野吉祥寺北町 1", address: "武蔵野市吉祥寺北町3-14-20", lat: 35.718094, lng: 139.576074 });
  assert.equal(m.rows.filter((r) => skipReasonOfName(r.name) === "月極").length, 3);
  const k = parseSanparkList(fs.readFileSync(path.join(FX, "list-koto.html"), "utf8"));
  assert.deepEqual([k.total, k.rows.length], [14, 14]);
  assert.equal(cityListUrl("56fa7ea81b30b"), "https://sanpark.jp/search/56fa7ea81b30b/?chk%5Bcount_car%5D%5Bmin%5D=1");
  assert.equal(cityOptionsUrl("tokyo"), "https://sanpark.jp/lib/search_park/select_city.html$/area/tokyo/");
  assert.equal(detailUrl("56fa1b050e088/459"), "https://sanpark.jp/search/56fa1b050e088/459/");
});

test("一覧づくり: マンスリーを外して番号を並べ、取れなかった市区は前の一覧の番号を残す。robots.txt で断られたら例外", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sanpark-"));
  const cacheFile = path.join(dir, "sanpark-ids.txt");
  fs.writeFileSync(cacheFile, ["56fa1b050e088/459", "56fa1b050e088/1916", "56fa7ea81b30b/9999"].join("\n") + "\n");
  const tokyo = fs.readFileSync(path.join(FX, "select-city-tokyo.html"), "utf8");
  const pages = {
    [cityOptionsUrl("tokyo")]: tokyo,
    [cityListUrl("56fa7ea81b30b")]: fs.readFileSync(path.join(FX, "list-musashino.html"), "utf8"),
    [cityListUrl("56efd69bb7b61")]: fs.readFileSync(path.join(FX, "list-koto.html"), "utf8"),
  };
  const fetchPage = async (url) => {
    if (url === cityListUrl("56fa1b050e088")) return { ok: false, status: 500, html: "" };   // 豊島区だけ取れない
    if (pages[url]) return { ok: true, status: 200, html: pages[url] };
    if (url.includes("select_city")) return { ok: true, status: 200, html: '<select><option value="">市区を選択してください</option><option value="/search/zz1/">x</option></select>' };
    return { ok: true, status: 200, html: "<html>該当件数 0 件<table></table></html>" };
  };
  const ids = await getAllSanparkIds({ cacheFile, fetchPage, log: silent });
  // 武蔵野30件−マンスリー3件、江東14件−マンスリー1件、豊島区は前の一覧の2件を残す（武蔵野の 9999 は今の一覧に無いので消える）
  assert.equal(ids.length, 27 + 13 + 2);
  assert.ok(ids.includes("56fa1b050e088/459") && ids.includes("56fa7ea81b30b/1900") && !ids.includes("56fa7ea81b30b/9999"));
  assert.ok(!ids.includes("56fa7ea81b30b/2082"));   // マンスリー武蔵野西久保 1
  assert.match(ids.listNote, /市区1件が取れなかった。その分は前の一覧の番号2件を残した/);
  assert.deepEqual(fs.readFileSync(cacheFile, "utf8").split("\n").filter(Boolean), [...ids]);
  await assert.rejects(getAllSanparkIds({ log: silent, fetchPage: async () => ({ ok: false, blocked: true, status: 403, skippedReason: "robots.txt が HTTP 403（断られている）" }) }),
    /SANパーク 市区の選択肢: robots\.txt が HTTP 403/);
});

test("通しの巡回（CRAWL_ONLY=sanpark）: 物件ページを取り、時間料金の無い物件は記録せずに日付だけ進める", () => {
  const ids = ["56fa1b050e088/459", "56fa7ea81986b/1761", "56fa7ea81b30b/1582"];
  const routes = { "*robots": { status: 404 } };
  for (const id of ids) routes[detailUrl(id)] = { status: 200, body: page(...id.split("/")) };
  const r = runCrawl({ env: { CRAWL_ONLY: "sanpark" }, routes,
    files: { "data/sanpark-ids.txt": ids.join("\n") + "\n", "data/sanpark-ids.txt.fetched": new Date().toISOString() } });
  assert.deepEqual(r.pages.sort(), ids.map(detailUrl).sort());
  assert.deepEqual(r.rows.map((x) => [x.operator, x.parkId, x.name]), [["sanpark", "56fa1b050e088/459", "SANパーク東池袋2"]]);
  const state = JSON.parse(fs.readFileSync(path.join(r.dir, "data/sanpark-crawl-state.json"), "utf8"));
  for (const id of ids) assert.match(String(state[id]), /^\d{4}-\d{2}-\d{2}T/);   // 記録しない物件も取りに行った日は進む
  const h = r.health[0];
  assert.deepEqual([h.op, h.label, h.ok, h.n, h.tried, h.noName, h.skipped], ["sanpark", "SANパーク", true, 1, 3, 0, 2]);
  assert.match(r.log, /\[skip\] 56fa7ea81986b\/1761: 時間料金なし/);
});

test("登録: 設定（1回250件）・巡回のワークフロー・メンテナンスの入口に載っている", async () => {
  const { config } = await import("../config.js");
  assert.ok(config.targets.some((t) => t.operator === "sanpark" && t.mode === "nationwide"));
  assert.equal(config.sanparkRollingPerRun, 250);
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/crawl-extra2.yml"), "utf8");
  assert.match(wf, /CRAWL_ONLY: "[^"]*\bsanpark\b[^"]*"/);
  const { entryOf } = await import("../src/maintenance.js");
  assert.equal(entryOf("sanpark"), "https://sanpark.jp/");
});
