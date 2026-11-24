package com.scene.spatial.kernel;

import com.scene.spatial.params.ParamsFingerprint;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;

/**
 * ParamsLive —— 规则参数的**运行时生效值**（R6-4 B4d）
 *
 * ## 为什么要有这个类（不是"顺手抽一层"，是修一个说不过去的事）
 *
 * {@link Params} 是**编译期基线**（`tools/server/gen-java-data.mjs` 生成，勿手改）。
 * 在 B4d 之前，内核里所有 `Params.xxx` 读的都是那 34 个 `static final` ——
 * 也就是说 **后台发布了参数，服务端内核一动不动**。实测（`logs/_b4d-prove.py`）：
 *
 * ```
 * 发布 door.openOkDeg=85  →  GET /api/params/rev  = 351788645（生效值那一版）
 *                         →  POST /api/audit     自报 paramsRev = 358430008（还是出厂）
 * ```
 *
 * 后果不是"少了个功能"，是**两套裁判**：同一份布局，前端内核按 85° 判「门开得到底」，
 * 服务端按 90° 判「会被挡」—— 而 `docs/25 §6` 写着「两边必须一致，而且这件事要看得见」。
 * 更糟的是 `SchemeService` 落库时已经改记**生效值**的 rev（B4a），
 * 于是库里会出现「这份方案按 rev X 摆的」配着「按 rev 358430008 判的结论」—— **数据本身在说谎**。
 *
 * ## 三条设计
 *
 * 1. **换引用，不改字段**：`install()` 把整份值装成一个**新的** {@link P}，一次 volatile 写换上去。
 *    读者永远看到"某一份完整的值"，看不到"改了一半"（前半句新值 + 后半句旧值是最坏的结果：
 *    算出来的结论不属于任何一版参数）。
 * 2. **只有一个写入者**：{@code ParamsSource.rebuild()}（库 → 校验 → 生效值）。
 *    别处不许 install —— 否则"裁判用的是哪一版"又说不清了。
 *    **刻意不做"临时换一版参数算完再换回来"**：那会让并发请求在窗口里读到别人的参数，
 *    得到的结论不属于任何一版。要"按老参数复现结论"，正解是**落库时就把结论存下来**
 *    （B4d 的做法：`scheme.audit_json` / `scheme_revision.audit_json`）。
 * 3. **没装过 = 出厂值**：没有后台数据时（`spatial.store=memory` / 单测）行为与 B4a 之前**逐字节相同**，
 *    指纹也还是 {@link ParamsFingerprint#defaults()}。
 *
 * ⚠️ 已知边界（写出来，不藏着）：一次计算里若正好跨过 `install()`，不同调用点可能读到相邻两份值
 * （微秒级窗口）。**落库的那条结论**用 {@code AuditService.judge()} 的「算前算后各读一次 rev，
 * 不同就重算一次」钉死；现货计算（前台拖动、`POST /api/audit`）不值得为此付代价，见 docs/40。
 */
public final class ParamsLive {

  private ParamsLive() {}

  /**
   * 一份完整的参数值。
   *
   * 字段名与 {@link Params} 里的**完全一致**，所以内核里的改动是纯文本替换
   * （`Params.doorOpenOkDeg` → `ParamsLive.p().doorOpenOkDeg`）——
   * 不引入第二个命名体系，读代码的人不用在两套名字之间换算。
   *
   * 类型也照抄 {@link Params}：整数就整数。**一条捷径别走**：全用 double 会让
   * `doorOpenOkDeg` 之类的比较结果与 JS 侧出现 0.0000001 级别的差别。
   */
  public static final class P {
    // ── room ─────────────────────────────────────────
    public int roomMinW;
    public int roomMaxW;
    public int roomMinD;
    public int roomMaxD;
    public int roomMinH;
    public int roomMaxH;
    public int roomNameMaxChars;
    public double roomMinAreaM2;
    // ── space ─────────────────────────────────────────
    public double spaceOverlapTolM;
    public double spaceWallThicknessM;
    public double spaceSnapM;
    public int spaceRotateStepDeg;
    public int spaceWallOpacity;
    // ── layout ─────────────────────────────────────────
    public int layoutMaxItems;
    public int layoutMaxWalls;
    public double layoutAutoZ0;
    public double layoutAutoDz;
    public double layoutAutoX0;
    public double layoutAutoDx;
    public double layoutAutoMargin;
    // ── scheme ─────────────────────────────────────────
    public int schemeMaxFileBytes;
    public int schemeMaxCoordM;
    public double schemeMinWallLengthM;
    // ── door ─────────────────────────────────────────
    public int doorOpenOkDeg;
    public int doorOpenWarnDeg;
    public int doorSweepStepDeg;
    public double doorFreeTolDeg;
    public int doorAmountMin;
    public int doorAmountMax;
    // ── opening（门洞 = 建筑门洞；与上面那组"设备柜门"无关）──
    public double openingDefaultWidthM;
    public double openingDefaultHeightM;
    public double openingMinWidthM;
    public double openingMaxWidthM;
    public double openingWallEdgeGapM;
    public int openingMaxPerWall;
    public double openingFrameThicknessM;

