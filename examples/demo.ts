/**
 * 端到端演示：
 *  1) 导入物性（苯/甲苯 Antoine）与进料
 *  2) 同一进料由低压全气跨过两相区到高压全液的压力扫描
 *  3) 泡点/露点边界
 *  4) 退化输入（所有 K=1，汽化分率不唯一）
 *  5) 超出物性温区的真实诊断
 *  6) 两版进料组成比较
 *  7) 报告冻结与重启后复核
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { Store } from '../src/db.js';
import { FlashService } from '../src/service.js';
import { parseCsv } from '../src/serialization.js';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.FLASH_DATA_DIR || mkdtempSync(join(tmpdir(), 'flash-demo-'));
const store = new Store(join(dataDir, 'flash.sqlite'));
const service = new FlashService(store);

function line(t: string): void {
  console.log('\n==================== ' + t + ' ====================');
}

// 1) 导入
const propsRows = parseCsv(readFileSync(join(here, 'props.csv'), 'utf8'));
if (!store.getVersion('V1')) service.importVersion(propsRows, 'V1', '苯/甲苯等 Antoine 系数（kPa, °C）');
service.importFeedFromCsv(join(here, 'feed_benz_tol.csv'), 'F-苯甲苯5050');
service.importFeedFromCsv(join(here, 'feed_benz_tol_lean.csv'), 'F-贫苯');
console.log('数据目录:', dataDir);

// 2) 压力扫描：低压全气 -> 两相 -> 高压全液（90°C）
line('压力扫描 T=90°C（低压全气 → 两相 → 高压全液）');
const scan = service.scan('F-苯甲苯5050', 'V1', 90, [60, 75, 82, 85, 90, 93, 100, 130, 160], false);
console.log('泡点压力 kPa =', scan.bubblePressure?.toFixed(3), ' 露点压力 kPa =', scan.dewPressure?.toFixed(3));
for (const p of scan.points) {
  console.log(`P=${String(p.pressure).padStart(6)} kPa  state=${p.state.padEnd(20)} beta=${p.beta === null ? '  n/a' : p.beta.toFixed(6)}`);
}
console.log('连续性核验通过:', scan.continuityPassed, ' 最大跳变:', scan.continuityMaxJump?.toExponential(2));

// 3) 泡点/露点边界
line('泡点 / 露点（T=90°C）');
const bub = service.bubbleOrDew('bubble', 'F-苯甲苯5050', 'V1', 90, false);
const dew = service.bubbleOrDew('dew', 'F-苯甲苯5050', 'V1', 90, false);
console.log('泡点压力', bub.pressure.toFixed(3), 'kPa；极限气相量 =', bub.limitingPhaseMoles, '（边界上不产出气相物流）');
console.log('露点压力', dew.pressure.toFixed(3), 'kPa；极限液相量 =', dew.limitingPhaseMoles, '（边界上不产出液相物流）');

// 单点两相闪蒸明细
line('两相闪蒸明细 T=90°C, P=85 kPa');
const f = service.flash({ feedName: 'F-苯甲苯5050', versionName: 'V1', temperature: 90, pressure: 85 });
console.log('state =', f.state, ' beta =', f.beta?.toFixed(6), ' 残差 =', f.residual?.toExponential(2), ' 停止原因 =', f.stopReason);
for (const c of f.components) {
  console.log(
    `${c.component}: z=${c.z} K=${c.k.toFixed(4)} x=${c.x?.toFixed(4)} y=${c.y?.toFixed(4)} L=${c.liquidMoles?.toFixed(4)} V=${c.vaporMoles?.toFixed(4)}`,
  );
}
console.log('物料核验通过:', f.materialCheck.passed, ' max|z-(L+V)|=', f.materialCheck.maxAbsImbalance.toExponential(2),
  ' max|y-Kx|=', f.materialCheck.maxKYDeviation?.toExponential(2));

// 4) 退化输入：K 全为 1
line('退化输入：所有有进料组分 K=1');
const deg = service.flash({
  feedName: 'F-苯甲苯5050', versionName: 'V1', temperature: 90, pressure: 100,
  userK: { 苯: 1, 甲苯: 1 },
});
console.log('state =', deg.state, ' beta =', deg.beta, '（不唯一，拒绝随意指定汽化分率）');

// 5) 超温区诊断
line('超出物性温区诊断');
try {
  service.flash({ feedName: 'F-苯甲苯5050', versionName: 'V1', temperature: 500, pressure: 100 });
} catch (e) {
  console.log('捕获真实诊断：', (e as Error).message);
}

// 6) 两版进料比较
line('两版进料组成比较（同 T=90°C, P=85 kPa）');
const cmp = service.compare(
  { feedName: 'F-苯甲苯5050', versionName: 'V1', temperature: 90, pressure: 85 },
  { feedName: 'F-贫苯', versionName: 'V1', temperature: 90, pressure: 85 },
);
console.log('基础 beta =', cmp.base.beta?.toFixed(6), ' 对比 beta =', cmp.other.beta?.toFixed(6), ' Δbeta =', cmp.deltaBeta?.toFixed(6),
  ' 相态变化 =', cmp.stateChanged);

// 7) 报告冻结与复核
line('报告冻结与复核');
const reportId = f.reportId!;
const rep = store.getReport(reportId)!;
console.log(`报告 #${reportId} kind=${rep.kind} 创建于 ${rep.createdAt}`);
console.log('冻结算法参数 rrMaxIter =', JSON.parse(rep.algorithmJson).rrMaxIter);
console.log('重启后可用 GET /reports/' + reportId + ' 或 CLI `report --id ' + reportId + '` 复核完整请求/结果');

store.close();
line('演示完成');
