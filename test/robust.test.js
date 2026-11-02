// 相手先の告知・転送・一覧の縮みへの守りのテスト（npm test）。事業者サイトには繋がない（fetch を差し替える）。
// 2026-11-02 の点検（maintenance の maint-02・08・09）で見つかったこと:
//   ・告知を HTTP 200 で返すサイトを巡回の途中で見分けられず、セイワパークは 10/22〜10/30 の14回、毎回344件「取れた」と記録して
//     料金の無い「メンテナンス中」の行を342件書いた。パークネットは告知のページへ転送される94市区を毎回最後まで取っていた
//   ・転送は fetch が追っていて、転送先の robots.txt（ホストもパスも）を見ず、2回目を間をあけずに送っていた
//   ・一覧づくりの多くに「前より極端に少なければ前の一覧を使う」守りが無く、セイワパーク・近鉄不動産は途中の1ページが取れないと
//     そこで一覧を打ち切って上書きしていた
// 告知のページは、その日に返ってきたもの（パークネットの告知・robots.txt。点検で保存したもの）を元にしている
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";
import { politeFetch, fetchOnceIgnoringRobots, _resetRobotsCache } from "../src/polite-fetch.js";
import { lotNotice, hasFee, pageSig, makeSameStreak, makeNoticeGuard, feeRateOf, maintenanceOf } from "../src/maintenance.js";
import { snapshotList, guardShrunkList } from "../src/list-guard.js";
import { dominantKind } from "../src/health-kind.js";
import { crawlParknetCity, crawlParknetCities } from "../src/parknet-enumerate.js";
import { cityListUrl, prefListUrl } from "../src/parknet.js";
import { listHash } from "../src/repark-enumerate.js";
import { areaListUrl } from "../src/gspark.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
config.minDelayMs = 0;

// ---- 点検の日に返ってきたページ（2026-11-01 に保存。パークネットは 10/22 から告知のまま） ----
// robots.txt（「Disallow: /・Allow: /parknet/」）
const PARKNET_ROBOTS = "#「＊」ですべてのクローラを制限する\nUser-agent: *\nDisallow: /       # まず全体を禁止\nAllow: /parknet/  # 特定フォルダのみ許可";
// 市区の一覧の転送先（/parknet/index.html）。題名はいつもどおりで、本文だけが告知（スクリプト・スタイルを除いた形）
const PARKNET_NOTICE = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><title>パークネット | 新明和工業株式会社</title>
<script>(function(i,s,o,g,r,a,m){i['GoogleAnalyticsObject']=r;})(window,document,'script','//www.google-analytics.com/analytics.js','ga');</script>
<style>body { margin: 0; min-height: 100vh; display: flex; }</style></head>
<body><div class="box"><h2>ただいまメンテナンス中です</h2><p>ご不便をおかけいたしますが、しばらくお待ちください。</p></div></body></html>`;
const PN = "https://parknet.shinmaywa.co.jp";
// セイワパークが 10/22〜10/30 に返していた告知（題名「メンテナンス中」・料金なし）
const SEIWA_NOTICE = `<!doctype html><html><head><title>メンテナンス中</title></head><body><h1>メンテナンス中</h1><p>ただいまメンテナンス中です。</p></body></html>`;

/** 差し替えた fetch（このプロセスの中だけ）。url → 本文（文字列）か { status, body, location }。呼ばれた URL と時刻・redirect を控える */
function stubFetch(routes, fallback = { status: 404 }) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, at: Date.now(), redirect: opts?.redirect });
    let r = routes[u] ?? (u.endsWith("/robots.txt") ? "" : fallback);
    const body = typeof r === "string" ? r : r.body ?? "";
    const status = typeof r === "string" ? 200 : r.status;
    return { ok: status >= 200 && status < 300, status, text: async () => body,
      headers: { get: (k) => (k.toLowerCase() === "location" && typeof r === "object" ? r.location ?? null : null) } };
  };
  return calls;
}
const urls = (calls) => calls.map((c) => c.url);

// ==== maint-08: 転送のたびに robots.txt（ホストとパス）を確かめ、間隔をあける ====

test("転送: 同じホストの許されたパスへの転送はたどる（パークネットの市区の一覧 → 告知のページ）。fetch には転送を追わせない", async () => {
  _resetRobotsCache();
  const list = cityListUrl("01", "札幌市中央区", 0);
  const to = `${PN}/parknet/index.html?pref_cd=01&city=%E6%9C%AD%E5%B9%8C%E5%B8%82%E4%B8%AD%E5%A4%AE%E5%8C%BA`;
  const calls = stubFetch({ [`${PN}/robots.txt`]: PARKNET_ROBOTS, [list]: { status: 302, location: to }, [to]: PARKNET_NOTICE });
  const r = await politeFetch(list);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.equal(r.url, to);
  assert.equal(r.movedTo, undefined);                          // 同じホストなので「移った」とはしない
  assert.equal(maintenanceOf(r.html), "ただいまメンテナンス中です");
  assert.deepEqual(urls(calls), [`${PN}/robots.txt`, list, to]);
  assert.ok(calls.every((c) => c.redirect === "manual"));      // 転送は自分で1回ずつたどる
});

test("転送: 同じホストでも robots.txt で禁止のパスへの転送は取りに行かない（パークネットが / の外へ転送したとき）", async () => {
  _resetRobotsCache();
  const list = cityListUrl("01", "札幌市中央区", 0);
  const calls = stubFetch({ [`${PN}/robots.txt`]: PARKNET_ROBOTS, [list]: { status: 302, location: "/maintenance.html" } }, "禁止のページ");
  const r = await politeFetch(list);
  assert.equal(r.ok, false);
  assert.match(r.skippedReason, /^転送先（parknet\.shinmaywa\.co\.jp）の robots\.txt で Disallow: \/maintenance\.html$/);
  assert.equal(r.location, "/maintenance.html");
  assert.deepEqual(urls(calls), [`${PN}/robots.txt`, list]);   // 転送先は送っていない
});

test("転送: 別のホストへの転送は、そのホストの robots.txt を先に見る。許されればたどって movedTo、断られたら送らない", async () => {
  _resetRobotsCache();
  const calls = stubFetch({
    "https://old.example/p/1": { status: 301, location: "https://new.example/p/1" }, "https://new.example/p/1": "新しいページ",
    "https://old.example/p/2": { status: 301, location: "https://deny.example/p/2" }, "https://deny.example/robots.txt": { status: 403 },
    "https://old.example/p/3": { status: 301, location: "https://dis.example/private/3" },
    "https://dis.example/robots.txt": "User-agent: *\nDisallow: /private/\n",
  });
  const a = await politeFetch("https://old.example/p/1");
  assert.equal(a.ok, true);
  assert.equal(a.html, "新しいページ");
  assert.equal(a.movedTo, "https://new.example/p/1");
  const b = await politeFetch("https://old.example/p/2");
  // 別のホストの robots.txt で断られたのは、その転送先だけの話。この社に断られた（blocked）としない（2026-11-02 点検の訂正）
  assert.equal(b.ok, false);
  assert.equal(b.blocked, undefined);
  assert.equal(b.redirectBlocked, true);
  assert.equal(b.status, 301);
  assert.match(b.skippedReason, /^転送先（deny\.example）の robots\.txt が HTTP 403/);
  assert.equal(b.movedTo, "https://deny.example/p/2");
  const c = await politeFetch("https://old.example/p/3");
  assert.equal(c.ok, false);
  assert.match(c.skippedReason, /Disallow: \/private\/3/);
  assert.deepEqual(urls(calls), [
    "https://old.example/robots.txt", "https://old.example/p/1", "https://new.example/robots.txt", "https://new.example/p/1",
    "https://old.example/p/2", "https://deny.example/robots.txt",
    "https://old.example/p/3", "https://dis.example/robots.txt",
  ]);
});

test("転送: 別のホストの robots.txt に届かない（503・通信の失敗）・メンテナンスでも、その転送先1件の見送り（transient にしない）", async () => {
  _resetRobotsCache();
  stubFetch({
    "https://a.example/lot/1": { status: 302, location: "https://c.example/lot/1" }, "https://c.example/robots.txt": { status: 503 },
    "https://a.example/lot/2": { status: 302, location: "https://m.example/lot/2" },
    "https://m.example/robots.txt": { status: 503, body: "<title>メンテナンス中</title>" },
    "https://a.example/lot/3": { status: 302, location: "https://a.example/lot/3/" }, "https://a.example/lot/3/": "同じホスト",
  });
  const c = await politeFetch("https://a.example/lot/1");
  assert.equal(c.transient, undefined);
  assert.equal(c.redirectBlocked, true);
  assert.match(c.skippedReason, /^転送先（c\.example）の robots\.txt に届かない/);
  assert.equal(c.robotsError, "HTTP 503");
  const m = await politeFetch("https://a.example/lot/2");
  assert.equal(m.transient, undefined);
  assert.equal(m.maintenance, undefined);
  assert.equal(m.redirectBlocked, true);
  assert.equal((await politeFetch("https://a.example/lot/3")).html, "同じホスト");
});

test("転送: http → https のようにホストが同じ転送は「移った」としない（robots.txt は https の側でも確かめる）", async () => {
  _resetRobotsCache();
  const calls = stubFetch({ "http://same.example/p": { status: 301, location: "https://same.example/p" }, "https://same.example/p": "ok" });
  const r = await politeFetch("http://same.example/p");
  assert.equal(r.html, "ok");
  assert.equal(r.movedTo, undefined);
  assert.deepEqual(urls(calls), ["http://same.example/robots.txt", "http://same.example/p", "https://same.example/robots.txt", "https://same.example/p"]);
});

test("転送: 転送の2回目もいつもの間隔をあけて送る（以前は間をあけずにすぐ送っていた）", async () => {
  _resetRobotsCache();
  const saved = config.minDelayMs;
  config.minDelayMs = 60;
  try {
    const calls = stubFetch({ "https://pace.example/a": { status: 302, location: "/b" }, "https://pace.example/b": "ok" });
    const r = await politeFetch("https://pace.example/a");
    assert.equal(r.html, "ok");
    assert.deepEqual(urls(calls), ["https://pace.example/robots.txt", "https://pace.example/a", "https://pace.example/b"]);
    for (let i = 1; i < calls.length; i++) assert.ok(calls[i].at - calls[i - 1].at >= 55, `${calls[i].url}: ${calls[i].at - calls[i - 1].at}ms`);
  } finally { config.minDelayMs = saved; }
});

test("転送: redirect: manual の社（エコロ・名鉄協商の閉鎖の転送）は今までどおり追わずに 3xx と転送先を返す", async () => {
  _resetRobotsCache();
  const calls = stubFetch({ "https://mkp.example/d/1": { status: 302, location: "../../misc/404.php" } }, "x");
  const r = await politeFetch("https://mkp.example/d/1", { redirect: "manual" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "../../misc/404.php");
  assert.deepEqual(urls(calls), ["https://mkp.example/robots.txt", "https://mkp.example/d/1"]);
});

test("転送: 5回を超えて転送が続いたら止める（ぐるぐる回る転送で送り続けない）", async () => {
  _resetRobotsCache();
  const routes = {};
  for (let i = 0; i < 20; i++) routes[`https://loop.example/${i}`] = { status: 302, location: `/${i + 1}` };
  const calls = stubFetch(routes);
  const r = await politeFetch("https://loop.example/0");
  assert.equal(r.ok, false);
  assert.equal(r.status, 302);
  assert.equal(urls(calls).filter((u) => !u.endsWith("/robots.txt")).length, 6);   // 最初の1回＋転送5回
});

