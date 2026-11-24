package com.scene.spatial.kernel;

import com.scene.spatial.params.ParamsFingerprint;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ParamsLiveTest —— **内核到底按哪一版参数算**（R6-4 B4d）
 *
 * 这个类盯的是一个已经真出过问题的东西：B4d 之前，后台发布了参数，
 * 前端内核跟着变、**Java 内核一动不动**（实测：发布 85 之后 `POST /api/audit` 自报的 rev 还是出厂那个）。
 * 所以这里的断言不是"能装进去"，而是**"装了之后判定真的会变"** ——
 * 直接打 `Clearance.clearanceLevel()`，那是规则 7 里决定红/黄/绿的那一句。
 *
 * ⚠️ 这里是**进程内全局状态**，测试之间必须复位（`@AfterEach`）。见 `ParamsLive` 的类注释：
 *    只有一个写入者（`ParamsSource.rebuild`），测试是第二个、也是唯一被允许的例外。
 */
class ParamsLiveTest {

  @AfterEach
  void reset() {
    ParamsLive.resetToDefaults();
  }

  @Test
  @DisplayName("没装过 = 出厂值那一份（内核在没有后台数据时照旧能跑）")
  void defaultsBeforeAnyInstall() {
    assertEquals(ParamsFingerprint.defaults(), ParamsLive.rev(), "没装过时的 rev 就是出厂值那一版");
    assertEquals(Params.doorOpenOkDeg, ParamsLive.p().doorOpenOkDeg, "出厂值逐项来自生成的基线");
    assertEquals(Params.spaceRotateStepDeg, ParamsLive.p().spaceRotateStepDeg);
    assertEquals(Params.roomMaxW, ParamsLive.p().roomMaxW);
    assertTrue(ParamsLive.isDefaults(), "界面要能说「没改过」");
  }

  @Test
  @DisplayName("装了之后，**判定真的跟着变**（这才是这一层存在的理由）")
  void judgementsFollowInstalledParams() {
    // 出厂值 90°：门只能开 87° → 黄灯
    assertEquals("warn", Clearance.clearanceLevel(87.0), "按出厂值 90，87° 应当是黄灯");

    final Map<String, Object> flat = new LinkedHashMap<>(ParamsLive.defaultsFlat());
    flat.put("door.openOkDeg", 85);
    final int rev = ParamsFingerprint.of(flat);
    assertNotEquals(ParamsFingerprint.defaults(), rev, "改了值，指纹必须跟着变（不然缓存与留痕全对不上）");
    ParamsLive.install(flat, rev, "测试");

    assertEquals(85, ParamsLive.p().doorOpenOkDeg, "生效值要换过来");
    assertEquals(rev, ParamsLive.rev(), "自报的版本必须是**装进来的那一版**");
    assertEquals("ok", Clearance.clearanceLevel(87.0),
        "★ 同一个 87°，按 85 判就是绿灯 —— 这一条通过，才说明「后台能配参数」不是句空话");
    assertEquals("warn", Clearance.clearanceLevel(80.0), "80° 仍然低于 85，还是黄灯");
  }

  @Test
  @DisplayName("整数项：库里回来的是 85.0 这种，也要落成 int 85（全用 double 会与 JS 侧差出小尾巴）")
  void integerPathsStayIntegers() {
    final Map<String, Object> flat = new LinkedHashMap<>(ParamsLive.defaultsFlat());
    flat.put("door.openOkDeg", 85.0d);
    flat.put("space.rotateStepDeg", 15.0d);
    flat.put("layout.maxItems", 40.0d);
    ParamsLive.install(flat, ParamsFingerprint.of(flat), "测试");

    assertEquals(85, ParamsLive.p().doorOpenOkDeg);
    assertEquals(15, ParamsLive.p().spaceRotateStepDeg);
    assertEquals(40, ParamsLive.p().layoutMaxItems);
    // 指纹是拿**整份值**算的：85 与 85.0 必须算出同一个数（canonicalValue 负责这件事）
    assertEquals(ParamsFingerprint.of(flat), ParamsLive.rev());
  }

