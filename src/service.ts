import { Store } from './db.js';
import { EquilibriumError, bubblePressure, buildK, dewPressure } from './equilibrium.js';
import { assembleFlash, solveRachfordRice } from './flash.js';
import { prepareComposition } from './validation.js';
import { toCsv, parseCsv } from './serialization.js';
import { AlgorithmParams, DEFAULT_ALGORITHM_PARAMS, DEFAULT_PRESSURE_UNIT } from './constants.js';
import {
  BubbleDewResult,
  Component,
  FlashRequest,
  FlashResult,
  ScanResult,
  ScanPoint,
} from './types.js';
import { readFileSync } from 'node:fs';

export class ServiceError extends Error {}

export class FlashService {
  constructor(private store: Store, private params: AlgorithmParams = DEFAULT_ALGORITHM_PARAMS) {}

  importVersionFromCsv(path: string, versionName: string, note: string | null = null): { versionId: number; count: number } {
    const rows = parseCsv(readFileSync(path, 'utf8'));
    return this.importVersion(rows, versionName, note);
  }

  importVersion(
    rows: Array<Record<string, string>>,
    versionName: string,
    note: string | null = null,
  ): { versionId: number; count: number } {
    if (this.store.getVersion(versionName)) throw new ServiceError(`物性版本 ${versionName} 已存在`);
    const versionId = this.store.createVersion(versionName, note);
    let count = 0;
    for (const row of rows) {
      const name = (row.name ?? row['组分'] ?? '').trim();
      if (!name) continue;
      const num = (v: string): number | null => (v === undefined || v.trim() === '' ? null : Number(v));
      const c: Component = {
        id: null,
        name,
        cas: row.cas?.trim() || null,
        pressureUnit: (row.pressure_unit ?? row.pressureUnit ?? DEFAULT_PRESSURE_UNIT).trim(),
        antoineA: num(row.antoine_a ?? row.A ?? ''),
        antoineB: num(row.antoine_b ?? row.B ?? ''),
        antoineC: num(row.antoine_c ?? row.C ?? ''),
        tMin: num(row.t_min ?? row.Tmin ?? ''),
        tMax: num(row.t_max ?? row.Tmax ?? ''),
      };
      const coeffs = [c.antoineA, c.antoineB, c.antoineC, c.tMin, c.tMax];
      const allNull = coeffs.every((v) => v === null);
      const someNull = coeffs.some((v) => v === null);
      if (!allNull && someNull) {
        throw new ServiceError(`组分 ${name} 的 Antoine 系数/温区必须全部提供或全部留空`);
      }
      this.store.addComponent(versionId, c);
      count++;
    }
    if (count === 0) throw new ServiceError('CSV 中没有有效组分行');
    return { versionId, count };
  }

  importFeedFromCsv(path: string, feedName: string): { feedId: number; count: number } {
    const rows = parseCsv(readFileSync(path, 'utf8'));
    return this.importFeed(rows, feedName);
  }

  importFeed(rows: Array<Record<string, string>>, feedName: string): { feedId: number; count: number } {
    const comp: Record<string, number> = {};
    for (const row of rows) {
      const name = (row.component ?? row.name ?? row['组分'] ?? '').trim();
      if (!name) continue;
      const z = Number(row.z ?? row.mole_fraction ?? row['摩尔分率']);
      comp[name] = z;
    }
    if (Object.keys(comp).length === 0) throw new ServiceError('CSV 中没有有效进料行');
    const feedId = this.store.upsertFeed(feedName, comp, 1);
    return { feedId, count: Object.keys(comp).length };
  }

