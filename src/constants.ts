/**
 * 全局公开容差与单位约定。
 *
 * 单位约定：
 *  - 温度 T：摄氏度 °C（Antoine 方程输入），开尔文 K 仅在需要绝对温度换算时内部使用。
 *  - 压力 P 与饱和蒸气压 Psat：同一压力单位（默认 kPa）。Raoult 定律 K = Psat / P
 *    为无量纲量，只要 Psat 与 P 单位一致即可；导入时两者必须声明相同单位。
 *  - 摩尔组成 z/x/y：摩尔分率，无量纲。
 *
 * Antoine 方程（本项目采用的显式形式，以 10 为底）：
 *    log10(Psat) = A - B / (T + C)
 *  其中 T 单位 °C，Psat 单位为组分声明的压力单位；适用温区 [Tmin, Tmax]（°C，闭区间）。
 */

export const DEFAULT_PRESSURE_UNIT = 'kPa';
export const TEMPERATURE_UNIT = '°C';

/** 组成归一化判定容差：|sum(z)-1| <= SUM_TOL 即视为总和为一。 */
export const SUM_TOL = 1e-6;
/** 归一化（用户显式选择）后再次核验的容差。 */
export const NORMALIZE_TOL = 1e-12;
/** 组成元素允许的下限：小于该值按零进料处理（稳定处理极微量组分）。 */
export const ZERO_Z = 1e-30;
/** K 视为等于 1 的邻域 |K-1| <= K_ONE_TOL，用于退化检测。 */
export const K_ONE_TOL = 1e-9;
/** 数值求解中 K 允许的严格正下界。 */
export const K_MIN = 1e-12;

/** Rachford-Rice 主迭代（Brent/割线混合）默认参数。 */
export const RR_MAX_ITER = 200;
/** 有根区间相对/绝对收敛宽度。 */
export const BRACKET_TOL = 1e-14;
/** RR 残差 |f(beta)| 的通过容差。 */
export const RR_RESIDUAL_TOL = 1e-10;

/** 闪蒸物料核验：总摩尔守恒 |z_i - (l_i + v_i)| 的通过容差。 */
export const MATERIAL_TOL = 1e-8;
/** 存在相组成归一核验容差。 */
export const PHASE_SUM_TOL = 1e-8;

export interface AlgorithmParams {
  rrMaxIter: number;
  bracketTol: number;
  rrResidualTol: number;
  materialTol: number;
  phaseSumTol: number;
  kOneTol: number;
  sumTol: number;
  zeroZ: number;
  kMin: number;
}

export const DEFAULT_ALGORITHM_PARAMS: AlgorithmParams = {
  rrMaxIter: RR_MAX_ITER,
  bracketTol: BRACKET_TOL,
  rrResidualTol: RR_RESIDUAL_TOL,
  materialTol: MATERIAL_TOL,
  phaseSumTol: PHASE_SUM_TOL,
  kOneTol: K_ONE_TOL,
  sumTol: SUM_TOL,
  zeroZ: ZERO_Z,
  kMin: K_MIN,
};
