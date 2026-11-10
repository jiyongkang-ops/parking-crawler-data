// 三菱地所パークス（Parking NAVI）の読み取り・一覧のたどり方・巡回のテスト（npm test。2026-11-02 追加）。事業者サイトには繋がない。
// 見本は test/fixtures/mecparks/ の実データ（2026-11-01〜02 に取った一覧の customdata の一部・北海道の一覧・東京都の市区の一覧）。
// 2026-11-01 の点検の指摘: 最大料金の曜日は見出し（【昼間最大料金】）ではなく次の行の頭（「月曜～土曜日(祝日除く)」「日曜日・祝日」など
// 11通り以上）に書かれる。そのまま parseFeeBlock に渡すと月～土2,800円と日祝1,000円がどちらも「全日」になり、昼の最大が1,000円と読まれる。
// 単価も「N分」だけでなく「100円 / 1時間」「100円 / 60」（単位なし）「1000円 / 24時間」「1000円 / 1泊」がある
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, runCrawl } from "./run-crawl.js";
import {
  parseMecparksLot, parseMecparksList, parseMecparksFees, parseCustomdata, parseParkingCount, parseCityCodes, parseTownCodes,
  skipReasonOf, normalizeUnitLine, listUrl, areaUrl, detailUrl,
} from "../src/mecparks.js";
import { crawlMecparks, mecparksHealth } from "../src/mecparks-enumerate.js";

const FX = path.join(ROOT, "test/fixtures/mecparks");
const LOTS = JSON.parse(fs.readFileSync(path.join(FX, "lots.json"), "utf8"));
const lot = (pid) => LOTS.find((p) => p.pid === String(pid));
const fees = (pid) => {
  const r = parseMecparksLot(lot(pid));
  return r && { u: r.unitCharges.map((x) => [x.scope, x.timeRange, x.perMinutes, x.amountYen]), m: r.maxFees.map((x) => [x.scope, x.condition, x.amountYen]) };
};
/** 一覧ページの形（customdata と parkingCount）。実際のページと同じく配列の後ろは「;」と改行 */
const listPage = (lots, count = lots.length) => `<html><body><script>\n    var customdata = ${JSON.stringify(lots)};\n    var parkingCount = ${count};\n</script></body></html>`;
const silent = { log() {}, warn() {}, error() {} };

test("最大料金の曜日は行の頭から取る（月～土の昼2,800円と日祝の昼1,000円を取り違えない）", () => {
  // PARKS PARK 千代田区神田紺屋町（鍛冶町の43件のレポートに出る）
  assert.deepEqual(fees(27453), {
    u: [["全日", "8:00-20:00", 15, 300], ["全日", "20:00-8:00", 60, 100]],
    m: [["月曜~土曜日(祝日除く)", "8:00-20:00 最大", 2800], ["日曜日・祝日", "8:00-20:00 最大", 1000], ["全日", "20:00-8:00 最大", 400]],
  });
  // 中央区日本橋室町4丁目は「月曜～土曜日」（祝日除くなし）
  assert.deepEqual(fees(28752).m, [["月曜~土曜日", "8:00-20:00 最大", 3300], ["日曜日・祝日", "8:00-20:00 最大", 1700], ["全日", "20:00-8:00 最大", 500]]);
  // 見出しが【最大料金】でも、行の「4時間最大」が種類。日祝だけの24時間最大は日祝のまま
  assert.deepEqual(fees(29104).m, [["月曜~土曜日", "4時間最大", 2700], ["日曜日・祝日", "24時間最大", 1500]]);
});

test("【当日最大料金】の行に「5時間最大」「24時間最大」「12時間最大」「3時間まで」があれば、そちらを種類にする", () => {
  assert.deepEqual(fees(27051).m, [["月曜~土曜日(祝日除く)", "5時間最大", 2900], ["月曜~土曜日(祝日除く)", "24時間最大", 2500], ["日曜日・祝日", "12時間最大", 1800]]);
  assert.deepEqual(fees(27211).m, [["全日", "3時間以内", 1700]]);   // normalize.js・studio-index.mjs が「入庫後3時間」と読む形
  // 時間帯が無い当日最大は「当日最大」（24時間相当）。時間帯つき（0:00～24:00）も当日最大のまま
  assert.deepEqual(fees(26735).m, [["月~金(祝日除く)", "当日最大", 1300], ["土日祝", "当日最大", 2000]]);   // 宿泊者だけの料金は入れない
  assert.deepEqual(fees(27198).m[0], ["月曜~土曜日(祝日除く)", "当日最大 0:00~24:00", 4200]);
});