test("転送: robots.txt を見ない入口の確かめ（fetchOnceIgnoringRobots）も1回ずつたどり、別のホストへは robots.txt を見てから", async () => {
  _resetRobotsCache();
  const calls = stubFetch({
    "https://top.example/": { status: 302, location: "/maint/" }, "https://top.example/maint/": "<title>メンテナンス中</title>",
    "https://top2.example/": { status: 302, location: "https://other.example/x" }, "https://other.example/robots.txt": "User-agent: *\nDisallow: /\n",
  });
  const a = await fetchOnceIgnoringRobots("https://top.example/");
  assert.equal(a.html, "<title>メンテナンス中</title>");
  const b = await fetchOnceIgnoringRobots("https://top2.example/");
  assert.equal(b.ok, false);
  assert.equal(b.status, 302);
  // 同じ origin の中は robots.txt を見ない（入口の robots.txt が 401・403 のときだけ使う）。別の origin は robots.txt で禁止なので送らない
  assert.deepEqual(urls(calls), ["https://top.example/", "https://top.example/maint/", "https://top2.example/", "https://other.example/robots.txt"]);
});

// ==== maint-02: 巡回の途中で告知を見分ける部品 ====

test("物件ページの告知: 題名で見る。本文は物件の名前が読めないときだけ（予告の帯のある普段のページでは止めない）", () => {
  assert.equal(lotNotice(SEIWA_NOTICE, { name: "メンテナンス中" }), "メンテナンス中");
  assert.equal(lotNotice(PARKNET_NOTICE, null), "ただいまメンテナンス中です");          // 題名はいつもどおり・名前なし → 本文で見る
  const banner = `<html><head><title>天神1丁目駐車場｜JQパークス</title></head><body><div class="info">11/10 2:00〜5:00 はサービスを停止いたします</div><h1>天神1丁目駐車場</h1></body></html>`;
  assert.equal(lotNotice(banner, { name: "天神1丁目駐車場" }), null);
  assert.equal(lotNotice("", null), null);
});

