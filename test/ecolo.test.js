// エコロパークの一覧づくりと閉鎖の見分けのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える）。
// 2026-10-18: エリアページの1ページ目（各10件）しか読まず、全3,945件のうち1,032件しか巡回していなかった。
// また閉じた物件は 301 でトップへ転送され、トップのページを物件として料金が空の行を書いていた。
// 2026-10-19 の最終点検: サイトマップが取れないとき、エリアページを辿る予備の道で数百回送る作りだった → 予備の道を消し、
// 前の一覧を使い続けて20時間は作り直しを試さない（ナビパークと同じ形）。閉鎖とみなす転送を「/」と「/park/」だけにした。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { parseEcoloDetail, isClosedRedirect } from "../src/ecolo.js";

// 一覧の作り直しは1回の実行で2件までに抑えてあるので、テストでは外す（読み込む前に決める必要がある）
process.env.LIST_REFRESH_MAX = "1000";
const { getAllEcoloIds, parseSitemapIndex, parseIds } = await import("../src/ecolo-enumerate.js");
config.minDelayMs = 0;   // テストでは待たない

const O = "https://service.ecolocity.co.jp";
const urlset = (ids) => `<urlset>${ids.map((i) => `<url><loc>${O}/park/coin-parking/${i}/</loc><lastmod>2026-10-08</lastmod></url>`).join("")}</urlset>`;

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
const tmpList = (lines, fetchedAt) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ecolo-"));
  const f = path.join(d, "ecolo-ids.txt");
  if (lines) fs.writeFileSync(f, lines.join("\n") + "\n");   // .fetched が無い＝作り直す時期
  if (fetchedAt) fs.writeFileSync(`${f}.fetched`, fetchedAt);
  return f;
};
const daysAgo = (d) => new Date(Date.now() - d * 864e5).toISOString();
/** 差し替えた取得（polite-fetch の代わり）。url → 応答。呼ばれた URL を控える */
function fakeFetcher(answer) {
  const calls = [];
  const fetcher = async (url) => { calls.push(url); return answer(url); };
  return { fetcher, calls };
}
const SITE = {
  [`${O}/sitemap.xml`]: `<loc>${O}/park_coin-parking-sitemap.xml</loc>`,
  [`${O}/park_coin-parking-sitemap.xml`]: urlset(["1", "2", "3", "4", "5"]),
};
const okSite = (url) => (SITE[url] != null ? { ok: true, status: 200, html: SITE[url] } : { ok: false, status: 404, html: "" });

test("サイトマップの索引から時間貸しの束だけを拾う（よそのホストは拾わない）", () => {
  const xml = `<sitemapindex>
    <sitemap><loc>${O}/news-sitemap.xml</loc></sitemap>
    <sitemap><loc>${O}/park_coin-parking-sitemap.xml</loc></sitemap>
    <sitemap><loc>${O}/park_coin-parking-sitemap2.xml</loc></sitemap>
    <sitemap><loc>https://evil.example/park_coin-parking-sitemap3.xml</loc></sitemap>
  </sitemapindex>`;
  assert.deepEqual(parseSitemapIndex(xml), [`${O}/park_coin-parking-sitemap.xml`, `${O}/park_coin-parking-sitemap2.xml`]);
  assert.deepEqual(parseIds(urlset(["10", "23", "10"])), ["10", "23"]);
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

// 401・403・429・5xx・robots.txt で見送り・通信の失敗。どれも別の経路（エリアページ）は探さない
const DOWN = [
  ["401", () => ({ ok: false, status: 401, html: "" }), /サイトマップ: HTTP 401/],
  ["403", () => ({ ok: false, status: 403, html: "" }), /サイトマップ: HTTP 403/],
  ["429", () => ({ ok: false, status: 429, html: "" }), /サイトマップ: HTTP 429/],
  ["503", () => ({ ok: false, status: 503, html: "" }), /サイトマップ: HTTP 503/],
  ["robots.txt で見送り", () => ({ ok: false, status: null, html: "", skippedReason: "robots.txt に届かない（相手先の障害の可能性）", transient: true, robotsError: "HTTP 503" }),
    /サイトマップ: robots\.txt に届かない（相手先の障害の可能性）（HTTP 503）/],
  ["通信の失敗", () => { throw new Error("fetch failed（ECONNRESET）"); }, /fetch failed（ECONNRESET）/],
];

test("サイトマップが取れないときは、エリアページを辿らずに前の一覧を使い、失敗の時刻と理由を .failed に残す（取得日は進めない）", async () => {
  for (const [name, answer, why] of DOWN) {
    const prev = ["1", "2", "3"];
    const fetchedAt = daysAgo(8);
    const f = tmpList(prev, fetchedAt);
    const { fetcher, calls } = fakeFetcher(answer);
    const list = await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher });
    assert.deepEqual([...list], prev, name);
    assert.deepEqual(calls, [`${O}/sitemap.xml`], `${name}: 索引の1回だけで止め、別の経路は探さない`);
    assert.equal(list.staleReason, undefined, name);                      // 14日より前は ok のまま
    assert.match(list.listNote, /一覧を作り直せず、前の一覧（3件・8日前）を使っている/, name);
    assert.match(fs.readFileSync(`${f}.failed`, "utf8"), why, name);
    assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /^\S+ 連続1回 /, name);
    assert.equal(fs.readFileSync(f, "utf8"), prev.join("\n") + "\n", name);
    assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), fetchedAt, name);   // 取得日は進めない
  }
  // 束が1本でも取れなければ、取れた分だけの一覧にしない
  const f = tmpList(["1", "2"], daysAgo(8));
  const { fetcher } = fakeFetcher((u) => (u.endsWith("/sitemap.xml") ? okSite(u) : { ok: false, status: 500, html: "" }));
  assert.deepEqual([...(await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher }))], ["1", "2"]);
  assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /park_coin-parking-sitemap\.xml: HTTP 500/);
});

