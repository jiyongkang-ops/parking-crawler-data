// 巡回の起動（crawl.yml の dispatch ジョブ）のテスト（npm test）。GitHub にも事業者サイトにも繋がない。
// dispatch ジョブの手順（run: | の中身）をそのまま bash で動かし、gh と date だけを差し替える。
//   - gh: 起動（workflow run）は手元のファイルに作成時刻を足すだけ。一覧（run list）はそのファイルから返す
//   - date: 「今」を FAKE_NOW（エポック秒）にする。-d @N（GNU の書き方）は BSD（macOS）の date には -r N で渡す
// 2026-10-18: GitHub の cron が遅れ・落ちて、エコロ・ナビパーク・名鉄協商・NPC の回数が予定より少なかった（14日で約2割欠け）。
//   毎時確実に動く crawl.yml から JST の決まった時刻に起動するようにし、各ワークフローの cron は外した。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = path.join(ROOT, ".github/workflows");
const readWf = (f) => fs.readFileSync(path.join(WF_DIR, f), "utf8");

// もとの cron（UTC）。回数はこのまま、時刻は07分の起動でいちばん近い JST の時にする（publish だけは studio-data の7:30より前の6時）
const ORIGINAL_CRON = {
  "crawl-others.yml": "0 1,7,13 * * *",
  "crawl-npc.yml": "13 1,7,13,19 * * *",
  "crawl-navipark.yml": "0 2,8,14 * * *",
  "crawl-extra.yml": "30 2,14 * * *",
  "crawl-ecolo.yml": "0 4,10,16 * * *",
  "crawl-extra2.yml": "30 5,17 * * *",
  "crawl-extra3.yml": "30 8,20 * * *",
  "crawl-carshares.yml": "0 18 * * *",
  "publish.yml": "40 21 * * *",
};
// 起動する JST の時（crawl.yml の FIXED と同じであること）
const EXPECTED_HOURS = {
  "crawl-others.yml": [10, 16, 22],
  "crawl-npc.yml": [4, 10, 16, 22],
  "crawl-navipark.yml": [11, 17, 23],
  "crawl-extra.yml": [11, 23],
  "crawl-ecolo.yml": [1, 13, 19],
  "crawl-extra2.yml": [2, 14],
  "crawl-extra3.yml": [5, 17],
  "crawl-carshares.yml": [3],
  "publish.yml": [6],
};
const DISPATCHED = [...Object.keys(EXPECTED_HOURS), "crawl-times.yml"];

// タイムズの時間割（2026-10-17〜）。D は JST の通し日
const timesHours = (D) => {
  const A = 9 + ((D + 5) % 6);
  return [A, A + 6, (21 + ((7 * D + 11) % 12)) % 24];
};
const jst = (epoch) => new Date((epoch + 9 * 3600) * 1000);
const jstDayOfYear = (epoch) => {
  const d = jst(epoch);
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 864e5) + 1;
};
const jstDate = (epoch) => jst(epoch).toISOString().slice(0, 10);
// JST の日時 → エポック秒
const epochJst = (y, mo, d, h, mi = 7, s = 5) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - 9 * 3600;