// studio-index.mjs（分析リポジトリ）の bandOf・bands・dmax のうち、ここで確かめる決まりだけを書き写したもの（2026-11-02 時点）。
// 「当日」「24時間」を含めば24時間相当（full）、時間帯だけなら始まり17時以降か終わり9時までで夜、ほかは昼。
// 平日に効く上限を採り（無いときだけ休日の上限）、同じ帯では低い方。full が無ければ昼＋夜
const bandOf = (m) => { const t = `${m.scope}${m.condition}`.normalize("NFKC");
  if (/24時間|当日/.test(t)) return "full";
  const r = t.match(/(\d{1,2}):\d{2}\s*[-~]\s*(\d{1,2}):\d{2}/); return r ? (+r[1] >= 17 || +r[2] <= 9 ? "night" : "day") : null; };
const offDay = (m) => /特定日/.test(m.scope) || (/土|日曜|日祝|祝|休日/.test(m.scope) && !/全日|平日|月/.test(m.scope));
const dmaxOf = (r) => { const pick = (b) => { const c = r.maxFees.filter((m) => bandOf(m) === b); const w = c.filter((m) => !offDay(m)); const u = w.length ? w : c;
  return u.length ? Math.min(...u.map((m) => m.amountYen)) : null; };
  const full = pick("full"), day = pick("day"), night = pick("night"); return full ?? (day && night ? day + night : null); };

test("【当日最大料金】【24時間最大料金】の行が1日の一部だけの時間帯なら、その時間帯の上限として読む（夜間最大と足して dmax）", () => {
  // PARKS PARK 江東区森下3丁目第3: 当日 8:00～20:00 1,900円＋夜間 20:00～8:00 500円 → 2,400円（前は当日最大1,900円だけ）
  assert.deepEqual(fees(26948).m, [["全日", "8:00-20:00 最大", 1900], ["全日", "20:00-8:00 最大", 500]]);
  assert.equal(dmaxOf(parseMecparksLot(lot(26948))), 2400);
  // PEN新潟市中央区東大通1丁目: 当日 7:00～19:00 800円＋夜間 19:00～7:00 1,000円 → 1,800円（前は800円）
  assert.deepEqual(fees(27504).m, [["全日", "7:00-19:00 最大", 800], ["全日", "19:00-7:00 最大", 1000]]);
  assert.equal(dmaxOf(parseMecparksLot(lot(27504))), 1800);
  // PEN横浜市中区山下町: 月～金だけ【当日最大料金】、土日祝は【昼間最大料金】。平日の昼1,300円＋夜400円 → 1,700円
  assert.deepEqual(fees(27458).m, [["月~金(祝日除く)", "8:00-24:00 最大", 1300], ["土日祝", "8:00-24:00 最大", 2000], ["全日", "24:00-8:00 最大", 400]]);
  assert.equal(dmaxOf(parseMecparksLot(lot(27458))), 1700);
  // 0:00～24:00（1日全部）は当日最大のまま（港区南青山7丁目。平日は4,200円）
  assert.deepEqual(fees(27198).m[0], ["月曜~土曜日(祝日除く)", "当日最大 0:00~24:00", 4200]);
  assert.equal(dmaxOf(parseMecparksLot(lot(27198))), 4200);
  // 24時間営業でない物件で、時間帯が営業時間（bhours「6:30～23:00」）と同じなら、営業中ずっとの上限なので当日最大のまま
  assert.deepEqual(fees(28471).m, [["月~金(祝日除く)", "当日最大 6:30~23:00", 1200]]);
  assert.equal(dmaxOf(parseMecparksLot(lot(28471))), 1200);
  // 【24時間最大料金】の行に時間帯（日比谷シティパーキング「全日 7：00～23：00」。施設）も同じ決まり
  const hibiya = lot(26658);
  assert.deepEqual(parseMecparksFees(hibiya.time, hibiya.timem).maxFees, [{ scope: "全日", condition: "7:00-23:00 最大", amountYen: 2400 }]);
  assert.deepEqual(parseMecparksFees(hibiya.time, hibiya.timem, { hours: hibiya.bhours }).maxFees,   // 営業時間 7：00～23：00 と同じ
    [{ scope: "全日", condition: "24時間最大 7:00~23:00", amountYen: 2400 }]);
});

