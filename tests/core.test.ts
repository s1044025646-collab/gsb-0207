import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_ALGO, ValidationError, MMHG_TO_KPA } from "../src/common.ts";
import { prepareFeed } from "../src/feed.ts";
import { antoinePsatKpa, raoultK, resolveK } from "../src/properties.ts";
import { flash } from "../src/flash.ts";
import { verifyBalance } from "../src/balance.ts";
import { bubbleDewPressure } from "../src/bubble.ts";
import type { ComponentDef } from "../src/common.ts";

const comps: ComponentDef[] = [
  { id: 1, name: "A", antoine: { a: 6.9, b: 1200, c: 220, tMinC: 0, tMaxC: 120 } },
  { id: 2, name: "B", antoine: { a: 7.0, b: 1340, c: 219, tMinC: 0, tMaxC: 150 } },
];

function run(k: (number | null)[], moles = [0.5, 0.5]) {
  const feed = prepareFeed(
    moles.map((m, i) => ({ componentId: i + 1, moles: m })),
    DEFAULT_ALGO,
    false,
  );
  return flash({
    components: comps,
    feed,
    k,
    temperatureC: 90,
    pressureKpa: 100,
    algo: DEFAULT_ALGO,
  });
}

test("二组分解析解：给定 z 与 K 直接核对 beta 闭式根", () => {
  // z=(0.5,0.5), K1=2.5, K2=0.5
  // RR: .5*1.5/(1+1.5b) + .5*(-.5)/(1-.5b)=0
  // 解析根 beta=0.5（代入：0.75/1.75 - 0.25/0.75 = 0.428571-0.333333 != 0，改为推导）
  const z1 = 0.5, k1 = 2.5, k2 = 0.5;
  // 0 = z1(k1-1)/(1+(k1-1)b) + (1-z1)(k2-1)/(1+(k2-1)b)
  // 乘开: 0.75(1-0.5b) - 0.25(1+1.5b) = 0 => 0.75-0.375b-0.25-0.375b=0 => b=0.5/0.75
  const betaExact = 0.5 / 0.75;
  const res = run([k1, k2]);
  assert.equal(res.regime, "two-phase");
  assert.ok(Math.abs(res.beta! - betaExact) < 1e-9, `beta=${res.beta}`);
  assert.ok(res.residual! < DEFAULT_ALGO.rrResidualTol);
  assert.equal(res.stopReason, "root-converged");
  void z1;
});

test("两相时 y=Kx、守恒、两相组成归一", () => {
  const res = run([2.5, 0.5]);
  for (const c of res.components) {
    assert.ok(Math.abs(c.y! - c.k * c.x!) < 1e-9);
    assert.ok(Math.abs((c.liquidMoles ?? 0) + (c.vaporMoles ?? 0) - c.feedMoles) < 1e-10);
  }
  const sx = res.components.reduce((a, c) => a + c.x!, 0);
  const sy = res.components.reduce((a, c) => a + c.y!, 0);
  assert.ok(Math.abs(sx - 1) < 1e-9 && Math.abs(sy - 1) < 1e-9);
  const bal = verifyBalance(res, DEFAULT_ALGO);
  assert.ok(bal.passed, JSON.stringify(bal, null, 2));
});

test("全液：所有 K<1，beta=0，气相不作为存在相产出", () => {
  const res = run([0.8, 0.6]);
  assert.equal(res.regime, "all-liquid");
  assert.equal(res.beta, 0);
  assert.deepEqual(res.phasesPresent, ["liquid"]);
  assert.equal(res.vaporMoles, null);
  for (const c of res.components) {
    assert.equal(c.y, null);
    assert.equal(c.vaporMoles, null);
  }
});

test("全气：所有 K>1，beta=1，液相不作为存在相产出", () => {
  const res = run([1.5, 2.2]);
  assert.equal(res.regime, "all-vapor");
  assert.equal(res.beta, 1);
  assert.deepEqual(res.phasesPresent, ["vapor"]);
  assert.equal(res.liquidMoles, null);
  for (const c of res.components) assert.equal(c.x, null);
});

test("K 全为 1：退化状态，beta=null 且不唯一", () => {
  const res = run([1, 1]);
  assert.equal(res.regime, "degenerate-k-all-one");
  assert.equal(res.beta, null);
  assert.equal(res.betaUnique, false);
  assert.equal(res.phasesPresent.length, 0);
  assert.throws(() => verifyBalance(res, DEFAULT_ALGO), ValidationError);
});

test("K 接近 1 稳定处理（不触发退化，正常求根）", () => {
  const comps3: ComponentDef[] = [...comps, { id: 3, name: "C", antoine: comps[0]!.antoine }];
  const feed = prepareFeed(
    [
      { componentId: 1, moles: 0.4 },
      { componentId: 2, moles: 0.3 },
      { componentId: 3, moles: 0.3 },
    ],
    DEFAULT_ALGO,
    false,
  );
  const res = flash({
    components: comps3,
    feed,
    k: [2.5, 0.5, 1 + 1e-7],
    temperatureC: 90,
    pressureKpa: 100,
    algo: DEFAULT_ALGO,
  });
  assert.equal(res.regime, "two-phase");
  assert.ok(res.warnings.some((w) => w.includes("K 接近但不等于 1")));
});

