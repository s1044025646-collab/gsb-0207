# 理想混合物气液闪蒸与泡露点计算后端

仅后端（HTTP API + CLI），实现理想多组分混合物的等温气液平衡（VLE）：

- Rachford–Rice（RR）方程自行求解（二分法），返回汽化分率 β、存在相的组成、
  各组分进出相摩尔量、残差、迭代次数与停止原因；
- 平衡常数 K 可直接给定（正有限值），或由冻结的 Antoine 系数算饱和蒸气压再按
  Raoult 定律 `K = Psat/P` 得到；系数缺失或温度越界直接拒绝；
- 泡点压力、露点压力、极限相组成，以及一系列压力下的相态扫描；
- 两版物性 / 两版进料组成的结果对比；
- 独立的组分守恒、相组成归一与两相 `y=Kx` 质量核验；
- SQLite 冻结每次运行的输入与算法参数，重启后可用 run id 复核；
- JSON / CSV 导入与导出。

**明确不包含**：活度系数、状态方程、化学反应、外部物性数据库、在线 API、前端界面。

## 环境与单位约定

- Windows 本地运行，无需 Docker / WSL；需要 Node.js ≥ 22（推荐 v24/v25，使用内置
  `node:sqlite`），仅开发依赖 TypeScript 与 tsx，无任何运行时第三方依赖。
- 温度：**摄氏温度 °C**（Antoine 温区与闪蒸输入均为 °C）。
- 压力：**kPa**（闪蒸总压、泡/露点、扫描统一 kPa）。
- Antoine 对数形式（冻结系数，显式声明）：

  `log10(Psat / mmHg) = A − B / (C + t/°C)`

  输出蒸气压换算 `Psat(kPa) = 10^(A − B/(C+t)) · (101.325/760)`；
  即 760 mmHg = 101.325 kPa。
- 进料输入为**摩尔量**（分数意义下总和应为 1，公开容差默认 1e-6）；
  只有显式 `normalize=true` 才按比例归一化，并保留原值与逐组分修正记录。

## 快速开始

```powershell
npm install
npm run build      # 类型检查并编译到 dist/
npm test           # 14 个 node:test 用例（tsx 直跑 TS 源码）
npm start -- --port=3000        # 启动 HTTP 服务（默认 3000，可用 PORT 环境变量）
npm run demo                    # 构建后运行端到端演示（也可用 npm run demo:dev）
```

环境变量：

- `PORT`：HTTP 端口；
- `FLASH_DATA_DIR`：项目内数据目录（默认 `./data`，SQLite 文件 `flash.sqlite`）。

CLI 帮助：`node dist/cli.js`（开发态可 `npx tsx src/cli.ts`）。

## CLI

```powershell
node dist/cli.js serve --port=3000
node dist/cli.js import-props --label=v1 --file=examples/properties.json
node dist/cli.js import-props --label=v1csv --file=examples/properties.csv --format=csv
node dist/cli.js import-feed  --label=f1 --props=v1 --file=examples/feed.json
node dist/cli.js import-feed  --label=f1n --props=v1 --file=examples/feed.csv --format=csv --normalize
node dist/cli.js flash       --props=v1 --feed=f1 --t=90 --p=86 [--format=csv] [--out=result.json]
node dist/cli.js flash       --props=v1 --feed=f1 --t=90 --p=101.325 --k='{"benzene":1,"toluene":1}'
node dist/cli.js bubble-dew  --props=v1 --feed=f1 --t=90
node dist/cli.js scan        --props=v1 --feed=f1 --t=90 --pressures=40,77.55,86.36,95.17,140
node dist/cli.js runs
node dist/cli.js run --id=1
node dist/cli.js compare --a=1 --b=2
node dist/cli.js demo
```

## HTTP API

