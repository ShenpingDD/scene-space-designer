package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * AdminGateTest —— 角色门的判据。
 *
 * 钉的是**行为**（谁进谁不进），不是实现。这道门是**服务端判定的边界**：
 * 前端藏的是入口，后端守的是数据（`docs/80` §四第 1 项）。
 * 所以每一条都写清楚"它到底挡了谁"。
 */
class AdminGateTest {

  @Test
  void admin_role_passes() {
    assertTrue(AdminGate.canAdmin("admin"));
  }

  @Test
  void leading_and_trailing_space_does_not_break_it() {
    assertTrue(AdminGate.canAdmin("  admin  "), "库里多一个空格不该把人挡在门外");
  }

  @Test
  void other_roles_are_rejected() {
    assertFalse(AdminGate.canAdmin("viewer"));
    assertFalse(AdminGate.canAdmin("editor"));
    assertFalse(AdminGate.canAdmin("Admin"), "大小写不认 —— 角色代码是机器标识，不做模糊匹配");
  }

  @Test
  void null_and_blank_are_rejected_without_throwing() {
    assertFalse(AdminGate.canAdmin(null), "没有用户行时不许抛异常（服务要能起来）");
    assertFalse(AdminGate.canAdmin(""));
    assertFalse(AdminGate.canAdmin("   "));
  }

  // ── R6-4 B4e：四档 ──────────────────────────────────────────────────

  @Test
  void four_roles_can_see_and_only_three_of_them_enter_the_console() {
    for (final String r : AdminGate.ROLES) {
      assertTrue(AdminGate.canView(r), r + " 都该能看（只读也是一档，不是「没有权限」）");
    }
    assertTrue(AdminGate.canEnterAdmin("admin"));
    assertTrue(AdminGate.canEnterAdmin("editor"), "维护端维护者当然能进维护端");
    assertTrue(AdminGate.canEnterAdmin("viewer"), "只读也要进得去 —— 进不去就看不见自己为什么不能改");
    assertFalse(AdminGate.canEnterAdmin("designer"), "前台设计师的工作面是设计器，不是维护端");
  }

  @Test
  void capabilities_are_graded_not_binary() {
    // admin：全都能
    for (final var e : AdminGate.caps("admin").entrySet()) {
      assertTrue(e.getValue(), "admin 应当能做 " + e.getKey());
    }
    // editor：能维护产品与方案，**不能发参数**（docs/32 §风险表：参数是全局口径）
    assertTrue(AdminGate.canMaintain("editor"));
    assertTrue(AdminGate.canWriteSchemes("editor"));
    assertFalse(AdminGate.canPublishParams("editor"), "发布参数只有 admin —— 这是这一档存在的意义");
    assertFalse(AdminGate.canManageUsers("editor"), "管用户只有 admin（建号、改角色、重置口令都是把权限交出去）");
    assertTrue(AdminGate.canDesign("editor"),
        "editor 的前台工作面里也有设计器：design 与 writeSchemes 两个集合一样大（docs/80 §四第 3 项）");
    // designer：能设计，不能维护目录、不能发参数、进不了维护端
    assertTrue(AdminGate.canDesign("designer"));
    assertTrue(AdminGate.canWriteSchemes("designer"));
    assertFalse(AdminGate.canMaintain("designer"));
    assertFalse(AdminGate.canPublishParams("designer"));
    assertFalse(AdminGate.canEnterAdmin("designer"));
    // viewer：只读 —— 一件写动作都不许
    assertTrue(AdminGate.canView("viewer"));
    assertFalse(AdminGate.canMaintain("viewer"));
    assertFalse(AdminGate.canDesign("viewer"));
    assertFalse(AdminGate.canWriteSchemes("viewer"));
    assertFalse(AdminGate.canPublishParams("viewer"));
  }

  @Test
  void unknown_role_gets_nothing_and_is_told_so() {
    for (final String r : new String[]{"", "   ", "Admin", "root", "manager", null}) {
      assertFalse(AdminGate.canView(r), "认不得的角色码不能有任何权限（fail-closed）：" + r);
      assertFalse(AdminGate.canEnterAdmin(r), "认不得的角色码进不了维护端：" + r);
      assertFalse(AdminGate.canPublishParams(r), "认不得的角色码更不能发参数：" + r);
      assertFalse(AdminGate.isKnown(r), "认不得就是认不得：" + r);
    }
    assertTrue(AdminGate.isKnown("editor"));
    assertTrue(AdminGate.isKnown("  viewer  "), "前后空格不算「另一个角色」");
    assertFalse(AdminGate.isKnown("Editor"), "大小写不模糊匹配是刻意的（见 normalize 的注释）");
  }

  @Test
  void caps_map_is_complete_so_the_ui_never_has_to_guess() {
    final var caps = AdminGate.caps("viewer");
    assertEquals(7, caps.size(), "能力表少一项，前端就会去猜一项 —— 而猜出来的权限迟早是错的");
    for (final String k : new String[]{"enterAdmin", "view", "maintain", "design",
        "writeSchemes", "publishParams", "manageUsers"}) {
      assertTrue(caps.containsKey(k), "能力表缺 " + k);
    }
  }

  /**
   * `POST /api/catalog/reload` 改的是**进程内共享状态**（`catalogs.reload()` 重建目录快照，
   * 所有使用者一起受影响）—— 它是写动作，必须有门。原来是写类接口里**唯一没有门**的一处
   * （第 2 轮对抗式审查 dev-6）。
   *
   * 为什么用源码级断言（与 `ProductWriteRepositoryTest` 同一个路子）：这个类要起 Spring
   * 上下文 + 库才拿得到，而"门在不在、在不在改状态之前"是**读源码就能判**的事。
   */
  @Test
  void catalog_reload_is_gated_before_it_touches_shared_state() throws IOException {
    final String src = Files.readString(
        Path.of("src/main/java/com/scene/spatial/catalog/CatalogController.java"));
    final int at = src.indexOf("public Map<String, Object> reload()");
    assertTrue(at > 0, "找不到 reload() 了（改了签名就同步改这条判据）");
    final String body = src.substring(at);
    final int gate = body.indexOf("requireMaintain()");
    final int mutate = body.indexOf("catalogs.reload()");
    assertTrue(gate > 0, "reload 必须过角色门：改共享状态不能人人可调");
    assertTrue(mutate > 0, "找不到 catalogs.reload()（改名就同步改这条）");
    assertTrue(gate < mutate, "门必须在改共享状态**之前** —— 改完再拦等于没拦");
  }
}
