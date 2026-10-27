// リパークの一覧と選び方のテスト（npm test）。事業者サイトには繋がない（fetch・fetcher を差し替える）。
// 2026-10-18 の点検で見つかったことを直したぶん:
//   ・sitemap_park.xml は lastmod が 2025-06-18 で止まっていて、それより後に開いた物件が一覧に入っていなかった
//     （都心の地図の200件のうち36件、東北北部の131件のうち12件が sitemap に無い）。地図検索のマーカー（repark-map.js）で補う
//   ・sitemap の更新が止まっても気づけなかった。lastmod の最新が90日より古ければ health に残す
//   ・満空で1日に見る物件が 10/01 の12,445件から 10/16 の5,651件まで減っていた。今日まだ見ていない物件を先にする。
//     優先物件をまとめて取る回に、ふつうの物件の満空がその時刻に取れなくなっていた。優先は毎回少しずつ取る
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseMarkers, planTiles, splitTile, markersUrl, crawlMarkers, getMapParkIds, readMapList, writeMapList, mapIdsOf,
  JAPAN, MAP_CAP, MARKERS_URL, MAP_REFRESH_MS, MAP_RETRY_MS, MAP_KEEP_UNSEEN_DAYS,
} from "../src/repark-map.js";
import {
  getAllParkIds, newestLastmod, readCachedParkIds, mapFileOf, pickRolling, recordVisit, parseState, STARVE_MS, SITEMAP_STALE_DAYS,
  pickOptsOf,
} from "../src/repark-enumerate.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "repark-list-"));
const rep = (n) => `REP${String(n).padStart(7, "0")}`;

// ---- にせものの相手先（地図のマーカー）----
// 本物と同じく、範囲（北・西・南・東）の中の物件を中心に近い順に最大200件返す（2026-10-18 に東京23区・東北北部・海の上で確かめた形）
function fakeMarkers(parks, { failAt = null } = {}) {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    if (failAt && calls.length === failAt) return { ok: false, status: 503, html: "" };
    const u = new URL(url);
    assert.equal(`${u.origin}${u.pathname}`, MARKERS_URL);
    const m = u.searchParams.get("range").match(/^C([\d.-]+),([\d.-]+)N([\d.-]+)W([\d.-]+)S([\d.-]+)E([\d.-]+)$/);
    assert.ok(m, url);
    const [cla, cln, n, w, s, e] = m.slice(1).map(Number);
    const inBox = parks.filter((p) => p.la >= s && p.la <= n && p.ln >= w && p.ln <= e)
      .sort((a, b) => Math.hypot(a.la - cla, a.ln - cln) - Math.hypot(b.la - cla, b.ln - cln));
    const out = inBox.slice(0, MAP_CAP).map((p) => ({ park_code: p.id, latitude: String(p.la), longitude: String(p.ln), delete_flg: "0" }));
    return { ok: true, status: 200, html: JSON.stringify(out) };
  };
  return { fetcher, calls };
}
/** 乱数を固定して物件を置く。都心に固まった場所（1か所に600件）と、全国にまばらな物件 */
function makeParks({ dense = 600, sparse = 900, seed = 7, from = 1 } = {}) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const parks = [];
  let id = from;
  for (let i = 0; i < dense; i++) parks.push({ id: rep(id++), la: 35.68 + (rnd() - 0.5) * 0.05, ln: 139.76 + (rnd() - 0.5) * 0.05 });
  for (let i = 0; i < sparse; i++) parks.push({ id: rep(id++), la: 31 + rnd() * 12, ln: 130 + rnd() * 12 });
  return parks;
}

test("地図のマーカーを読む: 物件番号と座標。削除の印の物件は入れない。物件が無い範囲は []", () => {
  const j = [
    { park_code: "REP0025815", latitude: "35.672688423553", longitude: "139.73920155353", delete_flg: "0" },
    { park_code: "REP0000001", latitude: "35.1", longitude: "139.1", delete_flg: "1" },
    { park_code: "REP0029469", latitude: "", longitude: "", delete_flg: "0" },
  ];
  const r = parseMarkers(JSON.stringify(j));
  assert.equal(r.raw, 3);
  assert.deepEqual(r.parks, [{ id: "REP0025815", lat: 35.672688423553, lng: 139.73920155353 }, { id: "REP0029469", lat: null, lng: null }]);
  assert.deepEqual(parseMarkers("[]"), { parks: [], raw: 0 });
  assert.deepEqual(parseMarkers(""), { parks: [], raw: 0 });
  // 作りが変わったら例外（黙って0件にしない）
  assert.throws(() => parseMarkers("<html>メンテナンス中</html>"), /JSON ではない/);
  assert.throws(() => parseMarkers('{"a":1}'), /配列ではない/);
  assert.throws(() => parseMarkers('[{"code":"X"}]'), /park_code/);
});