    // ── window（窗 = 墙上的矩形洞口 + 离地高度，W2；与上面那组"门洞"共用同一套洞口机制）──
    //    依据：GB/T 5824-2021 3M 模数（1200/1500）；离地 0.90 出自 GB 50096-2011 §3.9.1 的防护临界值
    public double windowDefaultWidthM;
    public double windowDefaultHeightM;
    public double windowDefaultSillM;
    public double windowMinWidthM;
    public double windowMaxWidthM;
    public double windowMinSillM;
    public double windowMaxSillM;
    public int windowMaxPerWall;
    // ── walk ─────────────────────────────────────────
    public double walkRadiusM;
    public double walkEyeM;
    public double walkWallClearanceM;
    public double walkDoorBarrierMinM;
    public double walkDoorBarrierMaxM;
    public double walkStepMaxM;
    public double walkSpawnStepM;
    // ── column（矩形结构柱，W5）─────────────────────────
    public double columnMinSideM;
    public int columnMaxSideM;
    public int columnMaxCount;
    public double columnDefaultSideM;
    // ── route（人员地面动线，W4）─────────────────────────
    public int routeMaxRoutes;
    public int routeMaxPoints;
    public double routeGridM;
    public double routeArrowEveryM;
    public int routeMaxLengthM;
    public double routeMinAnchorGapM;
    // ── model ─────────────────────────────────────────
    public double modelAnisotropyWarn;
    public int modelEnvelopeTolMm;
    // ── history ─────────────────────────────────────────
    public int historyMaxSteps;

    /** 这一份值对应的**参数版本**（指纹）。由 {@link ParamsFingerprint} 算出来，不许手写 */
    public int rev = ParamsFingerprint.defaults();
  }

  /**
   * 参数表里的**全部** path —— 只用来把不认识的名字挑出来（不静默）。
   *
   * ⭐ **不再手抄一份**：直接从 {@link Params#FINGERPRINT_INPUT} 派出来（那一份是生成的，改不了）。
   *
   * 为什么改成派生：这里原来手写 42 项、而参数表当时实际 45 项（现为 46 项）—— 缺的三项
   * （`room.nameMaxChars`、`room.minAreaM2`（两项都是 M1 多房间新增）、`space.wallOpacity`（外观档位））
   * 于是**每 5 秒被当成「不认识的名字」报一次 WARN**（实测一次 35 分钟的会话刷了 339 条，
   * `logs/backend.log` 共 381 行、其中 339 行是它）。
   *
   * 刷屏还不是最要紧的：将来 Java 侧任何一处真要用这三项时，{@link #install} 会**静默沿用出厂值** ——
   * 两侧结论不一致，而且不会有一点提示。原注释写的是「参数表里的 45 个 path」：
   * **数字碰巧是对的、清单是错的** —— 这就是「会变的东西抄两份」的典型下场。
   * 派生之后，参数表加一项这里自动跟着加，结构上不可能再漂移。
   */
  private static final Set<String> KNOWN = Set.copyOf(java.util.Arrays.stream(Params.FINGERPRINT_INPUT)
      .map(s -> {
        final int i = s.indexOf('=');
        if (i < 0) throw new IllegalStateException("FINGERPRINT_INPUT 里有一条没有 = ：" + s);
        return s.substring(0, i);
      })
      .toList());

