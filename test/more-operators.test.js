// 2026-11-27 本人「作れるものは全部作って」で足した8社の読み方。見本（test/fixtures/more/）は 2026-11-27 に東京から取った
// 本物のページから、読む所だけを残したもの。fetch は test/run-crawl.js で差し替える（事業者サイトには繋がない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { runCrawl } from "./run-crawl.js";
import { tidyFee, feeFromLines, linesOf, latLngOf, scopeOf } from "../src/fee-rows.js";
import { parseCoinparkDetail, parseCoinparkSitemap, parsePostSitemaps, SITEMAP_INDEX } from "../src/coinpark.js";
import { parseParkjapanList, parseParkjapanDetail, LIST_URL as PJ_LIST, detailUrl as pjUrl } from "../src/parkjapan.js";
import { parseFruitDetail, parseFruitSitemap, SITEMAP_URL as FRUIT_SM, detailUrl as fruitUrl } from "../src/fruitpark.js";
import { parseIzumiDetail, SITEMAP_URL as IZUMI_SM } from "../src/izumipark.js";
import { parseTobuDetail, parseTobuSitemap, SITEMAP_URL as TOBU_SM, detailUrl as tobuUrl } from "../src/tobupark.js";
import { parseYoursDetail, parseYoursList, listUrl as yoursList, detailUrl as yoursUrl } from "../src/yourspark.js";
import { parseKeiseiDetail, parseKeiseiSitemap, SITEMAP_URL as KEISEI_SM } from "../src/keiseipark.js";
import { parsePark1stDetail, parseIndex, parseAreaList, INDEX_URL as P1_INDEX } from "../src/park1st.js";

const fx = (n) => fs.readFileSync(new URL(`./fixtures/more/${n}`, import.meta.url), "utf8");
const units = (r) => r.unitCharges.map((u) => `${u.scope} ${u.timeRange} ${u.perMinutes}分${u.amountYen}`);
const maxes = (r) => r.maxFees.map((m) => `${m.scope} ${m.condition}=${m.amountYen}`);
const head = (r) => [r.operator, r.parkId, r.name, r.address, r.lat, r.lng, r.capacity];

test("料金の文の寄せ方: 金額が先・「翌」・「以降N分毎」・「8-19時」・行だけの曜日の区分・「最大」の入った行", () => {
  assert.equal(tidyFee("8:00～20:00 200円/30分"), "8:00~20:00 30分200円");
  assert.equal(tidyFee("夜時間(18:00～翌8:00）最大料金300円"), "夜時間(18:00~8:00)最大料金300円");
  assert.equal(tidyFee("最初の60分 400円 以降30分毎 200円"), "60分400円 30分 200円");
  assert.equal(tidyFee("昼間（8-19時）"), "昼間(8:00-19:00)");
  assert.equal(tidyFee("24時間最大 900円"), "24時間最大 900円");   // 「24時間」は時間帯にしない
  assert.equal(scopeOf("【月～金】"), "月~金");
  assert.equal(scopeOf("日 祝"), "日祝");
  const r = feeFromLines(linesOf("月-金<br />8:00～22:00 200円/30分<br /><span>最大料金5時間1,000円</span><br />土日祝<br />8:00～22:00 200円/20分"));
  assert.deepEqual(units(r), ["月~金 8:00-22:00 30分200", "土日祝 8:00-22:00 20分200"]);
  assert.deepEqual(maxes(r), ["月~金 最大料金5時間=1000"]);   // 「5時間1,000円」を5時間ごとの単価と読まない
  assert.deepEqual(latLngOf('<iframe src="https://maps.google.co.jp/maps?ll=35.6,139.7&amp;q=35.6,139.7">'), { lat: 35.6, lng: 139.7 });
  assert.deepEqual(latLngOf('<iframe src="https://maps.google.co.jp/maps?ll=,&amp;q=,">'), { lat: null, lng: null });
});

