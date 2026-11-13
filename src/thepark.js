// ザ・パーク（第一興商 / dkparking.com）のパーサ ----------------------------
// 2026-11-10 にサイトが作り直され、全物件が入った data/search.json は無くなった（404 の画面へ転送される）。
// いまは一覧のページが使っている GET /proxy/parkings/hourly?number=<0始まりのページ> を番号の順に読む。
//   1ページ10件（size は効かない）・絞り込みを付けなければ全国（約4,400件・約440ページ）。番号（id）の小さい順に並ぶ
//   各物件: id, facility_id, name, prefecture_name, city_name, address1〜3, latitude/longitude, parking_lot_capacity,
//           fee_info（掲示の文。left/right が曜日の区分）, is_available_24h, business_hours_from/to, close_at, use_in_website
// 番号は作り直しで振り直されている（前の id 22 は愛媛の「西条大町」、いまの id 22 は釧路）。前の番号と混ざらないよう、
// 物件の番号（parkId）は facility_id（「HH-00337」。詳細ページの URL にも使われている）にする
// 料金は fee_info の文（「07:00～19:00　最大料金　1000円<br>19:00～07:00　最大料金　800円」「オールタイム　40分　100円」）を
// 今までの parsePrice で読む。fee_days_of_the_week（数字だけの形）は時間帯が入っていない（start_time が null）ので使わない
// robots.txt は制限なし。

const LIST_API = "https://www.dkparking.com/proxy/parkings/hourly";
const SITE = "https://www.dkparking.com";

/** 一覧の n ページ目（0始まり）の URL */
export function listUrl(n = 0) {
  return `${LIST_API}?number=${n}`;
}

// 記録の読み方の版。読み方を変えたら上げる（分析側は版が変わった回を料金改定にしない）
//   2 … 2026-11-08 単価の読み違いを直した（下の parsePrice）
//   3 … 2026-11-13 作り直されたサイトに合わせた（番号は facility_id・料金は fee_info の文・名前に「ザ・パーク」が付く）
export const PARSE_VERSION = 3;

// 全角→半角の正規化（数字・英字・記号・スペース）。NFKC で全角の数字・Ｈ・コロン・スラッシュ・チルダが半角になる
function normalize(s) {
  return (s || "")
    .replace(/<[^>]+>/g, " ") // 残存タグ(<font>等)を除去
    .normalize("NFKC")
    .replace(/[～〜∼]/g, "~")
    .replace(/(\d)\s*[hH](?![a-zA-Z])/g, "$1時間") // 「24H」「24ｈ」は24時間
    .replace(/\s+/g, " ")
    .trim();
}

const TIME = /(\d{1,2}:\d{2}|\d{1,2}時)\s*[~\-−ー]\s*(\d{1,2}:\d{2}|\d{1,2}時)/g;
const hhmm = (x) => (/時$/.test(x) ? `${x.replace("時", "")}:00` : x);
const DAY = /(月\s*[~\-]\s*金|月~土|平日|土\s*[・,、]?\s*日\s*[・,、]?\s*祝日?|土日祝日?|土日|日祝日?|土曜|日曜)/;

// price文字列 → { unitCharges, maxFees }
// 1行に単価と最大が並ぶ掲示が多い（「オールタイム30分/200円 入庫後12時間毎最大1,200円」「21:00~8:00 30分100円 夜間最大300円」）。
// 以前は行の最初の額だけを取り、単価を最大料金にしていた（「30分/」の斜線・全角数字・額の後ろの最大を読めなかった）。
// いまは行の中の額を1つずつ見て、額の直前が「N分」「N分/」「N分毎」なら単価、「X円/N分」も単価、ほかは最大料金（掲示の文字＝額の前の文）
// scope … 文の外で曜日の区分が決まっているとき（新しいサイトの「月～木・日」「金・土」の列）に渡す。無ければ今までどおり全日
export function parsePrice(price, { scope = null } = {}) {
  const unitCharges = [];
  const maxFees = [];
  let lastUnits = [];      // 前の行の、時間帯の分からない単価（「20分100円」の次の行が「8:00~22:00」だけの掲示）
  for (const raw of (price || "").split(/<br\s*\/?>/i)) {
    const line = normalize(raw);
    if (!line) continue;
    const yen = [...line.matchAll(/([\d,]+)\s*円/g)];
    if (!yen.length) {
      // 時間帯だけの行は、直前の行の単価の時間帯
      const tm = [...line.matchAll(TIME)];
      if (tm.length === 1 && lastUnits.length && line.replace(TIME, "").replace(/[\s()（）]/g, "") === "")
        for (const u of lastUnits) u.timeRange = `${hhmm(tm[0][1])}-${hhmm(tm[0][2])}`;
      lastUnits = [];
      continue;
    }
    const now = [];
    let from = 0;
    for (let i = 0; i < yen.length; i++) {
      const m = yen[i];
      const amountYen = Number(m[1].replace(/,/g, ""));
      const ctx = line.slice(from, m.index);
      // 単価の時間帯は、その額の前の文にある時間帯だけ（前の額の時間帯を持ち越すと、終日の単価を夜だけにしてしまう）
      const tms = [...ctx.matchAll(TIME)];
      const curTime = tms.length ? `${hhmm(tms[tms.length - 1][1])}-${hhmm(tms[tms.length - 1][2])}` : null;
      const day = (line.slice(0, m.index).match(new RegExp(DAY.source, "g")) ?? []).pop() ?? null;
      let end = m.index + m[0].length;
      const unit = ctx.match(/(\d+)\s*分\s*[\/]?\s*毎?\s*$/);
      const rev = line.slice(end).match(/^\s*\/\s*(\d+)\s*分/);          // 「100円/90分」
      if ((unit || rev) && !/最大|上限|まで|以内|打ち?切|入庫|駐車/.test(ctx)) {
        const u = { scope: day ?? scope ?? "全日", timeRange: /オールタイム/.test(ctx) ? "全日" : curTime ?? "全日",
          perMinutes: Number(unit ? unit[1] : rev[1]), amountYen };
        unitCharges.push(u); if (u.timeRange === "全日" && !/オールタイム/.test(ctx)) now.push(u);
        if (rev && !unit) end += rev[0].length;
      } else {
        const condition = ctx.replace(/^[\s、,・/]+/, "").replace(/最大料金|最大/g, " ").replace(/\s+/g, " ").trim();
        maxFees.push({ scope: scope ?? "全日", condition, amountYen });
      }
      from = end;
    }
    lastUnits = now;
  }
  return { unitCharges, maxFees };
}

