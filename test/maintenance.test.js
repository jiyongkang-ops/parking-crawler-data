// 相手先のサイトのメンテナンスの見分けと、最後に取れた時刻の引き継ぎのテスト（npm test）。事業者サイトには繋がない。
// 2026-10-24 週次の見直し: 10/22〜23 に名鉄協商・近鉄不動産・ザ・パーク・あなぶきが「断られている（403）」
// 「多すぎる（429）」と記録されたが、4社とも相手先のサイトがメンテナンス中だった。題名はその日に返ってきたもの
import { test } from "node:test";
import assert from "node:assert/strict";
import { maintenanceTitle, markMaintenance, ORIGINS } from "../src/maintenance.js";
import { kindOfFetch, kindOfText, withLastOk } from "../src/health-kind.js";
import { politeFetch, _resetRobotsCache } from "../src/polite-fetch.js";

const page = (title, body = "") => `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;

test("題名がメンテナンスの告知なら見分ける（4社が実際に返した題名）", () => {
  assert.equal(maintenanceTitle(page("緊急メンテナンスに伴うWebサイト一時停止のお知らせ")), "緊急メンテナンスに伴うWebサイト一時停止のお知らせ");
  assert.ok(maintenanceTitle(page("緊急メンテナンスのお知らせ｜近鉄不動産株式会社")));
  assert.ok(maintenanceTitle(page("メンテナンスのお知らせ")));
  assert.ok(maintenanceTitle(page("メンテナンス中 | Under maintenance")));
  // 題名が無いときは最初の見出し
  assert.ok(maintenanceTitle("<html><body><h1>ただいまメンテナンス中です</h1></body></html>"));
});

test("普段のページは、本文にメンテナンスの見出しがあっても見分けない", () => {
  assert.equal(maintenanceTitle(page("名鉄協商パーキング｜時間貸し駐車場", "<a>システムメンテナンスのお知らせ（10/30）</a>")), null);
  assert.equal(maintenanceTitle(page("403 Forbidden", "You don't have permission")), null);
  assert.equal(maintenanceTitle(""), null);
  assert.equal(maintenanceTitle(null), null);
});

test("失敗した事業者だけ入口を1回ずつ見て、メンテナンスなら種類と理由を書き換える", async () => {
  const rows = [
    { op: "mkp", label: "名鉄協商", ok: false, n: 0, kind: "blocked", reason: "相手先の不調で打ち切り（8件続けて取れず。最後は HTTP 403）" },
    { op: "mkp", label: "名鉄協商（予備）", ok: false, n: 0, kind: "blocked", reason: "x" },
    { op: "times", label: "タイムズ", ok: true, n: 899 },
    { op: "space24", label: "スペース二十四", ok: false, n: 0, kind: "paused", reason: "停止中" },
    { op: "parknet", label: "パークネット", ok: false, n: 0, kind: "parse", reason: "0件" },
    { op: "times", label: "タイムズ（503）", ok: false, n: 0, kind: "network", reason: "HTTP 503" },
  ];
  const asked = [];
  const fetchTop = async (url) => {
    asked.push(url);
    if (url.startsWith(ORIGINS.mkp)) return { ok: true, status: 200, html: page("緊急メンテナンスに伴うWebサイト一時停止のお知らせ") };
    return { ok: true, status: 200, html: page("パークネット") };
  };
  await markMaintenance(rows, fetchTop);
  assert.equal(rows[0].kind, "maintenance");
  assert.match(rows[0].reason, /メンテナンス中（「緊急メンテナンスに伴うWebサイト一時停止のお知らせ」）/);
  assert.match(rows[0].reason, /8件続けて取れず/);          // もとの記録も残す
  assert.equal(rows[1].kind, "maintenance");                // 同じ入口は見直さずに同じ答え
  assert.equal(rows[2].kind, undefined);                    // 取れた行は触らない
  assert.equal(rows[3].kind, "paused");                     // 止めている社は入口にも行かない
  assert.equal(rows[4].kind, "parse");                      // メンテナンスでなければそのまま
  assert.equal(rows[5].kind, "network");                    // 届かない（503）は入口を見に行かない
  assert.deepEqual(asked, [`${ORIGINS.mkp}/`, `${ORIGINS.parknet}/`]);
  assert.equal(ORIGINS.space24, undefined);
  assert.equal(ORIGINS.odakyu, undefined);
});

test("入口を見られなかったときは元の行のまま", async () => {
  const rows = [{ op: "kintetsu", label: "近鉄不動産", ok: false, n: 0, kind: "blocked", reason: "robots.txt が HTTP 403（断られている）" }];
  await markMaintenance(rows, async () => { throw new Error("fetch failed"); });
  assert.equal(rows[0].kind, "blocked");
  await markMaintenance(rows, async () => ({ ok: false, blocked: true, skippedReason: "robots.txt が HTTP 403（断られている）" }));
  assert.equal(rows[0].kind, "blocked");
});

test("0件でも、答えが閉鎖（404）中心なら入口を見に行かない（閉鎖でありメンテナンスではない）", async () => {
  const rows = [{ op: "times", label: "タイムズ", ok: false, n: 0, kind: "parse", reason: "0件", statusCounts: { 404: 6, 200: 1 } }];
  let asked = 0;
  await markMaintenance(rows, async () => { asked++; return { ok: true, html: "<title>メンテナンス中</title>" }; });
  assert.equal(asked, 0);
  assert.equal(rows[0].kind, "parse");
});

test("robots.txt がメンテナンスの告知を 403 で返したら、断られたではなく一時的な見送りにする", async () => {
  _resetRobotsCache();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/robots.txt")) return new Response(page("メンテナンスのお知らせ"), { status: 403 });
    throw new Error("本ページは送らないはず");
  };
  try {
    const res = await politeFetch("https://example-maintenance.test/data/search.json");
    assert.equal(res.ok, false);
    assert.equal(res.blocked, undefined);
    assert.equal(res.transient, true);
    assert.equal(res.maintenance, "メンテナンスのお知らせ");
    assert.equal(kindOfFetch(res), "maintenance");
    assert.equal(kindOfText(res.skippedReason), "maintenance");
  } finally { globalThis.fetch = real; _resetRobotsCache(); }
});

test("中身がメンテナンスでない 403 は、今までどおり断られている", async () => {
  _resetRobotsCache();
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(page("403 Forbidden"), { status: 403 });
  try {
    const res = await politeFetch("https://example-blocked.test/x");
    assert.equal(res.blocked, true);
    assert.equal(kindOfFetch(res), "blocked");
  } finally { globalThis.fetch = real; _resetRobotsCache(); }
});

test("最後に取れた時刻を前の回から引き継ぐ（op と label の組で）", () => {
  const prevAt = "2026-10-22T07:00:00.000Z", at = "2026-10-24T07:00:00.000Z";
  const prev = { at: prevAt, targets: [
    { op: "thepark", label: "ザ・パーク", ok: true, n: 3527 },
    { op: "npc", label: "NPC全国 1/11", ok: false, lastOkAt: "2026-10-20T01:00:00.000Z" },
    { op: "npc", label: "NPC全国 2/11", ok: true, n: 1761 },
  ] };
  const rows = withLastOk([
    { op: "thepark", label: "ザ・パーク", ok: false, n: 0, kind: "maintenance" },   // 今回は失敗 → 前の回の時刻
    { op: "npc", label: "NPC全国 1/11", ok: false, n: 0 },                           // 前も失敗 → 前の回が持っていた時刻
    { op: "npc", label: "NPC全国 2/11", ok: true, n: 1761 },                          // 今回取れた → 今回の時刻
    { op: "mkp", label: "名鉄協商", ok: false, n: 0 },                                // 前の回に行が無い → 付けない
  ], prev, at);
  assert.equal(rows[0].lastOkAt, prevAt);
  assert.equal(rows[1].lastOkAt, "2026-10-20T01:00:00.000Z");
  assert.equal(rows[2].lastOkAt, at);
  assert.equal(rows[3].lastOkAt, undefined);
  assert.deepEqual(withLastOk([{ op: "a", label: "A", ok: true }], null, at), [{ op: "a", label: "A", ok: true, lastOkAt: at }]);
});

// ---- 2026-10-27: 本文での見分けと、robots.txt が 403 の社の入口を1回だけ見る ----
test("本文の「ただいまメンテナンス中です」で見分ける（題名がいつもどおりのパークネット）", async () => {
  const { maintenanceBody, maintenanceOf } = await import("../src/maintenance.js");
  const pn = '<html><head><title>パークネット | 新明和工業株式会社</title><style>.a{}</style></head>'
    + '<body><p>ただいまメンテナンス中です</p><p>現在、ウェブサイトの改修作業に伴い、サービスを停止しております。</p></body></html>';
  assert.equal(maintenanceOf(pn), "ただいまメンテナンス中です");
  assert.equal(maintenanceBody("<body>セキュリティ対策のため、Webサイトを一時停止いたします。</body>"), "Webサイトを一時停止いたします");
  assert.equal(maintenanceBody("<body>This site is temporarily unavailable due to system maintenance.</body>"), "temporarily unavailable due to system maintenance");
  // ふだんのページの予告・お知らせは見分けない
  assert.equal(maintenanceOf(page("名鉄協商パーキング", "<a>システムメンテナンスのお知らせ（10/30）</a><p>メンテナンス予定日 11/1</p>")), null);
  assert.equal(maintenanceOf(page("403 Forbidden", "You don't have permission")), null);
  // スクリプトの中の文字は見ない
  assert.equal(maintenanceOf('<title>x</title><script>var m="ただいまメンテナンス中です"</script>'), null);
  // 0件（parse）の社の入口が本文でメンテナンスなら書き換える
  const rows = [{ op: "parknet", label: "パークネット", ok: false, n: 0, kind: "parse", reason: "0件" }];
  await markMaintenance(rows, async () => ({ ok: true, status: 200, html: pn }));
  assert.equal(rows[0].kind, "maintenance");
  assert.match(rows[0].reason, /ただいまメンテナンス中です/);
});

test("robots.txt が 403 の社だけ、入口を1回だけ直接見る（paused・届かない社は見ない）", async () => {
  const rows = [
    { op: "kintetsu", label: "近鉄不動産", ok: false, n: 0, kind: "blocked", reason: "robots.txt が HTTP 403（断られている）" },
    { op: "mkp", label: "名鉄協商", ok: false, n: 0, kind: "blocked", reason: "robots.txt が HTTP 401" },
    { op: "anabuki", label: "あなぶき", ok: false, n: 0, kind: "blocked", reason: "x" },
  ];
  const direct = [];
  const fetchTop = async (url) => url.startsWith(ORIGINS.anabuki)
    ? { ok: false, blocked: true, status: 403 }
    : { ok: false, blocked: true, status: url.startsWith(ORIGINS.mkp) ? 401 : 403 };
  const fetchTopDirect = async (url) => {
    direct.push(url);
    if (url.startsWith(ORIGINS.kintetsu)) return { ok: true, status: 200, html: page("緊急メンテナンスのお知らせ｜近鉄不動産株式会社") };
    return { ok: false, status: 403, html: page("403 Forbidden") };
  };
  await markMaintenance(rows, fetchTop, fetchTopDirect);
  assert.equal(rows[0].kind, "maintenance");
  assert.equal(rows[1].kind, "blocked");                     // 直接見ても素の 403 なら元のまま
  assert.equal(rows[2].kind, "blocked");
  assert.deepEqual(direct, [`${ORIGINS.kintetsu}/`, `${ORIGINS.mkp}/`, `${ORIGINS.anabuki}/`]);   // 1社1回ずつ
  // 直接見る手段を渡さなければ、今までどおり見に行かない
  const r2 = [{ op: "kintetsu", label: "近鉄不動産", ok: false, n: 0, kind: "blocked", reason: "x" }];
  await markMaintenance(r2, fetchTop);
  assert.equal(r2[0].kind, "blocked");
});
