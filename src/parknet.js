// 新明和工業 パークネット（parknet.shinmaywa.co.jp / 全国 約390件）--------------
// 市区一覧 list.html?pref_cd=NN&city=市区名 に物件が料金つきで直接載る（詳細巡回不要）。
//   list_box ごと: detail_jXXXXX.html（ID）/ list_name / address_detail / daisu
//   料金ブロック: area_alltime（オールタイム）/ area_daytime（昼）/ area_nighttime（夜）
//     各 li: day_block（月～金 等・省略時は全日）、d_start_time〜d_end_time、kizami（N分）、rate（M円）
//   最大料金: area_max_rate の li: max_time（24時間 等）＋ rate
const BASE = "https://parknet.shinmaywa.co.jp/parknet/search/";

export const prefListUrl = (prefCd) => `${BASE}city_list_${prefCd}.html`;
export const cityListUrl = (prefCd, city) => `${BASE}list.html?pref_cd=${prefCd}&city=${encodeURIComponent(city)}`;

const txt = (s) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const pick = (html, cls) => { const m = html.match(new RegExp(`<span class="${cls}"[^>]*>([\\s\\S]*?)</span>`)); return m ? txt(m[1]) : null; };

function parseFeeSection(section, kind) {
  // kind: "all" | "day" | "night"
  const out = [];
  for (const li of section.split(/<li>/).slice(1)) {
    const scope = txt((li.match(/<div class="day_block">([\s\S]*?)<\/div>/) || [])[1]) || "全日";
    const st = pick(li, kind === "night" ? "n_start_time" : "d_start_time");
    const en = pick(li, kind === "night" ? "n_end_time" : "d_end_time");
    const kizami = pick(li, "kizami");
    const rate = pick(li, "rate");
    if (!kizami || !rate) continue;
    const per = Number((kizami.match(/(\d+)/) || [])[1]);
    const amt = Number((rate.match(/([\d,]+)/) || [])[1]?.replace(/,/g, ""));
    if (!per || !amt) continue;
    out.push({ scope, timeRange: st && en ? `${st}-${en}` : "00:00-24:00", perMinutes: per, amountYen: amt });
  }
  return out;
}

export function parseParknetList(html) {
  const records = [];
  for (const raw of html.split('<div class="list_box">').slice(1)) {
    const chunk = raw.replace(/<!--[\s\S]*?-->/g, "");
    const link = chunk.match(/href="\.\/detail_([a-z0-9]+)\.html"/i);
    if (!link) continue;
    const parkId = link[1];
    const name = pick(chunk, "list_name");
    const address = pick(chunk, "address_detail");
    const daisu = pick(chunk, "daisu");
    const capacity = daisu ? Number((daisu.match(/(\d+)/) || [])[1]) || null : null;

    // area_* セクションで分割し、各断片の種別（オールタイム/昼/夜/最大）ごとに解析する。
    // 入れ子の </div> があるため正規表現でセクション境界を取らず、先頭クラス名で判定する。
    const unitCharges = [];
    const maxFees = [];
    for (const part of chunk.split(/<div class="area_/).slice(1)) {
      const cls = (part.match(/^([a-z_]+)"/) || [])[1];
      if (cls === "max_rate") {
        for (const li of part.split(/<li>/).slice(1)) {
          const scope = txt((li.match(/<div class="day_block">([\s\S]*?)<\/div>/) || [])[1]) || "全日";
          const cond = (pick(li, "max_time") ?? "").replace(/最大/g, "").trim();
          const rate = pick(li, "rate");
          const amt = rate ? Number((rate.match(/([\d,]+)/) || [])[1]?.replace(/,/g, "")) : null;
          if (amt) maxFees.push({ scope, condition: cond ? `${cond}最大` : "最大", amountYen: amt });
        }
        continue;
      }
      const kind = cls === "nighttime" ? "night" : cls === "daytime" ? "day" : cls === "alltime" ? "all" : null;
      if (kind) unitCharges.push(...parseFeeSection(part, kind));
    }
    records.push({ operator: "parknet", parkId, label: null, name, address,
      lat: null, lng: null, capacity, openingHours: null,
      unitCharges, maxFees, sourceUrl: `${BASE}detail_${parkId}.html` });
  }
  return records;
}

// 都道府県ページから市区一覧（pref_cd, city）を抽出
export function parseCityLinks(html) {
  return [...new Set([...html.matchAll(/list\.html\?pref_cd=(\d+)&city=([^"&]+)/g)]
    .map((m) => `${m[1]}\t${decodeURIComponent(m[2])}`))];
}
