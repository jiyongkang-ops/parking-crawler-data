// ナビパークの一覧づくりのテスト（npm test）。事業者サイトには繋がない（取得は偽物に差し替える）。
// 2026-10-18: 市区ページの1ページ目（10件）しか読んでおらず、どの市区も10件で止まっていた（世田谷区は49件・5ページ）。
// また都道府県ページや市区ページが取れなくても黙って飛ばし、欠けた一覧を「作り直した」と記録していた。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// cache-age.js は1回の実行で作り直す一覧の数を絞っている（読み込んだときに決まる）。テストでは何度も作り直すので、
// 読み込む前に外す。だからこのファイルでは src を import 文ではなく、ここで読み込む
process.env.LIST_REFRESH_MAX = "99";
const {
  getAllNaviparkCodes, parseCityLinks, parseCodes, nextPageNo, declaredCount, cityPageUrl, prefUrl,
} = await import("../src/navipark-enumerate.js");

const ORIGIN = "https://www.navipark1.com";
const code = (n) => `N${String(n).padStart(5, "0")}`;
const codesOf = (from, n) => Array.from({ length: n }, (_, i) => code(from + i));

// ---- 偽のページ（2026-10-18 に見た実ページと同じ形だけをまねる） ----
const prefHtml = (cities) => `<h2 class="heading01">ア行</h2><ul class="linkList01">${
  cities.map((c) => `<li><a href="../parkingList-${c}/">市区${c}</a></li>`).join("")}</ul>`;
const pager = (city, page, last) => {
  const [p, c] = city.split("-");
  const href = (n) => `/search/parkingList.php?prefCD=${p}&cityCD=${c}&page=${n}`;
  const nums = Array.from({ length: last }, (_, i) => i + 1)
    .map((n) => `<li${n === page ? ' class="current"' : ""}><a href="${href(n)}">${n}</a></li>`).join("");
  return `<ul class="paginator">${page > 1 ? `<li><a href="${href(page - 1)}">前へ </a></li>` : ""}${nums}${
    page < last ? `<li class="last"><a href="${href(page + 1)}">次へ</a></li>` : ""}</ul>`;
};
const cityHtml = (city, page, codes, total) => {
  const last = Math.max(1, Math.ceil(total / 10));
  return `<p class="resultText">該当駐車場件数：<span>${total}</span>件<font id="msg_u"></font></p>${pager(city, page, last)}` +
    codes.map((c) => `<div class="resultBlock01"><p class="txBold"><a href="../parkingDetail/${c}.html" class="link01">駐車場${c}</a></p></div>`).join("") +
    pager(city, page, last);
};

// 偽のサイト。site = { 13: { "13-112": [コード…], … }, … }。1ページ10件。
// 取ったURLを calls に残す。fail(url) が応答を返せば、そのURLはその応答にする（失敗の再現）
function fakeSite(site, { fail = () => null } = {}) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    const f = fail(url, calls);
    if (f) { if (f instanceof Error) throw f; return f; }
    const pm = url.match(/searchAreaList-(\d+)\/$/);
    if (pm) return { ok: true, status: 200, html: prefHtml(Object.keys(site[pm[1]] ?? {})) };
    let city, page;
    const c1 = url.match(/\/parkingList-(\d+-\d+)\/$/);
    const cn = url.match(/parkingList\.php\?prefCD=(\d+)&cityCD=(\d+)&page=(\d+)$/);
    if (c1) { city = c1[1]; page = 1; } else if (cn) { city = `${cn[1]}-${cn[2]}`; page = Number(cn[3]); }
    const all = city && site[city.split("-")[0]]?.[city];
    if (!all) return { ok: false, status: 404, html: "Not Found" };
    return { ok: true, status: 200, html: cityHtml(city, page, all.slice((page - 1) * 10, page * 10), all.length) };
  };
  return { fetcher, calls };
}

const tmpList = (lines, fetchedAt) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "navipark-list-"));
  const f = path.join(dir, "navipark-codes.txt");
  if (lines) fs.writeFileSync(f, lines.join("\n") + "\n");
  if (fetchedAt) fs.writeFileSync(`${f}.fetched`, fetchedAt);
  return f;
};
const eightDaysAgo = new Date(Date.now() - 8 * 864e5).toISOString();
const opts = (f, fetcher, extra = {}) => ({ cacheFile: f, cacheMs: 7 * 864e5, fetcher, retryWaitMs: 0, ...extra });

// 東京2市区（25件・5件）と神奈川1市区（10件ちょうど）。1ページ目だけだと 10+5+10=25件
const SITE = {
  13: { "13-112": codesOf(100, 25), "13-113": codesOf(200, 5) },
  14: { "14-101": codesOf(300, 10) },
};
const ALL = [...SITE[13]["13-112"], ...SITE[13]["13-113"], ...SITE[14]["14-101"]];

