// エコロパークの一覧づくりと閉鎖の見分けのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える）。
// 2026-10-18: エリアページの1ページ目（各10件）しか読まず、全3,945件のうち1,032件しか巡回していなかった。
// また閉じた物件は 301 でトップへ転送され、トップのページを物件として料金が空の行を書いていた。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { parseEcoloDetail, isClosedRedirect } from "../src/ecolo.js";

// 一覧の作り直しは1回の実行で2件までに抑えてあるので、テストでは外す（読み込む前に決める必要がある）
process.env.LIST_REFRESH_MAX = "1000";
const { getAllEcoloIds, parseSitemapIndex, parseIds, hasNextPage } = await import("../src/ecolo-enumerate.js");
config.minDelayMs = 0;   // テストでは待たない

const O = "https://service.ecolocity.co.jp";
const urlset = (ids) => `<urlset>${ids.map((i) => `<url><loc>${O}/park/coin-parking/${i}/</loc><lastmod>2026-10-08</lastmod></url>`).join("")}</urlset>`;
const areaPage = (ids, next) => `<div>${ids.map((i) => `<a href="${O}/park/coin-parking/${i}/">P${i}</a>`).join("")}</div>`
  + (next ? `<li class="c-pager__item -next" rel="next"><a href="?paged=2"> </a></li>` : "");

/** 差し替えた fetch。url → 本文（文字列）または { status, location }。呼ばれた URL を控える */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const r = routes[String(url)] ?? (String(url).endsWith("/robots.txt") ? "" : { status: 404 });
    const body = typeof r === "string" ? r : "";
    const status = typeof r === "string" ? 200 : r.status;
    return { ok: status >= 200 && status < 300, status, text: async () => body,
      headers: { get: (k) => (k.toLowerCase() === "location" && typeof r === "object" ? r.location ?? null : null) } };
  };
  return calls;
}
const tmpList = (lines) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ecolo-"));
  const f = path.join(d, "ecolo-ids.txt");
  if (lines) fs.writeFileSync(f, lines.join("\n") + "\n");   // .fetched が無い＝作り直す時期
  return f;
};

test("サイトマップの索引から時間貸しの束だけを拾う（よそのホストは拾わない）", () => {
  const xml = `<sitemapindex>
    <sitemap><loc>${O}/news-sitemap.xml</loc></sitemap>
    <sitemap><loc>${O}/park_coin-parking-sitemap.xml</loc></sitemap>
    <sitemap><loc>${O}/park_coin-parking-sitemap2.xml</loc></sitemap>
    <sitemap><loc>https://evil.example/park_coin-parking-sitemap3.xml</loc></sitemap>
  </sitemapindex>`;
  assert.deepEqual(parseSitemapIndex(xml), [`${O}/park_coin-parking-sitemap.xml`, `${O}/park_coin-parking-sitemap2.xml`]);
  assert.deepEqual(parseIds(urlset(["10", "23", "10"])), ["10", "23"]);
  assert.equal(hasNextPage(areaPage(["1"], true)), true);
  assert.equal(hasNextPage(areaPage(["1"], false)), false);
});

test("一覧はサイトマップの全件から作る（エリアページの1ページ目10件で止まらない）", async () => {
  const calls = stubFetch({
    [`${O}/sitemap.xml`]: `<loc>${O}/park_coin-parking-sitemap.xml</loc><loc>${O}/park_coin-parking-sitemap2.xml</loc>`,
    [`${O}/park_coin-parking-sitemap.xml`]: urlset(["4", "10", "23"]),
    [`${O}/park_coin-parking-sitemap2.xml`]: urlset(["5563", "10372"]),
  });
  const f = tmpList(["4", "10"]);
  const ids = await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5 });
  assert.deepEqual(ids, ["4", "10", "23", "5563", "10372"]);
  assert.equal(fs.readFileSync(f, "utf8"), "4\n10\n23\n5563\n10372\n");
  assert.ok(fs.existsSync(`${f}.fetched`));
  assert.ok(!calls.some((u) => u.includes("/area/")), "サイトマップが取れたらエリアページは取りに行かない");
});

