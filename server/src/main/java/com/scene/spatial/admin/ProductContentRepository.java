package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ProductContentRepository —— 产品详情内容与 3D 热点的**写路径**（V18，设计决策记录）。
 *
 * 与 {@link ProductWriteRepository} 同一条纪律：新表的写 SQL 只在这里出现一次。
 * 每个写方法自己是一个事务；服务层按 设计决策记录的 tx1（编辑态）/ tx2（发布快照）分段调用 ——
 * 只有分段，发布失败才不会把编辑态一起回滚（这是 Lead 明确要求的失败隔离）。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class ProductContentRepository {

  static final String SQL_ROW = """
      SELECT product_id, draft_json, published_json, rev, published_rev, published_at,
             updated_by, updated_at
        FROM product_content WHERE product_id = :pid
      """;

  static final String SQL_ENSURE = """
      INSERT INTO product_content (product_id, draft_json)
      VALUES (:pid, '{"sellingPoints":[],"params":[]}')
      ON DUPLICATE KEY UPDATE product_id = product_id
      """;

  static final String SQL_UPDATE_DRAFT = """
      UPDATE product_content
         SET draft_json = :draft, rev = rev + 1, updated_by = :actor, updated_at = :now
       WHERE product_id = :pid AND rev = :expected
      """;

  static final String SQL_UPDATE_HOTSPOT_STATE = """
      UPDATE product_content
         SET draft_json = :draft, rev = rev + 1, updated_by = :actor, updated_at = :now
       WHERE product_id = :pid AND rev = :expected
      """;

  static final String SQL_PUBLISH = """
      UPDATE product_content
         SET published_json = :snapshot, published_rev = :rev, published_at = :now,
             updated_by = :actor, updated_at = :now
       WHERE product_id = :pid AND rev = :rev
      """;

  static final String SQL_PRODUCT_HEADER = """
      SELECT p.id AS db_id, p.model_no, p.name, p.status, p.description, p.recipe_json,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.id')) AS catalog_id,
             m.id AS model_id, m.variant, m.file_path, m.file_size, m.checksum, m.unit,
             m.bbox_w, m.bbox_d, m.bbox_h, m.hinge_nodes, m.lod_json, m.delta_vs_source_json
        FROM product p
        LEFT JOIN product_model m ON m.product_id = p.id AND m.variant = 'default'
       WHERE p.id = :pid
      """;

  static final String SQL_PRODUCT_BY_CATALOG = """
      SELECT p.id AS db_id, p.model_no, p.name, p.status, p.description,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.id')) AS catalog_id,
             m.id AS model_id, m.variant, m.file_path, m.file_size, m.checksum, m.unit,
             m.bbox_w, m.bbox_d, m.bbox_h, m.lod_json
        FROM product p
        LEFT JOIN product_model m ON m.product_id = p.id AND m.variant = 'default'
       WHERE JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.id')) = :cid
         AND p.status = 'active'
      """;

  static final String SQL_NOTES = """
      SELECT kind, label, value, sort_order
        FROM product_note WHERE product_id = :pid ORDER BY kind, sort_order, id
      """;

  static final String SQL_HOTSPOTS = """
      SELECT id, product_id, model_id, seq, title, body, media_file, media_alt,
             node_path, node_index, node_name, pos_x, pos_y, pos_z,
             nrm_x, nrm_y, nrm_z, door_state, camera_json, action_key, updated_by,
             created_at, updated_at
        FROM product_hotspot WHERE product_id = :pid ORDER BY seq, id
      """;

  static final String SQL_DELETE_HOTSPOT = "DELETE FROM product_hotspot WHERE id = :id AND product_id = :pid";

  static final String SQL_INSERT_HOTSPOT = """
      INSERT INTO product_hotspot (product_id, model_id, seq, title, body, media_file, media_alt,
                                   node_path, node_index, node_name, pos_x, pos_y, pos_z,
                                   nrm_x, nrm_y, nrm_z, door_state, camera_json, action_key,
                                   updated_by, created_at, updated_at)
      VALUES (:pid, :mid, :seq, :title, :body, '', '',
              :nodePath, :nodeIndex, :nodeName, :px, :py, :pz,
              :nx, :ny, :nz, :doorState, :camera, :actionKey, :actor, :now, :now)
      """;

  static final String SQL_UPDATE_HOTSPOT = """
      UPDATE product_hotspot
         SET model_id = :mid, seq = :seq, title = :title, body = :body,
             node_path = :nodePath, node_index = :nodeIndex, node_name = :nodeName,
             pos_x = :px, pos_y = :py, pos_z = :pz,
             nrm_x = :nx, nrm_y = :ny, nrm_z = :nz,
             door_state = :doorState, camera_json = :camera, action_key = :actionKey,
             updated_by = :actor, updated_at = :now
       WHERE id = :id AND product_id = :pid
      """;

  static final String SQL_ACTIONS = """
      SELECT id, product_id, action_key, name, kind, target_json, motion_json, sort_order,
             updated_by, created_at, updated_at
        FROM product_action WHERE product_id = :pid ORDER BY sort_order, id
      """;

  static final String SQL_DELETE_ACTIONS = "DELETE FROM product_action WHERE product_id = :pid";

  static final String SQL_INSERT_ACTION = """
      INSERT INTO product_action (product_id, action_key, name, kind, target_json, motion_json,
                                  sort_order, updated_by, created_at, updated_at)
      VALUES (:pid, :key, :name, :kind, :target, :motion, :sort, :actor, :now, :now)
      """;

  /**
   * 替换动作库后，把没有被重写的旧热点引用清空（NULL），保住「热点不指向不存在的动作」这条不变量。
   * 不建外键正是为了这里能先删后插；引用完整性只剩服务层这一道，所以必须有这条收尾 SQL。
   */
  static final String SQL_CLEAR_DANGLING_ACTION_REFS = """
      UPDATE product_hotspot
         SET action_key = NULL
       WHERE product_id = :pid
         AND action_key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM product_action a
                          WHERE a.product_id = product_hotspot.product_id
                            AND a.action_key = product_hotspot.action_key)
      """;

  private final JdbcClient jdbc;

  public ProductContentRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  public Map<String, Object> contentRow(long productId) {
    final List<Map<String, Object>> rows = jdbc.sql(SQL_ROW).param("pid", productId).query().listOfRows();
    return rows.isEmpty() ? null : rows.get(0);
  }

  public Map<String, Object> productHeader(long productId) {
    final List<Map<String, Object>> rows = jdbc.sql(SQL_PRODUCT_HEADER).param("pid", productId).query().listOfRows();
    return rows.isEmpty() ? null : rows.get(0);
  }

  public Map<String, Object> productByCatalogId(String catalogId) {
    final List<Map<String, Object>> rows = jdbc.sql(SQL_PRODUCT_BY_CATALOG)
        .param("cid", catalogId).query().listOfRows();
    return rows.isEmpty() ? null : rows.get(0);
  }

  public List<Map<String, Object>> notes(long productId) {
    return jdbc.sql(SQL_NOTES).param("pid", productId).query().listOfRows();
  }

  public List<Map<String, Object>> hotspots(long productId) {
    return jdbc.sql(SQL_HOTSPOTS).param("pid", productId).query().listOfRows();
  }

  /** 产品动作库（按 sort_order 稳定排序）；无动作返回空列表，不是 null。 */
  public List<Map<String, Object>> actions(long productId) {
    return jdbc.sql(SQL_ACTIONS).param("pid", productId).query().listOfRows();
  }

  /** 建 1:1 空行（幂等）。初始 rev=0、published_json=NULL。 */
  @Transactional
  public void ensureContent(long productId) {
    jdbc.sql(SQL_ENSURE).param("pid", productId).update();
  }

  /** 只写卖点/参数；返回是否抢到 expectedRev。0 行 = 409。 */
  @Transactional
  public boolean saveDraft(long productId, String draftJson, int expectedRev, String actor) {
    return saveDraft(productId, draftJson, null, expectedRev, actor);
  }

  /**
   * 只写卖点/参数，可选地**在同一事务里**整体替换动作库（actions=null 表示保留现有动作库）。
   * 替换动作库但没重写热点时，旧热点里指向已删动作的 action_key 会被清空（不是留悬空引用）。
   */
  @Transactional
  public boolean saveDraft(long productId, String draftJson, List<Map<String, Object>> actions,
                           int expectedRev, String actor) {
    ensureContent(productId);
    final int n = jdbc.sql(SQL_UPDATE_DRAFT)
        .param("pid", productId).param("draft", draftJson)
        .param("expected", expectedRev).param("actor", actor == null ? "" : actor)
        .param("now", LocalDateTime.now()).update();
    if (n != 1) return false;
    if (actions != null) {
      replaceActions(productId, actions, actor);
      clearDanglingActionRefs(productId);
    }
    return true;
  }

  /**
   * 只写热点编辑态：rev+1 后整体对账（保留请求里带的 id，删掉不再出现的）。
   *
   * @return 新的热点 id（按 seq）；null = expectedRev 不匹配
   */
  @Transactional
  public List<Long> saveHotspots(long productId, String draftJson,
                                 List<Map<String, Object>> hotspots,
                                 int expectedRev, String actor) {
    return saveHotspots(productId, draftJson, hotspots, null, expectedRev, actor);
  }

  /** 热点 + 可选动作库，同一 tx1：先替换动作库，再写热点，最后清悬空引用。 */
  @Transactional
  public List<Long> saveHotspots(long productId, String draftJson,
                                 List<Map<String, Object>> hotspots,
                                 List<Map<String, Object>> actions,
                                 int expectedRev, String actor) {
    ensureContent(productId);
    final int n = jdbc.sql(SQL_UPDATE_HOTSPOT_STATE)
        .param("pid", productId).param("draft", draftJson)
        .param("expected", expectedRev)
        .param("actor", actor == null ? "" : actor).param("now", LocalDateTime.now()).update();
    if (n != 1) return null;
    if (actions != null) replaceActions(productId, actions, actor);
    final List<Long> ids = replaceHotspots(productId, hotspots, actor);
    if (actions != null) clearDanglingActionRefs(productId);
    return ids;
  }

  /** 合并入口：内容 + 热点在**同一个 tx1** 里写，只推进一次 rev。 */
  @Transactional
  public List<Long> saveContentAndHotspots(long productId, String draftJson,
                                           List<Map<String, Object>> hotspots,
                                           int expectedRev, String actor) {
    return saveContentAndHotspots(productId, draftJson, hotspots, null, expectedRev, actor);
  }

  /** 合并入口 + 可选动作库；三者同一事务，任何一步失败都不留半套。 */
  @Transactional
  public List<Long> saveContentAndHotspots(long productId, String draftJson,
                                           List<Map<String, Object>> hotspots,
                                           List<Map<String, Object>> actions,
                                           int expectedRev, String actor) {
    ensureContent(productId);
    final int n = jdbc.sql(SQL_UPDATE_DRAFT)
        .param("pid", productId).param("draft", draftJson)
        .param("expected", expectedRev).param("actor", actor == null ? "" : actor)
        .param("now", LocalDateTime.now()).update();
    if (n != 1) return null;
    if (actions != null) replaceActions(productId, actions, actor);
    final List<Long> ids = replaceHotspots(productId, hotspots, actor);
    if (actions != null) clearDanglingActionRefs(productId);
    return ids;
  }

  /** tx2：把已构建好的快照写进 published_json；只认当前 rev。 */
  @Transactional
  public boolean publish(long productId, String snapshotJson, int rev, String actor) {
    final int n = jdbc.sql(SQL_PUBLISH)
        .param("pid", productId).param("snapshot", snapshotJson)
        .param("rev", rev).param("actor", actor == null ? "" : actor)
        .param("now", LocalDateTime.now()).update();
    return n == 1;
  }

  private List<Long> replaceHotspots(long productId, List<Map<String, Object>> hotspots, String actor) {
    final List<Map<String, Object>> existing = hotspots(productId);
    final Map<Long, Map<String, Object>> byId = new LinkedHashMap<>();
    for (final Map<String, Object> row : existing) byId.put(num(row.get("id")), row);

    final List<Long> kept = new ArrayList<>();
    for (int i = 0; i < hotspots.size(); i++) {
      final Map<String, Object> h = hotspots.get(i);
      final long id = num(h.get("id"));
      if (id > 0) {
        if (!byId.containsKey(id)) {
          throw new IllegalStateException("hotspot id " + id + " 不属于该产品：" + productId);
        }
        jdbc.sql(SQL_UPDATE_HOTSPOT)
            .param("id", id).param("pid", productId).param("mid", num(h.get("modelId")))
            .param("seq", i).param("title", str(h.get("title"))).param("body", str(h.get("body")))
            .param("nodePath", json(h.get("nodePath"))).param("nodeIndex", num(h.get("nodeIndex")))
            .param("nodeName", str(h.get("nodeName")))
            .param("px", dec(h.get("position"), "x")).param("py", dec(h.get("position"), "y"))
            .param("pz", dec(h.get("position"), "z"))
            .param("nx", decOrNull(h.get("normal"), "x")).param("ny", decOrNull(h.get("normal"), "y"))
            .param("nz", decOrNull(h.get("normal"), "z"))
            .param("doorState", str(h.get("doorState")).isEmpty() ? "any" : str(h.get("doorState")))
            .param("camera", h.get("camera") == null ? null : json(h.get("camera")))
            .param("actionKey", actionKeyOrNull(h))
            .param("actor", actor == null ? "" : actor).param("now", LocalDateTime.now()).update();
        kept.add(id);
      } else {
        final KeyHolder keys = new GeneratedKeyHolder();
        jdbc.sql(SQL_INSERT_HOTSPOT)
            .param("pid", productId).param("mid", num(h.get("modelId")))
            .param("seq", i).param("title", str(h.get("title"))).param("body", str(h.get("body")))
            .param("nodePath", json(h.get("nodePath"))).param("nodeIndex", num(h.get("nodeIndex")))
            .param("nodeName", str(h.get("nodeName")))
            .param("px", dec(h.get("position"), "x")).param("py", dec(h.get("position"), "y"))
            .param("pz", dec(h.get("position"), "z"))
            .param("nx", decOrNull(h.get("normal"), "x")).param("ny", decOrNull(h.get("normal"), "y"))
            .param("nz", decOrNull(h.get("normal"), "z"))
            .param("doorState", str(h.get("doorState")).isEmpty() ? "any" : str(h.get("doorState")))
            .param("camera", h.get("camera") == null ? null : json(h.get("camera")))
            .param("actionKey", actionKeyOrNull(h))
            .param("actor", actor == null ? "" : actor).param("now", LocalDateTime.now()).update(keys);
        final Number key = keys.getKey();
        if (key == null) throw new IllegalStateException("热点插入没有返回自增 id");
        kept.add(key.longValue());
      }
    }
    for (final Long oldId : byId.keySet()) {
      if (!kept.contains(oldId)) {
        jdbc.sql(SQL_DELETE_HOTSPOT).param("id", oldId).param("pid", productId).update();
      }
    }
    return kept;
  }

  /** 整体替换：先删后插，sort_order 按数组下标重排。调用方保证已校验通过且在事务内。 */
  private void replaceActions(long productId, List<Map<String, Object>> actions, String actor) {
    jdbc.sql(SQL_DELETE_ACTIONS).param("pid", productId).update();
    for (int i = 0; i < actions.size(); i++) {
      final Map<String, Object> a = actions.get(i);
      jdbc.sql(SQL_INSERT_ACTION)
          .param("pid", productId)
          .param("key", str(a.get("key")))
          .param("name", str(a.get("name")))
          .param("kind", str(a.get("kind")))
          .param("target", json(a.get("target")))
          .param("motion", json(a.get("motion")))
          .param("sort", i)
          .param("actor", actor == null ? "" : actor)
          .param("now", LocalDateTime.now()).update();
    }
  }

  private void clearDanglingActionRefs(long productId) {
    jdbc.sql(SQL_CLEAR_DANGLING_ACTION_REFS).param("pid", productId).update();
  }

  static String actionKeyOrNull(Map<String, Object> h) {
    final String key = str(h.get("actionKey")).trim();
    return key.isEmpty() ? null : key;
  }

  static String json(Object v) {
    return v == null ? "[]" : Json.write(v, 0);
  }

  static long num(Object o) {
    if (o instanceof Number n) return n.longValue();
    if (o == null) return 0L;
    try {
      return Long.parseLong(String.valueOf(o).trim());
    } catch (NumberFormatException e) {
      return 0L;
    }
  }

  static String str(Object o) {
    return o == null ? "" : String.valueOf(o);
  }

  static Double dec(Object container, String key) {
    if (!(container instanceof Map<?, ?> m)) return null;
    return decValue(m.get(key));
  }

  static Double decOrNull(Object container, String key) {
    return dec(container, key);
  }

  static Double decValue(Object o) {
    if (o instanceof Number n) return n.doubleValue();
    if (o == null) return null;
    try {
      return Double.parseDouble(String.valueOf(o).trim());
    } catch (NumberFormatException e) {
      return null;
    }
  }
}