test("コインパーク: 管理番号・名前・住所・本文の地図の位置（左の一覧の位置ではない）・車の台数・曜日ごとの料金", () => {
  const a = parseCoinparkDetail(fx("coinpark-a3635.html"), { url: "https://www.coinpark.info/x/" });
  assert.deepEqual(head(a), ["coinpark", "A-3635", "コインパーク西片2丁目", "東京都文京区西片2-11-9隣", 35.715597877068, 139.75636922331, 5]);
  assert.deepEqual(units(a), ["全日 0:00-24:00 20分200"]);
  assert.deepEqual(maxes(a), ["全日 駐車後24時間毎=1700", "全日 18:00-7:00 最大=400"]);
  const b = parseCoinparkDetail(fx("coinpark-b3612.html"), { url: "https://www.coinpark.info/y/" });
  assert.equal(b.name, "AURA PARKING本所4丁目第2");
  assert.deepEqual(maxes(b), ["月~土 8:00-18:00 最大=1700", "月~土 18:00-8:00 最大=300", "日祝 8:00-18:00 最大=1300", "日祝 18:00-8:00 最大=300"]);
  // sitemap: 物件ページ（1つの部分の URL）だけ
  assert.deepEqual(parsePostSitemaps("<sitemapindex><sitemap><loc>https://www.coinpark.info/wp-sitemap-posts-post-1.xml</loc></sitemap><sitemap><loc>https://www.coinpark.info/wp-sitemap-posts-page-1.xml</loc></sitemap></sitemapindex>"),
    ["https://www.coinpark.info/wp-sitemap-posts-post-1.xml"]);
  assert.deepEqual(parseCoinparkSitemap("<urlset><url><loc>https://www.coinpark.info/%e3%81%82/</loc></url><url><loc>https://www.coinpark.info/parking/tokyo/</loc></url></urlset>"),
    ["https://www.coinpark.info/%e3%81%82/"]);
});

test("パークジャパン: 位置は一覧の地図から・詳細は「月-金」「土日祝」の区分と最大料金", () => {
  const list = parseParkjapanList(fx("parkjapan-list.html"));
  assert.ok(list.length >= 3);
  assert.ok(list.every((x) => /^\d{7}$/.test(x.id)));
  assert.ok(list.filter((x) => x.lat).every((x) => x.lat > 30 && x.lng > 130));
  const r = parseParkjapanDetail(fx("parkjapan-1001532.html"), { id: "1001532", listMeta: { lat: 35.0015, lng: 135.7663 } });
  assert.deepEqual(head(r), ["parkjapan", "1001532", "パークジャパン 京都下京丸屋町第1", "京都府京都市下京区丸屋町429", 35.0015, 135.7663, 3]);
  assert.deepEqual(units(r), ["月~金 8:00-22:00 30分200", "月~金 22:00-8:00 60分100", "土日祝 8:00-22:00 20分200", "土日祝 22:00-8:00 60分100"]);
  assert.deepEqual(maxes(r), ["月~金 22:00-8:00 最大=400", "月~金 最大料金5時間=1000", "土日祝 22:00-8:00 最大=400", "土日祝 最大料金5時間=1200"]);
  assert.equal(r.sourceUrl, "https://www.parkjapan.com/search/parkinginfo1_1001532.html");   // parkinginfo_… は 404
  const s = parseParkjapanDetail(fx("parkjapan-1000021.html"), { id: "1000021" });
  assert.deepEqual([units(s), maxes(s)], [["全日 全日 30分200"], ["全日 20:00-8:00 最大=300", "全日 最大料金24時間=1200"]]);
});

test("フルーツパーク: 1行に2つの組・昼間最大は同じ行の時間帯・年末年始などの特別な日は読まない", () => {
  const r = parseFruitDetail(fx("fruitpark-parking.html"), { id: "parking" });
  assert.deepEqual(head(r), ["fruitpark", "parking", "フルーツパーク京都神明町", "京都市上京区御前通今出川上る三丁目神明町", 35.0344650018101, 135.73590589750907, 2]);
  assert.deepEqual(units(r), ["全日 8:00-19:00 60分220", "全日 19:00-8:00 60分110"]);
  assert.deepEqual(maxes(r), ["全日 8:00-19:00 最大=550", "全日 19:00-8:00 最大=220"]);
  const s = parseFruitDetail(fx("fruitpark-269.html"), { id: "parking-269" });
  assert.deepEqual(units(s), ["平日 8:00-20:00 30分200", "土日祝 8:00-20:00 30分300", "全日 20:00-8:00 60分100"]);
  assert.deepEqual(maxes(s), ["平日 12時間ごと最大=600"]);
  assert.deepEqual(parseFruitSitemap("<urlset><url><loc>https://www.fruit-parking.jp/coin/parking-2</loc></url><url><loc>https://www.fruit-parking.jp/coin/541</loc></url><url><loc>https://www.fruit-parking.jp/maps</loc></url></urlset>"),
    ["parking-2", "541"]);
});