  /** 准备进料：校验，按需归一化，返回与物性版本对齐的有序组分列表。 */
  private prepare(req: FlashRequest, pressureUnit: string) {
    const version = this.store.getVersion(req.versionName);
    if (!version) throw new ServiceError(`物性版本 ${req.versionName} 不存在`);
    const feed = this.store.getFeed(req.feedName);
    if (!feed) throw new ServiceError(`进料 ${req.feedName} 不存在`);

    const { check, record, usable } = prepareComposition(feed.composition, req.normalize === true);
    if (!usable) throw new ServiceError(`组成校验失败：${check.errors.join('；')}${req.normalize ? '' : '（如需修正请显式选择归一化）'}`);

    const components = this.store.getComponents(version.rowId);
    const byName = new Map(components.map((c) => [c.name, c]));
    for (const name of Object.keys(usable)) {
      if (!byName.has(name)) throw new ServiceError(`进料组分 ${name} 不在物性版本 ${req.versionName} 中`);
    }
    const order = components.map((c) => c.name).filter((n) => Object.prototype.hasOwnProperty.call(usable!, n));
    const zMap = new Map(order.map((n) => [n, usable![n]]));

    const { entries, warnings } = buildK(order, byName, req.temperature, req.pressure ?? null, req.userK ?? null, pressureUnit);
    const kSource = entries.some((e) => e.source === 'raoult') && entries.some((e) => e.source === 'user')
      ? 'raoult'
      : entries[0]?.source ?? 'raoult';
    return { version, feed, order, zMap, byName, entries, warnings, normalization: record, mixedSource: kSource };
  }

  flash(req: FlashRequest, pressureUnit = DEFAULT_PRESSURE_UNIT, save = true): FlashResult & { reportId?: number } {
    const prep = this.prepare(req, pressureUnit);
    const root = solveRachfordRice(prep.entries, prep.zMap, this.params);
    const result = assembleFlash(
      prep.entries,
      prep.zMap,
      root,
      req.temperature,
      req.pressure ?? null,
      pressureUnit,
      prep.mixedSource,
      prep.normalization,
      prep.warnings,
      this.params,
    );
    if (save) {
      const reportId = this.store.saveReport('flash', prep.feed.rowId, prep.version.rowId, req, result, this.params);
      return { ...result, reportId };
    }
    return result;
  }

  bubbleOrDew(
    kind: 'bubble' | 'dew',
    feedName: string,
    versionName: string,
    temperature: number,
    normalize: boolean,
    pressureUnit = DEFAULT_PRESSURE_UNIT,
  ): BubbleDewResult & { reportId: number } {
    const version = this.store.getVersion(versionName);
    if (!version) throw new ServiceError(`物性版本 ${versionName} 不存在`);
    const feed = this.store.getFeed(feedName);
    if (!feed) throw new ServiceError(`进料 ${feedName} 不存在`);
    const { check, record, usable } = prepareComposition(feed.composition, normalize);
    if (!usable) throw new ServiceError(`组成校验失败：${check.errors.join('；')}`);

    const components = this.store.getComponents(version.rowId);
    const byName = new Map(components.map((c) => [c.name, c]));
    const zArr = components
      .filter((c) => Object.prototype.hasOwnProperty.call(usable!, c.name))
      .map((c) => ({ name: c.name, z: usable![c.name] }));

    const warnings: string[] = [];
    if (record.normalized) warnings.push(record.reason ?? '已按用户选择归一化');

    let result: BubbleDewResult;
    if (kind === 'bubble') {
      const { pressure, y } = bubblePressure(zArr, byName, temperature, pressureUnit);
      const limitingComposition = zArr.map(({ name }) => ({ component: name, value: y.get(name) ?? 0 }));
      const existingComposition = zArr.map(({ name, z }) => ({ component: name, value: z }));
      const ysum = limitingComposition.reduce((a, b) => a + b.value, 0);
      const converged = Math.abs(ysum - 1) <= this.params.phaseSumTol;
      result = {
        kind,
        pressure,
        pressureUnit,
        temperature,
        temperatureUnit: '°C',
        limitingPhase: 'vapor',
        limitingComposition,
        existingPhase: 'liquid',
        existingComposition,
        limitingPhaseMoles: 0,
        residual: ysum - 1,
        converged,
        warnings,
      };
    } else {
      const { pressure, x } = dewPressure(zArr, byName, temperature, pressureUnit);
      const limitingComposition = zArr.map(({ name }) => ({ component: name, value: x.get(name) ?? 0 }));
      const existingComposition = zArr.map(({ name, z }) => ({ component: name, value: z }));
      const xsum = limitingComposition.reduce((a, b) => a + b.value, 0);
      const converged = Math.abs(xsum - 1) <= this.params.phaseSumTol;
      result = {
        kind,
        pressure,
        pressureUnit,
        temperature,
        temperatureUnit: '°C',
        limitingPhase: 'liquid',
        limitingComposition,
        existingPhase: 'vapor',
        existingComposition,
        limitingPhaseMoles: 0,
        residual: xsum - 1,
        converged,
        warnings,
      };
    }

    const reportId = this.store.saveReport(
      kind,
      feed.rowId,
      version.rowId,
      { feedName, versionName, temperature, normalize, pressureUnit },
      result,
      this.params,
    );
    return { ...result, reportId };
  }

