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
  // 止めている社（space24・odakyu）は載せない。許可が出るまでトップにも行かない
};

/** 入口がトップページ（/）でない社。パークネットのトップは「サイトインデックス」だけの小さなページで、
 *  メンテナンスの告知は巡回で取る検索のページ（/parknet/search/ → /parknet/index.html）に出ていた（2026-10-27 確認）。
 *  あなぶきは会社のトップ（住まいの会社のサイト）が 10/27 に戻ったが、駐車場の一覧（/park/hourly/）は
 *  メンテナンスの告知（429）のまま。トップで見ると「回数の制限」と取り違える（2026-10-30 確認）。
 *  どちらも巡回で取っているページなので、見に行っても新しい所にはアクセスしない */
export const ENTRY_PATHS = { parknet: "/parknet/search/", anabuki: "/park/hourly/" };

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
      try {
        let res = await fetchTop(entry);
        if (res?.blocked && (res.status === 401 || res.status === 403) && fetchTopDirect) res = await fetchTopDirect(entry);
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
