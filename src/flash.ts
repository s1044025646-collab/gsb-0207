import {
  AlgoParams,
  ComponentDef,
  FlashComponentResult,
  FlashResult,
  PhaseRegime,
  StopReason,
  ValidationError,
} from "./common";
import { PreparedFeed } from "./feed";

export interface FlashInput {
  components: ComponentDef[];
  feed: PreparedFeed;
  /** 与 feed.componentIds 对齐；零进料且无 K 时允许 null */
  k: (number | null)[];
  temperatureC: number;
  pressureKpa: number;
  algo: AlgoParams;
}

function rr(z: number[], k: number[], beta: number): number {
  let s = 0;
  for (let i = 0; i < z.length; i++) {
    const d = 1 + beta * (k[i]! - 1);
    s += (z[i]! * (k[i]! - 1)) / d;
  }
  return s;
}

/** 二分法求 RR 根（自行实现；返回 beta、残差与迭代次数） */
function solveRoot(
  z: number[],
  k: number[],
  algo: AlgoParams,
): { beta: number; residual: number; iterations: number; converged: boolean } {
  let lo = algo.endpointEps;
  let hi = 1 - algo.endpointEps;
  let flo = rr(z, k, lo);
  let fhi = rr(z, k, hi);
  let iter = 0;
  while (iter < algo.maxIter) {
    iter++;
    const mid = (lo + hi) / 2;
    const fm = rr(z, k, mid);
    if (Math.abs(fm) <= algo.rrResidualTol || hi - lo <= Number.EPSILON) {
      return { beta: mid, residual: Math.abs(fm), iterations: iter, converged: true };
    }
    if (flo * fm <= 0) {
      hi = mid;
      fhi = fm;
    } else {
      lo = mid;
      flo = fm;
    }
    void fhi;
  }
  const beta = (lo + hi) / 2;
  return {
    beta,
    residual: Math.abs(rr(z, k, beta)),
    iterations: iter,
    converged: false,
  };
}

export function flash(input: FlashInput): FlashResult {
  const { feed, k, algo, temperatureC, pressureKpa, components } = input;
  const nameOf = new Map(components.map((c) => [c.id, c.name]));
  const warnings: string[] = [];

  const activeIdx: number[] = [];
  for (let i = 0; i < feed.componentIds.length; i++) {
    if (!feed.zero[i]) activeIdx.push(i);
  }
  for (const i of activeIdx) {
    if (k[i] === null || k[i] === undefined) {
      throw new ValidationError(
        `组分 ${feed.componentIds[i]} 有进料但无法得到平衡常数 K`,
      );
    }
  }
  const za = activeIdx.map((i) => feed.z[i]!);
  const ka = activeIdx.map((i) => k[i]!);

  // 有进料组分 K 全为 1：beta 不唯一，返回退化状态，不指定分率
  if (ka.every((kv) => Math.abs(kv - 1) <= algo.kNearOneTol)) {
    return buildDegenerate(input, activeIdx, nameOf, warnings);
  }
  const nearBand = 1e-6;
  ka.forEach((kv, j) => {
    const dk = Math.abs(kv - 1);
    if (dk > algo.kNearOneTol && dk <= nearBand) {
      warnings.push(
        `组分 ${feed.componentIds[activeIdx[j]!]} 的 K 接近但不等于 1（${kv}），对 RR 根贡献极小`,
      );
    }
  });

  const g0 = rr(za, ka, 0);
  const g1 = rr(za, ka, 1);

  let regime: PhaseRegime;
  let beta: number;
  let residual: number;
  let iterations = 0;
  let converged = true;
  let stopReason: StopReason;

  // 端点边界容差相对残差容差放宽（端点数值含 K 链浮点误差）
  const endpointTol = Math.max(algo.rrResidualTol, 1e-9);
  if (g0 >= -endpointTol && g0 <= endpointTol) {
    // 泡点边界：g(0)≈0，气相为极限相，实际只有液相
    regime = "all-liquid";
    beta = 0;
    residual = Math.abs(g0);
    stopReason = "endpoint-all-liquid";
  } else if (Math.abs(g1) <= endpointTol) {
    // 露点边界：g(1)≈0，液相为极限相，实际只有气相
    regime = "all-vapor";
    beta = 1;
    residual = Math.abs(g1);
    stopReason = "endpoint-all-vapor";
  } else if (g0 < 0) {
    regime = "all-liquid";
    beta = 0;
    residual = Math.abs(g0);
    stopReason = "endpoint-all-liquid";
  } else if (g1 > 0) {
    regime = "all-vapor";
    beta = 1;
    residual = Math.abs(g1);
    stopReason = "endpoint-all-vapor";
  } else {
    // 唯一有物理根的情形：g(0)>0 且 g(1)<0
    regime = "two-phase";
    const root = solveRoot(za, ka, algo);
    beta = root.beta;
    residual = root.residual;
    iterations = root.iterations;
    converged = root.converged;
    stopReason = root.converged ? "root-converged" : "max-iterations";
    if (!converged) warnings.push("RR 根达到最大迭代次数仍未满足残差容差");
  }

  return assemble({
    input,
    activeIdx,
    nameOf,
    regime,
    beta,
    residual,
    iterations,
    converged,
    stopReason,
    warnings,
    temperatureC,
    pressureKpa,
  });
}

