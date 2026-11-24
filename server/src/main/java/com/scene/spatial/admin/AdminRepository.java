package com.scene.spatial.admin;

import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AdminRepository —— 维护端的只读取数（R6-1）
 *
 * 与 `CatalogRepository` 的关键区别（**这不是小事**）：
 *   目录要给前台用，所以 `WHERE p.status = 'active'`；
 *   维护端要**管**这些产品，所以**一条都不许滤掉** —— 停用/没模型/对不上账的，
 *   恰恰是管理员最需要看见的那些。过滤掉就等于把分诊对象藏起来了。
 *
 * 仍然遵守"只把行取出来"的分工：**不做裁剪与换算**（那是 AdminService 里纯函数的活），
 * 这样"装成什么样"能在没有数据库的地方被断言。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class AdminRepository {

  private final JdbcClient jdbc;

  public AdminRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /**
   * `id → 显示名`（审计里要写"谁改的"）。
   *
   * 查不到就不补：界面对认不出的 id 会**显示原始 id**，而不是编一个名字（审计最不能猜）。
   * 一条查询取全表，因为用户表在这个规模下就是个小表（几千行以内），
   * 而按 id 一条条问会在审计列表上变成 N+1 次查询。
   */
  public Map<String, String> userNames() {
    final Map<String, String> out = new LinkedHashMap<>();
    for (final Map<String, Object> r : jdbc.sql("SELECT id, display_name FROM sys_user")
        .query((rs, i) -> {
          final Map<String, Object> m = new LinkedHashMap<String, Object>();
          m.put("id", rs.getString("id"));
          m.put("name", rs.getString("display_name"));
          return m;
        }).list()) {
      out.put(String.valueOf(r.get("id")), r.get("name") == null ? "" : String.valueOf(r.get("name")));
    }
    return out;
  }

  /**
   * 产品行的**取数口径只有一份** —— `products()`（列表）与 `productRowById()`（单条）共用它。
   *
   * 为什么必须共用：界面拿一张卡片整条替换列表里的那一条，所以「单条」的列一旦比「列表」少，
   * 界面就会在缺的键上取值。第 3 轮审查 `C-15` 就是这么出的事（单条走的是 5 列的 `productById`，
   * 界面的 `badges` 变成 `undefined` → 角标区抛 `TypeError`）。
   */
  private static final String PRODUCT_ROW_SELECT = """
      SELECT p.id AS db_id, p.model_no, p.name, p.series, p.description, p.origin,
             p.size_note, p.door_part, p.door_verified, p.door_source, p.color, p.source_url,
             p.status, p.sort_order, p.created_at, p.updated_at, p.updated_by,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.id')) AS recipe_id,  -- 前端可以直接拿它去查已验证的缩略图，不必再认一套 id
             m.variant, m.file_path, m.file_size, m.source_file_path, m.thumb_file,
             m.thumb_size, m.checksum, m.unit, m.bbox_w, m.bbox_d, m.bbox_h,
             m.envelope_mode, m.envelope_ok, m.anisotropy_ok, m.hinge_nodes, m.lod_json,
             m.delta_vs_source_json,
             (SELECT COUNT(*) FROM product_note n WHERE n.product_id = p.id) AS note_count,
             (SELECT COUNT(*) FROM product_model x WHERE x.product_id = p.id) AS variant_count,
             -- 热点/详情摘要：列表一次带出，避免维护端逐卡再打 GET /content（V18）
             (SELECT COUNT(*) FROM product_hotspot h WHERE h.product_id = p.id) AS hotspot_count,
             (SELECT c.rev FROM product_content c WHERE c.product_id = p.id) AS content_rev,
             (SELECT c.published_rev FROM product_content c WHERE c.product_id = p.id) AS content_published_rev
        FROM product p
        LEFT JOIN product_model m ON m.product_id = p.id AND m.variant = 'default'
      """;

  /** 全部产品（含停用）+ 默认变体 + 两个计数。**无 WHERE status**（见类注释） */
  public List<Map<String, Object>> products() {
    return jdbc.sql(PRODUCT_ROW_SELECT + " ORDER BY p.sort_order, p.id").query().listOfRows();
  }

  /**
   * **一款**产品，列与 `products()` 逐列相同 —— 给「改完状态把卡片原样带回」用。
   *
   * 与 `productById()` 的分工：那个只取 5 列、用于「验存在 / 读改前的状态」；
   * 凡是**要把结果交给界面去替换卡片**的地方，必须走这一条。
   */
  public Map<String, Object> productRowById(long id) {
    final List<Map<String, Object>> rows = jdbc.sql(PRODUCT_ROW_SELECT + " WHERE p.id = :id")
        .param("id", id).query().listOfRows();
    return rows.isEmpty() ? null : rows.get(0);
  }

  /**
   * 全部变体（**一条都不滤**）—— 列表页按产品分组用。
   *
   * 为什么不让 `products()` 带默认变体的同时再加个按产品查的入口：
   * 4 款产品还行，40 款就是 40 次查询（N+1）。这里一次取回、在服务层分组。
   */
  public List<Map<String, Object>> allModels() {
    return jdbc.sql("""
        SELECT id, product_id, variant, file_path, file_size, source_file_path, thumb_file,
               checksum, unit, bbox_w, bbox_d, bbox_h, envelope_mode, envelope_ok,
               anisotropy_ok, lod_json, delta_vs_source_json, created_at, updated_at
          FROM product_model ORDER BY product_id, variant
        """).query().listOfRows();
  }

  /**
   * 一款产品（按 db id）—— 给“加变体”验存在用。
   * **按 id 查、不按状态滤**：停用的产品也能加变体（它迟早要修好）。
   */
  public Map<String, Object> productById(long id) {
    final List<Map<String, Object>> rows = jdbc.sql("""
            SELECT id, model_no, name, status,
                   JSON_UNQUOTE(JSON_EXTRACT(recipe_json, '$.id')) AS recipe_id
              FROM product WHERE id = :id
            """)
        .param("id", id).query().listOfRows();
    return rows.isEmpty() ? null : rows.get(0);
  }

  /**
   * 系统状态页要的账。
   *
   * 全部是**能被核对的数**（不是"感觉还行"）：各类对象各有多少、模型占盘多少、
   * LOD 层数分布、最后一条迁移是什么。维护端首页要能回答"这套东西现在是什么状态"。
   */
  public Map<String, Object> counts() {
    return jdbc.sql("""
        SELECT
          (SELECT COUNT(*) FROM product)                                      AS products,
          (SELECT COUNT(*) FROM product WHERE status = 'active')              AS products_active,
          (SELECT COUNT(*) FROM product WHERE status <> 'active')             AS products_disabled,
          (SELECT COUNT(*) FROM product_model)                                AS models,
          (SELECT COUNT(*) FROM product_model WHERE file_path <> '')          AS models_with_file,
          (SELECT COUNT(*) FROM product_note)                                 AS notes,
          (SELECT COUNT(*) FROM scheme)                                       AS schemes,
          (SELECT COUNT(*) FROM scheme WHERE deleted = 0)                     AS schemes_live,
          (SELECT COUNT(*) FROM scheme_revision)                              AS revisions,
          (SELECT COUNT(*) FROM sys_user)                                     AS users,
          (SELECT COUNT(*) FROM app_config)                                   AS config_rows
        """).query().listOfRows().get(0);
  }

  /** 磁盘占用（模型 + 缩略图，单位字节）。库大起来之后这是最直观的账 */
  public Map<String, Object> disk() {
    return jdbc.sql("""
        SELECT IFNULL(SUM(file_size), 0)  AS model_bytes,
               IFNULL(SUM(thumb_size), 0) AS thumb_bytes,
               COUNT(*)                   AS model_rows
          FROM product_model
        """).query().listOfRows().get(0);
  }

  /** LOD 层数分布（`{"levels":[...]}`，形状已核）：维护端要看"是不是每个都出齐了 3 层" */
  public List<Map<String, Object>> lodLevels() {
    return jdbc.sql("""
        SELECT m.product_id, m.variant, p.model_no, p.name,
               IFNULL(JSON_LENGTH(m.lod_json, '$.levels'), 0)  AS level_count,
               IFNULL(JSON_LENGTH(m.lod_json, '$.skipped'), 0) AS skipped_count
          FROM product_model m
          JOIN product p ON p.id = m.product_id
         ORDER BY m.product_id, m.variant
        """).query().listOfRows();
  }

  /** 迁移到哪一版了（Flyway 是**全局命名空间**，重号会让服务起不来 —— 这里看得见） */
  public List<Map<String, Object>> migrations() {
    return jdbc.sql("""
        SELECT version, description, success, installed_on
          FROM flyway_schema_history
         ORDER BY installed_rank
        """).query().listOfRows();
  }

  /**
   * 一个账号行（按登录名）。认证与"每次请求复核身份"都走这一条 —— 命中唯一键 `uk_user_username`。
   */
  public Map<String, Object> userByUsername(String username) {
    return first(jdbc.sql("""
        SELECT id, username, display_name, role_code, enabled, external_id, password_hash
          FROM sys_user
         WHERE username = :username
        """).param("username", username).query().listOfRows());
  }

  /** 一个账号行（按主键）。`AccountFreshnessFilter` 每次请求都走主键查一次，用户表是几十行的量级 */
  public Map<String, Object> userById(long id) {
    return first(jdbc.sql("""
        SELECT id, username, display_name, role_code, enabled, external_id, password_hash
          FROM sys_user
         WHERE id = :id
        """).param("id", id).query().listOfRows());
  }

  /**
   * 账号目录：登录名、显示名、角色、启用状态。
   *
   * 维护端方案库要在卡片上写出归属人、并在账号停用时标出来 —— 两件事走同一条取数，
   * 免得"名字来自一处、启用状态来自另一处"慢慢分岔。`password_hash` **不取**：这里只服务展示。
   */
  public List<Map<String, Object>> userDirectory() {
    return jdbc.sql("""
        SELECT id, username, display_name, role_code, enabled
          FROM sys_user ORDER BY id
        """).query().listOfRows();
  }

  private static Map<String, Object> first(List<Map<String, Object>> rows) {
    return rows.isEmpty() ? null : rows.get(0);
  }
}
