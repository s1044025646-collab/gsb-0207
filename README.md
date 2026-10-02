# 理想混合物气液闪蒸与泡露点计算后端

一个纯本地运行的理想多组分混合物气液平衡（VLE）计算服务，只提供 **HTTP API 与 CLI**（无前端）。
使用 TypeScript + Node.js（内置 `node:sqlite`）实现，**不依赖 Docker、WSL、付费服务或任何在线 API/外部物性数据库**。

## 1. 模型与约定（明确的物理定义）

### 单位
- 温度 `T`：**摄氏度 °C**（Antoine 方程输入）。
- 压力 `P` 与饱和蒸气压 `Psat`：同一压力单位（默认 **kPa**）。平衡常数
  `K = Psat / P` 无量纲，只要 `Psat` 与 `P` 单位一致即单位相消；导入时为每个组分声明压力单位，不一致将拒绝。
- 摩尔组成 `z / x / y`：摩尔分率，无量纲。

### Antoine 蒸气压（以 10 为底的显式形式）
```
log10(Psat) = A - B / (T + C)        T 单位 °C，Psat 单位为组分声明的压力单位
```
- 每个组分带闭区间有效温区 `[Tmin, Tmax]`（°C）。
- **系数缺失**（A/B/C/Tmin/Tmax 任一为空）或 **温度越界** 时，Raoult 路径直接拒绝并返回中文诊断，绝不外推。

### 平衡常数 K
- 可对组分**直接给定正的 K**（`userK`）；未给定的组分按 **Raoult 定律** `K_i = Psat_i(T)/P` 计算。
- K 必须为正的有限数，否则拒绝。

### Rachford–Rice（自行实现，未使用任何现成闪蒸求解器）
```
f(β) = Σ_i z_i (K_i - 1) / (1 + β(K_i - 1)) = 0,   β = V/F（汽化摩尔分率）∈ [0,1]
```
- 物理可行开区间由极点确定：
  `β_lo = max(0, max_{K>1} 1/(1-K))`，`β_hi = min(1, min_{K<1} 1/(1-K))`。
- **端点判据**：`f(0) ≤ 0` → 全液（β=0）；`f(1) ≥ 0` → 全气（β=1）；
  仅当 `f(0)>0 且 f(1)<0` 时在 `(0,1)` 内**有物理根**，用区间二分（RR 单调）求根。
- 返回：β、存在相的 x/y、各组分进出液相/气相的摩尔量、RR 残差、迭代次数、相态与停止原因。
- **退化**：所有“有进料”的组分 `|K-1| ≤ 1e-9` 时，β 不唯一，返回
  `degenerate-k-all-one`，`beta=null`，**不**随意指定汽化分率。
- 零进料（`z ≤ 1e-30`）组分不参与求和、不进入任何相；极微量组分正常参与并独立核验守恒。

### 相与物流
- 全液时 `y/气相摩尔量` 不作为产出（气相 `present=false`）；全气时同理不产出液相。
- 泡点处极限气相量为 0、露点处极限液相量为 0：**极限相**与**实际存在相**分别返回，
  极限相明确标注 `limitingPhaseMoles = 0`，不包装成已产出物流。

### 泡点 / 露点压力（定温，解析式）
```
P_bubble = Σ z_i Psat_i                      （液相 x=z，极限气相 y_i = z_i Psat_i / P_bubble）
P_dew    = 1 / (Σ z_i / Psat_i)              （气相 y=z，极限液相 x_i = z_i P_dew / Psat_i）
```

## 2. 组成校验与归一化
- 组成必须全部**有限、非负**，且 `|Σz - 1| ≤ 1e-6`（公开容差 `SUM_TOL`）才接受。
- 默认**不**自动修正；只有请求显式 `normalize=true` 时才把非负、有限、总和为正的组成
  按原值比例归一，并在结果 `normalization` 中同时保留**原值、原始总和、修正值与修正原因**。
- 无法满足 RR 残差容差（`1e-10`）或物料守恒容差（`1e-8`）时，结果 `converged=false` 并给出警告。

## 3. 冻结与可复核
每次闪蒸/泡露点/扫描/比较都会把 **请求 JSON、结果 JSON、算法参数（容差/迭代上限等）** 写入
SQLite 表 `reports`。重启后可用 `GET /reports/{id}` 或 CLI `report --id` 完整复核。
物性以**版本**（`property_versions` + 不可变组分行）冻结；进料存原始组成。

## 4. 环境要求
- **Node.js ≥ 22.5（推荐 22.5+ / 开发机实测 v25.5.0）**，使用内置实验模块 `node:sqlite`，无需原生编译。
- Windows PowerShell 本地直接运行。数据库位于项目内 `data/flash.sqlite`（可用 `FLASH_DATA_DIR` 覆盖）。

