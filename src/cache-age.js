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
