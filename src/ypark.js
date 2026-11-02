// ユアー・パーキング（株式会社ユアー・パーキング）詳細のパーサ（2026-11-02） --------------
// 会社のサイト ypark.co.jp の「コインパーキング」から行く公式の地図 https://www.waxds.com/ypark/map.php が、
// ホームページ更新サービス（waxds.com）の上で物件を出している。物件ページ parkinfo.php?id={番号} は、
// 画面の JS（parkinfo.js）が parkinfoc.php?crud=setparkinfo&id={番号} を読んで中身を埋める。その JSON をそのまま読む:
//   { name: "新橋第3", address: "東京都港区新橋4-27-6", a7: "2"（台数）, a8: 料金の自由文, a9: 営業（「無休<br>※…」）,
//     lat, lng, pn: "YP1434", err: null }
//   a8 の例:「【全日】<br>オールタイム　12分/300円<br><br>【最大料金】<br>月ー土：昼間最大（08時-20時の間）3,500円<br>
//           日・祝：昼間最大（08時-20時の間）1,200円<br>全　日：夜間最大（20時-08時の間）500円<br><br>※予告無く…」
// 使うのは、公開の画面が自分で読んでいる GET（一覧の getallpoint・物件の setparkinfo）だけ。
// 地図の JS（map.js）にある mapc.php?crud=updatecenter（地図の位置を書き換える管理用）など、読む以外の呼び出しは絶対に使わない。
// waxds.com の robots.txt は 404（制限なし）。ypark.co.jp の robots.txt は wp-admin だけを止めている。
//
// 名前（name）に社名が入っていないので、頭に「ユアー・パーキング」を付けて持つ（Parkopedia の同じ駐車場
// 「ユアー・パーキング新橋第3」と名寄せで合うようにする。社名の無い「新橋第3」のままだと、他社の「◯◯新橋第3」とも合ってしまう）。
// 記録しない物件（{ skip: 理由 } を返す。run.js が料金を書かずに寝かせる）:
//   ・a7（台数の欄）が「近日OPEN予定」「長期貸切」… まだ開いていない・時間貸しでない。一覧の段階でも外している（ypark-enumerate.js）
//   ・a8 に時間貸しの単価が無い（月極だけなど）。料金の無い行を書くと Advisor が同じ場所の Parkopedia の物件を落とす
//   ・名前に「駐輪場」「バイク」がある物件

import { han, strip, parseFeeBlock } from "./jp-fee-text.js";

const BASE = "https://www.waxds.com/ypark/";
export const BRAND = "ユアー・パーキング";

/** 料金を読む URL（画面の parkinfo.js が読むもの） */
export function detailUrl(id) {
  return `${BASE}parkinfoc.php?crud=setparkinfo&id=${encodeURIComponent(id)}`;
}
/** 人が見る物件ページ（記録の sourceUrl） */
export function pageUrl(id) {
  return `${BASE}parkinfo.php?id=${encodeURIComponent(id)}`;
}

/** まだ開いていない・時間貸しでない（台数の欄 a7 に書かれる） */
export const NOT_OPEN_RE = /近日\s*OPEN|近日\s*オープン|OPEN\s*予定|オープン予定|開業予定|長期貸切|貸切/i;
/** 車の駐車場でない */
export const TWO_WHEEL_RE = /駐輪|バイク|自転車/;

// 行頭の「月ー土：」「日・祝：」「全　日：」「土日祝：」を parseFeeBlock の見出し（【…】）にそろえる。
// 見出しにしないと曜日が分からず、日祝の安い上限が平日の上限と同じ「全日」として扱われる
const DAY_HEAD_RE = /^((?:[月火水木金土日祝平全]|祝日)(?:\s*[ー－\-~・、]?\s*(?:[月火水木金土日祝]|祝日))*)\s*[：:]\s*/;

