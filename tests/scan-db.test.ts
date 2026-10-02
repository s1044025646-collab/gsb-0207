import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { DEFAULT_ALGO } from "../src/common.ts";
import { prepareFeed } from "../src/feed.ts";
import { pressureScan, bubbleDewPressure } from "../src/bubble.ts";
import type { ComponentDef } from "../src/common.ts";
import { Store } from "../src/db.ts";
import { FlashService } from "../src/service.ts";

const comps: ComponentDef[] = [
  { id: 1, name: "苯", antoine: { a: 6.90565, b: 1211.033, c: 220.79, tMinC: 8, tMaxC: 103 } },
  { id: 2, name: "甲苯", antoine: { a: 6.95464, b: 1344.8, c: 219.48, tMinC: 6, tMaxC: 137 } },
];

test("压力扫描跨相边界：全气→两相→全液且 beta 单调连续", () => {
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
  const points = pressureScan(
    comps,
    feed,
    T,
    [
      bd.dewPressureKpa * 0.6,
      bd.dewPressureKpa * 0.9,
      (bd.dewPressureKpa + bd.bubblePressureKpa) / 2,
      bd.bubblePressureKpa * 1.1,
      bd.bubblePressureKpa * 1.6,
    ],
    DEFAULT_ALGO,
  );
  const regimes = points.map((p) => p.result.regime);
  assert.equal(regimes[0], "all-vapor");
  assert.equal(regimes[4], "all-liquid");
  assert.ok(regimes.includes("two-phase"));
  const betas = points.map((p) => p.result.beta!);
  for (let i = 1; i < betas.length; i++) {
    assert.ok(betas[i]! <= betas[i - 1]! + 1e-12, "beta 应随压力单调下降");
  }
});

test("SQLite 冻结与重启复核：重新打开库后 run 报告一致", () => {
  const dir = join(tmpdir(), `flash-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    let store = new Store(join(dir, "t.sqlite"));
    const service = new FlashService(store);
    service.importProperties("v1", {
      format: "json",
      text: JSON.stringify({
        components: [
          { key: "a", name: "苯", antoine: comps[0]!.antoine },
          { key: "b", name: "甲苯", antoine: comps[1]!.antoine },
        ],
      }),
    });
    service.importFeed({
      label: "f1",
      propertyVersion: "v1",
      format: "json",
      text: JSON.stringify({ entries: [{ key: "a", moles: 0.5 }, { key: "b", moles: 0.5 }] }),
    });
    const out = service.runFlash({
      propertyVersion: "v1",
      feedVersion: "f1",
      temperatureC: 90,
      pressureKpa: 70,
    });
    const runId = out.runId;
    store.close();

    store = new Store(join(dir, "t.sqlite"));
    const run = store.getRun(runId)!;
    assert.equal(run.kind, "flash");
    assert.equal(run.algo.rrResidualTol, DEFAULT_ALGO.rrResidualTol);
    const rep = run.report as { result: { beta: number; regime: string } };
    assert.equal(rep.result.regime, out.result.regime);
    assert.ok(Math.abs(rep.result.beta - out.result.beta!) < 1e-15);

    // CSV 物性/进料导入路径
    const service2 = new FlashService(store);
    service2.importProperties("vcsv", {
      format: "csv",
      text: "key,name,cas,A,B,C,Tmin_C,Tmax_C\na,苯,x,6.90565,1211.033,220.79,8,103\nb,甲苯,y,6.95464,1344.8,219.48,6,137\n",
    });
    service2.importFeed({
      label: "fcsv",
      propertyVersion: "vcsv",
      format: "csv",
      text: "component_key,moles\na,0.5\nb,0.5\n",
    });
    const out2 = service2.runFlash({
      propertyVersion: "vcsv",
      feedVersion: "fcsv",
      temperatureC: 90,
      pressureKpa: 70,
    });
    assert.ok(Math.abs(out2.result.beta! - out.result.beta!) < 1e-12);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
