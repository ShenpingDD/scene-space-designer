---
title: 空间内核：判据与接缝（领域真理）
type: 规范
tags: [示例, 场景设计器, 内核, spatial-core, 判据, 接缝, 参数表, 门几何]
created: 2026-09-28
updated: 2026-09-28
author: demo
status: 现行
project: scene-space-designer
---

# KERNEL 空间内核：判据与接缝

> 注：正文里凡写「设计决策记录」的地方，指的是本项目**内部的设计决策留档**（决策条目不随公开仓发布）；它只解释「为什么这么做」，不影响代码行为。


> 本文件是本项目的**领域真理**：空间内核是什么、在哪里、判据有哪些、接缝怎么定的。
> 它**替代**了通用模板里的「页面结构说明」——本项目没有组件详情页，真正要写清的是**空间判据**。
> 唯一权威的代码在 `spatial-core/src/`；本文只转述，不与代码平起平坐。数字与函数名以代码为准。

---

## ① 内核是什么、在哪

内核 = 一组**纯函数**，回答空间设计器的三个核心问题「放得下 / 能不能用 / 怎么进出」。
它不依赖 Three.js、不依赖 DOM，坐标一律是**房间本地坐标**（`0..w / 0..d`，米）。

### 双实现关系

| 端口 | 位置 | 角色 |
| --- | --- | --- |
| **JS 版（源）** | `spatial-core/src/` | 唯一权威；浏览器 + 服务端都调它 |
| **Java 版（镜像）** | `server/src/main/java/com/scene/spatial/kernel/` | 逐文件复现，靠同一份用例表逐条对账 |

Java 侧文件与 JS 一一对应（来源 设计决策记录）：
`Geometry.java`←`geometry.js`、`Layout.java`←`state`、`Room.java`←`room.js`、
`Validate.java`←`validate.js`、`Clearance.java`←`clearance.js`、`Catalog.java`←`getProduct()`、
`CaseRunner.java`←`case-runner.js`、`Placement/Scheme/Doors/Collision` 各对应同名 js；
`Cases.java` / `Params.java` 是**生成物**（内部工具链 `gen-java-data.mjs` 生成，含来源 sha256；该生成器不随公开仓发布，改用例时两边**手工保持逐字一致**）。设计决策记录记了两个「跑起来才知道」的坑：`javac` 会对单个巨型集合字面量卡死、`Map.ofEntries` 不接受 null（有意义的期望值）。

`spatial-core/src/` 实际文件（`ls`）：`case-runner.js`、`clearance.js`、`collision.js`、`doors.js`、
`geometry.js`、`history.js`、`model.js`、`params.js`、`placement.js`、`room.js`、`scheme.js`、`validate.js`。
本文只深读了 7 个规则文件（clearance/collision/placement/doors/scheme/validate/params），`geometry.js` / `room.js` 取了函数签名，`model.js` / `history.js` 未展开。

「服务端是唯一裁判」的语义：`state` 就是前端 v4 方案，**同形同义零迁移**；服务端写库前先拿内核的 `Scheme.importScheme(state, catalog, true)` 过一遍，「能存进去的一定导得回来」。

---

## ② 参数表（`params.js`）

**一句话**：所有「业务规则里的数字」收口成**一份数据**，`cfg.door.openOkDeg` 这样读；改配置不改代码、不重发版。
`PARAM_SPEC` 同时是**校验规则 / 后台表单定义 / Java 侧基线 / 给人看的说明**（一份 spec 驱动四处，设计决策记录）。

两条硬约束（写在 `params.js` 文件头，改前必读）：
1. `cfg` 是**活引用**，`configure()` 只做**原地深合并** → 模块里**禁止在导入期把 `cfg` 抄进常量**（`const X = cfg.door.openOkDeg` 会让配置永远不生效），一律在函数里读。
2. **改参数 = 改业务语义**；`test/cases/rules.json` 里钉住的数字可能就不成立，参数表自己有单测。

下面是按组精选的参数（来源 `params.js` 的 `PARAM_SPEC`，行号为文件内行号）：

