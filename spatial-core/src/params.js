/**
 * params.js —— 规则参数表（**唯一一份**）
 *
 * 目的：把"业务规则里的数字"从代码里搬出来变成**数据**。
 *
 * 为什么要这么做（三条，按重要性）：
 *  1. **同一件事只写一遍。** 这张表之前 `items/walls/room` 的上限在 `placement.js` 和 `scheme.js`
 *     各写了一份 —— 迟早打架（FIX-04 就是这么来的）。现在 `scheme.LIMITS` 读这里。
 *  2. **现场能改。** 阈值不该由程序员拍板：门开到底算 90° 还是 85°、自动摆放间距多少，
 *     是业务+现场经验。改配置不用改代码、不用重新发版。
 *  3. **后台有东西可管。** `PARAM_SPEC` 同时是**校验规则**、**后台表单定义**、**Java 侧基线**、
 *     也是给人看的说明（label/unit/help）。一份 spec 驱动四处，是这张表能不能长期活下来的关键。
 *
 * 用法：
 *   ```js
 *   import { cfg } from './params.js';        // 读：cfg.door.openOkDeg
 *   configure({ door: { openOkDeg: 85 } });   // 写：校验通过才整体生效，否则抛错（不半途改一半）
 *   ```
 *
 * ⚠️ 两条硬约束，改这个文件前必须先读：
 *  1. **`cfg` 是活引用，且 `configure()` 只做原地深合并**（不替换对象、不新建对象）。
 *     所以 `cfg.door.openOkDeg` 在任何时候读到的都是当前值 —— 模块里**不要在导入期把它
 *     抄进常量**（`const X = cfg.door.openOkDeg` 会让配置永远不生效）。一律在函数里读。
 *  2. **改参数 = 改业务语义**。参数一变，`test/cases/rules.json` 里钉住的数字可能就不成立了。
 *     所以参数表本身有单测（`test/params.test.js`），改了默认值必须显式改断言。
 */

/** 参数分组（后台按这个分栏） */
export const PARAM_GROUPS = {
  room: { label: '空间尺寸', help: '房间长宽高的允许范围' },
  space: { label: '几何口径', help: '判定"放得下"用的几何量：容差、墙厚、吸附步长' },
  layout: { label: '布置规则', help: '数量上限与自动摆放的间距' },
  column: { label: '结构柱', help: '矩形结构柱的尺寸/数量口径（docs/101 §二）' },
  scheme: { label: '方案文件', help: '导入导出的限制（写入端/读取端共用一份）' },
  door: { label: '设备柜门净空', help: '**设备柜门**能开多大算"能用"（见 docs/14 规则 7；与建筑门洞无关）' },
  opening: { label: '洞口（门洞 / 窗）', help: '建筑洞口（墙上的开口）的默认尺寸与放置规则 —— 与设备柜门 cfg.door.* 是两回事。门洞与窗共用这一组里的 `wallEdgeGapM`（离墙角间隙＝框要有安装面，是同一个物理量，禁止双真源）' },
  window: { label: '窗', help: '矩形窗（墙上的洞口 + 离地高度）的默认尺寸与放置规则 —— 与门洞共用同一套洞口机制，但窗**不能走人**（不挖碰撞），见 docs/78 §三' },
  walk: { label: '第一人称漫游', help: '走进房间时的碰撞与视角参数' },
  route: { label: '动线', help: '人员地面动线（P1 内核）：数量、拐点上限、寻路栅格与长度护栏' },
  model: { label: '模型资产', help: '模型验收阈值（与 docs/07 交付规范一致）' },
  history: { label: '撤销重做', help: '历史栈深度' },
};

/**
 * 参数规格表：**这份表就是一切**（校验 / 后台表单 / Java 基线 / 说明书）。
 * `path` 是 `组.键`；`admin: false` 表示"不建议在后台改"（改之前得先想清楚影响面）。
 */