// ---- crawl.yml から dispatch ジョブの手順を取り出す ----
function dispatchScript() {
  const lines = readWf("crawl.yml").split("\n");
  const at = lines.findIndex((l) => l.trim() === "- name: dispatch crawls due this hour (JST)");
  assert.ok(at >= 0, "crawl.yml に dispatch の手順がある");
  const runAt = lines.findIndex((l, i) => i > at && /^\s+run: \|\s*$/.test(l));
  const indent = lines[runAt + 1].match(/^ */)[0].length;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== "" && l.match(/^ */)[0].length < indent) break;
    body.push(l.slice(indent));
  }
  return body.join("\n") + "\n";
}
// ---- crawl.yml の各ジョブのブロック（2つ空けの行から次のジョブの手前まで）----
function jobBlock(text, job) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l === `  ${job}:`);
  assert.ok(at >= 0, `ジョブ ${job} がある`);
  let end = at + 1;
  while (end < lines.length && !/^ {2}[\w-]+:\s*$/.test(lines[end]) && !/^\S/.test(lines[end])) end++;
  return lines.slice(at, end).join("\n");
}
// ---- on: のブロック（コメントは除く）----
function onBlock(text) {
  const lines = text.split("\n").filter((l) => !/^\s*#/.test(l));
  const at = lines.findIndex((l) => /^on:/.test(l));
  assert.ok(at >= 0);
  let end = at + 1;
  while (end < lines.length && (/^\s/.test(lines[end]) || lines[end] === "")) end++;
  return lines.slice(at, end).join("\n");
}

// ---- 差し替えの gh と date ----
const REAL_DATE = spawnSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();
// GNU の date は -d @N、BSD（macOS）の date は -r N
const DATE_AT = spawnSync(REAL_DATE, ["--version"]).status === 0 ? "-d @" : "-r ";
function makeEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crawl-dispatch-"));
  const bin = path.join(dir, "bin");
  const state = path.join(dir, "gh");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(state, "runs"), { recursive: true });
  fs.writeFileSync(
    path.join(bin, "date"),
    `#!/bin/bash
# テスト用の date。「今」は FAKE_NOW。-d @N（GNU の書き方）は、手元の date に合わせて渡す
args=(); at="$FAKE_NOW"
while [ $# -gt 0 ]; do
  case "$1" in
    -d) at="\${2#@}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec ${REAL_DATE} ${DATE_AT}"$at" "\${args[@]}"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/bash
# テスト用の gh。起動は runs/<ワークフロー> に作成時刻を足す。一覧はそこから新しい順に返す
echo "$*" >> "$FAKE_GH/calls.log"
if [ "$1 $2" = "workflow run" ]; then
  wf=$3
  if [ -e "$FAKE_GH/fail-run" ]; then echo "HTTP 500: Server Error" >&2; exit 1; fi
  date -u +%Y-%m-%dT%H:%M:%SZ >> "$FAKE_GH/runs/$wf"
  # 先方では起動できているのに、返事が届かず失敗に見えるとき
  if [ -e "$FAKE_GH/fail-run-after-create" ]; then echo "connection reset" >&2; exit 1; fi
  echo "✓ Created workflow_dispatch event for $wf at main"
  exit 0
fi
if [ "$1 $2" = "run list" ]; then
  if [ -e "$FAKE_GH/fail-list" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
  shift 2; wf=""; lim=20; jq=""
  while [ $# -gt 0 ]; do
    case "$1" in
      -w) wf=$2; shift 2 ;;
      -L) lim=$2; shift 2 ;;
      --jq) jq=$2; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ "$jq" != ".[].createdAt" ]; then echo "このテストの gh は --jq '.[].createdAt' しか知らない: $jq" >&2; exit 2; fi
  if [ -e "$FAKE_GH/runs/$wf" ]; then sort -r "$FAKE_GH/runs/$wf" | head -n "$lim"; fi
  exit 0
fi
echo "想定していない gh の呼び出し: $*" >&2; exit 3
`,
    { mode: 0o755 },
  );
  const script = path.join(dir, "dispatch.sh");
  fs.writeFileSync(script, dispatchScript());
  let calls = 0;
  return {
    state,
    flag(name, on = true) {
      const p = path.join(state, name);
      if (on) fs.writeFileSync(p, "");
      else fs.rmSync(p, { force: true });
    },
    // 1回動かす。返り値: 終了コード・出力・この回で起動したワークフロー
    // extraEnv … ロケールなどを足して動かすとき（LC_ALL など）
    run(now, extraEnv = {}) {
      const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
        encoding: "utf8",
        env: { PATH: `${bin}:${process.env.PATH}`, FAKE_NOW: String(now), FAKE_GH: state, GITHUB_REPOSITORY: "owner/repo", GH_TOKEN: "dummy", ...extraEnv },
      });
      const log = fs.existsSync(path.join(state, "calls.log")) ? fs.readFileSync(path.join(state, "calls.log"), "utf8").trim().split("\n") : [];
      const mine = log.slice(calls);
      calls = log.length;
      const dispatched = mine.filter((l) => l.startsWith("workflow run ")).map((l) => l.split(" ")[2]);
      return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), dispatched, calls: mine };
    },
    runsOf(wf) {
      const p = path.join(state, "runs", wf);
      return fs.existsSync(p) ? fs.readFileSync(p, "utf8").trim().split("\n") : [];
    },
  };
}

