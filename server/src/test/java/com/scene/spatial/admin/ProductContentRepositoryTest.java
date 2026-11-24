package com.scene.spatial.admin;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ProductContentRepositoryTest —— V18 的写 SQL 静态钉子（不需要数据库）。
 *
 * 这里钉的不是“SQL 能跑”，而是最容易写错、且一错就静默的三件事：
 *   ① 热点必须带软删除/排序/坐标列；② 发布快照必须按 rev 条件更新；③ 不许用问号占位符。
 * 真库端到端探针另测。
 */
class ProductContentRepositoryTest {

  @Test
  void hotspotInsertCoversEveryContractColumn() {
    for (final String col : List.of("product_id", "model_id", "seq", "title", "body",
        "node_path", "node_index", "node_name", "pos_x", "pos_y", "pos_z",
        "nrm_x", "nrm_y", "nrm_z", "door_state", "camera_json", "updated_by")) {
      assertTrue(ProductContentRepository.SQL_INSERT_HOTSPOT.contains(col),
          "INSERT 漏列：" + col);
    }
    assertTrue(ProductContentRepository.SQL_INSERT_HOTSPOT.startsWith("INSERT INTO product_hotspot"));
  }

  @Test
  void publishIsGuardedByRev() {
    assertTrue(ProductContentRepository.SQL_PUBLISH.contains("published_json"));
    assertTrue(ProductContentRepository.SQL_PUBLISH.contains("published_rev"));
    assertTrue(ProductContentRepository.SQL_PUBLISH.contains("WHERE product_id = :pid AND rev = :rev"),
        "发布必须按当前 rev 条件更新，否则并发会覆盖新编辑态");
  }

  @Test
  void writesUseNamedPlaceholdersAndVerbs() {
    for (final String sql : List.of(ProductContentRepository.SQL_INSERT_HOTSPOT,
        ProductContentRepository.SQL_UPDATE_HOTSPOT, ProductContentRepository.SQL_PUBLISH,
        ProductContentRepository.SQL_UPDATE_DRAFT, ProductContentRepository.SQL_ENSURE)) {
      assertFalse(sql.contains("?"), "不要问号占位符");
      assertTrue(sql.strip().matches("(?is)^(INSERT|UPDATE|DELETE) .*"), "语句必须以动词开头");
      assertTrue(sql.contains(":"), "应当使用命名占位符");
    }
  }
}