test("サイトマップが取れないときは、エリアページを次のページまで辿る", async () => {
  const A = `${O}/park/coin-parking/area/%e5%a2%a8%e7%94%b0%e5%8c%ba/`;
  stubFetch({
    [`${O}/sitemap.xml`]: { status: 500 },
    [`${O}/park/coin-parking/`]: `<a href="${A}">墨田区</a>`,
    [A]: areaPage(["294", "444"], true),
    [`${A}?paged=2`]: areaPage(["2120", "2251"], true),
    [`${A}?paged=3`]: areaPage(["4298"], false),
  });
  const ids = await getAllEcoloIds({ cacheFile: tmpList(null), cacheMs: 7 * 864e5 });
  assert.deepEqual(ids, ["294", "444", "2120", "2251", "4298"]);
});

test("取り直した一覧が前回の半分に満たなければ、前の一覧を使い続ける（取得日も進めない）", async () => {
  stubFetch({
    [`${O}/sitemap.xml`]: `<loc>${O}/park_coin-parking-sitemap.xml</loc>`,
    [`${O}/park_coin-parking-sitemap.xml`]: urlset(["1"]),
    [`${O}/park/coin-parking/`]: { status: 503 },
  });
  const prev = ["1", "2", "3", "4"];
  const f = tmpList(prev);
  // 予備のエリアページも取れない → 前の一覧
  assert.deepEqual(await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5 }), prev);
  // 前の一覧も無く、どちらも取れなければ失敗として知らせる（空の一覧で巡回しない）
  stubFetch({ [`${O}/sitemap.xml`]: { status: 500 }, [`${O}/park/coin-parking/`]: { status: 503 } });
  await assert.rejects(getAllEcoloIds({ cacheFile: tmpList(null), cacheMs: 7 * 864e5 }));
  stubFetch({
    [`${O}/sitemap.xml`]: `<loc>${O}/park_coin-parking-sitemap.xml</loc>`,
    [`${O}/park_coin-parking-sitemap.xml`]: urlset(["1"]),
    [`${O}/park/coin-parking/`]: "<p>エリアなし</p>",
  });
  assert.deepEqual(await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5 }), prev);
  assert.equal(fs.readFileSync(f, "utf8"), prev.join("\n") + "\n");
  assert.ok(!fs.existsSync(`${f}.fetched`), "次の回にやり直せるよう、取得日は書かない");
});

test("閉鎖の転送（/ や /park/）だけを閉鎖とみなす", () => {
  assert.equal(isClosedRedirect("/"), true);
  assert.equal(isClosedRedirect("/park/"), true);
  assert.equal(isClosedRedirect(`${O}/`), true);
  assert.equal(isClosedRedirect(`${O}/park/coin-parking/10380/`), false);   // 番号の付け替えは閉鎖にしない
  assert.equal(isClosedRedirect(null), false);
});

test("物件ページでないページ（トップ）からは物件を作らない", () => {
  const top = `<title>コインパーキング・駐車場経営ならエコロパーク</title><h1 class="l-header__logo">コインパーキング・駐車場経営ならエコロパーク</h1>`;
  assert.equal(parseEcoloDetail(top, { id: "9345" }).name, null);
  const detail = `<title>エコロパーク 押上 | エコロパーク</title><h1 class="p-coin-parking-detail__title">エコロパーク 押上駐車場</h1>
    <table class="c-table"><tr><th>台数</th><td>4台</td></tr><tr><th>料金</th><td>全日 昼 8時〜20時 最大 1,000円<br>全日 夜 20時〜8時 最大 300円</td></tr></table>`;
  const r = parseEcoloDetail(detail, { id: "5563" });
  assert.equal(r.name, "エコロパーク 押上駐車場");
  assert.equal(r.capacity, 4);
  assert.equal(r.maxFees.length, 2);
});
