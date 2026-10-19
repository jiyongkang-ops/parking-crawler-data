// 一覧（sitemap / ids）を作り直す時期かを判定する。
//
// 二度外した経緯:
//   1. fs.statSync().mtimeMs → actions/checkout が毎回 mtime を「今」にするので永遠に新しい
//   2. git の最終コミット時刻 → checkout の既定は浅いクローン（fetch-depth: 1）で、
//      履歴が1件しかないため、どのファイルを問い合わせても先頭コミットの時刻＝「今」が返る
//
// 結局、取得した日をデータ自身に持たせるのがいちばん確か。
// 一覧のとなりに <file>.fetched（ISO文字列）を置き、これだけを見る。
import fs from "node:fs";
import path from "node:path";

const stampOf = (file) => `${path.resolve(file)}.fetched`;

/** 一覧を取り直した時刻を記録する。取り直した直後に必ず呼ぶ */
export function markFetched(file) {
  try { fs.writeFileSync(stampOf(file), new Date().toISOString()); } catch { /* 書けなくても巡回は続ける */ }
}

/** 最後に取り直してからの経過。記録が無ければ Infinity（＝作り直す） */
export function cacheAgeMs(file) {
  if (!fs.existsSync(path.resolve(file))) return Infinity;      // 一覧そのものが無い
  try {
    const t = Date.parse(fs.readFileSync(stampOf(file), "utf8").trim());
    if (Number.isFinite(t)) return Date.now() - t;
  } catch { /* 記録が無い */ }
  return Infinity;
}

// 1回の実行で作り直す一覧の数。全社ぶんを一度に取り直すと、その回の巡回の時間を食い潰す。
// 古いものから順に、毎回少しずつ入れ替える。
let refreshed = 0;
const MAX_REFRESH = Number(process.env.LIST_REFRESH_MAX) || 2;

export function cacheFresh(file, cacheMs) {
  const age = cacheAgeMs(file);
  if (age < cacheMs) return true;
  if (refreshed >= MAX_REFRESH) {
    console.log(`[list] ${file} は作り直し時期だが、この実行では見送る（1回あたり${MAX_REFRESH}件まで）`);
    return true;
  }
  refreshed++;
  console.log(`[list] ${file} を作り直す（前回の取得から ${(age / 864e5).toFixed(0)}日）`);
  return false;
}

// 一覧の作り直しに失敗した記録 <file>.failed（ナビパーク・エコロパーク）。
// 作り直せず前の一覧を使った回に書き、次に作り直しを試すまでの間をあけるのに使う（作り直せたら消す）。
// 1行「時刻 連続N回 理由」。N は続けて失敗した回数（以前の「時刻 理由」も読める。そのときは1回とみなす）
const failStampOf = (file) => `${path.resolve(file)}.failed`;

/** 失敗の記録 { at（ミリ秒）, count（続けて失敗した回数）, why }。無い・読めなければ null */
export function readFailStamp(file) {
  try {
    const m = fs.readFileSync(failStampOf(file), "utf8").trim().match(/^(\S+)(?: 連続(\d+)回)?(?: ([\s\S]*))?$/);
    const at = m ? Date.parse(m[1]) : NaN;
    if (!Number.isFinite(at)) return null;
    return { at, count: Number(m[2]) || 1, why: m[3] ?? "" };
  } catch { return null; }   // 記録が無い
}

/** 失敗の記録を書く（count は今回を含めて続けて失敗した回数）。書けなくても巡回は続ける */
export function writeFailStamp(file, why, count = 1) {
  try { fs.writeFileSync(failStampOf(file), `${new Date().toISOString()} 連続${count}回 ${why}`); } catch { /* 書けなくても巡回は続ける */ }
}

/** 失敗の記録を消す（作り直せたとき） */
export function clearFailStamp(file) {
  fs.rmSync(failStampOf(file), { force: true });
}

/** 作り直した一覧が前の一覧の minRatio（既定は半分）未満なら、作り直しの失敗とみなして前の一覧を返す。
 *  使ってよければ null。前の一覧を返すときは取得日（.fetched）を進めないので、次の回にまた作り直す。
 *  前の一覧には staleReason を付ける（run.js が health に ok:false で出して知らせる）。新しい一覧が少なく、
 *  前の一覧も無ければ例外。欠けた一覧で上書きすると、外れた物件を7日間取りに行かなくなるため
 *  （ナビパークは robots.txt に届かない回に0件の一覧を書き、1,283件を7日間回らなくなるところだった。2026-10-18 の点検） */
export function keepPrevIfShrunk(label, list, prev, minRatio = 0.5) {
  if (list.length > 0 && list.length >= prev.length * minRatio) return null;
  const why = `一覧が${list.length}件しか取れなかった（前回${prev.length}件）`;
  if (!prev.length) throw new Error(why);
  console.warn(`::warning::[${label}] ${why}。前の一覧を使い、次の回に作り直す`);
  const old = [...prev];
  old.staleReason = `一覧を作り直せていない: ${why}`;
  return old;
}
