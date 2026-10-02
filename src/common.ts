/**
 * 全局数值容差、单位约定与公共类型。
 *
 * 温度单位：摄氏温度 °C（Antoine 方程）与开尔文 K（内部统一用 °C 输入，
 * 转换由物性行的 T 单位声明决定，本实现冻结的 Antoine 系数一律按 °C）。
 * 压力单位：mmHg（Antoine 蒸气压原始输出），对外统一换算为 kPa；
 * 闪蒸总压 P 对外单位为 kPa。
 */

export const MMHG_TO_KPA = 101.325 / 760.0; // 1 mmHg = 0.133322 kPa

export interface AlgoParams {
  /** 组成归一化公开容差（摩尔分数和与 1 的允许偏差） */
  compSumTol: number;
  /** 单个摩尔分数允许的最小有限非负值下限判定 */
  zeroFeedTol: number;
  /** RR 根求解残差收敛阈值 */
  rrResidualTol: number;
  /** 守恒核验容差（相对） */
  balanceTol: number;
  /** |K-1| 小于该值视为 K≈1（退化分量） */
  kNearOneTol: number;
  /** bisection/Brent 最大迭代次数 */
  maxIter: number;
  /** 有物理根的端点判据余量（避免在严格端点做除法） */
  endpointEps: number;
}

export const DEFAULT_ALGO: AlgoParams = {
  compSumTol: 1e-6,
  zeroFeedTol: 1e-12,
  rrResidualTol: 1e-10,
  balanceTol: 1e-8,
  kNearOneTol: 1e-9,
  maxIter: 200,
  endpointEps: 1e-12,
};

export type PhaseRegime =
  | "all-liquid"
  | "all-vapor"
  | "two-phase"
  | "degenerate-k-all-one";

export type StopReason =
  | "endpoint-all-liquid"
  | "endpoint-all-vapor"
  | "root-converged"
  | "max-iterations"
  | "degenerate-k-all-one";

/** 冻结的 Antoine 系数行（温度 °C，蒸气压 mmHg，温区闭区间） */
export interface AntoineCoeff {
  a: number;
  b: number;
  c: number;
  tMinC: number;
  tMaxC: number;
}

export interface ComponentDef {
  id: number;
  name: string;
  cas?: string | null;
  antoine?: AntoineCoeff | null;
}

/** 进料中单个组分：id + 摩尔数（非负，内部以摩尔量而非分数为主） */
export interface FeedEntry {
  componentId: number;
  moles: number;
}

export interface FlashComponentResult {
  componentId: number;
  name: string;
  feedMoles: number;
  z: number; // 进料摩尔分数
  k: number; // 平衡常数 K=y/x
  liquidMoles: number | null; // 液相中摩尔量；液相不存在时为 null
  vaporMoles: number | null; // 气相中摩尔量；气相不存在时为 null
  x: number | null; // 液相摩尔分数；液相不存在时为 null
  y: number | null; // 气相摩尔分数；气相不存在时为 null
}

export interface FlashResult {
  regime: PhaseRegime;
  beta: number | null; // 汽化摩尔分率 V/F；退化时为 null
  betaUnique: boolean; // 汽化分率是否唯一
  phasesPresent: Array<"liquid" | "vapor">;
  components: FlashComponentResult[];
  residual: number | null; // RR 残差（端点态给出端点处值）
  iterations: number;
  stopReason: StopReason;
  converged: boolean;
  warnings: string[];
  temperatureC: number;
  pressureKpa: number;
  totalFeedMoles: number;
  liquidMoles: number | null;
  vaporMoles: number | null;
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
