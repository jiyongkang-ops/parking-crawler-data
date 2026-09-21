// タイムズ（Park24 / times-info.net）個別物件ページのパーサ ----------------
// 料金はサーバ描画の静的HTMLにある（Playwright不要）。
//   時間帯単価:  <p class="c-ulTable_items_list_txt ...">00:00-00:00 30分 300円</p>
//   最大料金:    <p class="c-ulTable_items_list_txt ...">当日１日最大料金1100円(24時迄)</p>
// 直前の HTML コメント <!--▼▼▼月～金の通常料金▼▼▼--> が曜日 scope を表す。
// コメントと <p> の前後関係が一定しないため、各 <p> を「位置的に最も近い直前の
// コメント」に紐付けて scope を決める（種別は本文テキストで判定）。
//
// ※タイムズは robots.txt で商用ボット(GPTBot/DataForSeoBot/bingbot)を名指しブロック
//   している。当ツールは汎用UAで robots.txt の * グループ（許可）に従うが、先方が
//   自動収集を歓迎していない点に配慮し、間隔は長め・低頻度で運用すること。

const BASE = "https://times-info.net";
import { emptyStatusLabel } from "./vacancy-label.js";

/** 詳細ページの「周辺の駐車場」一覧（本駐車場を含む最大11件）から満空と座標を読む。
 *  満空は <div class="s_bukIcon">N</div> の数値で、サイトの JS と同じ読み方（N & 7: 0=空 1=混雑 2=満車、それ以外は不明）。
 *  ビット3（8）は「満空対応外」の印なので、立っていれば満空なしとする。
 *  座標は同じ順で <div class="s_areaBukMapIcons">[{icon,lat,lon},…]</div> に入っている（件数が一致するときだけ信じる）。
 *  料金のために既に取っているページなので、満空のために追加の取得は発生しない。 */