test("行の頭の曜日が「(月-土)」（かっこ付き・ハイフン）や「駐車場指定日」でも区分に入れる", () => {
  // PARKS PARK 台東区橋場1丁目: 【24時間最大料金】(月-土) 1,900円・日祝 800円
  assert.deepEqual(fees(28814).m, [["月~土", "24時間最大", 1900], ["日祝", "24時間最大", 800], ["全日", "20:00-8:00 最大", 300]]);
  assert.equal(dmaxOf(parseMecparksLot(lot(28814))), 1900);
  // PARKS PARK 桂ガーデンプラザ: 「駐車場指定日 2500円」は特定日（休日の上限として、平日の上限に混ぜない）
  assert.deepEqual(fees(28739).m, [["全日", "24時間最大", 1500], ["特定日", "24時間最大", 2500], ["全日", "19:00-7:00 最大", 500]]);
  assert.equal(offDay({ scope: "特定日" }), true);
  assert.equal(offDay({ scope: "月~土" }), false);
});

test("昼間・夜間・N時間の見出しと時間帯（「24時-8時最大」「22時～8時」を含む）", () => {
  assert.deepEqual(fees(27192).m, [["全日", "24時間最大", 1500], ["全日", "24:00-8:00 最大", 400]]);
  assert.deepEqual(fees(27167).m, [["全日", "22:00-8:00 最大", 300]]);
  assert.deepEqual(fees(27220).m, [["全日", "12時間最大", 2900], ["全日", "22:00-8:00 最大", 500]]);
  // 【12時間最大料金】でも時間帯が書いてあれば、その時間帯の上限（夜300円・昼1,000円）
  assert.deepEqual(fees(26890).m, [["全日", "20:00-8:00 最大", 300], ["全日", "8:00-20:00 最大", 1000]]);
  // 時間帯の無い【夜間最大料金】は「夜間最大」
  assert.deepEqual(fees(29057).m, [["全日", "夜間最大", 500]]);
});

test("車室ごとの上限は区分を変えずに両方残し、小型車の区画だけの上限・特定日は平日の上限に混ぜない", () => {
  assert.deepEqual(fees(27436), {
    u: [["全日", "全日", 12, 400]],
    m: [["月曜~土曜日(祝日除く)", "8:00-20:00 最大", 3400], ["月曜~土曜日(祝日除く)", "8:00-20:00 最大", 3200],
      ["日曜日・祝日", "8:00-20:00 最大", 1000], ["全日", "20:00-8:00 最大", 500]],
  });
  assert.deepEqual(fees(28520).m, [["月~金(祝日除く)", "24時間最大", 800], ["土日祝", "4時間最大", 1000]]);   // 小型車・軽の区画の700円・900円は入れない
  // 特定日は区分を「特定日」だけにする（「7～8月」の「月」で平日の区分と読まれないように）
  assert.deepEqual(fees(28638).m, [["月~金(祝日除く)", "24時間最大", 600], ["土日祝", "24時間最大", 800], ["特定日", "24時間最大 7~8月", 2000]]);
});

test("単価: 曜日の見出し・「100円 / 1時間」「100円 / 60」（単位なしは分）・【昼間】【夜間】は時間帯の見出し", () => {
  assert.deepEqual(fees(28416).u, [["月~金(祝日除く)", "全日", 30, 200], ["土日祝", "全日", 60, 200]]);
  assert.deepEqual(fees(2109).u, [["全日", "全日", 60, 100]]);
  assert.deepEqual(fees(29057).u, [["全日", "8:00-20:00", 30, 200], ["全日", "20:00-8:00", 60, 100]]);
  assert.deepEqual(fees(27051).u, [["全日", "8:00-22:00", 15, 400], ["全日", "22:00-8:00", 60, 100]]);
  // 並べ替えの単体: 最初だけの料金・泊まり・駐輪場の上限・1日単位は単価にしない
  assert.equal(normalizeUnitLine("8:00～20:00 300円 / 15分"), "8:00～20:00 15分300円");
  assert.equal(normalizeUnitLine("以降、 300円 / 30分"), "30分300円");
  assert.equal(normalizeUnitLine("23：00～翌7：00 100円 / 120分"), "23：00～7：00 120分100円");
  assert.equal(normalizeUnitLine("最初の 1時間 600円"), null);
  assert.equal(normalizeUnitLine("宿泊駐車利用 1000円 / 1泊"), null);
  assert.equal(normalizeUnitLine("10時間まで 150円"), null);
  assert.equal(normalizeUnitLine("1000円 / 24時間"), null);
  assert.equal(normalizeUnitLine("24時間 200円"), null);
});