| 参数路径 | 含义 | 单位 | 默认 | 改了会怎样 |
| --- | --- | --- | --- | --- |
| `room.minW`/`maxW`/`minD`/`maxD` | 房间长宽范围 | m | 3/20/3/20 | 平面图可画的长宽变；越界方案被拒 |
| `room.minH`/`maxH` | 层高范围 | m | 2/5 | 同左（层高） |
| `space.overlapTolM` | 重叠容差 | m | 0.005 | 重叠判定松紧（5 mm 以内不算重叠） |
| `space.wallThicknessM` | 墙厚 | m | 0.12 | 压墙判定与建模厚度 |
| `space.snapM` | 位置吸附 | m | 0.1 | 拖动落位的取整步长 |
| `space.rotateStepDeg` | 旋转步长 | ° | 5 | 按一下旋转转多少度 |
| `layout.maxItems` | 设备上限 | 台 | 100 | 方案能放几台；超过 `addItem` 报 `limit` |
| `layout.maxWalls` | 内墙上限 | 面 | 100 | 能画几面内墙 |
| `layout.autoZ0/Dz/X0/Dx/Margin` | 自动摆放网格 | m | 0.7/1.1/0.7/1.2/0.5 | `findFreeSpot` 的行列起点与间距 |
| `scheme.maxFileBytes` | 导入文件上限 | B | 1_000_000 | 超过报「文件过大」 |
| `scheme.maxCoordM` | 坐标绝对值上限 | m | 22 | 超出范围的坐标读文件时拒绝 |
| `scheme.minWallLengthM` | 最短墙长 | m | 0.1 | 更短的墙拒绝（画不出也没意义） |
| `door.openOkDeg` | **绿灯阈值** | ° | **90** | 门开到 ≥90° 才算「不受阻」（用户 2026-09-21 拍板） |
| `door.openWarnDeg` | **黄灯阈值** | ° | 60 | 低于绿灯、高于此值 → 黄 |
| `door.sweepStepDeg` | 扫掠步长 | ° | 1 | 调粗算得快但角度偏小；**Java 侧必须同口径**（`admin:false`） |
| `door.freeTolDeg` | 扫掠容差 | ° | 0.5 | 判定「这一帧撞上」的几何容差（`admin:false`） |
| `door.amountMin`/`amountMax` | 开门比例端点 | — | 0/1 | 关门位/全开位的比例 |
| `walk.radiusM` | 人体半径 | m | 0.24 | 漫游碰撞圆柱半径（肩宽级） |
| `walk.wallClearanceM` | 离墙间隙 | m | 0.06 | 贴墙走额外留的余量 |
| `walk.doorBarrierMinM/MaxM` | 门挡人高度区间 | m | 0.08/1.8 | 门只在人体高度区间算障碍（底座缝/顶盖不挡人） |
| `walk.stepMaxM` | 单步最大位移 | m | 0.06 | 移动切小步做连续碰撞（防穿模，`admin:false`） |
| `walk.spawnStepM` | 出生点扫描步长 | m | 0.35 | 找站立位置的网格步长（`admin:false`） |
| `model.anisotropyWarn` | 比例失真告警 | 倍 | 1.02 | 各轴缩放比差 >2% 告警（尺寸不可信） |
| `history.maxSteps` | 历史深度 | 步 | 40 | 最多撤销多少步 |

**两条跨字段校验**（`validatePatch()`，params.js 196–203）：黄灯阈值不能**高于**绿灯阈值（否则黄灯级别无意义）、不能**等于**（等于取消黄灯级别）。任何一处非法 → **整体不生效**（不许改一半）；未知键一律报错（把 `openOkDeg` 写成 `openOKDeg` 是最坏结果）。

---

## ③ 判据清单

### 3.1 规则 1 —— 放得下（`validate.js`）

`checkItem(layout, item, getProduct)` 返回**原因码**（`REASON`，validate.js 16–21），`null` 为合法：