test("地図の URL は公式の地図と同じ形（range=C中心N北W西S南E東）で、範囲を外へ少し広げる", () => {
  const u = markersUrl({ s: 35.52, n: 35.82, w: 139.56, e: 139.92 });
  assert.equal(u, `${MARKERS_URL}?range=C35.67,139.74N35.820001W139.559999S35.519999E139.920001`);
});

test("全国を長方形に分ける: どの長方形も分かっている物件が目安以下で、すき間も重なりも無く全国を覆う", () => {
  const pts = makeParks().map((p) => [p.la, p.ln]);
  const tiles = planTiles(pts, 150);
  const area = (b) => (b.n - b.s) * (b.e - b.w);
  const total = area(JAPAN);
  assert.ok(Math.abs(tiles.reduce((a, b) => a + area(b), 0) - total) < 1e-9 * total);
  for (const t of tiles) {
    const n = pts.filter(([la, ln]) => la >= t.s && la <= t.n && ln >= t.w && ln <= t.e).length;
    assert.ok(n <= 150, `${JSON.stringify(t)} に ${n}件`);
  }
  // どの物件もどれかの長方形に入る（境目の物件も漏れない）
  for (const [la, ln] of pts) assert.ok(tiles.some((t) => la >= t.s && la <= t.n && ln >= t.w && ln <= t.e));
  // 物件が無ければ全国を1つで聞く
  assert.deepEqual(planTiles([]), [{ ...JAPAN }]);
  // 割れない（同じ座標に固まった）ときは長い辺の真ん中で割る
  const [a, b] = splitTile({ s: 35, n: 36, w: 139, e: 139.1 }, [[35.5, 139.05], [35.5, 139.05]]);
  assert.deepEqual([a.n, b.s], [35.5, 35.5]);
  // 割る向き（長い方の辺＝南北）の座標がすべて同じ点（同じ緯度に東西に並ぶ）: 点の真ん中で割ると線が点の上に来て、
  // どちらの長方形にも全部の点が入る。そのときは辺の真ん中で割る（同じ形の長方形をくり返し聞かない）
  const row = Array.from({ length: 5 }, (_, i) => [35.3, 139.01 + i * 0.02]);
  const [c, d] = splitTile({ s: 35, n: 36, w: 139, e: 139.1 }, row);
  assert.deepEqual([c.n, d.s], [35.5, 35.5]);
});

test("一覧づくり: 200件より多い物件が同じ緯度に並んでいても、同じ長方形をくり返し聞かない", async () => {
  // 東西に細長く並んだ300件（緯度がすべて同じ）。南北に長い長方形から割り始める
  const line = Array.from({ length: 300 }, (_, i) => ({ id: rep(70000 + i), la: 35.3, ln: 139.0001 + i * 0.0003 }));
  const { fetcher, calls } = fakeMarkers(line);
  const r = await crawlMarkers({ points: line.map((p) => [p.la, p.ln]), fetcher, limit: 1000 });
  assert.equal(r.parks.size, 300);
  assert.equal(r.complete, true);
  assert.equal(new Set(calls).size, calls.length, "同じ長方形を2回聞いた");
  assert.ok(calls.length < 40, `${calls.length}回`);
});

test("一覧づくり: 200件で打ち切られた長方形は割って聞き直し、分かっていない場所の新しい物件も全部取る", async () => {
  const known = makeParks();
  // 新しく開いた物件: 都心にさらに400件（分かっている座標だけで分けると200件を超える）と、物件の無かった北海道に3件
  const fresh = makeParks({ dense: 400, sparse: 0, seed: 99, from: 50000 })
    .concat([{ id: rep(60001), la: 43.06, ln: 141.35 }, { id: rep(60002), la: 43.07, ln: 141.36 }, { id: rep(60003), la: 42.9, ln: 143.2 }]);
  const truth = known.concat(fresh);
  const { fetcher, calls } = fakeMarkers(truth);
  const r = await crawlMarkers({ points: known.map((p) => [p.la, p.ln]), fetcher });
  assert.equal(r.complete, true);
  assert.equal(r.error, null);
  assert.equal(r.parks.size, truth.length);
  for (const p of fresh) assert.ok(r.parks.has(p.id), p.id);
  assert.equal(r.requests, calls.length);
  assert.ok(r.requests < 40, `${r.requests}回`);   // 1,903件を数十回で
});

test("一覧づくり: 失敗したらそこで止める（相手先が苦しいときに叩き続けない）。送ってよい数を超えたら止める", async () => {
  const parks = makeParks();
  const a = fakeMarkers(parks, { failAt: 3 });
  const r = await crawlMarkers({ points: parks.map((p) => [p.la, p.ln]), fetcher: a.fetcher });
  assert.equal(a.calls.length, 3);
  assert.equal(r.complete, false);
  assert.match(r.error, /HTTP 503.*3回目で止めた/);
  // robots.txt で断られた・届かないときも止める（polite-fetch が blocked・transient を付けて返す）
  const r2 = await crawlMarkers({ fetcher: async () => ({ ok: false, status: 0, blocked: true, skippedReason: "robots.txt が 403" }) });
  assert.equal(r2.requests, 1);
  assert.equal(r2.complete, false);
  const b = fakeMarkers(parks);
  const r3 = await crawlMarkers({ points: parks.map((p) => [p.la, p.ln]), fetcher: b.fetcher, maxRequests: 2 });
  assert.equal(b.calls.length, 2);
  assert.match(r3.error, /送ってよい数（2回）に達した/);
});