export const PARAM_SPEC = [
  // ── 空间尺寸 ──
  { path: 'room.minW', default: 3, label: '最小长度', unit: 'm', min: 1, max: 100, step: 0.1, admin: true, help: '房间长度下限' },
  { path: 'room.maxW', default: 20, label: '最大长度', unit: 'm', min: 1, max: 200, step: 0.1, admin: true, help: '房间长度上限' },
  { path: 'room.minD', default: 3, label: '最小宽度', unit: 'm', min: 1, max: 100, step: 0.1, admin: true, help: '房间宽度下限' },
  { path: 'room.maxD', default: 20, label: '最大宽度', unit: 'm', min: 1, max: 200, step: 0.1, admin: true, help: '房间宽度上限' },
  { path: 'room.minH', default: 2, label: '最小层高', unit: 'm', min: 1, max: 20, step: 0.1, admin: true, help: '墙高下限' },
  { path: 'room.maxH', default: 5, label: '最大层高', unit: 'm', min: 1, max: 20, step: 0.1, admin: true, help: '墙高上限' },
  { path: 'room.nameMaxChars', default: 12, label: '房间名长度', unit: '字', min: 2, max: 40, step: 1, admin: true, help: '房间名最多多少个字（多房间后才有房间名；默认名「未命名房间」不计）' },
  { path: 'room.minAreaM2', default: 0.5, label: '窄缝阈值', unit: '㎡', min: 0, max: 10, step: 0.1, admin: true, help: '小于这个面积的房面在列表里标成「窄缝」——**只标不藏**（两面墙贴太近会挤出一条缝）' },

  // ── 几何口径 ──
  { path: 'space.overlapTolM', default: 0.005, label: '重叠容差', unit: 'm', min: 0, max: 0.05, step: 0.001, admin: true, help: '两台设备占地矩形重叠多少以内不算重叠（5 mm）' },
  { path: 'space.wallThicknessM', default: 0.12, label: '墙厚', unit: 'm', min: 0.05, max: 0.5, step: 0.01, admin: true, help: '内墙在平面上的厚度，压墙判定与建模都用它' },
  { path: 'space.snapM', default: 0.1, label: '位置吸附', unit: 'm', min: 0.01, max: 1, step: 0.01, admin: true, help: '拖动时位置吸附到多少的整数倍' },
  { path: 'space.rotateStepDeg', default: 5, label: '旋转步长', unit: '°', min: 1, max: 45, step: 1, admin: true, help: '按一下旋转键转多少度' },
  { path: 'space.wallOpacity', default: 1, label: '外墙默认不透明度', unit: '', min: 0.2, max: 1, step: 0.05, admin: true, help: '"没选过外观档位"的方案用这个（1 = 实心）。半透明是让交付图更好看的美观选项，档位本身在方案里存的是 solid/half/light' },

  // ── 布置规则 ──
  { path: 'layout.maxItems', default: 100, label: '设备上限', unit: '台', min: 1, max: 500, step: 1, admin: true, help: '一个方案最多放几台（原型 100，性能与方案文件大小都吃这个）' },
  { path: 'layout.maxWalls', default: 100, label: '内墙上限', unit: '面', min: 1, max: 500, step: 1, admin: true, help: '一个方案最多几面内墙' },
  { path: 'layout.autoZ0', default: 0.7, label: '自动摆放起始边距', unit: 'm', min: 0, max: 5, step: 0.1, admin: true, help: '自动摆放时第一台的边距' },
  { path: 'layout.autoDz', default: 1.1, label: '自动摆放行距', unit: 'm', min: 0.2, max: 5, step: 0.1, admin: true, help: '自动摆放相邻两台的间距' },
  { path: 'layout.autoX0', default: 0.7, label: '自动摆放起始横向边距', unit: 'm', min: 0, max: 5, step: 0.1, admin: true, help: '（原型按行列网格摆放，横向与纵向分别有起始值）' },
  { path: 'layout.autoDx', default: 1.2, label: '自动摆放列距', unit: 'm', min: 0.2, max: 5, step: 0.1, admin: true, help: '自动摆放同排相邻两台的间距' },
  { path: 'layout.autoMargin', default: 0.5, label: '自动摆放末端留白', unit: 'm', min: 0, max: 5, step: 0.1, admin: true, help: '离墙留出的空当，保证不会一摆就压墙' },

  // ── 结构柱（W5，docs/101 §二）──
  // 尺寸先按 1 mm 取整再比较；柱-墙允许重叠，柱-柱/设备/洞口不允许。
  { path: 'column.minSideM', default: 0.2, label: '柱最小边长', unit: 'm', min: 0.05, max: 1, step: 0.01, admin: true, help: '矩形柱任一边的下限（0.20 m）；小于它的柱在结构上不成立' },
  { path: 'column.maxSideM', default: 3, label: '柱最大边长', unit: 'm', min: 0.5, max: 10, step: 0.1, admin: true, help: '矩形柱任一边的上限（3.00 m）；更大的构件按墙体处理' },
  { path: 'column.maxCount', default: 50, label: '柱数量上限', unit: '根', min: 1, max: 200, step: 1, admin: true, help: '一个方案最多几根柱；入口禁用并说明，导入超限整份拒绝' },
  { path: 'column.defaultSideM', default: 0.5, label: '柱默认边长', unit: 'm', min: 0.2, max: 3, step: 0.05, admin: true, help: '单击放置时默认的 0.5×0.5 m；拖两角画则按实际矩形' },

  // ── 方案文件 ──
  { path: 'scheme.maxFileBytes', default: 1_000_000, label: '导入文件上限', unit: 'B', min: 10_000, max: 50_000_000, step: 1000, admin: true, help: '导入方案文件的字节上限' },
  { path: 'scheme.maxCoordM', default: 22, label: '坐标绝对值上限', unit: 'm', min: 5, max: 200, step: 1, admin: true, help: '读文件时拒绝这个范围外的坐标（房间最大 20 m，留 2 m 余量）' },
  { path: 'scheme.minWallLengthM', default: 0.1, label: '最短墙长', unit: 'm', min: 0.01, max: 2, step: 0.01, admin: true, help: '比这更短的墙直接拒绝（画不出、也没意义）' },

  // ── 设备柜门净空（规则 7）──
  // ⚠️ 这一组说的**全是设备自己的柜门**（绕着铰链扫掠的那块）。建筑门洞是另一组 `opening.*` ——
  //    两个"门"业务语义、几何对象、消费链路都不同，名字上必须一眼分得开（docs/66 §四）。
  { path: 'door.openOkDeg', default: 90, label: '绿灯阈值', unit: '°', min: 0, max: 180, step: 1, admin: true, help: '柜门能开到这么大就算"不受阻"。用户 2026-09-21 拍板 90°：门要能开到底才叫能用' },
  { path: 'door.openWarnDeg', default: 60, label: '黄灯阈值', unit: '°', min: 0, max: 180, step: 1, admin: true, help: '柜门：低于绿灯阈值、高于这个值 → 黄灯（能开但会挡）' },
  { path: 'door.sweepStepDeg', default: 1, label: '扫掠步长', unit: '°', min: 0.5, max: 15, step: 0.5, admin: false, help: '逐度扫掠的精度。调粗会算得快但角度偏小，Java 侧必须同口径' },
  { path: 'door.freeTolDeg', default: 0.5, label: '扫掠容差', unit: '°', min: 0, max: 5, step: 0.1, admin: false, help: '判定"这一帧撞上了"的几何容差' },
  { path: 'door.amountMin', default: 0, label: '关门位置', unit: '', min: 0, max: 1, step: 0.05, admin: false, help: '开门比例的闭端（原型 0=关）' },
  { path: 'door.amountMax', default: 1, label: '全开位置', unit: '', min: 0, max: 1, step: 0.05, admin: false, help: '开门比例的开端（原型 1=全开）' },

  // ── 门洞（建筑门洞 = 墙上的洞口；与上面那组"设备柜门"无关）──
  // 默认值依据：单开 0.90 m / 2.10 m 取国标常用模数（无障碍门下界 GB 50763-2012 §3.5.3 是 0.90 m；
  // 疏散门 ≥2.0 m GB 50016 §5.5.18）。**诚实声明**：没有"医用设备存储间门"的专项标准，
  // 本项目的实际场景是中小型可移动设备（存储冰箱/离心机）的存储操作间，0.9 m 是够用的下沿。
  { path: 'opening.defaultWidthM', default: 0.9, label: '门洞默认净宽', unit: 'm', min: 0.6, max: 3, step: 0.05, admin: true, help: '新放的门洞默认多宽。用户 2026-10-09 拍板 0.9 m（无障碍门下界，设备推行够用）' },
  { path: 'opening.defaultHeightM', default: 2.1, label: '门洞默认净高', unit: 'm', min: 1.8, max: 3.5, step: 0.05, admin: true, help: '新放的门洞默认多高（国标门高常用模数 2.1 m）' },
  { path: 'opening.minWidthM', default: 0.6, label: '门洞最小净宽', unit: 'm', min: 0.3, max: 2, step: 0.05, admin: true, help: '净宽下限：0.6 m 是侧身通行极限（肩宽 0.48 + 余量），更窄的洞在漫游里过不去' },
  { path: 'opening.maxWidthM', default: 3, label: '门洞最大净宽', unit: 'm', min: 1, max: 6, step: 0.05, admin: true, help: '净宽上限：更宽的开口在建筑上算"通道"不算门' },
  { path: 'opening.wallEdgeGapM', default: 0.1, label: '离墙角最小间隙', unit: 'm', min: 0, max: 1, step: 0.05, admin: true, help: '洞口边缘离墙端（墙角/T 形接头）至少留多少 —— 门框要有安装面。**无国标条文**，工程惯例' },
  { path: 'opening.maxPerWall', default: 3, label: '每墙门洞上限', unit: '个', min: 1, max: 10, step: 1, admin: true, help: '一面墙上最多几个洞（超过会让墙段碎片化）。**无外部依据**，工程判断' },
  { path: 'opening.frameThicknessM', default: 0, label: '门框厚度', unit: 'm', min: 0, max: 0.2, step: 0.005, admin: false, help: '预留项（v1 未启用，改了不会有效果，所以标为不可改）：门框每侧厚度。v1 不做门框所以默认 0（净宽 = 洞宽）；做门框时只改这个默认值 + 一处减法' },

  // ── 窗（W2 矩形窗 = 墙上的洞口 + 离地高度；与门洞共用同一套机制）──
  // 依据（**诚实标注**，本次查证）：GB/T 5824-2021《建筑门窗洞口尺寸系列》建立「标志宽高采用
  // 3M/6M 模数制」并给出民用建筑窗洞口优先尺寸 —— 1200 / 1500 都是 3M（300 的整数倍）里最常用的两档。
  // 离地 0.90 m 出自 GB 50096-2011《住宅设计规范》§3.9.1：外窗窗台距楼面/地面高度**低于 0.90 m 时
  // 应设防护设施** —— 取 0.90 恰好是「免设防护」的临界值（本项目不是住宅，这是工程上稳妥的下沿，
  // 不是「标准规定必须 0.9」）。25 / 16 两条**无国标条文**，是工程判断，已在 help 里写明。
  { path: 'window.defaultWidthM', default: 1.2, label: '窗默认净宽', unit: 'm', min: 0.3, max: 6, step: 0.05, admin: true, help: '新放的窗默认多宽（1.20 m = 3M 模数，GB/T 5824-2021 民用建筑窗洞口优先尺寸里最常用的一档）' },
  { path: 'window.defaultHeightM', default: 1.5, label: '窗默认净高', unit: 'm', min: 0.3, max: 6, step: 0.05, admin: true, help: '新放的窗默认多高（1.50 m = 3M 模数；窗台 0.9 + 窗高 1.5 = 2.4 m，常规层高下梁下还留得住）' },
  { path: 'window.defaultSillM', default: 0.9, label: '窗默认离地高度', unit: 'm', min: 0, max: 2.5, step: 0.05, admin: true, help: '新放的窗默认离地多高（从**地面**量到洞口**下沿**）。0.90 m 出自 GB 50096-2011 §3.9.1 的防护临界值' },
  { path: 'window.minWidthM', default: 0.6, label: '窗最小净宽', unit: 'm', min: 0.2, max: 2, step: 0.05, admin: true, help: '窗净宽下限（0.6 m 是小窗的常见工程规格）。**它不影响碰撞** —— 窗本来就不能走人，窄一点没有通行问题' },
  { path: 'window.maxWidthM', default: 3, label: '窗最大净宽', unit: 'm', min: 0.6, max: 6, step: 0.05, admin: true, help: '窗净宽上限：更宽的洞口由门窗生产企业按分格处理，不在本工具口径内' },
  { path: 'window.minSillM', default: 0.3, label: '窗最小离地高度', unit: 'm', min: 0, max: 1.2, step: 0.05, admin: true, help: '离地下限：低于 0.3 m 的洞人一步就跨过去了，按建筑口径它该叫门。**无国标条文**，工程判断' },
  { path: 'window.maxSillM', default: 2.5, label: '窗最大离地高度', unit: 'm', min: 0.6, max: 3.5, step: 0.05, admin: true, help: '离地上限（策略护栏，防「贴到墙顶的窗」）；真正管住上限的是结构约束「离地 + 净高 ≤ 墙高」。**无国标条文**' },
  { path: 'window.maxPerWall', default: 3, label: '每墙窗上限', unit: '个', min: 1, max: 10, step: 1, admin: true, help: '一面墙上最多几扇窗（与门洞**各算各的**：同一面墙可以 3 门 + 3 窗；格式总上限仍是每墙 10 个洞口）。**无外部依据**，工程判断' },

  // ── 第一人称漫游 ──
  { path: 'walk.radiusM', default: 0.24, label: '人体半径', unit: 'm', min: 0.1, max: 0.6, step: 0.01, admin: true, help: '漫游碰撞用的圆柱半径（0.24 m，肩宽级别）' },
  { path: 'walk.eyeM', default: 1.6, label: '视点高度', unit: 'm', min: 1.2, max: 2, step: 0.05, admin: true, help: '第一人称的眼睛高度（原来是写在 scene3d.js 里的硬编码 1.6，抬进参数表才符合"参数表是唯一真源"）' },
  { path: 'walk.wallClearanceM', default: 0.06, label: '离墙间隙', unit: 'm', min: 0, max: 0.3, step: 0.01, admin: true, help: '贴墙走时额外留的余量' },
  { path: 'walk.doorBarrierMinM', default: 0.08, label: '门挡人下界', unit: 'm', min: 0, max: 1, step: 0.01, admin: true, help: '门只在人体高度区间内算障碍：低于这个高度（如底座缝）不挡人' },
  { path: 'walk.doorBarrierMaxM', default: 1.8, label: '门挡人上界', unit: 'm', min: 0.5, max: 3, step: 0.05, admin: true, help: '高于这个高度（如顶盖）不挡人' },
  { path: 'walk.stepMaxM', default: 0.06, label: '单步最大位移', unit: 'm', min: 0.01, max: 0.5, step: 0.01, admin: false, help: '移动时把位移切成小步做连续碰撞检测（防穿模）' },
  { path: 'walk.spawnStepM', default: 0.35, label: '出生点扫描步长', unit: 'm', min: 0.1, max: 2, step: 0.05, admin: false, help: '找站立位置时的网格扫描步长' },

  // ── 动线（P1 内核；docs/97 §四冻结 6 条 × 20 个用户点）──
  { path: 'route.maxRoutes', default: 6, label: '动线数量上限', unit: '条', min: 1, max: 20, step: 1, admin: true, help: '一个方案最多几条动线（v1 冻结 6 条；超过只做防御）' },
  { path: 'route.maxPoints', default: 20, label: '单条动线拐点上限', unit: '个', min: 2, max: 64, step: 1, admin: true, help: '一条动线最多几个用户点（v1 冻结 20；docs/96 的 64 只作防御上限）' },
  { path: 'route.gridM', default: 0.1, label: '寻路栅格', unit: 'm', min: 0.05, max: 0.5, step: 0.01, admin: true, help: 'A* 栅格边长（0.10 m）。改小更精确但更慢；网格只负责找路，合法性由精确几何复核' },
  { path: 'route.arrowEveryM', default: 1.5, label: '箭头间距', unit: 'm', min: 0.3, max: 10, step: 0.1, admin: true, help: '2D/3D 地面箭头每隔多远一个（P2/P3 用；P1 只提供参数）' },
  { path: 'route.maxLengthM', default: 500, label: '动线长度上限', unit: 'm', min: 10, max: 2000, step: 10, admin: true, help: '路径总长超过这个数就报 route-too-long（防异常布局把规划线画到离谱）' },
  { path: 'route.minAnchorGapM', default: 0.05, label: '相邻用户点最小间距', unit: 'm', min: 0.01, max: 1, step: 0.01, admin: true, help: '两个相邻用户点距离小于这个值视为重复点，整条动线拒绝（不静默合并）' },

  // ── 模型资产 ──
  { path: 'model.anisotropyWarn', default: 1.02, label: '比例失真告警', unit: '倍', min: 1, max: 2, step: 0.01, admin: true, help: '按包围盒缩放时各轴比例差超过这个倍数就告警（2%）：尺寸不可信的信号' },
  { path: 'model.envelopeTolMm', default: 1, label: '尺寸对账容差', unit: 'mm', min: 0, max: 50, step: 1, admin: true, help: '1:1 模型的声明尺寸与实测尺寸**逐轴**相差这么多 mm 以内算对账通过。维护端角标、写入侧判定与设计端加载体检共用这一把尺子（第 3 轮审查 C-10：原来是 1 mm 与 5 mm 两个数，同一个模型在两处得到相反结论）' },

  // ── 撤销重做 ──
  { path: 'history.maxSteps', default: 40, label: '历史深度', unit: '步', min: 1, max: 500, step: 1, admin: true, help: '最多能撤销多少步（原型 40）' },
];

