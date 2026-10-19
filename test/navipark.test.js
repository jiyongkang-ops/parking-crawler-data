// ナビパークの一覧づくりのテスト（npm test）。事業者サイトには繋がない（取得は偽物に差し替える）。
// 2026-10-18: 市区ページの1ページ目（10件）しか読んでおらず、どの市区も10件で止まっていた（世田谷区は49件・5ページ）。
// また都道府県ページや市区ページが取れなくても黙って飛ばし、欠けた一覧を「作り直した」と記録していた。
// 2回目の点検（同じ日）: 1ページだけ 404 が続くと一覧づくりが毎日まるごと失敗し、2ページ目以降の直しが効かない。
// 取り直しの合計回数・時間に上限が無い。200 なのに物件コード0件のページ（保守の画面など）を失敗として数えていない。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// cache-age.js は1回の実行で作り直す一覧の数を絞っている（読み込んだときに決まる）。テストでは何度も作り直すので、
// 読み込む前に外す。だからこのファイルでは src を import 文ではなく、ここで読み込む
process.env.LIST_REFRESH_MAX = "99";
const {
  getAllNaviparkCodes, parseCityLinks, parseCodes, nextPageNo, declaredCount, cityPageUrl, prefUrl, isEmptyAreaPage, retryAfterFailMs,
} = await import("../src/navipark-enumerate.js");

const ORIGIN = "https://www.navipark1.com";
const code = (n) => `N${String(n).padStart(5, "0")}`;
const codesOf = (from, n) => Array.from({ length: n }, (_, i) => code(from + i));

// ---- 偽のページ（2026-10-18 に見た実ページと同じ形だけをまねる） ----
// 物件の無い県は 200 で「お探しのエリアに駐車場は見つかりませんでした。」と出る（青森で確認）
const prefHtml = (cities) => cities.length
  ? `<h2 class="heading01">ア行</h2><ul class="linkList01">${cities.map((c) => `<li><a href="../parkingList-${c}/">市区${c}</a></li>`).join("")}</ul>`
  : `<p>お探しのエリアに駐車場は見つかりませんでした。</p><p>お探しのエリアを、市区町村からお選びください。</p>`;
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
const MAINTENANCE = { ok: true, status: 200, html: "<html><body>ただいまメンテナンス中です</body></html>" };
const NOT_FOUND = { ok: false, status: 404, html: "Not Found" };

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
    if (!all) return NOT_FOUND;
    return { ok: true, status: 200, html: cityHtml(city, page, all.slice((page - 1) * 10, page * 10), all.length) };
  };
  return { fetcher, calls };
}