test("地図の一覧: 7日に1回だけ作り直す。1回目で失敗したら1日あけ、途中で止まったら7日あける", async () => {
  const dir = tmp();
  const file = path.join(dir, "repark-map-ids.txt");
  const parks = makeParks({ dense: 50, sparse: 50 });
  const t0 = Date.parse("2026-10-19T00:00:00Z");
  const a = fakeMarkers(parks);
  const r1 = await getMapParkIds({ file, fetcher: a.fetcher, nowMs: t0, maxRequests: 250 });
  assert.equal(r1.refreshed, true);
  assert.equal(r1.ids.length, 100);
  assert.equal(r1.completeAt, t0);
  // 6日後は聞かない（ファイルから読む）
  const r2 = await getMapParkIds({ file, fetcher: a.fetcher, nowMs: t0 + 6 * 864e5, maxRequests: 250 });
  assert.equal(r2.refreshed, false);
  assert.equal(r2.ids.length, 100);
  const n1 = a.calls.length;
  // 7日後は作り直す
  const r3 = await getMapParkIds({ file, fetcher: a.fetcher, nowMs: t0 + MAP_REFRESH_MS, maxRequests: 250 });
  assert.equal(r3.refreshed, true);
  assert.ok(a.calls.length > n1);

  // 1回目で失敗（道が無い・断られた）: 毎時は試さず、1日あけて試す。前の一覧はそのまま使う
  const t1 = t0 + 2 * MAP_REFRESH_MS;
  const bad = async () => ({ ok: false, status: 404, html: "" });
  const f1 = await getMapParkIds({ file, fetcher: bad, nowMs: t1, maxRequests: 250 });
  assert.equal(f1.refreshed, true);
  assert.match(f1.error, /HTTP 404/);
  assert.equal(f1.ids.length, 100);
  assert.equal((await getMapParkIds({ file, fetcher: bad, nowMs: t1 + 3600e3, maxRequests: 250 })).refreshed, false);
  assert.equal((await getMapParkIds({ file, fetcher: bad, nowMs: t1 + MAP_RETRY_MS, maxRequests: 250 })).refreshed, true);

  // 途中で止まった（2回以上送った）: 取れた分は入れ、7日あける
  const t2 = t1 + 2 * MAP_RETRY_MS;
  // 都心に300件増えた: 1か所目が200件で打ち切られて割り、2回目で失敗する
  const more = parks.concat(makeParks({ dense: 300, sparse: 0, seed: 5, from: 80000 }));
  const c = fakeMarkers(more, { failAt: 2 });
  const p1 = await getMapParkIds({ file, coordsFile: null, fetcher: c.fetcher, nowMs: t2, maxRequests: 250 });
  assert.equal(p1.refreshed, true);
  assert.match(p1.error, /HTTP 503（2回目で止めた）/);
  assert.equal(c.calls.length, 2);
  assert.ok(p1.ids.length > 100);   // 1回目で取れた分は入れる
  assert.equal((await getMapParkIds({ file, fetcher: c.fetcher, nowMs: t2 + 2 * MAP_RETRY_MS, maxRequests: 250 })).refreshed, false);
  // 地図を使わない設定（REPARK_MAP_MAX_REQUESTS=0）なら聞かず、一覧ファイルだけ読む
  const off = await getMapParkIds({ file, fetcher: () => assert.fail("聞かない"), nowMs: t2 + 30 * 864e5, maxRequests: 0 });
  assert.equal(off.disabled, true);
});

