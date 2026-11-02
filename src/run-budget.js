// 毎時の回の取得の予算（2026-11-02 点検 pipeline-01） --------------------------------------
// 毎時の巡回（crawl.yml。NPC とリパーク）は毎時07分に始まり、取得は ROLLING_BUDGET_MIN の50分で切り上げる。
// ただ予算は取得を始めてから数えるので、その前のリポジトリの取り出し（actions/checkout）が延びると、そのぶん終わりも遅れる。
// 取り出しは data/ が増えるのに合わせて 9/22 の7秒から 10/30 の中央値80秒（最長104秒）まで延び、
// 10/25〜11/01 の191回では最長56.0分（中央値51.6分）かかって、次の回までの余裕は約4分だった。
// そこで「次の時の02分」（ROLLING_END_BY_MIN）までに取得を終えるよう、予算を自動で縮める。
// ふだんの回（08〜09分に取得を始める）は今と同じ50分のまま。取り出しが遅い日・前の回が長引いて順番待ちのあとに始まった回だけ短くなり、
// 次の回（07分に起動）に追いつく。

/** 取得を終える時刻（ミリ秒）。startMs … 巡回を始めた時刻。endByMin … 次の時の何分までに終えるか（0〜59。
 *  空・数値でないときは null＝縮めない）。日本時間と UTC は9時間ちょうどの差なので、正時はどちらで数えても同じ */
export function deadlineOf(startMs, endByMin) {
  if (endByMin == null || endByMin === "") return null;
  const m = Number(endByMin);
  if (!Number.isFinite(m) || m < 0 || m >= 60) return null;
  return (Math.floor(startMs / 3600e3) + 1) * 3600e3 + m * 60e3;
}

/** その社の取得の予算（分）。budgetMin と「startMs（予算を数え始める時刻）から deadlineMs までの分」の短いほう。
 *  deadlineMs が無ければ budgetMin のまま。短くても floorMin 分は取る（0分にすると1件も取らずに終わり、遅れが取り戻せないまま続く） */
export function budgetUntil(budgetMin, { startMs = Date.now(), deadlineMs = null, floorMin = 5 } = {}) {
  if (deadlineMs == null) return budgetMin;
  const left = Math.floor((deadlineMs - startMs) / 60e3);
  return Math.max(Math.min(budgetMin, floorMin), Math.min(budgetMin, left));
}