  @Test
  @DisplayName("认不得的键**说出来**，不静默吞掉（但也不因此拒绝整份值）")
  void unknownKeysAreReported() {
    final Map<String, Object> flat = new LinkedHashMap<>(ParamsLive.defaultsFlat());
    flat.put("door.openOkDeg", 85);
    flat.put("door.notAThing", 1);
    flat.put("nonsense", 2);
    final List<String> unknown = ParamsLive.install(flat, ParamsFingerprint.of(flat), "测试");

    assertEquals(2, unknown.size(), "两个参数表外的键都要报出来");
    assertTrue(unknown.contains("door.notAThing"));
    assertTrue(unknown.contains("nonsense"));
    assertEquals(85, ParamsLive.p().doorOpenOkDeg, "有一个坏键也照样把好的项装上（不因小失大，但要说话）");
  }

  @Test
  @DisplayName("缺项回落到出厂值：递半份值不会把内核搞成半个（更不会变成 0）")
  void missingPathsFallBackToDefaults() {
    // 只给一项，而且是**不合法**的一项（缺的项一个都不许变 0）
    final Map<String, Object> onlyOne = Map.of("door.openOkDeg", 85);
    ParamsLive.install(onlyOne, ParamsFingerprint.of(onlyOne), "测试");

    assertEquals(85, ParamsLive.p().doorOpenOkDeg);
    assertEquals(Params.roomMaxW, ParamsLive.p().roomMaxW, "没给的项回落到出厂值");
    assertEquals(Params.layoutMaxItems, ParamsLive.p().layoutMaxItems, "没给的项不许变成 0");
    assertEquals(Params.walkRadiusM, ParamsLive.p().walkRadiusM, 1e-9);
  }

  @Test
  @DisplayName("换一份值 = 换一个引用（读者不会看到「改了一半」的参数）")
  void installSwapsAWholeSnapshot() {
    final Map<String, Object> a = new LinkedHashMap<>(ParamsLive.defaultsFlat());
    a.put("door.openOkDeg", 85);
    a.put("door.openWarnDeg", 70);
    ParamsLive.install(a, ParamsFingerprint.of(a), "测试甲");
    final ParamsLive.P first = ParamsLive.p();
    assertFalse(ParamsLive.isDefaults(), "装的是 85 那一版 —— 「还是不是出厂值」要能回答");

    final Map<String, Object> b = new LinkedHashMap<>(ParamsLive.defaultsFlat());
    ParamsLive.install(b, ParamsFingerprint.of(b), "测试乙");
    final ParamsLive.P second = ParamsLive.p();

    assertNotSame(first, second, "装的是**新的**对象 —— 老读者手里的那一份不会被改到");
    assertEquals(85, first.doorOpenOkDeg, "老的那一份保持原样（它描述的是它被装进去时的世界）");
    assertEquals(ParamsFingerprint.defaults(), second.rev, "新的那一份是出厂值");
    assertTrue(ParamsLive.isDefaults(), "装回出厂值之后，要能说「没改过」");
    assertTrue(ParamsLive.installs() >= 2, "装过几次要数得出来（参数到底有没有热更新，靠它）；当前 "
        + ParamsLive.installs());
  }

