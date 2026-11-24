package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AdminBadgesTest —— 角标判据。
 *
 * 角标是维护端列表的**全部意义**（列表的价值是分诊，不是展示）。
 * 所以每一条判据都写在这里，而且**用字面量钉**（读常量抓不到"常量本身被改错"）。
 *
 * 覆盖两种坏法：**该发的没发**（假阴性 → 管理员没看见该修的东西）与
 * **不该发的乱发**（假阳性 → 管理员不再信任角标）。后者更隐蔽，所以专门有一条"干净的行"。
 */
class AdminBadgesTest {

  private static Map<String, Object> row(Object... kv) {
    final Map<String, Object> m = new HashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
    return m;
  }

  private static List<Map<String, Object>> of(Map<String, Object> r) {
    return AdminBadges.of(r);
  }

  private static boolean has(List<Map<String, Object>> bs, String text) {
    for (final Map<String, Object> b : bs) {
      if (text.equals(b.get("text"))) return true;
    }
    return false;
  }

  private static String levelOf(List<Map<String, Object>> bs, String text) {
    for (final Map<String, Object> b : bs) {
      if (text.equals(b.get("text"))) return String.valueOf(b.get("level"));
    }
    return null;
  }

  @Test
  void no_model_is_bad_and_suppresses_the_others() {
    // 没有模型时不该再嚷嚷"缺缩略图/尺寸未对账" —— 那是同一件事的下游，重复报警等于噪音
    final List<Map<String, Object>> bs = of(row("status", "active"));
    assertTrue(has(bs, "无模型"));
    assertEquals("bad", levelOf(bs, "无模型"));
    assertFalse(has(bs, "缺缩略图"), "没模型就别再提缩略图");
    assertFalse(has(bs, "尺寸未对账"), "没模型就别再提尺寸");
    assertTrue(AdminBadges.hasBad(bs));
  }

