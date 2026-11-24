package com.scene.spatial.kernel;

/**
 * Cases.java —— 语言中立用例表（**由 tools/server/gen-java-data.mjs 生成，勿手改**）
 *
 * 来源：spatial-core/test/cases/rules.json  sha256(前16)=c2dc4ac0bf3e9153
 * 版本：11，共 47 条，覆盖 11 组规则：validate / room-resize / placement / scheme-roundtrip / scheme-accept / scheme-errors / door / collision / collision-spawn / door-clearance / validate-wall
 * 重新生成：node tools/server/gen-java-data.mjs
 *
 * 为什么 Java 侧要复现这张表：这是"**服务端是唯一裁判**"的验收基准 —— 前端与后端跑同一份
 * 判据、同一份期望值，任何一边的结论不一样，就是有人把规则改歪了。
 */
public final class Cases {

  private Cases() {}

  /**
   * 造 map / list 的小工具。
   *
   * 为什么不用 Map.ofEntries / List.of：它们**不接受 null**，而用例表里的 null 是
   * 有意义的期望值（"合法时没有原因码"、"门不受阻时没有阻挡者"）。若把 null 键删掉，
   * 那几条断言就变成了空断言 —— 校验器悄悄失效，比失败更糟。
   */
  static java.util.Map<String, Object> m(Object... kv) {
    final java.util.Map<String, Object> r = new java.util.LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) r.put((String) kv[i], kv[i + 1]);
    return r;
  }

  static java.util.List<Object> l(Object... xs) {
    return new java.util.ArrayList<>(java.util.Arrays.asList(xs));
  }

  /** 用例表自带的型号目录（占地包络 w/d + 实测门数据），Java 侧只依赖这一份文件 */
  /** 用例表自带的型号目录（占地包络 w/d + 实测门数据），Java 侧只依赖这一份文件 */
  public static final java.util.Map<String, Object> CATALOG = java.util.Map.ofEntries(
      java.util.Map.entry("demo-cabinet-800", cat_c_demo_cabinet800()),
      java.util.Map.entry("demo-freezer-dual", cat_c_demo_fz040()),
      java.util.Map.entry("demo-freezer-upright", cat_c_demo_fz25u()),
      java.util.Map.entry("demo-freezer-chest", cat_c_demo_fz25c())
  );

  private static java.util.Map<String, Object> cat_c_demo_cabinet800() {
    return m("w", 1.15192501, "d", 1.09483496, "h", 1.98669948, "doors", l(m("node", "outer_door", "axis", "y", "openAngleDeg", 106, "hinge", m("x", 0.56298, "y", 1.22, "z", 0.42566), "leaf", m("x0", -0.57596, "x1", 0.57193, "z0", 0.29557, "z1", 0.54742), "swing", 1.14635)));
  }


  private static java.util.Map<String, Object> cat_c_demo_fz040() {
    return m("w", 0.99, "d", 0.8712, "h", 1.98, "doors", l(m("node", "upper_door", "axis", "y", "openAngleDeg", 106, "hinge", m("x", 0.41748, "y", 1.25119, "z", 0.32944), "leaf", m("x0", -0.44276, "x1", 0.43939, "z0", 0.2831, "z1", 0.4356), "swing", 0.86676)));
  }

  private static java.util.Map<String, Object> cat_c_demo_fz25u() {
    return m("_envelopeNote", "声明包络（= 库里的 recipe_json，库里存 mm）→ 700×690×1000 mm；doors 是实测门几何（product_model.hinge_nodes）。", "w", 0.7, "d", 0.69, "h", 1, "doors", l(m("node", "single_door", "axis", "y", "openAngleDeg", 106, "hinge", m("x", 0.30222, "y", 0.41032, "z", 0.2709), "leaf", m("x0", -0.31281, "x1", 0.30575, "z0", 0.2656, "z1", 0.34502), "swing", 0.61948)));
  }

  private static java.util.Map<String, Object> cat_c_demo_fz25c() {
    return m("_envelopeNote", "声明包络（= 库里的 recipe_json，库里存 mm）→ 1320×656×800 mm。旧的 735.075 / 646.866 / 1470.15 是**过时抄本**：实测门几何（doors）本来就是 1.32 这一套（leaf 宽 1.236 m），只有 w/d/h 抄错了。只有 door-clearance-lid-not-in-plan 用到它，而那条是结构判据（axis=x 不进平面），与尺寸无关 —— 所以改它不会动任何期望值。", "w", 1.32, "d", 0.656, "h", 0.8, "doors", l(m("node", "top_lid", "axis", "x", "openAngleDeg", -88.81, "hinge", m("x", 0, "y", 0.6831, "z", -0.32354), "leaf", m("x0", -0.61813, "x1", 0.61813, "z0", -0.328, "z1", 0.328), "swing", 0.65438)));
  }

  /** 47 条用例原样搬运：输入（room/walls/items/…）+ 期望结论（expect） */
  public static final java.util.List<Object> ALL = java.util.List.of(
      c_validate_flush_wall_ok(),
      c_validate_out_of_room(),
      c_validate_hit_interior_wall(),
      c_validate_overlap_item(),
      c_room_resize_keeps_inner_walls(),
      c_room_resize_out_of_range(),
      c_placement_auto_spot(),
      c_placement_limit_100(),
      c_scheme_roundtrip_identical(),
      c_scheme_accepts_legacy_v2_v3(),
      c_scheme_typed_errors(),
      c_door_hinge_formula(),
      c_collision_item_blocks(),
      c_collision_spawn_free(),
      c_door_clearance_open_ok(),
      c_door_clearance_blocked_by_item(),
      c_door_clearance_blocked_hard(),
      c_door_clearance_blocked_by_interior_wall(),
      c_door_clearance_lid_not_in_plan(),
      c_door_clearance_outer_wall(),
      c_door_clearance_rotated_180_free(),
      c_door_clearance_warn_level(),
      c_placement_auto_spot_fz25u(),
      c_scheme_roundtrip_fz25u(),
      c_wall_out_of_room(),
      c_wall_boundary_exempt(),
      c_scheme_roundtrip_wall_style(),
      c_scheme_roundtrip_wall_style_unknown(),
      c_validate_wall_diagonal_ok(),
      c_room_resize_keeps_diagonal(),
      c_collision_opening_passable(),
      c_collision_opening_jamb_blocks(),
      c_collision_window_blocks(),
      c_collision_door_mirror_passes(),
      c_scheme_roundtrip_openings(),
      c_scheme_roundtrip_window(),
      c_scheme_roundtrip_room_labels(),
      c_room_resize_keeps_openings(),
      c_room_resize_window_kept(),
      c_room_resize_drops_exterior_opening(),
      c_scheme_roundtrip_stale_room_label(),
      c_scheme_roundtrip_wall_role(),
      c_wall_exterior_float_offset_ok(),
      c_wall_exterior_poking_out(),
      c_wall_role_exterior_tolerance(),
      c_wall_role_interior_no_tolerance(),
      c_room_resize_keeps_wall_role()
  );

  /** validate · FIX-04：贴墙摆放必须合法（原型把外墙当障碍，误报'碰墙'） */
  private static java.util.Map<String, Object> c_validate_flush_wall_ok() {
    return m("id", "validate-flush-wall-ok", "rule", "validate", "why", "FIX-04：贴墙摆放必须合法（原型把外墙当障碍，误报'碰墙'）", "room", m("w", 8, "d", 6), "walls", l(), "items", l(), "item", m("id", 1, "p", "demo-cabinet-800", "x", 0.576, "z", 0.576, "r", 0), "expect", m("reason", null));
  }

  /** validate · FIX-04 反向：探出墙外仍必须报错（校验不得被削弱） */
  private static java.util.Map<String, Object> c_validate_out_of_room() {
    return m("id", "validate-out-of-room", "rule", "validate", "why", "FIX-04 反向：探出墙外仍必须报错（校验不得被削弱）", "room", m("w", 8, "d", 6), "walls", l(), "items", l(), "item", m("id", 1, "p", "demo-cabinet-800", "x", 0.1, "z", 0.5, "r", 0), "expect", m("reason", "out-of-room"));
  }

  /** validate · 内墙是障碍物，压在上面必须报错 */
  private static java.util.Map<String, Object> c_validate_hit_interior_wall() {
    return m("id", "validate-hit-interior-wall", "rule", "validate", "why", "内墙是障碍物，压在上面必须报错", "room", m("w", 8, "d", 6), "walls", l(m("a", l(2, 2), "b", l(2, 5))), "items", l(), "item", m("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 3.5, "r", 0), "expect", m("reason", "hit-wall"));
  }

  /** validate · 设备重叠要报出对方编号，供 UI 精准提示 */
  private static java.util.Map<String, Object> c_validate_overlap_item() {
    return m("id", "validate-overlap-item", "rule", "validate", "why", "设备重叠要报出对方编号，供 UI 精准提示", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 0.7, "z", 0.7, "r", 0)), "item", m("id", 3, "p", "demo-cabinet-800", "x", 1.6, "z", 0.7, "r", 0), "expect", m("reason", "overlap-item#1"));
  }

  /** room-resize · FIX-03：改尺寸必须保留仍在范围内的内墙（原型静默删除） */
  private static java.util.Map<String, Object> c_room_resize_keeps_inner_walls() {
    return m("id", "room-resize-keeps-inner-walls", "rule", "room-resize", "why", "FIX-03：改尺寸必须保留仍在范围内的内墙（原型静默删除）", "room", m("w", 12, "d", 9), "walls", l(m("a", l(0, 0), "b", l(12, 0)), m("a", l(12, 0), "b", l(12, 9)), m("a", l(12, 9), "b", l(0, 9)), m("a", l(0, 9), "b", l(0, 0)), m("a", l(2, 2), "b", l(2, 7))), "next", m("w", 14, "d", 11, "h", 2.8), "expect", m("ok", true, "kept", 1, "removed", 0, "wallCount", 5, "firstWall", m("a", l(0, 0), "b", l(14, 0))));
  }

  /** room-resize · 长宽 3–20 m 之外必须被拒 */
  private static java.util.Map<String, Object> c_room_resize_out_of_range() {
    return m("id", "room-resize-out-of-range", "rule", "room-resize", "why", "长宽 3–20 m 之外必须被拒", "room", m("w", 8, "d", 6), "walls", l(), "next", m("w", 25, "d", 6, "h", 2.8), "expect", m("ok", false, "error", "长宽范围 3–20 m，墙高 2–5 m"));
  }

  /** placement · 自动摆位必须与原型同序（Z 优先、步长 0.7/1.2/1.1） */
  private static java.util.Map<String, Object> c_placement_auto_spot() {
    return m("id", "placement-auto-spot", "rule", "placement", "why", "自动摆位必须与原型同序（Z 优先、步长 0.7/1.2/1.1）", "room", m("w", 8, "d", 6), "walls", l(), "items", l(), "product", "demo-cabinet-800", "expect", m("ok", true, "x", 0.7, "z", 0.7));
  }

  /** placement · FIX-06：第 101 台必须被拒（基线会堆到 103 台，然后自己导不回来） */
  private static java.util.Map<String, Object> c_placement_limit_100() {
    return m("id", "placement-limit-100", "rule", "placement", "why", "FIX-06：第 101 台必须被拒（基线会堆到 103 台，然后自己导不回来）", "room", m("w", 20, "d", 20), "walls", l(), "items", l(), "fillTo", 100, "product", "demo-freezer-dual", "expect", m("ok", false, "reason", "limit"));
  }

  /** scheme-roundtrip · FIX-05：导出→导入→再导出 必须逐字节一致；写入端与读取端限制共源 */
  private static java.util.Map<String, Object> c_scheme_roundtrip_identical() {
    return m("id", "scheme-roundtrip-identical", "rule", "scheme-roundtrip", "why", "FIX-05：导出→导入→再导出 必须逐字节一致；写入端与读取端限制共源", "room", m("w", 14, "d", 11, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(14, 0)), m("a", l(14, 0), "b", l(14, 11)), m("a", l(14, 11), "b", l(0, 11)), m("a", l(0, 11), "b", l(0, 0)), m("a", l(2, 2), "b", l(2, 7))), "items", l(m("id", 4, "p", "demo-cabinet-800", "x", 0.7, "z", 0.7, "r", 0, "doorAmount", 0), m("id", 5, "p", "demo-freezer-dual", "x", 1.9, "z", 0.7, "r", 0, "doorAmount", 0), m("id", 6, "p", "demo-freezer-dual", "x", 3.1, "z", 0.7, "r", 90, "doorAmount", 0)), "expect", m("ok", true, "identical", true, "nextId", 7, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** scheme-accept · 用户手里已有旧版本导出的文件，必须继续能打开 */
  private static java.util.Map<String, Object> c_scheme_accepts_legacy_v2_v3() {
    return m("id", "scheme-accepts-legacy-v2-v3", "rule", "scheme-accept", "why", "用户手里已有旧版本导出的文件，必须继续能打开", "formats", l("legacy-spatial-v2", "legacy-spatial-v3", "scene-space-designer", "scene-space-designer-openings", "scene-space-designer-windows", "scene-space-designer-scene"), "expect", m("allOk", true));
  }

  /** scheme-errors · FIX-21：不同失败原因要能分辨（原型 4 类共用一句话） */
  private static java.util.Map<String, Object> c_scheme_typed_errors() {
    return m("id", "scheme-typed-errors", "rule", "scheme-errors", "why", "FIX-21：不同失败原因要能分辨（原型 4 类共用一句话）", "samples", l(m("bad", "not-json", "reason", "not-json"), m("bad", "bad-format", "reason", "bad-format"), m("bad", "bad-room", "reason", "bad-room"), m("bad", "too-many-walls", "reason", "too-many-walls"), m("bad", "duplicate-id", "reason", "duplicate-id"), m("bad", "bad-wall", "reason", "bad-wall")), "expect", m("exact", true));
  }

  /** door · 铰链旋转公式全项目唯一：rotation[axis] = openAngle × amount */
  private static java.util.Map<String, Object> c_door_hinge_formula() {
    return m("id", "door-hinge-formula", "rule", "door", "why", "铰链旋转公式全项目唯一：rotation[axis] = openAngle × amount", "hinge", m("axis", "y", "openAngle", 1.85), "amount", 0.5, "expect", m("rotation", m("y", 0.925)));
  }

  /** collision · 站在设备里必须判定被挡（FIX-17 卡死的成因，R3 要在此之上加脱困） */
  private static java.util.Map<String, Object> c_collision_item_blocks() {
    return m("id", "collision-item-blocks", "rule", "collision", "why", "站在设备里必须判定被挡（FIX-17 卡死的成因，R3 要在此之上加脱困）", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(m("id", 1, "p", "demo-freezer-dual", "x", 4, "z", 3, "r", 0)), "point", l(4, 3), "expect", m("blocked", true));
  }

  /** collision-spawn · 出生点必须保证可站立，否则漫游进入即卡死 */
  private static java.util.Map<String, Object> c_collision_spawn_free() {
    return m("id", "collision-spawn-free", "rule", "collision-spawn", "why", "出生点必须保证可站立，否则漫游进入即卡死", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(m("id", 1, "p", "demo-freezer-dual", "x", 4, "z", 3, "r", 0)), "expect", m("spawnIsFree", true));
  }

  /** door-clearance · 接缝 A（A3）：空旷房间里门能开到底 → 绿灯 */
  private static java.util.Map<String, Object> c_door_clearance_open_ok() {
    return m("id", "door-clearance-open-ok", "rule", "door-clearance", "why", "接缝 A（A3）：空旷房间里门能开到底 → 绿灯", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", 106, "level", "ok", "unobstructed", true, "blockedKind", null, "blockedId", null));
  }

  /** door-clearance · 门前方 0.4 m 有邻柜：能开但被挡 → 黄灯/红灯并指名撞到谁 */
  private static java.util.Map<String, Object> c_door_clearance_blocked_by_item() {
    return m("id", "door-clearance-blocked-by-item", "rule", "door-clearance", "why", "门前方 0.4 m 有邻柜：能开但被挡 → 黄灯/红灯并指名撞到谁", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0), m("id", 2, "p", "demo-freezer-dual", "x", 2, "z", 3.35, "r", 0, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", 19, "level", "bad", "unobstructed", false, "blockedKind", "item", "blockedId", 2));
  }

  /** door-clearance · 邻柜贴到门前：连关门位（0°）都撞 → 打不开。注意 freeDeg=0 时**占地本身也已经重叠**（关门位的门板落在设备占地框内），所以净空规则真正独立贡献的区间是 (0, maxDeg] */
  private static java.util.Map<String, Object> c_door_clearance_blocked_hard() {
    return m("id", "door-clearance-blocked-hard", "rule", "door-clearance", "why", "邻柜贴到门前：连关门位（0°）都撞 → 打不开。注意 freeDeg=0 时**占地本身也已经重叠**（关门位的门板落在设备占地框内），所以净空规则真正独立贡献的区间是 (0, maxDeg]", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0), m("id", 2, "p", "demo-freezer-dual", "x", 2, "z", 2.6, "r", 0, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", 0, "level", "bad", "unobstructed", false, "blockedKind", "item", "blockedId", 2));
  }

  /** door-clearance · 内墙横在门前 1 m：门板扫到内墙，与撞设备同一口径 */
  private static java.util.Map<String, Object> c_door_clearance_blocked_by_interior_wall() {
    return m("id", "door-clearance-blocked-by-interior-wall", "rule", "door-clearance", "why", "内墙横在门前 1 m：门板扫到内墙，与撞设备同一口径", "room", m("w", 8, "d", 6), "walls", l(m("a", l(1, 3), "b", l(4, 3))), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", 20, "level", "bad", "unobstructed", false, "blockedKind", "wall", "blockedId", null));
  }

  /** door-clearance · 上盖（绕水平轴）不参与平面净空：往竖直方向扫，平面上不占地方 */
  private static java.util.Map<String, Object> c_door_clearance_lid_not_in_plan() {
    return m("id", "door-clearance-lid-not-in-plan", "rule", "door-clearance", "why", "上盖（绕水平轴）不参与平面净空：往竖直方向扫，平面上不占地方", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-freezer-chest", "x", 2, "z", 2, "r", 0, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", null, "level", "n/a", "unobstructed", false, "blockedKind", null, "blockedId", null));
  }

  /** door-clearance · 门顶到外墙：外墙与房间边界同一口径（不重复算两次） */
  private static java.util.Map<String, Object> c_door_clearance_outer_wall() {
    return m("id", "door-clearance-outer-wall", "rule", "door-clearance", "why", "门顶到外墙：外墙与房间边界同一口径（不重复算两次）", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 5.6, "r", 0, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", 0, "level", "bad", "unobstructed", false, "blockedKind", "room", "blockedId", null));
  }

  /** door-clearance · 转 180° 后门朝屋内：同样不受阻（旋转口径与 corners() 一致） */
  private static java.util.Map<String, Object> c_door_clearance_rotated_180_free() {
    return m("id", "door-clearance-rotated-180-free", "rule", "door-clearance", "why", "转 180° 后门朝屋内：同样不受阻（旋转口径与 corners() 一致）", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-freezer-dual", "x", 2, "z", 5.6, "r", 180, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", 106, "level", "ok", "unobstructed", true, "blockedKind", null, "blockedId", null));
  }

  /** door-clearance · 可开角度落在 60°~90°：黄灯（90° 阈值由用户 2026-09-21 拍板 —— "门要能开到底才叫能用"） */
  private static java.util.Map<String, Object> c_door_clearance_warn_level() {
    return m("id", "door-clearance-warn-level", "rule", "door-clearance", "why", "可开角度落在 60°~90°：黄灯（90° 阈值由用户 2026-09-21 拍板 —— \"门要能开到底才叫能用\"）", "room", m("w", 8, "d", 6), "walls", l(), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 2, "z", 2, "r", 0, "doorAmount", 0), m("id", 2, "p", "demo-freezer-dual", "x", 2, "z", 3.92, "r", 0, "doorAmount", 0)), "item", m("id", 1), "expect", m("freeDeg", 62, "level", "warn", "unobstructed", false, "blockedKind", "item", "blockedId", 2));
  }

  /** placement · 真目录第 4 款（demo-freezer-upright）必须能被服务端摆下 —— 曾经「界面能摆、服务端报 bad-item」就是因为内核目录只有 3 款。刻意**只断 ok**：尺寸是库里的，改尺寸不该让这条变红（那是别的用例的事）。 */
  private static java.util.Map<String, Object> c_placement_auto_spot_fz25u() {
    return m("id", "placement-auto-spot-demo-freezer-upright", "rule", "placement", "why", "真目录第 4 款（demo-freezer-upright）必须能被服务端摆下 —— 曾经「界面能摆、服务端报 bad-item」就是因为内核目录只有 3 款。刻意**只断 ok**：尺寸是库里的，改尺寸不该让这条变红（那是别的用例的事）。", "room", m("w", 8, "d", 6), "walls", l(), "items", l(), "product", "demo-freezer-upright", "expect", m("ok", true));
  }

  /** scheme-roundtrip · 真目录第 4 款也要能 导出→导入→再导出 逐字节一致（也是「每一款都被用例用过」的覆盖证据） */
  private static java.util.Map<String, Object> c_scheme_roundtrip_fz25u() {
    return m("id", "scheme-roundtrip-demo-freezer-upright", "rule", "scheme-roundtrip", "why", "真目录第 4 款也要能 导出→导入→再导出 逐字节一致（也是「每一款都被用例用过」的覆盖证据）", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(m("id", 1, "p", "demo-freezer-upright", "x", 1.5, "z", 1.5, "r", 0, "doorAmount", 0)), "expect", m("ok", true, "identical", true, "nextId", 2, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** validate-wall · B19：墙的端点必须落在房间内。外墙跳过（它就是边界本身），但**一端贴边、另一端探出去**的墙不豁免 —— 粗粒度实现会把这种也放过 */
  private static java.util.Map<String, Object> c_wall_out_of_room() {
    return m("id", "wall-out-of-room", "rule", "validate-wall", "why", "B19：墙的端点必须落在房间内。外墙跳过（它就是边界本身），但**一端贴边、另一端探出去**的墙不豁免 —— 粗粒度实现会把这种也放过", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(2, 2), "b", l(6, 2)), m("a", l(2, 4), "b", l(6, 4)), m("a", l(7.5, 3), "b", l(8.5, 3)), m("a", l(0, 3), "b", l(-1, 3)), m("a", l(9, 3), "b", l(9, 6))), "expect", m("badWalls", l(m("index", 3, "reason", "wall-out-of-room"), m("index", 4, "reason", "wall-out-of-room"), m("index", 5, "reason", "wall-out-of-room"))));
  }

  /** validate-wall · 贴着房间四条边的墙不是越界（它就是边界）；一端贴边、另一端在房间里的内墙也不越界 */
  private static java.util.Map<String, Object> c_wall_boundary_exempt() {
    return m("id", "wall-boundary-exempt", "rule", "validate-wall", "why", "贴着房间四条边的墙不是越界（它就是边界）；一端贴边、另一端在房间里的内墙也不越界", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(0, 0), "b", l(0, 6)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(0, 6), "b", l(8, 6)), m("a", l(0, 3), "b", l(4, 3))), "expect", m("badWalls", l()));
  }

  /** scheme-roundtrip · 视图档位（solid/half/light）必须**进方案**并且原样存回来 —— 交付图是浏览器现画的，档位丢了则同一次交付谁点导出都不一样 */
  private static java.util.Map<String, Object> c_scheme_roundtrip_wall_style() {
    return m("id", "scheme-roundtrip-wall-style", "rule", "scheme-roundtrip", "why", "视图档位（solid/half/light）必须**进方案**并且原样存回来 —— 交付图是浏览器现画的，档位丢了则同一次交付谁点导出都不一样", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 1.2, "z", 1.2, "r", 0, "doorAmount", 0)), "view", m("wallOpacity", "half"), "expect", m("ok", true, "identical", true, "styleOut", "half", "nextId", 2, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** scheme-roundtrip · 认不得的档位两侧都当没写（不报错、不猜、不回就近值）—— 未来版本的档位不该让一份合法方案打不开 */
  private static java.util.Map<String, Object> c_scheme_roundtrip_wall_style_unknown() {
    return m("id", "scheme-roundtrip-wall-style-unknown", "rule", "scheme-roundtrip", "why", "认不得的档位两侧都当没写（不报错、不猜、不回就近值）—— 未来版本的档位不该让一份合法方案打不开", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(m("id", 1, "p", "demo-cabinet-800", "x", 1.2, "z", 1.2, "r", 0, "doorAmount", 0)), "view", m("wallOpacity", "neon"), "expect", m("ok", true, "identical", true, "styleOut", null, "nextId", 2, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** validate-wall · 斜墙（两点之间的直墙）合法，而且斜墙的**端点**同样要落在房间内 —— 内核的墙矩形本来就按角度构造，这条把「与角度无关」钉住 */
  private static java.util.Map<String, Object> c_validate_wall_diagonal_ok() {
    return m("id", "validate-wall-diagonal-ok", "rule", "validate-wall", "why", "斜墙（两点之间的直墙）合法，而且斜墙的**端点**同样要落在房间内 —— 内核的墙矩形本来就按角度构造，这条把「与角度无关」钉住", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(0, 0), "b", l(0, 6)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(0, 6), "b", l(8, 6)), m("a", l(1, 1), "b", l(5, 4)), m("a", l(1, 5), "b", l(5, 7))), "expect", m("badWalls", l(m("index", 5, "reason", "wall-out-of-room"))));
  }

  /** room-resize · 改房间尺寸时，斜墙的保留判据要**四个坐标全比**（原型只比 x/z 的下界与 xx/zz 的上界，「另一头越界」会漏过去） */
  private static java.util.Map<String, Object> c_room_resize_keeps_diagonal() {
    return m("id", "room-resize-keeps-diagonal", "rule", "room-resize", "why", "改房间尺寸时，斜墙的保留判据要**四个坐标全比**（原型只比 x/z 的下界与 xx/zz 的上界，「另一头越界」会漏过去）", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0)), m("a", l(1, 1), "b", l(5, 4)), m("a", l(1, 5), "b", l(9, 5))), "next", m("w", 6, "d", 6, "h", 2.8), "expect", m("ok", true, "kept", 1, "removed", 1, "wallCount", 5, "firstWall", m("a", l(0, 0), "b", l(6, 0))));
  }

  /** collision · 门洞是**能走过去**的：墙在洞口处不再挡人（W1）。判据与下一条成对 —— 少了它，"洞没挖开"也会全绿 */
  private static java.util.Map<String, Object> c_collision_opening_passable() {
    return m("id", "collision-opening-passable", "rule", "collision", "why", "门洞是**能走过去**的：墙在洞口处不再挡人（W1）。判据与下一条成对 —— 少了它，\"洞没挖开\"也会全绿", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0)), m("a", l(2, 1), "b", l(2, 5), "openings", l(m("at", 2, "w", 0.9, "h", 2.1)))), "items", l(), "point", l(2, 3), "expect", m("blocked", false));
  }

  /** collision · 成对的另一半：洞口**旁边**的墙身照旧挡人（0.15 m 在安全距离 0.30 m 之内）—— 少了它，"整面墙被挖空"也会全绿 */
  private static java.util.Map<String, Object> c_collision_opening_jamb_blocks() {
    return m("id", "collision-opening-jamb-blocks", "rule", "collision", "why", "成对的另一半：洞口**旁边**的墙身照旧挡人（0.15 m 在安全距离 0.30 m 之内）—— 少了它，\"整面墙被挖空\"也会全绿", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0)), m("a", l(2, 1), "b", l(2, 5), "openings", l(m("at", 2, "w", 0.9, "h", 2.1)))), "items", l(), "point", l(2, 2.4), "expect", m("blocked", true));
  }

  /** collision · ⭐ 窗**不能走人**：窗洞正中照旧挡人（W2）。与下一条 `collision-door-mirror-passes` 成对 —— 两条的墙、点位、`at/w/h` 逐字相同，只差窗多出来的那两个字段。 少了这一条，「窗也被挖空了」会全绿，而界面上完全看不出来（墙上有洞、看着对） */
  private static java.util.Map<String, Object> c_collision_window_blocks() {
    return m("id", "collision-window-blocks", "rule", "collision", "why", "⭐ 窗**不能走人**：窗洞正中照旧挡人（W2）。与下一条 `collision-door-mirror-passes` 成对 —— 两条的墙、点位、`at/w/h` 逐字相同，只差窗多出来的那两个字段。 少了这一条，「窗也被挖空了」会全绿，而界面上完全看不出来（墙上有洞、看着对）", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0)), m("a", l(2, 1), "b", l(2, 5), "openings", l(m("at", 2, "w", 1.2, "h", 1.5, "kind", "window", "sill", 0.9)))), "items", l(), "point", l(2, 3), "expect", m("blocked", true));
  }

  /** collision · 成对的另一半（**同一面墙、同一个点位**，只有洞口类别不同）：门洞在那儿是能走过去的 —— 少了它，「窗挡住了人」可以靠「整面墙根本没建/被挖空」蒙过去 */
  private static java.util.Map<String, Object> c_collision_door_mirror_passes() {
    return m("id", "collision-door-mirror-passes", "rule", "collision", "why", "成对的另一半（**同一面墙、同一个点位**，只有洞口类别不同）：门洞在那儿是能走过去的 —— 少了它，「窗挡住了人」可以靠「整面墙根本没建/被挖空」蒙过去", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0)), m("a", l(2, 1), "b", l(2, 5), "openings", l(m("at", 2, "w", 1.2, "h", 1.5)))), "items", l(), "point", l(2, 3), "expect", m("blocked", false));
  }

  /** scheme-roundtrip · 带门洞的方案必须**导出→导入→再导出**逐字节一致，而且门洞一个都不许丢（服务端 stateOf 是字段白名单，漏一个字段就会在保存/分享/交付链上无警告消失 —— FIX-05 的病因） */
  private static java.util.Map<String, Object> c_scheme_roundtrip_openings() {
    return m("id", "scheme-roundtrip-openings", "rule", "scheme-roundtrip", "why", "带门洞的方案必须**导出→导入→再导出**逐字节一致，而且门洞一个都不许丢（服务端 stateOf 是字段白名单，漏一个字段就会在保存/分享/交付链上无警告消失 —— FIX-05 的病因）", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0), "openings", l(m("at", 4, "w", 1.2, "h", 2.1))), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(), "expect", m("ok", true, "identical", true, "openingCount", 1, "nextId", 1, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** scheme-roundtrip · 带**窗**的方案必须导出→导入→再导出逐字节一致：`kind`/`sill` 在服务端 `stateOf` 的字段白名单上漏一个，窗就会在保存/分享/交付链上无警告消失**或者被当成门**（FIX-05 的病因）。`identical` 顺带钉住「窗没有被降级成落地洞」——降级会改变字节 */
  private static java.util.Map<String, Object> c_scheme_roundtrip_window() {
    return m("id", "scheme-roundtrip-window", "rule", "scheme-roundtrip", "why", "带**窗**的方案必须导出→导入→再导出逐字节一致：`kind`/`sill` 在服务端 `stateOf` 的字段白名单上漏一个，窗就会在保存/分享/交付链上无警告消失**或者被当成门**（FIX-05 的病因）。`identical` 顺带钉住「窗没有被降级成落地洞」——降级会改变字节", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0), "openings", l(m("at", 4, "w", 1.2, "h", 1.5, "kind", "window", "sill", 0.9))), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(), "expect", m("ok", true, "identical", true, "openingCount", 1, "nextId", 1, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** scheme-roundtrip · 房间名（M1a）必须**导出→导入→再导出**逐字节一致，而且一个名字都不许丢（服务端 stateOf 是字段白名单，漏掉 roomLabels 就会在保存/分享/交付链上无警告消失 —— 与门洞同一处风险） */
  private static java.util.Map<String, Object> c_scheme_roundtrip_room_labels() {
    return m("id", "scheme-roundtrip-room-labels", "rule", "scheme-roundtrip", "why", "房间名（M1a）必须**导出→导入→再导出**逐字节一致，而且一个名字都不许丢（服务端 stateOf 是字段白名单，漏掉 roomLabels 就会在保存/分享/交付链上无警告消失 —— 与门洞同一处风险）", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0)), m("a", l(4, 0), "b", l(4, 6))), "items", l(), "roomLabels", m("h6xjvy", "冰箱间", "1pb6owk", "离心机房"), "expect", m("ok", true, "identical", true, "roomLabelCount", 2, "nextId", 1, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** room-resize · 内墙上的门洞在改房间尺寸时**随墙一起走**（墙是对象，门洞是它的字段）—— 静默丢掉就是丢数据 */
  private static java.util.Map<String, Object> c_room_resize_keeps_openings() {
    return m("id", "room-resize-keeps-openings", "rule", "room-resize", "why", "内墙上的门洞在改房间尺寸时**随墙一起走**（墙是对象，门洞是它的字段）—— 静默丢掉就是丢数据", "room", m("w", 12, "d", 9, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(12, 0)), m("a", l(12, 0), "b", l(12, 9)), m("a", l(12, 9), "b", l(0, 9)), m("a", l(0, 9), "b", l(0, 0)), m("a", l(2, 2), "b", l(2, 7), "openings", l(m("at", 2.5, "w", 0.9, "h", 2.1)))), "items", l(), "next", m("w", 14, "d", 9, "h", 2.8), "expect", m("ok", true, "kept", 1, "removed", 0, "wallCount", 5, "openingsKept", 1, "openingsDropped", 0));
  }

  /** room-resize · 内墙上的**窗**在改房间尺寸时随墙一起走，而且**不许降级成落地洞** —— `windowCount` 就是钉这一条的：只数洞口个数的话，窗被降级成门照样是 1（设计决策记录第 4 处窄门，也是最难发现的一处） */
  private static java.util.Map<String, Object> c_room_resize_window_kept() {
    return m("id", "room-resize-window-kept", "rule", "room-resize", "why", "内墙上的**窗**在改房间尺寸时随墙一起走，而且**不许降级成落地洞** —— `windowCount` 就是钉这一条的：只数洞口个数的话，窗被降级成门照样是 1（设计决策记录第 4 处窄门，也是最难发现的一处）", "room", m("w", 12, "d", 9, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(12, 0)), m("a", l(12, 0), "b", l(12, 9)), m("a", l(12, 9), "b", l(0, 9)), m("a", l(0, 9), "b", l(0, 0)), m("a", l(2, 2), "b", l(2, 7), "openings", l(m("at", 2.5, "w", 1.2, "h", 1.5, "kind", "window", "sill", 0.9)))), "items", l(), "next", m("w", 14, "d", 9, "h", 2.8), "expect", m("ok", true, "kept", 1, "removed", 0, "wallCount", 5, "openingsKept", 1, "openingsDropped", 0, "windowCount", 1));
  }

  /** room-resize · 外墙是**重建**的：搬过去放不下的门洞要如实报删（`openingsDropped`）—— 许静默丢就是许丢数据 */
  private static java.util.Map<String, Object> c_room_resize_drops_exterior_opening() {
    return m("id", "room-resize-drops-exterior-opening", "rule", "room-resize", "why", "外墙是**重建**的：搬过去放不下的门洞要如实报删（`openingsDropped`）—— 许静默丢就是许丢数据", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0), "openings", l(m("at", 3.6, "w", 0.9, "h", 2.1))), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0))), "items", l(), "next", m("w", 4, "d", 6, "h", 2.8), "expect", m("ok", true, "kept", 0, "removed", 0, "wallCount", 4, "openingsKept", 0, "openingsDropped", 1));
  }

  /** scheme-roundtrip · M1a 房间名：暂时对不上房间的名字（界面说「在等房间」）**不许在导出时被静默丢掉** —— 名字跟着几何 id 走，墙改回去名字就回来。同时钉住 JS 与 Java 的镜像：这条规则**不许依赖面遍历**（Java 侧没有房间算法），否则两边导出的字节会分叉。 */
  private static java.util.Map<String, Object> c_scheme_roundtrip_stale_room_label() {
    return m("id", "scheme-roundtrip-stale-room-label", "rule", "scheme-roundtrip", "why", "M1a 房间名：暂时对不上房间的名字（界面说「在等房间」）**不许在导出时被静默丢掉** —— 名字跟着几何 id 走，墙改回去名字就回来。同时钉住 JS 与 Java 的镜像：这条规则**不许依赖面遍历**（Java 侧没有房间算法），否则两边导出的字节会分叉。", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(8, 0), "b", l(8, 6)), m("a", l(8, 6), "b", l(0, 6)), m("a", l(0, 6), "b", l(0, 0)), m("a", l(4, 0), "b", l(4, 6))), "items", l(), "roomLabels", m("h6xjvy", "冷藏间", "zzzzzzz", "等在等"), "expect", m("ok", true, "identical", true, "roomLabelCount", 2, "nextId", 1, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** scheme-roundtrip · W3：墙的角色（exterior / interior）是**持久化语义**，必须进方案并在 导出→导入→再导出 上逐字节一致 —— 服务端 stateOf 是字段白名单，漏掉 role 会让墙在保存/分享/交付链上无警告地退回「按几何猜」，用户下次打开时同一面墙挡不挡设备就变了（FIX-05 同一形状）。同一条里带一个门洞，顺带钉住字段顺序 a,b,openings?,role? */
  private static java.util.Map<String, Object> c_scheme_roundtrip_wall_role() {
    return m("id", "scheme-roundtrip-wall-role", "rule", "scheme-roundtrip", "why", "W3：墙的角色（exterior / interior）是**持久化语义**，必须进方案并在 导出→导入→再导出 上逐字节一致 —— 服务端 stateOf 是字段白名单，漏掉 role 会让墙在保存/分享/交付链上无警告地退回「按几何猜」，用户下次打开时同一面墙挡不挡设备就变了（FIX-05 同一形状）。同一条里带一个门洞，顺带钉住字段顺序 a,b,openings?,role?", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0), "openings", l(m("at", 4, "w", 1.2, "h", 2.1)), "role", "exterior"), m("a", l(8, 0), "b", l(8, 6), "role", "exterior"), m("a", l(8, 6), "b", l(0, 6), "role", "exterior"), m("a", l(0, 6), "b", l(0, 0), "role", "exterior"), m("a", l(2, 2), "b", l(2, 5), "role", "interior")), "items", l(), "expect", m("ok", true, "identical", true, "openingCount", 1, "nextId", 1, "format", "scene-space-designer-scene-routes-columns"));
  }

  /** validate-wall · 外墙坐标本来就恰好是 0 / w / d，浮点会让它差 1e-16 → 外墙给 1e-6 容差。这条钉住「贴边外墙不会因为浮点残差被判越界」；容差**不是**无限宽由下一对 wall-exterior-poking-out 钉住（只多探 0.5 m 就必须报） */
  private static java.util.Map<String, Object> c_wall_exterior_float_offset_ok() {
    return m("id", "wall-exterior-float-offset-ok", "rule", "validate-wall", "why", "外墙坐标本来就恰好是 0 / w / d，浮点会让它差 1e-16 → 外墙给 1e-6 容差。这条钉住「贴边外墙不会因为浮点残差被判越界」；容差**不是**无限宽由下一对 wall-exterior-poking-out 钉住（只多探 0.5 m 就必须报）", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8.0000001, 0)), m("a", l(8, 0), "b", l(8, 6.0000001)), m("a", l(0, 6), "b", l(8, 6)), m("a", l(0, 0), "b", l(0, 6)), m("a", l(2, 2), "b", l(2, 5))), "expect", m("badWalls", l()));
  }

  /** validate-wall · ⭐ 与 wall-exterior-float-offset-ok 成对：一头贴着外墙那条线、另一头探出去 0.5 m 的墙**必须报**。旧 Java 侧对「外墙」整条跳过 —— 这种墙会被判成合法，而 JS 写端/读端调的是同一个带容差的函数（保存能过、导入却拒绝，正是 FIX-05 的形状） */
  private static java.util.Map<String, Object> c_wall_exterior_poking_out() {
    return m("id", "wall-exterior-poking-out", "rule", "validate-wall", "why", "⭐ 与 wall-exterior-float-offset-ok 成对：一头贴着外墙那条线、另一头探出去 0.5 m 的墙**必须报**。旧 Java 侧对「外墙」整条跳过 —— 这种墙会被判成合法，而 JS 写端/读端调的是同一个带容差的函数（保存能过、导入却拒绝，正是 FIX-05 的形状）", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8, 0)), m("a", l(0, 0), "b", l(8.5, 0))), "expect", m("badWalls", l(m("index", 1, "reason", "wall-out-of-room"))));
  }

  /** validate-wall · role 是语义、不是豁免：标了 exterior 的墙仍按外墙容差（1e-6）判，探出去照样报 —— 角色不许把越界判据变松 */
  private static java.util.Map<String, Object> c_wall_role_exterior_tolerance() {
    return m("id", "wall-role-exterior-tolerance", "rule", "validate-wall", "why", "role 是语义、不是豁免：标了 exterior 的墙仍按外墙容差（1e-6）判，探出去照样报 —— 角色不许把越界判据变松", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 0), "b", l(8.5, 0), "role", "exterior")), "expect", m("badWalls", l(m("index", 0, "reason", "wall-out-of-room"))));
  }

  /** validate-wall · ⭐ 与 wall-role-exterior-tolerance 成对：标了 interior 的贴边墙按内墙判、没有容差，探出 1e-7 也报 —— 「角色优先于几何」在这里第一次被机器钉住；按几何旧判据会把它当外墙而放过 */
  private static java.util.Map<String, Object> c_wall_role_interior_no_tolerance() {
    return m("id", "wall-role-interior-no-tolerance", "rule", "validate-wall", "why", "⭐ 与 wall-role-exterior-tolerance 成对：标了 interior 的贴边墙按内墙判、没有容差，探出 1e-7 也报 —— 「角色优先于几何」在这里第一次被机器钉住；按几何旧判据会把它当外墙而放过", "room", m("w", 8, "d", 6), "walls", l(m("a", l(0, 1), "b", l(8.0000001, 1), "role", "interior")), "expect", m("badWalls", l(m("index", 0, "reason", "wall-out-of-room"))));
  }

  /** room-resize · 改房间尺寸时外墙是**重建**的，但重建 ≠ 换身份：旧外墙标了 exterior 的，重建之后同一面还是 exterior。firstWall 两侧读同一条记录（JS 是墙对象、Java 是 wallJson），漏了角色就会在这里对不上 —— 用户改一次尺寸，墙的语义不许静默退回「按几何猜」 */
  private static java.util.Map<String, Object> c_room_resize_keeps_wall_role() {
    return m("id", "room-resize-keeps-wall-role", "rule", "room-resize", "why", "改房间尺寸时外墙是**重建**的，但重建 ≠ 换身份：旧外墙标了 exterior 的，重建之后同一面还是 exterior。firstWall 两侧读同一条记录（JS 是墙对象、Java 是 wallJson），漏了角色就会在这里对不上 —— 用户改一次尺寸，墙的语义不许静默退回「按几何猜」", "room", m("w", 8, "d", 6, "h", 2.8), "walls", l(m("a", l(0, 0), "b", l(8, 0), "role", "exterior"), m("a", l(8, 0), "b", l(8, 6), "role", "exterior"), m("a", l(8, 6), "b", l(0, 6), "role", "exterior"), m("a", l(0, 6), "b", l(0, 0), "role", "exterior"), m("a", l(2, 2), "b", l(2, 5), "role", "interior")), "items", l(), "next", m("w", 10, "d", 8, "h", 2.8), "expect", m("ok", true, "kept", 1, "removed", 0, "wallCount", 5, "firstWall", m("a", l(0, 0), "b", l(10, 0), "role", "exterior")));
  }


  /** 用例表版本（写进报告，便于对照） */
  public static final int VERSION = 11;
}
