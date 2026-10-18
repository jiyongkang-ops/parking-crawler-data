// 優先物件の照合のテスト（npm test）。事業者サイトには繋がない。
// 2026-10-17: タイムズの優先物件は BUK… で届くのに、巡回の一覧・状態ファイルはページのURLで持っていたため
// 1件も当たらず、622件が優先されていなかった。番号どうしで照合するようにしたので、それを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPriority, pickRolling } from "../src/repark-enumerate.js";
import { bukCode } from "../src/times.js";

const T = (pref, city, buk) => `https://times-info.net/${pref}/${city}/park-detail-${buk}/`;
const timesList = [
  T("P13-tokyo", "C101", "BUK0010203"),
  T("P13-tokyo", "C102", "BUK0010444"),
  T("P14-kanagawa", "C152", "BUK0081660"),
  T("P27-osaka", "C118", "BUK0081720"),
];

test("タイムズ: BUK… の優先物件を、一覧のURLに読み替えて当てる", () => {
  const want = ["BUK0010203", "BUK0081720", "BUK9999999"];
  // 読み替えないと（以前の作り）1件も当たらない
  assert.deepEqual(matchPriority(want, timesList).ids, []);
  const { ids, missing } = matchPriority(want, timesList, bukCode);
  assert.deepEqual(ids, [timesList[0], timesList[3]]);
  assert.equal(missing, 1);   // 一覧に無い番号は数えてログに出す
});

test("タイムズ: 同じ番号が2回届いても1件として扱う", () => {
  const { ids, missing } = matchPriority(["BUK0010444", "BUK0010444"], timesList, bukCode);
  assert.deepEqual(ids, [timesList[1]]);
  assert.equal(missing, 0);
});

test("リパーク: 番号と一覧の書き方が同じなので、読み替えなしでそのまま当たる（今までどおり）", () => {
  const list = ["REP0011419", "REP0028040", "REP0028041"];
  const { ids, missing } = matchPriority(["REP0028041", "REP0000001"], list);
  assert.deepEqual(ids, ["REP0028041"]);
  assert.equal(missing, 1);
});

test("タイムズ: 読み替えた優先物件は、取り直しの間隔を過ぎていれば全国の巡回より先に選ばれる", () => {
  const at = "2026-10-17T03:00:00.000Z";
  const h = (x) => new Date(Date.parse(at) - x * 3600e3).toISOString();
  // 一覧の先頭2件はいちばん古い（全国の巡回ならこちらが先）。優先の2件は 25時間前・10時間前
  const state = {
    [timesList[0]]: `${h(30 * 24)}|0`,
    [timesList[1]]: `${h(29 * 24)}|0`,
    [timesList[2]]: `${h(25)}|0`,
    [timesList[3]]: `${h(10)}|0`,
  };
  const { ids: prio } = matchPriority(["BUK0081660", "BUK0081720"], timesList, bukCode);
  const batch = pickRolling(timesList, state, 1, { at, priority: prio, priorityMinAgeMs: 20 * 3600e3 });
  // 25時間前のものは20時間を過ぎているので先頭に入る。10時間前のものはまだ（毎回取り直さない）
  assert.deepEqual(batch, [timesList[2], timesList[0]]);
});