test("料金が読めたか・ふだんの料金の読めた割合（前の記録から。物件が少なければ比べない）", () => {
  assert.equal(hasFee({ unitCharges: [{ amountYen: 100 }], maxFees: [] }), true);
  assert.equal(hasFee({ unitCharges: [], maxFees: [{ amountYen: 700 }] }), true);
  assert.equal(hasFee({ name: "メンテナンス中", unitCharges: [], maxFees: [] }), false);
  assert.equal(hasFee(null), false);
  const recs = [...Array.from({ length: 97 }, () => ({ operator: "seiwapark", maxFees: [{ amountYen: 700 }] })),
    ...Array.from({ length: 3 }, () => ({ operator: "seiwapark", maxFees: [] })), { operator: "times", maxFees: [] }];
  assert.equal(feeRateOf(recs, "seiwapark"), 0.97);
  assert.equal(feeRateOf(recs, "times"), null);
});

test("続けて同じ: 違う鍵が n 件続けて同じ値なら true。値が変わる・空なら数え直す。同じ鍵の取り直しは1件と数える", () => {
  const s = makeSameStreak(3);
  assert.equal(s.push("a", "x"), false);
  assert.equal(s.push("a", "x"), false);
  assert.equal(s.push("b", "x"), false);
  assert.equal(s.push("c", "y"), false);
  assert.equal(s.push("d", "y"), false);
  assert.equal(s.push("e", null), false);
  assert.equal(s.count, 0);
  for (const k of ["f", "g"]) assert.equal(s.push(k, "z"), false);
  assert.equal(s.push("h", "z"), true);
  assert.equal(pageSig("<p>a  b</p>\n"), pageSig("<p>a b</p>"));
  assert.notEqual(pageSig("<p>a</p>"), pageSig("<p>b</p>"));
});

test("見張り: 違う物件のページが5件続けて同じ名前で料金なしなら止める（セイワパークの「メンテナンス中」342件）。料金が読めたら数え直す", () => {
  const g = makeNoticeGuard();
  for (let i = 0; i < 4; i++) assert.equal(g.page({ id: `s${i}`, html: `<p>${i}</p>`, name: "メンテナンス中", fee: false }), null);
  const trip = g.page({ id: "s4", html: "<p>4</p>", name: "メンテナンス中", fee: false });
  assert.equal(trip.kind, "maintenance");
  assert.match(trip.why, /5件続けて同じ名前（「メンテナンス中」）/);
  const h = makeNoticeGuard();
  for (let i = 0; i < 4; i++) h.page({ id: `s${i}`, html: `<p>${i}</p>`, name: "同じ名前", fee: false });
  assert.equal(h.page({ id: "x", html: "<p>x</p>", name: "同じ名前", fee: true }), null);   // 料金が読めた物件で数え直す
  for (let i = 5; i < 9; i++) assert.equal(h.page({ id: `s${i}`, html: `<p>${i}</p>`, name: "同じ名前", fee: false }), null);
});

test("見張り: 同じ中身（0バイトのページ・番号を名前にする社の告知）が5件続いたら止める。言葉に頼らない", () => {
  const g = makeNoticeGuard();
  // タマパーク・キョウテク・ル・パルクは名前が読めないと番号を名前にするので、名前は毎回違う
  for (let i = 0; i < 4; i++) assert.equal(g.page({ id: `${i}`, html: "", name: `${i}`, fee: false }), null);
  const trip = g.page({ id: "4", html: "", name: "4", fee: false });
  assert.equal(trip.kind, "maintenance");
  assert.match(trip.why, /5件続けて同じ中身（0バイト）/);
});

test("見張り: 同じ名前・同じ中身で止めるとき、告知の言葉も無く中身も短くなければ parse（作りの変更の見込み。待てばよいと読ませない）", () => {
  const body = (extra = "") => `<html><head><title>駐車場</title></head><body>${"<div class=\"app\"></div>".repeat(20)}${extra}</body></html>`;
  const g = makeNoticeGuard();
  let trip = null;
  for (let i = 0; i < 5 && !trip; i++) trip = g.page({ id: `${i}`, html: body(), name: "駐車場", fee: false });
  assert.equal(trip.kind, "parse");
  assert.match(trip.why, /5件続けて同じ名前（「駐車場」）で、料金が読めない。告知かページの作りの変更の見込み/);
  // 本文に止まっている最中の言い回しがあれば maintenance
  const h = makeNoticeGuard();
  trip = null;
  for (let i = 0; i < 5 && !trip; i++) trip = h.page({ id: `${i}`, html: body("<p>ただいまメンテナンス中です</p>"), name: "駐車場", fee: false });
  assert.equal(trip.kind, "maintenance");
  assert.match(trip.why, /告知のページの見込み$/);
  // 同じ中身（名前は番号で毎回違う）でも同じ
  const k = makeNoticeGuard();
  trip = null;
  for (let i = 0; i < 5 && !trip; i++) trip = k.page({ id: `${i}`, html: body(), name: `${i}`, fee: false });
  assert.equal(trip.kind, "parse");
  assert.match(trip.why, /5件続けて同じ中身/);
});

test("見張り: 料金の読めた割合がふだん（97%）の半分を下回ったら止める。告知の言葉を見ていれば maintenance、無ければ parse", () => {
  const run = (notice) => {
    const g = makeNoticeGuard({ normalFeeRate: 0.97 });
    let trip = null, i = 0;
    for (; i < 40 && !trip; i++) {
      const fee = i % 4 === 0;                                    // 25% しか読めない
      trip = g.page({ id: `${i}`, html: `<p>${i}</p>`, name: `物件${i}`, fee, notice: i === 3 && notice ? "メンテナンスのお知らせ" : null });
    }
    return { trip, i };
  };
  const a = run(false);
  assert.equal(a.i, 20);                                         // 20件取った時点で比べる
  assert.equal(a.trip.kind, "parse");
  assert.match(a.trip.why, /料金の読めた物件が20件中5件（25%）で、ふだん（97%）より大きく少ない/);
  assert.equal(run(true).trip.kind, "maintenance");
  // ふだんから料金の無い物件が多い社（JQパークスは約半分）は割合で止めない
  const jq = makeNoticeGuard({ normalFeeRate: 0.5 });
  for (let i = 0; i < 40; i++) assert.equal(jq.page({ id: `${i}`, html: `<p>${i}</p>`, name: `物件${i}`, fee: i % 4 === 0 }), null);
});

test("失敗の種類の多数決に maintenance も入る（告知だけで打ち切った回が parse にならない）", () => {
  assert.equal(dominantKind({ maintenance: 8 }), "maintenance");
  assert.equal(dominantKind({ maintenance: 4, parse: 4 }), "maintenance");
  assert.equal(dominantKind({ blocked: 2, maintenance: 2 }), "blocked");
});

// ==== maint-09: 一覧の縮みの守り（list-guard.js） ====