  @Test
  void model_without_thumb_warns() {
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "assets/optimized/A.glb", "thumb_file", "",
        "door_verified", 1, "envelope_mode", "1:1", "envelope_ok", 1));
    assertTrue(has(bs, "缺缩略图"));
    assertFalse(has(bs, "无模型"));
    assertFalse(AdminBadges.hasBad(bs), "缺缩略图是 warn，不是 bad");
  }

  @Test
  void one_to_one_with_bad_envelope_is_warned() {
    // 只有 1:1 模型才有"对账"可言
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "assets/optimized/A.glb", "thumb_file", "assets/thumbs/A.png",
        "envelope_mode", "1:1", "envelope_ok", 0));
    assertTrue(has(bs, "尺寸未对账"));
    assertEquals("warn", levelOf(bs, "尺寸未对账"));
    assertFalse(has(bs, "非 1:1"), "它是 1:1，不该再报「非 1:1」");
  }

  @Test
  void fit_model_never_gets_the_envelope_badge() {
    // 第一版就是在这里误报的：fit 模式下 envelope_ok=0 说的是"缩放后放不进声明包络"，
    // **不是**"尺寸对不上账"。demo-freezer-dual 实测 525.5×990×517 vs 声明 990×1980×871，本来就不同。
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "assets/optimized/A.glb", "thumb_file", "assets/thumbs/A.png",
        "envelope_mode", "fit", "envelope_ok", 0));
    assertFalse(has(bs, "尺寸未对账"), "fit 模型不许发「尺寸未对账」—— 那是假角标");
    assertTrue(has(bs, "非 1:1"), "该说的事实还是要说：它不是 1:1");
  }

  @Test
  void one_to_one_model_gets_no_scale_badge() {
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "assets/optimized/A.glb", "thumb_file", "assets/thumbs/A.png",
        "envelope_mode", "1:1", "envelope_ok", 1));
    assertFalse(has(bs, "非 1:1"));
  }

  @Test
  void disabled_is_off_not_bad() {
    final List<Map<String, Object>> bs = of(row(
        "status", "disabled", "file_path", "assets/optimized/A.glb", "thumb_file", "assets/thumbs/A.png",
        "door_verified", 1, "envelope_mode", "1:1", "envelope_ok", 1));
    assertTrue(has(bs, "已停用"));
    assertEquals("off", levelOf(bs, "已停用"), "停用是状态不是毛病");
    assertFalse(AdminBadges.hasBad(bs));
  }

  @Test
  void a_clean_row_gets_no_badge_at_all() {
    // 假阳性防线：干净的行必须**一条角标都没有**
    // 干净行 = **事实齐全**：门型（显式 single）与尺寸说明都写清了。
    // 空 door_part / 空 size_note 现在是真缺口（会挂「门型未填」），不再是「干净」。
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "assets/optimized/A.glb", "thumb_file", "assets/thumbs/A.png",
        "door_part", "single", "door_verified", 1, "size_note", "厂家图册，实测一致",
        "envelope_mode", "1:1", "envelope_ok", 1));
    assertEquals(0, bs.size(), "干净的行不许有角标，否则角标会失去信誉");
    assertFalse(AdminBadges.hasBad(bs));
  }

  @Test
  void envelope_ok_coming_as_string_or_boolean_is_understood() {
    // LEFT JOIN / 驱动差异会把 tinyint 给成 Boolean 或 "1" —— 三种都要认
    for (final Object v : List.of(1, true, "1")) {
      assertFalse(has(of(row("status", "active", "file_path", "a.glb", "thumb_file", "t.png",
          "envelope_mode", "1:1", "envelope_ok", v)), "尺寸未对账"), "envelope_ok=" + v + " 应视为通过");
    }
    for (final Object v : List.of(0, false, "0")) {
      assertTrue(has(of(row("status", "active", "file_path", "a.glb", "thumb_file", "t.png",
          "envelope_mode", "1:1", "envelope_ok", v)), "尺寸未对账"), "envelope_ok=" + v + " 应视为未通过");
    }
  }

  @Test
  void door_not_verified_warns() {
    // 「门型未确认」**曾经故意不发**（缺列）—— V9 补列后才发。它不是"没有门"。
    // door_part 必须**填了**才谈得上「未确认」——空值是「门型未填」，是另一条判据。
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "a.glb", "thumb_file", "t.png", "door_part", "single",
        "door_verified", 0, "door_source", "auto", "size_note", "官网图册",
        "envelope_mode", "1:1", "envelope_ok", 1));
    assertTrue(has(bs, "门型未确认"));
    assertEquals("warn", levelOf(bs, "门型未确认"));
    assertFalse(AdminBadges.hasBad(bs), "门型未确认是 warn：不挡放置，只是体检结论不可信");
  }

  @Test
  void door_verified_gets_no_badge() {
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "a.glb", "thumb_file", "t.png",
        "door_part", "single", "door_verified", 1, "door_source", "user", "size_note", "官网图册",
        "envelope_mode", "1:1", "envelope_ok", 1));
    assertFalse(has(bs, "门型未确认"));
  }

  @Test
  void fit_with_uneven_scaling_warns() {
    // fit 下真正该查的判据（V9 的 anisotropy_ok）。各轴缩放不一致 = 模型被按轴拉伸过。
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "a.glb", "thumb_file", "t.png", "door_verified", 1,
        "envelope_mode", "fit", "envelope_ok", 0, "anisotropy_ok", 0));
    assertTrue(has(bs, "缩放不均匀"));
    assertTrue(has(bs, "非 1:1"), "fit 模型两个事实都要说");
    assertFalse(has(bs, "尺寸未对账"), "fit 永远不发「尺寸未对账」");
  }

  @Test
  void one_to_one_never_gets_uneven_scaling_badge() {
    // 1:1 **根本没做缩放** → "各轴缩放是否均匀"对它不适用。
    // 这一列在 1:1 行上可能是 0（列默认值不同或驱动返回），照样不许据此报警。
    final List<Map<String, Object>> bs = of(row(
        "status", "active", "file_path", "a.glb", "thumb_file", "t.png", "door_verified", 1,
        "envelope_mode", "1:1", "envelope_ok", 1, "anisotropy_ok", 0));
    assertFalse(has(bs, "缩放不均匀"), "只在 fit 下看这一列 —— 1:1 报警就是假角标");
  }

  // ── 判据列的**三态**（V15）：没读数 ≠ 判为否 ──
  //
  // 背景：这两列建表时是 NOT NULL DEFAULT 1（"缺省宣称一切正常"），于是"没判过"这个
  // 真实状态根本没有地方放。dev-1/dev-2 两条审查结论都落在这里：
  // 缺读数要写成 NULL，读出侧说「未判」，不说「均匀」也不说「不均匀」。

  @Test
  void null_anisotropy_is_reported_as_not_judged_not_as_uniform() {
    final List<Map<String, Object>> bs = of(row("status", "active", "file_path", "/x.glb",
        "thumb_file", "/t.png", "envelope_mode", "fit", "envelope_ok", 1,
        "anisotropy_ok", null, "door_verified", 1, "origin", "用户原始模型"));
    assertTrue(has(bs, "缩放未判"), "没读数必须说「未判」，实际：" + bs);
    assertFalse(has(bs, "缩放不均匀"), "没读数**不许**说成「不均匀」（会冤枉模型）");
    assertFalse(has(bs, "无待办"), "「未判」也是一条要看的角标，不能显示成「无待办」");
  }

  @Test
  void zero_anisotropy_is_an_accusation_one_anisotropy_is_silence() {
    final Map<String, Object> base = row("status", "active", "file_path", "/x.glb",
        "thumb_file", "/t.png", "envelope_mode", "fit", "envelope_ok", 1,
        "door_verified", 1, "origin", "用户原始模型");
    final Map<String, Object> bad = new java.util.HashMap<>(base);
    bad.put("anisotropy_ok", 0);
    assertTrue(has(of(bad), "缩放不均匀"), "判为否要说出来");

    final Map<String, Object> good = new java.util.HashMap<>(base);
    good.put("anisotropy_ok", 1);
    assertFalse(has(of(good), "缩放不均匀"));
    assertFalse(has(of(good), "缩放未判"), "判过就是判过，不许再说「未判」");
  }

  @Test
  void null_envelope_on_one_to_one_is_not_judged_because_it_never_was() {
    final List<Map<String, Object>> bs = of(row("status", "active", "file_path", "/x.glb",
        "thumb_file", "/t.png", "envelope_mode", "1:1", "envelope_ok", null,
        "door_verified", 1, "origin", "用户原始模型"));
    assertTrue(has(bs, "尺寸未判"), "1:1 没有对账读数 → 说「未判」，不能说成「未对账」（差多少我们并不知道）");
    assertFalse(has(bs, "尺寸未对账"));

    final List<Map<String, Object>> bs2 = of(row("status", "active", "file_path", "/x.glb",
        "thumb_file", "/t.png", "envelope_mode", "1:1", "envelope_ok", 0,
        "door_verified", 1, "origin", "用户原始模型"));
    assertTrue(has(bs2, "尺寸未对账"), "判为否才是「未对账」");
  }
}
