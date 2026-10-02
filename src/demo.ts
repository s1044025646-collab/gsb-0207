import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { Store } from "./db";
import { FlashService } from "./service";
import { toCsv } from "./importexport";

const propsV1 = {
  components: [
    // 经典 Antoine 系数（log10 mmHg, t°C），温区取自常见数据表
    { key: "benzene", name: "苯", cas: "71-43-2", antoine: { a: 6.90565, b: 1211.033, c: 220.79, tMinC: 8, tMaxC: 103 } },
    { key: "toluene", name: "甲苯", cas: "108-88-3", antoine: { a: 6.95464, b: 1344.8, c: 219.48, tMinC: 6, tMaxC: 137 } },
    { key: "hexane", name: "正己烷", cas: "110-54-3", antoine: { a: 6.87601, b: 1171.17, c: 224.41, tMinC: -25, tMaxC: 100 } },
  ],
};

const feedEq = {
  entries: [
    { key: "benzene", moles: 0.5 },
    { key: "toluene", moles: 0.5 },
  ],
};

const feedV2 = {
  entries: [
    { key: "benzene", moles: 0.7 },
    { key: "toluene", moles: 0.3 },
  ],
};

export function runDemo(store: Store, service: FlashService): void {
  const lines: string[] = [];
  const log = (s: string) => {
    console.log(s);
    lines.push(s);
  };

  log("=== 理想混合物闪蒸后端演示 ===");

  // 两版物性：v2 微调苯的系数（冻结版本，可对比）
  service.importProperties("demo-v1", { format: "json", text: JSON.stringify(propsV1) });
  const propsV2 = JSON.parse(JSON.stringify(propsV1));
  propsV2.components[0].antoine.a = 6.91;
  service.importProperties("demo-v2", { format: "json", text: JSON.stringify(propsV2) });

  service.importFeed({
    label: "demo-feed-5050",
    propertyVersion: "demo-v1",
    format: "json",
    text: JSON.stringify(feedEq),
  });
  service.importFeed({
    label: "demo-feed-7030",
    propertyVersion: "demo-v1",
    format: "json",
    text: JSON.stringify(feedV2),
  });
  service.importFeed({
    label: "demo-feed-5050-v2",
    propertyVersion: "demo-v2",
    format: "json",
    text: JSON.stringify(feedEq),
  });

  const T = 90;
  log(`\n--- 90°C 泡点/露点压力（苯-甲苯 50/50）---`);
  const bd = service.runBubbleDew({
    propertyVersion: "demo-v1",
    feedVersion: "demo-feed-5050",
    temperatureC: T,
  });
  log(`泡点压力 = ${bd.bubblePressureKpa.toFixed(3)} kPa`);
  log(`露点压力 = ${bd.dewPressureKpa.toFixed(3)} kPa`);

  const mid = (bd.bubblePressureKpa + bd.dewPressureKpa) / 2;
  log(`\n--- 压力扫描：低压全气 → 两相 → 高压全液（T=${T}°C）---`);
  const pressures = [
    bd.dewPressureKpa * 0.5,
    bd.dewPressureKpa,
    Number(mid.toFixed(3)),
    bd.bubblePressureKpa,
    bd.bubblePressureKpa * 1.5,
  ];
  const scan = service.runScan({
    propertyVersion: "demo-v1",
    feedVersion: "demo-feed-5050",
    temperatureC: T,
    pressuresKpa: pressures,
  });
  for (const pt of scan.points) {
    log(
      `P=${pt.pressureKpa.toFixed(2).padStart(7)} kPa  regime=${pt.result.regime.padEnd(16)} beta=${
        pt.result.beta === null ? "null(退化)" : pt.result.beta.toFixed(6)
      } 残差=${pt.result.residual?.toExponential(2)}`,
    );
  }

  log(`\n--- 两版物性对比（P=${mid.toFixed(2)} kPa）---`);
  const r1 = service.runFlash({
    propertyVersion: "demo-v1",
    feedVersion: "demo-feed-5050",
    temperatureC: T,
    pressureKpa: mid,
  });
  const r2 = service.runFlash({
    propertyVersion: "demo-v2",
    feedVersion: "demo-feed-5050-v2",
    temperatureC: T,
    pressureKpa: mid,
  });
  const cmp = service.compareRuns(r1.runId, r2.runId);
  log(`v1 beta=${r1.result.beta?.toFixed(6)}  v2 beta=${r2.result.beta?.toFixed(6)}  相态变化=${cmp.regimeChanged}`);

  log(`\n--- 两版进料组成对比（50/50 vs 70/30，P=${mid.toFixed(2)} kPa）---`);
  const r3 = service.runFlash({
    propertyVersion: "demo-v1",
    feedVersion: "demo-feed-7030",
    temperatureC: T,
    pressureKpa: mid,
  });
  log(`70/30 beta=${r3.result.beta?.toFixed(6)}（运行 id=${r3.runId}，可用 compare 比较）`);

  log(`\n--- 退化输入：所有 K=1（直接给定 K）---`);
  const deg = service.runFlash({
    propertyVersion: "demo-v1",
    feedVersion: "demo-feed-5050",
    temperatureC: T,
    pressureKpa: 101.325,
    directK: { benzene: 1, toluene: 1 },
  });
  log(`regime=${deg.result.regime}, beta=${deg.result.beta}, betaUnique=${deg.result.betaUnique}`);
  log(`警告: ${deg.result.warnings.join("; ")}`);

  log(`\n--- 越界诊断：温度 200°C 超出苯温区 [8,103] ---`);
  try {
    service.runFlash({
      propertyVersion: "demo-v1",
      feedVersion: "demo-feed-5050",
      temperatureC: 200,
      pressureKpa: 101.325,
    });
  } catch (err) {
    log(`已拒绝: ${(err as Error).message}`);
  }

  const csv = toCsv(
    [["pressureKpa", "regime", "beta", "residual"],
    ...scan.points.map((p) => [
      p.pressureKpa,
      p.result.regime,
      p.result.beta ?? "",
      p.result.residual ?? "",
    ])] as Array<Array<string | number>>,
  );
  const outPath = join(process.env.FLASH_DATA_DIR ?? "data", "demo-scan.csv");
  writeFileSync(outPath, csv, "utf8");
  log(`\n扫描 CSV 已导出: ${outPath}`);
  log("所有运行均已冻结到 SQLite，可用 `flash run --id=<n>` 复核。");
  writeFileSync(join(process.env.FLASH_DATA_DIR ?? "data", "demo-log.txt"), lines.join("\n"), "utf8");
}
