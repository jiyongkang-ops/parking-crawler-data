// MAYパーク（日本メカトロニクス / aaa-mtc.jp）のテスト（npm test）。事業者サイトには繋がない（保存したページと、差し替えた fetch を使う）。
// 2026-11-02 追加。見本は 2026-11-01 に当ボットで取った一覧のページ（Shift_JIS のまま。test/fixtures/maypark/may.html）。
// 料金は金額が先（「100円/30分　700円/昼間」）で、共通の parseFeeBlock にそのまま渡すと「30分700円」「最大100円」と読み違える
// （0件にならないので0件の歯止めでは気づけない。2026-11-01 見直し）。maypark.js で読める形に直してから渡す。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "../config.js";
import { parseFeeBlock } from "../src/jp-fee-text.js";
import { parseMayList, parseMayFee, normalizeMayFee, parseMayCapacity, excludeReason, listUrl, ENCODING } from "../src/maypark.js";
import { politeFetch, _resetRobotsCache } from "../src/polite-fetch.js";
import { markMaintenance, entryOf } from "../src/maintenance.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BYTES = fs.readFileSync(path.join(ROOT, "test/fixtures/maypark/may.html"));
const HTML = new TextDecoder("shift_jis").decode(BYTES);
const { records, excluded, boxes } = parseMayList(HTML);
const lot = (name) => records.find((r) => r.name === name) ?? assert.fail(`${name} が無い`);
const U = (scope, timeRange, perMinutes, amountYen) => ({ scope, timeRange, perMinutes, amountYen });
const M = (scope, condition, amountYen) => ({ scope, condition, amountYen });

// ---- 料金の読み取り ----

test("料金: 金額が先の「100円/30分 700円/昼間」。今の parseFeeBlock だと読み違える書き方を、直してから渡す（瓦町）", () => {
  const raw = "8～18時　100円/30分　700円/昼間<br />18～8時　100円/60分　600円/夜間";
  const wrong = parseFeeBlock(raw);   // 見直しで確かめた読み違い（30分700円・最大100円）
  assert.ok(wrong.unitCharges.some((u) => u.perMinutes === 30 && u.amountYen === 700));
  assert.deepEqual(parseMayFee(raw), {
    unitCharges: [U("全日", "8:00-18:00", 30, 100), U("全日", "18:00-8:00", 60, 100)],
    maxFees: [M("全日", "8:00-18:00 最大", 700), M("全日", "18:00-8:00 最大", 600)],
  });
  const r = lot("瓦町");   // 実物のページでも同じ（Parkopedia の控え「08:00-18:00 30分100円 ／ 最大700円 ／ 18:00-08:00 最大600円」と一致）
  assert.deepEqual([r.unitCharges, r.maxFees], [parseMayFee(raw).unitCharges, parseMayFee(raw).maxFees]);
  assert.equal(r.address, "愛知県名古屋市中区栄5-8-13");
  assert.equal(r.capacity, 10);
  assert.equal(r.parkId, "瓦町");
  assert.equal(r.sourceUrl, "https://aaa-mtc.jp/may/index.html");
});

test("料金: 24時間の上限（「600円/24H」「24h最大800円」「24時間最大 1,200円」）と夜間の上限、「最大400円」は同じ行の時間帯", () => {
  assert.deepEqual([lot("赤池").unitCharges, lot("赤池").maxFees], [[U("全日", "全日", 60, 100)],
    [M("全日", "24時間最大", 600), M("全日", "18:00-8:00 最大", 300)]]);
  const n = lot("名駅南");
  assert.deepEqual(n.unitCharges, [U("全日", "8:00-19:00", 20, 200), U("全日", "19:00-8:00", 30, 100)]);
  assert.deepEqual(n.maxFees, [M("全日", "19:00-8:00 最大", 400), M("全日", "24時間最大", 1200)]);
  assert.deepEqual(lot("志賀本通駅北").maxFees, [M("全日", "24時間最大", 800), M("全日", "18:00-8:00 最大", 600)]);
  // 「8～18時 100円/30分 800円/24H」は24時間の上限（時間帯に引きずられない）
  assert.deepEqual(lot("大曽根駅南第1").maxFees, [M("全日", "8時~18時 24時間最大", 800), M("全日", "18:00-8:00 最大", 400)]);
});

test("料金: 平日・土日祝・全日の区分（<平日> <土日祝> <全日>）。土日祝だけの上限は土日祝のまま（池上・黒川）", () => {
  const r = lot("池上");
  assert.deepEqual(r.unitCharges, [U("平日", "9:00-15:00", 30, 200), U("平日", "15:00-9:00", 30, 100), U("土日祝", "全日", 30, 100)]);
  // 「600円/（9～翌9時）最大」は丸1日の上限。区分は土日祝
  assert.deepEqual(r.maxFees, [M("土日祝", "24時間最大", 600), M("全日", "15:00-9:00 最大", 300)]);
  const k = lot("黒川");
  assert.deepEqual(k.maxFees, [M("土日祝", "8:00-20:00 最大", 800), M("全日", "20:00-8:00 最大", 500)]);
  assert.ok(k.unitCharges.every((u) => u.scope === "平日" || u.scope === "土日祝"));
});

