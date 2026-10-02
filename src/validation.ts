import { CompositionCheck, NormalizationRecord } from './types.js';
import { NORMALIZE_TOL, SUM_TOL } from './constants.js';

/**
 * 校验摩尔组成：必须全部有限、非负，且总和在公开容差 SUM_TOL 内等于 1。
 * 不做任何自动修正。
 */
export function checkComposition(comp: Record<string, number>): CompositionCheck {
  const errors: string[] = [];
  let finite = true;
  let nonNegative = true;
  let rawSum = 0;

  for (const [name, value] of Object.entries(comp)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      finite = false;
      errors.push(`组分 ${name} 的摩尔分率不是有限数`);
      continue;
    }
    if (value < 0) {
      nonNegative = false;
      errors.push(`组分 ${name} 的摩尔分率为负 (${value})`);
    }
    rawSum += value;
  }

  if (Object.keys(comp).length === 0) {
    errors.push('进料组成不能为空');
  }

  const sumWithinTolerance = finite && nonNegative && Math.abs(rawSum - 1) <= SUM_TOL;
  if (finite && nonNegative && !sumWithinTolerance) {
    errors.push(`组成总和 ${rawSum} 与 1 的偏差超过容差 ${SUM_TOL}`);
  }

  return { ok: errors.length === 0, finite, nonNegative, rawSum, sumWithinTolerance, errors };
}

/**
 * 处理组成。normalize=false（默认）时不允许修正：
 * 仅当总和已在容差内时通过，并把总和精确归一用于数值计算（记录但不视为“修正”）。
 * normalize=true 时允许把非负、有限、总和为正的组成按原值比例归一，
 * 保留原值并输出修正记录。
 */
export function prepareComposition(
  comp: Record<string, number>,
  normalize: boolean,
): { check: CompositionCheck; record: NormalizationRecord; usable?: Record<string, number> } {
  const check = checkComposition(comp);
  const record: NormalizationRecord = {
    normalized: false,
    rawSum: check.rawSum,
    rawComposition: { ...comp },
  };

  if (check.sumWithinTolerance) {
    // 总和已在容差内：做一次精确重标定仅用于内部数值稳定，记录为非用户修正。
    const usable = rescale(comp, check.rawSum);
    return { check, record, usable };
  }

  if (!normalize) {
    return { check, record };
  }

  // 用户显式选择归一化：要求有限、非负且总和为正。
  if (!check.finite || !check.nonNegative || !(check.rawSum > 0)) {
    record.reason = '组成包含非有限值、负值或总和非正，无法归一化';
    return { check, record };
  }

  const normalizedComposition = rescale(comp, check.rawSum);
  const newSum = Object.values(normalizedComposition).reduce((a, b) => a + b, 0);
  if (Math.abs(newSum - 1) > NORMALIZE_TOL) {
    record.reason = `归一化后总和 ${newSum} 未通过核验`;
    return { check, record };
  }
  record.normalized = true;
  record.normalizedComposition = normalizedComposition;
  record.reason = `用户选择归一化：原始总和 ${check.rawSum}，按原值比例修正为 1`;
  return { check, record, usable: normalizedComposition };
}

function rescale(comp: Record<string, number>, sum: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(comp)) out[k] = v / sum;
  return out;
}
