// 巡回の失敗の扱いのテスト（npm test）。事業者サイトには繋がない。
// 2026-10-18 タイムズの点検で見つかったこと:
//   ・相手先の不調（502・503・タイムアウト）で取れなかった物件も時刻を進めていたので、データの無いまま1巡後ろへ回っていた
//   ・不調のあいだも叩き続けていた（2026-10-02 は約32分で124件が失敗）
//   ・一覧（sitemap）から消えた物件は二度と取りに行かず、閉鎖の印が付かないまま Advisor の相場に残っていた（64件）
//   ・一覧の作り直しで子 sitemap が1つ欠けても、欠けた一覧を7日間使う作りだった
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isTransient, recordTransient, recordVisit, makeBreaker, pickDropped, pickRolling, parseState,
} from "../src/repark-enumerate.js";
import { bukCode } from "../src/times.js";

const T = (pref, city, buk) => `https://times-info.net/${pref}/${city}/park-detail-${buk}/`;
const at = "2026-10-18T03:00:00.000Z";
const h = (x) => new Date(Date.parse(at) - x * 3600e3).toISOString();

test("相手先の不調かどうか: 通信の失敗・5xx・429・403 は不調、404 や robots.txt の見送りは不調ではない", () => {
  assert.equal(isTransient(null), true);                         // タイムアウト・通信の失敗
  assert.equal(isTransient({ ok: false, status: 503 }), true);
  assert.equal(isTransient({ ok: false, status: 502 }), true);
  assert.equal(isTransient({ ok: false, status: 429 }), true);
  assert.equal(isTransient({ ok: false, status: 403 }), true);
  assert.equal(isTransient({ ok: false, status: 404 }), false);  // 閉鎖
  assert.equal(isTransient({ ok: false, status: 410 }), false);
  assert.equal(isTransient({ ok: false, status: 400 }), false);
  assert.equal(isTransient({ ok: true, status: 200 }), false);
  assert.equal(isTransient({ ok: false, skippedReason: "robots.txt で Disallow: /x" }), false);
});

test("不調の1回目は時刻を進めず印だけ付け、次の回に先頭で取り直す", () => {
  const ids = [T("P13-tokyo", "C101", "BUK0000001"), T("P13-tokyo", "C101", "BUK0000002"), T("P13-tokyo", "C101", "BUK0000003")];
  const state = { [ids[0]]: `${h(200)}|5`, [ids[1]]: `${h(100)}|0`, [ids[2]]: `${h(50)}|0` };
  assert.equal(recordTransient(state, ids[0], at, { hours: true }), true);
  assert.equal(state[ids[0]], `${h(200)}|5|r`);
  // 読む側はこれまでどおり読める（時刻と時間帯マスクはそのまま）
  assert.deepEqual(parseState(state[ids[0]]), { t: Date.parse(h(200)), mask: 5, gone: false });
  assert.equal(String(state[ids[0]]).split("|")[0], h(200));     // studio-index.mjs の読み方
  // まだいちばん古いので、次の回の先頭に選ばれる（以前は今の時刻になり、1巡後ろへ回っていた）
  assert.equal(pickRolling(ids, state, 1, { at })[0], ids[0]);
});

test("不調が2回続いたら従来どおり時刻を進める（壊れたページが先頭に居座って巡回を止めないため）", () => {
  const id = T("P13-tokyo", "C101", "BUK0000001");
  const state = { [id]: `${h(200)}|5|r` };
  assert.equal(recordTransient(state, id, at, { hours: true }), false);
  assert.equal(state[id], `${at}|5`);
});

test("不調の印は、取れたら消える", () => {
  const id = T("P13-tokyo", "C101", "BUK0000001");
  const state = { [id]: `${h(200)}|5|r` };
  recordVisit(state, id, at, { ok: true, status: 200 }, { hours: true, seen: true });
  assert.equal(state[id], `${at}|${(5 | (1 << 12)).toString(36)}`);   // 03:00Z = 日本時間12時
});

