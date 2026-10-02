import {
  AlgoParams,
  ComponentDef,
  FlashResult,
  ValidationError,
} from "./common";
import { PreparedFeed } from "./feed";
import { antoinePsatKpa } from "./properties";
import { flash } from "./flash";

export interface PsatEntry {
  componentId: number;
  name: string;
  psatKpa: number | null;
  zero: boolean;
}

/** 计算所有组分在指定温度下的饱和蒸气压；有进料而越界/缺系数时拒绝。 */
export function computePsats(
  components: ComponentDef[],
  feed: PreparedFeed,
  temperatureC: number,
): PsatEntry[] {
  return feed.componentIds.map((id, i) => {
    const comp = components.find((c) => c.id === id);
    if (!comp) throw new ValidationError(`组分 id=${id} 在物性库中不存在`);
    if (feed.zero[i]) {
      return { componentId: id, name: comp.name, psatKpa: null, zero: true };
    }
    if (!comp.antoine) {
      throw new ValidationError(`组分 ${comp.name} 缺少 Antoine 系数，无法计算泡露点`);
    }
    return {
      componentId: id,
      name: comp.name,
      psatKpa: antoinePsatKpa(comp.antoine, temperatureC),
      zero: false,
    };
  });
}

export interface BubbleDewResult {
  temperatureC: number;
  bubblePressureKpa: number;
  dewPressureKpa: number;
  /** 泡点处极限气相组成 y_i = z_i Psat_i/Pbub */
  bubbleVaporY: { componentId: number; name: string; y: number | null }[];
  /** 露点处极限液相组成 x_i = z_i Pdew/Psat_i */
  dewLiquidX: { componentId: number; name: string; x: number | null }[];
  note: string;
}

export function bubbleDewPressure(
  components: ComponentDef[],
  feed: PreparedFeed,
  temperatureC: number,
): BubbleDewResult {
  const psats = computePsats(components, feed, temperatureC);
  let pbub = 0;
  let invPdew = 0;
  for (let i = 0; i < psats.length; i++) {
    const e = psats[i]!;
    if (e.zero) continue;
    const z = feed.z[i]!;
    pbub += z * e.psatKpa!;
    invPdew += z / e.psatKpa!;
  }
  if (!(pbub > 0) || !(invPdew > 0)) {
    throw new ValidationError("泡点/露点压力计算失败：缺少有效的有进料组分");
  }
  const pdew = 1 / invPdew;
  return {
    temperatureC,
    bubblePressureKpa: pbub,
    dewPressureKpa: pdew,
    bubbleVaporY: psats.map((e, i) => ({
      componentId: e.componentId,
      name: e.name,
      y: e.zero ? null : (feed.z[i]! * e.psatKpa!) / pbub,
    })),
    dewLiquidX: psats.map((e, i) => ({
      componentId: e.componentId,
      name: e.name,
      x: e.zero ? null : (feed.z[i]! * pdew) / e.psatKpa!,
    })),
    note: "泡点处液相为实际存在相、气相为极限相；露点处气相为实际存在相、液相为极限相",
  };
}

export interface ScanPoint {
  pressureKpa: number;
  result: FlashResult;
}

/** 一系列压力下的相态扫描；每个压力独立由 Antoine+Raoult 求 K。 */
export function pressureScan(
  components: ComponentDef[],
  feed: PreparedFeed,
  temperatureC: number,
  pressuresKpa: number[],
  algo: AlgoParams,
): ScanPoint[] {
  const psats = computePsats(components, feed, temperatureC);
  return pressuresKpa.map((p) => {
    if (!(p > 0)) throw new ValidationError("扫描压力必须为正（kPa）");
    const k = psats.map((e) => (e.zero ? null : e.psatKpa! / p));
    const result = flash({
      components,
      feed,
      k,
      temperatureC,
      pressureKpa: p,
      algo,
    });
    return { pressureKpa: p, result };
  });
}