  /** 出厂值那一份（进程启动到第一次 install 之间，内核读的就是它） */
  private static final P DEFAULTS = defaults();

  private static volatile P current = DEFAULTS;
  private static volatile String source = "参数表默认值";
  private static volatile long installedAt = 0L;
  private static volatile int installs = 0;

  /** 出厂值那一份：逐项抄 {@link Params}（**唯一出处**，生成的基线改了这里自动跟着改） */
  public static P defaults() {
    final P p = new P();
    p.roomMinW = Params.roomMinW;
    p.roomMaxW = Params.roomMaxW;
    p.roomMinD = Params.roomMinD;
    p.roomMaxD = Params.roomMaxD;
    p.roomMinH = Params.roomMinH;
    p.roomMaxH = Params.roomMaxH;
    p.roomNameMaxChars = Params.roomNameMaxChars;
    p.roomMinAreaM2 = Params.roomMinAreaM2;
    p.spaceOverlapTolM = Params.spaceOverlapTolM;
    p.spaceWallThicknessM = Params.spaceWallThicknessM;
    p.spaceSnapM = Params.spaceSnapM;
    p.spaceRotateStepDeg = Params.spaceRotateStepDeg;
    p.spaceWallOpacity = Params.spaceWallOpacity;
    p.layoutMaxItems = Params.layoutMaxItems;
    p.layoutMaxWalls = Params.layoutMaxWalls;
    p.layoutAutoZ0 = Params.layoutAutoZ0;
    p.layoutAutoDz = Params.layoutAutoDz;
    p.layoutAutoX0 = Params.layoutAutoX0;
    p.layoutAutoDx = Params.layoutAutoDx;
    p.layoutAutoMargin = Params.layoutAutoMargin;
    p.schemeMaxFileBytes = Params.schemeMaxFileBytes;
    p.schemeMaxCoordM = Params.schemeMaxCoordM;
    p.schemeMinWallLengthM = Params.schemeMinWallLengthM;
    p.doorOpenOkDeg = Params.doorOpenOkDeg;
    p.doorOpenWarnDeg = Params.doorOpenWarnDeg;
    p.doorSweepStepDeg = Params.doorSweepStepDeg;
    p.doorFreeTolDeg = Params.doorFreeTolDeg;
    p.doorAmountMin = Params.doorAmountMin;
    p.doorAmountMax = Params.doorAmountMax;
    p.openingDefaultWidthM = Params.openingDefaultWidthM;
    p.openingDefaultHeightM = Params.openingDefaultHeightM;
    p.openingMinWidthM = Params.openingMinWidthM;
    p.openingMaxWidthM = Params.openingMaxWidthM;
    p.openingWallEdgeGapM = Params.openingWallEdgeGapM;
    p.openingMaxPerWall = Params.openingMaxPerWall;
    p.openingFrameThicknessM = Params.openingFrameThicknessM;
    p.windowDefaultWidthM = Params.windowDefaultWidthM;
    p.windowDefaultHeightM = Params.windowDefaultHeightM;
    p.windowDefaultSillM = Params.windowDefaultSillM;
    p.windowMinWidthM = Params.windowMinWidthM;
    p.windowMaxWidthM = Params.windowMaxWidthM;
    p.windowMinSillM = Params.windowMinSillM;
    p.windowMaxSillM = Params.windowMaxSillM;
    p.windowMaxPerWall = Params.windowMaxPerWall;
    p.walkRadiusM = Params.walkRadiusM;
    p.walkEyeM = Params.walkEyeM;
    p.walkWallClearanceM = Params.walkWallClearanceM;
    p.walkDoorBarrierMinM = Params.walkDoorBarrierMinM;
    p.walkDoorBarrierMaxM = Params.walkDoorBarrierMaxM;
    p.walkStepMaxM = Params.walkStepMaxM;
    p.walkSpawnStepM = Params.walkSpawnStepM;
    p.columnMinSideM = Params.columnMinSideM;
    p.columnMaxSideM = Params.columnMaxSideM;
    p.columnMaxCount = Params.columnMaxCount;
    p.columnDefaultSideM = Params.columnDefaultSideM;
    p.routeMaxRoutes = Params.routeMaxRoutes;
    p.routeMaxPoints = Params.routeMaxPoints;
    p.routeGridM = Params.routeGridM;
    p.routeArrowEveryM = Params.routeArrowEveryM;
    p.routeMaxLengthM = Params.routeMaxLengthM;
    p.routeMinAnchorGapM = Params.routeMinAnchorGapM;
    p.modelAnisotropyWarn = Params.modelAnisotropyWarn;
    p.modelEnvelopeTolMm = Params.modelEnvelopeTolMm;
    p.historyMaxSteps = Params.historyMaxSteps;
    p.rev = ParamsFingerprint.defaults();
    return p;
  }

