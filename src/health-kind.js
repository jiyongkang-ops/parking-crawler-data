// health の行の種類（kind）と状態コードの件数（statusCounts） ------------------------------------------
// 毎朝の Advisor のお知らせで「断られている」と「一時的な失敗」が区別できなかった（2026-10-18 点検 blocked-4）。
// 断られて直らない2社が、ほかの社に何か起きた朝のたびに並び、本当に見るべき一時的な失敗（エコロの通信エラー257回など）が
// 埋もれていた。逆に、新しく 403 で断られ始めた社があっても reason の文だけでは見分けられなかった。
// そこで run.js の health の行に、次の2つを足す（Advisor の crawl-health が読む op・label・ok・n・reason の形と意味は変えない）。
//
// kind … ok:false の行にだけ付ける（ok:true の行には付けない）
//   paused     … 止めている（config.js の paused。先方に断られていて、許可が出るまでアクセスしない）
//   blocked    … 断られた（401・403。robots.txt が 401・403、robots.txt の Disallow で見送った分も含む）
//   rate       … 多すぎると言われた（429。robots.txt が 429 のときも）
//   network    … 届かない（通信の失敗・タイムアウト・5xx・robots.txt に届かない・タイムズの「混み合っております」のページ）
//   parse      … 取れたが読めない（解析の失敗・名前が読めない・0件・404 などで物件として読めなかった）
//   stale-list … 一覧を作り直せていない（前の一覧で回している・一覧が0件・一覧が作れない）
//   mass-gone  … 閉鎖が一斉に出たので止めた（先方のサイトの作り替え・保守の見込み）
//   ※「巡回全体」の行（途中の例外・止められた回。run.js の writeFailedHealth）と「未対応の target」の行（config.js の書き間違い）には
//     kind を付けない（相手先の答えではなく、こちらの問題のため）
//   2026-10-18 の1回目の直しでは unreachable（robots.txt に届かない）・transient（不調で打ち切り）と書いていた。
//   それぞれ network（429 なら rate）と、打ち切るまでに続いた失敗の種類にそろえた（読む側はまだ無い）
//
// statusCounts … 送った本ページ（詳細・一覧のページ）の HTTP の状態コードごとの件数（例 {"200":880,"403":3}）。
//   応答が無かった通信の失敗・タイムアウトは "network" に数える。robots.txt で見送った分（送っていない）は数えない

export const KINDS = ["paused", "blocked", "rate", "network", "parse", "stale-list", "mass-gone"];

/** 状態コード → 失敗の種類。2xx なら null。
 *  404・410（閉鎖）・転送などのほかの答えは、先方は答えたが物件として読めなかったので parse */
export function kindOfStatus(status) {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "blocked";
  if (status === 429) return "rate";
  if (status >= 500) return "network";
  return "parse";
}

/** politeFetch の結果 → 失敗の種類。res が無い（例外）は通信の失敗。取れた（2xx）なら null */
export function kindOfFetch(res) {
  if (!res) return "network";
  if (res.blocked) return "blocked";                                         // robots.txt が 401・403
  if (res.transient) return /HTTP 429\b/.test(res.robotsError ?? "") ? "rate" : "network";   // robots.txt に届かない
  if (res.skippedReason) return "blocked";                                   // robots.txt の Disallow（送っていない）
  return kindOfStatus(res.status);
}

/** 失敗の文（一覧づくりの例外・reason）→ 種類。分からなければ null（呼ぶ側が決める） */
export function kindOfText(msg) {
  const s = String(msg ?? "");
  if (/^停止中/.test(s)) return "paused";
  if (/robots\.txt が HTTP 40[13]|断られている|Disallow|HTTP 40[13]\b/.test(s)) return "blocked";
  if (/HTTP 429\b/.test(s)) return "rate";
  if (/robots\.txt に届かない|fetch failed|TIMEOUT|timed? ?out|aborted|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR|socket|HTTP 5\d\d\b/i.test(s)) return "network";
  if (/(?<![\d０-９])0件|構造|解析|読めない/.test(s)) return "parse";
  return null;
}

// 件数が同じなら、手を打つべきものを先に出す
const ORDER = ["blocked", "rate", "network", "parse"];
/** 種類ごとの件数 → いちばん多い種類（無ければ null） */
export function dominantKind(counts) {
  let best = null, n = 0;
  for (const k of ORDER) if ((counts[k] ?? 0) > n) { best = k; n = counts[k]; }
  return best;
}

/** 件数を数える小さな入れ物。add(key) で1つ足し、toJSON で { key: 件数 } を返す */
export function makeCounter() {
  const m = {};
  return { add(k) { if (k != null) m[k] = (m[k] ?? 0) + 1; }, get size() { return Object.keys(m).length; }, toJSON: () => ({ ...m }), counts: m,
    reset() { for (const k of Object.keys(m)) delete m[k]; } };
}

/** 送った1件の状態コードを数える（statusCounts）。res が無い（例外）は "network"、robots.txt で見送った分は数えない */
export function countStatus(counter, res) {
  if (!res) { counter.add("network"); return; }
  if (res.blocked || res.transient || res.skippedReason) return;
  counter.add(String(res.status));
}
