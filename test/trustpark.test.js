// トラストパーク（トラストナビ tpnavi.com）の読み方（2026-11-27 本人「トラストパークも作って」）。
// 見本は P2550.html（2026-11-27）から読む所だけを残したもの（test/fixtures/trustpark-detail.html）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { parseTrustparkDetail, normalizeTrustFee, detailUrl } from "../src/trustpark.js";
import { parseTrustparkSitemap, SITEMAP_URL } from "../src/trustpark-enumerate.js";
import { parseFeeBlock } from "../src/jp-fee-text.js";
import { runCrawl } from "./run-crawl.js";

const PAGE = fs.readFileSync(new URL("./fixtures/trustpark-detail.html", import.meta.url), "utf8");

test("物件ページ: 名前（頭の【…】を外す）・住所・座標・台数・営業時間・料金", () => {
  const r = parseTrustparkDetail(PAGE, { id: "2550", label: "トラストパーク全国" });
  assert.deepEqual([r.operator, r.parkId, r.name, r.address, r.lat, r.lng, r.capacity, r.openingHours, r.sourceUrl],
    ["trustpark", "2550", "トラストパーク恵比寿3丁目", "東京都渋谷区恵比寿3-39-16", 35.6439950354848, 139.720379944686, 20, "24時間", "http://tpnavi.com/P2550.html"]);
  assert.deepEqual(r.unitCharges, [{ scope: "全日", timeRange: "全日", perMinutes: 20, amountYen: 330 }]);
  assert.deepEqual(r.maxFees.map((m) => `${m.scope} ${m.condition}=${m.amountYen}`), ["全日 7:00-19:00 最大=3100", "全日 19:00-7:00 最大=500"]);
});

test("料金の見出し【時間料金】【長時間サービス料金】を曜日の区分と読まない（共通のパーサに渡す前に直す）", () => {
  // 直さずに渡すと、最大料金の scope が「長時間サービス料金」になる
  assert.equal(parseFeeBlock("【長時間サービス料金】<br>(07:00～19:00)最大3100円").maxFees[0].scope, "長時間サービス料金");
  const r = parseFeeBlock(normalizeTrustFee("【時間料金】<br>30分200円<br>【長時間サービス料金】<br>入庫後24時間最大1,200円<br>※料金や制限事項等につきまして、予告なく変更"));
  assert.deepEqual(r.unitCharges.map((u) => `${u.scope} ${u.perMinutes}分${u.amountYen}`), ["全日 30分200"]);
  assert.deepEqual(r.maxFees.map((m) => `${m.scope} ${m.amountYen}`), ["全日 1200"]);
});

test("sitemap: 物件ページ（P番号.html）だけを拾う（スマホ版・月極・都道府県のページは拾わない）", () => {
  const xml = `<urlset><url><loc>http://tpnavi.com/</loc></url><url><loc>http://tpnavi.com/A40.html</loc></url>
    <url><loc>http://tpnavi.com/P2550.html</loc></url><url><loc>https://tpnavi.com/sp/park/detail.php?qvC=2550</loc></url>
    <url><loc>http://tpnavi.com/P101.html</loc></url><url><loc>https://tpnavi.com/monthly/detail/77</loc></url><url><loc>http://tpnavi.com/P2550.html</loc></url></urlset>`;
  assert.deepEqual(parseTrustparkSitemap(xml), ["101", "2550"]);
});

test("通しの巡回: sitemap から列挙して物件ページを読む（相手先には繋がない）", () => {
  const xml = `<urlset>${["11", "12", "13"].map((i) => `<url><loc>http://tpnavi.com/P${i}.html</loc></url>`).join("")}</urlset>`;
  const routes = { [SITEMAP_URL]: { status: 200, body: xml } };
  for (const i of ["11", "12", "13"]) routes[detailUrl(i)] = { status: 200, body: PAGE.replace("恵比寿3丁目", `テスト${i}`) };
  const r = runCrawl({ env: { CRAWL_ONLY: "trustpark", ROLLING_PER_RUN: "3" }, routes });
  assert.deepEqual(r.pages.filter((u) => u.includes("/P")).sort(), ["11", "12", "13"].map(detailUrl));
  assert.deepEqual([r.health[0].ok, r.health[0].n], [true, 3]);
  assert.deepEqual(r.rows.map((x) => x.name).sort(), ["トラストパークテスト11", "トラストパークテスト12", "トラストパークテスト13"]);
});