test("地図の一覧: 前回の半分も取れなければ使わない。地図に出なくなった物件は180日残してから外す", async () => {
  const dir = tmp();
  const file = path.join(dir, "repark-map-ids.txt");
  const parks = makeParks({ dense: 50, sparse: 50 });
  const t0 = Date.parse("2026-10-19T00:00:00Z");
  await getMapParkIds({ file, fetcher: fakeMarkers(parks).fetcher, nowMs: t0 });
  // 作りが変わって10件しか返らない: 一覧は前のまま。完了の時刻も進めない
  const r = await getMapParkIds({ file, fetcher: fakeMarkers(parks.slice(0, 10)).fetcher, nowMs: t0 + MAP_REFRESH_MS });
  assert.match(r.error, /10件しか取れなかった（前回100件）/);
  assert.equal(r.ids.length, 100);
  assert.equal(readMapList(file).complete, t0);
  // 同じ物件のまま作り直しても、見出しの1行のほかは1文字も変わらない（週1回の全行のコミットで git が太らない）
  const body = () => fs.readFileSync(file, "utf8").split("\n").slice(1).join("\n");
  const before = body();
  await getMapParkIds({ file, fetcher: fakeMarkers(parks).fetcher, nowMs: t0 + MAP_REFRESH_MS + 864e5 });
  assert.equal(body(), before);
  // 1件閉じた: 地図に出なくなった日を付け、180日までは一覧に残す（巡回で 404 を確かめて閉鎖の印を付けるため）、過ぎたら外す
  const left = parks.slice(1);
  const t1 = t0 + 3 * MAP_REFRESH_MS;
  assert.equal((await getMapParkIds({ file, fetcher: fakeMarkers(left).fetcher, nowMs: t1 })).ids.length, 100);
  const goneDay = new Date(t1 + 9 * 3600e3).toISOString().slice(0, 10);
  assert.equal(readMapList(file).entries.get(parks[0].id).gone, goneDay);
  assert.equal(readMapList(file).entries.get(parks[1].id).gone, null);
  // 変わったのはその1行だけ
  const diff = body().split("\n").filter((l, i) => l !== before.split("\n")[i]);
  assert.deepEqual(diff.map((l) => l.split("\t")[0]), [parks[0].id]);
  // 次の作り直しでも出なくなった日は進めない
  await getMapParkIds({ file, fetcher: fakeMarkers(left).fetcher, nowMs: t1 + MAP_REFRESH_MS });
  assert.equal(readMapList(file).entries.get(parks[0].id).gone, goneDay);
  // 戻ってきたら出なくなった日を消す
  const back = await getMapParkIds({ file, fetcher: fakeMarkers(parks).fetcher, nowMs: t1 + 2 * MAP_REFRESH_MS });
  assert.equal(back.ids.length, 100);
  assert.equal(readMapList(file).entries.get(parks[0].id).gone, null);
  const t1b = t1 + 3 * MAP_REFRESH_MS;
  await getMapParkIds({ file, fetcher: fakeMarkers(left).fetcher, nowMs: t1b });
  const t2 = t1b + (MAP_KEEP_UNSEEN_DAYS + 1) * 864e5;
  const r2 = await getMapParkIds({ file, fetcher: fakeMarkers(left).fetcher, nowMs: t2 });
  assert.equal(r2.ids.length, 99);
  assert.ok(!r2.ids.includes(parks[0].id));
  // ファイルは読み書きで同じ中身になる
  const list = readMapList(file);
  const f2 = path.join(dir, "copy.txt");
  writeMapList(f2, { entries: list.entries, complete: list.complete, tried: list.tried, parks: list.parks, requests: list.lastRequests });
  assert.equal(fs.readFileSync(f2, "utf8"), fs.readFileSync(file, "utf8"));
  assert.deepEqual(mapIdsOf(list, t2), r2.ids);
});

test("地図の一覧: どの長方形も [] が返る（道や作りが変わった）ときは、聞き終えても失敗にする（前回の件数が無いときも）", async () => {
  const empty = async () => ({ ok: true, status: 200, html: "[]" });
  const t0 = Date.parse("2026-10-19T00:00:00Z");
  // 初回（前回の件数が無い）: めやすは長方形を決めた座標の数（満空の控え）。0件なので失敗。聞き終えた扱いにしない
  const dir = tmp();
  const file = path.join(dir, "repark-map-ids.txt");
  const coordsFile = path.join(dir, "vacancy-lots.jsonl");
  const parks = makeParks({ dense: 300, sparse: 300 });
  fs.writeFileSync(coordsFile, parks.map((p) => JSON.stringify({ k: `repark:${p.id}`, la: p.la, ln: p.ln })).join("\n") + "\n");
  const r = await getMapParkIds({ file, coordsFile, fetcher: empty, nowMs: t0 });
  assert.match(r.error, /地図の一覧が0件しか取れなかった（分かっている座標600件）/);
  assert.equal(r.completeAt, null);
  assert.equal(readMapList(file).complete, null);
  // 座標も無い（全国を1つで聞く）ときも、0件は失敗
  const d2 = tmp();
  const r2 = await getMapParkIds({ file: path.join(d2, "m.txt"), fetcher: empty, nowMs: t0 });
  assert.match(r2.error, /0件しか取れなかった/);
  assert.equal(r2.completeAt, null);
  // 半分より少ない（座標600件のめやすで200件）も失敗
  const d3 = tmp();
  const c3 = path.join(d3, "vacancy-lots.jsonl");
  fs.copyFileSync(coordsFile, c3);
  const r3 = await getMapParkIds({ file: path.join(d3, "m.txt"), coordsFile: c3, fetcher: fakeMarkers(parks.slice(0, 200)).fetcher, nowMs: t0 });
  assert.match(r3.error, /200件しか取れなかった（分かっている座標600件）/);
  // 通しで: sitemap が止まっていて、地図が1回も聞き終えられないので health は ok:false（staleReason）
  const d4 = tmp();
  const c4 = path.join(d4, "repark-sitemap.xml");
  fs.writeFileSync(c4, sitemapXml([rep(1), rep(2)], "2025-06-18"));
  fs.writeFileSync(`${c4}.fetched`, new Date().toISOString());
  fs.copyFileSync(coordsFile, path.join(d4, "vacancy-lots.jsonl"));
  const ids = await getAllParkIds({ cacheFile: c4, cacheMs: 7 * 864e5, fetcher: empty, nowMs: t0 });
  assert.match(ids.staleReason, /地図の一覧を一度も作り直せていない（地図の一覧が0件しか取れなかった/);
  // 前に聞き終えていた一覧があって、そのあと全部 [] になった: 前回の件数がめやす。一覧は前のまま、14日で ok:false
  const d5 = tmp();
  const c5 = path.join(d5, "repark-sitemap.xml");
  fs.writeFileSync(c5, sitemapXml([rep(1), rep(2)], "2025-06-18"));
  fs.writeFileSync(`${c5}.fetched`, new Date().toISOString());
  await getAllParkIds({ cacheFile: c5, cacheMs: 7 * 864e5, fetcher: fakeMarkers(parks).fetcher, nowMs: t0 });
  const later = await getAllParkIds({ cacheFile: c5, cacheMs: 7 * 864e5, fetcher: empty, nowMs: t0 + MAP_REFRESH_MS });
  assert.equal(later.length, parks.length);   // sitemap の2件は地図にも出ている
  assert.equal(later.staleReason, undefined);
  fs.writeFileSync(`${c5}.fetched`, new Date().toISOString());
  const stale = await getAllParkIds({ cacheFile: c5, cacheMs: 7 * 864e5, fetcher: empty, nowMs: t0 + 2 * MAP_REFRESH_MS + 864e5 });
  assert.match(stale.staleReason, /地図の一覧を15日作り直せていない（地図の一覧が0件しか取れなかった（前回600件））/);
});