function listDir(n, { stamp = "2026-10-01T00:00:00.000Z" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "list-guard-"));
  const file = path.join(dir, "x-ids.txt");
  const prev = Array.from({ length: n }, (_, i) => `id${i}`);
  fs.writeFileSync(file, prev.join("\n") + "\n");
  if (stamp) fs.writeFileSync(`${file}.fetched`, stamp);
  return { dir, file, prev };
}
/** 一覧づくりが作り直した形（ファイルを上書きして取得日を進める） */
function rebuild(file, list) { fs.writeFileSync(file, list.join("\n") + "\n"); fs.writeFileSync(`${file}.fetched`, new Date().toISOString()); return list; }

test("一覧の縮み: 作り直した一覧が前の9割未満かつ10件以上減ったら、ファイルと取得日を前に戻して前の一覧（staleReason つき）を使う", () => {
  const { file, prev } = listDir(100);
  const snap = snapshotList(file);
  const list = rebuild(file, prev.slice(0, 20));                 // セイワパーク: 2ページ目が取れず1ページ目だけで打ち切った形
  const got = guardShrunkList({ op: "seiwapark", label: "セイワパーク", file, snap, prev, list, env: {} });
  assert.deepEqual([...got], prev);
  assert.match(got.staleReason, /^一覧を作り直せていない: 一覧が100件 → 20件に減った（90%未満は作り直しの失敗とみなす）/);
  assert.equal(fs.readFileSync(file, "utf8"), prev.join("\n") + "\n");
  assert.equal(fs.readFileSync(`${file}.fetched`, "utf8"), "2026-10-01T00:00:00.000Z");   // 取得日も戻す＝次の回にまた作り直す
});

test("一覧の縮み: 前の一覧に戻すときも、一覧づくりが付けた補足（listNote・listInfo）は残す", () => {
  const { file, prev } = listDir(100);
  const snap = snapshotList(file);
  const list = rebuild(file, prev.slice(0, 30));
  list.listNote = "一部の市区が取れなかった";
  list.listInfo = { pages: 3 };
  const got = guardShrunkList({ op: "navipark", label: "ナビパーク", file, snap, prev, list, env: {} });
  assert.equal(got.length, 100);
  assert.equal(got.listNote, "一部の市区が取れなかった");
  assert.deepEqual(got.listInfo, { pages: 3 });
  assert.match(got.staleReason, /100件 → 30件/);
});

test("一覧の縮み: あなぶきの形（sitemap と和集合で66%残る）も9割の基準で気づく", () => {
  const { file, prev } = listDir(795);
  const snap = snapshotList(file);
  const got = guardShrunkList({ op: "anabuki", label: "あなぶきパーク", file, snap, prev, list: rebuild(file, prev.slice(0, 529)), env: {} });
  assert.equal(got.length, 795);
  assert.ok(got.staleReason);
});

test("一覧の縮み: 取得日が無かった一覧は、戻すときに取得日を消す（次の回に作り直す）", () => {
  const { file, prev } = listDir(100, { stamp: null });
  const snap = snapshotList(file);
  const got = guardShrunkList({ op: "kintetsu", label: "近鉄不動産", file, snap, prev, list: rebuild(file, prev.slice(0, 10)), env: {} });
  assert.equal(got.length, 100);
  assert.equal(fs.existsSync(`${file}.fetched`), false);
});

test("一覧の縮み: 9割以上・減り方が10件未満・作り直していない・前の一覧が無い・一覧づくりが自分で戻したときはそのまま", () => {
  const a = listDir(100);
  const snapA = snapshotList(a.file);
  const l1 = rebuild(a.file, a.prev.slice(0, 92));
  assert.equal(guardShrunkList({ op: "x", label: "x", file: a.file, snap: snapA, prev: a.prev, list: l1, env: {} }), l1);
  const b = listDir(30);                                          // 30件 → 21件（7割）でも9件しか減っていない（小さい社の入れ替わり）
  const snapB = snapshotList(b.file);
  const l2 = rebuild(b.file, b.prev.slice(0, 21));
  assert.equal(guardShrunkList({ op: "x", label: "x", file: b.file, snap: snapB, prev: b.prev, list: l2, env: {} }), l2);
  const c = listDir(100);                                         // キャッシュのまま（取得日が控えと同じ）
  const l3 = c.prev.slice(0, 10);
  assert.equal(guardShrunkList({ op: "x", label: "x", file: c.file, snap: snapshotList(c.file), prev: c.prev, list: l3, env: {} }), l3);
  const d = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "list-guard-")), "none.txt");   // 前の一覧が無い
  assert.equal(snapshotList(d), null);
  const l4 = ["a"];
  assert.equal(guardShrunkList({ op: "x", label: "x", file: d, snap: null, prev: null, list: l4, env: {} }), l4);
  const e = listDir(100);
  const snapE = snapshotList(e.file);
  const l5 = rebuild(e.file, e.prev.slice(0, 10)); l5.staleReason = "自前の守りで戻した";
  assert.equal(guardShrunkList({ op: "x", label: "x", file: e.file, snap: snapE, prev: e.prev, list: l5, env: {} }), l5);
});

test("一覧の縮み: LIST_SHRINK_OK に載せた社は、人が確かめたものとして新しい一覧を使う", () => {
  const { file, prev } = listDir(100);
  const snap = snapshotList(file);
  const list = rebuild(file, prev.slice(0, 50));
  const got = guardShrunkList({ op: "seiwapark", label: "セイワパーク", file, snap, prev, list, env: { LIST_SHRINK_OK: "kintetsu, seiwapark" } });
  assert.equal(got, list);
  assert.equal(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length, 50);
});

// ==== パークネット: 告知の0件のページで打ち切る ====

test("パークネット: 0件のページが告知なら、その市区で stop（maintenance）。残りの市区は取りに行かない", async () => {
  const asked = [];
  const fetchPage = async (u) => { asked.push(u); return { ok: true, status: 200, html: PARKNET_NOTICE }; };
  const r = await crawlParknetCity("01", "札幌市中央区", { fetchPage });
  assert.equal(r.stopKind, "maintenance");
  assert.match(r.stop, /メンテナンスの告知（「ただいまメンテナンス中です」）/);
  assert.equal(r.stopRes.maintenance, "ただいまメンテナンス中です");
  const quiet = { log() {}, warn() {}, error() {} };
  const sum = await crawlParknetCities(["01\t札幌市中央区", "13\t台東区", "30\t和歌山市"], {
    crawlCity: (p, c, o) => crawlParknetCity(p, c, { ...o, fetchPage }), log: quiet });
  assert.equal(sum.stopKind, "maintenance");
  assert.equal(asked.length, 2);                                // 1市区目の1ページで止める（2回目の呼び出しは上の1市区ぶん）
});