test("記録しない物件: バイク・駐輪場・（月極）・時間料金の文が無い・1日単位の料金だけ", () => {
  assert.equal(skipReasonOf(lot(26658)), null);    // 日比谷シティパーキング（ptype=1。施設も記録する。2026-11-02 本人指示）
  assert.equal(skipReasonOf(lot(2108)), "バイク");
  assert.equal(skipReasonOf(lot(26591)), "駐輪場");
  assert.equal(skipReasonOf(lot(27275)), "月極");
  assert.equal(skipReasonOf({ ptype: "3", pname: "PARKS PARK 近日OPEN" }), "近日オープン");
  for (const pid of [2108, 26591, 27275]) assert.equal(parseMecparksLot(lot(pid)), null);
  assert.equal(parseMecparksLot(lot(26658))?.name, "日比谷シティパーキング");   // 施設も記録する
  assert.equal(parseMecparksLot(lot(28722)), null);   // 時間料金の文が空（最大料金だけ）
  assert.equal(parseMecparksLot(lot(29058)), null);   // 同上
  assert.equal(parseMecparksLot(lot(28655)), null);   // 「1000円 / 24時間」だけ
  // 記録する物件の形
  const r = parseMecparksLot(lot(27453), { label: "三菱地所パークス全国" });
  assert.deepEqual({ ...r, unitCharges: undefined, maxFees: undefined }, {
    operator: "mecparks", parkId: "27453", label: "三菱地所パークス全国", name: "PARKS PARK 千代田区神田紺屋町",
    address: "東京都千代田区神田紺屋町37", lat: 35.69281524209459, lng: 139.77384087915664, capacity: null, openingHours: null,
    unitCharges: undefined, maxFees: undefined, sourceUrl: "https://parkingnavi.jp/details.php?parking_id=27453&page=time",
  });
  assert.equal(parseMecparksLot(lot(26735)).openingHours, "7：00～22：00");
});

test("一覧ページ: customdata と件数を読み、記録しない物件は理由ごとに数える（北海道の実ページ）", () => {
  const html = fs.readFileSync(path.join(FX, "list-pref1.html"), "utf8");
  assert.equal(parseParkingCount(html), 6);
  assert.equal(parseCustomdata(html).length, 6);
  const r = parseMecparksList(html);
  assert.deepEqual([r.rows, r.count, r.broken, r.skipped], [6, 6, false, {}]);
  assert.deepEqual(r.records.map((x) => x.parkId).sort(), ["192", "26735", "26995", "27374", "28514", "28647"]);
  // 作りが変わって customdata が無いときは broken
  assert.deepEqual(parseMecparksList("<html>作りが変わった</html>").broken, true);
  // 東京都の市区の一覧（50市区）と町丁のリンク
  const area = fs.readFileSync(path.join(FX, "area-pref13.html"), "utf8");
  const cities = parseCityCodes(area, 13);
  assert.equal(cities.length, 50);
  assert.ok(cities.includes("131016") && cities.includes("131199"));
  assert.deepEqual(parseTownCodes('<a href="/search_result.php?type=1&area=13&city=131016&town=131010001">', 13, 131016), ["131010001"]);
  assert.equal(listUrl(13, { city: "131016" }), "https://parkingnavi.jp/search_result.php?type=1&area=13&city=131016");
  assert.equal(areaUrl(13), "https://parkingnavi.jp/area.php?type=time&pref=13");
  assert.equal(detailUrl(27453), "https://parkingnavi.jp/details.php?parking_id=27453&page=time");
});

test("一覧のたどり方: 100件で頭打ちの都道府県は市区ごと、市区も頭打ちなら町丁ごと。番号で重複を除く", async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...lot(27453), pid: String(900000 + i) }));
  const pages = {
    [listUrl(1)]: listPage([lot(27453), lot(26658)]),
    [listUrl(13)]: listPage(many, 100),
    [areaUrl(13)]: '<a href="/area.php?type=time&pref=13&city=131016">千代田区</a><a href="/area.php?type=time&pref=13&city=131024">中央区</a>',
    [listUrl(13, { city: "131016" })]: listPage([lot(27453), lot(29104)]),          // 27453 は北海道の一覧と重複（番号で除く）
    [listUrl(13, { city: "131024" })]: listPage(many, 100),                          // 市区でも頭打ち → 町丁
    [areaUrl(13, "131024")]: '<a href="/search_result.php?type=1&area=13&city=131024&town=1">x</a>',
    [listUrl(13, { city: "131024", town: "1" })]: listPage([lot(28752)]),
  };
  const asked = [];
  const got = [];
  const sum = await crawlMecparks({ prefs: [1, 13, 14], log: silent, onRecord: (r) => got.push(r.parkId),
    fetchPage: async (url) => { asked.push(url); return pages[url] ? { ok: true, status: 200, html: pages[url] } : { ok: false, status: 404, html: "" }; } });
  assert.deepEqual(got, ["27453", "26658", "29104", "28752"]);
  assert.deepEqual([sum.count, sum.pages, sum.rows, sum.skipped], [4, 7, 5, {}]);
  assert.deepEqual(sum.failures.map((f) => f.where), ["都道府県14"]);   // 取れなかったページは飛ばして続ける
  assert.equal(asked.length, 8);
  const h = mecparksHealth(sum);
  assert.deepEqual([h.ok, h.n, h.reason], [true, 4, "取れなかったページ1"]);
});

