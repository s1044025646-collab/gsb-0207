import {
  AntoineCoeff,
  MMHG_TO_KPA,
  ValidationError,
  isFiniteNumber,
} from "./common";

/**
 * Antoine 方程（冻结系数，显式对数形式）：
 *   log10(Psat / mmHg) = A - B / (C + t/°C)
 * 因此：Psat(kPa) = 10^(A - B/(C+t)) * 0.133322...
 * 仅在闭温区 [tMinC, tMaxC] 内有效；越界或缺系数一律拒绝。
 */
export function antoinePsatKpa(coeff: AntoineCoeff, temperatureC: number): number {
  if (!isFiniteNumber(temperatureC)) {
    throw new ValidationError("温度必须为有限数值（°C）");
  }
  if (temperatureC < coeff.tMinC || temperatureC > coeff.tMaxC) {
    throw new ValidationError(
      `温度 ${temperatureC}°C 超出 Antoine 有效温区 ` +
        `[${coeff.tMinC}, ${coeff.tMaxC}]°C`,
    );
  }
  const denom = coeff.c + temperatureC;
  if (denom <= 0) {
    throw new ValidationError(
      `Antoine 分母 C+T=${denom} 非正，系数在该温度下无定义`,
    );
  }
  const log10Mmhg = coeff.a - coeff.b / denom;
  const psatMmhg = Math.pow(10, log10Mmhg);
  if (!Number.isFinite(psatMmhg) || psatMmhg <= 0) {
    throw new ValidationError("Antoine 计算得到非正或非有限的饱和蒸气压");
  }
  return psatMmhg * MMHG_TO_KPA;
}

/** Raoult 定律（理想体系）：K_i = Psat_i / P，P 与 Psat 均为 kPa。 */
export function raoultK(psatKpa: number, pressureKpa: number): number {
  if (!isFiniteNumber(pressureKpa) || pressureKpa <= 0) {
    throw new ValidationError("总压必须为正的有限数值（kPa）");
  }
  return psatKpa / pressureKpa;
}

/**
 * 统一组装 K：
 * - 用户直接给定正的 K 时原样使用（仍校验为正有限值）；
 * - 否则用冻结 Antoine + Raoult 计算；
 * - 零进料组分（进料摩尔量为 0）不参与闪蒸，允许缺 K（返回 null）。
 */
export function resolveK(options: {
  directK?: number;
  antoine?: AntoineCoeff | null;
  temperatureC: number;
  pressureKpa: number;
  hasFeed: boolean;
}): number | null {
  const { directK, antoine, temperatureC, pressureKpa, hasFeed } = options;
  if (directK !== undefined) {
    if (!isFiniteNumber(directK) || directK <= 0) {
      throw new ValidationError("直接给定的平衡常数 K 必须为正的有限数值");
    }
    return directK;
  }
  if (!antoine) {
    if (hasFeed) {
      throw new ValidationError(
        "有进料的组分缺少 Antoine 系数，且未直接给定 K",
      );
    }
    return null;
  }
  const psat = antoinePsatKpa(antoine, temperatureC);
  return raoultK(psat, pressureKpa);
}