test("パークネット: 違う市区の1ページ目が5件続けて同じ中身で0件（0バイトの 200）なら、告知とみなして打ち切る", async () => {
  const quiet = { log() {}, warn() {}, error() {} };
  const lines = Array.from({ length: 12 }, (_, i) => `01\t市${i}`);
  let n = 0;
  const fetchPage = async () => { n++; return { ok: true, status: 200, html: "" }; };
  const sum = await crawlParknetCities(lines, { crawlCity: (p, c, o) => crawlParknetCity(p, c, { ...o, fetchPage }), log: quiet });
  assert.equal(n, 5);
  assert.equal(sum.stopKind, "maintenance");
  assert.match(sum.stop, /違う市区のページが5件続けて同じ中身で0件/);
  assert.equal(sum.stopRes.maintenance, "同じ中身の0件のページ");
});

// ==== 通しの巡回 ====

/** run.js を別のプロセスで通しで動かす（test/crawl-core.test.js と同じ作り。転送は fetch に追わせず 3xx のまま返す）。
 *  routes の値: { status, body, location }。"*robots" は robots.txt の既定、"*" はほかの既定 */
function runCrawl({ env = {}, routes = {}, files = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), "robust-")) }) {
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  const routesFile = path.join(dir, "routes.json");
  const callsFile = path.join(dir, "calls.txt");
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  fs.writeFileSync(callsFile, "");
  const preload = path.join(dir, "stub.mjs");
  fs.writeFileSync(preload, `
import fs from "node:fs";
import { config } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)};
config.minDelayMs = 0; config.timesMinDelayMs = 0;
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"));
globalThis.fetch = async function stub(url, opts) {
  const u = String(url);
  fs.appendFileSync(${JSON.stringify(callsFile)}, u + "\\n");
  let r = routes[u];
  if (r === undefined) r = u.endsWith("/robots.txt") ? (routes["*robots"] ?? { status: 404 }) : (routes["*"] ?? { status: 404 });
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "",
    headers: { get: (k) => (k.toLowerCase() === "location" ? r.location ?? null : null) } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_HOLD: "off", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl",
      REPARK_MAP_MAX_REQUESTS: "0", LIST_SHRINK_OK: "", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, 0, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const hf = path.join(dir, "data/health/test.json");
  const health = fs.existsSync(hf) ? JSON.parse(fs.readFileSync(hf, "utf8")).targets : null;
  const pf = path.join(dir, "data/prices-test.jsonl");
  const rows = fs.existsSync(pf) ? fs.readFileSync(pf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { calls, health, log, dir, rows, detail: calls.filter((u) => !u.endsWith("/robots.txt")) };
}
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
const ROBOTS_OK = { status: 200, body: "User-agent: *\nAllow: /\n" };

// セイワパークの一覧と状態（古い順）。番号は英字のスラッグ
const SW = (s) => `https://www.seiwapark.co.jp/search/${s}`;
function seiwaFiles(n, { fetched = new Date().toISOString() } = {}) {
  const ids = Array.from({ length: n }, (_, i) => `lot-${String(i).padStart(3, "0")}`);
  const state = { _list: listHash(ids) };
  ids.forEach((id, i) => { state[id] = new Date(Date.now() - (n + 5 - i) * 864e5).toISOString(); });
  return { ids, state, files: { "data/seiwapark-ids.txt": ids.join("\n") + "\n", "data/seiwapark-ids.txt.fetched": fetched,
    "data/seiwapark-crawl-state.json": JSON.stringify(state) } };
}

test("通しの巡回: セイワパークの告知（題名「メンテナンス中」・料金なし）は行を書かず、時刻も進めず、8件で打ち切る。health は maintenance", () => {
  const { ids, state, files } = seiwaFiles(30);
  const r = runCrawl({ env: { CRAWL_ONLY: "seiwapark", ROLLING_PER_RUN: "30" }, files,
    routes: { "*robots": { status: 200, body: "" }, "*": { status: 200, body: SEIWA_NOTICE } } });
  assert.equal(r.detail.length, 8);                              // 以前は344件すべて取って「取れた」と記録していた
  assert.equal(r.rows.length, 0);                                // 「メンテナンス中」の行を書かない
  const after = readJson(r.dir, "data/seiwapark-crawl-state.json");
  for (const id of ids.slice(0, 8)) assert.equal(after[id], `${state[id]}|0|r`);   // 次の回に取り直す印だけ（日付は進めない）
  for (const id of ids.slice(8)) assert.equal(after[id], state[id]);
  const h = r.health[0];
  assert.equal(h.ok, false);
  assert.equal(h.kind, "maintenance");
  assert.match(h.reason, /8件続けて取れず。最後は メンテナンスの告知（「メンテナンス中」）/);
  // 巡回の最後に入口を取り直してメンテナンスを確かめることもしない（kind がもう maintenance）
  assert.ok(!r.calls.includes("https://www.seiwapark.co.jp/"));
});

test("通しの巡回: 告知の言葉が無くても、違う物件のページが5件続けて同じ名前・料金なしなら止め、その5件は書かない", () => {
  const { ids, state, files } = seiwaFiles(30);
  const page = `<!doctype html><html><head><title>お知らせ</title></head><body><h1>お知らせ</h1><p>しばらくお待ちください。</p></body></html>`;
  const r = runCrawl({ env: { CRAWL_ONLY: "seiwapark", ROLLING_PER_RUN: "30" }, files,
    routes: { "*robots": { status: 200, body: "" }, "*": { status: 200, body: page } } });
  assert.equal(r.detail.length, 5);
  assert.equal(r.rows.length, 0);
  const after = readJson(r.dir, "data/seiwapark-crawl-state.json");
  for (const id of ids.slice(0, 5)) assert.equal(after[id], `${state[id]}|0|r`);   // 時刻は進めず、取り直しの印を付ける
  for (const id of ids.slice(5)) assert.equal(after[id], state[id]);
  assert.equal(r.health[0].ok, false);
  assert.equal(r.health[0].kind, "maintenance");                 // 短いページなので告知の見込み
  assert.match(r.health[0].reason, /違う物件のページが5件続けて同じ名前（「お知らせ」）で、料金が読めない。告知のページの見込み。.*料金の読めなかった5件は行を書かずに次の回に取り直す/);
  // 次の回: 印の付いた5件は見張りに数えず、印の無い5件でまた止まる（本当の告知なら毎回止まる）。印の付いた5件は時刻だけ進める
  const r2 = runCrawl({ env: { CRAWL_ONLY: "seiwapark", ROLLING_PER_RUN: "30" }, dir: r.dir,
    routes: { "*robots": { status: 200, body: "" }, "*": { status: 200, body: page } } });
  assert.deepEqual(r2.detail, ids.slice(0, 10).map(SW));
  assert.equal(r2.rows.length, 0);
  const after2 = readJson(r.dir, "data/seiwapark-crawl-state.json");
  for (const id of ids.slice(0, 5)) assert.ok(after2[id] > state[ids.at(-1)] && !after2[id].endsWith("|r"), after2[id]);
  for (const id of ids.slice(5, 10)) assert.equal(after2[id], `${state[id]}|0|r`);
  assert.equal(r2.health[0].kind, "maintenance");
  assert.match(r2.health[0].reason, /料金の読めなかった10件は行を書かずに次の回に取り直す（2回目の5件は時刻だけ進める）/);
});

test("通しの巡回: 閉じた物件が同じ雛形（名前は会社名・料金なし）を5件続けて返す社は、1回目は止めても2回目で書いて時刻を進め、3回目は先へ進む", () => {
  const { ids, state, files } = seiwaFiles(30);
  // 閉じた物件の雛形（10/30 の写しでも、名前が「セイワパーク株式会社」で料金の無い物件が11件あった）。告知の言葉は無く、中身も短くない
  const closed = `<html><head><title>セイワパーク株式会社</title></head><body>${"<div class=\"c-nav\"><a href=\"/\">駐車場を探す</a></div>".repeat(8)}</body></html>`;
  const lot = (n) => `<html><head><title>${n} | セイワパーク</title></head><body><h1 class="p-parking-detail__heading">${n}</h1><table>` +
    `<tr><th>住所</th><td>東京都千代田区1-1</td></tr><tr><th>料金形態</th><td>全日 8:00～22:00 30分 200円</td></tr></table></body></html>`;
  const routes = { "*robots": { status: 200, body: "" }, "*": { status: 404 } };
  ids.forEach((id, i) => { routes[SW(id)] = { status: 200, body: i < 5 ? closed : lot(`セイワパーク${id}`) }; });
  const env = { CRAWL_ONLY: "seiwapark", ROLLING_PER_RUN: "10" };
  const lots = (r) => r.detail.filter((u) => u.includes("/search/"));
  // 1回目: 先頭の5件が同じ雛形なので止める（kind は parse。告知の言葉が無いので「作りの変更の見込み」も添える）
  const r1 = runCrawl({ env, files, routes });
  assert.deepEqual(lots(r1), ids.slice(0, 5).map(SW));
  assert.equal(r1.rows.length, 0);
  assert.equal(r1.health[0].kind, "parse");
  assert.match(r1.health[0].reason, /5件続けて同じ名前（「セイワパーク株式会社」）で、料金が読めない。告知かページの作りの変更の見込み/);
  for (const id of ids.slice(0, 5)) assert.equal(readJson(r1.dir, "data/seiwapark-crawl-state.json")[id], `${state[id]}|0|r`);
  // 2回目: 印の付いた5件は数えないので止まらない。料金のある5件と一緒に書き、時刻を進める
  const r2 = runCrawl({ env, dir: r1.dir, routes });
  assert.deepEqual(lots(r2), ids.slice(0, 10).map(SW));
  assert.equal(r2.rows.length, 10);
  assert.equal(r2.health[0].ok, true);
  const s2 = readJson(r1.dir, "data/seiwapark-crawl-state.json");
  for (const id of ids.slice(0, 10)) assert.ok(s2[id] > state[ids.at(-1)] && !s2[id].endsWith("|r"), s2[id]);
  // 3回目: 先へ進む（以前の作りでは毎回先頭の5件で止まり続けた）
  const r3 = runCrawl({ env, dir: r1.dir, routes });
  assert.deepEqual(lots(r3), ids.slice(10, 20).map(SW));
  assert.equal(r3.health[0].ok, true);
  assert.equal(r3.rows.length, 20);                              // 前の回の10行＋今回の10行
});

test("通しの巡回: 1件の物件だけが別のホスト（robots.txt が 403・503）へ転送されても、その物件の見送りにして残りは取る（回を打ち切らない）", () => {
  const { ids, state, files } = seiwaFiles(10);
  const lot = (n) => `<html><head><title>${n} | セイワパーク</title></head><body><h1 class="p-parking-detail__heading">${n}</h1><table>` +
    `<tr><th>住所</th><td>東京都千代田区1-1</td></tr><tr><th>料金形態</th><td>全日 8:00～22:00 30分 200円</td></tr></table></body></html>`;
  const routes = { "*robots": { status: 200, body: "" }, "*": { status: 404 },
    "https://deny.example/robots.txt": { status: 403 }, "https://down.example/robots.txt": { status: 503 } };
  ids.forEach((id) => { routes[SW(id)] = { status: 200, body: lot(`セイワパーク${id}`) }; });
  routes[SW(ids[1])] = { status: 301, location: "https://deny.example/p/1" };
  routes[SW(ids[3])] = { status: 302, location: "https://down.example/p/3" };
  const r = runCrawl({ env: { CRAWL_ONLY: "seiwapark", ROLLING_PER_RUN: "10" }, files, routes });
  assert.deepEqual(r.detail, ids.map(SW));                       // 転送先には送らず、残りの物件はみな取る
  assert.equal(r.rows.length, 8);
  const h = r.health[0];
  assert.equal(h.ok, true);
  assert.notEqual(h.kind, "blocked");
  assert.deepEqual(h.movedTo, { "deny.example": 1, "down.example": 1 });
  const after = readJson(r.dir, "data/seiwapark-crawl-state.json");
  for (const id of ids) assert.ok(after[id] > state[ids.at(-1)] && !after[id].endsWith("|r"), `${id} ${after[id]}`);   // 転送の物件も時刻は進む（先頭に居座らない）
});

test("通しの巡回: 番号を名前にする社（タマパーク）の 0バイトのページも、同じ中身が5件続いたら止める", () => {
  const ids = Array.from({ length: 20 }, (_, i) => `p${i}`);
  const state = { _list: listHash(ids), ...Object.fromEntries(ids.map((id, i) => [id, new Date(Date.now() - (30 - i) * 864e5).toISOString()])) };
  const r = runCrawl({ env: { CRAWL_ONLY: "tamapark", ROLLING_PER_RUN: "20" },
    files: { "data/tamapark-ids.txt": ids.join("\n") + "\n", "data/tamapark-ids.txt.fetched": new Date().toISOString(),
      "data/tamapark-crawl-state.json": JSON.stringify(state) },
    routes: { "*robots": { status: 200, body: "" }, "*": { status: 200, body: "" } } });
  assert.equal(r.detail.length, 5);
  assert.equal(r.rows.length, 0);                                // 番号だけの名前の行を書かない
  const after = readJson(r.dir, "data/tamapark-crawl-state.json");
  for (const id of ids.slice(0, 5)) assert.equal(after[id], `${state[id]}|0|r`);   // 次の回に取り直す印
  for (const id of ids.slice(5)) assert.equal(after[id], state[id]);
  assert.equal(r.health[0].kind, "maintenance");
  assert.match(r.health[0].reason, /5件続けて同じ中身（0バイト）/);
});

// ---- タイムズの偽のページ（test/runjs.test.js と同じ形）----
const TU = (n) => `https://times-info.net/P13-tokyo/C101/park-detail-BUK${String(n).padStart(7, "0")}/`;
function timesPage(n, { fee = true } = {}) {
  const buk = `BUK${String(n).padStart(7, "0")}`, name = `タイムズテスト${n}`;
  return `<html><head><title>${name}（東京都千代田区丸の内1-1）の時間貸駐車場・満車/空車・料金情報 ｜タイムズ駐車場検索</title></head><body><h1 class="c-topInfo_ttl">${name}</h1>
<p class="p-basicInfo_table_td_address"><span class="p-basicInfo_table_td_address_txt"><span itemprop="addressRegion">東京都</span><span itemprop="addressLocality">千代田区</span><span itemprop="streetAddress">丸の内1-1</span></span></p>
<p>駐車場台数10台</p>
${fee ? `<!--▼▼▼全日の通常料金▼▼▼--><p class="c-ulTable_items_list_txt">00:00-00:00 30分 300円</p>` : ""}
<li class="s_areaBukListItem"><a href="/P13-tokyo/C101/park-detail-${buk}/"><p><span>1</span> ${name}</p><div class="s_bukIcon">0</div><p>本駐車場</p></a></li>
</body></html>`;
}
function timesFiles(n) {
  const list = Array.from({ length: n }, (_, i) => TU(i + 1));
  const state = { _list: listHash(list) };
  list.forEach((u, i) => { state[u] = `${new Date(Date.now() - (60 - i) * 864e5).toISOString()}|0`; });
  return { list, state, files: {
    "data/times-park-urls.txt": list.join("\n") + "\n", "data/times-park-urls.txt.fetched": new Date().toISOString(),
    "data/times-crawl-state.json": JSON.stringify(state) } };
}

test("通しの巡回: 料金の無い物件（名前はそれぞれ違う）は、止めなければ回の終わりにまとめて書く（行も時刻も今までどおり）", () => {
  const { list, files } = timesFiles(12);
  const routes = { "*robots": ROBOTS_OK, ...Object.fromEntries(list.map((u, i) => [u, { status: 200, body: timesPage(i + 1, { fee: i % 2 === 0 }) }])) };
  const r = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes });
  assert.equal(r.detail.length, 12);
  assert.equal(r.rows.length, 12);
  assert.equal(r.rows.filter((x) => !hasFee(x)).length, 6);
  assert.equal(r.health[0].ok, true);
  assert.equal(r.health[0].n, 12);
  const after = readJson(r.dir, "data/times-crawl-state.json");
  for (const u of list) assert.ok(after[u].startsWith(new Date().toISOString().slice(0, 10)), after[u]);
});

