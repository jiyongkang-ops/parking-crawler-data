// ユアー・パーキング（2026-11-02 追加）のテスト（npm test）。事業者サイトには繋がない。
// fixtures は 2026-11-01〜02 に節度ある取得（当社の UA・4秒以上の間隔）で保存した、公式の地図の画面が読む JSON そのもの。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";
import { parseYparkDetail, normalizeFee, capacityOf, detailUrl, pageUrl } from "../src/ypark.js";
import { parseYparkList, getAllYparkIds, LIST_URL } from "../src/ypark-enumerate.js";
import { _resetRobotsCache } from "../src/polite-fetch.js";

config.minDelayMs = 0;   // テストでは待たない
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FX = path.join(ROOT, "test/fixtures/ypark");
const fx = (f) => fs.readFileSync(path.join(FX, f), "utf8");
const detail = (id) => parseYparkDetail(fx(`setparkinfo-${id}.json`), { id });
const offDay = (m) => /土|日曜|日祝|祝|休日/.test(m.scope ?? "") && !/全日|平日|月/.test(m.scope ?? "");   // studio-index.mjs と同じ

test("一覧: 地図の getallpoint（日本全体）632件。近日OPEN予定2件・長期貸切1件を外して629件", () => {
  const raw = JSON.parse(fx("getallpoint.json"));
  assert.equal(raw.length, 632);
  const { ids, excluded } = parseYparkList(fx("getallpoint.json"));
  assert.equal(ids.length, 629);
  assert.deepEqual(excluded.map((x) => [x.id, x.name]).sort(), [["11357", "六本木第4"], ["11545", "西大井第3"], ["11554", "北区岸町第1"]]);
  assert.match(excluded.find((x) => x.id === "11357").why, /長期貸切/);
  assert.ok(ids.includes("11337") && ids.includes("10880"));
  assert.equal(parseYparkList("<html>作りが変わった</html>"), null);
  assert.equal(parseYparkList('{"err":"x"}'), null);
});

/** fetch を差し替える（このプロセスの中だけ）。url → 本文か { status }。呼んだ URL を控える */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const r = routes[u] ?? { status: 404 };   // waxds.com の robots.txt は 404（制限なし）
    const body = typeof r === "string" ? r : r.body ?? "";
    const status = typeof r === "string" ? 200 : r.status;
    return { ok: status >= 200 && status < 300, status, text: async () => body, headers: { get: () => null } };
  };
  return calls;
}

test("一覧の作り直し: 読むのは getallpoint の1回だけ（updatecenter などの管理用は呼ばない）。取得日を付ける", async () => {
  _resetRobotsCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ypark-"));
  const cacheFile = path.join(dir, "ypark-ids.txt");
  const calls = stubFetch({ [LIST_URL]: fx("getallpoint.json") });
  const ids = await getAllYparkIds({ cacheFile });
  assert.equal(ids.length, 629);
  assert.deepEqual(calls, ["https://www.waxds.com/robots.txt", LIST_URL]);
  assert.match(LIST_URL, /^https:\/\/www\.waxds\.com\/ypark\/mapc\.php\?crud=getallpoint&/);
  assert.ok(fs.existsSync(`${cacheFile}.fetched`));
  // 1週間は作り直さない
  const again = stubFetch({});
  assert.equal((await getAllYparkIds({ cacheFile })).length, 629);
  assert.deepEqual(again, []);
});

test("一覧の作り直し: 急に半分未満になったら前の一覧で回す（staleReason）。JSON でなければ例外", async () => {
  _resetRobotsCache();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ypark-"));
  const cacheFile = path.join(dir, "ypark-ids.txt");
  fs.writeFileSync(cacheFile, Array.from({ length: 629 }, (_, i) => String(10000 + i)).join("\n") + "\n");
  const few = JSON.stringify(JSON.parse(fx("getallpoint.json")).slice(0, 10));
  stubFetch({ [LIST_URL]: few });
  const ids = await getAllYparkIds({ cacheFile });
  assert.equal(ids.length, 629);
  assert.match(ids.staleReason, /一覧が10件しか取れなかった（前回629件）/);
  _resetRobotsCache();
  stubFetch({ [LIST_URL]: "<html>Not Found</html>" });
  await assert.rejects(getAllYparkIds({ cacheFile: path.join(dir, "other.txt") }), /JSON の配列ではない/);
});