test("読み取り: 実ページの形から市区・物件コード・「次へ」・件数を読む", () => {
  assert.deepEqual(parseCityLinks(prefHtml(["13-207", "13-112", "13-207"])), ["13-207", "13-112"]);
  const h1 = cityHtml("13-112", 1, codesOf(1, 10), 49);
  assert.equal(parseCodes(h1).length, 10);
  assert.equal(nextPageNo(h1), 2);                      // 「前へ」や番号のリンクではなく「次へ」を読む
  assert.equal(nextPageNo(cityHtml("13-112", 2, codesOf(11, 10), 49)), 3);
  assert.equal(nextPageNo(cityHtml("13-112", 5, codesOf(41, 9), 49)), null);   // 最後のページ
  assert.equal(declaredCount(h1), 49);
  // 2ページ目からは「次へ」と同じ URL。1ページ目はいままでどおり
  assert.equal(cityPageUrl("13-112", 1), `${ORIGIN}/parkingList-13-112/`);
  assert.equal(cityPageUrl("13-112", 2), `${ORIGIN}/search/parkingList.php?prefCD=13&cityCD=112&page=2`);
  assert.equal(prefUrl(13), `${ORIGIN}/searchAreaList-13/`);
});

test("ページ送り: 2ページ目以降を「次へ」が無くなるまで辿り、取り直した一覧を書いて .fetched を進める", async () => {
  const f = tmpList(codesOf(100, 10).concat(codesOf(200, 5), codesOf(300, 10)), eightDaysAgo);
  const { fetcher, calls } = fakeSite(SITE);
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(list, ALL);                                          // 25+5+10 = 40件（以前は25件）
  assert.deepEqual(fs.readFileSync(f, "utf8").split("\n").filter(Boolean), ALL);
  assert.notEqual(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);
  // 都道府県47 + 13-112 は3ページ・13-113 と 14-101 は1ページ（10件ちょうどは「次へ」が無いので2ページ目を取らない）
  assert.equal(calls.length, 47 + 3 + 1 + 1);
  assert.ok(calls.includes(`${ORIGIN}/search/parkingList.php?prefCD=13&cityCD=112&page=3`));
  assert.ok(!calls.some((u) => /page=4/.test(u)));
});

test("ページ送り: 新しいコードが無いページで止まる（page を無視して同じページが返るとき）", async () => {
  const { fetcher, calls } = fakeSite(SITE);
  // 2ページ目以降も1ページ目と同じ中身（「次へ」付き）を返すサイト
  const same = async (url) => {
    const m = url.match(/prefCD=13&cityCD=112&page=\d+$/);
    return fetcher(m ? `${ORIGIN}/parkingList-13-112/` : url);
  };
  const f = tmpList(null, null);
  const list = await getAllNaviparkCodes(opts(f, same));
  assert.equal(list.length, 10 + 5 + 10);
  // 13-112 は1ページ目と、新しいコードが無かった2ページ目の2回だけ
  assert.equal(calls.filter((u) => /parkingList-13-112\/$/.test(u)).length, 2);
});

test("ページ送り: 1市区30ページで止める（それ以上続いても取りに行かない）", async () => {
  const big = { 13: { "13-101": codesOf(1000, 500) } };   // 50ページある市区
  const { fetcher, calls } = fakeSite(big);
  const f = tmpList(null, null);
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.equal(list.length, 300);
  const cityCalls = calls.filter((u) => /parkingList/.test(u));
  assert.equal(cityCalls.length, 30);
  assert.ok(!calls.some((u) => /page=31/.test(u)));
});

test("守り: 途中の市区ページが取れなければ、その時点で打ち切り、前の一覧を使い続ける（.fetched を進めない）", async () => {
  const old = codesOf(100, 10).concat(codesOf(200, 5), codesOf(300, 10));
  const f = tmpList(old, eightDaysAgo);
  const { fetcher, calls } = fakeSite(SITE, {
    fail: (u) => (/cityCD=112&page=2$/.test(u) ? { ok: false, status: 404, html: "" } : null),
  });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual([...list], old);
  assert.deepEqual(fs.readFileSync(f, "utf8").split("\n").filter(Boolean), old);   // 一覧を書き換えない
  assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);              // 作り直したことにしない
  assert.equal(list.staleReason, undefined);                                         // 14日までは知らせない
  // 404 は取り直さず、そこで打ち切る（都道府県14以降は取りに行かない）
  assert.equal(calls.filter((u) => /cityCD=112&page=2$/.test(u)).length, 1);
  assert.ok(!calls.includes(prefUrl(14)));
});