所有请求/响应为 UTF-8 JSON（导入接口也接受 `format:"csv"` 的文本）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/versions` | 物性/进料版本列表 |
| POST | `/properties/import` | 导入物性版本（冻结 Antoine 系数） |
| POST | `/feeds/import` | 导入进料版本（`normalize` 可选） |
| POST | `/flash` | 等温闪蒸，返回结果 + 质量核验，落库 |
| POST | `/bubble-dew` | 定温泡点/露点压力与极限相组成 |
| POST | `/scan` | 一系列压力下的相态扫描 |
| POST | `/compare` | 比较两次运行（物性或进料差异） |
| GET | `/runs` | 运行记录列表 |
| GET | `/runs/:id` | 取冻结报告；加 `?format=csv` 导出闪蒸组分表 CSV |

`/flash` 请求示例：

```json
{
  "propertyVersion": "v1",
  "feedVersion": "f1",
  "temperatureC": 90,
  "pressureKpa": 86,
  "normalize": false,
  "directK": { "benzene": 1.5 },
  "algo": { "rrResidualTol": 1e-10, "balanceTol": 1e-8, "maxIter": 200 }
}
```

## 相态判据与退化处理

RR 方程（β=V/F 为汽化摩尔分率）：

`g(β) = Σ_i z_i (K_i − 1) / (1 + β(K_i − 1))`

- `g(0) ≤ 0`：全液（β=0，气相不存在）；
- `g(1) ≥ 0`：全气（β=1，液相不存在）；
- 仅当 `g(0) > 0 且 g(1) < 0` 时 (0,1) 内有唯一物理根，才调用二分法；
- 泡点处气相、露点处液相是**极限相**：单相结果里不存在的相不会包装成产出物流
  （对应摩尔量/组成为 `null`，`phasesPresent` 只列实际存在相）；
- 当所有有进料组分 `|K−1| ≤ 1e-9` 时，g(β)≡0，β 不唯一：返回
  `regime="degenerate-k-all-one"`、`beta=null`、`betaUnique=false`，不随意指定分率；
  零进料组分不参与该判定，也不要求 K；
- 求解超过最大迭代仍不满足残差容差时 `converged=false`、`stopReason="max-iterations"`。

## 组成规则

- 摩尔量必须有限、非负；至少一个有进料组分；
- 有进料组分摩尔量之和与 1 的偏差超过 `compSumTol` 且未要求归一化时拒绝（422）；
- `normalize=true` 时按比例缩放，报告含原值 `raw`、使用值 `used` 与 `rawSum`；
- 零进料组分（≤1e-12）只作占位：其 K 可为空、相摩尔量为 0、不参与归一化分母；
- 极微量组分与 K 接近 1（1e-9 < |K−1| ≤ 1e-6）稳定处理并给出 warning。

## 质量核验

`verifyBalance` 独立于求解器，逐组分核对 `F_i = L_i + V_i`（相对容差 `balanceTol`），
核对每个存在相的组成归一、两相时 `y_i = K_i x_i`；任何一项失败或求解未收敛则
`passed=false`。退化状态不做相级核验（相分配不唯一）。

## 数据冻结与复核

SQLite（WAL 模式）表：`property_versions`、`components`（Antoine 系数 JSON 冻结）、
`feed_versions`（归一化标志、原始和、逐组分原/用值）、`runs`（请求、算法参数、
完整报告、时间戳）。关闭进程后重新打开同一数据目录，`GET /runs/:id` 或
`run --id=` 可原样复核。

## 测试覆盖

- 二组分解析闭式 β、全液/全气端点、泡露点边界、K 全为 1 退化、零/微量组分、
  非法组成（负值/NaN/和不为一/全零）、显式归一化修正记录；
- 守恒、各存在相组成归一、两相 `y=Kx`、单位换算（760 mmHg = 101.325 kPa）；
- 压力扫描跨相边界的相态顺序与 β 单调连续性；
- SQLite 关闭重开后的报告一致性，以及 JSON / CSV 双导入路径一致性。

## 演示

`npm run demo`（或 `npm run demo:dev`）使用苯/甲苯/正己烷在 90 °C 下展示：

- 低压全气 → 露点 → 两相 → 泡点 → 高压全液的完整扫描；
- 两版 Antoine 系数、两版进料组成（50/50 与 70/30）的结果对比；
- 直接给定 K=1 的退化诊断；
- 200 °C 超出苯温区 [8,103]°C 的真实拒绝信息；
- 扫描结果导出 CSV（`$FLASH_DATA_DIR/demo-scan.csv`），全部运行落库可复核。

## 假设与限制

- 理想体系：气相理想、液相理想（Raoult 定律），无活度系数 / 逸度修正 / 焓平衡；
- 仅等温闪蒸与定温泡/露点压力；不做定压泡/露点温度迭代；
- Antoine 系数由调用方提供并自行负责来源，系统只做冻结、温区与数值合法性校验；
- `node:sqlite` 在当前 Node 版本会打印一次 ExperimentalWarning，不影响功能；
- 仅本机 / 局域网使用，未内置鉴权与 HTTPS。