test("差し替えた fetch でも（polite-fetch を通しても）エリアページへは行かない", async () => {
  const calls = stubFetch({ [`${O}/sitemap.xml`]: { status: 500 }, [`${O}/park/coin-parking/`]: `<a href="${O}/park/coin-parking/area/x/">x</a>` });
  const f = tmpList(["1", "2"], daysAgo(8));
  assert.deepEqual([...(await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5 }))], ["1", "2"]);
  assert.ok(!calls.some((u) => u.includes("/area/") || u === `${O}/park/coin-parking/`), calls.join(" "));
  assert.ok(fs.existsSync(`${f}.failed`));
});

test("作り直しに失敗したら20時間は試さない。過ぎたら試し、作り直せたら .failed を消して取得日を進める", async () => {
  const prev = ["1", "2", "3"];
  const f = tmpList(prev, daysAgo(8));
  await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: fakeFetcher(() => ({ ok: false, status: 503, html: "" })).fetcher });
  assert.ok(fs.existsSync(`${f}.failed`));
  // すぐ次の回は1回も送らない
  const again = fakeFetcher(okSite);
  const list = await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: again.fetcher });
  assert.deepEqual([...list], prev);
  assert.equal(again.calls.length, 0);
  assert.match(list.listNote, /前回の失敗: サイトマップ: HTTP 503/);
  // 19時間あとも試さない
  fs.writeFileSync(`${f}.failed`, `${new Date(Date.now() - 19 * 3600e3).toISOString()} 連続1回 サイトマップ: HTTP 503`);
  assert.equal((await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: again.fetcher })).length, 3);
  assert.equal(again.calls.length, 0);
  // 20時間を過ぎたら試す。また失敗したら続けて2回目と記録する
  fs.writeFileSync(`${f}.failed`, `${new Date(Date.now() - 21 * 3600e3).toISOString()} 連続1回 サイトマップ: HTTP 503`);
  const down = fakeFetcher(() => ({ ok: false, status: 429, html: "" }));
  await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: down.fetcher });
  assert.equal(down.calls.length, 1);
  assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /^\S+ 連続2回 サイトマップ: HTTP 429$/);
  // 作り直せたら .failed を消し、取得日を進める
  fs.writeFileSync(`${f}.failed`, `${new Date(Date.now() - 21 * 3600e3).toISOString()} サイトマップ: HTTP 503`);   // 以前の形の記録も読める
  const later = fakeFetcher(okSite);
  const ok = await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: later.fetcher });
  assert.deepEqual(ok, ["1", "2", "3", "4", "5"]);
  assert.equal(later.calls.length, 2);
  assert.ok(!fs.existsSync(`${f}.failed`));
  assert.ok(Date.parse(fs.readFileSync(`${f}.fetched`, "utf8")) > Date.now() - 60e3);
  assert.equal(ok.staleReason, undefined);
  assert.equal(ok.listNote, undefined);
});

