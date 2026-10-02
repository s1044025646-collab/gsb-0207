import { Component, KEntry } from './types.js';
import { K_MIN } from './constants.js';

export class EquilibriumError extends Error {}

/**
 * Antoine 饱和蒸气压（10 为底）：log10(Psat) = A - B/(T+C)，T 单位 °C。
 * 系数缺失或温度超出闭区间 [Tmin,Tmax] 时拒绝（抛出真实诊断）。
 */
export function antoinePsat(component: Component, temperatureC: number): number {
  const { name, antoineA: A, antoineB: B, antoineC: C, tMin, tMax } = component;
  if (A === null || B === null || C === null || tMin === null || tMax === null) {
    throw new EquilibriumError(
      `组分 ${name} 缺少 Antoine 系数或温区，无法在 T=${temperatureC}°C 计算饱和蒸气压`,
    );
  }
  if (!Number.isFinite(temperatureC)) {
    throw new EquilibriumError(`组分 ${name}：温度不是有限数`);
  }
  if (temperatureC < tMin || temperatureC > tMax) {
    throw new EquilibriumError(
      `组分 ${name} 的温度 ${temperatureC}°C 超出 Antoine 有效温区 [${tMin}, ${tMax}]°C`,
    );
  }
  const denom = temperatureC + C;
  if (denom === 0) {
    throw new EquilibriumError(`组分 ${name}：T+C=0，Antoine 方程奇异`);
  }
  const psat = Math.pow(10, A - B / denom);
  if (!Number.isFinite(psat) || psat <= 0) {
    throw new EquilibriumError(`组分 ${name}：计算得到非正/非有限饱和蒸气压 ${psat}`);
  }
  return psat;
}

/**
 * 构造每个进料组分的平衡常数。
 * 优先使用用户直接给定的正 K；其余组分按 Raoult 定律 K=Psat(T)/P，
 * 要求压力为正，且组分压力单位与总压单位一致（K 为比值，单位相消）。
 */
export function buildK(
  feedOrder: string[],
  componentsByName: Map<string, Component>,
  temperatureC: number,
  pressure: number | null | undefined,
  userK: Record<string, number> | null | undefined,
  pressureUnit: string,
): { entries: KEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const entries: KEntry[] = [];

  for (const name of feedOrder) {
    const comp = componentsByName.get(name);
    if (!comp) throw new EquilibriumError(`进料组分 ${name} 在物性版本中不存在`);

    if (userK && Object.prototype.hasOwnProperty.call(userK, name)) {
      const k = userK[name];
      if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) {
        throw new EquilibriumError(`组分 ${name} 直接给定的 K 必须为正的有限数，收到 ${k}`);
      }
      if (k < K_MIN) throw new EquilibriumError(`组分 ${name} 的 K=${k} 低于数值下限 ${K_MIN}`);
      entries.push({ component: name, k, source: 'user', psat: null });
      continue;
    }

    // Raoult 路径
    if (pressure === null || pressure === undefined || !Number.isFinite(pressure) || pressure <= 0) {
      throw new EquilibriumError(
        `组分 ${name} 未直接给定 K，按 Raoult 定律需要正的总压，收到 P=${pressure} ${pressureUnit}`,
      );
    }
    if (comp.pressureUnit !== pressureUnit) {
      throw new EquilibriumError(
        `组分 ${name} 的压力单位 ${comp.pressureUnit} 与总压单位 ${pressureUnit} 不一致，不能相消`,
      );
    }
    const psat = antoinePsat(comp, temperatureC);
    const k = psat / pressure;
    if (!Number.isFinite(k) || k <= 0 || k < K_MIN) {
      throw new EquilibriumError(`组分 ${name} 导出 K=${k} 非法（Psat=${psat}, P=${pressure}）`);
    }
    entries.push({ component: name, k, source: 'raoult', psat });
  }

  return { entries, warnings };
}

/** 计算定温泡点压力：P_bub = Σ z_i Psat_i（边界上液相 x=z，极限气相 y=Kx）。 */
export function bubblePressure(
  z: Array<{ name: string; z: number }>,
  componentsByName: Map<string, Component>,
  temperatureC: number,
  pressureUnit: string,
): { pressure: number; y: Map<string, number>; psats: Map<string, number> } {
  let p = 0;
  const psats = new Map<string, number>();
  for (const { name, z: zi } of z) {
    const comp = componentsByName.get(name);
    if (!comp) throw new EquilibriumError(`进料组分 ${name} 在物性版本中不存在`);
    if (comp.pressureUnit !== pressureUnit) {
      throw new EquilibriumError(`组分 ${name} 压力单位 ${comp.pressureUnit} 与请求单位 ${pressureUnit} 不一致`);
    }
    const ps = zi > 0 ? antoinePsat(comp, temperatureC) : 0;
    psats.set(name, ps);
    p += zi * ps;
  }
  if (!(p > 0) || !Number.isFinite(p)) {
    throw new EquilibriumError(`泡点压力 ${p} 非正或非有限（可能全部为零进料）`);
  }
  const y = new Map<string, number>();
  for (const { name, z: zi } of z) {
    const ps = psats.get(name)!;
    y.set(name, zi > 0 ? (zi * ps) / p : 0);
  }
  return { pressure: p, y, psats };
}

/** 计算定温露点压力：P_dew = 1 / Σ z_i/Psat_i（边界上气相 y=z，极限液相 x=(y/K)）。 */
export function dewPressure(
  z: Array<{ name: string; z: number }>,
  componentsByName: Map<string, Component>,
  temperatureC: number,
  pressureUnit: string,
): { pressure: number; x: Map<string, number>; psats: Map<string, number> } {
  let inv = 0;
  const psats = new Map<string, number>();
  for (const { name, z: zi } of z) {
    const comp = componentsByName.get(name);
    if (!comp) throw new EquilibriumError(`进料组分 ${name} 在物性版本中不存在`);
    if (comp.pressureUnit !== pressureUnit) {
      throw new EquilibriumError(`组分 ${name} 压力单位 ${comp.pressureUnit} 与请求单位 ${pressureUnit} 不一致`);
    }
    // 零进料组分不参与求和；但其 Psat 若被请求仍需在温区内。
    const ps = antoinePsat(comp, temperatureC);
    psats.set(name, ps);
    if (zi > 0) {
      if (!(ps > 0)) throw new EquilibriumError(`组分 ${name} Psat=${ps} 非正`);
      inv += zi / ps;
    }
  }
  if (!(inv > 0) || !Number.isFinite(inv)) {
    throw new EquilibriumError(`露点压力倒数和 ${inv} 非正（可能全部为零进料）`);
  }
  const p = 1 / inv;
  const x = new Map<string, number>();
  for (const { name, z: zi } of z) {
    const ps = psats.get(name)!;
    x.set(name, zi > 0 ? (zi * p) / ps : 0);
  }
  return { pressure: p, x, psats };
}
