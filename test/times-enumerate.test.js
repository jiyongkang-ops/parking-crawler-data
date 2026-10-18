// タイムズの一覧（sitemap）の作り直しのテスト（npm test）。事業者サイトには繋がない（取得は偽物に差し替える）。
// 2026-10-18: 子 sitemap が1つ欠けても欠けた一覧を「作り直した」と記録し、7日間は約3分の1の物件を回らない作りだった。
// また sitemap の取得に失敗すると例外でタイムズの回がまるごと止まっていた。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// cache-age.js は1回の実行で作り直す一覧の数を絞っている（読み込んだときに決まる）。テストでは何度も作り直すので、
// 読み込む前に外す。だからこのファイルでは src を import 文ではなく、ここで読み込む
process.env.LIST_REFRESH_MAX = "99";
const { getAllParkUrls } = await import("../src/times-enumerate.js");

const T = (pref, city, buk) => `https://times-info.net/${pref}/${city}/park-detail-${buk}/`;
const IDX = "https://times-info.net/parkdetails_index.xml";
const CH = [1, 2, 3].map((i) => `https://times-info.net/parkdetails_${i}.xml`);
const urlsOf = (from, n) => Array.from({ length: n }, (_, i) => T("P13-tokyo", "C101", `BUK${String(from + i).padStart(7, "0")}`));
const xml = (locs) => `<?xml version="1.0"?><urlset>${locs.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;
const site = (children) => async (u) => {
  if (u === IDX) return { ok: true, status: 200, html: xml(CH) };
  const c = children[CH.indexOf(u)];
  return c ? { ok: true, status: 200, html: xml(c) } : { ok: false, status: 503, html: "" };
};
const tmpList = (lines, fetchedAt) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "times-list-"));
  const f = path.join(dir, "times-park-urls.txt");
  if (lines) fs.writeFileSync(f, lines.join("\n") + "\n");
  if (fetchedAt) fs.writeFileSync(`${f}.fetched`, fetchedAt);
  return f;
};
const old = urlsOf(1, 30);
const eightDaysAgo = new Date(Date.now() - 8 * 864e5).toISOString();

test("一覧: 子 sitemap が1つ取れなければ、欠けた一覧を作らず前の一覧を使い続ける（次の回にまた作り直す）", async () => {
  const f = tmpList(old, eightDaysAgo);
  const list = await getAllParkUrls({ cacheFile: f, cacheMs: 7 * 864e5, fetcher: site([urlsOf(1, 10), null, urlsOf(21, 10)]) });
  assert.deepEqual(list, old);
  assert.equal(fs.readFileSync(`${f}.fetched`, "utf8"), eightDaysAgo);   // 作り直したことにしない
  assert.equal(list.staleReason, undefined);                             // 14日までは知らせない
});

test("一覧: 1割より多く減ったら作り直しの失敗とみなす。少しの増減はそのまま受け入れる", async () => {
  const f1 = tmpList(old, eightDaysAgo);
  const shrunk = await getAllParkUrls({ cacheFile: f1, cacheMs: 7 * 864e5, fetcher: site([urlsOf(1, 10), urlsOf(11, 10), urlsOf(21, 5)]) });
  assert.deepEqual(shrunk, old);
  const f2 = tmpList(old, eightDaysAgo);
  const fresh = await getAllParkUrls({ cacheFile: f2, cacheMs: 7 * 864e5, fetcher: site([urlsOf(1, 10), urlsOf(11, 10), urlsOf(23, 10).concat(urlsOf(33, 2))]) });
  assert.equal(fresh.length, 32);
  assert.deepEqual(fs.readFileSync(f2, "utf8").split("\n").filter(Boolean), fresh);
  assert.notEqual(fs.readFileSync(`${f2}.fetched`, "utf8"), eightDaysAgo);
});

test("一覧: 前の一覧が無ければ従来どおり失敗にする。長く作り直せていなければ知らせる印を付ける", async () => {
  const f1 = tmpList(null, null);
  await assert.rejects(getAllParkUrls({ cacheFile: f1, cacheMs: 7 * 864e5, fetcher: site([urlsOf(1, 10), null, null]) }), /子sitemap取得失敗/);
  const f2 = tmpList(old, new Date(Date.now() - 20 * 864e5).toISOString());
  const list = await getAllParkUrls({ cacheFile: f2, cacheMs: 7 * 864e5, fetcher: async () => { throw new Error("The operation was aborted due to timeout"); } });
  assert.deepEqual([...list], old);
  assert.match(list.staleReason, /20日前の一覧/);
});