| 原因码 | 发声条件 | 返回 |
| --- | --- | --- |
| `unknown-product` | 型号目录里查不到该 `p` | `'unknown-product'` |
| `out-of-room` | 四角任一越出房间 | `'out-of-room'` |
| `overlap-item#<id>` | 与其它设备占地矩形 OBB 相交 | `'overlap-item#<对方id>'`（带 id） |
| `hit-wall` | 压到**内墙**（外墙跳过，FIX-04） | `'hit-wall'` |

`checkAll()` 返回非法设备清单（带原因码）；`statusText()` 给状态栏文案「`N 台设备存在重叠、碰墙或超出空间`」。
关键设计（comment）：外墙 = 房间边界，**不再是障碍物**——越界规则已经兜住它。

### 3.2 规则 7 —— 能不能用（`clearance.js`，与规则 1 **并列、不阻断**）

`doorFreeAngle()` 逐度扫掠，返回 `{freeDeg, maxDeg, door, blockedBy, unobstructed, doors}`：
- **粗筛**（clearance.js 140–150）：门板上每点到铰链 ≤ `swing`，故「到铰链 > swing + 容差」的设备/墙先剔除；100 台从 2.9s 降到几十 ms。
- **逐度扫掠**（clearance.js 151–156）：从关门位向开方向转，第一帧撞到就停 → `freeDeg`；第一步就被挡 = 0°。
- `blockedBy` 是 `{kind:'room'|'item'|'wall', id}`。
- `unobstructed = freeDeg >= maxDeg - freeTolDeg`（clearance.js 161）。

`clearanceLevel(freeDeg)`（clearance.js 168）分三档：

| 分级 | 判据 | 返回 |
| --- | --- | --- |
| `n/a` | `freeDeg` 为 null/undefined（无平面净空门 / 无实测数据） | `'n/a'` |
| `ok`（绿） | `freeDeg >= openOkDeg`（90） | `'ok'` |
| `warn`（黄） | `openWarnDeg`(60) ≤ `freeDeg` < 90 | `'warn'` |
| `bad`（红） | `freeDeg` < 60 | `'bad'` |

文案也由内核持有（`clearanceText()`，clearance.js 184–195）：开不到底就**不能**说成「能开但会挡」，三级三句话。
`doorTroubleClause()`（clearance.js 208）是「自动摆放后该说那一句」，纯提示不阻断；无话可说返回 `''`。
**一条耦合事实**：`freeDeg=0` 时占地必然已重叠（关门位门板落在自家占地框内），所以规则 7 真正独立贡献的区间是 `(0, maxDeg]`——单测里已写成断言。

### 3.3 规则 4 —— 进出怎么走（`collision.js`，漫游碰撞）

| 判据 | 发声条件 | 返回 |
| --- | --- | --- |
| `blocked()` | ① 边界内缩 radius ② 离墙 < radius+wallClearance ③ 进设备占地矩形 ④ 开着的门（AABB ∩ 高度区间） | `true`/`false` |
| `doorIsBlocking()` | 门 AABB 是否落在 `doorBarrierMinM~MaxM` 高度区间 | `true`/`false` |
| `safeSpawn()` | 先试房间中央两处，再 `spawnStepM` 网格扫 | 首个不挡点或 `null` |
| `moveWithCollision()` | 位移切 ≤`stepMaxM` 小步，分轴判定，撞墙「沿墙滑动」 | `[x,z]` |

⚠️ **两处已知缺陷保持行为对齐**（collision.js 头注释）：FIX-16（门用世界 AABB，开门后覆盖整个扫掠区 → 空地上出现隐形障碍；且未跳过 `amount===0` 的门）、FIX-17（玩家嵌入几何体后 `blocked` 恒 true → 永久卡死）。修这两处时**必须显式改掉断言**，不悄悄改行为。

### 3.4 规则 3 / 5 —— 摆位与方案（`placement.js` / `scheme.js`）

`addItem()` 顺序严格对齐原型：上限→型号存在→位置（夹取或自动找空位）→**空位失败则不新增**。
`scheme.js` 导入失败返回**分类原因码**（`IMPORT_ERROR`，scheme.js 37）：`not-json` / `bad-format` /
`bad-room` / `too-many-items` / `too-many-walls` / `bad-item` / `duplicate-id` / `bad-wall`。
**写入端与读取端共用同一套限制**（`scheme.LIMITS` 全用 getter 读 `cfg`，scheme.js 23）。