// テストで作った一時ディレクトリは最後に消す
const tmpDirs = [];
// 一覧づくりのログは画面に出さずに控える（中身を確かめる。node --test で1ファイルだけ走らせると、子プロセスの日本語のログを
// テストの結果と読み違えて「Unable to deserialize cloned data」で落ちることがあった。Node v22.11）
const logs = [];
const origConsole = { log: console.log, warn: console.warn };
console.log = (...a) => { logs.push(a.join(" ")); };
console.warn = (...a) => { logs.push(a.join(" ")); };
after(() => {
  Object.assign(console, origConsole);
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmpList = (lines, fetchedAt) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "navipark-list-"));
  tmpDirs.push(dir);
  const f = path.join(dir, "navipark-codes.txt");
  if (lines) fs.writeFileSync(f, lines.join("\n") + "\n");
  if (fetchedAt) fs.writeFileSync(`${f}.fetched`, fetchedAt);
  return f;
};
const readLines = (f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
const readCities = (f) => JSON.parse(fs.readFileSync(`${f}.cities.json`, "utf8"));
const eightDaysAgo = new Date(Date.now() - 8 * 864e5).toISOString();
const opts = (f, fetcher, extra = {}) => ({ cacheFile: f, cacheMs: 7 * 864e5, fetcher, retryWaitMs: 0, ...extra });
/** 取得日を8日前に戻す（次の呼び出しで作り直させる） */
const makeOld = (f) => fs.writeFileSync(`${f}.fetched`, eightDaysAgo);

// 東京2市区（25件・5件）と神奈川1市区（10件ちょうど）。1ページ目だけだと 10+5+10=25件
const SITE = {
  13: { "13-112": codesOf(100, 25), "13-113": codesOf(200, 5) },
  14: { "14-101": codesOf(300, 10) },
};
const ALL = [...SITE[13]["13-112"], ...SITE[13]["13-113"], ...SITE[14]["14-101"]];
// 1市区・1県だけ欠けるテスト用に、物件の多い市区（200件・20ページ）を足したサイト。
// 欠けても今回読めた番号が前の一覧の9割を下回らないようにする（下回れば作り直しの失敗になる。別のテストで確かめる）
const BIG = { 12: { "12-101": codesOf(1000, 200) }, ...SITE };
const ALL_BIG = [...BIG[12]["12-101"], ...ALL];
/** BIG で1回作り直して、市区ごとの控えを作っておく。取得日は8日前に戻す（次の呼び出しで作り直させる） */
async function builtBig() {
  const f = tmpList(null, null);
  assert.deepEqual(await getAllNaviparkCodes(opts(f, fakeSite(BIG).fetcher)), ALL_BIG);
  makeOld(f);
  return f;
}

test("読み取り: 実ページの形から市区・物件コード・「次へ」・件数・物件の無い県を読む", () => {
  assert.deepEqual(parseCityLinks(prefHtml(["13-207", "13-112", "13-207"])), ["13-207", "13-112"]);
  const h1 = cityHtml("13-112", 1, codesOf(1, 10), 49);
  assert.equal(parseCodes(h1).length, 10);
  assert.equal(nextPageNo(h1), 2);                      // 「前へ」や番号のリンクではなく「次へ」を読む
  assert.equal(nextPageNo(cityHtml("13-112", 2, codesOf(11, 10), 49)), 3);
  assert.equal(nextPageNo(cityHtml("13-112", 5, codesOf(41, 9), 49)), null);   // 最後のページ
  assert.equal(declaredCount(h1), 49);
  assert.equal(isEmptyAreaPage(prefHtml([])), true);
  assert.equal(isEmptyAreaPage(MAINTENANCE.html), false);
  // 2ページ目からは「次へ」と同じ URL。1ページ目はいままでどおり
  assert.equal(cityPageUrl("13-112", 1), `${ORIGIN}/parkingList-13-112/`);
  assert.equal(cityPageUrl("13-112", 2), `${ORIGIN}/search/parkingList.php?prefCD=13&cityCD=112&page=2`);
  assert.equal(prefUrl(13), `${ORIGIN}/searchAreaList-13/`);
});

test("ページ送り: 2ページ目以降を「次へ」が無くなるまで辿り、取り直した一覧と市区ごとの控えを書いて .fetched を進める", async () => {
  const f = tmpList(codesOf(100, 10).concat(codesOf(200, 5), codesOf(300, 10)), eightDaysAgo);
  const { fetcher, calls } = fakeSite(SITE);
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(list, ALL);                                          // 25+5+10 = 40件（以前は25件）
  assert.equal(list.listNote, undefined);
  assert.deepEqual(readLines(f), ALL);
  assert.notEqual(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);
  assert.deepEqual(readCities(f).cities, { "13-112": SITE[13]["13-112"], "13-113": SITE[13]["13-113"], "14-101": SITE[14]["14-101"] });
  assert.deepEqual(readCities(f).missing, []);
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

// ---- 1つの市区・都道府県だけが取れないとき（2回目の点検の should） ----

test("1市区だけ 404: その市区は前回の控えの番号を残し、ほかの市区は作り直す。ログと health の reason（listNote）に出す", async () => {
  // 1回目: 全部取れる（控えができる）。2回目: 13-113 が 404。14-101 には新しい物件が1件増えている
  const f = await builtBig();
  const site2 = { ...BIG, 14: { "14-101": codesOf(300, 11) } };
  const { fetcher, calls } = fakeSite(site2, { fail: (u) => (/parkingList-13-113\/$/.test(u) ? NOT_FOUND : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(new Set(list), new Set([...ALL_BIG, code(310)]));
  assert.notEqual(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);   // 作り直しは進める
  assert.ok(calls.includes(prefUrl(47)));                                  // 打ち切らずに最後まで辿る
  assert.equal(calls.filter((u) => /parkingList-13-113\/$/.test(u)).length, 1);   // 404 は取り直さない
  assert.match(list.listNote, /取れなかった市区・都道府県1か所（市区13-113 1ページ目が HTTP 404）。その分は前の一覧の番号5件を残した/);
  assert.ok(logs.includes("::warning::[ナビパーク] 市区13-113 が取れなかった（1ページ目が HTTP 404）。前の一覧の番号を残す"));
  assert.ok(logs.some((l) => /^\[ナビパーク\] 一覧を作り直した: .* → 241件（前回240件・.*・取れなかった所の前の番号5件を含む）$/.test(l)), logs.slice(-3).join("\n"));
  const saved = readCities(f);
  assert.deepEqual(saved.missing, [{ key: "13-113", why: "1ページ目が HTTP 404" }]);
  assert.deepEqual(saved.cities["13-113"], SITE[13]["13-113"]);           // 次もまた取れなくても落とさない
  assert.ok(!fs.existsSync(`${f}.failed`));
  // 次の回（取得日が新しい）は取りに行かないが、次の作り直しまで health の reason に出し続ける
  const again = fakeSite(BIG);
  const cached = await getAllNaviparkCodes(opts(f, again.fetcher));
  assert.equal(again.calls.length, 0);
  assert.match(cached.listNote, /^前回の一覧づくり（\d{4}-\d\d-\d\d）で取れなかった市区・都道府県1か所（市区13-113 1ページ目が HTTP 404）/);
  // その次の作り直しで取れれば、控えも reason も元に戻る
  makeOld(f);
  const fixed = await getAllNaviparkCodes(opts(f, fakeSite(site2).fetcher));
  assert.equal(fixed.listNote, undefined);
  assert.deepEqual(readCities(f).missing, []);
});

test("1都道府県だけ 404: その県の市区の番号は前回の控えから残す", async () => {
  const f = await builtBig();
  const { fetcher, calls } = fakeSite(BIG, { fail: (u) => (u === prefUrl(14) ? NOT_FOUND : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(new Set(list), new Set(ALL_BIG));
  assert.ok(!calls.some((u) => /parkingList-14-/.test(u)));
  assert.match(list.listNote, /都道府県14 HTTP 404/);
  assert.deepEqual(readCities(f).cities["14-101"], SITE[14]["14-101"]);
});

test("控えが無い（この直しのあと初めての作り直し）ときに1市区が 404 なら、前の一覧のうち今回見つからなかった番号を全部残す", async () => {
  const old = [...ALL_BIG, code(999)];   // N00999 は本当に無くなった物件。控え（.cities.json）は無い
  const f = tmpList(old, eightDaysAgo);
  const { fetcher } = fakeSite(BIG, { fail: (u) => (/parkingList-13-113\/$/.test(u) ? NOT_FOUND : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  // どの市区の番号か分からないので、13-113 の5件と N00999 をどちらも残す（落とすより残すほうを選ぶ）
  assert.deepEqual(new Set(list), new Set(old));
  assert.deepEqual(new Set(readCities(f).cities["13-113"]), new Set([...SITE[13]["13-113"], code(999)]));
  // 次に 13-113 が取れれば、本当に無くなった N00999 は落ちる
  makeOld(f);
  const next = await getAllNaviparkCodes(opts(f, fakeSite(BIG).fetcher));
  assert.deepEqual(next, ALL_BIG);
});

test("2ページ目以降が 404: その市区はそこまで読めた番号を使い、前回の番号も残す", async () => {
  const f = await builtBig();
  const { fetcher, calls } = fakeSite(BIG, { fail: (u) => (/cityCD=112&page=2$/.test(u) ? NOT_FOUND : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(new Set(list), new Set(ALL_BIG));
  assert.ok(!calls.some((u) => /cityCD=112&page=3$/.test(u)));
  assert.match(list.listNote, /市区13-112 2ページ目が HTTP 404/);
});

test("200 なのに物件コードが0件の市区ページ（保守の画面など）は取れなかったと数える。「該当駐車場件数：0件」なら物件の無い市区", async () => {
  const f = await builtBig();
  const { fetcher } = fakeSite(BIG, { fail: (u) => (/parkingList-13-113\/$/.test(u) ? MAINTENANCE : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(new Set(list), new Set(ALL_BIG));
  assert.match(list.listNote, /市区13-113 200 だが物件コードが0件/);
  // 「該当駐車場件数：0件」と出ていれば、物件が無くなった市区（飛ばさない。番号は落ちる）
  makeOld(f);
  const empty = { ok: true, status: 200, html: cityHtml("13-113", 1, [], 0) };
  const list2 = await getAllNaviparkCodes(opts(f, fakeSite(BIG, { fail: (u) => (/parkingList-13-113\/$/.test(u) ? empty : null) }).fetcher));
  assert.equal(list2.listNote, undefined);
  assert.deepEqual(list2, [...BIG[12]["12-101"], ...SITE[13]["13-112"], ...SITE[14]["14-101"]]);
});

test("都道府県ページが 200 なのに市区のリンクも「見つかりませんでした」も無ければ、取れなかったと数える", async () => {
  const f = await builtBig();
  const { fetcher } = fakeSite(BIG, { fail: (u) => (u === prefUrl(14) ? MAINTENANCE : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual(new Set(list), new Set(ALL_BIG));
  assert.match(list.listNote, /都道府県14 市区のリンクも「見つかりませんでした」も無い（前回は1市区）/);
});

test("表示の件数の半分も読めない市区（2ページ目以降が保守の画面など）は取れなかったと数え、前回の番号を残す", async () => {
  const f = await builtBig();
  const { fetcher } = fakeSite(BIG, { fail: (u) => (/cityCD=112&page=\d$/.test(u) ? MAINTENANCE : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher));   // 13-112 は25件のうち10件しか読めない
  assert.deepEqual(new Set(list), new Set(ALL_BIG));
  assert.match(list.listNote, /市区13-112 表示25件のうち10件しか読めない/);
});

test("取れなかった市区・都道府県が上限を超えたら、サイト全体の不具合とみなして打ち切り、前の一覧を使う", async () => {
  const f = tmpList(ALL, eightDaysAgo);
  const { fetcher, calls } = fakeSite(SITE, { fail: (u) => (/parkingList/.test(u) ? NOT_FOUND : null) });
  const list = await getAllNaviparkCodes(opts(f, fetcher, { maxSkipped: 2 }));
  assert.deepEqual([...list], ALL);
  assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);
  assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /取れなかった市区・都道府県が上限の2か所を超えた/);
  assert.match(list.listNote, /^一覧を作り直せず、前の一覧（40件・8日前）を使っている/);
  assert.ok(!calls.includes(prefUrl(15)));                                  // 打ち切ったあとは取りに行かない
});

// ---- 作り直しの失敗（全体） ----

test("守り: 403・429 は取り直さず、その場で打ち切り、前の一覧を使い続ける（.fetched を進めない）", async () => {
  for (const status of [403, 429]) {
    const old = codesOf(100, 10).concat(codesOf(200, 5), codesOf(300, 10));
    const f = tmpList(old, eightDaysAgo);
    const { fetcher, calls } = fakeSite(SITE, {
      fail: (u) => (/cityCD=112&page=2$/.test(u) ? { ok: false, status, html: "" } : null),
    });
    const list = await getAllNaviparkCodes(opts(f, fetcher));
    assert.deepEqual([...list], old);
    assert.deepEqual(readLines(f), old);                                     // 一覧を書き換えない
    assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);     // 作り直したことにしない
    assert.equal(list.staleReason, undefined);                               // 14日までは ok のまま、reason に出す
    assert.match(list.listNote, new RegExp(`HTTP ${status}`));
    assert.equal(calls.filter((u) => /cityCD=112&page=2$/.test(u)).length, 1);
    assert.ok(!calls.includes(prefUrl(14)));
  }
});

test("守り: robots.txt で見送った（本ページを送っていない）ときも、その場で打ち切る", async () => {
  const f = tmpList(ALL, eightDaysAgo);
  const calls = [];
  const fetcher = async (u) => { calls.push(u); return { ok: false, transient: true, status: null, skippedReason: "robots.txt に届かない（相手先の障害の可能性）", robotsError: "HTTP 503" }; };
  const list = await getAllNaviparkCodes(opts(f, fetcher));
  assert.deepEqual([...list], ALL);
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /robots\.txt に届かない（相手先の障害の可能性）（HTTP 503）/);
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

test("守り: 取り直しの合計が上限に達したら打ち切る（毎回1回目だけ失敗するサイトで何時間も回らない）", async () => {
  const f = tmpList(ALL, eightDaysAgo);
  const seen = new Set();
  // どのページも1回目だけ 503（2回目は取れる）
  const { fetcher, calls } = fakeSite(SITE, { fail: (u) => (seen.has(u) ? null : (seen.add(u), { ok: false, status: 503, html: "" })) });
  const list = await getAllNaviparkCodes(opts(f, fetcher, { maxRetries: 3 }));
  assert.deepEqual([...list], ALL);
  assert.equal(calls.length, 3 * 2 + 1);                                     // 3ページを2回ずつ、4ページ目の1回目で打ち切り
  assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /取り直しが上限の3回に達した/);
});

test("守り: 一覧づくり全体の時間が上限を超えたら打ち切る", async () => {
  const f = tmpList(ALL, eightDaysAgo);
  const { fetcher: fast, calls } = fakeSite(SITE);
  const slow = async (u) => { await new Promise((r) => setTimeout(r, 20)); return fast(u); };
  const list = await getAllNaviparkCodes(opts(f, slow, { maxMinutes: 0.0005 }));   // 30ミリ秒
  assert.deepEqual([...list], ALL);
  assert.ok(calls.length >= 1 && calls.length <= 3, `取得${calls.length}回`);
  assert.match(fs.readFileSync(`${f}.failed`, "utf8"), /一覧づくりが0分を超えた/);
  assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);
});

test("守り: 前の一覧の9割に満たなければ作り直しの失敗とみなす。少しの減りはそのまま受け入れる。取れなかった所が大きすぎても失敗", async () => {
  const old = codesOf(1, 50);
  const f1 = tmpList(old, eightDaysAgo);
  const shrunk = await getAllNaviparkCodes(opts(f1, fakeSite(SITE).fetcher));   // 40件 < 45件
  assert.deepEqual([...shrunk], old);
  assert.equal(fs.readFileSync(`${f1}.fetched`, "utf8"), eightDaysAgo);
  const f2 = tmpList(codesOf(1, 44), eightDaysAgo);
  const ok = await getAllNaviparkCodes(opts(f2, fakeSite(SITE).fetcher));       // 40件 ≥ 39.6件
  assert.deepEqual(ok, ALL);
  assert.notEqual(fs.readFileSync(`${f2}.fetched`, "utf8"), eightDaysAgo);
  // 県14が 404。読めたのは30件だが、控えから14-101の10件を残すと前と同じ40件なので、作り直しは進める（1つの県だけなら進める）
  const f3 = tmpList(null, null);
  await getAllNaviparkCodes(opts(f3, fakeSite(SITE).fetcher));
  makeOld(f3);
  const part = await getAllNaviparkCodes(opts(f3, fakeSite(SITE, { fail: (u) => (u === prefUrl(14) ? NOT_FOUND : null) }).fetcher));
  assert.deepEqual(new Set(part), new Set(ALL));
  assert.match(part.listNote, /^一覧づくりで取れなかった市区・都道府県1か所（都道府県14 HTTP 404）/);
  // 県13が 404 だと、読めたのは10件（前の一覧40件の25%）。前の番号を残せば40件でも、取れなかった所が大きすぎるので失敗
  makeOld(f3);
  const most = await getAllNaviparkCodes(opts(f3, fakeSite(SITE, { fail: (u) => (u === prefUrl(13) ? NOT_FOUND : null) }).fetcher));
  assert.deepEqual(new Set(most), new Set(ALL));
  assert.match(most.listNote, /^一覧を作り直せず.*今回読めたのは10件で、前の一覧40件の50%に満たない/);
  assert.equal(fs.readFileSync(`${f3}.fetched`, "utf8"), eightDaysAgo);
});

test("守り: 前の一覧が無ければ例外。長く作り直せていなければ知らせる印を付ける", async () => {
  const f1 = tmpList(null, null);
  await assert.rejects(getAllNaviparkCodes(opts(f1, async () => { throw new Error("getaddrinfo ENOTFOUND"); })), /ENOTFOUND/);
  // ページの作りが変わって市区のリンクが1つも無いときも例外（空の一覧を書かない）
  await assert.rejects(getAllNaviparkCodes(opts(tmpList(null, null), fakeSite({}).fetcher)), /市区のリンクが1つもありません/);
  const f2 = tmpList(ALL, new Date(Date.now() - 20 * 864e5).toISOString());
  const list = await getAllNaviparkCodes(opts(f2, async () => { throw new Error("The operation was aborted due to timeout"); }));
  assert.deepEqual([...list], ALL);
  assert.match(list.staleReason, /一覧を作り直せていない（前の一覧は20日前）/);
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
  assert.match(list.listNote, /前回の失敗: /);
  // 20時間を過ぎたら試す。作り直せたら失敗の記録を消す
  fs.writeFileSync(`${f}.failed`, `${new Date(Date.now() - 21 * 3600e3).toISOString()} HTTP 503`);
  const later = fakeSite(SITE);
  assert.deepEqual(await getAllNaviparkCodes(opts(f, later.fetcher)), ALL);
  assert.ok(later.calls.length > 0);
  assert.ok(!fs.existsSync(`${f}.failed`));
});

test("守り: 作り直しの失敗が続いたら、次に試すまでを 20時間→2日→4日→7日（上限）と延ばす。作り直せたら元に戻す", async () => {
  const H = 3600e3, D = 864e5;
  assert.deepEqual([1, 2, 3, 4, 5, 30].map(retryAfterFailMs), [20 * H, 2 * D, 4 * D, 7 * D, 7 * D, 7 * D]);
  assert.equal(retryAfterFailMs(0), 20 * H);   // 回数が読めないときは1回目とみなす
  const f = tmpList(ALL, eightDaysAgo);
  const down = () => fakeSite(SITE, { fail: () => ({ ok: false, status: 403, html: "" }) });
  const stamp = (agoMs, n) => fs.writeFileSync(`${f}.failed`, `${new Date(Date.now() - agoMs).toISOString()} 連続${n}回 HTTP 403`);
  const count = () => Number(fs.readFileSync(`${f}.failed`, "utf8").match(/ 連続(\d+)回 /)?.[1]);
  /** 1回呼んで、送った回数を返す */
  const tryOnce = async (site) => { await getAllNaviparkCodes(opts(f, site.fetcher)); return site.calls.length; };

  assert.equal(await tryOnce(down()), 1);       // 1回目の失敗（403 は取り直さない）
  assert.equal(count(), 1);
  // 1回目のあとは20時間あける
  stamp(19 * H, 1); assert.equal(await tryOnce(down()), 0);
  stamp(21 * H, 1); assert.equal(await tryOnce(down()), 1);
  assert.equal(count(), 2);
  // 2回続けて失敗したら2日
  stamp(21 * H, 2); assert.equal(await tryOnce(down()), 0);
  const skipped = await getAllNaviparkCodes(opts(f, down().fetcher));
  assert.match(skipped.listNote, /前回の失敗: HTTP 403（続けて2回。次に試すのは2日あと）/);
  stamp(47 * H, 2); assert.equal(await tryOnce(down()), 0);
  stamp(49 * H, 2); assert.equal(await tryOnce(down()), 1);
  assert.equal(count(), 3);
  // 3回で4日
  stamp(3.9 * D, 3); assert.equal(await tryOnce(down()), 0);
  stamp(4.1 * D, 3); assert.equal(await tryOnce(down()), 1);
  assert.equal(count(), 4);
  // 4回目からは7日（上限。それより延ばさない）
  stamp(6.9 * D, 4); assert.equal(await tryOnce(down()), 0);
  stamp(6.9 * D, 12); assert.equal(await tryOnce(down()), 0);
  stamp(7.1 * D, 12); assert.equal(await tryOnce(down()), 1);
  assert.equal(count(), 13);
  // 作り直せたら記録を消す（待ちも元に戻る）
  stamp(7.1 * D, 13);
  assert.deepEqual(await getAllNaviparkCodes(opts(f, fakeSite(SITE).fetcher)), ALL);
  assert.ok(!fs.existsSync(`${f}.failed`));
  makeOld(f);
  assert.equal(await tryOnce(down()), 1);
  assert.equal(count(), 1);                      // また1回目から数える
  stamp(21 * H, 1); assert.equal(await tryOnce(down()), 1);
});

test("キャッシュ: 取得日が新しければ取りに行かない（いままでどおり）。前の一覧が空なら取得日が新しくても作り直す", async () => {
  const f = tmpList(ALL, new Date().toISOString());
  const { fetcher, calls } = fakeSite(SITE);
  assert.deepEqual(await getAllNaviparkCodes(opts(f, fetcher)), ALL);
  assert.equal(calls.length, 0);
  const empty = tmpList([], new Date().toISOString());
  const site = fakeSite(SITE);
  assert.deepEqual(await getAllNaviparkCodes(opts(empty, site.fetcher)), ALL);
  assert.ok(site.calls.length > 0);
});

// ---- run.js を通しで動かす（別のプロセス。fetch を偽物に替え、ネットには繋がない） ----

test("通しの巡回: 1市区だけ 404 の作り直しは health を ok のまま、reason に「取れなかった市区」を出す", () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "navipark-run-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  // 前回の一覧と市区ごとの控え（8日前＝作り直す時期）
  const list = path.join(dir, "data/navipark-codes.txt");
  fs.writeFileSync(list, ALL_BIG.join("\n") + "\n");
  fs.writeFileSync(`${list}.fetched`, eightDaysAgo);
  const cities = Object.fromEntries(Object.values(BIG).flatMap((p) => Object.entries(p)));
  fs.writeFileSync(`${list}.cities.json`, JSON.stringify({ at: eightDaysAgo, missing: [], cities }));
  // 偽のサイト（このファイルの fakeSite と同じ形）。13-113 の市区ページだけ 404。物件ページは読める形で返す
  const preload = path.join(dir, "stub.mjs");
  fs.writeFileSync(preload, `
import { config } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)};
config.minDelayMs = 0;
const site = ${JSON.stringify(BIG)};
const prefHtml = ${prefHtml.toString()};
const pager = ${pager.toString()};
const cityHtml = ${cityHtml.toString()};
globalThis.fetch = async (url) => {
  const u = String(url);
  const r = (status, body) => ({ ok: status < 300, status, text: async () => body, headers: { get: () => null } });
  if (!u.startsWith("https://www.navipark1.com/")) throw new Error("偽のサイトの外: " + u);
  if (u.endsWith("/robots.txt")) return r(404, "");
  let m = u.match(/searchAreaList-(\\d+)\\/$/);
  if (m) return r(200, prefHtml(Object.keys(site[m[1]] ?? {})));
  m = u.match(/parkingDetail\\/(\\w+)\\.html$/);
  if (m) return r(200, "<html><head><title>" + m[1] + "駐車場｜ナビパーク</title></head><body><table><tr><th>所在地</th><td>東京都テスト区1-1</td></tr></table>" +
    "<table class=\\"table05\\"><tr><th>料金体系</th><th>時間帯</th><th>単位・金額</th><th>備考</th></tr><tr><td>全曜日</td><td>8:00 ～ 22:00</td><td>30分 / 300円</td><td></td></tr></table></body></html>");
  if (/parkingList-13-113\\/$/.test(u)) return r(404, "");
  let city, page;
  if ((m = u.match(/parkingList-(\\d+-\\d+)\\/$/))) { city = m[1]; page = 1; }
  else if ((m = u.match(/prefCD=(\\d+)&cityCD=(\\d+)&page=(\\d+)$/))) { city = m[1] + "-" + m[2]; page = Number(m[3]); }
  const all = city && site[city.split("-")[0]]?.[city];
  if (!all) return r(404, "");
  return r(200, cityHtml(city, page, all.slice((page - 1) * 10, page * 10), all.length));
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_ONLY: "navipark", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl" },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, 0, log);
  const health = JSON.parse(fs.readFileSync(path.join(dir, "data/health/test.json"), "utf8")).targets;
  assert.equal(health.length, 1, log);
  assert.deepEqual([health[0].op, health[0].ok, health[0].n], ["navipark", true, 240]);
  assert.match(health[0].reason, /^一覧づくりで取れなかった市区・都道府県1か所（市区13-113 1ページ目が HTTP 404）。その分は前の一覧の番号5件を残した$/);
  assert.match(log, /::warning::\[ナビパーク\] 市区13-113 が取れなかった（1ページ目が HTTP 404）/);
  assert.deepEqual(new Set(readLines(list)), new Set(ALL_BIG));            // 13-113 の5件も一覧に残る
  assert.notEqual(fs.readFileSync(`${list}.fetched`, "utf8"), eightDaysAgo);
});