## 5. 安装、构建、测试、启动、演示
```powershell
npm install
npm run build     # 类型检查并编译到 dist/
npm test          # node:test 运行 17 个测试
npm run demo      # 端到端演示（导入→扫描→泡露点→退化→越界诊断→比较→报告）
npm start         # 启动 HTTP 服务，默认 http://localhost:3000
```
- 端口：`$env:PORT="3210"`（或 `$env:FLASH_PORT`）。
- 数据目录：`$env:FLASH_DATA_DIR="E:/path/to/data"`（默认项目内 `./data`）。

## 6. CLI
```powershell
npx tsx src/cli/index.ts import-props --file examples/props.csv --name V1
npx tsx src/cli/index.ts import-feed  --file examples/feed_benz_tol.csv --name F1
npx tsx src/cli/index.ts list-versions
npx tsx src/cli/index.ts flash  --feed F1 --version V1 --t 90 --p 85 [--k '{\"苯\":2.1}'] [--normalize] [--format csv]
npx tsx src/cli/index.ts bubble --feed F1 --version V1 --t 90
npx tsx src/cli/index.ts dew    --feed F1 --version V1 --t 90
npx tsx src/cli/index.ts scan   --feed F1 --version V1 --t 90 --pressures 60,75,85,90,100,160 [--format csv]
npx tsx src/cli/index.ts compare --feed F1 --version V1 --t 90 --p 85 --compare F2:V1
npx tsx src/cli/index.ts report --id 1
```
导入 CSV 列名：
- 物性：`name,cas,pressure_unit,antoine_a,antoine_b,antoine_c,t_min,t_max`（系数必须全填或全空）。
- 进料：`component,z`（或 `name,mole_fraction`）。

## 7. HTTP API
所有请求/响应均为 JSON（`Content-Type: application/json`）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/health` | 健康检查与数据目录 |
| GET  | `/versions` `/feeds` `/reports` | 列出物性版本 / 进料 / 报告 |
| GET  | `/reports/{id}` | 取冻结的请求、结果、算法参数 |
| POST | `/import/properties` | `{name,note,rows:[{name,pressure_unit,antoine_a,...}]}` |
| POST | `/import/feed` | `{name,rows:[{component,z}]}` |
| POST | `/flash` | `{feedName,versionName,temperature,pressure?,userK?,normalize?}` |
| POST | `/bubble` `/dew` | `{feedName,versionName,temperature,normalize?}` |
| POST | `/scan` | `{feedName,versionName,temperature,pressures:[...],normalize?}` |
| POST | `/compare` | `{base:{...flashRequest}, other:{...flashRequest}}` |

闪蒸响应关键字段：`state`（all-liquid/all-vapor/two-phase/degenerate-k-all-one/infeasible）、
`stopReason`、`beta`、`liquidPresent/vaporPresent`、`components[]{z,k,x,y,liquidMoles,vaporMoles}`、
`residual`、`iterations`、`materialCheck`、`normalization`、`warnings`。
导出 JSON 即响应本体；CSV 用 CLI `--format csv`（或 `service.flashToCsv/scanToCsv`）。

### curl 示例
```powershell
Invoke-RestMethod http://localhost:3000/flash -Method Post -ContentType 'application/json' `
  -Body '{"feedName":"F1","versionName":"V1","temperature":90,"pressure":85}'
```

## 8. 测试覆盖（17 项，独立核对，不使用现成闪蒸求解器）
- 二组分解析解（`z=[.5,.5], K=[2,.5]` → β=0.5）；
- 全液 / 全气（不存在相不产出物流）；
- 两相组分守恒、存在相组成归一、`y=Kx`；
- 泡点/露点边界与极限相量为 0；
- K 全为 1 的退化状态（β 不唯一）；
- 零进料与极微量组分；非法组成（负、非有限、总和越界）拒绝；
- 显式归一化保留原值与修正记录；非正 K、缺系数、越温区诊断；
- 压力扫描跨相边界（全气→两相→全液）且 β 随压力单调不增；
- 报告冻结读取；两版进料比较；`K=Psat/P` 的单位一致性。

## 9. 范围与限制（合理假设）
- 仅理想体系：Raoult 定律，**不含**活度系数、完整状态方程、化学反应或固相。
- Antoine 仅支持本项目声明的以 10 为底形式；不做温区外推，也不接入外部数据库。
- 泡/露点为定温解析式（理想体系精确），不做温度迭代。
- 压力单位须与组分单位一致；本项目示例统一 kPa，不内置自动单位换算（一致性被强制校验）。
- `node:sqlite` 在当前 Node 版本会打印一条 ExperimentalWarning，不影响功能。