test("時刻表: もとの cron と同じ回数で、時刻はいちばん近い JST の時（07分起動）", () => {
  const script = dispatchScript();
  const fixed = Object.fromEntries(
    script
      .match(/FIXED='([^']*)'/)[1]
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .map(([wf, ...hs]) => [wf, hs.map(Number)]),
  );
  assert.deepEqual(fixed, EXPECTED_HOURS);
  for (const [wf, cron] of Object.entries(ORIGINAL_CRON)) {
    const [min, hours] = cron.split(" ");
    const orig = hours.split(",").map((h) => ((Number(h) + 9) % 24) * 60 + Number(min)); // JST の分
    const now = EXPECTED_HOURS[wf].map((h) => h * 60 + 7);
    assert.equal(now.length, orig.length, `${wf} の1日の回数はもとのまま`);
    for (const o of orig) {
      const diff = Math.min(...now.map((n) => Math.min(Math.abs(n - o), 1440 - Math.abs(n - o))));
      assert.ok(diff <= 37, `${wf}: もとの JST ${Math.floor(o / 60)}:${String(o % 60).padStart(2, "0")} に近い時がある（差 ${diff} 分）`);
    }
  }
  // タイムズの式は 2026-10-18 まで crawl ジョブの先頭にあったものと同じ
  assert.ok(script.includes("A=$(( 9 + (D + 5) % 6 )); B=$(( A + 6 )); C=$(( (21 + (7 * D + 11) % 12) % 24 ))"));
});

test("毎時の起動を7日ぶん動かすと、各ワークフローが予定どおりの回数・時刻で起動される（警告なし）", () => {
  const env = makeEnv();
  const perDay = {}; // 日付 → ワークフロー → [JST の時]
  // 前の日の21〜23時は慣らし（それより前の回が無いので、取り戻しの起動と警告が出る）。数えるのは 10/19 0時から
  const start = epochJst(2026, 10, 18, 21);
  for (let i = 0; i < 3 + 7 * 24; i++) {
    const now = start + i * 3600;
    const r = env.run(now);
    assert.equal(r.code, 0, r.out);
    if (i < 3) continue;
    assert.ok(!r.out.includes("::warning::"), r.out);
    const day = jstDate(now);
    const H = jst(now).getUTCHours();
    for (const wf of r.dispatched) ((perDay[day] ??= {})[wf] ??= []).push(H);
    // 起動は main・このリポジトリに対して
    for (const c of r.calls.filter((c) => c.startsWith("workflow run "))) assert.match(c, /--ref main -R owner\/repo$/);
  }
  const days = Object.keys(perDay).sort();
  assert.equal(days.length, 7);
  for (const day of days) {
    const D = jstDayOfYear(Date.parse(`${day}T12:00:00+09:00`) / 1000);
    assert.deepEqual(Object.keys(perDay[day]).sort(), [...DISPATCHED].sort(), day);
    for (const [wf, hours] of Object.entries(EXPECTED_HOURS)) assert.deepEqual(perDay[day][wf], hours, `${day} ${wf}`);
    assert.deepEqual(perDay[day]["crawl-times.yml"], [...timesHours(D)].sort((a, b) => a - b), `${day} タイムズ`);
  }
});