---

## ④ 接缝决策

### 接缝 A：开门占位要不要参与「能不能这么摆」的判定 → **A3**

| 方案 | 行为 | 代价 / 风险 |
| --- | --- | --- |
| A1 不纳入（现状） | 只画扇形，不判定 | 零成本；系统给「不可用」方案盖章通过 |
| A2 纳入硬性错误 | 门扫掠撞到 → 拒绝放置 | 安全但**过硬**：角落位置常允许「门只开 60°」，硬拒让合法方案无法表达 |
| **A3 折中（选定）** | 算**实际可开角度**、分两级提示、**不阻断放置** | 内核 +1 条规则、用例 +4~6 条、Java 同步；但业务上最值钱 |

**为什么这么定**（设计决策记录 §接缝A）：设计器要回答的真实问题是「这么摆**能不能用**」，放得下 ≠ 能用——门打不开的柜子等于不能用的柜子。A3 三件事一起成立：不破坏现有拖拽交互、给出比原型更强的判断、数据零新增（实测门几何 R3-7 已经全量出来）。阈值拍板：**90°**（门要能开到底才叫能用，而非更宽松的 60°）。

> 术语注意：设计决策记录/14 里「黄灯阈值 90°」指的是「开不到 90° 就开始提示」这条**绿/黄分界线**；
> 代码里它叫「绿灯阈值 `door.openOkDeg=90`」（params.js 74），而「黄灯阈值」一词在代码里对应 `door.openWarnDeg=60`（黄/红分界线，params.js 75）。本文 §3.2 按代码口径表述。

### 接缝 B：开门角度听方案的还是听模型的 → **B2**

两个来源在打架（设计决策记录 §接缝B）：方案 `doorOpenAngle` 原型写死 1.85 rad=106°（所有型号同一个数），
模型实测 `openAngleDeg`（demo-freezer-chest 上盖 **−88.81°**）。判断——这两个数不是一回事：
**模型角度 = 几何上限**（机械结构决定），**方案角度 = 展示开度**（用户偏好，0~上限）。
所以不做二选一，而**各归其位**：

```
实际开度 = clamp(用户开度, 0, 模型上限)
doorAmount(0~1) 保留为 UI 概念，换算角度时乘模型上限
```

- 方案 `doorOpenAngle` 字段**保留但标 deprecated**（读入解释成 amount），**方案格式不升版**。
- 替代方案 B1（以方案值写死）**直接错**：demo-freezer-chest 上盖会被当成「绕 y 轴开 106°」——轴上就不对。
- 落地接口（设计决策记录 §定完之后）——**2026-10-10 就地改正**：这一行原来写的
  `product_model` 的 `open_angle_deg / hinge_x,y,z / swing_radius_mm / door_nodes` 四列
  与 `openableAngle()` / `doorSweep()` 两个函数**一个都不存在**（第 2 轮对抗式审查 dev-7；
  迁移里逐列搜过）。当时那句话写在"定完之后"，落地时走的是另一条路，而**这句没跟着改** ——
  于是后来的人按它去查列，会以为库坏了。实际情况是：

  | 原来写的 | 实际是什么 |
  | --- | --- |
  | `door_nodes` / `hinge_x,y,z` | 一列 `product_model.hinge_nodes`（JSON：每扇门的节点名与铰链轴/角） |
  | `open_angle_deg` / `swing_radius_mm` | 不是列：靠 `product.door_part` + 目录里的 `doors`（`openAngleRad`/pivot）与 `cfg.door.*` 参数算出来 |
  | `openableAngle(layout,itemId)` | `spatial-core/src/clearance.js` 的 `doorFreeAngle(layout, item, getProduct)`（配 `doorHingeAt` / `doorPlateAt`；逐度扫掠步长是参数 `door.sweepStepDeg`） |
  | `doorSweep(itemId)` | 同上（没有单独的 doorSweep 函数；扫掠在 `doorFreeAngle` 里） |

  门型确认状态另有 `product.door_verified` + `door_source` 两列（V9/V10）。