export function parseTimesNearby(html) {
  const items = [...html.matchAll(/<li class="s_areaBukListItem[\s\S]*?<\/li>/g)].map((m) => m[0]);
  let icons = [];
  try {
    const raw = (html.match(/class="s_areaBukMapIcons"[^>]*>\s*([\[{][\s\S]*?)\s*<\/div>/) || [])[1];
    if (raw) icons = JSON.parse(raw.replace(/&quot;/g, '"'));
  } catch { icons = []; }
  const aligned = Array.isArray(icons) && icons.length === items.length;
  return items.map((it, i) => {
    const buk = (it.match(/park-detail-(BUK\d+)/) || [])[1] ?? null;
    const name = stripTags((it.match(/<\/span>\s*([^<]+?)\s*<\/p>/) || [])[1] ?? "") || null;
    const code = Number((it.match(/s_bukIcon"[^>]*>\s*(\d+)\s*</) || [])[1]);
    const status = Number.isFinite(code) && !(code & 8) ? emptyStatusLabel(code & 7) : null;
    const self = /本駐車場<\/p>/.test(it);
    const g = aligned ? icons[i] : null;
    return { parkId: buk, name, status, self,
      lat: g && Number.isFinite(g.lat) ? g.lat : null, lng: g && Number.isFinite(g.lon) ? g.lon : null };
  }).filter((x) => x.parkId);
}

export function detailUrlFromParkId(parkId) {
  // parkId はフル URL を保持（県/市コードを含むため）。後方互換でそのまま返す。
  return parkId.startsWith("http") ? parkId : `${BASE}${parkId}`;
}

// BUKコード（物件の安定キー）を URL から取り出す
function bukCode(url) {
  const m = url.match(/park-detail-(BUK\d+)/);
  return m ? m[1] : url;
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// "00:00-00:00 30分 300円" → 単価
function parseUnit(text) {
  const fm = text.match(/(\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2})?\s*(\d+)\s*分\s*(\d[\d,]*)\s*円/);
  if (!fm) return null;
  return {
    timeRange: (fm[1] || "全日").replace(/\s+/g, ""),
    perMinutes: Number(fm[2]),
    amountYen: Number(fm[3].replace(/,/g, "")),
  };
}

// "当日１日最大料金1100円(24時迄)" → 最大料金
function parseMax(text) {
  const fm = text.match(/(\d[\d,]*)\s*円/);
  if (!fm || !/最大料金/.test(text)) return null;
  const condMatch = text.match(/[(（]([^)）]+)[)）]/);
  return {
    condition: condMatch ? condMatch[1].trim() : text.replace(/\d[\d,]*\s*円.*/, "").trim(),
    amountYen: Number(fm[1].replace(/,/g, "")),
  };
}

export function parseTimesDetail(html, { url, label } = {}) {
  const parkId = bukCode(url ?? "");

  // 名称・住所（title: "〇〇（住所）の時間貸駐車場…"）
  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || "";
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  const tm = title.match(/^(.+?)[（(](.+?)[)）]/);
  const name = (h1 ? stripTags(h1) : tm?.[1]) || title.split("｜")[0] || null;
  const address = tm?.[2] ?? null;

  // 収容台数: "駐車場台数395台"
  const capM = html.match(/(?:駐車場台数|収容台数)\D{0,6}(\d+)\s*台/);
  const capacity = capM ? Number(capM[1]) : null;

  // scope コメントと料金 <p> を位置情報つきで収集
  const comments = [...html.matchAll(/<!--\s*▼+\s*([^▼]+?)\s*の(通常|最大)料金\s*▼+\s*-->/g)]
    .map((m) => ({ index: m.index, scope: m[1].trim() }));
  // セルは内側HTMLを丸ごと取得（1セルに <BR> 区切りで複数料金が入る場合がある）。
  const cells = [...html.matchAll(
    /<p class="c-ulTable_items_list_txt[^"]*">([\s\S]*?)<\/p>/g
  )].map((m) => ({ index: m.index, inner: m[1] }));

  // 直前(セル外)の最近接コメントの scope
  const precedingScope = (idx) => {
    let best = null;
    for (const c of comments) if (c.index < idx && (!best || c.index > best.index)) best = c;
    return best?.scope ?? "全日";
  };
  // セル内コメントを優先（コメントが <p> の内側に入るレイアウトがあるため）。
  const innerScopeRe = /▼+\s*([^▼]+?)\s*の(?:通常|最大)料金\s*▼+/;

  const unitCharges = [];
  const maxFees = [];
  for (const cell of cells) {
    const inner = innerScopeRe.exec(cell.inner);
    const scope = inner ? inner[1].trim() : precedingScope(cell.index);
    // コメント除去 → <br> で分割 → 各セグメントを判定
    const cleaned = cell.inner.replace(/<!--[\s\S]*?-->/g, "");
    for (const seg of cleaned.split(/<br\s*\/?>/i)) {
      const text = stripTags(seg);
      if (!text || /^[-－‐–—\s]+$/.test(text)) continue; // "－－－" 等は料金なし
      if (/最大料金/.test(text)) {
        const mx = parseMax(text);
        if (mx) maxFees.push({ scope, ...mx });
      } else {
        const u = parseUnit(text);
        if (u) unitCharges.push({ scope, ...u });
      }
    }
  }

  // 満空と座標。周辺一覧の「本駐車場」の行が自分。周辺の他社・他店舗の満空も同じページで分かるので、
  // 追加の取得なしに観測を増やせる（1ページで最大11件ぶん）
  const nearby = parseTimesNearby(html);
  const me = nearby.find((x) => x.self) ?? nearby.find((x) => x.parkId === parkId) ?? null;
  return {
    operator: "times",
    parkId,
    label: label ?? null,
    name,
    fullEmptyStatus: me?.status ?? null,
    address,
    lat: me?.lat ?? null,   // 静的HTMLには無いが、周辺一覧の地図データに本駐車場の座標が入っている
    lng: me?.lng ?? null,
    capacity,
    openingHours: null,
    unitCharges,
    maxFees,
    sourceUrl: url ?? null,
    // 同じページに載っていた周辺の満空（本駐車場を除く）。run.js が観測として書く
    nearbyVacancy: nearby.filter((x) => !x.self && x.status && x.parkId !== parkId),
  };
}