interface AssembleArgs {
  input: FlashInput;
  activeIdx: number[];
  nameOf: Map<number, string>;
  regime: PhaseRegime;
  beta: number;
  residual: number;
  iterations: number;
  converged: boolean;
  stopReason: StopReason;
  warnings: string[];
  temperatureC: number;
  pressureKpa: number;
}

function basisTotal(feed: PreparedFeed): number {
  // 归一化后基准总摩尔量为 1；否则使用（近似 1 的）原始总和
  return feed.normalized ? 1 : feed.rawSum;
}

function assemble(a: AssembleArgs): FlashResult {
  const { input, regime, beta, warnings } = a;
  const { feed, k } = input;
  const fTotal = basisTotal(feed);
  const present: Array<"liquid" | "vapor"> =
    regime === "all-liquid"
      ? ["liquid"]
      : regime === "all-vapor"
        ? ["vapor"]
        : ["liquid", "vapor"];
  const liquidExists = present.includes("liquid");
  const vaporExists = present.includes("vapor");
  const vMoles = beta * fTotal;
  const lMoles = (1 - beta) * fTotal;

  const components: FlashComponentResult[] = feed.componentIds.map((id, i) => {
    const zi = feed.z[i]!;
    const kv = k[i] ?? 1;
    let x: number | null = null;
    let y: number | null = null;
    let lm: number | null = null;
    let vm: number | null = null;
    if (feed.zero[i]) {
      if (liquidExists) x = 0;
      if (vaporExists) y = 0;
      lm = liquidExists ? 0 : null;
      vm = vaporExists ? 0 : null;
    } else if (regime === "all-liquid") {
      x = zi;
      lm = zi * fTotal;
    } else if (regime === "all-vapor") {
      y = zi;
      vm = zi * fTotal;
    } else {
      x = zi / (1 + beta * (kv - 1));
      y = kv * x;
      lm = x * lMoles;
      vm = y * vMoles;
    }
    return {
      componentId: id,
      name: a.nameOf.get(id) ?? `#${id}`,
      feedMoles: feed.rawMoles[i]!,
      z: zi,
      k: feed.zero[i] ? (k[i] ?? NaN) : kv,
      liquidMoles: lm,
      vaporMoles: vm,
      x,
      y,
    };
  });

  return {
    regime,
    beta,
    betaUnique: regime === "two-phase",
    phasesPresent: present,
    components,
    residual: a.residual,
    iterations: a.iterations,
    stopReason: a.stopReason,
    converged: a.converged,
    warnings,
    temperatureC: a.temperatureC,
    pressureKpa: a.pressureKpa,
    totalFeedMoles: feed.totalMoles,
    liquidMoles: liquidExists ? lMoles : null,
    vaporMoles: vaporExists ? vMoles : null,
  };
}

function buildDegenerate(
  input: FlashInput,
  activeIdx: number[],
  nameOf: Map<number, string>,
  warnings: string[],
): FlashResult {
  warnings.push(
    "所有有进料组分的 K=1，Rachford–Rice 对任意 beta 恒为零，汽化分率不唯一",
  );
  const { feed, k, temperatureC, pressureKpa } = input;
  const components: FlashComponentResult[] = feed.componentIds.map((id, i) => ({
    componentId: id,
    name: nameOf.get(id) ?? `#${id}`,
    feedMoles: feed.rawMoles[i]!,
    z: feed.z[i]!,
    k: feed.zero[i] ? (k[i] ?? NaN) : (k[i] ?? 1),
    liquidMoles: null,
    vaporMoles: null,
    x: null,
    y: null,
  }));
  void activeIdx;
  return {
    regime: "degenerate-k-all-one",
    beta: null,
    betaUnique: false,
    phasesPresent: [],
    components,
    residual: 0,
    iterations: 0,
    stopReason: "degenerate-k-all-one",
    converged: true,
    warnings,
    temperatureC,
    pressureKpa,
    totalFeedMoles: feed.totalMoles,
    liquidMoles: null,
    vaporMoles: null,
  };
}
