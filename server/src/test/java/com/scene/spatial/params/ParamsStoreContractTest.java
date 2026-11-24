package com.scene.spatial.params;

import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ParamsStoreContractTest —— 两个存储实现的**同一套契约**（R6-4 B4c 补上）
 *
 * ## 为什么现在才补，而且这不只是"少一个文件"
 *
 * `ParamsStore` 的接口注释从 B4a 起就写着「两个实现必须一字不差地同语义，所以有一个契约测试
 * 同时跑两边」—— 而**实际上没有这个文件**：`ParamsPublishTest` 只用内存实现，
 * JDBC 那一份从没被断言过。也就是说**那句话在说谎**（B4c 顺手把它变成真的）。
 *
 * 而 B4c 要加的恰恰是最容易"两份长得不一样"的东西：分页顺序、筛选、快照回读。
 * 差一点点，症状就是"我本地是好的"。
 *
 * ## 关于 skip：两种颜色
 * JDBC 那一条在连不上库 / 没跑过迁移时判 **skip**（`Assumptions`），不假装绿
 * —— 与 `docs/21` 修正记录里那条纪律一致：「没跑起来」和「跑起来没问题」必须两种颜色。
 *
 * ## 只碰自己的数据（这一条尤其重要，这个库里有真实留痕）
 * - 靠 `changed_by = 'contract-test'` 认出自己写的审计行（真实发布的 `changed_by` 是**数字用户 id**，
 *   绝不会撞上这个标记），`finally` 里**按这个标记删**；
 * - **不 `DELETE FROM config_revision`**（那会清掉真实留痕，也会清掉另一个 agent 的行）；
 * - 审计与配置值是两条独立路径（`audit()` 不碰 `put()`）→ 本测试**一个配置值都不写**，
 *   跑完 `app_config` 34 行原样不动。
 */
class ParamsStoreContractTest {

  /** 认自己写的行 */
  private static final String MARK = "contract-test";

  /** 一个真实存在的参数键（审计行按它记，但**不写 `app_config`**） */
  private static final String KEY = "door.openOkDeg";

  @Test
  @DisplayName("内存实现 · 契约")
  void inMemory() {
    contract(new ParamsStoreInMemory(), null);
  }