test("通しの巡回: 料金の読めた割合がふだん（前の記録で100%）の半分を下回ったら、20件で止めて料金の無い行は書かない（health は parse）", () => {
  const { list, state, files } = timesFiles(40);
  // 前の記録: 60件すべて料金あり（ふだんの割合 100%）
  const prevRows = Array.from({ length: 60 }, (_, i) => JSON.stringify({ operator: "times", parkId: `BUKX${i}`, name: `前${i}`,
    unitCharges: [{ scope: "全日", timeRange: "00:00-00:00", perMinutes: 30, amountYen: 300 }], maxFees: [], fetchedAt: "2026-10-01T00:00:00Z" }));
  const routes = { "*robots": ROBOTS_OK, ...Object.fromEntries(list.map((u, i) => [u, { status: 200, body: timesPage(i + 1, { fee: i % 5 === 0 }) }])) };
  const r = runCrawl({ env: { CRAWL_ONLY: "times" }, files: { ...files, "data/prices-test.jsonl": prevRows.join("\n") + "\n" }, routes });
  // 物件のページは20件で止める（そのあと parse の行なので、巡回の最後に入口を1回だけ見てメンテナンスかを確かめる）
  assert.deepEqual(r.detail, [...list.slice(0, 20), "https://times-info.net/"]);
  const fresh = r.rows.slice(60);
  assert.equal(fresh.length, 4);                                 // 料金の読めた4件だけ書く
  assert.ok(fresh.every(hasFee));
  const after = readJson(r.dir, "data/times-crawl-state.json");
  for (const [i, u] of list.slice(0, 20).entries()) {
    if (i % 5 === 0) assert.notEqual(after[u], state[u]);        // 書いた物件は時刻が進む
    else assert.equal(after[u], `${state[u]}|r`);                 // 書かなかった物件は次の回に取り直す（印だけ）
  }
  assert.equal(r.health[0].ok, false);
  assert.equal(r.health[0].kind, "parse");
  assert.match(r.health[0].reason, /料金の読めた物件が20件中4件（20%）で、ふだん（100%）より大きく少ない/);
});