function buildDefaults(spec) {
  const out = {};
  for (const e of spec) {
    const [g, k] = e.path.split('.');
    if (!out[g]) out[g] = {};
    out[g][k] = e.default;
  }
  return out;
}

const BY_PATH = new Map(PARAM_SPEC.map((e) => [e.path, e]));

/**
 * 当前生效的参数（**活引用**）。
 * 读：`cfg.door.openOkDeg`。不要把它整体存下来当快照用 —— 它随时会被 configure 改。
 */
export const cfg = buildDefaults(PARAM_SPEC);

/**
 * 「1:1 尺寸对账」的**逐轴容差（mm）** —— `model.envelopeTolMm` 的唯一读取方。
 *
 * 为什么放在核心层而不是某个界面文件：**维护端与三维端都要读它**
 * （写入侧 `admin/analyze.js` 算 `envelope_ok`、加载体检 `scene3d.js` 重判 `sizeOk`），
 * 放这里才可能只有一处。第 3 轮审查 `C-10`：原来是写入侧 1 mm、设计端 5 mm 两个数，
 * 声明 990 / 实测 994.5 的模型在维护端挂「尺寸未对账」、在设计端却报合格 ——
 * 同一个模型两处相反结论，`AGENTS.md` §5 的「两边结论一致」就没满足。
 *
 * 读不到（旧快照 / 缺这一项）就退回出厂值：**缺一项不许把整个体检判死** ——
 * 那会变成「处处不合格」，比漏报更难查。
 */