test("いずみパーキング: 時間料金と打切りの欄・月極の物件は記録しない", () => {
  const url = "https://ssparking.co.jp/detail/%e3%81%84%e3%81%9a%e3%81%bf/";
  const r = parseIzumiDetail(fx("izumi-fujigaoka3.html"), { url });
  assert.deepEqual(head(r), ["izumipark", "いずみ", "いずみパーキング藤が丘第3", "名古屋市名東区藤見が丘63", 35.18125006166661, 137.02212474308396, 4]);
  assert.deepEqual(units(r), ["全日 全日 30分200"]);
  assert.deepEqual(maxes(r), ["全日 24時間打切り 最大=700", "全日 18:00-9:00 最大=400"]);
  assert.match(parseIzumiDetail(fx("izumi-septon.html"), { url }).skip, /月極/);
});

test("TOBU PARK: 金額が先の書き方・月極だけと駐輪場は記録しない", () => {
  const r = parseTobuDetail(fx("tobu-2232.html"), { id: "2232" });
  assert.deepEqual(head(r), ["tobupark", "2232", "TOBU PARK小金井本町住宅駐車場", "東京都小金井市本町4‐8‐15", 35.70814567636, 139.50198396561, 5]);
  assert.deepEqual(units(r), ["全日 8:00-20:00 30分200", "全日 20:00-8:00 60分100"]);
  assert.deepEqual(maxes(r), ["全日 24時間最大=900", "全日 20:00-8:00 最大=400"]);
  assert.match(parseTobuDetail(fx("tobu-863.html"), { id: "863" }).skip, /月極/);
  assert.match(parseTobuDetail(fx("tobu-1084.html"), { id: "1084" }).skip, /駐輪場/);
  assert.deepEqual(parseTobuSitemap(`<urlset><url><loc><![CDATA[https://www.tobu-re-parking.jp/parking/1084.html]]></loc></url><url><loc><![CDATA[https://www.tobu-re-parking.jp/parking/867.html]]></loc></url></urlset>`), ["867", "1084"]);
});

test("ユアーズパーキング: 名前に社名を付ける・料金は最初の空行まで・地図の埋め込みの位置", () => {
  const r = parseYoursDetail(fx("yours-438.html"), { id: "438" });
  assert.deepEqual(head(r), ["yourspark", "438", "ユアーズ・パーキング茅ヶ崎第2", "神奈川県茅ヶ崎市本宿町1-42", 35.33913898064324, 139.43432885323588, 6]);
  assert.deepEqual(units(r), ["全日 全日 30分200"]);
  assert.deepEqual(maxes(r), ["全日 24時間最大料金=600", "全日 18:00-8:00 最大=300"]);
  const l = parseYoursList(fx("yours-list.html"));
  assert.deepEqual([l.ids.slice(0, 2), l.lastPage], [["438", "437"], 13]);
});

test("京成パーク: 時間帯ごとの単価と「最大料金（繰り返し適用）」の欄・地図が My Maps のときは位置なし", () => {
  const url = "https://www.keisei-park.com/car/carhourly/carhourly-chiba/narashino/carhourly-narashino02.html";
  const r = parseKeiseiDetail(fx("keisei-narashino02.html"), { url });
  assert.deepEqual(head(r), ["keiseipark", "carhourly-narashino02", "京成パーク津田沼7丁目", "千葉県習志野市津田沼7丁目2-14", 35.678905799999995, 140.01810519999998, 6]);
  assert.deepEqual(units(r), ["全日 8:00-20:00 30分200", "全日 20:00-8:00 60分100"]);
  assert.deepEqual(maxes(r), ["全日 24時間最大=900", "全日 20:00-8:00 最大=300"]);
  const m = parseKeiseiDetail(fx("keisei-matsudo14.html"), { url });
  assert.deepEqual([m.name, m.lat, m.lng, m.capacity], ["エスピーパーク五香", null, null, 13]);
  assert.deepEqual(parseKeiseiSitemap(`<urlset><url><loc>${url}</loc></url>
    <url><loc>https://www.keisei-park.com/motorbike/motorhourly/motorhourly-chiba/funabashi/carhourly-funabashi05.html</loc></url>
    <url><loc>https://www.keisei-park.com/car/carmonthly/carmonthly-tokyo/taito/carhourly-toito04.html</loc></url>
    <url><loc>https://www.keisei-park.com/car/carhourly/carhourly-chiba/yachiyo/</loc></url></urlset>`), [url]);
});