// ---- sitemap と地図を合わせた一覧 ----

const sitemapXml = (ids, lastmod) => `<?xml version="1.0"?><urlset>${ids.map((id) =>
  `<url><loc>https://www.repark.jp/parking_user/time/result/detail/?park=${id}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("")}</urlset>`;

test("sitemap の lastmod のいちばん新しい日を読む", () => {
  assert.equal(newestLastmod("<lastmod>2025-03-01</lastmod><lastmod>2025-06-18T10:00:00+09:00</lastmod><lastmod>2024-12-31</lastmod>"), "2025-06-18");
  assert.equal(newestLastmod("<urlset></urlset>"), null);
});

test("一覧 = sitemap ＋ 地図だけの物件。1回あたりの件数は sitemap の分で決める。sitemap が止まっていれば health の reason に残す", async () => {
  const dir = tmp();
  const cacheFile = path.join(dir, "repark-sitemap.xml");
  const sm = [rep(1), rep(2), rep(3)];
  fs.writeFileSync(cacheFile, sitemapXml(sm, "2025-06-18"));
  fs.writeFileSync(`${cacheFile}.fetched`, new Date().toISOString());   // sitemap は作り直さない
  const parks = [{ id: rep(2), la: 35.1, ln: 139.1 }, { id: rep(3), la: 35.2, ln: 139.2 }, { id: rep(29469), la: 35.69, ln: 139.75 }];
  const { fetcher, calls } = fakeMarkers(parks);
  const nowMs = Date.parse("2026-10-19T00:00:00Z");
  const ids = await getAllParkIds({ cacheFile, cacheMs: 7 * 864e5, fetcher, nowMs });
  assert.deepEqual([...ids], [rep(1), rep(2), rep(3), rep(29469)]);
  assert.deepEqual([...ids.perRunIds], sm);
  assert.equal(ids.staleReason, undefined);   // 地図で補えているので ok のまま
  assert.match(ids.listNote, /sitemap の更新が止まっている（いちばん新しい lastmod が 2025-06-18・488日前）。地図の一覧（sitemap に無い1件）で補っている/);
  assert.deepEqual(ids.listInfo, { sitemap: 3, sitemapNewest: "2025-06-18", map: 3, mapOnly: 1,
    mapCompleteAt: new Date(nowMs).toISOString(), mapRequests: calls.length });
  assert.ok(fs.existsSync(mapFileOf(cacheFile)));
  // 次の回の「前の一覧」には地図だけの物件も入る（unparkGone で「新しく載った番号」を見分けるため）
  assert.deepEqual(readCachedParkIds(cacheFile, nowMs), [...ids]);

  // 地図が使えず、sitemap も止まっている: 新しい物件を取る手立てが無いので staleReason（health は ok:false）
  const d2 = tmp();
  const c2 = path.join(d2, "repark-sitemap.xml");
  fs.writeFileSync(c2, sitemapXml(sm, "2025-06-18"));
  fs.writeFileSync(`${c2}.fetched`, new Date().toISOString());
  const ids2 = await getAllParkIds({ cacheFile: c2, cacheMs: 7 * 864e5, fetcher: async () => ({ ok: false, status: 404, html: "" }), nowMs });
  assert.deepEqual([...ids2], sm);
  assert.match(ids2.staleReason, /sitemap の更新が止まっている.*地図の一覧を一度も作り直せていない（地図のマーカー HTTP 404（1回目で止めた））。sitemap に載っていない新しい物件を取れない/);

  // sitemap が新しく、地図も取れている: 何も出さない
  const d3 = tmp();
  const c3 = path.join(d3, "repark-sitemap.xml");
  const fresh = new Date(nowMs - 10 * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync(c3, sitemapXml(sm, fresh));
  fs.writeFileSync(`${c3}.fetched`, new Date().toISOString());
  const ids3 = await getAllParkIds({ cacheFile: c3, cacheMs: 7 * 864e5, fetcher: fakeMarkers(parks).fetcher, nowMs });
  assert.equal(ids3.staleReason, undefined);
  assert.equal(ids3.listNote, undefined);
  // 90日を過ぎたら知らせる。地図を使わない設定なら新しい物件を取る手立てが無いので staleReason（health は ok:false）
  const old = new Date(nowMs - (SITEMAP_STALE_DAYS + 1) * 864e5).toISOString().slice(0, 10);
  fs.writeFileSync(c3, sitemapXml(sm, old));
  const ids4 = await getAllParkIds({ cacheFile: c3, cacheMs: 7 * 864e5, fetcher: () => assert.fail("聞かない"), nowMs, mapMaxRequests: 0 });
  assert.match(ids4.staleReason, /sitemap の更新が止まっている.*91日前.*地図の一覧は使っていない（REPARK_MAP_MAX_REQUESTS=0）/);
  // 90日ちょうどまでは知らせない
  fs.writeFileSync(c3, sitemapXml(sm, new Date(nowMs - SITEMAP_STALE_DAYS * 864e5).toISOString().slice(0, 10)));
  const ids5 = await getAllParkIds({ cacheFile: c3, cacheMs: 7 * 864e5, fetcher: () => assert.fail("聞かない"), nowMs, mapMaxRequests: 0 });
  assert.equal(ids5.staleReason, undefined);
  assert.equal(ids5.listNote, undefined);
});

// ---- 選び方 ----

const JST = (s) => Date.parse(`${s}+09:00`);
const stamp = (iso, hours) => `${new Date(iso).toISOString()}|${hours.reduce((m, h) => m | (1 << h), 0).toString(36)}`;

test("今日まだ見ていない物件を、今日もう見た物件より先にする（この時刻をまだ見ていなくても）", () => {
  const at = new Date(JST("2026-10-19T15:10:00")).toISOString();
  const state = {
    A: stamp(JST("2026-10-19T09:00:00"), [9]),                              // 今日見た・15時はまだ
    B: stamp(JST("2026-10-18T20:00:00"), [...Array(24).keys()].filter((h) => h !== 0 && h !== 1)),   // 今日まだ・15時は見た
    C: stamp(JST("2026-10-18T22:00:00"), [22]),                             // 今日まだ・15時はまだ
  };
  const df = { spreadHours: true, at, dailyFirst: true };
  assert.deepEqual(pickRolling(["A", "B", "C"], state, 3, df), ["C", "B", "A"]);
  assert.deepEqual(pickRolling(["A", "B", "C"], state, 1, df), ["C"]);
  // 48時間より長く見ていない物件は、時間帯を問わず先（印のそろいかけた物件を待たせ続けない）
  state.D = stamp(JST("2026-10-19T15:10:00") - STARVE_MS - 3600e3, [...Array(24).keys()].filter((h) => h !== 3));
  assert.equal(pickRolling(["A", "B", "C", "D"], state, 1, df)[0], "D");
  // dailyFirst を渡さない社（タイムズ）は直す前のまま: この時刻（15時）をまだ見ていない物件が先、その中は古い順
  assert.deepEqual(pickRolling(["A", "B", "C", "D"], state, 4, { spreadHours: true, at }), ["C", "A", "D", "B"]);
  // 時間帯を見ない社（spreadHours なし）は古い順のまま
  assert.deepEqual(pickRolling(["A", "B", "C", "D"], state, 4, { at }), ["D", "B", "C", "A"]);
});

test("優先物件を毎回少しずつ取る（spreadPriority）: 1回に優先の数÷3まで。全国の巡回からは取る優先の数の半分を引く", () => {
  const prio = Array.from({ length: 30 }, (_, i) => `P${String(i).padStart(2, "0")}`);
  const rest = Array.from({ length: 100 }, (_, i) => `R${String(i).padStart(3, "0")}`);
  const at = "2026-10-19T06:10:00Z";
  const b = pickRolling(prio.concat(rest), {}, 20, { spreadHours: true, at, priority: prio, priorityMinAgeMs: 3 * 3600e3, spreadPriority: true });
  assert.equal(b.filter((id) => id.startsWith("P")).length, 10);
  assert.equal(b.filter((id) => id.startsWith("R")).length, 15);
  // 渡さなければ従来どおり（3時間たった優先は全部、全国の巡回は n 件）
  const c = pickRolling(prio.concat(rest), {}, 20, { spreadHours: true, at, priority: prio, priorityMinAgeMs: 3 * 3600e3 });
  assert.deepEqual([c.filter((id) => id.startsWith("P")).length, c.filter((id) => id.startsWith("R")).length], [30, 20]);
});

test("優先物件を少しずつ取っても、3時間たったら次の回で取る決まりはそのまま（間隔も回数も直す前と同じ）", () => {
  // 優先12件・毎時の回で24時間。同じ回の中で後に取った物件は3時間にわずかに足りず、次の回へずれる（直す前も同じ）
  const run = (spreadPriority) => {
    const prio = Array.from({ length: 12 }, (_, i) => `P${String(i).padStart(2, "0")}`);
    const rest = Array.from({ length: 300 }, (_, i) => `R${i}`);
    const state = {};
    const seen = new Map(prio.map((id) => [id, []]));
    const t0 = Date.parse("2026-10-19T00:07:00Z");
    for (let h = 0; h < 24; h++) {
      let t = t0 + h * 3600e3;
      const batch = pickRolling(prio.concat(rest), state, 10, { spreadHours: true, at: new Date(t).toISOString(), priority: prio,
        priorityMinAgeMs: 3 * 3600e3, spreadPriority });
      for (const id of batch) {
        recordVisit(state, id, new Date(t).toISOString(), { ok: true, status: 200 }, { hours: true });
        if (seen.has(id)) seen.get(id).push(h);
        t += 4000;
      }
    }
    const gaps = [...seen.values()].flatMap((hs) => hs.slice(1).map((h, i) => h - hs[i]));
    return { visits: gaps.length + seen.size, maxGap: Math.max(...gaps), minGap: Math.min(...gaps) };
  };
  const before = run(false), after = run(true);
  assert.equal(after.minGap, 3);              // 3時間より短くはしない
  assert.ok(after.maxGap <= 4, JSON.stringify(after));
  assert.ok(after.visits >= before.visits, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
  assert.ok(before.maxGap <= 4);
});

test("タイムズ（hours だけの社）の選び方は直す前と同じ: 優先物件は3時間たった分を全部先頭に、残りは「この時刻をまだ見ていない物件」が先", () => {
  // 巡回の表の印: spreadPriority・dailyFirst はリパークの行だけ。hours（満空が取れる）だけでは付かない（2026-10-19 の点検）
  const times = pickOptsOf({ op: "times", hours: true }, { at: "x", priority: ["p"], priorityMinAgeMs: 3 * 3600e3 });
  assert.deepEqual(times, { spreadHours: true, at: "x", priority: ["p"], priorityMinAgeMs: 3 * 3600e3, spreadPriority: false, dailyFirst: false });
  const repark = pickOptsOf({ op: "repark", hours: true, spreadPriority: true, dailyFirst: true }, { at: "x" });
  assert.equal(repark.spreadPriority, true);
  assert.equal(repark.dailyFirst, true);
  const runSrc = fs.readFileSync(path.join(ROOT, "src/run.js"), "utf8");
  const rowOf = (op) => runSrc.slice(runSrc.indexOf(`{ op: "${op}"`), runSrc.indexOf("},", runSrc.indexOf(`{ op: "${op}"`)));
  assert.match(rowOf("repark"), /spreadPriority: true, dailyFirst: true/);
  assert.doesNotMatch(rowOf("times"), /spreadPriority|dailyFirst/);
  assert.match(runSrc, /pickRolling\(candidates, state, perPass, pickOptsOf\(rolling,/);

  // 直す前の選び方（c52153d より前の pickRolling。眠らせている物件の無い状態）と、乱数で作った状態で比べる
  const ALL = (1 << 24) - 1;
  const ref = (ids, state, n, { at, priority, priorityMinAgeMs }) => {
    const nowMs = Date.parse(at), st = (id) => parseState(state[id]);
    const head = priority.filter((id) => ids.includes(id) && nowMs - st(id).t >= priorityMinAgeMs).sort((a, b) => st(a).t - st(b).t);
    const hs = new Set(head), bit = 1 << new Date(nowMs + 9 * 3600e3).getUTCHours();
    const need = [], done = [];
    for (const id of ids.filter((x) => !hs.has(x))) { const m = st(id).mask; (((m === ALL ? 0 : m) & bit) ? done : need).push(id); }
    const byAge = (a, b) => st(a).t - st(b).t;
    need.sort(byAge);
    const rest = need.length >= n ? need.slice(0, n) : need.concat(done.sort(byAge).slice(0, n - need.length));
    return head.concat(rest);
  };
  let x = 11;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ids = Array.from({ length: 400 }, (_, i) => `T${i}`);
  const priority = ids.filter((_, i) => i % 7 === 0);   // 優先が多い（n の3分の1より多い）
  for (let k = 0; k < 20; k++) {
    const now = Date.parse("2026-10-19T00:00:00Z") + k * 8 * 3600e3 + 600e3;
    const state = {};
    for (const id of ids) {
      if (rnd() < 0.05) continue;   // まだ取っていない
      // 1周約8日の社なので、最後に見たのは 0〜10日前
      const t = now - Math.floor(rnd() * 10 * 864e5);
      let mask = 0;
      for (let h = 0; h < 24; h++) if (rnd() < 0.6) mask |= 1 << h;
      state[id] = `${new Date(t).toISOString()}|${mask.toString(36)}`;
    }
    const opt = pickOptsOf({ op: "times", hours: true }, { at: new Date(now).toISOString(), priority, priorityMinAgeMs: 3 * 3600e3 });
    assert.deepEqual(pickRolling(ids, state, 30, opt), ref(ids, state, 30, opt), `${k}回目`);
  }
});

// ---- 通しの巡回（run.js を別のプロセスで動かす）----

/** run.js を通しで動かす。fetch は routes（URL → { status, body }）で差し替え、URL が prefix で始まる分は prefixRoute で答える */
function runCrawl({ dir, routes = {}, env = {} }) {
  const callsFile = path.join(dir, "calls.txt");
  const routesFile = path.join(dir, "routes.json");
  fs.writeFileSync(callsFile, "");
  fs.writeFileSync(routesFile, JSON.stringify(routes));
  const preload = path.join(dir, "stub.mjs");
  fs.writeFileSync(preload, `
import fs from "node:fs";
import { config } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)};
config.minDelayMs = 0;
const routes = JSON.parse(fs.readFileSync(${JSON.stringify(routesFile)}, "utf8"));
globalThis.fetch = async (url) => {
  const u = String(url);
  fs.appendFileSync(${JSON.stringify(callsFile)}, u + "\\n");
  const key = Object.keys(routes).find((k) => k === u || (k.endsWith("*") && u.startsWith(k.slice(0, -1))));
  const r = key ? routes[key] : { status: 404 };
  return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => r.body ?? "", headers: { get: () => null } };
};
`);
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
    cwd: dir, encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CRAWL_HOLD: "off", HEALTH_NAME: "test", LIST_REFRESH_MAX: "1000", ROLLING_PASSES: "1", OUT_FILE: "data/prices-test.jsonl",
      CRAWL_ONLY: "repark", ...env },
  });
  const log = `${p.stdout}\n${p.stderr}`;
  assert.equal(p.status, 0, log);
  const calls = fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean);
  const health = JSON.parse(fs.readFileSync(path.join(dir, "data/health/test.json"), "utf8")).targets;
  return { calls, health, log };
}

