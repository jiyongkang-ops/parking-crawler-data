// Dパーキング（大和ハウスパーキング）の読み方（2026-11-27 本人「画面に出ている項目だけ取る」）。
// 見本は元データ（parking.filtered.json）の形（欄ごとに { type, value }）を、2026-11-27 に先頭の数件で確かめて作ったもの。値は作りもの。
// fetch は test/run-crawl.js で差し替える（事業者サイトには繋がない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseDparkingData, hiddenReason, DATA_URL } from "../src/dparking.js";
import { runCrawl } from "./run-crawl.js";

const F = (type, value) => ({ type, value });
const rec = (id, o = {}) => ({
  $id: F("__ID__", String(id)),
  ブランド名: F("DROP_DOWN", "Dﾊﾟｰｷﾝｸﾞ"), ブランド名_その他: F("SINGLE_LINE_TEXT", ""),
  物件名称: F("SINGLE_LINE_TEXT", `テスト${id}丁目第１`),
  地図表示用_所在地: F("SINGLE_LINE_TEXT", `東京都江東区亀戸4-${id}`),
  所在地_都道府県: F("SINGLE_LINE_TEXT", "東京都"), 所在地_市区町村: F("SINGLE_LINE_TEXT", "江東区"),
  緯度: F("NUMBER", "35.6969"), 経度: F("NUMBER", "139.8263"),
  四輪_時間貸: F("NUMBER", "8"), 自動二輪_時間貸: F("NUMBER", "0"),
  収入区分: F("CHECK_BOX", ["直営"]), 論理削除フラグ: F("CHECK_BOX", []),
  開設確定日: F("DATE", "2024-04-01"), 閉鎖日: F("DATE", null),
  // 画面に出さない欄（記録に入らないこと）
  拠点: F("ORGANIZATION_SELECT", [{ code: "x", name: "東京支店" }]), 所在地_謄本地番: F("SINGLE_LINE_TEXT", "1234番5"),
  最新_時間帯料金テーブル: F("SUBTABLE", [{ value: { 最新_時間帯料金_開始: F("TIME", "08:00") } }]),
  最新_最大料金テーブル: F("SUBTABLE", []),
  ...o,
});
const TODAY = "2026-11-27";
const DATA = { generated_at: "2026-10-23T08:45:50Z", source: { base_url: "https://example.invalid", app_id: 1 }, records: [
  rec(1),
  rec(2, { 収入区分: F("CHECK_BOX", ["管理受託（固定＋変動委託）"]), 閉鎖日: F("DATE", "2026-12-31") }),   // 全角のかっこ・閉鎖はまだ先
  rec(3, { ブランド名: F("DROP_DOWN", "その他"), ブランド名_その他: F("SINGLE_LINE_TEXT", "ﾀﾞｲﾜﾊﾟｰｸ"), 四輪_時間貸: F("NUMBER", ""), 自動二輪_時間貸: F("NUMBER", "3") }),
  rec(11, { 四輪_時間貸: F("NUMBER", ""), 物件名称: F("SINGLE_LINE_TEXT", "東小橋2丁目月極駐車場") }),   // 月極だけ
  rec(12, { 収入区分: F("CHECK_BOX", ["保守のみ"]), ブランド名: F("DROP_DOWN", "ﾀｲﾑﾊﾟｰｸ") }),         // 機械の保守だけ
  rec(13, { 論理削除フラグ: F("CHECK_BOX", ["削除"]) }),
  rec(14, { 開設確定日: F("DATE", "2026-12-01") }),
  rec(15, { 閉鎖日: F("DATE", "2026-02-14") }),
  rec(16, { 緯度: F("NUMBER", "0"), 経度: F("NUMBER", "") }),                                          // 位置が無い（記録はする）
] };

test("画面に出る物件だけを、画面に出る項目（名前・住所・位置）だけで記録する", () => {
  const p = parseDparkingData(JSON.stringify(DATA), { today: TODAY });
  assert.equal(p.total, 9);
  assert.deepEqual(p.records.map((r) => r.parkId), ["1", "2", "3", "16"]);
  assert.deepEqual(p.hidden, { 時間貸なし: 1, 収入区分: 1, 削除: 1, 開設前: 1, 閉鎖: 1 });
  const r = p.records[0];
  assert.deepEqual(r, { operator: "dparking", parkId: "1", label: "Dパーキング全国", name: "Dパーキング テスト1丁目第1",
    address: "東京都江東区亀戸4-1", lat: 35.6969, lng: 139.8263, datum: "wgs84", capacity: null, openingHours: null, hourlyOk: true,
    unitCharges: [], maxFees: [], parseV: 1, sourceUrl: "https://www.dh-parking.co.jp/d-parking/parking_list/" });
  // 料金・台数・社内の欄は入らない
  assert.doesNotMatch(JSON.stringify(p.records), /東京支店|1234番5|08:00/);
  assert.equal(p.records[2].name, "ダイワパーク テスト3丁目第1");   // ブランドが「その他」ならその他の欄
  assert.deepEqual([p.records[3].lat, p.records[3].lng], [null, null]);
});

test("ページと同じ決まり: 閉鎖日が今日なら出る・昨日なら出ない。開設確定日が無ければ出ない", () => {
  assert.equal(hiddenReason(rec(1, { 閉鎖日: F("DATE", TODAY) }), TODAY), null);
  assert.equal(hiddenReason(rec(1, { 閉鎖日: F("DATE", "2026-11-26") }), TODAY), "閉鎖");
  assert.equal(hiddenReason(rec(1, { 開設確定日: F("DATE", "") }), TODAY), "開設前");
  assert.equal(parseDparkingData("<html>404</html>"), null);
  assert.equal(parseDparkingData({ foo: 1 }), null);
});

test("通しの巡回: 1回読んだら7日は取りに行かない。物件ごとの記録（一覧型）を書く", () => {
  const routes = { [DATA_URL]: { status: 200, body: JSON.stringify(DATA) } };
  const r = runCrawl({ env: { CRAWL_ONLY: "dparking", CRAWL_TODAY: TODAY }, routes });
  assert.deepEqual(r.pages, [DATA_URL]);
  assert.deepEqual([r.health[0].ok, r.health[0].n], [true, 4]);
  assert.equal(r.rows.length, 4);
  assert.ok(r.rows.every((x) => x.operator === "dparking" && !x.unitCharges.length && x.capacity == null));
  assert.equal(fs.readFileSync(path.join(r.dir, "data/dparking-ids.txt"), "utf8"), "1\n16\n2\n3\n");
  assert.ok(fs.existsSync(path.join(r.dir, "data/dparking-fetched.txt")));
  // 次の回は取りに行かない（health は前の件数で ok）
  const r2 = runCrawl({ env: { CRAWL_ONLY: "dparking" }, dir: r.dir, routes });
  assert.deepEqual(r2.pages, []);
  assert.deepEqual([r2.health[0].ok, r2.health[0].n], [true, 4]);
  assert.match(r2.log, /\[cache\] Dパーキング スキップ/);
  // 取りに行って断られたら知らせる（前の記録はそのまま）
  const r3 = runCrawl({ env: { CRAWL_ONLY: "dparking", PAGE_CACHE_MS: "0" }, dir: r.dir, routes: { [DATA_URL]: { status: 403 } } });
  assert.deepEqual([r3.health[0].ok, r3.health[0].kind], [false, "blocked"]);
  assert.equal(fs.readFileSync(path.join(r.dir, "data/dparking-ids.txt"), "utf8"), "1\n16\n2\n3\n");
});
