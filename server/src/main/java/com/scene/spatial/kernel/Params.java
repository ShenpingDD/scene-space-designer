package com.scene.spatial.kernel;

/**
 * Params.java —— 规则参数的 Java 侧基线（**由 tools/server/gen-java-data.mjs 生成，勿手改**）
 *
 * 来源：config/params.default.json  sha256(前16)=cd51712fc3e3e49b（← spatial-core/src/params.js 的 PARAM_SPEC）
 * 每行注释里的路径就是参数表里的原始 path —— 改参数时**两边都要改**，所以这里保留可追溯的出处。
 * 重新生成：node tools/server/gen-java-data.mjs
 *
 * 与 JS 侧的差别：JS 的 cfg 是**活引用**（改配置立即生效）；这里是**编译期基线**（默认值）。
 * 上线后参数由 app_config 表供数，这个类退化成"没配就用默认值"的那一层。
 */
public final class Params {

  private Params() {}

  // ── room ─────────────────────────────────────────
  public static final int roomMinW = 3;  // room.minW [m] 房间长度下限
  public static final int roomMaxW = 20;  // room.maxW [m] 房间长度上限
  public static final int roomMinD = 3;  // room.minD [m] 房间宽度下限
  public static final int roomMaxD = 20;  // room.maxD [m] 房间宽度上限
  public static final int roomMinH = 2;  // room.minH [m] 墙高下限
  public static final int roomMaxH = 5;  // room.maxH [m] 墙高上限
  public static final int roomNameMaxChars = 12;  // room.nameMaxChars [字] 房间名最多多少个字（多房间后才有房间名；默认名「未命名房间」不计）
  public static final double roomMinAreaM2 = 0.5;  // room.minAreaM2 [㎡] 小于这个面积的房面在列表里标成「窄缝」——**只标不藏**（两面墙贴太近会挤出一条缝）
  // ── space ─────────────────────────────────────────
  public static final double spaceOverlapTolM = 0.005;  // space.overlapTolM [m] 两台设备占地矩形重叠多少以内不算重叠（5 mm）
  public static final double spaceWallThicknessM = 0.12;  // space.wallThicknessM [m] 内墙在平面上的厚度，压墙判定与建模都用它
  public static final double spaceSnapM = 0.1;  // space.snapM [m] 拖动时位置吸附到多少的整数倍
  public static final int spaceRotateStepDeg = 5;  // space.rotateStepDeg [°] 按一下旋转键转多少度
  public static final int spaceWallOpacity = 1;  // space.wallOpacity "没选过外观档位"的方案用这个（1 = 实心）。半透明是让交付图更好看的美观选项，档位本身在方案里存的是 solid/half/light
  // ── layout ─────────────────────────────────────────
  public static final int layoutMaxItems = 100;  // layout.maxItems [台] 一个方案最多放几台（原型 100，性能与方案文件大小都吃这个）
  public static final int layoutMaxWalls = 100;  // layout.maxWalls [面] 一个方案最多几面内墙
  public static final double layoutAutoZ0 = 0.7;  // layout.autoZ0 [m] 自动摆放时第一台的边距
  public static final double layoutAutoDz = 1.1;  // layout.autoDz [m] 自动摆放相邻两台的间距
  public static final double layoutAutoX0 = 0.7;  // layout.autoX0 [m] （原型按行列网格摆放，横向与纵向分别有起始值）
  public static final double layoutAutoDx = 1.2;  // layout.autoDx [m] 自动摆放同排相邻两台的间距
  public static final double layoutAutoMargin = 0.5;  // layout.autoMargin [m] 离墙留出的空当，保证不会一摆就压墙
  // ── column ─────────────────────────────────────────
  public static final double columnMinSideM = 0.2;  // column.minSideM [m] 矩形柱任一边的下限（0.20 m）；小于它的柱在结构上不成立
  public static final int columnMaxSideM = 3;  // column.maxSideM [m] 矩形柱任一边的上限（3.00 m）；更大的构件按墙体处理
  public static final int columnMaxCount = 50;  // column.maxCount [根] 一个方案最多几根柱；入口禁用并说明，导入超限整份拒绝
  public static final double columnDefaultSideM = 0.5;  // column.defaultSideM [m] 单击放置时默认的 0.5×0.5 m；拖两角画则按实际矩形
  // ── scheme ─────────────────────────────────────────
  public static final int schemeMaxFileBytes = 1000000;  // scheme.maxFileBytes [B] 导入方案文件的字节上限
  public static final int schemeMaxCoordM = 22;  // scheme.maxCoordM [m] 读文件时拒绝这个范围外的坐标（房间最大 20 m，留 2 m 余量）
  public static final double schemeMinWallLengthM = 0.1;  // scheme.minWallLengthM [m] 比这更短的墙直接拒绝（画不出、也没意义）
  // ── door ─────────────────────────────────────────
  public static final int doorOpenOkDeg = 90;  // door.openOkDeg [°] 柜门能开到这么大就算"不受阻"。用户 2026-09-21 拍板 90°：门要能开到底才叫能用
  public static final int doorOpenWarnDeg = 60;  // door.openWarnDeg [°] 柜门：低于绿灯阈值、高于这个值 → 黄灯（能开但会挡）
  public static final int doorSweepStepDeg = 1;  // door.sweepStepDeg [°] 逐度扫掠的精度。调粗会算得快但角度偏小，Java 侧必须同口径
  public static final double doorFreeTolDeg = 0.5;  // door.freeTolDeg [°] 判定"这一帧撞上了"的几何容差
  public static final int doorAmountMin = 0;  // door.amountMin 开门比例的闭端（原型 0=关）
  public static final int doorAmountMax = 1;  // door.amountMax 开门比例的开端（原型 1=全开）
  // ── opening ─────────────────────────────────────────
  public static final double openingDefaultWidthM = 0.9;  // opening.defaultWidthM [m] 新放的门洞默认多宽。用户 2026-10-09 拍板 0.9 m（无障碍门下界，设备推行够用）
  public static final double openingDefaultHeightM = 2.1;  // opening.defaultHeightM [m] 新放的门洞默认多高（国标门高常用模数 2.1 m）
  public static final double openingMinWidthM = 0.6;  // opening.minWidthM [m] 净宽下限：0.6 m 是侧身通行极限（肩宽 0.48 + 余量），更窄的洞在漫游里过不去
  public static final int openingMaxWidthM = 3;  // opening.maxWidthM [m] 净宽上限：更宽的开口在建筑上算"通道"不算门
  public static final double openingWallEdgeGapM = 0.1;  // opening.wallEdgeGapM [m] 洞口边缘离墙端（墙角/T 形接头）至少留多少 —— 门框要有安装面。**无国标条文**，工程惯例
  public static final int openingMaxPerWall = 3;  // opening.maxPerWall [个] 一面墙上最多几个洞（超过会让墙段碎片化）。**无外部依据**，工程判断
  public static final int openingFrameThicknessM = 0;  // opening.frameThicknessM [m] 预留项（v1 未启用，改了不会有效果，所以标为不可改）：门框每侧厚度。v1 不做门框所以默认 0（净宽 = 洞宽）；做门框时只改这个默认值 + 一处减法
  // ── window ─────────────────────────────────────────
  public static final double windowDefaultWidthM = 1.2;  // window.defaultWidthM [m] 新放的窗默认多宽（1.20 m = 3M 模数，GB/T 5824-2021 民用建筑窗洞口优先尺寸里最常用的一档）
  public static final double windowDefaultHeightM = 1.5;  // window.defaultHeightM [m] 新放的窗默认多高（1.50 m = 3M 模数；窗台 0.9 + 窗高 1.5 = 2.4 m，常规层高下梁下还留得住）
  public static final double windowDefaultSillM = 0.9;  // window.defaultSillM [m] 新放的窗默认离地多高（从**地面**量到洞口**下沿**）。0.90 m 出自 GB 50096-2011 §3.9.1 的防护临界值
  public static final double windowMinWidthM = 0.6;  // window.minWidthM [m] 窗净宽下限（0.6 m 是小窗的常见工程规格）。**它不影响碰撞** —— 窗本来就不能走人，窄一点没有通行问题
  public static final int windowMaxWidthM = 3;  // window.maxWidthM [m] 窗净宽上限：更宽的洞口由门窗生产企业按分格处理，不在本工具口径内
  public static final double windowMinSillM = 0.3;  // window.minSillM [m] 离地下限：低于 0.3 m 的洞人一步就跨过去了，按建筑口径它该叫门。**无国标条文**，工程判断
  public static final double windowMaxSillM = 2.5;  // window.maxSillM [m] 离地上限（策略护栏，防「贴到墙顶的窗」）；真正管住上限的是结构约束「离地 + 净高 ≤ 墙高」。**无国标条文**
  public static final int windowMaxPerWall = 3;  // window.maxPerWall [个] 一面墙上最多几扇窗（与门洞**各算各的**：同一面墙可以 3 门 + 3 窗；格式总上限仍是每墙 10 个洞口）。**无外部依据**，工程判断
  // ── walk ─────────────────────────────────────────
  public static final double walkRadiusM = 0.24;  // walk.radiusM [m] 漫游碰撞用的圆柱半径（0.24 m，肩宽级别）
  public static final double walkEyeM = 1.6;  // walk.eyeM [m] 第一人称的眼睛高度（原来是写在 scene3d.js 里的硬编码 1.6，抬进参数表才符合"参数表是唯一真源"）
  public static final double walkWallClearanceM = 0.06;  // walk.wallClearanceM [m] 贴墙走时额外留的余量
  public static final double walkDoorBarrierMinM = 0.08;  // walk.doorBarrierMinM [m] 门只在人体高度区间内算障碍：低于这个高度（如底座缝）不挡人
  public static final double walkDoorBarrierMaxM = 1.8;  // walk.doorBarrierMaxM [m] 高于这个高度（如顶盖）不挡人
  public static final double walkStepMaxM = 0.06;  // walk.stepMaxM [m] 移动时把位移切成小步做连续碰撞检测（防穿模）
  public static final double walkSpawnStepM = 0.35;  // walk.spawnStepM [m] 找站立位置时的网格扫描步长
  // ── route ─────────────────────────────────────────
  public static final int routeMaxRoutes = 6;  // route.maxRoutes [条] 一个方案最多几条动线（v1 冻结 6 条；超过只做防御）
  public static final int routeMaxPoints = 20;  // route.maxPoints [个] 一条动线最多几个用户点（v1 冻结 20；设计决策记录的 64 只作防御上限）
  public static final double routeGridM = 0.1;  // route.gridM [m] A* 栅格边长（0.10 m）。改小更精确但更慢；网格只负责找路，合法性由精确几何复核
  public static final double routeArrowEveryM = 1.5;  // route.arrowEveryM [m] 2D/3D 地面箭头每隔多远一个（P2/P3 用；P1 只提供参数）
  public static final int routeMaxLengthM = 500;  // route.maxLengthM [m] 路径总长超过这个数就报 route-too-long（防异常布局把规划线画到离谱）
  public static final double routeMinAnchorGapM = 0.05;  // route.minAnchorGapM [m] 两个相邻用户点距离小于这个值视为重复点，整条动线拒绝（不静默合并）
  // ── model ─────────────────────────────────────────
  public static final double modelAnisotropyWarn = 1.02;  // model.anisotropyWarn [倍] 按包围盒缩放时各轴比例差超过这个倍数就告警（2%）：尺寸不可信的信号
  public static final int modelEnvelopeTolMm = 1;  // model.envelopeTolMm [mm] 1:1 模型的声明尺寸与实测尺寸**逐轴**相差这么多 mm 以内算对账通过。维护端角标、写入侧判定与设计端加载体检共用这一把尺子（第 3 轮审查 C-10：原来是 1 mm 与 5 mm 两个数，同一个模型在两处得到相反结论）
  // ── history ─────────────────────────────────────────
  public static final int historyMaxSteps = 40;  // history.maxSteps [步] 最多能撤销多少步（原型 40）