test("通しの巡回: sitemap に無い新しい物件を地図で見つけて取りに行く。health は ok のまま reason に sitemap が止まっていることを残す", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "data"), { recursive: true });
  const sm = [rep(1), rep(2)];
  fs.writeFileSync(path.join(dir, "data/repark-sitemap.xml"), sitemapXml(sm, "2025-06-18"));
  fs.writeFileSync(path.join(dir, "data/repark-sitemap.xml.fetched"), new Date().toISOString());
  const markers = [rep(2), rep(29469)].map((id, i) => ({ park_code: id, latitude: String(35.6 + i / 10), longitude: "139.7", delete_flg: "0" }));
  const detail = (name) => ({ status: 200, body: `<html><head><title>${name}</title></head><body><h1>${name}</h1></body></html>` });
  const routes = {
    "https://www.repark.jp/ajax/time_markers.json*": { status: 200, body: JSON.stringify(markers) },
    "https://www.repark.jp/parking_user/time/result/detail/*": detail("三井のリパーク テスト駐車場"),
  };
  const r = runCrawl({ dir, routes, env: { ROLLING_PER_RUN: "10" } });
  const detailCalls = r.calls.filter((u) => u.includes("/detail/"));
  assert.deepEqual(detailCalls.map((u) => new URL(u).searchParams.get("park")).sort(), [rep(1), rep(2), rep(29469)]);
  assert.equal(r.calls.filter((u) => u.includes("time_markers")).length, 1);   // 物件の無い初回は全国を1回で聞く
  const h = r.health.find((t) => t.op === "repark");
  assert.equal(h.ok, true, JSON.stringify(h));
  assert.match(h.reason, /sitemap の更新が止まっている.*地図の一覧（sitemap に無い1件）で補っている/);
  assert.equal(h.list.mapOnly, 1);
  assert.match(fs.readFileSync(path.join(dir, "data/repark-map-ids.txt"), "utf8"), /REP0029469/);
  // 次の回（毎時）は地図を聞かない。一覧は同じ
  const r2 = runCrawl({ dir, routes, env: { ROLLING_PER_RUN: "10" } });
  assert.equal(r2.calls.filter((u) => u.includes("time_markers")).length, 0);
  assert.equal(r2.health.find((t) => t.op === "repark").list.mapOnly, 1);
});
