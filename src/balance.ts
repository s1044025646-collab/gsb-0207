import { AlgoParams, FlashResult, ValidationError } from "./common";

export interface BalanceIssue {
  componentId: number;
  feedMoles: number;
  liquidMoles: number;
  vaporMoles: number;
  sumMoles: number;
  absError: number;
  relError: number;
  pass: boolean;
}

export interface BalanceReport {
  passed: boolean;
  maxRelError: number;
  phaseNormalization: Array<{
    phase: "liquid" | "vapor";
    exists: boolean;
    sum: number | null;
    pass: boolean;
  }>;
  kRelation: Array<{ componentId: number; ratio: number | null; pass: boolean | null }>;
  issues: BalanceIssue[];
}

/**
 * 独立物料核验（不使用闪蒸内部数据结构的任何缓存值，直接由相摩尔量求和）：
 * 1) 逐组分 F_i = L_i + V_i；
 * 2) 存在相组成归一化；
 * 3) 两相时 y_i = K_i x_i。
 */
export function verifyBalance(result: FlashResult, algo: AlgoParams): BalanceReport {
  if (result.regime === "degenerate-k-all-one") {
    throw new ValidationError("退化状态（K 全为 1）相分配不唯一，无法做相级物料核验");
  }
  const issues: BalanceIssue[] = result.components.map((c) => {
    const l = c.liquidMoles ?? 0;
    const v = c.vaporMoles ?? 0;
    const sum = l + v;
    const absError = Math.abs(sum - c.feedMoles);
    const scale = Math.max(Math.abs(c.feedMoles), algo.zeroFeedTol);
    const relError = absError / scale;
    return {
      componentId: c.componentId,
      feedMoles: c.feedMoles,
      liquidMoles: l,
      vaporMoles: v,
      sumMoles: sum,
      absError,
      relError,
      pass: relError <= algo.balanceTol,
    };
  });

  const phaseNormalization: BalanceReport["phaseNormalization"] = (
    ["liquid", "vapor"] as const
  ).map((phase) => {
    const exists = result.phasesPresent.includes(phase);
    if (!exists) return { phase, exists: false, sum: null, pass: true };
    const sum = result.components.reduce(
      (acc, c) => acc + ((phase === "liquid" ? c.x : c.y) ?? 0),
      0,
    );
    return { phase, exists: true, sum, pass: Math.abs(sum - 1) <= algo.balanceTol };
  });

  const kRelation: BalanceReport["kRelation"] = result.components.map((c) => {
    if (result.regime !== "two-phase" || c.x === null || c.y === null) {
      return { componentId: c.componentId, ratio: null, pass: null };
    }
    if (c.feedMoles <= algo.zeroFeedTol) {
      return { componentId: c.componentId, ratio: null, pass: null };
    }
    const ratio = c.x !== 0 ? c.y / c.x : c.k;
    const pass = Math.abs(ratio - c.k) <= algo.balanceTol * Math.max(1, Math.abs(c.k));
    return { componentId: c.componentId, ratio, pass };
  });

  const maxRelError = issues.reduce((m, i) => Math.max(m, i.relError), 0);
  const passed =
    issues.every((i) => i.pass) &&
    phaseNormalization.every((p) => p.pass) &&
    kRelation.every((k) => k.pass !== false) &&
    result.converged;

  return { passed, maxRelError, phaseNormalization, kRelation, issues };
}
