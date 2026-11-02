// 相手先のサイトのメンテナンスを見分ける（2026-10-24 週次の見直し） ----------------------------------------
// 10/22〜23 に名鉄協商・近鉄不動産・ザ・パーク・あなぶきの4社が「断られている（403）」「多すぎる（429）」と
// 記録されたが、実際は4社とも相手先のサイトが「緊急メンテナンス」「メンテナンス中」だった。
// メンテナンスの告知ページを 403・429 で返すサイトがあり、状態コードだけでは断られたのと区別できない。
// 断られたと取り違えると、朝のお知らせで「断られている」の欄に並び、止める判断を誤るおそれがある。
//
// 見分け方は**ページの題名（<title>・無ければ最初の見出し）**と、**本文の決まった言い回し**（maintenanceBody）。
// 普段のトップページにも「システムメンテナンスのお知らせ（10/30）」のような見出しが本文に並ぶことはよくあるため、
// 本文は「ただいまメンテナンス中です」「サービスを停止しております」のような、止まっている最中にしか書かない言い回しだけを見る。
// 2026-10-27: パークネットは題名を「パークネット | 新明和工業株式会社」のまま、本文だけを「ただいまメンテナンス中です」に
// 差し替えていて、題名だけでは見分けられず「0件（parse）」と記録されていた（10/22〜）。

import { createHash } from "node:crypto";

const RE = /メンテナンス|maintenance|一時停止|一時休止|サービス停止|システム停止|臨時休止|ただいま工事中/i;

