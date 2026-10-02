import { AntoineCoeff, FeedEntry, ValidationError } from "./common";

export interface PropertyImportRow {
  key: string;
  name: string;
  cas?: string | null;
  antoine?: AntoineCoeff | null;
}

/** 极简 RFC4180 风格 CSV 解析（支持引号、逗号、双引号转义） */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const s = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          if (v === null || v === undefined) return "";
          const s = String(v);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\r\n");
}

function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new ValidationError(`字段 ${field} 必须为有限数值`);
  return n;
}

/**
 * 物性 CSV 表头（顺序固定）：
 * key,name,cas,A,B,C,Tmin_C,Tmax_C  （log10(Psat/mmHg)=A-B/(C+t°C)）
 */
export function parsePropertyCsv(text: string): PropertyImportRow[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ValidationError("物性 CSV 至少需要表头与一行数据");
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const need = ["key", "name", "a", "b", "c", "tmin_c", "tmax_c"];
  for (const n of need) {
    if (!header.includes(n)) throw new ValidationError(`物性 CSV 缺少列 ${n}`);
  }
  const idx = (n: string) => header.indexOf(n);
  return rows.slice(1).map((r) => {
    const a = num(r[idx("a")], "A");
    const b = num(r[idx("b")], "B");
    const c = num(r[idx("c")], "C");
    const tMinC = num(r[idx("tmin_c")], "Tmin");
    const tMaxC = num(r[idx("tmax_c")], "Tmax");
    if (tMinC > tMaxC) throw new ValidationError("Tmin 不能大于 Tmax");
    const key = (r[idx("key")] ?? "").trim();
    const name = (r[idx("name")] ?? "").trim();
    if (!key || !name) throw new ValidationError("key 与 name 不能为空");
    return {
      key,
      name,
      cas: header.includes("cas") ? (r[idx("cas")] ?? "").trim() || null : null,
      antoine: { a, b, c, tMinC, tMaxC },
    };
  });
}

/** 物性 JSON：{ components: [{ key, name, cas?, antoine: {a,b,c,tMinC,tMaxC}? }] } */
export function parsePropertyJson(text: string): PropertyImportRow[] {
  const data = JSON.parse(text) as { components?: PropertyImportRow[] };
  if (!data || !Array.isArray(data.components)) {
    throw new ValidationError("物性 JSON 需要 { components: [...] }");
  }
  for (const c of data.components) {
    if (!c.key || !c.name) throw new ValidationError("每个组分需要 key 与 name");
    if (c.antoine) {
      const an = c.antoine;
      for (const f of ["a", "b", "c", "tMinC", "tMaxC"] as const) {
        if (!Number.isFinite(an[f])) throw new ValidationError(`组分 ${c.key} 的 Antoine.${f} 非法`);
      }
      if (an.tMinC > an.tMaxC) throw new ValidationError(`组分 ${c.key} 的 Tmin>Tmax`);
    }
  }
  return data.components;
}

/** 进料 CSV：component_key,moles */
export function parseFeedCsv(text: string): Array<{ key: string; moles: number }> {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ValidationError("进料 CSV 至少需要表头与一行数据");
  return rows.slice(1).map((r) => ({
    key: (r[0] ?? "").trim(),
    moles: num(r[1], "moles"),
  }));
}

/** 进料 JSON：{ entries: [{ key|componentId, moles }] } */
export function parseFeedJson(
  text: string,
): Array<{ key?: string; componentId?: number; moles: number }> {
  const data = JSON.parse(text) as {
    entries?: Array<{ key?: string; componentId?: number; moles: number }>;
  };
  if (!data || !Array.isArray(data.entries)) {
    throw new ValidationError("进料 JSON 需要 { entries: [...] }");
  }
  return data.entries;
}

export type { FeedEntry };