  /**
   * 出厂值的**扁平整份**（`door.openOkDeg` → 90）。
   *
   * 不是给测试专用的东西：它是"没装过时唯一的真相"，也是 {@link #install} 的起点
   * （每一份生效值都是"出厂值 + 库里的改动"）。单测用它拼一份完整输入，
   * 免得漏给一项就回落成默认值、把用例测成假绿。
   */
  public static Map<String, Object> defaultsFlat() {
    final P p = DEFAULTS;
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("room.minW", p.roomMinW);
    out.put("room.maxW", p.roomMaxW);
    out.put("room.minD", p.roomMinD);
    out.put("room.maxD", p.roomMaxD);
    out.put("room.minH", p.roomMinH);
    out.put("room.maxH", p.roomMaxH);
    out.put("room.nameMaxChars", p.roomNameMaxChars);
    out.put("room.minAreaM2", p.roomMinAreaM2);
    out.put("space.overlapTolM", p.spaceOverlapTolM);
    out.put("space.wallThicknessM", p.spaceWallThicknessM);
    out.put("space.snapM", p.spaceSnapM);
    out.put("space.rotateStepDeg", p.spaceRotateStepDeg);
    out.put("space.wallOpacity", p.spaceWallOpacity);
    out.put("layout.maxItems", p.layoutMaxItems);
    out.put("layout.maxWalls", p.layoutMaxWalls);
    out.put("layout.autoZ0", p.layoutAutoZ0);
    out.put("layout.autoDz", p.layoutAutoDz);
    out.put("layout.autoX0", p.layoutAutoX0);
    out.put("layout.autoDx", p.layoutAutoDx);
    out.put("layout.autoMargin", p.layoutAutoMargin);
    out.put("scheme.maxFileBytes", p.schemeMaxFileBytes);
    out.put("scheme.maxCoordM", p.schemeMaxCoordM);
    out.put("scheme.minWallLengthM", p.schemeMinWallLengthM);
    out.put("door.openOkDeg", p.doorOpenOkDeg);
    out.put("door.openWarnDeg", p.doorOpenWarnDeg);
    out.put("door.sweepStepDeg", p.doorSweepStepDeg);
    out.put("door.freeTolDeg", p.doorFreeTolDeg);
    out.put("door.amountMin", p.doorAmountMin);
    out.put("door.amountMax", p.doorAmountMax);
    out.put("opening.defaultWidthM", p.openingDefaultWidthM);
    out.put("opening.defaultHeightM", p.openingDefaultHeightM);
    out.put("opening.minWidthM", p.openingMinWidthM);
    out.put("opening.maxWidthM", p.openingMaxWidthM);
    out.put("opening.wallEdgeGapM", p.openingWallEdgeGapM);
    out.put("opening.maxPerWall", p.openingMaxPerWall);
    out.put("opening.frameThicknessM", p.openingFrameThicknessM);
    out.put("window.defaultWidthM", p.windowDefaultWidthM);
    out.put("window.defaultHeightM", p.windowDefaultHeightM);
    out.put("window.defaultSillM", p.windowDefaultSillM);
    out.put("window.minWidthM", p.windowMinWidthM);
    out.put("window.maxWidthM", p.windowMaxWidthM);
    out.put("window.minSillM", p.windowMinSillM);
    out.put("window.maxSillM", p.windowMaxSillM);
    out.put("window.maxPerWall", p.windowMaxPerWall);
    out.put("walk.radiusM", p.walkRadiusM);
    out.put("walk.eyeM", p.walkEyeM);
    out.put("walk.wallClearanceM", p.walkWallClearanceM);
    out.put("walk.doorBarrierMinM", p.walkDoorBarrierMinM);
    out.put("walk.doorBarrierMaxM", p.walkDoorBarrierMaxM);
    out.put("walk.stepMaxM", p.walkStepMaxM);
    out.put("walk.spawnStepM", p.walkSpawnStepM);
    out.put("column.minSideM", p.columnMinSideM);
    out.put("column.maxSideM", p.columnMaxSideM);
    out.put("column.maxCount", p.columnMaxCount);
    out.put("column.defaultSideM", p.columnDefaultSideM);
    out.put("route.maxRoutes", p.routeMaxRoutes);
    out.put("route.maxPoints", p.routeMaxPoints);
    out.put("route.gridM", p.routeGridM);
    out.put("route.arrowEveryM", p.routeArrowEveryM);
    out.put("route.maxLengthM", p.routeMaxLengthM);
    out.put("route.minAnchorGapM", p.routeMinAnchorGapM);
    out.put("model.anisotropyWarn", p.modelAnisotropyWarn);
    out.put("model.envelopeTolMm", p.modelEnvelopeTolMm);
    out.put("history.maxSteps", p.historyMaxSteps);
    return out;
  }

