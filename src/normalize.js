// 料金の正規化（事業者横断の統一スキーマ）---------------------------------
// 3社は料金の持ち方が異なる（分刻み・条件の書式）。比較のため共通形へ写像する。
//   - 時間単価 → 円/時（yph）。曜日区分(day)と適用時間帯(from-to)も付与
//   - 最大料金 → 種別(type)で分類：d24h(24時間/当日最大) / night(夜間) /
//                daytime(昼間) / duration(N時間制限) / other
// ヘッドライン比較値：
//   yph    … 代表の円/時（平日/全日の昼14時に適用される単価）
//   max24h … 24時間・当日最大料金（比較の主指標。無ければ null）
//   maxNight … 夜間最大（あれば）

// 曜日区分を正規化
export function dayType(s) {
  const t = (s || "").trim();
  if (!t || /全日|終日/.test(t)) return "all";
  if (/^月|平日/.test(t)) return "weekday"; // 月～金 / 月～土 など
  if (/[土日祝]/.test(t)) return "weekend"; // 土・日・祝 / 日・祝 など
  return "all";
}

// "08:00-20:00" → {from:8,to:20}。"00:00-00:00"/空/"全日 終日" → 終日 {0,24}
function hourRange(timeRange) {
  const m = (timeRange || "").match(/(\d{1,2}):\d{2}\s*-\s*(\d{1,2}):\d{2}/);
  if (!m) return { from: 0, to: 24 };
  let f = +m[1], t = +m[2];
  if (f === 0 && t === 0) return { from: 0, to: 24 };
  if (t === 0) t = 24;
  return { from: f, to: t };
}

// 最大料金の条件文から種別を判定
export function maxType(condition) {
  const c = condition || "";
  // 入庫後 N 時間以内（Nが24なら24時間、それ以外は時間制限）
  const dur = c.match(/(\d+)\s*時間以内/);
  if (dur) return +dur[1] === 24 ? { type: "d24h" } : { type: "duration", hours: +dur[1] };
  // 24時間 / 当日最大(24時切替) / 24時迄 / 当日 / 1日
  if (/24\s*時間|24時切替|24時迄|当日|[1１]日/.test(c)) return { type: "d24h" };
  // 明示の時間帯レンジ
  const r = c.match(/(\d{1,2})[:：]?\d{0,2}\s*[-~～〜]\s*(\d{1,2})/);
  if (r) {
    const s = +r[1], e = +r[2];
    if (s > e || s >= 17) return { type: "night" };
    if (s < 12 && e <= 21) return { type: "daytime" };
    return { type: "other" };
  }
  if (/夜間|夜/.test(c)) return { type: "night" };
  return { type: "other" };
}

// 指定時刻(hour)・平日/全日に適用される円/時を選ぶ
function rateAt(units, hour) {
  for (const u of units) {
    if (u.day === "weekend") continue;
    const covers = u.from <= u.to ? hour >= u.from && hour < u.to : hour >= u.from || hour < u.to;
    if (covers) return u.yph;
  }
  return units[0]?.yph ?? null;
}

// レコード → 正規化した fee ブロック
export function normalizeFees(rec) {
  const unit = (rec.unitCharges ?? [])
    .map((u) => {
      if (!u.perMinutes) return null;
      const { from, to } = hourRange(u.timeRange);
      return {
        day: dayType(u.scope ?? u.timeRange),
        from, to,
        yph: Math.round((u.amountYen / u.perMinutes) * 60),
      };
    })
    .filter(Boolean);

  const max = (rec.maxFees ?? []).map((m) => ({
    day: dayType(m.scope),
    ...maxType(`${m.scope ?? ""} ${m.condition ?? ""}`),
    amountYen: m.amountYen,
  }));

  // ヘッドライン
  const pickMax = (type) => {
    const c = max.filter((m) => m.type === type);
    return (
      c.find((m) => m.day === "all") ??
      c.find((m) => m.day === "weekday") ??
      c[0]
    )?.amountYen ?? null;
  };

  return {
    unit,
    max,
    yph: rateAt(unit, 14), // 平日/全日 14時の単価を代表とする
    max24h: pickMax("d24h"),
    maxNight: pickMax("night"),
  };
}
