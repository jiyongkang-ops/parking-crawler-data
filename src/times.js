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
/** 旧日本測地系（Tokyo Datum）→ 世界測地系（WGS84）の近似換算（誤差は数m〜十数m）。
 *  タイムズのページの地図座標は旧測地系で、そのままだと南に約360m・東に約270mずれる（2026-09-24 点検で確認）。 */
export function tokyoToWgs(lat, lng) {
  return { lat: lat - 0.00010695 * lat + 0.000017464 * lng + 0.0046017,
           lng: lng - 0.000046038 * lat - 0.000083043 * lng + 0.010040 };
}
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
    const g0 = aligned ? icons[i] : null;
    const g = g0 && Number.isFinite(g0.lat) && Number.isFinite(g0.lon) ? tokyoToWgs(g0.lat, g0.lon) : null;
    return { parkId: buk, name, status, self,
      // datum: 換算済みの印。これが無い古い行（2026-09-21〜24）は読む側で換算する
      lat: g ? +g.lat.toFixed(6) : null, lng: g ? +g.lng.toFixed(6) : null, datum: g ? "wgs84" : null };
  }).filter((x) => x.parkId);
}

export function detailUrlFromParkId(parkId) {
  // parkId はフル URL を保持（県/市コードを含むため）。後方互換でそのまま返す。
  return parkId.startsWith("http") ? parkId : `${BASE}${parkId}`;
}

// BUKコード（物件の安定キー）を URL から取り出す
// 優先物件（BUK… で届く）を巡回の一覧（URL）と照合するのにも使う（2026-10-17）
export function bukCode(url) {
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

/** タイムズカーの有無とステーション番号。印が無い・無効なら null */
export function parseTimesCarShare(html) {
  const on = /feature_list_txt--cShare[^"]*\bis-active\b/.test(html);
  const scd = (html.match(/id="carshareStationLink"[^>]*href="[^"]*[?&]scd=([A-Za-z0-9]+)/) || [])[1] ?? null;
  return on || scd ? { scd } : null;
}

// ---- 住所 ------------------------------------------------------------------
// 以前は題名の「最初のかっこ」を住所にしていた。名前にかっこがある施設（「タイムズJR札幌病院（上層階）」
// 「京都駅ビル（西）」など）では、題名が「名前（上層階）（北海道札幌市…）の時間貸駐車場…」になるので、
// 「上層階」「平面」「第２」「B1」などを住所として保存していた（最新の行で344件。2026-10-18 点検）。
// 住所が出ないうえ、国土地理院が別の地名に当てて遠くに置かれる原因になっていた。
// 住所の中のかっこ（「北海道札幌市白石区本通（北）…」「…鶴馬（大字）…」）でも途中で切れていた（34件）。
const PREFS = "北海道|青森県|岩手県|宮城県|秋田県|山形県|福島県|茨城県|栃木県|群馬県|埼玉県|千葉県|東京都|神奈川県"
  + "|新潟県|富山県|石川県|福井県|山梨県|長野県|岐阜県|静岡県|愛知県|三重県|滋賀県|京都府|大阪府|兵庫県|奈良県"
  + "|和歌山県|鳥取県|島根県|岡山県|広島県|山口県|徳島県|香川県|愛媛県|高知県|福岡県|佐賀県|長崎県|熊本県|大分県"
  + "|宮崎県|鹿児島県|沖縄県";
// 都道府県のすぐ後に市区町村郡が続くもの。「京都府立医大」「東京都庁」のような名前のかっこは住所にしない
const PREF_ADDR = new RegExp(`^(?:${PREFS}).{0,10}?[市区町村郡]`);
// 都道府県が無くても、市区町村郡で始まり番地（数字）のあるもの（例: 札幌市中央区北3条西2）
const MUNI_ADDR = /^[^\d０-９]{1,10}?[市区町村郡].*(?:[0-9０-９]|丁目|番地)/;
// 市・区・郡で始まるだけの、ゆるい形（例: 中央区銀座）。題名の最後のかっこにだけ使う。
// 町・村は「さがみ信用金庫緑町支店」のような名前にも出るので、ここでは使わない
const MUNI_LOOSE = /^[^\d０-９]{1,5}?[市区郡]/;
// 市区町村の字を含んでも住所ではない言葉（「京都市総合教育センター」「西宮市立北口」「第2区画」「〜支店」など）
const NOT_ADDR = /(?:センター|病院|医院|駐車|パーキング|専用|ビル|モール|大学|学校|公園|ホテル|役所|役場|区画|支店|銀行|金庫|店$|[都道府県市区町村]立)/;

const isPrefAddress = (s) => PREF_ADDR.test(s);
const isMuniAddress = (s) => MUNI_ADDR.test(s) && !NOT_ADDR.test(s);

/** 題名のかっこを外側ごと拾う（右から読むので、住所の中のかっこや名前の閉じ忘れに強い）。 */
function bracketGroups(s) {
  const out = [];
  let depth = 0, end = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === "）" || c === ")") { if (depth++ === 0) end = i; }
    else if ((c === "（" || c === "(") && depth > 0 && --depth === 0) {
      out.unshift({ text: s.slice(i + 1, end).trim(), start: i, end: end + 1 });
    }
  }
  return out;
}