  /** 当前生效值。**内核里所有算规则的地方都读它** */
  public static P p() {
    return current;
  }

  /** 当前参数版本（指纹）。**它跟着生效值走** —— 「这份结论是在哪一版参数下算的」靠它回答 */
  public static int rev() {
    return current.rev;
  }

  /** 这一份是从哪来的（"现在裁判用的是哪一份"要说得出来） */
  public static String source() {
    return source;
  }

  /** 装过几次（启动第一次装载也算一次）。给"参数到底有没有热更新"这类问题一个可观察量 */
  public static int installs() {
    return installs;
  }

  public static long installedAtMillis() {
    return installedAt;
  }

  /**
   * 装一份生效值。**只有 {@code ParamsSource.rebuild()} 调这里。**
   *
   * @param flat path → 值（`door.openOkDeg` → 85）。**缺项回落到出厂值**（不猜、不抛）
   * @param rev  这一份的指纹（由调用方用 {@link ParamsFingerprint#of} 算，别在这儿重算一遍：
   *             两处各算一次早晚会不一致）
   * @param from 来源说明（"数据库（改过 1 项）" / "参数表默认值"）—— 界面上要显示
   * @return 被忽略的键（参数表里没有的 path）。**调用方有义务说出来**，别静默吞掉
   */
  public static synchronized java.util.List<String> install(Map<String, Object> flat, int rev, String from) {
    final Map<String, Object> vals = flat == null ? Map.of() : flat;
    final P next = defaults();
    next.roomMinW = intOf(vals, "room.minW", next.roomMinW);
    next.roomMaxW = intOf(vals, "room.maxW", next.roomMaxW);
    next.roomMinD = intOf(vals, "room.minD", next.roomMinD);
    next.roomMaxD = intOf(vals, "room.maxD", next.roomMaxD);
    next.roomMinH = intOf(vals, "room.minH", next.roomMinH);
    next.roomMaxH = intOf(vals, "room.maxH", next.roomMaxH);
    next.roomNameMaxChars = intOf(vals, "room.nameMaxChars", next.roomNameMaxChars);
    next.roomMinAreaM2 = dblOf(vals, "room.minAreaM2", next.roomMinAreaM2);
    next.spaceOverlapTolM = dblOf(vals, "space.overlapTolM", next.spaceOverlapTolM);
    next.spaceWallThicknessM = dblOf(vals, "space.wallThicknessM", next.spaceWallThicknessM);
    next.spaceSnapM = dblOf(vals, "space.snapM", next.spaceSnapM);
    next.spaceRotateStepDeg = intOf(vals, "space.rotateStepDeg", next.spaceRotateStepDeg);
    next.spaceWallOpacity = intOf(vals, "space.wallOpacity", next.spaceWallOpacity);
    next.layoutMaxItems = intOf(vals, "layout.maxItems", next.layoutMaxItems);
    next.layoutMaxWalls = intOf(vals, "layout.maxWalls", next.layoutMaxWalls);
    next.layoutAutoZ0 = dblOf(vals, "layout.autoZ0", next.layoutAutoZ0);
    next.layoutAutoDz = dblOf(vals, "layout.autoDz", next.layoutAutoDz);
    next.layoutAutoX0 = dblOf(vals, "layout.autoX0", next.layoutAutoX0);
    next.layoutAutoDx = dblOf(vals, "layout.autoDx", next.layoutAutoDx);
    next.layoutAutoMargin = dblOf(vals, "layout.autoMargin", next.layoutAutoMargin);
    next.schemeMaxFileBytes = intOf(vals, "scheme.maxFileBytes", next.schemeMaxFileBytes);
    next.schemeMaxCoordM = intOf(vals, "scheme.maxCoordM", next.schemeMaxCoordM);
    next.schemeMinWallLengthM = dblOf(vals, "scheme.minWallLengthM", next.schemeMinWallLengthM);
    next.doorOpenOkDeg = intOf(vals, "door.openOkDeg", next.doorOpenOkDeg);
    next.doorOpenWarnDeg = intOf(vals, "door.openWarnDeg", next.doorOpenWarnDeg);
    next.doorSweepStepDeg = intOf(vals, "door.sweepStepDeg", next.doorSweepStepDeg);
    next.doorFreeTolDeg = dblOf(vals, "door.freeTolDeg", next.doorFreeTolDeg);
    next.doorAmountMin = intOf(vals, "door.amountMin", next.doorAmountMin);
    next.doorAmountMax = intOf(vals, "door.amountMax", next.doorAmountMax);
    next.openingDefaultWidthM = dblOf(vals, "opening.defaultWidthM", next.openingDefaultWidthM);
    next.openingDefaultHeightM = dblOf(vals, "opening.defaultHeightM", next.openingDefaultHeightM);
    next.openingMinWidthM = dblOf(vals, "opening.minWidthM", next.openingMinWidthM);
    next.openingMaxWidthM = dblOf(vals, "opening.maxWidthM", next.openingMaxWidthM);
    next.openingWallEdgeGapM = dblOf(vals, "opening.wallEdgeGapM", next.openingWallEdgeGapM);
    next.openingMaxPerWall = intOf(vals, "opening.maxPerWall", next.openingMaxPerWall);
    next.openingFrameThicknessM = dblOf(vals, "opening.frameThicknessM", next.openingFrameThicknessM);
    next.windowDefaultWidthM = dblOf(vals, "window.defaultWidthM", next.windowDefaultWidthM);
    next.windowDefaultHeightM = dblOf(vals, "window.defaultHeightM", next.windowDefaultHeightM);
    next.windowDefaultSillM = dblOf(vals, "window.defaultSillM", next.windowDefaultSillM);
    next.windowMinWidthM = dblOf(vals, "window.minWidthM", next.windowMinWidthM);
    next.windowMaxWidthM = dblOf(vals, "window.maxWidthM", next.windowMaxWidthM);
    next.windowMinSillM = dblOf(vals, "window.minSillM", next.windowMinSillM);
    next.windowMaxSillM = dblOf(vals, "window.maxSillM", next.windowMaxSillM);
    next.windowMaxPerWall = intOf(vals, "window.maxPerWall", next.windowMaxPerWall);
    next.walkRadiusM = dblOf(vals, "walk.radiusM", next.walkRadiusM);
    next.walkEyeM = dblOf(vals, "walk.eyeM", next.walkEyeM);
    next.walkWallClearanceM = dblOf(vals, "walk.wallClearanceM", next.walkWallClearanceM);
    next.walkDoorBarrierMinM = dblOf(vals, "walk.doorBarrierMinM", next.walkDoorBarrierMinM);
    next.walkDoorBarrierMaxM = dblOf(vals, "walk.doorBarrierMaxM", next.walkDoorBarrierMaxM);
    next.walkStepMaxM = dblOf(vals, "walk.stepMaxM", next.walkStepMaxM);
    next.walkSpawnStepM = dblOf(vals, "walk.spawnStepM", next.walkSpawnStepM);
    next.columnMinSideM = dblOf(vals, "column.minSideM", next.columnMinSideM);
    next.columnMaxSideM = intOf(vals, "column.maxSideM", next.columnMaxSideM);
    next.columnMaxCount = intOf(vals, "column.maxCount", next.columnMaxCount);
    next.columnDefaultSideM = dblOf(vals, "column.defaultSideM", next.columnDefaultSideM);
    next.routeMaxRoutes = intOf(vals, "route.maxRoutes", next.routeMaxRoutes);
    next.routeMaxPoints = intOf(vals, "route.maxPoints", next.routeMaxPoints);
    next.routeGridM = dblOf(vals, "route.gridM", next.routeGridM);
    next.routeArrowEveryM = dblOf(vals, "route.arrowEveryM", next.routeArrowEveryM);
    next.routeMaxLengthM = intOf(vals, "route.maxLengthM", next.routeMaxLengthM);
    next.routeMinAnchorGapM = dblOf(vals, "route.minAnchorGapM", next.routeMinAnchorGapM);
    next.modelAnisotropyWarn = dblOf(vals, "model.anisotropyWarn", next.modelAnisotropyWarn);
    next.modelEnvelopeTolMm = intOf(vals, "model.envelopeTolMm", next.modelEnvelopeTolMm);
    next.historyMaxSteps = intOf(vals, "history.maxSteps", next.historyMaxSteps);
    next.rev = rev;

    final java.util.List<String> unknown = new java.util.ArrayList<>();
    for (final String k : vals.keySet()) if (!KNOWN.contains(k)) unknown.add(k);

    // 顺序要紧：**先把值换上去，再报来源** —— 反过来的话，两次 install 之间
    // 会有人看到"新的 source 配着旧的值"（和"改了却没看出来"是同一类问题）
    current = next;
    source = from == null ? "（没说来源）" : from;
    installedAt = System.currentTimeMillis();
    installs++;
    return java.util.List.copyOf(unknown);
  }

