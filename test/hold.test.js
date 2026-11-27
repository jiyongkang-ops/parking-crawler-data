// 保留（src/hold.js）の期限の読み方と、理由の文
import test from "node:test";
import assert from "node:assert/strict";
import { holdOf, holdReason } from "../src/hold.js";

test("保留は日本時間の期限の日まで効き、過ぎたら外れる", () => {
  const t = { operator: "mkp", hold: { until: "2026-11-24", reason: "相手先が一時停止" } };
  assert.deepEqual(holdOf(t, new Date("2026-10-27T00:00:00Z")), { until: "2026-11-24", reason: "相手先が一時停止" });
  assert.ok(holdOf(t, new Date("2026-11-24T14:59:00Z")));          // JST 11/24 23:59 はまだ効く
  assert.equal(holdOf(t, new Date("2026-11-24T15:00:00Z")), null);  // JST 11/25 0:00 で外れる
  assert.equal(holdOf({ operator: "x" }), null);
  assert.equal(holdOf({ hold: { until: "11/24" } }), null);          // 期限の書き方が違えば効かせない
  assert.equal(holdOf({ hold: { until: "2026-11-24" } }, new Date("2026-10-27T00:00:00Z")).reason, "相手先のサイトが一時停止");
});

test("保留中に取れなかった回の理由", () => {
  assert.equal(holdReason({ until: "2026-11-24", reason: "相手先が一時停止" }, "HTTP 403"),
    "保留中（2026-11-24まで）: 相手先が一時停止。様子見の1件も取れなかった（HTTP 403）");
});

test("設定: 近鉄不動産に保留があり、名鉄協商（2026-11-27 外した）と止めている社（paused）には無い", async () => {
  const { config } = await import("../config.js");
  const ts = config.targets ?? config.targetList ?? Object.values(config).find((v) => Array.isArray(v) && v.some((x) => x?.operator));
  const of = (op) => ts.find((x) => x.operator === op);
  assert.ok(of("kintetsu").hold);
  // 名鉄協商は 10/27 にサイトが再開していて、この巡回だけが断られている（止まっているのではない）ので保留にしない
  assert.equal(of("mkp").hold, undefined);
  assert.equal(of("space24").hold, undefined);
  assert.equal(of("odakyu").hold, undefined);
});

test("名鉄協商は1回200件・8秒おき（2026-11-27。続けて650ページほど読むと robots.txt が 403 になっていた）", async () => {
  const { config } = await import("../config.js");
  assert.equal(config.mkpRollingPerRun, 200);
  assert.equal(config.mkpMinDelayMs, 8000);
  const src = (await import("node:fs")).readFileSync(new URL("../src/run.js", import.meta.url), "utf8");
  assert.match(src, /op: "mkp"[^}]*minDelay: config\.mkpMinDelayMs/);
});