test("詳細: 新橋第3（オールタイム12分300円・月ー土と日・祝で昼の上限が違う・全日の夜間）。名前に社名を付ける", () => {
  const r = detail(11337);
  assert.equal(r.operator, "ypark");
  assert.equal(r.parkId, "11337");
  assert.equal(r.name, "ユアー・パーキング新橋第3");
  assert.equal(r.address, "東京都港区新橋4-27-6");
  assert.equal(r.capacity, 2);
  assert.equal(r.openingHours, "無休");
  assert.ok(Math.abs(r.lat - 35.6641204) < 1e-6 && Math.abs(r.lng - 139.7548706) < 1e-6);
  assert.equal(r.sourceUrl, pageUrl(11337));
  assert.equal(detailUrl(11337), "https://www.waxds.com/ypark/parkinfoc.php?crud=setparkinfo&id=11337");
  assert.deepEqual(r.unitCharges, [{ scope: "全日", timeRange: "全日", perMinutes: 12, amountYen: 300 }]);
  assert.deepEqual(r.maxFees, [
    { scope: "月~土", condition: "8:00-20:00 最大", amountYen: 3500 },
    { scope: "日・祝", condition: "8:00-20:00 最大", amountYen: 1200 },
    { scope: "全日", condition: "20:00-8:00 最大", amountYen: 500 },
  ]);
  assert.deepEqual(r.maxFees.map(offDay), [false, true, false]);   // 日・祝の安い上限を平日の上限にしない
});

test("詳細: 曜日の書き方（日祝・日 祝・月-土）と、曜日の付いた行のあとの曜日の無い行は全日（亀岡駅前第1）", () => {
  assert.deepEqual(detail(10880).maxFees.map((m) => [m.scope, m.amountYen]), [["月~土", 3000], ["日祝", 1200], ["全日", 400]]);
  assert.deepEqual(detail(10374).maxFees.map((m) => [m.scope, m.condition, m.amountYen]),
    [["月~土", "8:00-21:00 最大", 3200], ["日祝", "8:00-21:00 最大", 1000], ["全日", "21:00-8:00 最大", 400]]);
  const k = detail(11112);
  // 単価は【平日】【土日祝】の見出しの下に並ぶ
  assert.deepEqual(k.unitCharges.map((u) => [u.scope, u.timeRange, u.perMinutes, u.amountYen]), [
    ["平日", "8:00-20:00", 60, 200], ["平日", "20:00-8:00", 60, 100], ["土日祝", "8:00-20:00", 40, 200], ["土日祝", "20:00-8:00", 60, 100]]);
  // 「夜間最大（20時-08時の間）300円」には曜日が無い。前の行の「土日祝：」を持ち越さない
  assert.deepEqual(k.maxFees.map((m) => [m.scope, m.amountYen]), [["月~金", 500], ["土日祝", 1000], ["全日", 300]]);
});

test("詳細: 時間帯ごとの単価と昼・夜の上限（佃・八丁堀・飯田橋・横浜・千葉・静岡）", () => {
  const r = detail(10394);
  assert.deepEqual(r.unitCharges, [
    { scope: "全日", timeRange: "8:00-20:00", perMinutes: 20, amountYen: 300 },
    { scope: "全日", timeRange: "20:00-8:00", perMinutes: 60, amountYen: 100 },
  ]);
  assert.deepEqual(r.maxFees, [
    { scope: "全日", condition: "8:00-20:00 最大", amountYen: 3000 },
    { scope: "全日", condition: "20:00-8:00 最大", amountYen: 400 },
  ]);
  // 「10分200円」（斜線なし）
  assert.deepEqual(detail(10626).unitCharges[0], { scope: "全日", timeRange: "8:00-21:00", perMinutes: 10, amountYen: 200 });
  for (const id of [10382, 10739, 10755, 10370, 10744, 10937, 11407]) {
    const x = detail(id);
    assert.equal(x.unitCharges.length, 2, `${id}`);
    assert.ok(x.maxFees.some((m) => /^8:00-/.test(m.condition)) && x.maxFees.some((m) => /-8:00 最大$/.test(m.condition)), `${id}`);
  }
});

