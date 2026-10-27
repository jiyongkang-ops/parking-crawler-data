// 保留（config の hold）。人が見て「相手先のサイトが一時停止している」と確かめた社を、期限つきで寝かせる（2026-10-27）。
//
// なぜ要るか: 名鉄協商（mkp.jp）と近鉄不動産は 2026-10-21 から「セキュリティ対策のため Web サイトを一時停止」
// 「緊急メンテナンス」になったが、GitHub のサーバーには告知のページではなく素の 403・タイムアウトだけが返る。
// 巡回の側からはメンテナンスと見分けられず「断られている（blocked）」と記録され、分析の側は 14日記録が増えないと
// その社の全物件に「60日より前」の印を付ける（studio-seen.mjs stuckOps）。止まっているだけなのに相場から外れていく。
//
// 保留のあいだは:
//   ・その回の失敗は「メンテナンス（maintenance）」と記録する（理由に保留の訳と期限を出す）
//   ・様子見の1件だけを取る（打ち切りの数を1にする。今は1回に8件以上送って 403 を受けていた）。取れたらそのまま続けて再開する
//   ・一覧は作り直さない（前の一覧で回す。一覧の作り直しで何十回も送らないため）
// 期限を過ぎたら保留は効かなくなり、いつもどおりに戻る（消し忘れても困らない）。止めている社（paused）とは別:
// paused は先方に断られた社で、許可が出るまで一切送らない。hold は先方が止まっているだけの社。

/** 今日（日本時間）が保留の期限までなら { until, reason } を返す。期限の書き方が違う・過ぎていれば null */
export function holdOf(t, now = new Date()) {
  const h = t?.hold;
  if (!h || !/^\d{4}-\d{2}-\d{2}$/.test(String(h.until ?? ""))) return null;
  const today = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
  return today <= h.until ? { until: h.until, reason: String(h.reason ?? "相手先のサイトが一時停止") } : null;
}

/** 保留中に取れなかった回の health の理由 */
export const holdReason = (hold, why) =>
  `保留中（${hold.until}まで）: ${hold.reason}。様子見の1件も取れなかった${why ? `（${why}）` : ""}`;