/** a8（料金の自由文）→ parseFeeBlock に渡す行（<br> 区切り）。
 *  ・行頭の「曜日：」はその行だけに効く。次の行に曜日が無ければ全日に戻す
 *    （京都府亀岡駅前第1 は「月-金：昼間最大…」「土日祝：昼間最大…」のあとに「夜間最大（20時-08時の間）300円」が続く。
 *    parseFeeBlock は見出しを次の行へ持ち越すので、そのままだと夜間の上限が土日祝だけのものになる）
 *  ・「昼間最大（08時-20時の間）」の下に「■車室№1-2　1,500円」「■車室№3-6　1,300円」と車室ごとの額が並ぶ物件がある（業平第1）。
 *    額の無い見出しの行を、下の「■」の行の頭に付ける（付けないと時間帯の分からない上限になり、終日の上限として扱われる）
 *  ・「?」は「～」が化けたもの（一覧の a7 にも「2026年4月1日?9月30日まで」がある）。
 *    青葉六本木ビルディングの「8時-0分?23時」は 8時～23時（23時以降は営業時間外）と読む */
export function normalizeFee(a8) {
  const out = [];
  let inline = false, head = null;
  for (const l0 of String(a8 ?? "").split(/<br\s*\/?>|\r?\n/i)) {
    let l = strip(l0.replace(/&nbsp;/g, " ")).replace(/\?/g, "~").replace(/(\d{1,2})\s*時\s*-\s*0{1,2}\s*分\s*~/g, "$1時~");
    if (!l) continue;
    if (/^[【《]/.test(l)) { out.push(l); inline = false; head = null; continue; }
    // 額の無い見出し（「昼間最大（08時-20時の間）」）。下の「■…円」の行に付ける
    if (!/円/.test(l) && /最大/.test(l)) { head = l; continue; }
    if (head && /^[■□・●◆]/.test(l)) l = `${head} ${l.replace(/^[■□・●◆]\s*/, "")}`;
    else head = null;
    const m = l.match(DAY_HEAD_RE);
    if (m) {
      const scope = m[1].replace(/\s+/g, "").replace(/[ー－\-]/g, "~");
      out.push(`【${scope}】${l.slice(m[0].length)}`);
      inline = true;
      continue;
    }
    out.push(inline && /円/.test(l) ? `【全日】${l}` : l);
    if (/円/.test(l)) inline = false;
  }
  return out.join("<br>");
}

/** 台数の欄（a7）。「2」「3台」「6\n※車室№6 軽専用」→ 先頭の数。数が無ければ null */
export function capacityOf(a7) {
  const m = han(String(a7 ?? "")).match(/^\s*(\d+)/);
  return m ? Number(m[1]) || null : null;
}

export function parseYparkDetail(json, { id, label } = {}) {
  const pid = String(id);
  const j = typeof json === "string" ? JSON.parse(json) : json;
  if (!j || typeof j !== "object") throw new Error("JSON ではない");
  if (j.err) throw new Error(`err: ${String(j.err).slice(0, 80)}`);
  const raw = strip(j.name ?? "");
  if (!raw) return null;   // 名前が無い（掲載が終わった番号など）。run.js が「名前が読めない」と数える
  const name = raw.startsWith(BRAND) ? raw : `${BRAND}${raw}`;

  if (NOT_OPEN_RE.test(strip(j.a7 ?? ""))) return { skip: `まだ時間貸しをしていない（${strip(j.a7).slice(0, 30)}）` };
  if (TWO_WHEEL_RE.test(raw)) return { skip: "駐輪場・バイク" };

  const { unitCharges, maxFees } = parseFeeBlock(normalizeFee(j.a8));
  if (!unitCharges.length) return { skip: "時間貸しの料金が無い" };

  const lat = Number(j.lat), lng = Number(j.lng);
  return {
    operator: "ypark",
    parkId: pid,
    label: label ?? null,
    name,
    address: strip(j.address ?? "") || null,
    lat: Number.isFinite(lat) && lat > 0 ? lat : null,
    lng: Number.isFinite(lng) && lng > 0 ? lng : null,
    capacity: capacityOf(j.a7),
    // 「無休<br><br>※予告無しに工事…」の1行目だけ
    openingHours: strip(String(j.a9 ?? "").split(/<br\s*\/?>/i)[0]) || null,
    unitCharges,
    maxFees,
    sourceUrl: pageUrl(pid),
  };
}