/** 題名（"名前（住所）の時間貸駐車場・満車/空車・料金情報 ｜タイムズ駐車場検索"）から住所を選ぶ。
 *  1) 都道府県で始まるかっこ（複数あれば「の時間貸」に近い方）
 *  2) 無ければ、市区町村郡と番地（数字）を含むかっこ
 *  3) それも無ければ、「の時間貸」の直前のかっこ。ただし住所らしくなければ null（「上層階」「第２」「B1」「南」は住所にしない）
 *  戻り値 { address, start }（start は名前の終わり＝住所のかっこの位置） */
export function timesTitleAddress(title) {
  const t = String(title ?? "");
  const cut = t.indexOf("の時間貸");
  const head = (cut >= 0 ? t.slice(0, cut) : t.split("｜")[0]).trimEnd();
  const groups = bracketGroups(head);
  const pick = (g) => (g ? { address: g.text, start: g.start } : null);
  // 外側ごと拾えたかっこを先に見る。かっこが閉じていない題名でも以前より悪くならないよう、
  // 以前と同じ読み方（開きから最初の閉じまで）のかっこも後ろに候補として足す
  const flat = [...head.matchAll(/[（(](.+?)[)）]/g)].map((m) => ({ text: m[1].trim(), start: m.index, end: m.index + m[0].length }));
  const rev = [...groups].reverse().concat([...flat].reverse());
  const last = groups.length && groups[groups.length - 1].end === head.length ? groups[groups.length - 1] : null;
  return pick(rev.find((g) => isPrefAddress(g.text)))
    ?? pick(rev.find((g) => isMuniAddress(g.text)))
    ?? (last && MUNI_LOOSE.test(last.text) && !NOT_ADDR.test(last.text) ? pick(last) : null)
    ?? { address: null, start: -1 };
}

/** 本文「基本情報」の住所の行（<span itemprop="addressRegion|addressLocality|streetAddress">）。
 *  名前のかっこに左右されないので題名より確か。住所らしくなければ null（題名から選ぶ） */
export function timesBodyAddress(html) {
  const i = html.indexOf("p-basicInfo_table_td_address_txt");
  if (i < 0) return null;
  const end = html.indexOf("</p>", i);
  const block = html.slice(i, end > i ? end : i + 2000);
  const parts = [...block.matchAll(/itemprop="(?:addressRegion|addressLocality|streetAddress)"[^>]*>([\s\S]*?)<\/span>/g)]
    .map((m) => stripTags(m[1])).filter(Boolean);
  const text = parts.length
    ? parts.join("")
    // itemprop が無い作りなら、まとまりの文字をそのまま使う（「地図を見る」の画像は文字を持たない）
    : stripTags((block.match(/^[^>]*>([\s\S]*?)<\/span>\s*(?:<a\b|$)/) || [])[1] ?? "").replace(/\s+/g, "");
  return text && (isPrefAddress(text) || isMuniAddress(text)) ? text : null;
}

// 相手先が混み合っているときのページ（HTTP 200 で料金も住所も無い）。
// 以前は名前「ただいま大変混み合っております」・料金0件の行として記録され、その物件の最新の料金を上書きしていた（2026-10-02 に2件）
const BUSY_PAGE = /ただいま大変混み合っております/;

export function parseTimesDetail(html, { url, label } = {}) {
  const parkId = bukCode(url ?? "");

  // 名称・住所（title: "〇〇（住所）の時間貸駐車場…"）
  const title = (html.match(/<title>([^<]+)<\/title>/) || [])[1] || "";
  const h1 = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1];
  if (BUSY_PAGE.test(title) || (h1 && BUSY_PAGE.test(stripTags(h1)))) {
    // 例外にすると run.js が [parse error] として記録に書かずに飛ばす（料金の記録を上書きしない）
    const e = new Error("相手先が混み合っているページ（料金・住所なし）");
    e.transient = true;
    throw e;
  }
  const fromTitle = timesTitleAddress(title);
  const titleName = fromTitle.start > 0 ? title.slice(0, fromTitle.start).trim() : (title.match(/^(.+?)[（(]/) || [])[1];
  const name = (h1 ? stripTags(h1) : titleName) || title.split("｜")[0] || null;
  // 本文の住所の行を先に使い、無ければ題名から選ぶ
  const address = timesBodyAddress(html) ?? fromTitle.address;

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
  // タイムズカー（カーシェア）のステーションがこの駐車場にあるか。「設備」の欄の印（is-active で有り）と、
  // 「ステーション情報を見る」のリンクのステーション番号（scd）。台数はこのページに無い（タイムズカー側は自動取得禁止の通信で読む）。
  // 料金のために既に取っているページなので、追加の取得は発生しない。
  const carShare = parseTimesCarShare(html);
  const me = nearby.find((x) => x.self) ?? nearby.find((x) => x.parkId === parkId) ?? null;
  return {
    operator: "times",
    parkId,
    label: label ?? null,
    name,
    fullEmptyStatus: me?.status ?? null,
    address,
    lat: me?.lat ?? null,   // 静的HTMLには無いが、周辺一覧の地図データに本駐車場の座標が入っている（世界測地系に換算済み）
    lng: me?.lng ?? null,
    datum: me?.datum ?? null,
    capacity,
    openingHours: null,
    unitCharges,
    maxFees,
    sourceUrl: url ?? null,
    carShare,
    // 同じページに載っていた周辺の満空（本駐車場を除く）。run.js が観測として書く
    nearbyVacancy: nearby.filter((x) => !x.self && x.status && x.parkId !== parkId),
  };
}