  /**
   * 参数表指纹的输入（每项形如 path=默认值），顺序与 config/params.default.json 一致。
   *
   * 用途：方案落库时的 params_rev —— 回答"这份方案是在哪一版规则参数下摆出来的"。
   * 不手工维护版本号（人一定会忘记加一），改成取这份列表的稳定散列：参数一改，指纹就变。
   */
  public static final String[] FINGERPRINT_INPUT = {
      "room.minW=3",
      "room.maxW=20",
      "room.minD=3",
      "room.maxD=20",
      "room.minH=2",
      "room.maxH=5",
      "room.nameMaxChars=12",
      "room.minAreaM2=0.5",
      "space.overlapTolM=0.005",
      "space.wallThicknessM=0.12",
      "space.snapM=0.1",
      "space.rotateStepDeg=5",
      "space.wallOpacity=1",
      "layout.maxItems=100",
      "layout.maxWalls=100",
      "layout.autoZ0=0.7",
      "layout.autoDz=1.1",
      "layout.autoX0=0.7",
      "layout.autoDx=1.2",
      "layout.autoMargin=0.5",
      "column.minSideM=0.2",
      "column.maxSideM=3",
      "column.maxCount=50",
      "column.defaultSideM=0.5",
      "scheme.maxFileBytes=1000000",
      "scheme.maxCoordM=22",
      "scheme.minWallLengthM=0.1",
      "door.openOkDeg=90",
      "door.openWarnDeg=60",
      "door.sweepStepDeg=1",
      "door.freeTolDeg=0.5",
      "door.amountMin=0",
      "door.amountMax=1",
      "opening.defaultWidthM=0.9",
      "opening.defaultHeightM=2.1",
      "opening.minWidthM=0.6",
      "opening.maxWidthM=3",
      "opening.wallEdgeGapM=0.1",
      "opening.maxPerWall=3",
      "opening.frameThicknessM=0",
      "window.defaultWidthM=1.2",
      "window.defaultHeightM=1.5",
      "window.defaultSillM=0.9",
      "window.minWidthM=0.6",
      "window.maxWidthM=3",
      "window.minSillM=0.3",
      "window.maxSillM=2.5",
      "window.maxPerWall=3",
      "walk.radiusM=0.24",
      "walk.eyeM=1.6",
      "walk.wallClearanceM=0.06",
      "walk.doorBarrierMinM=0.08",
      "walk.doorBarrierMaxM=1.8",
      "walk.stepMaxM=0.06",
      "walk.spawnStepM=0.35",
      "route.maxRoutes=6",
      "route.maxPoints=20",
      "route.gridM=0.1",
      "route.arrowEveryM=1.5",
      "route.maxLengthM=500",
      "route.minAnchorGapM=0.05",
      "model.anisotropyWarn=1.02",
      "model.envelopeTolMm=1",
      "history.maxSteps=40",
  };

  /**
   * 参数表指纹：这套结论是在**哪一版规则参数**下算出来的。
   *
   * 不手工维护版本号（人一定会忘记加一），取参数表的稳定散列：
   * 参数一改指纹就变 —— 方案存 params_rev 记它，体检缓存也拿它当键的一部分。
   */
  public static int fingerprint() {
    int h = 17;
    for (final String s : FINGERPRINT_INPUT) h = h * 31 + s.hashCode();
    return h & 0x7fffffff;
  }
}
