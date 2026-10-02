import { AlgoParams, FeedEntry, ValidationError, isFiniteNumber } from "./common";

export interface PreparedFeed {
  /** 以原始顺序排列的组分 id */
  componentIds: number[];
  /** 与 componentIds 对齐的原始摩尔量 */
  rawMoles: number[];
  /** 与 componentIds 对齐的归一化摩尔分数 z */
  z: number[];
  totalMoles: number;
  rawSum: number;
  normalized: boolean;
  /** 每组分的缩放记录（原值→使用值），未归一化时为空列表 */
  corrections: Array<{ componentId: number; raw: number; used: number }>;
  /** 零进料标记，与 componentIds 对齐 */
  zero: boolean[];
}

/**
 * 校验并准备进料。
 * - 每个摩尔量必须有限、非负；
 * - 原始总和必须 > 0；
 * - |sum-1| ≤ compSumTol 时视为合法的分数输入（不修改）；
 * - 仅当 normalize=true 时才把总和修正为 1，保留原值与修正记录；
 * - 总和偏离 1 且未要求归一化时拒绝。
 */
export function prepareFeed(
  entries: FeedEntry[],
  algo: AlgoParams,
  normalize: boolean,
): PreparedFeed {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ValidationError("进料至少包含一个组分");
  }
  const seen = new Set<number>();
  for (const e of entries) {
    if (!isFiniteNumber(e.moles) || e.moles < 0) {
      throw new ValidationError(
        `组分 ${e.componentId} 的进料摩尔量必须为有限非负数`,
      );
    }
    if (seen.has(e.componentId)) {
      throw new ValidationError(`组分 ${e.componentId} 在进料中重复出现`);
    }
    seen.add(e.componentId);
  }
  const componentIds = entries.map((e) => e.componentId);
  const rawMoles = entries.map((e) => e.moles);
  const zero = rawMoles.map((m) => m <= algo.zeroFeedTol);
  // 有进料组分的摩尔量之和（零进料组分只是占位，不参与归一化）
  const activeSum = rawMoles.reduce((a, b) => a + b, 0);
  const rawSum = rawMoles.reduce((a, b) => a + b, 0);
  if (activeSum <= 0) {
    throw new ValidationError("进料总摩尔量必须为正（至少一个组分摩尔量 > 0）");
  }

  const diff = Math.abs(activeSum - 1);
  const corrections: PreparedFeed["corrections"] = [];
  let normalizedFlag = false;
  let z: number[];
  if (diff > algo.compSumTol) {
    if (!normalize) {
      throw new ValidationError(
        `有进料组分摩尔量总和 ${activeSum} 与 1 的偏差 ${diff} 超过容差 ` +
          `${algo.compSumTol}；如需按比例归一化请显式选择 normalize=true`,
      );
    }
    normalizedFlag = true;
    z = rawMoles.map((m) => m / activeSum);
    for (let i = 0; i < entries.length; i++) {
      if (!zero[i]) {
        corrections.push({
          componentId: componentIds[i]!,
          raw: rawMoles[i]!,
          used: z[i]!,
        });
      }
    }
  } else {
    z = rawMoles.map((m) => m / activeSum);
  }
  return {
    componentIds,
    rawMoles,
    z,
    totalMoles: activeSum,
    rawSum,
    normalized: normalizedFlag,
    corrections,
    zero,
  };
}