  /** 给测试用：回到出厂值那一份（进程内状态，别在生产路径上调） */
  public static synchronized void resetToDefaults() {
    current = DEFAULTS;
    source = "参数表默认值";
    installedAt = 0L;
    installs = 0;
  }

  /** 整数项：库里存的是 `90.0` 这种也要认（JDBC 的 JSON 列会这么回来） */
  private static int intOf(Map<String, Object> flat, String path, int fallback) {
    final Object v = flat.get(path);
    if (!(v instanceof Number n) || !Double.isFinite(n.doubleValue())) return fallback;
    return (int) Math.round(n.doubleValue());
  }

  private static double dblOf(Map<String, Object> flat, String path, double fallback) {
    final Object v = flat.get(path);
    if (!(v instanceof Number n) || !Double.isFinite(n.doubleValue())) return fallback;
    return n.doubleValue();
  }

  /** 这一份值 == 出厂值吗（界面要能说「没改过」） */
  public static boolean isDefaults() {
    return rev() == ParamsFingerprint.defaults();
  }

  /** 只读快照（给诊断接口用；**不含内部对象**，避免有人从这里改到生效值） */
  public static Map<String, Object> describe() {
    final P p = current;
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("rev", p.rev);
    out.put("source", source);
    out.put("installs", installs);
    out.put("installedAt", installedAt == 0L ? null : installedAt);
    out.put("isDefaults", isDefaults());
    out.put("doorOpenOkDeg", p.doorOpenOkDeg);
    out.put("spaceRotateStepDeg", p.spaceRotateStepDeg);
    return out;
  }
}