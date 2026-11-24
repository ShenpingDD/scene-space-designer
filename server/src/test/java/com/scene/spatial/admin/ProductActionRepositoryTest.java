package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductActionRepositoryTest —— V19 动作库的写/读 SQL 静态钉子（不需要数据库）。
 *
 * 钉三件「一错就静默」的事：
 *   ① 动作库读回来必须带 kind/target/motion 且按 sort_order 稳定排序；
 *   ② 热点表新增的 action_key 必须同时出现在 SELECT/INSERT/UPDATE 三处，漏一处就是「存了读不出」；
 *   ③ 替换动作库后必须有一条收尾 SQL 把悬空引用清成 NULL —— 热点不建外键，这是唯一一道完整性。
 */
class ProductActionRepositoryTest {

  @Test
  void actionSelectCoversEveryContractColumn() {
    for (final String col : List.of("action_key", "name", "kind", "target_json", "motion_json",
        "sort_order", "updated_by", "created_at", "updated_at")) {
      assertTrue(ProductContentRepository.SQL_ACTIONS.contains(col), "SELECT 漏列：" + col);
    }
    assertTrue(ProductContentRepository.SQL_ACTIONS.contains("FROM product_action"));
    assertTrue(ProductContentRepository.SQL_ACTIONS.contains("WHERE product_id = :pid"));
    assertTrue(ProductContentRepository.SQL_ACTIONS.contains("ORDER BY sort_order, id"),
        "动作顺序必须稳定，否则前端按数组下标绑定的顺序会漂");
  }

  @Test
  void actionInsertCoversEveryContractColumn() {
    for (final String col : List.of("product_id", "action_key", "name", "kind", "target_json",
        "motion_json", "sort_order", "updated_by", "created_at", "updated_at")) {
      assertTrue(ProductContentRepository.SQL_INSERT_ACTION.contains(col), "INSERT 漏列：" + col);
    }
    for (final String p : List.of(":pid", ":key", ":name", ":kind", ":target", ":motion",
        ":sort", ":actor", ":now")) {
      assertTrue(ProductContentRepository.SQL_INSERT_ACTION.contains(p), "INSERT 漏占位符：" + p);
    }
    assertTrue(ProductContentRepository.SQL_INSERT_ACTION.startsWith("INSERT INTO product_action"));
  }

  @Test
  void hotspotCarriesActionKeyOnEveryPath() {
    assertTrue(ProductContentRepository.SQL_HOTSPOTS.contains("action_key"), "读热点必须带 action_key");
    assertTrue(ProductContentRepository.SQL_INSERT_HOTSPOT.contains("action_key"), "写热点必须带 action_key");
    assertTrue(ProductContentRepository.SQL_INSERT_HOTSPOT.contains(":actionKey"));
    assertTrue(ProductContentRepository.SQL_UPDATE_HOTSPOT.contains("action_key = :actionKey"),
        "改热点也必须更新 action_key，否则绑定改不动");
  }

  @Test
  void danglingActionRefsAreClearedAfterReplace() {
    final String sql = ProductContentRepository.SQL_CLEAR_DANGLING_ACTION_REFS;
    assertTrue(sql.contains("SET action_key = NULL"), "悬空引用要清成 NULL，不是留旧值");
    assertTrue(sql.contains("NOT EXISTS"), "只清不再存在于动作库里的引用");
    assertTrue(sql.contains("FROM product_action"), "判据来自动作库本身");
    assertTrue(sql.contains("product_id = :pid"));
  }

  @Test
  void writesUseNamedPlaceholdersAndVerbs() {
    for (final String sql : List.of(ProductContentRepository.SQL_ACTIONS,
        ProductContentRepository.SQL_DELETE_ACTIONS,
        ProductContentRepository.SQL_INSERT_ACTION,
        ProductContentRepository.SQL_CLEAR_DANGLING_ACTION_REFS,
        ProductContentRepository.SQL_HOTSPOTS,
        ProductContentRepository.SQL_INSERT_HOTSPOT,
        ProductContentRepository.SQL_UPDATE_HOTSPOT)) {
      assertFalse(sql.contains("?"), "不要问号占位符");
      assertTrue(sql.strip().matches("(?is)^(SELECT|INSERT|UPDATE|DELETE) .*"), "语句必须以动词开头");
      assertTrue(sql.contains(":"), "应当使用命名占位符");
    }
  }
}
