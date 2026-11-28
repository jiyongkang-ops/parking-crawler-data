#!/usr/bin/env bash
# 東京（Google Cloud の Cloud Build・asia-northeast1）で巡回するときの「送るもの」を1つのフォルダにまとめる（2026-11-28）。
# 使い方: bash scripts/tokyo-prepare.sh <空のフォルダ>
#
# なぜ東京から取るのか:
#   コインパーク・パークジャパン・Park1st. は、GitHub のサーバー（米国）からつなぐと入口（robots.txt）で返事が無く時間切れになる
#   （2026-11-27 23:07・11-28 2:07 の回。11/27 に東京の Google Cloud から試したときは3社ともつながった）。
#   コインパーク・パークジャパンは国外からのアクセスを止める設定がある会社（Xserver）のサーバー、Park1st. は阪急阪神の自社の回線で、
#   日本の外からのアクセスを止めている＝地域の制限で、クローラを狙ったものではない見込み。
#   本人「東京からとって」（2026-11-28。at PARKING を東京から取るのと同じ形・2026-11-08 了承）。
#   名乗り（UA）・robots.txt・間隔・1回の件数・断られたら止める、はふだんの巡回と同じ（src/run.js と config.js をそのまま使う）。
#   東京からも断られたら、それは本当に断られたので取りに行くのをやめる（回り込まない）。
#
# 送るのは、巡回の中身（src・config.js・package*.json）と、対象の社の状態だけ（リポジトリを丸ごと送らない）。
# data/priority-lots.json は読むだけ（毎時の crawl.yml が書く。持ち帰らない）。
set -euo pipefail
DEST=${1:?送り先のフォルダを指定してください}
OPS=${TOKYO_OPS:-coinpark,parkjapan,park1st}
mkdir -p "$DEST/data/health" "$DEST/scripts"
cp -R src config.js package.json package-lock.json "$DEST/"
cp scripts/tokyo-crawl.sh "$DEST/scripts/"
cp cloudbuild-tokyo.yaml "$DEST/"
for op in ${OPS//,/ }; do
  case "$op" in *[!a-z0-9]*|"") echo "社の名前が正しくありません: $op" >&2; exit 2;; esac
  for f in data/"$op"-*; do [ -e "$f" ] && cp "$f" "$DEST/data/"; done
done
for f in data/prices-tokyo.jsonl data/health/crawl-tokyo.json data/priority-lots.json; do
  [ -e "$f" ] && cp "$f" "$DEST/$f"
done
echo "送るもの: $(cd "$DEST" && find . -type f | wc -l | tr -d ' ')ファイル（社: $OPS）"