/** ページの題名（<title>。無ければ最初の <h1>）がメンテナンスの告知なら、その題名を返す。違えば null */
export function maintenanceTitle(html) {
  const s = String(html ?? "").slice(0, 20000);
  const strip = (x) => x.replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
  const title = strip(s.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const h1 = strip(s.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const head = title || h1;
  return head && RE.test(head) ? head.slice(0, 60) : null;
}

// 止まっている最中にしか書かない言い回し。「メンテナンスのお知らせ」「メンテナンス予定」のような予告は入れない
const BODY_RE = /ただいまメンテナンス中です|現在メンテナンス中です|メンテナンス中のため(?:現在)?(?:この)?(?:サイト|サービス|ページ)|(?:サービス|サイト|ウェブサイト|Webサイト)を(?:一時)?停止(?:して)?(?:おります|いたします|しています)|(?:サイト|サービス)は(?:現在)?ご利用いただけません|temporarily unavailable due to (?:system )?maintenance|under maintenance/i;

/** 本文（スクリプト・スタイル・タグを除いた文字）に、止まっている最中の言い回しがあれば、その言い回しを返す。違えば null */
export function maintenanceBody(html) {
  const s = String(html ?? "").slice(0, 60000)
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ");
  const m = s.match(BODY_RE);
  return m ? m[0].slice(0, 60) : null;
}

/** 題名か本文がメンテナンスの告知なら、その言葉を返す（題名を先に見る）。違えば null */
export function maintenanceOf(html) {
  return maintenanceTitle(html) ?? maintenanceBody(html);
}

// ---- 巡回の途中で告知のページを見分ける（2026-11-02 点検 maint-02） ----------------------------------------
// 上の markMaintenance は巡回の最後に、しかも失敗した行にしか効かない。告知を HTTP 200 で返すサイトでは、
// 物件ページ型の社は題名・見出しの「メンテナンス中」を物件の名前として読み、料金の無い行を書いて「取れた」と数えていた
// （セイワパークは 10/22 05:08〜10/30 05:31 の14回、毎回344件「取れた」と記録し、料金の無い「メンテナンス中」の行を342件書いた。
// 分析側はその物件を相場から外したので、8日分の DB でセイワパークの約342件が抜けていた）。
// そこで巡回の途中で見分け、その社のその回を行を書かずに止める。見分け方は2つ:
//   (1) 言葉: 料金が読めない物件ページの題名（lotNotice）
//   (2) 言葉に頼らない: 違う物件のページが続けて同じ名前・同じ中身（makeSameStreak）、料金の読めた割合がふだんより急に下がった
//       （makeNoticeGuard）。0バイトのページ（10/24 のパークネット）や、名前が無いと番号を名前にする社（タマパーク・キョウテク・
//       ル・パルク）の告知にも効く

/** 物件ページが告知か。題名（無ければ最初の見出し）で見る。本文は物件の名前が読めないときだけ見る。
 *  料金の無い物件が多い社（JQパークスは542件中275件）で、ページの上の予告の帯（「…サービスを停止いたします」）だけで
 *  止めないため（2026-11-02 点検の訂正）。告知ならその言葉、違えば null */
export function lotNotice(html, rec = null) {
  return maintenanceTitle(html) ?? (rec?.name ? null : maintenanceBody(html));
}

/** 料金が1つでも読めたか（料金の指紋 run.js feeFingerprint と同じ2つの欄） */
export const hasFee = (rec) => (rec?.unitCharges?.length ?? 0) + (rec?.maxFees?.length ?? 0) > 0;

/** ページの中身の指紋（空白をそろえた本文のハッシュ）。違う物件のページが同じ指紋なら、物件ではなく同じ告知のページ */
export function pageSig(html) {
  return createHash("sha1").update(String(html ?? "").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 16);
}

/** 違う鍵（物件・市区）の答えが、続けて同じ値（名前・中身の指紋）になった数を数える。push(key, value) が
 *  n 件続いたら true。value が空なら数え直す */
export function makeSameStreak(n = 5) {
  let last = null, keys = new Set();
  return {
    push(key, value) {
      if (!value || value !== last) { last = value || null; keys = new Set(); }
      if (value) keys.add(key);
      return keys.size >= n;
    },
    reset() { last = null; keys = new Set(); },
    get count() { return keys.size; },
  };
}

/** 前の記録で、その社の物件のうち料金の読めた割合（ふだんの割合）。物件が minN 件より少なければ null（比べない） */
export function feeRateOf(lastRecords, op, minN = 50) {
  let n = 0, f = 0;
  for (const r of lastRecords) if (r?.operator === op) { n++; if (hasFee(r)) f++; }
  return n >= minN ? f / n : null;
}

/** 中身がとても短いページ（空白を除いて200文字未満。0バイトの答えなど）。物件ページとしては短すぎるので、続けば告知や不調とみなす */
const TINY_PAGE = 200;

/** 巡回の1回ぶんの見張り。料金が読めない答え（名前が読めない・読めなかったページも含む）を page() に渡すと、
 *  告知とみなして止めるべきなら { why, kind } を返す（止めなくてよければ null）。料金が読めた答えも page() に渡す
 *  （続けて同じ、の数え直しと、料金の読めた割合に使う）。
 *    same      … 違う物件のページが続けて同じ名前・同じ中身なら止める数（既定5）
 *    normalFeeRate … その社のふだんの料金の読めた割合（feeRateOf）。0.8 以上の社だけ、minSample 件取った時点で
 *                 その rateDrop 倍（既定は半分）を下回ったら止める。告知の言葉を見ていれば maintenance、無ければ parse（ページの作りの変更）
 *    同じ名前・同じ中身で止めるときも、告知の言葉を見ていた（notice・maintenanceOf）か中身がとても短いときだけ maintenance、ほかは parse
 *  page({ id, html, name, fee, notice }) … notice は lotNotice の答え（告知の言葉を見たか。渡さなければ本文から見る）。
 *  取り直しの印が付いている物件（2回目）で料金が読めないものは、呼ぶ側が page() に渡さない（run.js。止めたあとの取り直しで
 *  また同じ物件が並んで止まり続けないため） */
export function makeNoticeGuard({ same = 5, normalFeeRate = null, minSample = 20, rateDrop = 0.5 } = {}) {
  const byName = makeSameStreak(same), byBody = makeSameStreak(same);
  let n = 0, f = 0, sawNotice = false;
  return {
    page({ id, html, name, fee, notice = null }) {
      n++;
      if (fee) { f++; byName.reset(); byBody.reset(); return null; }
      // 告知の言葉を見たか。run.js は題名の告知（lotNotice）を先に別の道で扱うので、ここへ来るのは本文だけに言葉がある告知など。
      // 料金の読めないページだけを見る（料金の読めた普段のページの予告の帯では数えない）
      if (notice ?? maintenanceOf(html)) sawNotice = true;
      // 同じ名前・同じ中身で止めるとき、告知の言葉を見ていたか本文がとても短い（0バイトなど）ときだけ maintenance。
      // それ以外は parse（全部の物件の URL が同じ画面を返すように作りが変わった、クライアント側で描くようになった、など。
      // 「相手先のメンテナンス」と出すと待てばよいと読まれてしまう。2026-11-02 点検の訂正）
      const tiny = String(html ?? "").replace(/\s+/g, "").length < TINY_PAGE;
      const kindOf = () => (sawNotice || tiny ? "maintenance" : "parse");
      const guess = () => (sawNotice || tiny ? "告知のページの見込み" : "告知かページの作りの変更の見込み");
      if (byName.push(id, name ? String(name) : null)) {
        return { kind: kindOf(), why: `違う物件のページが${same}件続けて同じ名前（「${String(name).slice(0, 40)}」）で、料金が読めない。${guess()}` };
      }
      if (byBody.push(id, pageSig(html))) {
        const len = String(html ?? "").length;
        return { kind: kindOf(), why: `違う物件のページが${same}件続けて同じ中身（${len}バイト）で、料金が読めない。${guess()}` };
      }
      if (normalFeeRate != null && normalFeeRate >= 0.8 && n >= minSample && f / n < normalFeeRate * rateDrop) {
        return { kind: sawNotice ? "maintenance" : "parse",
          why: `料金の読めた物件が${n}件中${f}件（${Math.round((f / n) * 100)}%）で、ふだん（${Math.round(normalFeeRate * 100)}%）より大きく少ない。` +
            `${sawNotice ? "告知のページの見込み" : "ページの作りの変更か告知のページの見込み"}` };
      }
      return null;
    },
    get stats() { return { n, f }; },
  };
}

/** 事業者のサイトの入口（トップページ）。巡回で失敗した事業者のメンテナンスを確かめるときに、ここを1回だけ見る */
export const ORIGINS = {
  anabuki: "https://www.anabuki-housing.co.jp", carshares: "https://www.carshares.jp", comnet: "https://comnet-p.co.jp",
  ecolo: "https://service.ecolocity.co.jp", gspark: "https://www.gs-park.com", jqparks: "https://www.parking-kyushu.jp",
  keio: "https://www.keiofudosan.co.jp", kintetsu: "https://parking.kintetsu-re.co.jp", kyotech: "https://kte.ne.jp",
  leparc: "https://sasp.mapion.co.jp", mden: "https://m-dentechno.co.jp", mkp: "https://mkp.jp",
  navipark: "https://www.navipark1.com", npc: "https://parking.npc-npc.co.jp", parknet: "https://parknet.shinmaywa.co.jp",
  repark: "https://www.repark.jp", seiwapark: "https://www.seiwapark.co.jp", systempark: "https://systempark.biz",
  tamapark: "https://www.tamapark.co.jp", thepark: "https://www.dkparking.com", times: "https://times-info.net",
  tokyulifia: "https://www.tokyulifia.co.jp",
  mecparks: "https://parkingnavi.jp", sanpark: "https://sanpark.jp",
  showapark: "https://www.shouwapark.co.jp", ypark: "https://www.waxds.com",
  carmax: "http://www.carmax-parking.jp", maypark: "https://aaa-mtc.jp",
  // 止めている社（space24・odakyu）は載せない。許可が出るまでトップにも行かない
};

/** 入口がトップページ（/）でない社。パークネットのトップは「サイトインデックス」だけの小さなページで、
 *  メンテナンスの告知は巡回で取る検索のページ（/parknet/search/ → /parknet/index.html）に出ていた（2026-10-27 確認）。
 *  あなぶきは会社のトップ（住まいの会社のサイト）が 10/27 に戻ったが、駐車場の一覧（/park/hourly/）は
 *  メンテナンスの告知（429）のまま。トップで見ると「回数の制限」と取り違える（2026-10-30 確認）。
 *  どちらも巡回で取っているページなので、見に行っても新しい所にはアクセスしない。
 *  三菱地所パークス（Parking NAVI）も巡回で取っている一覧（北海道。6件の小さいページ）で見る（2026-11-02） */
export const ENTRY_PATHS = { parknet: "/parknet/search/", anabuki: "/park/hourly/", mecparks: "/search_result.php?type=1&area=1",
  // ショウワパークは巡回で一覧を作るときに取る駐車場検索のページ。ユアー・パーキングの waxds.com はホームページ更新サービスで、
  // トップ（/）はサービスの会社のページになる。同社の地図の画面（物件の JSON を読んでいるページ）を見る（2026-11-02）
  showapark: "/parking/", ypark: "/ypark/map.php",
  //  東洋カーマックス・MAYパーク（2026-11-02 追加）も、巡回で取る「駐車場を探す」と一覧のページを見る
  //  （会社のトップは別のサイト・別の作りで、駐車場の検索が止まっていても普段どおりのことがある）
  carmax: "/25search/", maypark: "/may/index.html" };
/** 入口のページの文字コード（UTF-8 でない社だけ）。MAYパークは Shift_JIS で、UTF-8 で読むと告知の言葉が化けて見分けられない */
export const ENTRY_ENCODINGS = { maypark: "shift_jis" };

/** 事業者の入口の URL（メンテナンスを確かめるときに見るページ）。載っていなければ null */
export const entryOf = (op) => (ORIGINS[op] ? `${ORIGINS[op]}${ENTRY_PATHS[op] ?? "/"}` : null);

/** メンテナンスを確かめる失敗の種類。取り違えが実際に起きた「断られた・多すぎる・0件」だけ。
 *  届かない（network・503・タイムアウト）は、もともと一時的な失敗として扱っていて取り違えても困らないので、入口を見に行かない
 *  （相手先の不調のあいだに1回でも多く送らないため）。止めている（paused）・閉鎖が一斉に出た（mass-gone）・一覧の作り直しも対象外 */
const CHECK = new Set(["blocked", "rate", "parse"]);

/** health の行のうち、失敗した事業者の入口を1回ずつ見て、メンテナンスなら kind と reason を書き換える。
 *  fetchTop(url) は politeFetch（robots.txt と間隔を守る）。同じ入口は1回の巡回で1回だけ見る。
 *  robots.txt が 401・403 で入口を見られなかったときだけ、fetchTopDirect(url) で入口を1回だけ見る
 *  （RFC 9309 2.3.1.3: robots.txt が 4xx のときはどのページを取ってもよい。ふだんは控えめに「断られた」と同じ扱いに
 *  しているが、メンテナンスかどうかを確かめる入口の1回だけは見る。2026-10-27 本人了承「全部進めて」）。
 *  止めている社（paused）は CHECK に入らないので、ここには来ない。届かないときは元の行のまま */
export async function markMaintenance(rows, fetchTop, fetchTopDirect = null) {
  const seen = new Map();
  // 0件（parse）でも、送ったページの答えが閉鎖（404・410）中心なら閉鎖の扱いでメンテナンスではない。
  // 見に行くのは「ページは取れた（200）のに読めない」とき（パークネットは 200 の空のページを返していた）
  const mostlyGone = (r) => { const c = r.statusCounts ?? {}; const all = Object.values(c).reduce((a, b) => a + b, 0);
    return all > 0 && ((c["404"] ?? 0) + (c["410"] ?? 0)) * 2 >= all; };
  for (const r of rows) {
    if (r.ok || !CHECK.has(r.kind)) continue;
    if (r.kind === "parse" && mostlyGone(r)) continue;
    const entry = entryOf(r.op);
    if (!entry) continue;
    if (!seen.has(entry)) {
      let title = null;
      // 文字コードの指定は UTF-8 でない社だけに渡す（ほかの社は今までどおり URL だけで呼ぶ）
      const opts = ENTRY_ENCODINGS[r.op] ? [{ encoding: ENTRY_ENCODINGS[r.op] }] : [];
      try {
        let res = await fetchTop(entry, ...opts);
        if (res?.blocked && (res.status === 401 || res.status === 403) && fetchTopDirect) res = await fetchTopDirect(entry, ...opts);
        title = res?.maintenance ?? (res?.html ? maintenanceOf(res.html) : null);
      } catch { /* 見られなければ元のまま */ }
      seen.set(entry, title);
    }
    const title = seen.get(entry);
    if (!title) continue;
    r.reason = `相手先のサイトがメンテナンス中（「${title}」）。この回は見送り（巡回の記録: ${r.reason ?? r.kind}）`;
    r.kind = "maintenance";
  }
  return rows;
}
