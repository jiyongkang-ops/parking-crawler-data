// 一覧のページを番号の順に読む社の「続き」（2026-11-27 本人「全部直して」）。いまはザ・パーク（約440ページ）だけが使う。
//
// なぜ要るか: ザ・パークは 2026-11-13 から、毎回どこかで1ページだけ HTTP 500 が返り（5〜381ページ目のどこか・毎回違う）、
// そこで打ち切っていた。次の回はまた1ページ目から読み直すので、後ろのページにずっと届かず、11/13〜11/27 の間
// 一度も最後まで取れなかった（7日以内に確かめた物件は 3,811件中48件だけ）。
// そこで、止まったページの番号と、そこまでに読んだ物件の番号を data/<op>-list-progress.json に残し、
// 次の回はそのページから続ける。続きを使うのは、読み始めてから RESUME_MS（24時間）以内だけ
// （それより古い続きは捨てて1ページ目から読む。ページの中身は物件の増減で少しずつずれるため）。
// 最後のページまで読んだら（全部取れたかどうかにかかわらず）ファイルを消す。
import fs from "node:fs";
import path from "node:path";
import { writeFileAtomic } from "./write-atomic.js";

/** 続きを使う長さ（読み始めてから） */
export const RESUME_MS = 24 * 3600e3;

export const progressFile = (op, dir = "data") => path.join(dir, `${op}-list-progress.json`);

/** 続きを読む。無い・壊れている・古い（RESUME_MS より前に読み始めた）ときは null */
export function readProgress(file, now = Date.now()) {
  let j;
  try { j = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  if (!j || typeof j !== "object" || !Number.isInteger(j.next) || j.next < 0 || !Array.isArray(j.ids)) return null;
  const started = Date.parse(j.startedAt);
  if (!Number.isFinite(started) || now - started > RESUME_MS || started > now + 60_000) return null;
  return {
    startedAt: j.startedAt, next: j.next,
    ids: j.ids.map(String), pages: Number(j.pages) || null, total: Number(j.total) || null,
    hidden: Number(j.hidden) || 0, skipped: Array.isArray(j.skipped) ? j.skipped.filter(Number.isInteger) : [],
    // 地図の口で読むとき（ザ・パーク。2026-11-27）: mode "map"・まだ読んでいない範囲（queue）・取れなかった範囲（skippedBoxes）。
    // 範囲は [北, 西, 南, 東]
    mode: typeof j.mode === "string" ? j.mode : "pages",
    queue: Array.isArray(j.queue) ? j.queue.filter(isBox) : [],
    skippedBoxes: Array.isArray(j.skippedBoxes) ? j.skippedBoxes.filter(isBox) : [],
  };
}

const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every((x) => Number.isFinite(x));

/** 続きを書く。ids は番号の順に並べる（同じ中身なら同じファイル） */
export function writeProgress(file, p) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileAtomic(file, JSON.stringify({
    startedAt: p.startedAt, ...(p.mode && p.mode !== "pages" ? { mode: p.mode } : {}),
    next: p.next, pages: p.pages ?? null, total: p.total ?? null, hidden: p.hidden ?? 0,
    skipped: [...new Set(p.skipped ?? [])].sort((a, b) => a - b),
    ...(p.queue ? { queue: p.queue } : {}), ...(p.skippedBoxes ? { skippedBoxes: p.skippedBoxes } : {}),
    ids: [...new Set(p.ids)].sort(),
  }));
}

export function clearProgress(file) {
  try { fs.unlinkSync(file); } catch { /* 無ければよい */ }
}