  /**
   * 参数表的清单与内核认识的清单**必须一致**。
   *
   * 这一条是 M1 之后补的：多房间与外观档位新增了三项（`room.nameMaxChars`、`room.minAreaM2`、
   * `space.wallOpacity`），`ParamsLive.KNOWN` 没跟着加 —— 后果有两个，第二个更要命：
   *
   * 1. 每 5 秒一条 WARN（实测一次 35 分钟的会话刷了 339 条），日志被同一句话淹没；
   * 2. 将来 Java 侧真要用这三项时，`install()` 会**静默沿用出厂值** ——
   *    同一份布局，JS 按库里的值判、Java 按出厂值判，两侧结论不一致而**没有任何提示**。
   *
   * 判据双向：既查「表里有、内核没有」，也查「内核有、表里没有」（D49）。
   */
  @Test
  @DisplayName("参数表清单与内核清单必须一致（M1 之后这里少过三项，每 5 秒刷一条 WARN）")
  void tableAndKernelAgreeOnThePathList() {
    final List<String> tablePaths = java.util.Arrays.stream(Params.FINGERPRINT_INPUT)
        .map(s -> s.substring(0, s.indexOf('=')))
        .toList();
    final Map<String, Object> flat = ParamsLive.defaultsFlat();

    final List<String> inTableOnly = new ArrayList<>();
    for (final String p : tablePaths) if (!flat.containsKey(p)) inTableOnly.add(p);
    final List<String> inKernelOnly = new ArrayList<>();
    for (final String p : flat.keySet()) if (!tablePaths.contains(p)) inKernelOnly.add(p);

    assertTrue(inTableOnly.isEmpty(),
        "参数表里有、内核不认识（会被当成「参数表外的键」，静默沿用出厂值）：" + inTableOnly);
    assertTrue(inKernelOnly.isEmpty(), "内核认识、参数表里没有（多出来的名字同样会让清单对不上）：" + inKernelOnly);

    // 最直接的一条：把**整份出厂值**装进去，一个「不认识的名字」都不许报出来
    assertEquals(List.of(), ParamsLive.install(flat, ParamsFingerprint.defaults(), "测试"),
        "★ 整份出厂值装进去必须一个不认识的名字都没有 —— 这一条在 M1 之后、补三项之前是红的");
  }

  /**
   * 参数表里的**每一项**都真的装得进内核。
   *
   * 为什么需要这条：上面的清单测试只能证明「名字对得上」，证明不了「值真落到字段上」——
   * 而 `install()` 漏一行赋值正好是那个样子：名字在清单里、值被丢掉、字段停在出厂值。
   * 所以这里逐项改一个必定不同的值，装进去，再看**那个字段**是不是真的换了。
   *
   * path → 字段名是机械映射（`room.nameMaxChars` → `roomNameMaxChars`），所以这条不用维护。
   */
  @Test
  @DisplayName("参数表里每一项都真的装得进内核（漏一行赋值 = 那一项悄悄用出厂值）")
  void everyPathLandsInItsField() throws Exception {
    final Map<String, Object> defaults = ParamsLive.defaultsFlat();
    final List<String> silent = new ArrayList<>();

    for (final String path : defaults.keySet()) {
      final java.lang.reflect.Field f = fieldOf(path);
      final double before = ((Number) f.get(ParamsLive.defaults())).doubleValue();
      final double want = before + 1;
      final Map<String, Object> one = new LinkedHashMap<>(defaults);
      one.put(path, want);
      ParamsLive.install(one, ParamsFingerprint.of(one), "测试:" + path);
      final double after = ((Number) f.get(ParamsLive.p())).doubleValue();
      if (Math.abs(after - want) > 1e-9) silent.add(path + "（给的是 " + want + "，内核里是 " + after + "）");
      ParamsLive.resetToDefaults();
    }

    assertTrue(silent.isEmpty(), "这些 path 装进去了、内核没接住（静默沿用出厂值）：" + silent);
  }

  /** path → P 上的字段名：`room.nameMaxChars` → `roomNameMaxChars`（约定：组名 + 首字母大写） */
  private static java.lang.reflect.Field fieldOf(String path) throws Exception {
    final int dot = path.indexOf('.');
    final String group = path.substring(0, dot);
    final String rest = path.substring(dot + 1);
    return ParamsLive.P.class.getField(group + Character.toUpperCase(rest.charAt(0)) + rest.substring(1));
  }

  private static void assertNotSame(Object a, Object b, String msg) {
    org.junit.jupiter.api.Assertions.assertNotSame(a, b, msg);
  }
}