---

## ⑤ 门的几何

**三层分工**（都是纯函数）：
- `doors.js` — 门**语义**：铰链旋转公式、门型文案、开度换算；
- `clearance.js` — 门**扫掠**：开角 → 门板四角 → 撞谁（本文 §3.2）；
- 门数据本身来自 GLB 实测（`verify-models.py` 逐顶点量 → `doors.measured.js`，R4 起由 `product_model` 供数）。

**`door_part` 是什么**：门型代码，共 4 个，与 `product.door_part` 列同值（V8 口径）。
`DOOR_PART_LABELS = { single:'柜门', double:'双门', top:'上盖', drawer:'抽屉' }`（doors.js 51）。
**门型是产品事实**（厂家的叫法），不是几何的函数——实测证据：demo-freezer-dual 实测门只有 1 扇但产品本身是双门。

**门型优先级 `top > double > single > drawer`**（来源 app/src/admin/analyze.js `pickDoor()` 与 `DOOR_VARIANTS` 注释）：
有门的柜子即使柜内有抽屉，它也是「双门柜」——抽屉是柜内结构件，不是这个产品的门型（demo-freezer-dual 就这种：有门，也有 6 层抽屉）。

**铰链旋转公式（全项目唯一一份，doors.js 36）**：`rotation[axis] = hinge.openAngle × clampDoorAmount(amount)`（`clampDoorAmount` 夹取到 `amountMin~amountMax`）。

**扫掠几何**（clearance.js `doorPlateAt` / `doorFreeAngle`）：
门板 4 角点 = ① 绕铰链自转 `openDeg`（three.js 绕 +Y：局部 `(x,z)→(x·cosθ+z·sinθ, −x·sinθ+z·cosθ)`） ② 再按设备朝向转到房间。
**上盖（`axis !== 'y'`）不参与平面净空**：它往竖直方向扫，平面上不占地方 → 返回 `n/a`（clearance.js 122、126）。
**门能不能开是模型属性**（铰链来自模型配方 pivots 或节点 extras），不是 UI 判断（doors.js 头注释）；`canOpen(model)` = 模型是否有 `hinges`（doors.js 19），缺门体节点时给 `NO_HINGES` 原话（doors.js 16）。

---

## ⑥ 内核不许做的事（一句话一条，来自各处注释）

- **判据只在自己适用的条件下发声**：规则 1 只判「放得下」（越界/重叠/压内墙），「门打不开」是规则 7 的事，二者并列、互不阻断（clearance.js 头注释）。
- **上盖不参与平面净空**：`axis !== 'y'` 直接 `n/a`，不硬算一个平面角度（clearance.js 126）。
- **无实测门数据的型号返回 `null`，拒绝编造**：生成器遇到缺数据直接报错，不退回「前脸左端+柜宽」估算。
- **门型不看模型的样子猜**：它是产品事实，值住 `product.door_part` 那一列，不按型号名写死（doors.js `doorPartLabel` 注释）。
- **`cfg` 不许在导入期抄成常量**：一律在函数里读，否则改配置永远不生效（params.js 头注释）。
- **配置不许改一半**：一份补丁全量校验，任一项非法 → 整体不生效；未知键报错（params.js `validatePatch`）。
- **阈值不许写死在两处**：分级判据直接用 `level` / 读 `cfg`，「90」只住在参数表一处（clearance.js `clearanceLevel` / `doorTroubleClause` 注释）。
- **写入端与读取端不许各写一套限制**：`scheme.LIMITS` 全读参数表，保证「自己导出的文件自己导得回来」（scheme.js、FIX-05）。
- **漫游的两处已知缺陷不许悄悄改行为**：FIX-16/17 用断言钉住，修时必须显式改断言（collision.js 头注释）。
- **无操作不许静默**：`moveItem` 找不到 id 时 `console.warn` 出声（placement.js）；`doorPartLabel` 认不出的门型代码原样显示并吼一声（doors.js）。
- **导入检查顺序不许乱**：`scheme-errors` 用例把「6 类坏样本各报各的原因码」的顺序也当判据。