test("同じ時に2回起動されても（手での実行・Cloud Scheduler の二重の起動）、2回目は何も起動しない", () => {
  const env = makeEnv();
  const first = env.run(epochJst(2026, 10, 20, 10, 7));
  assert.deepEqual(first.dispatched.sort(), ["crawl-npc.yml", "crawl-others.yml"]);
  const again = env.run(epochJst(2026, 10, 20, 10, 41));
  assert.equal(again.code, 0);
  assert.deepEqual(again.dispatched, []);
  assert.match(again.out, /crawl-others\.yml（JST 10時の回）: この時の回はもう起動されています/);
});

// 2026-10-19 点検: 変数のすぐ後ろに全角の文字を続ける書き方（"$WF（$WHEN）"）は、UTF-8 のロケールの bash 3.2（macOS）で
// 全角の文字の先頭のバイトまで変数の名前とみなされ、表示が空になった。表示の変数は {} で囲む（GitHub の ubuntu では起きない）
test("UTF-8 のロケールでも、知らせの文にワークフローの名前と回が出る", () => {
  const UTF8 = ["C.UTF-8", "en_US.UTF-8", "ja_JP.UTF-8"].find((l) =>
    spawnSync("bash", ["-c", "printf x"], { env: { LC_ALL: l }, encoding: "utf8" }).stderr === "");
  const env = makeEnv();
  env.run(epochJst(2026, 10, 20, 9), { LC_ALL: UTF8 ?? "C" });
  const r11 = env.run(epochJst(2026, 10, 20, 11), { LC_ALL: UTF8 ?? "C" });
  assert.match(r11.out, /::warning::crawl-others\.yml（JST 10時の回）が起動されていなかったので、いま起動します（1時間遅れ）/);
  assert.match(r11.out, /起動しました: crawl-navipark\.yml（JST 11時の回）/);
  const again = env.run(epochJst(2026, 10, 20, 11, 40), { LC_ALL: UTF8 ?? "C" });
  assert.match(again.out, /crawl-navipark\.yml（JST 11時の回）: この時の回はもう起動されています/);
  // crawl.yml の表示の文で、全角の文字の前の変数はすべて {} で囲む
  const bad = dispatchScript().split("\n").filter((l) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(l));
  assert.deepEqual(bad, [], "全角の文字の前の変数に {} が無い行");
});

test("Cloud Scheduler が1時間抜けても、次の時に取り戻す（1回だけ・警告つき）。3時間抜けた回は取り戻さない", () => {
  const env = makeEnv();
  env.run(epochJst(2026, 10, 20, 9));
  // 10時の起動が抜けた
  const r11 = env.run(epochJst(2026, 10, 20, 11));
  assert.equal(r11.code, 0);
  assert.deepEqual(r11.dispatched.sort(), ["crawl-extra.yml", "crawl-navipark.yml", "crawl-npc.yml", "crawl-others.yml"]);
  assert.match(r11.out, /::warning::crawl-others\.yml（JST 10時の回）が起動されていなかったので、いま起動します（1時間遅れ）/);
  const r12 = env.run(epochJst(2026, 10, 20, 12));
  assert.ok(!r12.dispatched.includes("crawl-others.yml") && !r12.dispatched.includes("crawl-npc.yml"), "取り戻しは1回だけ");
  assert.ok(!r12.out.includes("::warning::"), r12.out);

  // 16・17・18時が抜けた → 19時の起動で 17時の回（2時間前）は取り戻す。16時の回（3時間前）は取り戻さない
  const r19 = env.run(epochJst(2026, 10, 20, 19));
  assert.ok(r19.dispatched.includes("crawl-navipark.yml") && r19.dispatched.includes("crawl-extra3.yml"), r19.out);
  assert.ok(r19.dispatched.includes("crawl-ecolo.yml"));
  assert.ok(!r19.dispatched.includes("crawl-others.yml") && !r19.dispatched.includes("crawl-npc.yml"), r19.out);
});