test("通しの巡回: 別のホストへ転送された物件は、転送先の robots.txt を見てから取り、health に移った先のホストの数を残す", () => {
  const { list, files } = timesFiles(3);
  const routes = { "*robots": ROBOTS_OK };
  list.forEach((u, i) => {
    const to = u.replace("https://times-info.net/", "https://new-times.example/");
    routes[u] = { status: 301, location: to };
    routes[to] = { status: 200, body: timesPage(i + 1) };
  });
  const r = runCrawl({ env: { CRAWL_ONLY: "times" }, files, routes });
  assert.equal(r.calls.filter((u) => u === "https://new-times.example/robots.txt").length, 1);
  assert.equal(r.rows.length, 3);
  assert.equal(r.health[0].ok, true);
  assert.deepEqual(r.health[0].movedTo, { "new-times.example": 3 });
});

test("通しの巡回: セイワパークの一覧を作り直したら途中のページが取れず20件になった → 前の一覧で回し、ファイルも取得日も戻す（stale-list）", () => {
  const old = "2026-10-01T00:00:00.000Z";
  const { ids, files } = seiwaFiles(100, { fetched: old });
  const QS = "post_type=search&type%5B0%5D=35";
  const page1 = ids.slice(0, 20).map((id) => `<a href="https://www.seiwapark.co.jp/search/${id}">x</a>`).join("") + `<a href="/search/page/5">5</a>`;
  const r = runCrawl({ env: { CRAWL_ONLY: "seiwapark", ROLLING_PER_RUN: "3" }, files,
    routes: { "*robots": { status: 200, body: "" }, [`https://www.seiwapark.co.jp/search/?${QS}`]: { status: 200, body: page1 },
      [`https://www.seiwapark.co.jp/search/page/2?${QS}`]: { status: 503, body: "busy" } } });
  assert.equal(fs.readFileSync(path.join(r.dir, "data/seiwapark-ids.txt"), "utf8"), ids.join("\n") + "\n");
  assert.equal(fs.readFileSync(path.join(r.dir, "data/seiwapark-ids.txt.fetched"), "utf8"), old);
  assert.match(r.log, /全100件/);
  const h = r.health[0];
  assert.equal(h.ok, false);
  assert.equal(h.kind, "stale-list");
  assert.match(h.reason, /一覧が100件 → 20件に減った/);
});

