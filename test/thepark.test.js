// ザ・パークの料金の読み方（2026-11-08 単価を最大料金にしていた読み違いを直した）。例は dkparking.com の掲示の実物
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePrice, parseTheparkJson, PARSE_VERSION } from "../src/thepark.js";

const U = (r) => r.unitCharges.map((u) => `${u.timeRange} ${u.perMinutes}分${u.amountYen}`);
const M = (r) => r.maxFees.map((m) => `${m.condition}=${m.amountYen}`);

test("「30分/200円」「30分／200円」は単価。同じ行の最大も落とさない", () => {
  const r = parsePrice("オールタイム30分／200円　入庫後12時間毎最大1,200円　最大料金の繰り返し有り");
  assert.deepEqual(U(r), ["全日 30分200"]);
  assert.deepEqual(M(r), ["入庫後12時間毎=1200"]);
});

test("単価と最大が同じ行（「60分100円夜間最大400円」）", () => {
  const r = parsePrice("18:00～6:00  60分100円夜間最大400円");
  assert.deepEqual(U(r), ["18:00-6:00 60分100"]);
  assert.deepEqual(M(r), ["夜間=400"]);
});

test("全角数字・「100円/90分」の逆順・「24H」", () => {
  assert.deepEqual(U(parsePrice("22：00～8：00　６０分１００円、２４時間最大７００円")), ["22:00-8:00 60分100"]);
  assert.deepEqual(M(parsePrice("22：00～8：00　６０分１００円、２４時間最大７００円")), ["24時間=700"]);
  assert.deepEqual(U(parsePrice("0：00～24：00　100円/90分")), ["0:00-24:00 90分100"]);
  assert.deepEqual(M(parsePrice("前払い・チケット式　24H500円")), ["前払い・チケット式 24時間=500"]);
  assert.deepEqual(M(parsePrice("入庫後24ｈ最大　1,000円")), ["入庫後24時間=1000"]);
});

test("単価の次の行が時間帯だけの掲示は、その時間帯を単価に付ける", () => {
  const r = parsePrice("<br />20分100円<br />8:00~22:00<br />60分100円<br />22:00~8:00<br /><font color=#FF0000>入庫後24時間最大1,000円</font>");
  assert.deepEqual(U(r), ["8:00-22:00 20分100", "22:00-8:00 60分100"]);
  assert.deepEqual(M(r), ["入庫後24時間=1000"]);
});

test("時間帯の最大は今までどおり。単価の時間帯は前の額から持ち越さない", () => {
  const r = parsePrice("8:00~20:00 500円　20:00~8:00 300円  30分/100円");
  assert.deepEqual(M(r), ["8:00~20:00=500", "20:00~8:00=300"]);
  assert.deepEqual(U(r), ["全日 30分100"]);
  assert.deepEqual(M(parsePrice("1日（料金前払い精算）300円")), ["1日(料金前払い精算)=300"]);
});

test("曜日の付いた単価は scope に曜日", () => {
  const r = parsePrice("月～金6:00～18:00  15分100円<br />土・日・祝6:00～18:00 30分100円");
  assert.deepEqual(r.unitCharges.map((u) => u.scope), ["月~金", "土・日・祝"]);
});

test("記録に読み方の版（parseV）を付ける", () => {
  const [r] = parseTheparkJson([{ id: 1, name: "テスト", price: "オールタイム30分/100円", lat: 139.7, lng: 35.6 }]);
  assert.equal(r.parseV, PARSE_VERSION);
  assert.equal(PARSE_VERSION, 2);
});
