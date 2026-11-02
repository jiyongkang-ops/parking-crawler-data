// 作り直した一覧が前より極端に少ないときの共通の守り（2026-11-02 点検 maint-09） -----------------------------
// 一覧づくり（*-enumerate.js）の多くは、途中のページが取れなくても先へ進むか、そこで打ち切って、少ない一覧でファイルを上書きする。
// セイワパークと近鉄不動産は途中の1ページが取れないだけで一覧を打ち切り、あなぶきとパークネットは取れなかったページを飛ばす。
// メンテナンス明けなど相手先が不安定なときに起きやすく、欠けた一覧がそのまま7日間使われる（その分の物件を1週間回らない。
// 一覧型のパークネットでは、取っていない市区の物件まで「今日確かめた」ことになる）。
// 守りがあったのはリパーク・名鉄協商（cache-age.js keepPrevIfShrunk）とタイムズ・ナビパーク・エコロ（自前で前の一覧の9割・半分）だけで、
// 社ごとに足すと漏れるので、run.js で作り直す前の一覧と比べる共通の守りにする。
//
// 決まり: 作り直した一覧が前の一覧の minRatio（既定9割。タイムズ・ナビパークと同じ）未満で、かつ minDrop（既定10件）以上減ったら、
// 作り直しの失敗とみなして前の一覧に戻す。ファイルと取得日（.fetched）も作り直す前の中身に戻すので、次の回にまた作り直す。
// 戻した一覧には staleReason を付ける（run.js が health に ok:false・kind stale-list で出して知らせる）。
// あなぶきは sitemap（約517件）と和集合を取るので、一覧のページ送りが全部だめでも前の795件の66%が残る。半分の基準では気づけない。
// 相手先が本当に物件を大きく減らしたときは、前の一覧で回り続けて毎回知らせる。人が確かめて新しい一覧でよければ、
// LIST_SHRINK_OK=<op>（カンマ区切り）を付けて1回回すと、その回は守りを外して新しい一覧を使う
import fs from "node:fs";
import path from "node:path";

export const LIST_MIN_RATIO = 0.9;
export const LIST_MIN_DROP = 10;

const stampOf = (file) => `${path.resolve(file)}.fetched`;
const readOrNull = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return null; } };

/** 作り直す前の一覧のファイルと取得日の中身を控える（作り直すと上書きされるので、一覧づくりの前に呼ぶ）。ファイルが無ければ null */
export function snapshotList(file) {
  const text = readOrNull(path.resolve(file));
  return text == null ? null : { text, stamp: readOrNull(stampOf(file)) };
}

/** 控えた中身に戻す。取得日が無かったときは消す（次の回に作り直す） */
function restoreList(file, snap) {
  fs.writeFileSync(path.resolve(file), snap.text);
  if (snap.stamp == null) fs.rmSync(stampOf(file), { force: true });
  else fs.writeFileSync(stampOf(file), snap.stamp);
}

/** 作り直した一覧（list）を前の一覧（prev）と比べ、極端に少なければファイルを戻して前の一覧（staleReason つき）を返す。
 *  そうでなければ list をそのまま返す。比べないのは: 前の一覧が無い・作り直していない（取得日が控えと同じ＝キャッシュのまま）・
 *  一覧づくりが自分で前の一覧に戻した（staleReason がある）・LIST_SHRINK_OK でその社を外したとき。
 *  file … 一覧のファイル（snap はその控え。snapshotList）。op … LIST_SHRINK_OK と照らす事業者の名前 */
export function guardShrunkList({ op, label, file, snap, prev, list, minRatio = LIST_MIN_RATIO, minDrop = LIST_MIN_DROP, env = process.env }) {
  if (!snap || !prev?.length || !Array.isArray(list) || list.staleReason) return list;
  if (readOrNull(stampOf(file)) === snap.stamp) return list;
  const drop = prev.length - list.length;
  if (list.length >= prev.length * minRatio || drop < minDrop) return list;
  const why = `一覧が${prev.length}件 → ${list.length}件に減った（${Math.round(minRatio * 100)}%未満は作り直しの失敗とみなす）`;
  const accept = String(env.LIST_SHRINK_OK ?? "").split(",").map((s) => s.trim()).includes(op);
  if (accept) {
    console.warn(`::warning::[${label}] ${why}が、LIST_SHRINK_OK で新しい一覧を使う`);
    return list;
  }
  try { restoreList(file, snap); } catch (e) { console.error(`[${label}] 前の一覧に戻せませんでした: ${e.message}`); }
  console.warn(`::warning::[${label}] ${why}。前の一覧（${prev.length}件）を使い、次の回に作り直す`);
  const old = [...prev];
  old.staleReason = `一覧を作り直せていない: ${why}。前の一覧で回している`;
  return old;
}