test("一覧のたどり方: robots.txt で断られたら打ち切り、customdata が読めないページは読めなかったページに数える", async () => {
  const blocked = await crawlMecparks({ prefs: [1, 2, 3], log: silent,
    fetchPage: async () => ({ ok: false, blocked: true, status: 403, skippedReason: "robots.txt が HTTP 403（断られている）" }) });
  assert.deepEqual([blocked.pages, blocked.stopKind], [0, "blocked"]);
  assert.deepEqual(mecparksHealth(blocked).ok, false);
  const broken = await crawlMecparks({ prefs: [1, 2], log: silent, fetchPage: async () => ({ ok: true, status: 200, html: "<html></html>" }) });
  assert.deepEqual([broken.count, broken.broken], [0, ["都道府県1", "都道府県2"]]);
  assert.deepEqual([mecparksHealth(broken).ok, mecparksHealth(broken).reason], [false, "0件"]);
});

test("通しの巡回（CRAWL_ONLY=mecparks）: 全国の一覧を取り、記録と health を書く", () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...lot(27453), pid: String(900000 + i) }));
  const routes = {
    "*robots": { status: 200, body: "User-agent: BUbiNG\nDisallow: /\n\nUser-agent: dotbot\nDisallow: /\n" },
    "*": { status: 200, body: listPage([]) },
    [listUrl(1)]: { status: 200, body: fs.readFileSync(path.join(FX, "list-pref1.html"), "utf8") },
    [listUrl(13)]: { status: 200, body: listPage(many, 100) },
    [areaUrl(13)]: { status: 200, body: fs.readFileSync(path.join(FX, "area-pref13.html"), "utf8") },
    [listUrl(13, { city: "131016" })]: { status: 200, body: listPage([lot(27453), lot(26658), lot(28722)]) },
  };
  const r = runCrawl({ env: { CRAWL_ONLY: "mecparks" }, routes });
  // 一覧（47 ＋ 東京都の市区の一覧1 ＋ 市区50）のあとに、記録した8件の台数を詳細ページで読む（2026-11-10。src/detail-caps.js）
  const details = r.pages.filter((u) => u.includes("/details.php?"));
  assert.equal(r.pages.length - details.length, 47 + 1 + 50);
  assert.equal(details.length, 8);
  assert.deepEqual(r.rows.map((x) => x.parkId).sort(), ["192", "26658", "26735", "26995", "27374", "27453", "28514", "28647"]);
  assert.ok(r.rows.every((x) => x.operator === "mecparks" && x.fetchedAt && x.label === "三菱地所パークス全国"));
  const h = r.health[0];
  assert.deepEqual([h.op, h.label, h.ok, h.n, h.reason, h.statusCounts], ["mecparks", "三菱地所パークス", true, 8, null, { 200: 98 }]);
  assert.deepEqual(h.skipped, { 料金なし: 1 });
  // robots.txt が 403 なら一覧は取りに行かない（メンテナンスを確かめる入口の1回だけ）
  const b = runCrawl({ env: { CRAWL_ONLY: "mecparks" }, routes: { "*robots": { status: 403 } } });
  assert.deepEqual([b.health[0].ok, b.health[0].kind], [false, "blocked"]);
  assert.deepEqual(b.pages, ["https://parkingnavi.jp/search_result.php?type=1&area=1"]);
});

test("登録: 設定・巡回のワークフロー・メンテナンスの入口に載っている", async () => {
  const { config } = await import("../config.js");
  assert.ok(config.targets.some((t) => t.operator === "mecparks" && t.mode === "nationwide"));
  const wf = fs.readFileSync(path.join(ROOT, ".github/workflows/crawl-extra2.yml"), "utf8");
  assert.match(wf, /CRAWL_ONLY: "[^"]*\bmecparks\b[^"]*"/);
  const { entryOf } = await import("../src/maintenance.js");
  assert.equal(entryOf("mecparks"), "https://parkingnavi.jp/search_result.php?type=1&area=1");
  // 料金の文の並べ替えは parseFeeBlock に渡す前だけ（ほかの社の読み方は変えていない）
  assert.deepEqual(parseMecparksFees("", ""), { unitCharges: [], maxFees: [] });
});
