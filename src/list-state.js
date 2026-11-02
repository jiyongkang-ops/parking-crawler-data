// 一覧型の社（NPC・ザ・パーク・GSパーク・パークネット・エムデン）の、物件ごとの「一覧に載っていた最後の日」 -------------
// 一覧型は毎回全件を取るので、巡回型のような物件ごとの記録（状態ファイル）が無かった。分析側（parking-price-crawler の
// studio-index.mjs）は直近の回の日付を全件の「最後に確かめた日」にしていて、先方の一覧から消えた物件（閉鎖など）も
// 毎日確かめた扱いのまま相場に残っていた（11/1 に NPC 41件・ザ・パーク 38件。「【閉鎖】新町2丁目（熊本）」など。2026-11-02 点検 C5・fresh-8）。
// そこで一覧を全部取れた回だけ、巡回型と同じ名前・同じ読み方のファイルを2つ書く（分析側の studio-data.yml がそのまま写し、studio-index.mjs が読む）:
//   data/<op>-crawl-state.json … { 物件の番号: "YYYY-MM-DD" }。その物件が、全部取れた一覧に最後に載っていた日（UTC の日付。
//                                巡回型の状態ファイルの ISO の日付と同じ）。日付だけにしてあるので、ファイルが変わるのは1日1回と、
//                                一覧が変わったときだけ（毎時の回で毎回書き換えると、毎回コミットが増えてデータのリポジトリが太る）
//   data/<op>-ids.txt         … 今の一覧（1行1件・番号の順）
// 番号は料金の記録の parkId と同じもの。一覧から消えた物件は前の日付のまま残す（閉鎖の印 GONE は付けない。相場から外すかは分析側で決める）。
// 書かない回（前の2つのファイルをそのまま残す）:
//   ・取れなかった・途中までしか取れなかった回（呼ぶ側が complete に false を渡す。途中のページの失敗・上限で切れた一覧など）
//   ・料金を書かない回（writer が false。NPC は crawl.yml と crawl-npc.yml の両方が取るので、書くのは料金を書く crawl.yml だけ）
//   ・今の一覧が前の一覧の9割に満たない回（一斉の閉鎖の歯止めと同じ考え。一度に1割以上が消えたように見えるのは、先方の不調・作り替えの
//     ことが多い）。health は ok:false（stale-list）にして知らせる（noteListState）。本当に減ったと確かめたら、data/<op>-ids.txt を消すと
//     次の回から今の一覧で書き直す
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./write-atomic.js";

/** 今の一覧がこの割合より前の一覧から減っていたら書かない（今の一覧 < 前の一覧 × この割合） */
export const LIST_KEEP_RATIO = 0.9;

/** 事業者の状態ファイルと一覧のパス（巡回型と同じ名前。分析側はこの名前で読む） */
export const listStateFiles = (op, dir = "data") => ({
  stateFile: path.join(dir, `${op}-crawl-state.json`), idsFile: path.join(dir, `${op}-ids.txt`),
});

const readLines = (file) => {
  try { return fs.readFileSync(file, "utf8").split("\n").map((s) => s.trim()).filter(Boolean); } catch { return []; }
};
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const readState = (file) => {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || typeof j !== "object" || Array.isArray(j)) return {};
    // 日付（YYYY-MM-DD）の値だけを引き継ぐ（手で直した・壊れた値を前の日付として残さない）
    return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === "string" && DAY.test(v)));
  } catch { return {}; }   // 初回・壊れている（書き直す）
};

/** 一覧を全部取れた回の番号（ids）で、状態ファイルと一覧を書く。today は "YYYY-MM-DD"（既定は今の UTC の日付）。
 *  戻り値: { written, n（今の一覧の件数）, prev（前の一覧の件数）, added（前の一覧に無く今回載った件数）,
 *           dropped（状態ファイルにあって今の一覧に無い件数）, reason（書かなかった理由） } */
export function updateListState(op, ids, { dir = "data", today = new Date().toISOString().slice(0, 10), keepRatio = LIST_KEEP_RATIO } = {}) {
  if (!DAY.test(today)) throw new Error(`today は YYYY-MM-DD で渡す: ${today}`);
  const { stateFile, idsFile } = listStateFiles(op, dir);
  // 1行1件で書くので、空の番号・改行の入った番号は入れない（料金の記録の番号はどれも1行に収まる）
  const list = [...new Set(ids.map((x) => String(x ?? "").trim()))].filter((x) => x && !/[\r\n]/.test(x)).sort();
  const prevIds = readLines(idsFile);
  if (!list.length) return { written: false, n: 0, prev: prevIds.length, added: 0, dropped: 0, reason: "一覧が0件" };
  if (prevIds.length && list.length < prevIds.length * keepRatio) {
    return { written: false, n: list.length, prev: prevIds.length, added: 0, dropped: 0,
      reason: `一覧が前の回の${Math.round(keepRatio * 100)}%に満たない（${list.length}件・前の回${prevIds.length}件）ので、`
        + `物件ごとの記録（${path.basename(stateFile)}）を進めない。本当に減ったと確かめたら ${path.basename(idsFile)} を消すと次の回から書き直す` };
  }
  const prev = readState(stateFile);
  const listed = new Set(list);
  const before = new Set(prevIds);
  // 番号の順に並べて書く（同じ中身なら同じファイルになり、毎時の回でもコミットが増えない）
  const state = {};
  let dropped = 0;
  for (const id of [...new Set([...Object.keys(prev), ...list])].sort()) {
    if (listed.has(id)) state[id] = today;
    else { state[id] = prev[id]; dropped++; }
  }
  fs.mkdirSync(path.resolve(dir), { recursive: true });
  writeFileAtomic(stateFile, JSON.stringify(state, null, 0));
  writeFileAtomic(idsFile, list.join("\n") + "\n");
  return { written: true, n: list.length, prev: prevIds.length, added: prevIds.length ? list.filter((id) => !before.has(id)).length : 0,
    dropped, reason: null };
}

/** run.js の一覧型の処理から呼ぶ。complete … 一覧を全部取れた回か。writer … この回が書く回か（料金を書かない回は false）。
 *  書かなかった（書く回でない・全部取れていない）ときは null、書いた・書くのを止めたときは updateListState の戻り値 */
export function recordListState(op, ids, { complete, writer = true, log = console, ...opts } = {}) {
  if (!writer) return null;
  if (!complete) { log.log(`[${op}] 一覧を全部は取れなかったので、物件ごとの記録（${op}-crawl-state.json）は進めない`); return null; }
  const r = updateListState(op, ids, opts);
  if (r.written) {
    log.log(`[${op}] 物件ごとの記録: 一覧の${r.n}件に今日の日付を付けた（一覧に無い${r.dropped}件は前の日付のまま`
      + `${r.added ? `・新しく載った${r.added}件` : ""}）`);
  } else log.warn(`::warning::[${op}] ${r.reason}`);
  return r;
}

/** health の行（run.js の hp で足したもの）に、書くのを止めたこと（一覧が前の回より減りすぎ）を反映する。
 *  取れた回でも ok:false・stale-list にして知らせる（黙って日付が止まり、60日後に全件へ「60日より前」の印が付く前に気づけるように）。
 *  書いた回・書く回でなかった回（r が null）は何も変えない */
export function noteListState(row, r) {
  if (!row || !r || r.written || !r.n) return row;
  row.ok = false;
  row.kind = "stale-list";
  row.reason = r.reason;
  row.list = { n: r.n, prev: r.prev };
  return row;
}