test("通しの巡回: パークネットの市区の一覧が告知へ転送される（10/22〜）と、1市区目で止め、残りの市区は取らない。health は maintenance", () => {
  const cities = ["01\t札幌市中央区", "13\t台東区", "30\t和歌山市"];
  const routes = { [`${PN}/robots.txt`]: { status: 200, body: PARKNET_ROBOTS } };
  for (const line of cities) {
    const [p, c] = line.split("\t");
    routes[cityListUrl(p, c, 0)] = { status: 302, location: `${PN}/parknet/index.html?pref_cd=${p}` };
    routes[`${PN}/parknet/index.html?pref_cd=${p}`] = { status: 200, body: PARKNET_NOTICE };
  }
  const r = runCrawl({ env: { CRAWL_ONLY: "parknet" }, routes,
    files: { "data/parknet-cities.txt": cities.join("\n") + "\n", "data/parknet-cities.txt.fetched": new Date().toISOString() } });
  assert.deepEqual(r.detail, [cityListUrl("01", "札幌市中央区", 0), `${PN}/parknet/index.html?pref_cd=01`]);
  const h = r.health[0];
  assert.equal(h.ok, false);
  assert.equal(h.kind, "maintenance");
  assert.match(h.reason, /メンテナンスの告知（「ただいまメンテナンス中です」）/);
});

test("通しの巡回: パークネットの入口が告知なら、一覧の失敗を maintenance と記録し、最後に同じ入口を取り直さない", () => {
  const routes = { [`${PN}/robots.txt`]: { status: 200, body: PARKNET_ROBOTS },
    [`${PN}/parknet/search/`]: { status: 302, location: `${PN}/parknet/index.html` }, [`${PN}/parknet/index.html`]: { status: 200, body: PARKNET_NOTICE } };
  const r = runCrawl({ env: { CRAWL_ONLY: "parknet" }, routes,
    files: { "data/parknet-cities.txt": "01\t札幌市中央区\n", "data/parknet-cities.txt.fetched": "2026-10-01T00:00:00.000Z" } });
  assert.deepEqual(r.detail, [`${PN}/parknet/search/`, `${PN}/parknet/index.html`]);   // 以前は最後の確かめでもう2回送っていた
  assert.equal(r.health[0].kind, "maintenance");
  assert.match(r.health[0].reason, /^一覧: パークネット トップ: 相手先のサイトがメンテナンス中（「ただいまメンテナンス中です」）/);
});

test("通しの巡回: パークネットの市区の一覧を作り直したら都道府県ページが1つ取れず極端に減った → 前の一覧で回し、health は stale-list", () => {
  const prev = Array.from({ length: 40 }, (_, i) => `${i < 20 ? "01" : "13"}\t市${i}`);
  const top = `<a href="city_list_01.html">北海道</a><a href="city_list_13.html">東京都</a>`;
  // 北海道のページは5市区だけ載せて返り、東京都のページは 503（以前はそのまま飛ばして5市区の一覧で上書きし、7日間使っていた）
  const hokkaido = Array.from({ length: 5 }, (_, i) => `<a href="list.html?pref_cd=01&city=${encodeURIComponent(`市${i}`)}">x</a>`).join("");
  const routes = { [`${PN}/robots.txt`]: { status: 200, body: PARKNET_ROBOTS }, [`${PN}/parknet/search/`]: { status: 200, body: top },
    [prefListUrl("01")]: { status: 200, body: hokkaido }, [prefListUrl("13")]: { status: 503, body: "busy" } };
  const r = runCrawl({ env: { CRAWL_ONLY: "parknet" }, routes,
    files: { "data/parknet-cities.txt": prev.join("\n") + "\n", "data/parknet-cities.txt.fetched": "2026-10-01T00:00:00.000Z" } });
  assert.equal(fs.readFileSync(path.join(r.dir, "data/parknet-cities.txt"), "utf8"), prev.join("\n") + "\n");
  assert.equal(fs.readFileSync(path.join(r.dir, "data/parknet-cities.txt.fetched"), "utf8"), "2026-10-01T00:00:00.000Z");
  assert.match(r.log, /市区40件を巡回/);
  assert.equal(r.detail.filter((u) => u.includes("/list.html?")).length, 40);   // 前の一覧の40市区を回る（市区のページは 404）
  const h = r.health[0];
  assert.equal(h.ok, false);
  assert.equal(h.kind, "stale-list");
  assert.match(h.reason, /^一覧を作り直せていない: 一覧が40件 → 5件に減った/);
});

test("通しの巡回: GSパークのエリアのページが5件続けて同じ中身で0件なら打ち切る。告知の言葉があれば1件目で止める", () => {
  const codes = Array.from({ length: 8 }, (_, i) => `A${i}`);
  const files = { "data/gspark-areas.txt": codes.join("\n") + "\n", "data/gspark-areas.txt.fetched": new Date().toISOString() };
  const a = runCrawl({ env: { CRAWL_ONLY: "gspark" }, files, routes: { "*robots": ROBOTS_OK, "*": { status: 200, body: "<html><body></body></html>" } } });
  assert.deepEqual(a.detail, codes.slice(0, 5).map((c) => areaListUrl(c, 1)));
  assert.equal(a.health[0].ok, false);
  assert.equal(a.health[0].kind, "maintenance");
  assert.match(a.health[0].reason, /違うエリアのページが5件続けて同じ中身で0件/);
  const b = runCrawl({ env: { CRAWL_ONLY: "gspark" }, files, routes: { "*robots": ROBOTS_OK, "*": { status: 200, body: SEIWA_NOTICE } } });
  assert.deepEqual(b.detail, [areaListUrl("A0", 1)]);
  assert.equal(b.health[0].kind, "maintenance");
  assert.match(b.health[0].reason, /メンテナンスの告知（「メンテナンス中」）/);
});

test("通しの巡回: あなぶきの一覧が告知（429・題名「メンテナンス中 | Under maintenance」）なら maintenance と記録し、最後に同じ一覧を取り直さない", () => {
  const notice = `<!DOCTYPE html><html><head><title>メンテナンス中 | Under maintenance</title></head><body><h1>ただいまメンテナンス中です</h1></body></html>`;
  const A = "https://www.anabuki-housing.co.jp";
  const r = runCrawl({ env: { CRAWL_ONLY: "anabuki" },
    files: { "data/anabuki-ids.txt": "284\n285\n", "data/anabuki-ids.txt.fetched": "2026-10-01T00:00:00.000Z" },
    routes: { [`${A}/robots.txt`]: { status: 200, body: "User-agent: *\nDisallow: /wp-admin/\n" }, [`${A}/sitemap.xml`]: { status: 429, body: notice },
      [`${A}/park/hourly/`]: { status: 429, body: notice } } });
  assert.deepEqual(r.detail, [`${A}/sitemap.xml`, `${A}/park/hourly/`]);   // 以前は最後の確かめで /park/hourly/ をもう1回取っていた
  assert.equal(r.health[0].kind, "maintenance");
  assert.match(r.health[0].reason, /^一覧: anabuki 一覧: 相手先のサイトがメンテナンス中（「メンテナンス中 \| Under maintenance」・HTTP 429）/);
});
