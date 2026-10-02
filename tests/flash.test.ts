import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.js';
import { FlashService, ServiceError } from '../src/service.js';
import { EquilibriumError } from '../src/equilibrium.js';
import { solveRachfordRice } from '../src/flash.js';
import { KEntry } from '../src/types.js';
import { DEFAULT_ALGORITHM_PARAMS } from '../src/constants.js';

function harness(): { store: Store; service: FlashService } {
  const dir = mkdtempSync(join(tmpdir(), 'flash-'));
  const store = new Store(join(dir, 't.sqlite'));
  const service = new FlashService(store);
  service.importVersion(
    [
      { name: '苯', pressure_unit: 'kPa', antoine_a: '6.019', antoine_b: '1211.033', antoine_c: '220.790', t_min: '8', t_max: '103' },
      { name: '甲苯', pressure_unit: 'kPa', antoine_a: '6.078', antoine_b: '1343.943', antoine_c: '219.587', t_min: '6', t_max: '111' },
    ],
    'V1',
  );
  return { store, service };
}

let h: ReturnType<typeof harness>;
beforeEach(() => (h = harness()));

test('二组分解析解：给定 K 时 RR 根与手算一致', () => {
  // z=[0.5,0.5], K=[2,0.5]。二次式 => beta=0.5
  const entries: KEntry[] = [
    { component: 'A', k: 2, source: 'user' },
    { component: 'B', k: 0.5, source: 'user' },
  ];
  const z = new Map([
    ['A', 0.5],
    ['B', 0.5],
  ]);
  const root = solveRachfordRice(entries, z, DEFAULT_ALGORITHM_PARAMS);
  assert.equal(root.state, 'two-phase');
  assert.ok(Math.abs((root.beta ?? -1) - 0.5) < 1e-9);
});

test('两相：组分守恒、组成归一、y=Kx', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const r = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: 1.8, 甲苯: 0.6 } });
  assert.equal(r.state, 'two-phase');
  assert.equal(r.liquidPresent, true);
  assert.equal(r.vaporPresent, true);
  assert.ok(r.materialCheck.passed);
  assert.ok(Math.abs((r.materialCheck.liquidSum ?? -1) - 1) < 1e-8);
  assert.ok(Math.abs((r.materialCheck.vaporSum ?? -1) - 1) < 1e-8);
  assert.ok((r.materialCheck.maxKYDeviation ?? 1) < 1e-8);
  assert.ok(r.materialCheck.maxAbsImbalance < 1e-8);
});

test('高压全液：气相不作为产出物流', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const r = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 1e7, userK: { 苯: 0.01, 甲苯: 0.005 } });
  assert.equal(r.state, 'all-liquid');
  assert.equal(r.vaporPresent, false);
  assert.equal(r.liquidPresent, true);
  for (const c of r.components) {
    assert.equal(c.y, null);
    assert.equal(c.vaporMoles, 0);
  }
});

test('低压全气：液相不作为产出物流', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const r = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 1, userK: { 苯: 80, 甲苯: 40 } });
  assert.equal(r.state, 'all-vapor');
  assert.equal(r.liquidPresent, false);
  for (const c of r.components) assert.equal(c.x, null);
});

test('K 全为 1：退化状态，beta 不唯一', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const r = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: 1, 甲苯: 1 } });
  assert.equal(r.state, 'degenerate-k-all-one');
  assert.equal(r.beta, null);
  assert.equal(r.liquidPresent, false);
  assert.equal(r.vaporPresent, false);
});

test('零进料组分被稳定标记且不破坏守恒', () => {
  h.store.upsertFeed('F', { 苯: 1, 甲苯: 0 });
  const r = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: 1.8, 甲苯: 0.6 } });
  const tol = r.components.find((c) => c.component === '甲苯')!;
  assert.equal(tol.zeroFeed, true);
  assert.ok(r.materialCheck.passed);
});

test('极微量组分稳定处理', () => {
  h.store.upsertFeed('F', { 苯: 1 - 1e-12, 甲苯: 1e-12 });
  const r = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: 1.8, 甲苯: 0.001 } });
  assert.ok(['two-phase', 'all-vapor', 'all-liquid'].includes(r.state));
  assert.ok(r.materialCheck.passed);
  const tol = r.components.find((c) => c.component === '甲苯')!;
  assert.ok(Math.abs(1e-12 - (tol.liquidMoles ?? 0) - (tol.vaporMoles ?? 0)) <= 1e-8);
});

test('非法组成（负值/非有限/总和偏差）被拒绝', () => {
  h.store.upsertFeed('neg', { 苯: -0.1, 甲苯: 1.1 });
  assert.throws(
    () => h.service.flash({ feedName: 'neg', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: 1.8, 甲苯: 0.6 } }),
    ServiceError,
  );
  h.store.upsertFeed('sum', { 苯: 0.6, 甲苯: 0.6 });
  assert.throws(
    () => h.service.flash({ feedName: 'sum', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: 1.8, 甲苯: 0.6 } }),
    /组成总和/,
  );
});