test("gh の起動が失敗しても手順は成功で終わり（毎時の巡回を止めない）、次の時に取り戻す", () => {
  const env = makeEnv();
  env.flag("fail-run");
  const r10 = env.run(epochJst(2026, 10, 20, 10));
  assert.equal(r10.code, 0, "起動の失敗で手順を失敗にしない");
  assert.match(r10.out, /::warning::crawl-others\.yml（JST 10時の回）を起動できませんでした。次の時の回でもう一度試します/);
  assert.match(r10.out, /::warning::crawl-npc\.yml（JST 10時の回）を起動できませんでした/);
  env.flag("fail-run", false);
  const r11 = env.run(epochJst(2026, 10, 20, 11));
  assert.deepEqual(r11.dispatched.sort(), ["crawl-extra.yml", "crawl-navipark.yml", "crawl-npc.yml", "crawl-others.yml"]);
  assert.equal(env.runsOf("crawl-others.yml").length, 1);
  // 取り戻せる時間（2時間）を過ぎても失敗が続いたときは、その回はあきらめる
  env.flag("fail-run");
  env.run(epochJst(2026, 10, 20, 16));
  env.run(epochJst(2026, 10, 20, 17));
  const r18 = env.run(epochJst(2026, 10, 20, 18));
  assert.equal(r18.code, 0);
  assert.match(r18.out, /::warning::crawl-others\.yml（JST 16時の回）を起動できませんでした。取り戻せる時間（2時間）を過ぎたので、この回は動きません/);
  env.flag("fail-run", false);
  const r19 = env.run(epochJst(2026, 10, 20, 19));
  assert.ok(!r19.dispatched.includes("crawl-others.yml"), "3時間前の回は起動しない");
});

test("起動できていたのに失敗に見えたとき（返事が届かない）は、次の時に二重に起動しない", () => {
  const env = makeEnv();
  env.flag("fail-run-after-create");
  const r10 = env.run(epochJst(2026, 10, 20, 10));
  assert.equal(r10.code, 0);
  env.flag("fail-run-after-create", false);
  const r11 = env.run(epochJst(2026, 10, 20, 11));
  assert.ok(!r11.dispatched.includes("crawl-others.yml"), r11.out);
  assert.equal(env.runsOf("crawl-others.yml").length, 1);
});

test("起動済みかを確かめられない（gh run list の失敗）ときは、この時の回は起動し、取り戻しはしない", () => {
  const env = makeEnv();
  env.run(epochJst(2026, 10, 20, 9));
  env.flag("fail-list");
  // 10時の起動が抜けたあとの11時。10時の回は確かめられないので起動しない（二重に起動しないため）
  const r11 = env.run(epochJst(2026, 10, 20, 11));
  assert.equal(r11.code, 0);
  assert.deepEqual(r11.dispatched.sort(), ["crawl-extra.yml", "crawl-navipark.yml"]);
  assert.match(r11.out, /::warning::crawl-others\.yml（JST 10時の回）: 起動済みかを確かめられないので、取り戻しの起動はしません/);
});

test("年をまたいでも、タイムズは1日3回・回と回の間は6時間以上", () => {
  const env = makeEnv();
  const times = [];
  const start = epochJst(2026, 12, 30, 21); // 最初の3回は慣らし。数えるのは 12/31 と 1/1
  for (let i = 0; i < 3 + 48; i++) {
    const now = start + i * 3600;
    const r = env.run(now);
    assert.equal(r.code, 0);
    if (i >= 3 && r.dispatched.includes("crawl-times.yml")) times.push(now);
  }
  assert.equal(times.length, 6, "2日で6回");
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 6 * 3600, `間が6時間以上: ${jst(times[i - 1]).toISOString()} → ${jst(times[i]).toISOString()}`);
});

