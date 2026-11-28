#!/usr/bin/env bash
# 東京（Cloud Build・asia-northeast1）の中で巡回する（2026-11-28。理由は scripts/tokyo-prepare.sh の先頭）。
# 呼び出し: .github/workflows/crawl-tokyo.yml →（gcloud builds submit）→ cloudbuild-tokyo.yaml → ここ。
# 結果（料金の記録・health・対象の社の状態・この回のログ）を tokyo-out.tgz にまとめ、Cloud Build が GCS に置く。
# 巡回が失敗しても、そこまでの記録と health（失敗の理由）を持ち帰れるように、この手順は 0 で終える
# （Cloud Build は手順が失敗すると結果を置かないため）。npm ci の失敗だけは失敗で終える（巡回していない）。
set -uo pipefail
OPS=${TOKYO_OPS:-coinpark,parkjapan,park1st}
if [ -z "${TOKYO_SKIP_NPM:-}" ]; then
  npm ci --no-audit --no-fund || { echo "npm ci に失敗しました（巡回していません）"; exit 1; }
fi
CRAWL_ONLY="$OPS" OUT_FILE="data/prices-tokyo.jsonl" HEALTH_NAME="crawl-tokyo" LIST_SHRINK_OK="${LIST_SHRINK_OK:-}" \
  node src/run.js 2>&1 | tee data/tokyo-run.log
code=${PIPESTATUS[0]}
echo "巡回の終了コード: $code" | tee -a data/tokyo-run.log
FILES=(data/tokyo-run.log)
for f in data/prices-tokyo.jsonl data/health/crawl-tokyo.json; do [ -e "$f" ] && FILES+=("$f"); done
for op in ${OPS//,/ }; do for f in data/"$op"-*; do [ -e "$f" ] && FILES+=("$f"); done; done
tar czf tokyo-out.tgz "${FILES[@]}"
echo "持ち帰るもの: ${#FILES[@]}ファイル"
exit 0