test("料金: かっこの区分「(平日）（9～15時）」・行の後ろの区分「800円/昼間・平日」・「月～金 1400円/24H」", () => {
  const i = lot("いなり");
  assert.deepEqual(i.unitCharges, [U("平日", "9:00-15:00", 30, 300), U("平日", "15:00-18:00", 30, 100), U("平日", "18:00-9:00", 60, 100),
    U("土日祝", "9:00-18:00", 60, 200), U("土日祝", "18:00-9:00", 60, 100)]);
  assert.deepEqual(i.maxFees, [M("平日", "18:00-9:00 最大", 300), M("土日祝", "18:00-9:00 最大", 300), M("土日祝", "24時間最大", 500)]);
  // 橘: 行の後ろの区分はその行だけ。次の行（夜間）は全日に戻す
  assert.deepEqual(lot("橘").maxFees, [M("平日", "昼間最大", 800), M("土日祝", "昼間最大", 1000), M("全日", "20:00-8:00 最大", 400)]);
  assert.deepEqual(lot("丸の内").maxFees, [M("全日", "20:00-8:00 最大", 500), M("月~金", "24時間最大", 1400), M("土・日", "24時間最大", 700)]);
  // 二川: 行頭の「平日」「土日祝」も区分
  assert.deepEqual(lot("二川").maxFees, [M("平日", "入庫当日24時まで", 500), M("土日祝", "入庫当日24時まで", 1100)]);
});

test("料金: 普通車の料金だけを採る（(普)/(軽)、普通車/軽自動車、行の途中の「軽 400円/24H」「(小型)」）", () => {
  assert.deepEqual([lot("大曽根").unitCharges, lot("大曽根").maxFees], [[U("全日", "全日", 40, 200)], [M("全日", "24時間最大", 1000)]]);
  const c = lot("中村第2");
  assert.deepEqual(c.unitCharges, [U("全日", "8:00-17:00", 40, 100), U("全日", "17:00-8:00", 40, 100)]);
  assert.deepEqual(c.maxFees, [M("全日", "8時~17時 24時間最大", 400), M("全日", "17:00-8:00 最大", 200)]);
  const p = lot("Pat烏森");
  assert.deepEqual(p.maxFees, [M("全日", "24時間最大", 500), M("全日", "18:00-8:00 最大", 300)]);
  assert.deepEqual(lot("勝川第3").maxFees, [M("全日", "24時間最大", 800)]);
  assert.equal(lot("勝川第3").capacity, 36);   // 普通車17＋小型19
});

test("料金: 特別な日・特別な人・一部の区画・二輪の料金は採らない（イベント開催日・宿泊のお客様・No.○のみ・原付）", () => {
  // ドーム南: 【イベント開催日】の 300円/30分・2,000円 は採らない
  const d = lot("ドーム南");
  assert.deepEqual(d.unitCharges, [U("全日", "8:00-20:00", 30, 100), U("全日", "20:00-8:00", 60, 100)]);
  assert.deepEqual(d.maxFees, [M("全日", "8:00-20:00 最大", 400), M("全日", "20:00-8:00 最大", 200)]);
  // ヴィアイン椿: ホテルの宿泊客の 1,500円 は採らない（Parkopedia の控え「40分200円 ／ 24時間最大1800円」と一致）
  assert.deepEqual([lot("ヴィアイン椿").unitCharges, lot("ヴィアイン椿").maxFees], [[U("全日", "全日", 40, 200)], [M("全日", "24時間最大", 1800)]]);
  // 高辻: 「No.8～No.19のみ 1,200円/24H」は一部の区画だけなので採らない
  assert.deepEqual(lot("高辻").maxFees, [M("全日", "18:00-8:00 最大", 500)]);
  // 大須第5: 原付・自動二輪の行から先は採らない
  assert.deepEqual(lot("大須第5").unitCharges, [U("平日", "全日", 30, 100), U("土日祝縁日(28日)", "全日", 30, 200)]);
  assert.deepEqual(lot("大須第5").maxFees, [M("平日", "18:00-8:00 最大", 200)]);
  // 名駅北（車5台・バイク12台）: 料金の行に車種が無いので、台数の欄と同じ並びの1行目（車）だけ
  assert.deepEqual([lot("名駅北").unitCharges, lot("名駅北").maxFees], [[U("全日", "全日", 60, 200)], [M("全日", "6時間最大", 600)]]);
  // 勝川（立駐）（車・自転車・バイク）: 自転車の「一回利用 110円/24H」を24時間の上限にしない
  assert.deepEqual(lot("勝川（立駐）").maxFees, [M("全日", "24時間最大", 1000)]);
  assert.equal(lot("勝川（立駐）").capacity, 358);
});