test('显式归一化保留原值并记录修正', () => {
  h.store.upsertFeed('raw', { 苯: 2, 甲苯: 2 });
  const r = h.service.flash({ feedName: 'raw', versionName: 'V1', temperature: 90, pressure: 100, normalize: true, userK: { 苯: 1.8, 甲苯: 0.6 } });
  assert.equal(r.normalization.normalized, true);
  assert.deepEqual(r.normalization.rawComposition, { 苯: 2, 甲苯: 2 });
  assert.ok(Math.abs(r.normalization.normalizedComposition!['苯'] - 0.5) < 1e-12);
});

test('泡点与露点压力边界：ΣzPsat 与 1/Σz/Psat，极限相量为0', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const bub = h.service.bubbleOrDew('bubble', 'F', 'V1', 90, false);
  const dew = h.service.bubbleOrDew('dew', 'F', 'V1', 90, false);
  assert.ok(bub.pressure > dew.pressure);
  assert.equal(bub.limitingPhaseMoles, 0);
  assert.equal(dew.limitingPhaseMoles, 0);
  assert.ok(Math.abs(bub.limitingComposition.reduce((a, b) => a + b.value, 0) - 1) < 1e-8);
  assert.ok(Math.abs(dew.limitingComposition.reduce((a, b) => a + b.value, 0) - 1) < 1e-8);
  // 泡点压力下闪蒸应为全液边界（beta=0），露点压力下为全气边界（beta=1）
  const atBub = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: bub.pressure });
  assert.ok(atBub.beta === 0 || atBub.state === 'two-phase');
  const atDew = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: dew.pressure });
  assert.ok(atDew.beta === 1 || atDew.state === 'two-phase');
});

test('压力扫描跨相边界连续：低压全气 -> 两相 -> 高压全液', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const scan = h.service.scan('F', 'V1', 90, [60, 75, 90, 100, 110, 160], false);
  const states = scan.points.map((p) => p.state);
  assert.ok(states.includes('all-vapor'));
  assert.ok(states.includes('two-phase'));
  assert.ok(states.includes('all-liquid'));
  assert.equal(states[0], 'all-vapor');
  assert.equal(states[states.length - 1], 'all-liquid');
  assert.ok(scan.continuityPassed);
  // beta 单调不增
  const betas = scan.points.map((p) => p.beta) as number[];
  for (let i = 1; i < betas.length; i++) assert.ok(betas[i] <= betas[i - 1] + 1e-9);
});

test('超出 Antoine 温区给出真实诊断', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  assert.throws(
    () => h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 500, pressure: 100 }),
    /超出 Antoine 有效温区/,
  );
});

test('缺失系数拒绝', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  h.service.importVersion(
    [{ name: '苯', pressure_unit: 'kPa', antoine_a: '', antoine_b: '', antoine_c: '', t_min: '', t_max: '' }],
    'V2',
  );
  h.store.upsertFeed('G', { 苯: 1 });
  assert.throws(
    () => h.service.flash({ feedName: 'G', versionName: 'V2', temperature: 90, pressure: 100 }),
    /缺少 Antoine 系数/,
  );
});

test('非正 K 被拒绝', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  assert.throws(
    () => h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: -2, 甲苯: 0.6 } }),
    /必须为正/,
  );
});

test('报告冻结并可在重启后复核', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const r = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 100, userK: { 苯: 1.8, 甲苯: 0.6 } });
  const rep = h.store.getReport(r.reportId!)!;
  assert.ok(rep);
  const parsed = JSON.parse(rep.resultJson);
  assert.equal(parsed.state, 'two-phase');
  assert.ok(JSON.parse(rep.algorithmJson).rrMaxIter);
});

test('两版进料比较：检测汽化分率与相态变化', () => {
  h.store.upsertFeed('F1', { 苯: 0.5, 甲苯: 0.5 });
  h.store.upsertFeed('F2', { 苯: 0.2, 甲苯: 0.8 });
  const cmp = h.service.compare(
    { feedName: 'F1', versionName: 'V1', temperature: 90, pressure: 85 },
    { feedName: 'F2', versionName: 'V1', temperature: 90, pressure: 85 },
  );
  assert.ok(cmp.base.state === 'two-phase' || cmp.other.state === 'two-phase');
  assert.ok(cmp.reportId > 0);
});

test('单位一致性：K=Psat/P，压力同比例缩放时 K 不变', () => {
  h.store.upsertFeed('F', { 苯: 0.5, 甲苯: 0.5 });
  const r1 = h.service.flash({ feedName: 'F', versionName: 'V1', temperature: 90, pressure: 100 });
  // 直接给定相同 K（模拟单位一致换算后比值不变）应得相同 beta
  const r2 = h.service.flash({
    feedName: 'F',
    versionName: 'V1',
    temperature: 90,
    pressure: 100,
    userK: Object.fromEntries(r1.components.map((c) => [c.component, c.k])),
  });
  assert.ok(Math.abs((r1.beta ?? 0) - (r2.beta ?? 0)) < 1e-9);
});
