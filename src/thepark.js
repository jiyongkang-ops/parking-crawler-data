// ザ・パーク（第一興商 / dkparking.com）のパーサ ----------------------------
// 全物件が単一JSON(data/search.json)に入っており、1リクエストで全件取得できる。
//   各物件: id, name, pref, address, lat/lng(※フィールドが逆), car_cnt, price(HTML文字列)
// price は <br /> 区切り・全角記号混じりのテキスト（例:「7：00～20：00　30分100円」）。
// robots.txt は制限なし。

const SEARCH_JSON = "https://www.dkparking.com/data/search.json?ver=1";

export function searchUrl() {
  return SEARCH_JSON;
}

// 記録の読み方の版。読み方を変えたら上げる（分析側は版が変わった回を料金改定にしない）
//   2 … 2026-11-08 単価の読み違いを直した（下の parsePrice）
export const PARSE_VERSION = 2;

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
export function parsePrice(price) {
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
        const u = { scope: day ?? "全日", timeRange: /オールタイム/.test(ctx) ? "全日" : curTime ?? "全日",
          perMinutes: Number(unit ? unit[1] : rev[1]), amountYen };
        unitCharges.push(u); if (u.timeRange === "全日" && !/オールタイム/.test(ctx)) now.push(u);
        if (rev && !unit) end += rev[0].length;
      } else {
        const condition = ctx.replace(/^[\s、,・/]+/, "").replace(/最大料金|最大/g, " ").replace(/\s+/g, " ").trim();
        maxFees.push({ scope: "全日", condition, amountYen });
      }
      from = end;
    }
    lastUnits = now;
  }
  return { unitCharges, maxFees };
}

// JSON文字列/オブジェクト → 正規化レコード配列
export function parseTheparkJson(body, { label } = {}) {
  let arr;
  try {
    arr = typeof body === "string" ? JSON.parse(body) : body;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => {
    const { unitCharges, maxFees } = parsePrice(p.price);
    // ザ・パークの JSON は lat/lng フィールドが逆（"lng"に緯度, "lat"に経度）
    const lat = Number(p.lng) || null;
    const lng = Number(p.lat) || null;
    return {
      operator: "thepark",
      parkId: String(p.id),
      label: label ?? null,
      name: p.name ?? null,
      address: p.address ?? null,
      lat,
      lng,
      capacity: p.car_cnt ? Number(p.car_cnt) || null : null,
      openingHours: null,
      unitCharges,
      maxFees,
      parseV: PARSE_VERSION,
      sourceUrl: "https://www.dkparking.com/search.html",
    };
  });
}