test("Park1st.: 見出しの行と値の行の組・定期券は読まない・「最初の60分」「以降30分毎」", () => {
  const url = "https://park1st.jp/system/Parkings/detail/79/1/1/%E5%A4%A7%E9%98%AA%E5%BA%9C/x/y";
  const r = parsePark1stDetail(fx("park1st-79.html"), { url });
  assert.deepEqual(head(r), ["park1st", "79", "野田阪神ウイステ駐車場", "大阪府大阪市福島区海老江1の1の23", 34.69521, 135.47581, 560]);
  assert.deepEqual(units(r), ["全日 全日 60分400", "全日 全日 30分200"]);
  assert.deepEqual(maxes(r), ["全日 当日最大=1000"]);
  assert.equal(parseIndex(fx("park1st-index.html")).length, 3);
  assert.equal(parseAreaList(fx("park1st-list.html")).length, 1);
});

test("通しの巡回: 8社とも一覧から物件ページを読み、記録しない物件（月極・駐輪場）は skip（相手先には繋がない）", () => {
  const cpUrl = "https://www.coinpark.info/%e3%81%82/", izUrl = "https://ssparking.co.jp/detail/%e3%81%84/";
  const ksUrl = "https://www.keisei-park.com/car/carhourly/carhourly-chiba/narashino/carhourly-narashino02.html";
  const p1Area = parseIndex(fx("park1st-index.html"))[0];
  const p1Url = parseAreaList(fx("park1st-list.html"))[0];
  const pjIds = parseParkjapanList(fx("parkjapan-list.html")).map((x) => x.id);
  const ok = (body) => ({ status: 200, body });
  const routes = {
    [SITEMAP_INDEX]: ok("<sitemapindex><sitemap><loc>https://www.coinpark.info/wp-sitemap-posts-post-1.xml</loc></sitemap></sitemapindex>"),
    "https://www.coinpark.info/wp-sitemap-posts-post-1.xml": ok(`<urlset><url><loc>${cpUrl}</loc></url></urlset>`),
    [cpUrl]: ok(fx("coinpark-a3635.html")),
    [PJ_LIST]: ok(fx("parkjapan-list.html")),
    ...Object.fromEntries(pjIds.map((id) => [pjUrl(id), ok(fx("parkjapan-1000021.html"))])),
    [TOBU_SM]: ok(`<urlset><url><loc><![CDATA[${tobuUrl("2232")}]]></loc></url><url><loc><![CDATA[${tobuUrl("863")}]]></loc></url></urlset>`),
    [tobuUrl("2232")]: ok(fx("tobu-2232.html")), [tobuUrl("863")]: ok(fx("tobu-863.html")),
    [FRUIT_SM]: ok(`<urlset><url><loc>${fruitUrl("parking")}</loc></url></urlset>`), [fruitUrl("parking")]: ok(fx("fruitpark-parking.html")),
    [IZUMI_SM]: ok(`<urlset><url><loc>${izUrl}</loc></url></urlset>`), [izUrl]: ok(fx("izumi-fujigaoka3.html")),
    [yoursList(0)]: ok(`<a href="./case_detail438.html">x</a>`), [yoursUrl("438")]: ok(fx("yours-438.html")),
    [KEISEI_SM]: ok(`<urlset><url><loc>${ksUrl}</loc></url></urlset>`), [ksUrl]: ok(fx("keisei-narashino02.html")),
    [P1_INDEX]: ok(fx("park1st-index.html")), [p1Area]: ok(fx("park1st-list.html")), [p1Url]: ok(fx("park1st-79.html")),
  };
  for (const a of parseIndex(fx("park1st-index.html")).slice(1)) routes[a] = ok("<p>なし</p>");
  const ops = "coinpark,parkjapan,tobupark,fruitpark,izumipark,yourspark,keiseipark,park1st";
  const r = runCrawl({ env: { CRAWL_ONLY: ops, ROLLING_PER_RUN: "10" }, routes });
  const byOp = Object.fromEntries(r.health.map((h) => [h.op, h]));
  for (const op of ops.split(",")) assert.equal(byOp[op]?.ok, true, `${op}: ${byOp[op]?.reason}`);
  assert.deepEqual(ops.split(",").map((op) => byOp[op].n), [1, pjIds.length, 1, 1, 1, 1, 1, 1]);   // TOBU の月極（863）は記録しない
  const ops2 = [...new Set(r.rows.map((x) => x.operator))].sort();
  assert.deepEqual(ops2, ops.split(",").sort());
  assert.ok(r.rows.every((x) => x.name && (x.unitCharges.length || x.maxFees.length)));
  // パークジャパンの位置は一覧の地図から詳細の記録に渡る
  assert.ok(r.rows.filter((x) => x.operator === "parkjapan").some((x) => x.lat > 30 && x.lng > 130));
});
