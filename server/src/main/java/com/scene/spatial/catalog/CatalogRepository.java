package com.scene.spatial.catalog;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/**
 * CatalogRepository —— 从 `product` / `product_model` / `product_note` 三张表读目录（V5 建的）。
 *
 * 只做"把行取出来"，**不做任何裁剪与换算** —— 那是 DbCatalog 里那个纯函数的活
 * （这样装配逻辑才能在没有数据库的地方被断言）。
 *
 * 为什么 `variant = 'default'`：G3 口径是"一型号多模型"（1:N），界面这一版只用默认变体。
 * 将来出现变体，选择权应该来自请求参数，而不是把两张表 JOIN 出重复行。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class CatalogRepository {

  private final JdbcClient jdbc;

  public CatalogRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public List<Map<String, Object>> products() {
    return jdbc.sql("""
        SELECT p.id AS db_id, p.model_no, p.name, p.series, p.description, p.origin,
               p.size_note, p.door_part, p.color, p.source_url, p.sort_order, p.recipe_json,
               m.variant, m.file_path, m.source_file_path, m.thumb_file, m.thumb_size,
               m.checksum, m.unit, m.bbox_w, m.bbox_d, m.bbox_h, m.envelope_mode,
               m.hinge_nodes, m.lod_json,
               c.published_rev AS content_published_rev,
               IFNULL(JSON_LENGTH(c.published_json, '$.hotspots'), 0) AS content_hotspot_count
          FROM product p
          LEFT JOIN product_model m ON m.product_id = p.id AND m.variant = 'default'
          LEFT JOIN product_content c ON c.product_id = p.id
         WHERE p.status = 'active'
         ORDER BY p.sort_order, p.id
        """).query().listOfRows();
  }

  public List<Map<String, Object>> notes() {
    return jdbc.sql("""
        SELECT product_id, kind, label, value, sort_order
          FROM product_note
         ORDER BY product_id, kind, sort_order, id
        """).query().listOfRows();
  }
}