  @Test
  @DisplayName("JDBC 实现 · 契约（连不上库则 skip，不假装绿）")
  void jdbc() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null,
        "跳过：连不上 MySQL，或这个库还没跑过 V1–V11 迁移（这是 skip，不是通过）");
    try {
      contract(new ParamsStoreJdbc(jdbc), jdbc);
    } finally {
      purge(jdbc);
    }
  }

  /**
   * 同一套断言，跑两遍。
   *
   * ⚠️ **不许假设整表是空的**：真实库里有 20+ 条留痕。所以每一条查询都带上自己的标记，
   * 断言的是"我写进去的那三条"，而不是"全库有几条"。
   */
  private static void contract(ParamsStore store, JdbcClient jdbc) {
    // ① 还没写：按标记筛，一条都没有
    assertEquals(0, store.countAudit(by(null, null, null)), "还没写就不该有我的行");
    assertTrue(store.auditPage(by(null, null, null)).isEmpty());

    // ② 写三条（快照用小 map：只验"原样进出"，不看它是不是 34 项）
    final Map<String, Object> snap = new LinkedHashMap<>();
    snap.put("door.openOkDeg", 85);
    snap.put("room.minW", 3);
    store.audit(new ParamsStore.AuditRow(KEY, ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE,
        111, 90, 85, snap, MARK, "改小一点"));
    store.audit(new ParamsStore.AuditRow("space.rotateStepDeg", ParamsStore.SCOPE_GLOBAL,
        ParamsStore.SCOPE_ID_NONE, 222, 5, 15, snap, MARK, ""));
    store.audit(new ParamsStore.AuditRow(KEY, ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE,
        333, 85, 80, snap, MARK, "再小一点"));

    // ③ `total`（一共几条）与 `rows`（这一页几条）是两件事 —— 界面常驻「显示 N / 共 M 条」
    assertEquals(3, store.countAudit(by(null, null, null)));
    final List<ParamsStore.AuditItem> p1 = store.auditPage(by(null, null, null));
    assertEquals(3, p1.size(), "没给 limit 就用兜底值（50），三条都该出来");
    // **新的在前**：JDBC 是 `ORDER BY id DESC`，内存实现必须翻成同一个顺序，
    // 否则「第几页」在两份实现里不是同一页（这类差异只有在换档那天才暴露）
    assertEquals(80, num(p1.get(0).newValue()), "第一条必须是最新的那条");
    assertEquals(15, num(p1.get(1).newValue()));
    assertEquals(85, num(p1.get(2).newValue()));

    assertEquals(2, store.auditPage(new ParamsStore.AuditQuery(null, null, null, MARK, 2, 0)).size(),
        "limit 要管住这一页");
    final List<ParamsStore.AuditItem> p2 =
        store.auditPage(new ParamsStore.AuditQuery(null, null, null, MARK, 2, 2));
    assertEquals(1, p2.size(), "第二页只剩一条");
    assertEquals(85, num(p2.get(0).newValue()), "第二页第一条是老的那条（顺序不能错）");

    // ④ 按项筛 / 按人筛
    assertEquals(2, store.countAudit(new ParamsStore.AuditQuery(null, null, KEY, MARK, 50, 0)));
    assertEquals(3, store.countAudit(new ParamsStore.AuditQuery(null, null, null, MARK, 50, 0)));
    assertEquals(0, store.countAudit(new ParamsStore.AuditQuery(null, null, null, "别人的标记", 50, 0)));

    // ⑤ 时间是**闭区间**：用"写之前/写之后"夹住，不依赖具体时刻
    final LocalDateTime before = LocalDateTime.now().minusMinutes(1);
    final LocalDateTime after = LocalDateTime.now().plusMinutes(1);
    assertEquals(3, store.countAudit(new ParamsStore.AuditQuery(before, after, null, MARK, 50, 0)),
        "起止都夹住，三条都要在");
    assertEquals(0, store.countAudit(new ParamsStore.AuditQuery(after, null, null, MARK, 50, 0)),
        "起点放到将来 → 一条都不该有");
    assertEquals(0, store.countAudit(new ParamsStore.AuditQuery(null, before, null, MARK, 50, 0)),
        "终点放到过去 → 一条都不该有");

    // ⑥ 每行的时间要读得回来（两份实现的列类型不一样：`Timestamp` / `LocalDateTime`）
    for (final ParamsStore.AuditItem it : p1) {
      assertNotNull(it.changedAt(), "审计行必须有时间（界面第一列就是它）");
      assertNotNull(it.note(), "note 是空串也不该是 null");
    }
    assertEquals("再小一点", p1.get(0).note(), "中文注记要原样进出");

    // ⑦ 详情：带**全量快照**，跨实现一模一样；查不到 → null（不是异常，也不是空壳）
    final ParamsStore.AuditItem one = store.auditOne(p1.get(0).id());
    assertNotNull(one);
    assertEquals(80, num(one.newValue()));
    assertEquals(85, num(one.snapshot().get("door.openOkDeg")), "快照要原样读回来");
    assertEquals(3, num(one.snapshot().get("room.minW")));
    assertNull(store.auditOne(999_999_999L), "不存在的 id 必须是 null（界面要能说「这条不在了」）");

    // ⑧ limit 的兜底写在接口里（控制器就不用再防一遍）
    assertEquals(50, new ParamsStore.AuditQuery(null, null, null, null, 0, 0).limit());
    assertEquals(ParamsStore.AUDIT_MAX_LIMIT,
        new ParamsStore.AuditQuery(null, null, null, null, 999_999, 0).limit());
    assertEquals(0, new ParamsStore.AuditQuery(null, null, null, null, 50, -5).offset());
  }

  /** 按标记筛（顺带覆盖"别的条件为空"这一支） */
  private static ParamsStore.AuditQuery by(String path, LocalDateTime from, LocalDateTime to) {
    return new ParamsStore.AuditQuery(from, to, path, MARK, 50, 0);
  }

  private static int num(Object o) {
    return ((Number) o).intValue();
  }

  /** 只删自己写的（按 `changed_by` 认）。**绝不整表删** */
  private static void purge(JdbcClient jdbc) {
    final int n = jdbc.sql("DELETE FROM config_revision WHERE changed_by = :by")
        .param("by", MARK).update();
    if (n > 0) {
      System.out.println("[cleanup] 清掉契约测试写的审计行 " + n + " 条（按 changed_by 认，没碰真实留痕）");
    }
  }

  /** 连不上库、或没跑过迁移就返回 null —— 让上面的 assumeTrue 判成 skip */
  private static JdbcClient jdbcOrNull() {
    final String url = "jdbc:mysql://" + env("DB_HOST", "127.0.0.1") + ":" + env("DB_PORT", "3306")
        + "/" + env("DB_NAME", "spatial_design")
        + "?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true";
    final DriverManagerDataSource ds =
        new DriverManagerDataSource(url, env("DB_USER", "root"), env("DB_PASSWORD", ""));
    try (Connection c = ds.getConnection()) {
      if (count(c, "SELECT COUNT(*) FROM config_revision") < 0) return null;
      if (count(c, "SELECT COUNT(*) FROM app_config") == 0) {
        System.out.println("[skip] app_config is empty -- run migration V11");
        return null;
      }
      return JdbcClient.create(ds);
    } catch (Exception e) {
      System.out.println("[skip] MySQL unreachable or migrations not applied: " + e.getMessage());
      return null;
    }
  }

  private static int count(Connection c, String sql) throws Exception {
    try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
      return rs.next() ? rs.getInt(1) : -1;
    }
  }

  private static String env(String key, String fallback) {
    final String v = System.getenv(key);
    return v == null || v.isBlank() ? fallback : v;
  }
}