test("詳細: 入庫後24時間・当日の上限（日向町第1・つくば・FDC）、平日と土日祝で違う24時間の上限", () => {
  assert.deepEqual(detail(11406).maxFees, [
    { scope: "月~金", condition: "入庫から24時間以内最大", amountYen: 500 },
    { scope: "土日祝", condition: "入庫から24時間以内最大", amountYen: 300 },
  ]);
  assert.deepEqual(detail(11075).maxFees, [{ scope: "全日", condition: "入庫から24時間以内最大", amountYen: 500 }]);
  assert.deepEqual(detail(10266).maxFees, [{ scope: "全日", condition: "入庫当日最大", amountYen: 600 }]);
  assert.equal(detail(10266).capacity, 50);
  assert.deepEqual(detail(10498).maxFees.map((m) => [m.scope, m.amountYen]), [["月~土", 4200], ["日祝", 1800], ["全日", 5000]]);
});

test("詳細: 車室ごとの昼の上限（業平第1）は昼の上限として持つ。化けた「～」（青葉六本木ビルディング）は時間帯として読む", () => {
  const n = detail(11272);
  assert.equal(n.capacity, 6);   // 「6\n※車室№6 軽専用」
  assert.deepEqual(n.maxFees, [
    { scope: "全日", condition: "8:00-20:00 最大", amountYen: 1500 },
    { scope: "全日", condition: "8:00-20:00 最大", amountYen: 1300 },
    { scope: "全日", condition: "20:00-8:00 最大", amountYen: 300 },
  ]);
  const a = detail(10836);
  assert.equal(a.capacity, 4);   // 「4台」
  assert.deepEqual(a.unitCharges, [{ scope: "全日", timeRange: "8:00-23:00", perMinutes: 30, amountYen: 400 }]);
  assert.deepEqual(a.maxFees, [
    { scope: "全日", condition: "8:00-23:00 最大", amountYen: 3000 },
    { scope: "全日", condition: "夜間最大（一泊）", amountYen: 800 },
  ]);
});

test("詳細: 記録しない物件（近日OPEN・長期貸切・時間貸しの単価が無い・駐輪場）。err は読めない、名前が無ければ null", () => {
  const base = JSON.parse(fx("setparkinfo-11337.json"));
  const p = (o) => parseYparkDetail(JSON.stringify({ ...base, ...o }), { id: 1 });
  assert.match(p({ a7: "近日OPEN予定！" }).skip, /まだ時間貸しをしていない/);
  assert.match(p({ a7: "長期貸切\n2026年4月1日?9月30日まで" }).skip, /まだ時間貸しをしていない/);
  assert.match(p({ a8: "【月極】<br>月額 33,000円" }).skip, /時間貸しの料金が無い/);
  assert.match(p({ a8: "" }).skip, /時間貸しの料金が無い/);
  assert.match(p({ name: "新橋バイク駐車場" }).skip, /駐輪場・バイク/);
  assert.throws(() => p({ err: "not found" }), /err: not found/);
  assert.equal(p({ name: "" }), null);
  assert.equal(p({ name: "ユアー・パーキング新橋第3" }).name, "ユアー・パーキング新橋第3");   // 社名を重ねない
});

test("料金の整え方: 行頭の曜日を見出しに、注記の行はそのまま（parseFeeBlock が飛ばす）", () => {
  assert.equal(normalizeFee("月ー土：昼間最大（08時-20時の間）3,500円<br>土日祝：入庫後 24時間最大 300円"),
    "【月~土】昼間最大（08時-20時の間）3,500円<br>【土日祝】入庫後 24時間最大 300円");
  assert.equal(normalizeFee("全　日：夜間最大（20時-08時の間）500円"), "【全日】夜間最大（20時-08時の間）500円");
  assert.equal(normalizeFee("日中最大（08時-20時の間）1,000円"), "日中最大（08時-20時の間）1,000円");   // 「日中」は曜日ではない
  assert.equal(capacityOf("5\n"), 5);
  assert.equal(capacityOf("近日OPEN予定"), null);
});