test("零进料组分不参与且不要求 K，有进料组分缺 K 被拒绝", () => {
  const feed = prepareFeed(
    [
      { componentId: 1, moles: 1.0 },
      { componentId: 2, moles: 0 },
    ],
    DEFAULT_ALGO,
    false,
  );
  const res = flash({
    components: comps,
    feed,
    k: [1.5, null],
    temperatureC: 90,
    pressureKpa: 100,
    algo: DEFAULT_ALGO,
  });
  assert.equal(res.components[1]!.liquidMoles, null);
  assert.equal(res.components[1]!.vaporMoles, 0);
  assert.equal(res.regime, "all-vapor");

  const feed2 = prepareFeed(
    [{ componentId: 1, moles: 1.0 }],
    DEFAULT_ALGO,
    false,
  );
  assert.throws(
    () =>
      flash({
        components: comps,
        feed: feed2,
        k: [null],
        temperatureC: 90,
        pressureKpa: 100,
        algo: DEFAULT_ALGO,
      }),
    ValidationError,
  );
});

test("非法组成：负值/非有限/总和不为一/全零", () => {
  assert.throws(() => prepareFeed([{ componentId: 1, moles: -0.1 }], DEFAULT_ALGO, false), ValidationError);
  assert.throws(() => prepareFeed([{ componentId: 1, moles: NaN }], DEFAULT_ALGO, false), ValidationError);
  assert.throws(
    () => prepareFeed([{ componentId: 1, moles: 0.6 }, { componentId: 2, moles: 0.6 }], DEFAULT_ALGO, false),
    ValidationError,
  );
  assert.throws(() => prepareFeed([{ componentId: 1, moles: 0 }], DEFAULT_ALGO, false), ValidationError);
});

test("显式归一化：保留原值与修正记录", () => {
  const pf = prepareFeed(
    [
      { componentId: 1, moles: 2 },
      { componentId: 2, moles: 3 },
    ],
    DEFAULT_ALGO,
    true,
  );
  assert.equal(pf.normalized, true);
  assert.ok(Math.abs(pf.z[0]! - 0.4) < 1e-12);
  assert.equal(pf.corrections.length, 2);
  assert.equal(pf.corrections[0]!.raw, 2);
});

test("极微量组分稳定", () => {
  const res = run([2.5, 0.5], [0.999999999999, 1e-12]);
  assert.ok(["two-phase", "all-vapor"].includes(res.regime));
});

test("Antoine 越界与缺系数拒绝；单位换算一致", () => {
  const coeff = comps[0]!.antoine!;
  assert.throws(() => antoinePsatKpa(coeff, 200), ValidationError);
  assert.throws(() => antoinePsatKpa(coeff, -10), ValidationError);
  assert.throws(
    () => resolveK({ antoine: null, temperatureC: 90, pressureKpa: 100, hasFeed: true }),
    ValidationError,
  );
  // 760 mmHg = 101.325 kPa：用苯类系数在某温度不直接成立，改验换算常数与 Raoult
  assert.ok(Math.abs(760 * MMHG_TO_KPA - 101.325) < 1e-10);
  const k = raoultK(50, 100);
  assert.equal(k, 0.5);
  assert.throws(() => raoultK(50, 0), ValidationError);
  assert.throws(() => resolveK({ directK: -1, temperatureC: 90, pressureKpa: 100, hasFeed: true }), ValidationError);
});

test("泡点/露点边界：在计算压力处回退到单相端点，极限相不被包装成产物", () => {
  const feed = prepareFeed(
    [
      { componentId: 1, moles: 0.5 },
      { componentId: 2, moles: 0.5 },
    ],
    DEFAULT_ALGO,
    false,
  );
  const T = 90;
  const bd = bubbleDewPressure(comps, feed, T);
  assert.ok(bd.dewPressureKpa < bd.bubblePressureKpa);
  // 泡点极限气相组成归一；露点极限液相组成归一
  assert.ok(Math.abs(bd.bubbleVaporY.reduce((a, c) => a + (c.y ?? 0), 0) - 1) < 1e-9);
  assert.ok(Math.abs(bd.dewLiquidX.reduce((a, c) => a + (c.x ?? 0), 0) - 1) < 1e-9);

  const atBubble = flash({
    components: comps,
    feed,
    k: comps.map((c) => antoinePsatKpa(c.antoine!, T) / bd.bubblePressureKpa),
    temperatureC: T,
    pressureKpa: bd.bubblePressureKpa,
    algo: DEFAULT_ALGO,
  });
  assert.equal(atBubble.regime, "all-liquid");
  assert.equal(atBubble.vaporMoles, null);
  const atDew = flash({
    components: comps,
    feed,
    k: comps.map((c) => antoinePsatKpa(c.antoine!, T) / bd.dewPressureKpa),
    temperatureC: T,
    pressureKpa: bd.dewPressureKpa,
    algo: DEFAULT_ALGO,
  });
  assert.equal(atDew.regime, "all-vapor");
  assert.equal(atDew.liquidMoles, null);
});