export function envelopeTolMm() {
  const v = Number(cfg.model && cfg.model.envelopeTolMm);
  return Number.isFinite(v) && v >= 0 ? v : 1;
}

export function param(path) {
  const e = BY_PATH.get(path);
  if (!e) throw new Error(`未知参数：${path}（参数表里没有这一项，先加 PARAM_SPEC）`);
  return cfg[path.split('.')[0]][path.split('.')[1]];
}

/** 参数表的默认值（深拷贝，改它不影响生效值） */
export function defaultParams() {
  return JSON.parse(JSON.stringify(buildDefaults(PARAM_SPEC)));
}

/** 当前生效值的快照（存后台 / 导出 / 日志用） */
export function snapshot() {
  return JSON.parse(JSON.stringify(cfg));
}

/** 规格 → 后台表单可用的结构（分组 + 每项的 label/unit/范围/说明） */
export function schema() {
  return {
    version: 1,
    groups: Object.entries(PARAM_GROUPS).map(([id, g]) => ({
      id,
      label: g.label,
      help: g.help,
      params: PARAM_SPEC.filter((e) => e.path.startsWith(id + '.')).map((e) => ({
        path: e.path,
        key: e.path.split('.')[1],
        label: e.label,
        unit: e.unit,
        min: e.min,
        max: e.max,
        step: e.step,
        admin: e.admin,
        help: e.help,
        default: e.default,
      })),
    })),
  };
}