test("料金: N時間の上限・無料の時間・「最初の60分」「以後」", () => {
  assert.deepEqual(lot("今池").maxFees, [M("全日", "12時間最大", 500)]);
  assert.deepEqual(lot("宮川駐車場").unitCharges, [U("全日", "全日", 60, 100)]);      // 最初の60分無料 / 以後100円/60分
  assert.deepEqual(lot("瀬戸市駅前駐車場").unitCharges, [U("全日", "全日", 30, 100)]);  // 最初の60分100円 は単価にしない
  assert.deepEqual(lot("愛知尾頭橋").unitCharges, [U("平日", "8:00-16:00", 30, 100), U("平日", "16:00-8:00", 240, 100), U("土日祝", "全日", 60, 200)]);
  assert.match(normalizeMayFee("入庫後15分以内無料<br />8～18時 100円/30分"), /^8時~18時 30分100円$/);
});

// ---- 記録しない物件 ----

test("記録しない: 駐輪場・バイク（名前か台数の欄）・月極専用・料金の文が無い。193区画のうち車の133件を記録する", () => {
  assert.equal(boxes, 193);
  assert.equal(records.length, 133);
  const why = {}; for (const e of excluded) why[e.reason] = (why[e.reason] ?? 0) + 1;
  assert.deepEqual(why, { "駐輪場・バイク": 52, "時間貸しの料金の文が無い": 5, "月極専用": 3 });
  const reason = (n) => excluded.find((e) => e.name === n)?.reason;
  assert.equal(reason("名古屋駅各駐輪場"), "駐輪場・バイク");
  assert.equal(reason("下園公園東"), "駐輪場・バイク");     // 名前に駐輪が無く、台数が自転車・バイクだけ
  assert.equal(reason("瑞穂桜山"), "駐輪場・バイク");
  assert.equal(reason("三河三谷"), "月極専用");
  assert.equal(reason("豊川駅東駐車場"), "時間貸しの料金の文が無い");   // 「一日500円」だけで時間の料金が無い
  assert.equal(reason("名古屋市立大学病院"), "時間貸しの料金の文が無い");
  assert.ok(records.every((r) => r.unitCharges.length > 0 && !/駐輪|自転車|バイク/.test(r.name)));
  assert.equal(new Set(records.map((r) => r.parkId)).size, records.length);   // 名前が番号。重なりは無い
  const cap = parseMayCapacity("<br />近日OPEN<br />10台");
  assert.equal(excludeReason({ name: "栄第3", cap, feeText: "近日OPEN", unitCharges: [U("全日", "全日", 30, 100)] }), "近日オープン");
});

test("住所・台数: 都道府県を足す（エリアの見出し）。住所でない行（管理所・電話・支店・交番）は飛ばす", () => {
  assert.equal(lot("赤池").address, "愛知県日進市赤池1-2709");
  assert.equal(lot("岐阜駅南").address, "岐阜県岐阜市加納菱野町4");          // もとから県があるものはそのまま
  assert.equal(lot("可児").address, "岐阜県可児市広見1丁目27-28");           // 岐阜エリアの見出しの下
  assert.equal(lot("上前津第3").address, "愛知県名古屋市中区上前津1-3-7");   // 「(岡崎信用金庫)」を外す
  assert.equal(lot("いなり").address, "愛知県豊川市旭町17");                // 同じ行の支店名を外す
  assert.equal(lot("蒲郡").address, "愛知県蒲郡市元町66-2");                // 2つ書かれていたら1つ目
  assert.equal(lot("安城西").address, null);                               // 「安城駅前交番」は住所ではない
  assert.equal(lot("多治見第二").capacity, 27);                            // 65台のうち時間貸27台
  assert.equal(lot("マックスバリュ本山第1・第2").capacity, 38);
  assert.equal(lot("今池").capacity, 185);                                 // （軽50台）は内数
});

// ---- 取得（Shift_JIS） ----

function stubFetch(routes) {
  _resetRobotsCache();
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const r = routes[String(url)] ?? { status: 404, body: "" };
    const bytes = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body ?? "", "utf8");
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: () => null },
      text: async () => bytes.toString("utf8"), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
  };
  return () => { globalThis.fetch = real; _resetRobotsCache(); };
}

