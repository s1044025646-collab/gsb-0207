import {
  ComponentFlow,
  FlashResult,
  KEntry,
  MaterialCheck,
  NormalizationRecord,
  PhaseState,
  StopReason,
} from './types.js';
import { AlgorithmParams, DEFAULT_PRESSURE_UNIT, TEMPERATURE_UNIT } from './constants.js';

interface RRInput {
  name: string;
  z: number;
  k: number;
  zero: boolean;
}

/**
 * Rachford–Rice 函数：
 *   f(beta) = Σ_i z_i (K_i - 1) / (1 + beta (K_i - 1))
 * beta = V/F 为汽化摩尔分率。零进料组分不参与求和（其分配不定义、按缺省处理）。
 */
function rrFunction(rows: RRInput[], beta: number): number {
  let f = 0;
  for (const r of rows) {
    if (r.zero) continue;
    const km1 = r.k - 1;
    f += (r.z * km1) / (1 + beta * km1);
  }
  return f;
}

export interface RRRootOutput {
  state: PhaseState;
  stopReason: StopReason;
  beta: number | null;
  residual: number | null;
  iterations: number;
  /** 物理根开区间端点（两相时有意义）。 */
  betaMin: number;
  betaMax: number;
}

/**
 * 端点判据 + 有物理根才在 (0,1) 内求根。
 * 物理可行开区间：
 *   beta_lo = max(0, max_{K_i>1} 1/(1-K_i))
 *   beta_hi = min(1, min_{K_i<1} 1/(1-K_i)) = min(1, min_{K_i<1} -1/(K_i-1))
 */
export function solveRachfordRice(entries: KEntry[], zMap: Map<string, number>, params: AlgorithmParams): RRRootOutput {
  const rows: RRInput[] = entries.map((e) => {
    const z = zMap.get(e.component) ?? 0;
    return { name: e.component, z, k: e.k, zero: z <= params.zeroZ };
  });

  const active = rows.filter((r) => !r.zero);

  // 退化：所有“有进料”的组分 K≈1 => beta 不唯一。
  const allOne = active.every((r) => Math.abs(r.k - 1) <= params.kOneTol);
  if (allOne) {
    return {
      state: 'degenerate-k-all-one',
      stopReason: 'degenerate-k-all-one',
      beta: null,
      residual: 0,
      iterations: 0,
      betaMin: NaN,
      betaMax: NaN,
    };
  }

  // 物理可行开区间（只用有进料组分，避免微量 K 把区间压扁）。
  let lo = 0;
  let hi = 1;
  for (const r of active) {
    if (r.k > 1) {
      const pole = 1 / (1 - r.k); // < 0
      if (pole > lo) lo = pole;
    } else if (r.k < 1) {
      const pole = 1 / (1 - r.k); // > 1
      if (pole < hi) hi = pole;
    }
  }

  // 端点函数值。f(0)=Σ z(K-1)；f(1)=Σ z(K-1)/K。
  const f0 = rrFunction(active, 0);
  const f1 = rrFunction(active, 1);

  // 全液：f(0) <= 0（正侧无物理根，beta 上限为 0）。
  if (f0 <= 0) {
    return {
      state: 'all-liquid',
      stopReason: 'endpoint-all-liquid',
      beta: 0,
      residual: f0,
      iterations: 0,
      betaMin: lo,
      betaMax: hi,
    };
  }
  // 全气：f(1) >= 0（beta 下限 1）。
  if (f1 >= 0) {
    return {
      state: 'all-vapor',
      stopReason: 'endpoint-all-vapor',
      beta: 1,
      residual: f1,
      iterations: 0,
      betaMin: lo,
      betaMax: hi,
    };
  }

  // 两相：f(0)>0 且 f(1)<0，在开区间 (max(lo,0), min(hi,1)) 内求根。
  const a = Math.max(lo, 0);
  const b = Math.min(hi, 1);
  if (!(b > a)) {
    return {
      state: 'infeasible',
      stopReason: 'no-physical-root',
      beta: null,
      residual: null,
      iterations: 0,
      betaMin: lo,
      betaMax: hi,
    };
  }

  // 二分法求根（RR 在物理区间单调递减，二分严格稳健），端点留小间隙避开极点。
  let left = a;
  let right = b;
  let fLeft = rrFunction(active, left);
  let fRight = rrFunction(active, right);
  let iter = 0;
  let mid = 0.5 * (left + right);

  // 数值上把恰好落在 0/1 的端点向内微推，保证分母非零且符号正确。
  if (!Number.isFinite(fLeft) || fLeft <= 0) {
    left = a + Math.max(params.bracketTol, 1e-12) * Math.max(1, Math.abs(a));
    fLeft = rrFunction(active, left);
  }
  if (!Number.isFinite(fRight) || fRight >= 0) {
    right = b - Math.max(params.bracketTol, 1e-12) * Math.max(1, Math.abs(b === 1 ? 1 : b));
    fRight = rrFunction(active, right);
  }

  if (!(fLeft > 0 && fRight < 0)) {
    return {
      state: 'infeasible',
      stopReason: 'no-physical-root',
      beta: null,
      residual: null,
      iterations: iter,
      betaMin: lo,
      betaMax: hi,
    };
  }

  let fMid = 0;
  for (; iter < params.rrMaxIter; iter++) {
    mid = 0.5 * (left + right);
    fMid = rrFunction(active, mid);
    if (Math.abs(right - left) <= params.bracketTol && Math.abs(fMid) <= params.rrResidualTol) break;
    if (fMid > 0) {
      left = mid;
    } else {
      right = mid;
    }
    if (Math.abs(fMid) <= params.rrResidualTol && Math.abs(right - left) <= 1e-12) break;
  }

  const converged =
    Number.isFinite(fMid) &&
    Math.abs(fMid) <= params.rrResidualTol &&
    mid >= a - params.bracketTol &&
    mid <= b + params.bracketTol;

  return {
    state: converged ? 'two-phase' : 'infeasible',
    stopReason: converged ? 'physical-root-bracketed' : 'max-iterations',
    beta: mid,
    residual: fMid,
    iterations: iter + 1,
    betaMin: lo,
    betaMax: hi,
  };
}