/**
 * 校验一份补丁，**不改任何东西**。返回 `{ ok, errors }`。
 *
 * 这里必须严：配置错了不能静默生效，也不能"改一半生效一半"。
 * 未知键一律报错 —— 后台把 `openOkDeg` 写成 `openOKDeg` 时，静默无效是最坏的结果。
 */
export function validatePatch(patch, opts) {
  // `allowNonAdmin`：**"能不能在后台改"这道门是在写端（发布接口）上的，不是装配置时的主要判据**。
  // 前端启动时要把服务端发来的**整份生效值**装进内核，那份里当然包含 `admin:false` 的项
  // —— 用表单那条规则去拦它，整份都会被拒、内核退回默认值，而界面上什么都不对劲。
  // 实测就撞过这一次：页面 console 里一条「参数不合法（6 处）：… 不允许改」，
  // 然后 15° 一档的旋转照旧按 5° 转（**"看着能配、其实没生效"**）。
  const allowNonAdmin = !!(opts && opts.allowNonAdmin);
  const errors = [];
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: [{ path: '', message: '参数必须是对象（如 { door: { openOkDeg: 85 } }）' }] };
  }
  for (const [g, fields] of Object.entries(patch)) {
    if (!PARAM_GROUPS[g]) {
      errors.push({ path: g, message: `未知分组：${g}（可用：${Object.keys(PARAM_GROUPS).join(' / ')}）` });
      continue;
    }
    if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
      errors.push({ path: g, message: `分组 ${g} 必须是对象` });
      continue;
    }
    for (const [k, v] of Object.entries(fields)) {
      const path = `${g}.${k}`;
      const e = BY_PATH.get(path);
      if (!e) {
        errors.push({ path, message: `未知参数：${path}（${PARAM_GROUPS[g].label} 里没有这一项）` });
        continue;
      }
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        errors.push({ path, message: `${path} 必须是数字，收到 ${JSON.stringify(v)}` });
        continue;
      }
      if (v < e.min || v > e.max) {
        errors.push({ path, message: `${path}（${e.label}）超出范围：${v} 不在 ${e.min}~${e.max}${e.unit} 之间` });
        continue;
      }
      if (!e.admin && !allowNonAdmin) {
        errors.push({ path, message: `${path}（${e.label}）不允许改：${e.help}` });
      }
    }
  }

  // 跨字段规则：单看每一项都合法，但组合起来是错的
  const ok = 'door' in patch ? patch.door.openOkDeg ?? cfg.door.openOkDeg : cfg.door.openOkDeg;
  const warn = 'door' in patch ? patch.door.openWarnDeg ?? cfg.door.openWarnDeg : cfg.door.openWarnDeg;
  if (typeof ok === 'number' && typeof warn === 'number' && warn > ok) {
    errors.push({ path: 'door.openWarnDeg', message: `黄灯阈值（${warn}°）不能高于绿灯阈值（${ok}°）—— 否则"黄灯"这个级别就没意义了` });
  }
  if (typeof ok === 'number' && typeof warn === 'number' && warn === ok) {
    errors.push({ path: 'door.openWarnDeg', message: '黄灯阈值与绿灯阈值相同：等于取消了黄灯级别（要取消请把黄灯设为 0）' });
  }
  return { ok: errors.length === 0, errors };
}