test("一度も取っていない物件・時間帯を持たない社・閉鎖の物件の不調", () => {
  const id = "REP0000001";
  const s1 = {};
  assert.equal(recordTransient(s1, id, at), true);
  assert.equal(s1[id], "1970-01-01T00:00:00.000Z|0|r");
  assert.equal(parseState(s1[id]).t, 0);                           // いちばん古い＝次の回の先頭
  const s2 = { [id]: h(10) };                                        // 時間帯を持たない社は ISO だけ
  assert.equal(recordTransient(s2, id, at), true);
  assert.equal(s2[id], `${h(10)}|0|r`);
  assert.equal(recordTransient(s2, id, at), false);
  assert.equal(s2[id], at);
  const s3 = { [id]: `GONE|${h(800)}` };                             // 寝かせ期間が切れて取りに行ったら不調だった
  assert.equal(recordTransient(s3, id, at), false);
  assert.equal(s3[id], `GONE|${at}`);                                // 閉鎖のまま寝かせ直す（生き返らせない）
});

test("404 と 410 は閉鎖として寝かせる", () => {
  const s = {};
  recordVisit(s, "a", at, { ok: false, status: 404 }, { hours: true });
  recordVisit(s, "b", at, { ok: false, status: 410 }, { hours: true });
  assert.equal(s.a, `GONE|${at}`);
  assert.equal(s.b, `GONE|${at}`);
});

test("不調が8件続いたら打ち切る。相手先が答えたら数え直す", () => {
  const b = makeBreaker(8);
  for (let i = 0; i < 7; i++) assert.equal(b.fail(), false);
  b.ok();                                                            // 1件取れた（または404）
  for (let i = 0; i < 7; i++) assert.equal(b.fail(), false);
  assert.equal(b.fail(), true);
});

test("一覧から消えた物件のうち、今の一覧を作ってから確かめていないものだけを古い順に選ぶ", () => {
  const listAt = Date.parse(h(24));
  const list = [T("P13-tokyo", "C101", "BUK0000001"), T("P13-tokyo", "C101", "BUK0000002")];
  const goneOld = T("P13-tokyo", "C102", "BUK0000010");
  const droppedA = T("P13-tokyo", "C103", "BUK0000011");
  const droppedB = T("P27-osaka", "C104", "BUK0000012");
  const checked = T("P27-osaka", "C105", "BUK0000013");
  const moved = T("P13-tokyo", "C999", "BUK0000002");               // URL だけ変わって、同じ番号が一覧にある
  const state = {
    _list: "2:abc",
    [list[0]]: `${h(300)}|0`, [list[1]]: `${h(300)}|0`,
    [goneOld]: `GONE|${h(900)}`,                                     // もう閉鎖の印がある
    [droppedA]: `${h(500)}|3`,
    [droppedB]: `${h(900)}|0|r`,                                     // 前の回に不調で取れなかった
    [checked]: `${h(2)}|1`,                                          // 一覧を作ったあとに確かめ済み
    [moved]: `${h(700)}|0`,
  };
  assert.deepEqual(pickDropped(list, state, listAt, 100, bukCode), [droppedB, droppedA]);
  assert.deepEqual(pickDropped(list, state, listAt, 1, bukCode), [droppedB]);   // 1回あたりの上限
  // 番号で照合しないと、URL が変わっただけの物件まで選んでしまう
  assert.deepEqual(pickDropped(list, state, listAt, 100), [droppedB, moved, droppedA]);
  // 一覧を作った時刻が分からなければ何も選ばない
  assert.deepEqual(pickDropped(list, state, -Infinity, 100, bukCode), []);
  // 確かめて 404 なら閉鎖、載っていれば時刻が進み、次に一覧を作り直すまで選ばれない
  recordVisit(state, droppedA, at, { ok: false, status: 404 }, { hours: true });
  recordVisit(state, droppedB, at, { ok: true, status: 200 }, { hours: true, seen: true });
  assert.deepEqual(pickDropped(list, state, listAt, 100, bukCode), []);
  assert.ok(state[droppedA].startsWith("GONE|"));
});