/** 依据 beta 求存在相组成与组分进出摩尔量（基准 F=1 mol），并做物料核验。 */
export function assembleFlash(
  entries: KEntry[],
  zMap: Map<string, number>,
  root: RRRootOutput,
  temperature: number,
  pressure: number | null,
  pressureUnit: string,
  kSource: KEntry['source'],
  normalization: NormalizationRecord,
  warnings: string[],
  params: AlgorithmParams,
): FlashResult {
  const beta = root.beta;
  const liquid = root.state === 'all-liquid' || root.state === 'two-phase';
  const vapor = root.state === 'all-vapor' || root.state === 'two-phase';

  const components: ComponentFlow[] = [];
  const perComponent: MaterialCheck['perComponent'] = [];
  let maxImb = 0;
  let liquidSum = 0;
  let vaporSum = 0;
  let maxKY: number | null = null;

  for (const e of entries) {
    const z = zMap.get(e.component) ?? 0;
    const zero = z <= params.zeroZ;
    let liqMoles: number | null = null;
    let vapMoles: number | null = null;
    let x: number | null = null;
    let y: number | null = null;

    if (root.state === 'degenerate-k-all-one') {
      // beta 不唯一：不产出相分配。
    } else if (root.state === 'all-liquid') {
      liqMoles = z;
      vapMoles = 0;
      x = z;
    } else if (root.state === 'all-vapor') {
      liqMoles = 0;
      vapMoles = z;
      y = z;
    } else if (root.state === 'two-phase' && beta !== null) {
      if (zero) {
        // 零进料组分：不进入任何相，进出摩尔量为 0，避免伪组成/伪守恒。
        x = 0;
        y = 0;
        liqMoles = 0;
        vapMoles = 0;
      } else {
        const denom = 1 + beta * (e.k - 1);
        x = z / denom;
        y = (e.k * z) / denom;
        liqMoles = (1 - beta) * x;
        vapMoles = beta * y;
      }
    }

    if (liquid && x !== null && !zero) liquidSum += x;
    if (vapor && y !== null && !zero) vaporSum += y;

    if (liqMoles !== null && vapMoles !== null) {
      const imb = z - (liqMoles + vapMoles);
      perComponent.push({ component: e.component, imbalance: imb });
      maxImb = Math.max(maxImb, Math.abs(imb));
    } else {
      perComponent.push({ component: e.component, imbalance: 0 });
    }

    if (root.state === 'two-phase' && !zero && x !== null && y !== null) {
      const dev = Math.abs(y - e.k * x);
      maxKY = maxKY === null ? dev : Math.max(maxKY, dev);
    }

    components.push({
      component: e.component,
      z,
      k: e.k,
      liquidMoles: liqMoles,
      vaporMoles: vapMoles,
      x: liquid ? x : null,
      y: vapor ? y : null,
      zeroFeed: zero,
    });
  }

  const liqSumVal = liquid ? liquidSum : null;
  const vapSumVal = vapor ? vaporSum : null;
  const sumOk =
    (!liquid || liqSumVal === null || Math.abs(liqSumVal - 1) <= params.phaseSumTol) &&
    (!vapor || vapSumVal === null || Math.abs(vapSumVal - 1) <= params.phaseSumTol);
  const kyOk = maxKY === null || maxKY <= params.phaseSumTol;
  const matOk = maxImb <= params.materialTol;

  const passed = root.state === 'degenerate-k-all-one' ? true : sumOk && kyOk && matOk && root.state !== 'infeasible';
  if (!sumOk) warnings.push(`存在相组成归一核验未通过：液相和=${liqSumVal}，气相和=${vapSumVal}`);
  if (!kyOk) warnings.push(`两相 y=Kx 核验偏差 ${maxKY} 超过容差`);
  if (!matOk) warnings.push(`组分守恒最大偏差 ${maxImb} 超过容差 ${params.materialTol}`);

  const materialCheck: MaterialCheck = {
    perComponent,
    maxAbsImbalance: maxImb,
    liquidSum: liqSumVal,
    vaporSum: vapSumVal,
    maxKYDeviation: maxKY,
    passed,
  };

  return {
    state: root.state,
    stopReason: root.stopReason,
    converged: root.state === 'infeasible' ? false : passed,
    beta: root.state === 'two-phase' ? beta : root.state === 'all-vapor' ? 1 : root.state === 'all-liquid' ? 0 : null,
    liquidFraction:
      root.state === 'two-phase' && beta !== null
        ? 1 - beta
        : root.state === 'all-liquid'
          ? 1
          : root.state === 'all-vapor'
            ? 0
            : null,
    liquidPresent: liquid,
    vaporPresent: vapor,
    temperature,
    temperatureUnit: TEMPERATURE_UNIT,
    pressure: pressure ?? NaN,
    pressureUnit,
    components,
    residual: root.residual,
    iterations: root.iterations,
    kSource,
    materialCheck,
    normalization,
    warnings,
  };
}

export { DEFAULT_PRESSURE_UNIT };
