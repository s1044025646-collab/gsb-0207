/** 组分：冻结的 Antoine 系数（10 为底，log10(Psat)=A-B/(T+C)，T 单位 °C）。 */
export interface Component {
  id: number | null;
  name: string;
  cas?: string | null;
  pressureUnit: string;
  /** Antoine A、B、C，任一为 null 表示该组分不能用蒸气压模型。 */
  antoineA: number | null;
  antoineB: number | null;
  antoineC: number | null;
  /** 有效温区（°C，闭区间）。 */
  tMin: number | null;
  tMax: number | null;
}

/** 进料模板（归一化前的原始摩尔分率与可选总摩尔数）。 */
export interface Feed {
  id: number | null;
  name: string;
  /** 组分名 -> 原始（未修正）摩尔分率。 */
  composition: Record<string, number>;
  totalMoles: number;
}

/** 物性版本（一组组分的不可变快照）。 */
export interface PropertyVersion {
  id: number | null;
  name: string;
  createdAt: string;
  note?: string | null;
}

/** K 值来源。 */
export type KSource = 'user' | 'raoult';

export interface KEntry {
  component: string;
  k: number;
  source: KSource;
  /** Raoult 来源时记录的饱和蒸气压。 */
  psat?: number | null;
}

/** 组成校验结果。 */
export interface CompositionCheck {
  ok: boolean;
  finite: boolean;
  nonNegative: boolean;
  rawSum: number;
  sumWithinTolerance: boolean;
  errors: string[];
}

export interface NormalizationRecord {
  normalized: boolean;
  rawSum: number;
  /** 原始组成（修正前）。 */
  rawComposition: Record<string, number>;
  /** 修正后组成。 */
  normalizedComposition?: Record<string, number>;
  reason?: string;
}

/** 相态分类。 */
export type PhaseState =
  | 'all-liquid'
  | 'all-vapor'
  | 'two-phase'
  | 'degenerate-k-all-one'
  | 'infeasible';

/** 求解停止原因。 */
export type StopReason =
  | 'endpoint-all-liquid'
  | 'endpoint-all-vapor'
  | 'physical-root-bracketed'
  | 'degenerate-k-all-one'
  | 'no-physical-root'
  | 'max-iterations';

export interface ComponentFlow {
  component: string;
  z: number;
  k: number;
  /** 进入液相的摩尔量（以总进料 1 mol 为基准）。 */
  liquidMoles: number | null;
  /** 进入气相的摩尔量（以总进料 1 mol 为基准）。 */
  vaporMoles: number | null;
  /** 液相摩尔分率（仅液相存在时有值）。 */
  x: number | null;
  /** 气相摩尔分率（仅气相存在时有值）。 */
  y: number | null;
  zeroFeed: boolean;
}

export interface MaterialCheck {
  /** 每组分守恒偏差 z - (l+v)（基准 1 mol）。 */
  perComponent: Array<{ component: string; imbalance: number }>;
  maxAbsImbalance: number;
  liquidSum: number | null;
  vaporSum: number | null;
  /** 两相时 max|y - Kx|。 */
  maxKYDeviation: number | null;
  passed: boolean;
}

export interface FlashResult {
  state: PhaseState;
  stopReason: StopReason;
  converged: boolean;
  /** 汽化摩尔分率 beta = V/F；退化或不存在的相为 null。 */
  beta: number | null;
  /** 液相分率 L/F。 */
  liquidFraction: number | null;
  /** 液相是否实际存在。 */
  liquidPresent: boolean;
  /** 气相是否实际存在。 */
  vaporPresent: boolean;
  temperature: number;
  temperatureUnit: string;
  pressure: number;
  pressureUnit: string;
  components: ComponentFlow[];
  residual: number | null;
  iterations: number;
  kSource: KSource;
  materialCheck: MaterialCheck;
  normalization: NormalizationRecord;
  warnings: string[];
}

export type BoundaryKind = 'bubble' | 'dew';

export interface BubbleDewResult {
  kind: BoundaryKind;
  pressure: number;
  pressureUnit: string;
  temperature: number;
  temperatureUnit: string;
  /** 边界上“极限相”的组成：泡点极限气相 y，露点极限液相 x。 */
  limitingPhase: 'vapor' | 'liquid';
  limitingComposition: Array<{ component: string; value: number }>;
  /** 实际存在的相：泡点以液相为主体，露点以气相为主体。 */
  existingPhase: 'liquid' | 'vapor';
  existingComposition: Array<{ component: string; value: number }>;
  /** 极限相在边界处量为 0，不是已产出的物流。 */
  limitingPhaseMoles: 0;
  residual: number;
  converged: boolean;
  warnings: string[];
}

export interface ScanPoint {
  pressure: number;
  state: PhaseState;
  beta: number | null;
  converged: boolean;
  residual: number | null;
}

export interface ScanResult {
  temperature: number;
  pressureUnit: string;
  bubblePressure: number | null;
  dewPressure: number | null;
  points: ScanPoint[];
  /** 相邻点 beta 跨边界连续性核验最大跳变（归一化后）。 */
  continuityMaxJump: number | null;
  continuityPassed: boolean;
}

export interface FlashRequest {
  feedName: string;
  versionName: string;
  temperature: number;
  pressure?: number | null;
  /** 直接给定 K：组分名 -> 正 K；提供则忽略 Raoult 路径（除非该组分缺省）。 */
  userK?: Record<string, number> | null;
  normalize?: boolean;
}