// 曜日の区分（fee_info の left_label・right_label）。「全日」「全日　一般ご利用者」は全日
const scopeOf = (label) => {
  const t = (label ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  return !t || /^全日/.test(t) ? "全日" : t;
};

/** fee_info → { unitCharges, maxFees }。左右の列（曜日の区分）ごとに、通常料金と最大料金の文を読む */
export function parseFeeInfo(fi) {
  const unitCharges = [], maxFees = [];
  if (!fi || typeof fi !== "object") return { unitCharges, maxFees };
  const sides = [[fi.left_label, fi.normal_left_value, fi.max_left_value], [fi.right_label, fi.normal_right_value, fi.max_right_value]];
  for (const [label, normal, max] of sides) {
    if (normal == null && max == null) continue;
    const scope = scopeOf(label);
    for (const text of [normal, max]) {
      const r = parsePrice(text, { scope });
      unitCharges.push(...r.unitCharges); maxFees.push(...r.maxFees);
    }
  }
  return { unitCharges, maxFees };
}

const num = (x) => { const n = Number(x); return Number.isFinite(n) && n !== 0 ? n : null; };
const hm = (x) => (typeof x === "string" && /^\d{1,2}:\d{2}/.test(x) ? x.slice(0, 5) : null);

/** もう閉じた・サイトに出さない物件か。close_at（閉鎖日）が今日までなら閉じている */
function hidden(p, today) {
  if (p.use_in_website === false || p.use_in_website === "false") return true;
  const c = typeof p.close_at === "string" ? p.close_at.slice(0, 10) : null;
  return !!c && /^\d{4}-\d{2}-\d{2}$/.test(c) && c <= today;
}

/** 一覧の1ページ（JSON の文字列かオブジェクト）→ { records, listed, hidden, totalPages, total }。JSON でない・形が違うときは null
 *  listed … そのページに載っていた件数（閉じた・番号の無いものも含む）。0 なら最後のページを過ぎている */
export function parseTheparkPage(body, { label, today = new Date().toISOString().slice(0, 10) } = {}) {
  let j;
  try { j = typeof body === "string" ? JSON.parse(body) : body; } catch { return null; }
  if (!j || typeof j !== "object" || !Array.isArray(j.data) || !j.pagination || typeof j.pagination !== "object") return null;
  const records = [];
  let hid = 0;
  for (const p of j.data) {
    const parkId = String(p?.facility_id ?? "").trim();
    if (!parkId || hidden(p, today)) { hid++; continue; }
    const { unitCharges, maxFees } = parseFeeInfo(p.fee_info);
    const from = hm(p.business_hours_from), to = hm(p.business_hours_to);
    records.push({
      operator: "thepark",
      parkId,
      label: label ?? null,
      name: p.name ?? null,
      address: [p.prefecture_name, p.city_name, p.address1, p.address2, p.address3].map((x) => String(x ?? "").trim()).filter(Boolean).join("") || null,
      lat: num(p.latitude),
      lng: num(p.longitude),
      capacity: num(p.parking_lot_capacity),
      openingHours: p.is_available_24h === true ? "24時間" : from && to ? `${from}-${to}` : null,
      unitCharges,
      maxFees,
      parseV: PARSE_VERSION,
      sourceUrl: p.prefecture_latin && p.city_code ? `${SITE}/hourly/${p.prefecture_latin}/${p.city_code}/${parkId}` : `${SITE}/hourly`,
    });
  }
  return { records, listed: j.data.length, hidden: hid,
    totalPages: Number(j.pagination.total_pages) || 0, total: Number(j.pagination.total_elements) || 0 };
}