test("守り: 都道府県ページが取れないときも同じ（以前は黙って飛ばしていた）", async () => {
  const old = ALL;
  const f = tmpList(old, eightDaysAgo);
  const { fetcher } = fakeSite(SITE, { fail: (u) => (u === prefUrl(14) ? { ok: false, status: 403, html: "" } : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual([...list], old);
  assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);
});

test("守り: タイムアウト・5xx は1回だけ取り直す。取り直して取れればそのまま続ける", async () => {
  const f = tmpList(null, null);
  let n = 0;
  const { fetcher, calls } = fakeSite(SITE, {
    fail: (u) => (/cityCD=112&page=2$/.test(u) && n++ === 0 ? new Error("The operation was aborted due to timeout") : null),
  });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(list, ALL);
  assert.equal(calls.filter((u) => /cityCD=112&page=2$/.test(u)).length, 2);
  // 2回続けて 503 なら失敗。前の一覧が無ければ例外
  const f2 = tmpList(null, null);
  const { fetcher: down } = fakeSite(SITE, { fail: (u) => (u === prefUrl(13) ? { ok: false, status: 503, html: "" } : null) });
  await assert.rejects(getAllNaviparkCodes(opts(f2, down)), /searchAreaList-13\/ が取れない（HTTP 503）/);
  assert.ok(!fs.existsSync(f2));
});

test("守り: 前の一覧の9割に満たなければ作り直しの失敗とみなす。少しの減りはそのまま受け入れる", async () => {
  const old = codesOf(1, 50);
  const f1 = tmpList(old, eightDaysAgo);
  const shrunk = await getAllNaviparkCodes(opts(f1, fakeSite(SITE).fetcher));   // 40件 < 45件
  assert.deepEqual([...shrunk], old);
  assert.equal(fs.readFileSync(`${f1}.fetched`, "utf8"), eightDaysAgo);
  const f2 = tmpList(codesOf(1, 44), eightDaysAgo);
  const ok = await getAllNaviparkCodes(opts(f2, fakeSite(SITE).fetcher));       // 40件 ≥ 39.6件
  assert.deepEqual(ok, ALL);
  assert.notEqual(fs.readFileSync(`${f2}.fetched`, "utf8"), eightDaysAgo);
});

test("守り: 前の一覧が無ければ例外。長く作り直せていなければ知らせる印を付ける", async () => {
  const f1 = tmpList(null, null);
  await assert.rejects(getAllNaviparkCodes(opts(f1, async () => { throw new Error("getaddrinfo ENOTFOUND"); })), /ENOTFOUND/);
  // ページの作りが変わって市区のリンクが1つも無いときも例外（空の一覧を書かない）
  await assert.rejects(getAllNaviparkCodes(opts(tmpList(null, null), fakeSite({}).fetcher)), /市区のリンクが1つもありません/);
  const f2 = tmpList(ALL, new Date(Date.now() - 20 * 864e5).toISOString());
  const list = await getAllNaviparkCodes(opts(f2, async () => { throw new Error("The operation was aborted due to timeout"); }));
  assert.deepEqual([...list], ALL);
  assert.match(list.staleReason, /20日前の一覧/);
});

test("守り: 作り直しに失敗したら、次に試すのは20時間あと（失敗が続いても毎回約500リクエストを重ねない）", async () => {
  const f = tmpList(ALL, eightDaysAgo);
  const down = fakeSite(SITE, { fail: () => ({ ok: false, status: 503, html: "" }) });
  await getAllNaviparkCodes(opts(f, down.fetcher));
  assert.equal(down.calls.length, 2);                    // 都道府県1の1回と取り直し1回で打ち切り
  assert.ok(fs.existsSync(`${f}.failed`));
  // すぐ次の回は取りに行かない
  const again = fakeSite(SITE);
  const list = await getAllNaviparkCodes(opts(f, again.fetcher));
  assert.deepEqual([...list], ALL);
  assert.equal(again.calls.length, 0);
  // 20時間を過ぎたら試す。作り直せたら失敗の記録を消す
  fs.writeFileSync(`${f}.failed`, `${new Date(Date.now() - 21 * 3600e3).toISOString()} HTTP 503`);
  const later = fakeSite(SITE);
  assert.deepEqual(await getAllNaviparkCodes(opts(f, later.fetcher)), ALL);
  assert.ok(later.calls.length > 0);
  assert.ok(!fs.existsSync(`${f}.failed`));
});

test("キャッシュ: 取得日が新しければ取りに行かない（いままでどおり）", async () => {
  const f = tmpList(ALL, new Date().toISOString());
  const { fetcher, calls } = fakeSite(SITE);
  assert.deepEqual(await getAllNaviparkCodes(opts(f, fetcher)), ALL);
  assert.equal(calls.length, 0);
});