test("起動するワークフローは cron を持たず、入力なしで動き、前の回と重ならない", () => {
  const script = dispatchScript();
  const lookback = Number(script.match(/^LOOKBACK=(\d+)/m)[1]);
  for (const wf of DISPATCHED) {
    const text = readWf(wf);
    const on = onBlock(text);
    assert.ok(!/schedule:|cron:/.test(on), `${wf} の on: に schedule が無い（両方あると同じ回が2回走る）`);
    assert.match(on, /workflow_dispatch:/, `${wf} は workflow_dispatch で起動できる`);
    // 入力があるなら、すべて既定値つき（gh workflow run は入力を渡さない）
    if (/inputs:/.test(on)) {
      for (const m of on.matchAll(/^ {6}([\w-]+):\n((?: {8}.*\n?)*)/gm)) assert.ok(/default:/.test(m[2]) || !/required: true/.test(m[2]), `${wf} の入力 ${m[1]} に既定値がある`);
    }
    // 同じワークフローは1つずつ（前の回が残っていたら終わるのを待つ。取り消さない）
    assert.match(text, /concurrency:\n\s+group: [\w-]+\n\s+cancel-in-progress: false/, `${wf} の concurrency`);
    // 回と回の最短の間が、ジョブの時間切れと取り戻しの幅より長い（ふつうは前の回が終わっている。同じ回を2回数えない）
    const timeout = Number(text.match(/^ {4}timeout-minutes: (\d+)/m)[1]);
    let gaps;
    if (wf === "crawl-times.yml") {
      gaps = [];
      let prev = null;
      for (let t = epochJst(2026, 10, 17, 0, 0, 0); t < epochJst(2028, 12, 31, 0, 0, 0); t += 3600) {
        if (timesHours(jstDayOfYear(t)).includes(jst(t).getUTCHours())) {
          if (prev !== null) gaps.push((t - prev) / 3600);
          prev = t;
        }
      }
    } else {
      const hs = EXPECTED_HOURS[wf];
      gaps = hs.map((h, i) => (i + 1 < hs.length ? hs[i + 1] - h : hs[0] + 24 - h));
    }
    const minGap = Math.min(...gaps);
    assert.ok(minGap * 60 > timeout, `${wf}: 最短の間 ${minGap} 時間 > 時間切れ ${timeout} 分`);
    assert.ok(minGap > lookback, `${wf}: 最短の間 ${minGap} 時間 > 取り戻しの幅 ${lookback} 時間`);
  }
});

test("crawl.yml: 起動は別のジョブで、毎時の巡回とはつながず、起動の権限はそのジョブだけ", () => {
  const text = readWf("crawl.yml");
  assert.ok(!/schedule:|cron:/.test(onBlock(text)));
  const crawl = jobBlock(text, "crawl");
  const dispatch = jobBlock(text, "dispatch");
  assert.ok(!/needs:/.test(crawl) && !/needs:/.test(dispatch), "どちらも needs でつながない（起動の失敗で巡回が止まらない）");
  assert.ok(!/gh workflow run/.test(crawl), "巡回のジョブでは起動しない");
  assert.match(dispatch, /permissions:\n\s+actions: write/);
  const top = text.slice(text.indexOf("\npermissions:"), text.indexOf("\njobs:"));
  assert.ok(!/^\s+actions: write/m.test(top), "ワークフロー全体には actions: write を付けない");
  // 起動の手順は最後に必ず成功で終わる
  assert.match(dispatchScript(), /^set \+e\b/);
  assert.match(dispatchScript(), /\nexit 0\s*$/);
});

test("ほかのワークフローも、起動の一覧と二重にならない（cron を持つものは crawl.yml から起動しない）。README に一覧がある", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  for (const f of fs.readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"))) {
    const hasCron = /schedule:|cron:/.test(onBlock(readWf(f)));
    if (hasCron) assert.ok(!DISPATCHED.includes(f), `${f} は cron と crawl.yml の両方から起動されている`);
    assert.ok(readme.includes(f), `README の「定期実行の起動」に ${f} がある`);
  }
});
