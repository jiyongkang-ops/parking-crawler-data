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

  return {
    operator: "times",
    parkId,
    label: label ?? null,
    name,
    address,
    lat: null, // タイムズは座標を静的HTMLに出さない（地図はJS描画）
    lng: null,
    capacity,
    openingHours: null,
    unitCharges,
    maxFees,
    sourceUrl: url ?? null,
  };
}