  /**
   * 定温压力扫描。先算泡/露点压力作为相边界，再在各压力点闪蒸。
   * 物理序：P < P_dew 全气；P_dew < P < P_bub 两相；P > P_bub 全液
   * （对理想体系通常 P_dew <= P_bub）。
   */
  scan(
    feedName: string,
    versionName: string,
    temperature: number,
    pressures: number[],
    normalize: boolean,
    pressureUnit = DEFAULT_PRESSURE_UNIT,
  ): ScanResult & { reportId: number } {
    let pBub: number | null = null;
    let pDew: number | null = null;
    const warnings: string[] = [];
    try {
      pBub = this.bubbleOrDew('bubble', feedName, versionName, temperature, normalize, pressureUnit).pressure;
    } catch (e) {
      warnings.push(`泡点压力不可用：${(e as Error).message}`);
    }
    try {
      pDew = this.bubbleOrDew('dew', feedName, versionName, temperature, normalize, pressureUnit).pressure;
    } catch (e) {
      warnings.push(`露点压力不可用：${(e as Error).message}`);
    }

    const points: ScanPoint[] = pressures.map((p) => {
      const r = this.flash(
        { feedName, versionName, temperature, pressure: p, normalize },
        pressureUnit,
        false,
      );
      return { pressure: p, state: r.state, beta: r.beta, converged: r.converged, residual: r.residual };
    });

    // 连续性核验：定温升压时汽化分率 beta 必须单调不增（含在边界处连续到 0/1）。
    // 粗压力网格下两相区内 beta 可以有较大变化，因此不以相邻跳变幅度判据，而以单调性为准。
    let maxJump: number | null = null;
    let continuity = true;
    for (let i = 1; i < points.length; i++) {
      const b1 = points[i - 1].beta;
      const b2 = points[i].beta;
      if (b1 === null || b2 === null) {
        continuity = false;
        continue;
      }
      const jump = Math.abs(b2 - b1);
      maxJump = maxJump === null ? jump : Math.max(maxJump, jump);
      if (b2 > b1 + this.params.phaseSumTol) continuity = false;
    }

    const result: ScanResult = {
      temperature,
      pressureUnit,
      bubblePressure: pBub,
      dewPressure: pDew,
      points,
      continuityMaxJump: maxJump,
      continuityPassed: continuity,
    };
    const feed = this.store.getFeed(feedName)!;
    const version = this.store.getVersion(versionName)!;
    const reportId = this.store.saveReport('scan', feed.rowId, version.rowId, {
      feedName, versionName, temperature, pressures, normalize, pressureUnit,
    }, result, this.params);
    return { ...result, reportId };
  }

  /** 比较两版物性或两版进料：同温同压分别闪蒸并汇总差异。 */
  compare(
    base: FlashRequest,
    other: FlashRequest,
    pressureUnit = DEFAULT_PRESSURE_UNIT,
  ): { base: FlashResult; other: FlashResult; deltaBeta: number | null; stateChanged: boolean; reportId: number } {
    const a = this.flash(base, pressureUnit, false);
    const b = this.flash(other, pressureUnit, false);
    const deltaBeta = a.beta === null || b.beta === null ? null : b.beta - a.beta;
    const reportId = this.store.saveReport('compare', null, null, { base, other, pressureUnit }, { base: a, other: b }, this.params);
    return { base: a, other: b, deltaBeta, stateChanged: a.state !== b.state, reportId };
  }

  /** 导出闪蒸明细表（组分级）为 CSV。 */
  flashToCsv(result: FlashResult): string {
    return toCsv(
      result.components.map((c) => ({
        component: c.component,
        z: c.z,
        k: c.k,
        x: c.x,
        y: c.y,
        liquid_moles: c.liquidMoles,
        vapor_moles: c.vaporMoles,
        zero_feed: c.zeroFeed ? 1 : 0,
      })),
    );
  }

  scanToCsv(scan: ScanResult): string {
    return toCsv(scan.points.map((p) => ({ pressure: p.pressure, state: p.state, beta: p.beta, converged: p.converged ? 1 : 0, residual: p.residual })));
  }
}

export { EquilibriumError };
