// 一覧（sitemap / ids）のキャッシュが古いかを判定する。
//
// もとは fs.statSync(...).mtimeMs を見ていたが、GitHub Actions の checkout は
// ファイルの mtime を毎回「今」にするため、CI では**一度も古いと判定されず**、
// 7日で更新するはずの一覧が7月9日のまま2か月止まっていた（全19事業者）。
// 新設・閉鎖が反映されず、消えた物件を叩き続ける原因にもなる。
//
// git に入っているファイルは最終コミット時刻を見る。無ければ mtime に戻す。
import fs from "node:fs";
import { execFileSync } from "node:child_process";

export function cacheAgeMs(file) {
  if (!fs.existsSync(file)) return Infinity;
  try {
    const ct = execFileSync("git", ["log", "-1", "--format=%ct", "--", file], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    if (ct) return Date.now() - Number(ct) * 1000;
  } catch { /* git が無い・追跡外 */ }
  return Date.now() - fs.statSync(file).mtimeMs;
}
export const cacheFresh = (file, cacheMs) => cacheAgeMs(file) < cacheMs;
