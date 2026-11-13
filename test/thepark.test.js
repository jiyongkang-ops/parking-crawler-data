// ザ・パークの料金の読み方（2026-11-08 単価を最大料金にしていた読み違いを直した）。例は dkparking.com の掲示の実物
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parsePrice, parseFeeInfo, parseTheparkPage, listUrl, PARSE_VERSION } from "../src/thepark.js";

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

// ---- 2026-11-13 作り直されたサイト（一覧のページ /proxy/parkings/hourly?number=N）----
const PAGE = fs.readFileSync(new URL("./fixtures/thepark-page.json", import.meta.url), "utf8");   // 実物の1ページから要る欄だけ残したもの
const byId = (id) => parseTheparkPage(PAGE, { label: "ザ・パーク全国" }).records.find((r) => r.parkId === id);
const US = (r) => r.unitCharges.map((u) => `${u.scope} ${u.timeRange} ${u.perMinutes}分${u.amountYen}`);
const MS = (r) => r.maxFees.map((m) => `${m.scope} ${m.condition}=${m.amountYen}`);

test("一覧のページ: 番号は facility_id・座標はそのまま・住所は都道府県からつなぐ", () => {
  const page = parseTheparkPage(PAGE, { label: "ザ・パーク全国" });
  assert.deepEqual([page.listed, page.hidden, page.totalPages, page.total], [7, 0, 437, 4368]);
  const r = byId("SI-00592");
  assert.deepEqual([r.operator, r.name, r.address, r.lat, r.lng, r.capacity, r.openingHours, r.label, r.parseV],
    ["thepark", "鳥取富安２丁目", "鳥取県鳥取市富安2-126", 35.491734, 134.228476, 6, "24時間", "ザ・パーク全国", PARSE_VERSION]);
  assert.equal(r.sourceUrl, "https://www.dkparking.com/hourly/tottori/312011/SI-00592");
  assert.deepEqual(US(r), ["全日 全日 40分100"]);
  assert.deepEqual(MS(r), ["全日 07:00~19:00=1000", "全日 19:00~07:00=800"]);
  assert.equal(byId("SN-09276").openingHours, "07:00-23:00");
  assert.equal(PARSE_VERSION, 3);
  assert.equal(listUrl(3), "https://www.dkparking.com/proxy/parkings/hourly?number=3");
});

test("一覧のページ: 左右の列は曜日の区分。「全日　一般ご利用者」は全日・最大料金「なし」は何も足さない", () => {
  assert.deepEqual(US(byId("SI-08930")), ["月~木・日 08:00-18:00 60分100", "月~木・日 18:00-08:00 60分200", "金・土 08:00-18:00 60分100", "金・土 18:00-08:00 60分200"]);
  assert.deepEqual(MS(byId("SI-08930")), ["月~木・日 08:00~18:00=500", "月~木・日 18:00~08:00=1400", "金・土 08:00~18:00=500", "金・土 18:00~08:00=1800"]);
  assert.deepEqual(MS(byId("ON-08850")), ["平日 24時間=600", "平日 19:00~08:00=100", "土・日・祝 24時間=500", "土・日・祝 19:00~08:00=100"]);
  assert.deepEqual([US(byId("HH-08816")), MS(byId("HH-08816"))], [["全日 全日 15分100"], ["全日 24時間=1100"]]);
  // 前払いの1日料金（「前払式　24時間　600円」）は最大料金
  assert.deepEqual([US(byId("HH-00337")), MS(byId("HH-00337"))], [[], ["全日 前払式 24時間=600"]]);
  assert.deepEqual(MS(byId("KU-09574")), ["全日 24時間=500", "全日 20:00~08:00 12時間=200"]);
  assert.deepEqual(parseFeeInfo(null), { unitCharges: [], maxFees: [] });
});

test("一覧のページ: 閉じた・サイトに出さない・番号の無い物件は記録しない。JSON でなければ null", () => {
  const j = JSON.parse(PAGE);
  j.data[0].close_at = "2026-11-01"; j.data[1].use_in_website = false; j.data[2].facility_id = null; j.data[3].close_at = "2027-03-31";
  const page = parseTheparkPage(j, { today: "2026-11-13" });
  assert.deepEqual([page.listed, page.hidden, page.records.length], [7, 3, 4]);
  assert.equal(parseTheparkPage("<html>404</html>"), null);
  assert.equal(parseTheparkPage("[]"), null);
  assert.deepEqual(parseTheparkPage({ pagination: { total_pages: 437, total_elements: 4368 }, data: [] }).listed, 0);
});
