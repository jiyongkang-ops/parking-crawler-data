// 書き換えるファイルを「全部書けた新しい中身」か「前のまま」のどちらかにする書き込み。
// 同じフォルダの一時ファイルに書いてから rename で置き換える（同じフォルダの中の rename は一度に入れ替わる）。
//
// 2026-10-18 点検の指摘: 巡回状態（data/*-crawl-state.json）を writeFileSync で直接書いていたので、
// 書いている途中（ファイルを空にしてから書き終わるまで）に巡回が止められると、壊れた JSON がそのままコミットされた。
// そうなると巡回は {} から始め直し（閉鎖の印と時間帯の記録を失い、404 の物件をまた取りに行く）、
// studio-index はその社の状態ファイルを読み飛ばす（閉鎖の物件が相場に戻り、全物件に「60日より前」の印が付く）。
//
// 一時ファイルは「.<元の名前>.<pid>.tmp」。rename の前に止められると残るが、.gitignore で外してあるのでコミットされない。
import fs from "node:fs";
import path from "node:path";

export function writeFileAtomic(file, data) {
  const abs = path.resolve(file);
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, abs);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 消せなくても元の失敗を伝える */ }
    throw e;
  }
}