test("取得: politeFetch に encoding を渡すと Shift_JIS で読む。渡さなければ今までどおり UTF-8（文字化けして0件）", async () => {
  const delay = config.minDelayMs; config.minDelayMs = 0;
  // robots.txt はトップへの 302（HTML が返る）＝決まりなし
  const restore = stubFetch({ "https://aaa-mtc.jp/robots.txt": { status: 200, body: "<html><title>株式会社日本メカトロニクス</title></html>" },
    [listUrl()]: { status: 200, body: BYTES } });
  try {
    const sj = await politeFetch(listUrl(), { encoding: ENCODING });
    assert.equal(sj.ok, true);
    assert.equal(parseMayList(sj.html).records.length, 133);
    const utf = await politeFetch(listUrl());
    assert.equal(parseMayList(utf.html).records.length, 0);
  } finally { restore(); config.minDelayMs = delay; }
});

test("メンテナンスの確かめ: MAYパークの入口（一覧のページ）は Shift_JIS で読む。ほかの社は今までどおり URL だけで呼ぶ", async () => {
  const asked = [];
  const sjis = Buffer.from([...Buffer.from("<html><head><title>"), 0x83, 0x81, 0x83, 0x93, 0x83, 0x65, 0x83, 0x69, 0x83, 0x93, 0x83, 0x58, 0x92, 0x86,
    ...Buffer.from("</title></head></html>")]);   // 「メンテナンス中」（Shift_JIS）
  const fetchTop = async (url, opts) => {
    asked.push([url, opts ?? null]);
    const html = opts?.encoding ? new TextDecoder(opts.encoding).decode(sjis) : "<html><title>ok</title></html>";
    return { ok: false, status: 403, html };
  };
  const rows = [{ op: "maypark", ok: false, kind: "parse", reason: "0件" }, { op: "keio", ok: false, kind: "parse", reason: "0件" },
    { op: "carmax", ok: false, kind: "blocked", reason: "HTTP 403" }];
  await markMaintenance(rows, fetchTop);
  assert.deepEqual(asked, [["https://aaa-mtc.jp/may/index.html", { encoding: "shift_jis" }], ["https://www.keiofudosan.co.jp/", null],
    ["http://www.carmax-parking.jp/25search/", null]]);
  assert.equal(rows[0].kind, "maintenance");
  assert.match(rows[0].reason, /メンテナンス中/);
  assert.equal(entryOf("maypark"), "https://aaa-mtc.jp/may/index.html");
});

// ---- 巡回（run.js を別のプロセスで通しで動かす） ----

test("巡回: 1回の取得で車の133件を記録し、health に記録しない区画の数を残す。0件の回は失敗", () => {
  const run = (body) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "maypark-run-"));
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    const page = path.join(dir, "page.bin");
    fs.writeFileSync(page, body);
    const calls = path.join(dir, "calls.txt");
    const preload = path.join(dir, "stub.mjs");
    fs.writeFileSync(preload, `
import fs from "node:fs";
import { config } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "config.js")).href)};
config.minDelayMs = 0;
const page = fs.readFileSync(${JSON.stringify(page)});
globalThis.fetch = async function stub(url) {
  const u = String(url);
  fs.appendFileSync(${JSON.stringify(calls)}, u + "\\n");
  const bytes = u === ${JSON.stringify(listUrl())} ? page : Buffer.from("<html><title>株式会社日本メカトロニクス</title></html>");
  return { ok: true, status: 200, headers: { get: () => null }, text: async () => bytes.toString("utf8"),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) };
};
`);
    const p = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, path.join(ROOT, "src/run.js")], {
      cwd: dir, encoding: "utf8", timeout: 60_000,
      env: { ...process.env, HEALTH_NAME: "test", OUT_FILE: "data/prices-test.jsonl", CRAWL_ONLY: "maypark" },
    });
    assert.equal(p.status, 0, `${p.stdout}\n${p.stderr}`);
    const pf = path.join(dir, "data/prices-test.jsonl");
    return {
      rows: fs.existsSync(pf) ? fs.readFileSync(pf, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
      health: JSON.parse(fs.readFileSync(path.join(dir, "data/health/test.json"), "utf8")).targets,
      calls: fs.readFileSync(calls, "utf8").split("\n").filter(Boolean),
    };
  };
  const ok = run(BYTES);
  assert.equal(ok.rows.length, 133);
  assert.ok(ok.rows.every((r) => r.operator === "maypark" && r.unitCharges.length && r.lat === null));
  assert.deepEqual(ok.calls, ["https://aaa-mtc.jp/robots.txt", listUrl()]);
  const h = ok.health.find((x) => x.op === "maypark");
  assert.deepEqual([h.ok, h.label, h.n, h.excluded], [true, "MAYパーク", 133, 60]);
  const empty = run(Buffer.from("<html><body>作りが変わった</body></html>"));
  const e = empty.health.find((x) => x.op === "maypark");
  assert.deepEqual([e.ok, e.n, e.reason, e.kind], [false, 0, "0件", "parse"]);
});