test("前の一覧が古いまま14日を超えたら staleReason を付けて health で知らせる。前の一覧も無ければ例外", async () => {
  const prev = ["1", "2", "3"];
  const f = tmpList(prev, daysAgo(15));
  const list = await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: fakeFetcher(() => ({ ok: false, status: 403, html: "" })).fetcher });
  assert.deepEqual([...list], prev);
  assert.match(list.staleReason, /一覧を作り直せていない（前の一覧は15日前）: サイトマップ: HTTP 403/);
  // 待っている回（.failed が新しい）も同じく知らせる
  const again = await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: fakeFetcher(okSite).fetcher });
  assert.match(again.staleReason, /一覧を作り直せていない（前の一覧は15日前）: 前回の失敗: サイトマップ: HTTP 403/);
  // 前の一覧が無ければ例外（空の一覧で巡回しない）。.failed も書かない（次の回にまた試す）
  const g = tmpList(null);
  await assert.rejects(getAllEcoloIds({ cacheFile: g, cacheMs: 7 * 864e5, fetcher: fakeFetcher(() => ({ ok: false, status: 503, html: "" })).fetcher }),
    /一覧が取れませんでした: サイトマップ: HTTP 503/);
  assert.ok(!fs.existsSync(g));
  assert.ok(!fs.existsSync(`${g}.failed`));
});

test("取り直した一覧が前回の半分に満たなければ、前の一覧を使い続ける（取得日も進めない）", async () => {
  const prev = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"];
  const f = tmpList(prev);
  const { fetcher, calls } = fakeFetcher(okSite);   // 5件だけ
  assert.deepEqual([...(await getAllEcoloIds({ cacheFile: f, cacheMs: 7 * 864e5, fetcher }))], prev);
  assert.equal(calls.length, 2);                     // 索引と束の2回だけ（別の経路で数え直さない）
  assert.equal(fs.readFileSync(f, "utf8"), prev.join("\n") + "\n");
  assert.ok(!fs.existsSync(`${f}.fetched`), "次の回にやり直せるよう、取得日は書かない");
  assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /一覧が 11件 → 5件に減った/);
  // 中身が無いサイトマップ（0件）も失敗。前の一覧も無ければ例外
  const empty = fakeFetcher((u) => (u.endsWith("/sitemap.xml") ? okSite(u) : { ok: true, status: 200, html: "<urlset></urlset>" }));
  await assert.rejects(getAllEcoloIds({ cacheFile: tmpList(null), cacheMs: 7 * 864e5, fetcher: empty.fetcher }), /物件が1件もありません/);
});

test("閉鎖の転送（同じホストの / や /park/）だけを閉鎖とみなす", () => {
  assert.equal(isClosedRedirect("/"), true);
  assert.equal(isClosedRedirect("/park/"), true);
  assert.equal(isClosedRedirect(`${O}/`), true);
  assert.equal(isClosedRedirect(`${O}/park/`), true);
  assert.equal(isClosedRedirect("http://service.ecolocity.co.jp/park/"), true);   // http への転送も同じホスト
  assert.equal(isClosedRedirect(`${O}/park/coin-parking/10380/`), false);   // 番号の付け替えは閉鎖にしない
  assert.equal(isClosedRedirect(null), false);
  assert.equal(isClosedRedirect(""), false);
  // 保守・ログイン・別のホストなどへの転送は、いつもの失敗（閉鎖にしない）
  assert.equal(isClosedRedirect("/maintenance/"), false);
  assert.equal(isClosedRedirect(`${O}/maintenance.html`), false);
  assert.equal(isClosedRedirect("/login/?redirect_to=%2Fpark%2Fcoin-parking%2F10%2F"), false);
  assert.equal(isClosedRedirect("/wp-login.php"), false);
  assert.equal(isClosedRedirect("/park/coin-parking/"), false);
  assert.equal(isClosedRedirect("/?maintenance=1"), false);
  assert.equal(isClosedRedirect("https://www.ecolocity.co.jp/"), false);    // 別のホスト
  assert.equal(isClosedRedirect("https://example.com/park/"), false);
  assert.equal(isClosedRedirect("//evil.example/"), false);
  assert.equal(isClosedRedirect("javascript:alert(1)"), false);
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