/** 校验失败时抛的错误：带上所有问题，便于后台一次显示全 */
export class ParamError extends Error {
  constructor(errors) {
    super(`参数不合法（${errors.length} 处）：\n` + errors.map((e) => `  · ${e.message}`).join('\n'));
    this.name = 'ParamError';
    this.errors = errors;
  }
}

/**
 * 应用一份补丁：**先整体校验，通过才原地生效**。
 *
 * `opts.allowNonAdmin`：装**服务端发布的整份生效值**时传 true（见 `validatePatch` 的注释）。
 * 后台表单/发布那条路**不要**传 —— 那里必须继续拦住"不允许在后台改"的项。
 * 原地（in-place）= 只改 `cfg` 里已有的字段值，不替换 `cfg` 本身，也不替换任何子对象 ——
 * 这样所有模块持有的 `cfg` 引用永远有效，不需要重新 import。
 * @throws {ParamError} 有任何一处不合法
 */
export function configure(patch, opts) {
  const { ok, errors } = validatePatch(patch, opts);
  if (!ok) throw new ParamError(errors);
  for (const [g, fields] of Object.entries(patch)) {
    for (const [k, v] of Object.entries(fields)) cfg[g][k] = v;
  }
  return cfg;
}

/**
 * Java `String.hashCode()` 的等价实现（**必须是同一个数**，所以逐位照抄）。
 * Java 的 int 是 32 位回绕，所以这里每步都 `| 0`。
 */
function javaHashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h;
}

/**
 * 值的规范化写法 —— **两边必须写出一模一样的字符串**，否则同一个配置会算出两个指纹。
 * 取 `String(v)`：`3` → `"3"`、`0.005` → `"0.005"`、`1000000` → `"1000000"`。
 * （参数表里全是数字，所以这一条够用；将来真加了布尔/字符串，这里和 Java 侧一起改。）
 */
function canonicalValue(v) {
  return String(v);
}

/**
 * 参数表指纹：**这套结论是在哪一版规则参数下算出来的**。
 *
 * 输入 = 按 `PARAM_SPEC` 顺序的 `path=生效值` 列表（**注意是生效值，不是默认值**）。
 * 算法 = 照抄 Java 侧 `Params.fingerprint()`：`h = 17; for (s of list) h = h*31 + s.hashCode();`，
 * 最后 `& 0x7fffffff` 取正。
 *
 * ⚠️ 三条必须一起读：
 *  1. **必须与 Java 侧算出同一个数** —— 方案落库时是 Java 写的 `params_rev`，
 *     前端和内核缓存键用的是这里的值，两边不一致就等于"同一个配置有两个指纹"，
 *     而这种错**不会报错**，只会让缓存莫名失效或复现不出来。
 *  2. 所以两边各有一条**钉住同一个字面量**的测试（默认配置 = `1831018939`）。
 *  3. 不手工维护版本号（人一定会忘记加一），所以取散列 —— **改一个数，指纹就变**。
 *
 * @param {object} [values] 要算指纹的那份值（默认用当前生效值 `cfg`）
 */
export function fingerprint(values) {
  const v = values || cfg;
  let h = 17;
  for (const e of PARAM_SPEC) {
    const [g, k] = e.path.split('.');
    h = (Math.imul(31, h) + javaHashCode(e.path + '=' + canonicalValue(v[g][k]))) | 0;
  }
  return h & 0x7fffffff;
}

/** 恢复出厂默认（同样原地改，不是换对象） */
export function resetParams() {
  const d = buildDefaults(PARAM_SPEC);
  for (const g of Object.keys(cfg)) for (const k of Object.keys(cfg[g])) cfg[g][k] = d[g][k];
  return cfg;
}