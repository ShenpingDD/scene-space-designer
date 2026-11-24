package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * ProductWriteRepository —— 维护端的**写**路径（R6-2）
 *
 * 为什么不并进 AdminRepository：那个类的注释把"**一条都不滤**"当成契约，
 * 往里塞 INSERT 会让"它只读"这个前提作废 —— 以后读代码的人会以为它安全。
 *
 * **一个事务写三张表**：product（产品事实）+ product_model（这一个模型文件）+
 * product_note（说明条目）。缺一张就是半成品 —— 而**半成品在列表里和成品长得一样**，
 * 这是最坏的情况。
 *
 * ⚠️ `status` 不是参数，而是**写死在 SQL 里的 'draft'**：
 * 表上这一列的默认值是 `'active'` —— 图省事不写它，没跑完 LOD 的产品就会**立刻对使用者可见**。
 * 做成常量而不是参数，是为了让调用方**没有机会**误传 active。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class ProductWriteRepository {

  /** 新增一律 draft。要转 active 只有一个正当理由：LOD 跑完且达标（见 R6-2 的作业）。 */
  static final String NEW_PRODUCT_STATUS = "draft";

  // 文本块里**不能**拼常量（Java 的 """ 里不允许出现 +），所以这里写的是字面量 'draft'。
  // 常量 NEW_PRODUCT_STATUS 与这条 SQL 的一致性由测试断言（ProductWriteRepositoryTest）——
  // 光靠"我看着对"不行，得有一条会失败的检查。
  static final String SQL_INSERT_PRODUCT = """
      INSERT INTO product (model_no, name, series, description, origin, size_note,
                           door_part, door_verified, door_source, color, source_url,
                           status, recipe_json, sort_order, updated_by, created_at, updated_at)
      VALUES (:modelNo, :name, :series, :description, :origin, :sizeNote,
              :doorPart, :doorVerified, :doorSource, :color, :sourceUrl,
              'draft', :recipeJson, :sortOrder, :actor, :now, :now)
      """;

  static final String SQL_INSERT_MODEL = """
      INSERT INTO product_model (product_id, variant, source_file_path, thumb_file, thumb_size,
                                 thumb_checksum, file_path, file_size, checksum, unit,
                                 bbox_w, bbox_d, bbox_h, envelope_mode, envelope_ok, anisotropy_ok,
                                 delta_vs_source_json, hinge_nodes, lod_json, source,
                                 created_at, updated_at)
      VALUES (:pid, :variant, :srcPath, :thumbFile, :thumbSize,
              :thumbChecksum, :filePath, :fileSize, :checksum, :unit,
              :bboxW, :bboxD, :bboxH, :envMode, :envOk, :anisoOk,
              :delta, :hinge, :lod, :origin,
              :now, :now)
      """;

  /**
   * LOD 跑完：填产物路径与账本。
   *
   * ⚠️ 认的是**模型行自己的 id**，不是 product_id。
   *    一个产品现在可以有多个变体（决策④：换模型 = 新增 variant，不覆盖）——
   *    按 product_id 更新会让"给 v2 跑完 LOD"把 **default 那一行**的 file_path 覆盖掉，
   *    于是前台加载的是错的那份模型，而两个变体看起来都"有文件"。
   *    （老代码的注释已经预告过这一天：「将来若出现多变体，这里必须按 variant 过一遍」。）
   */
  static final String SQL_UPDATE_MODEL_LOD = """
      UPDATE product_model
         SET file_path = :file, file_size = :size, checksum = :sum, lod_json = :lod, updated_at = :now
       WHERE id = :mid
      """;

  /**
   * 转到 active —— **只有 LOD 真跑完才有这个正当理由**（新增时写死 draft 的那条 SQL 见上）。
   *
   * ⚠️ 多变体（B5）之后多了一个条件：**必须有 `default` 变体、而且它真有产物文件**。
   *    理由：前台只认 `default`（`CatalogRepository` 的 join）。不加这个条件的话，
   *    "给 v2 跑完 LOD"会把一个**默认变体还没有模型**的产品盖上 active 章 →
   *    产品在列表里可点、打开却没有模型 —— 这正是「半成品比干脆失败更难查」。
   *    条件写进 SQL 而不是交给调用方传布尔：**调用方没有机会记错**。
   */
  static final String SQL_ACTIVATE = """
      UPDATE product p
         SET p.status = 'active', p.updated_at = :now
       WHERE p.id = :pid
         AND EXISTS (SELECT 1 FROM product_model d
                      WHERE d.product_id = p.id AND d.variant = 'default' AND d.file_path <> '')
      """;

  /**
   * LOD 没跑成：产品留在 draft，但**把原因写进库里** —— 否则「没优化」和「优化过了」看起来一样。
   * 同样认模型行 id（理由见 SQL_UPDATE_MODEL_LOD）：写错行的话，失败原因会挂在另一个变体上，
   * 读的人会去查一个**没问题**的模型。
   */
  static final String SQL_MARK_LOD_FAILURE = """
      UPDATE product_model SET delta_vs_source_json = :delta, updated_at = :now WHERE id = :mid
      """;

  static final String SQL_INSERT_NOTE = """
      INSERT INTO product_note (product_id, kind, label, value, sort_order)
      VALUES (:pid, :kind, :label, :value, :sort)
      """;

  /** 变体名 → 模型行 id（LOD 回写要用它认行；没有就是 null，调用方负责说清"没找到"）。 */
  static final String SQL_MODEL_ID =
      "SELECT id FROM product_model WHERE product_id = :pid AND variant = :variant";

  /** 这个变体名是不是已被占用（重名要给人话，不能让数据库的唯一键去抛天书）。 */
  static final String SQL_VARIANT_EXISTS =
      "SELECT COUNT(*) FROM product_model WHERE product_id = :pid AND variant = :variant";

  /** 这个产品现在有哪些变体（报"重名"时要把已有的说出来，用户才知道该换个什么名字）。 */
  static final String SQL_VARIANTS_OF =
      "SELECT variant FROM product_model WHERE product_id = :pid ORDER BY variant";

  /**
   * 停用 / 启用（决策③：产品**只停用不删除**）。
   *
   * ⚠️ 逐字写清"只改这三列"：产品事实（型号/名称/尺寸/门型/配方）**一个都不许动** ——
   *    停用是个"还看不看得见"的问题，不是"改它的内容"。这条由测试断言（不许出现 name/bbox 之类）。
   */
  static final String SQL_SET_STATUS = """
      UPDATE product SET status = :status, updated_by = :actor, updated_at = :now WHERE id = :pid
      """;

  /**
   * 允许由**人**写进 status 的两个值。
   *
   * 为什么把 'draft' 挡在外面：它是"LOD 还没跑完"的内部状态（表默认值 'active' 才是那个坑）。
   * 一个手滑把成品打成 draft，前台会静默消失一款 —— 而界面上看起来只是"停用"。
   * 所以这里用**白名单**而不是"非空就行"。
   */
  static final List<String> STATUS_WRITABLE = List.of("active", "disabled");

  /** 写之前的校验（抽成静态方法：不连库也能测这条规矩）。 */
  static String checkStatusWritable(String status) {
    final String s = status == null ? "" : status.trim();
    if (!STATUS_WRITABLE.contains(s)) {
      throw new IllegalArgumentException("status 只接受 " + STATUS_WRITABLE + "（收到："
          + (s.isEmpty() ? "(空)" : s) + "）—— 'draft' 是 LOD 没跑完的内部状态，不能拿它当停用");
    }
    return s;
  }

  /** 加变体也算"改了这个产品"：`updated_by` 是用来找人的（见 product 表那一列的注释）。 */
  static final String SQL_TOUCH_PRODUCT =
      "UPDATE product SET updated_by = :actor, updated_at = :now WHERE id = :pid";

  /**
   * 编辑产品事实：只列允许人改的列；modelNo 不在里面（它是产品身份，改了目录/方案全认不出）。
   * 声明尺寸用 JSON_SET 写回 recipe_json，**保留 id/unit 等其它键**。
   */
  static final String SQL_UPDATE_PRODUCT_EDIT = """
      UPDATE product
         SET name = :name, series = :series, description = :description,
             source_url = :sourceUrl, size_note = :sizeNote, color = :color,
             door_part = :doorPart, door_verified = :doorVerified, door_source = :doorSource,
             recipe_json = JSON_SET(COALESCE(recipe_json, JSON_OBJECT()),
                                    '$.w', :declaredW, '$.d', :declaredD, '$.h', :declaredH),
             updated_by = :actor, updated_at = :now
       WHERE id = :pid
      """;

  /** 编辑默认模型：只改人能改的展示/标注字段；产物路径/尺寸/checksum 不在里面。 */
  static final String SQL_UPDATE_DEFAULT_MODEL = """
      UPDATE product_model
         SET thumb_file = :thumbFile, envelope_mode = :envMode,
             anisotropy_ok = :anisoOk, hinge_nodes = COALESCE(:hinge, hinge_nodes),
             updated_at = :now
       WHERE product_id = :pid AND variant = 'default'
      """;

  /**
   * 1:1 尺寸对账的输入：声明尺寸（recipe_json 的 w/d/h）+ 实测包围盒 + 模式。
   *
   * ⚠️ 从**同一行库数据**里取两边，而不是信任请求体里的声明数字：写库与对账必须是同一份事实。
   */
  static final String SQL_ENVELOPE_INPUTS = """
      SELECT m.id AS model_id, m.envelope_mode, m.bbox_w, m.bbox_d, m.bbox_h,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.w')) AS declared_w,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.d')) AS declared_d,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.h')) AS declared_h
        FROM product p
        JOIN product_model m ON m.product_id = p.id
       WHERE p.id = :pid AND m.variant = :variant
      """;

  /** 同一个对账按**模型行 id** 取（LOD 回写按行认，见 finishLod）。 */
  static final String SQL_ENVELOPE_INPUTS_BY_MODEL = """
      SELECT m.id AS model_id, m.envelope_mode, m.bbox_w, m.bbox_d, m.bbox_h,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.w')) AS declared_w,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.d')) AS declared_d,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.h')) AS declared_h
        FROM product p
        JOIN product_model m ON m.product_id = p.id
       WHERE m.id = :mid
      """;

  /** 对账结论的唯一落点（1 / 0 / NULL 三态，NULL 只表示确实无可核对数据）。 */
  static final String SQL_UPDATE_ENVELOPE_OK =
      "UPDATE product_model SET envelope_ok = :envOk WHERE id = :mid";

  /** 质量闸门要的一行：产品事实 + 指定变体的模型事实（snake_case，交给 ProductQuality.gate）。 */
  static final String SQL_QUALITY_ROW_BY_MODEL = """
      SELECT p.recipe_json, p.size_note, p.door_part, p.door_verified,
             m.variant, m.file_path, m.unit, m.bbox_w, m.bbox_d, m.bbox_h,
             m.envelope_mode, m.envelope_ok
        FROM product p
        JOIN product_model m ON m.product_id = p.id
       WHERE m.id = :mid
      """;

  /** QA 复核 / 回填用：列出现有产品的对账输入（只读）。 */
  static final String SQL_ENVELOPE_INPUTS_ALL = """
      SELECT p.id AS product_id, p.model_no, p.recipe_json, p.size_note,
             p.door_part, p.door_verified, m.id AS model_id, m.variant, m.file_path, m.unit,
             m.bbox_w, m.bbox_d, m.bbox_h, m.envelope_mode, m.envelope_ok,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.w')) AS declared_w,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.d')) AS declared_d,
             JSON_UNQUOTE(JSON_EXTRACT(p.recipe_json, '$.h')) AS declared_h
        FROM product p
        JOIN product_model m ON m.product_id = p.id
       ORDER BY p.id, m.variant
      """;

  /** 物理删除产品；子表靠既有 FK CASCADE 收尾（不新增迁移，也不自己拼删除顺序）。 */
  static final String SQL_DELETE_PRODUCT = "DELETE FROM product WHERE id = :pid";

  private final JdbcClient jdbc;

  public ProductWriteRepository(JdbcClient jdbc) {
    this.jdbc = jdbc;
  }

  /**
   * 停用（`disabled`）或重新启用（`active`）一款产品。
   *
   * 为什么**不提供删除**：方案里存的是几何快照，但目录条目被引在别处（配方、交付包、类型卡）——
   * 删掉之后"以前那份方案为什么摆的是它"就再也答不上来。停用只影响"前台还找不找得到它"。
   *
   * @return true = 这一行确实存在（并按新状态更新了）；false = 没有这个 id。
   *         调用方要的"本来就是启用的"那句话由 controller 读旧值来说 —— UPDATE 成功不等于"改变了什么"。
   */
  @Transactional
  public boolean setStatus(long productId, String status, String actor) {
    final String want = checkStatusWritable(status);
    final int n = jdbc.sql(SQL_SET_STATUS)
        .param("status", want)
        .param("actor", s(actor))
        .param("now", LocalDateTime.now())
        .param("pid", productId)
        .update();
    return n > 0;
  }

  /**
   * 建一款产品（含默认变体的模型行 + 若干说明条目）。
   *
   * @param p     产品事实（modelNo/name/series/description/origin/sizeNote/doorPart/color/sourceUrl/sortOrder/recipeJson）
   * @param m     模型行（源文件、缩略图、实测包围盒、门节点、LOD 账本、偏差…）
   * @param notes 说明条目（可空）
   * @param actor 谁建的 —— 写进 updated_by，出了问题要能找到人
   * @return 新 product.id
   */
  @Transactional
  public long createProduct(Map<String, Object> p, Map<String, Object> m,
                            List<Map<String, Object>> notes, String actor) {
    final LocalDateTime now = LocalDateTime.now();
    final KeyHolder keys = new GeneratedKeyHolder();
    jdbc.sql(SQL_INSERT_PRODUCT)
        .param("modelNo", s(p.get("modelNo")))
        .param("name", s(p.get("name")))
        .param("series", s(p.get("series")))
        .param("description", s(p.get("description")))
        .param("origin", s(p.get("origin")))
        .param("sizeNote", s(p.get("sizeNote")))
        .param("doorPart", p.get("doorPart"))          // 这一列允许 NULL：门型确实可能判不出来
        .param("doorVerified", b(p.get("doorVerified")))
        .param("doorSource", s(p.get("doorSource")))
        .param("color", s(p.get("color")))
        .param("sourceUrl", s(p.get("sourceUrl")))
        .param("recipeJson", s(p.get("recipeJson")))
        .param("sortOrder", i(p.get("sortOrder")))
        .param("actor", s(actor))
        .param("now", now)
        .update(keys);
    final long productId = keys.getKey().longValue();

    // ⚠️ 没有模型 = **人工代录**（B6）：这一行**不许插**。
    //    插了就会得到一行“看起来有模型、实际没有任何尺寸”的记录 —— 比没有行更坏：
    //    列表上会显示“1 个变体、没就绪”，后人根本分不清是“LOD 还没跑完”还是“本来就没交模型”。
    //    调用方（ProductAdminController.create）分的是同一刀：model == null 就不发 LOD 作业。
    //    ← 这一条是端到端探针抓到的：controller 那一层分好了，写库这一层还无条件调用，
    //      表现是 500「Cannot invoke "java.util.Map.get(Object)" because "m" is null」。
    if (m != null) {
      bindModel(jdbc.sql(SQL_INSERT_MODEL), productId, m, now).update();
      // 新写入的模型也要**立刻**对账：不能等一次手工编辑才判 1:1（用户 22:18 记录的缺陷就是这样来的）
      refreshEnvelope(productId, ProductDraft.variantOf(m));
    }

    if (notes != null) {
      for (final Map<String, Object> n : notes) {
        jdbc.sql(SQL_INSERT_NOTE)
            .param("pid", productId)
            .param("kind", s(n.get("kind")))
            .param("label", s(n.get("label")))
            .param("value", s(n.get("value")))
            .param("sort", i(n.get("sortOrder")))
            .update();
      }
    }
    return productId;
  }

  /**
   * 加一个变体（决策④：换模型 = 新增 variant，**不覆盖**老的那一份）。
   *
   * 只是往 `product_model` 插一行 —— **产品行一个字都不改**（型号/尺寸/门型是产品事实，
   * 换模型不该动它）。所以"给老产品换个模型"对**已经存下来的方案**没有任何影响：
   * 方案里的几何是自己存的，而且前台只认 `default` 变体（见 `CatalogRepository`）。
   *
   * @return 新模型行 id（LOD 回写要用它认行）
   */
  @Transactional
  public long addVariant(long productId, Map<String, Object> m, String actor) {
    final LocalDateTime now = LocalDateTime.now();
    final KeyHolder keys = new GeneratedKeyHolder();
    bindModel(jdbc.sql(SQL_INSERT_MODEL), productId, m, now).update(keys);
    final long modelId = keys.getKey().longValue();
    refreshEnvelope(productId, ProductDraft.variantOf(m));
    jdbc.sql(SQL_TOUCH_PRODUCT).param("pid", productId).param("actor", s(actor)).param("now", now).update();
    return modelId;
  }

  /** 模型行的参数绑定 —— 新增产品与"加一个变体"**共用这一处**（两处各写一遍，迟早漏一个字段）。 */
  private org.springframework.jdbc.core.simple.JdbcClient.StatementSpec bindModel(
      org.springframework.jdbc.core.simple.JdbcClient.StatementSpec spec,
      long productId, Map<String, Object> m, LocalDateTime now) {
    return spec
        .param("pid", productId)
        .param("variant", ProductDraft.variantOf(m))
        .param("srcPath", s(m.get("sourceFilePath")))
        .param("thumbFile", s(m.get("thumbFile")))
        .param("thumbSize", i(m.get("thumbSize")))
        .param("thumbChecksum", s(m.get("thumbChecksum")))
        .param("filePath", s(m.get("filePath")))       // draft 阶段可以是空串：LOD 跑完才填
        .param("fileSize", i(m.get("fileSize")))
        .param("checksum", s(m.get("checksum")))
        .param("unit", s(m.get("unit")).isEmpty() ? "mm" : s(m.get("unit")))
        .param("bboxW", m.get("bboxW"))
        .param("bboxD", m.get("bboxD"))
        .param("bboxH", m.get("bboxH"))
        .param("envMode", s(m.get("envelopeMode")).isEmpty() ? "fit" : s(m.get("envelopeMode")))
        // ⚠️ 两条判据都**不许缺省替模型下结论**（第 2 轮审查 dev-1）：
        //    `anisotropyOk == null ? 1 : ...` 会让「漏传这个字段」变成「各轴缩放正常」 ——
        //    库里躺着一条假话，而且没有任何地方会报。缺读数就写 NULL（未判），
        //    读出侧把 NULL 说成「未判」—— V15 把这两列改成可为空就是为了这个。
        .param("envOk", nb(m.get("envelopeOk")))
        .param("anisoOk", nb(m.get("anisotropyOk")))
        .param("delta", m.get("deltaVsSourceJson"))
        .param("hinge", s(m.get("hingeNodesJson")).isEmpty() ? "[]" : s(m.get("hingeNodesJson")))
        .param("lod", s(m.get("lodJson")).isEmpty() ? "{\"levels\":[],\"skipped\":[]}" : s(m.get("lodJson")))
        .param("origin", s(m.get("source")).isEmpty() ? "upload" : s(m.get("source")))
        .param("now", now);
  }

  /**
   * 编辑产品事实 + 默认模型展示字段（一个事务；产品不存在返回 false）。
   *
   * @param p 已校验的产品字段（name/series/description/sourceUrl/sizeNote/color/
   *          doorPart/doorVerified/doorSource/declaredW/declaredD/declaredH）
   * @param m 已校验的默认模型字段（thumbFile/envMode/envOk/anisoOk/hingeNodesJson）
   */
  @Transactional
  public boolean editProduct(long productId, Map<String, Object> p, Map<String, Object> m,
                             String actor) {
    final LocalDateTime now = LocalDateTime.now();
    final int n = jdbc.sql(SQL_UPDATE_PRODUCT_EDIT)
        .param("pid", productId)
        .param("name", s(p.get("name")))
        .param("series", s(p.get("series")))
        .param("description", s(p.get("description")))
        .param("sourceUrl", s(p.get("sourceUrl")))
        .param("sizeNote", s(p.get("sizeNote")))
        .param("color", s(p.get("color")))
        .param("doorPart", p.get("doorPart") == null ? null : s(p.get("doorPart")))
        .param("doorVerified", b(p.get("doorVerified")))
        .param("doorSource", s(p.get("doorSource")))
        .param("declaredW", p.get("declaredW"))
        .param("declaredD", p.get("declaredD"))
        .param("declaredH", p.get("declaredH"))
        .param("actor", s(actor))
        .param("now", now)
        .update();
    if (n == 0) return false;
    jdbc.sql(SQL_UPDATE_DEFAULT_MODEL)
        .param("pid", productId)
        .param("thumbFile", s(m.get("thumbFile")))
        .param("envMode", s(m.get("envMode")))
        // envelope_ok **不接受请求体里的值**：它是「声明 vs 实测」的服务端结论，
        // 由 editProduct 写回之后统一 refreshEnvelope 重算（见 SQL_UPDATE_DEFAULT_MODEL 的注释）。
        .param("anisoOk", nb(m.get("anisoOk")))
        .param("hinge", m.get("hingeNodesJson") == null ? null : s(m.get("hingeNodesJson")))
        .param("now", now)
        .update();
    // 声明尺寸刚被 JSON_SET 写回、模式可能刚被改过 → 用**库里的新事实**重算 1:1 对账
    refreshEnvelope(productId, "default");
    return true;
  }

  /**
   * 1:1 尺寸对账的**唯一写入点**：从库里取声明尺寸与实测包围盒，逐轴判，写回 envelope_ok。
   *
   * 为什么写在这里而不是 controller：新增 / 加变体 / 编辑 / LOD 跑完四条路都要算，
   * 放 controller 就一定会漏一条（用户 22:18 记的缺陷正是「导入/激活路径没算」）。
   *
   * @return 算出的三态值（1 / 0 / NULL）；没有这一行模型时返回 null
   */
  Integer refreshEnvelope(long productId, String variant) {
    final List<Map<String, Object>> rows = jdbc.sql(SQL_ENVELOPE_INPUTS)
        .param("pid", productId).param("variant", variant).query().listOfRows();
    return rows.isEmpty() ? null : writeEnvelope(rows.get(0));
  }

  /** 同一个对账按模型行取（LOD 回写按行认，见 finishLod）。 */
  Integer refreshEnvelopeByModel(long modelId) {
    final List<Map<String, Object>> rows = jdbc.sql(SQL_ENVELOPE_INPUTS_BY_MODEL)
        .param("mid", modelId).query().listOfRows();
    return rows.isEmpty() ? null : writeEnvelope(rows.get(0));
  }

  private Integer writeEnvelope(Map<String, Object> row) {
    // fit/空模式没有「声明 vs 实测」这个结论：不要写 NULL，更不要覆盖历史值。
    // 这一列只属于 1:1；对账入口也必须只处理 1:1，否则一次 recheck 就会把 fit 的 0/1 抹掉。
    if (!"1:1".equals(String.valueOf(row.get("envelope_mode")))) return null;
    final Integer ok = ProductQuality.envelopeOk(row.get("envelope_mode"),
        row.get("declared_w"), row.get("declared_d"), row.get("declared_h"),
        row.get("bbox_w"), row.get("bbox_d"), row.get("bbox_h"));
    final Object mid = row.get("model_id");
    if (mid instanceof Number n) {
      jdbc.sql(SQL_UPDATE_ENVELOPE_OK).param("envOk", ok).param("mid", n.longValue()).update();
    }
    return ok;
  }

  /** 质量闸门（只读）：按模型行取一行事实，交给 {@link ProductQuality} 判 BLOCK / WARN。 */
  public ProductQuality.Gate gateOf(long modelId) {
    final List<Map<String, Object>> rows = jdbc.sql(SQL_QUALITY_ROW_BY_MODEL)
        .param("mid", modelId).query().listOfRows();
    return rows.isEmpty() ? new ProductQuality.Gate(List.of()) : ProductQuality.gate(rows.get(0));
  }

  /** QA 复核用：现有产品的对账输入（声明 / 实测 / 模式 / 已落库的 envelope_ok），只读。 */
  public List<Map<String, Object>> envelopeInputs() {
    return jdbc.sql(SQL_ENVELOPE_INPUTS_ALL).query().listOfRows();
  }

  /**
   * 维护端「按同一规则重算」：把现有产品的 envelope_ok 逐行重算并写回（只改这一列）。
   *
   * 用途：批量导入/历史数据（例如演示产品）在**导入路径之外**落库时，用它补一次对账；
   * 不会因为某款 `envelope_ok=0` 就判死 —— 0 是结论，写回的也是 0。
   *
   * ⚠️ 只处理**有模型行**的产品（SQL 里 JOIN product_model）：人工代录、或还没跑出默认模型的
   * draft 一行都不会被碰 —— 它们没有 `file_path`、也没有实测包围盒，不该在这里被误判成 BLOCK。
   * 本方法也**不写**产品级字段（size_note / door_part / status），只改 `envelope_ok` 一列。
   *
   * @return 实际改动的行数（含从 NULL 变成 1/0 的行）
   */
  @Transactional
  public int recheckEnvelopes() {
    final List<Map<String, Object>> rows = envelopeInputs();
    int changed = 0;
    for (final Map<String, Object> row : rows) {
      final Object mid = row.get("model_id");
      if (!(mid instanceof Number n)) continue;
      // fit/空模式不在本列语义内：跳过，既不改库，也不要把“跳过”误报成 changed。
      if (!"1:1".equals(String.valueOf(row.get("envelope_mode")))) continue;
      final Integer before = nb(row.get("envelope_ok"));
      final Integer after = writeEnvelope(row);
      if (!java.util.Objects.equals(before, after)) changed++;
    }
    return changed;
  }

  /** 物理删除；返回是否存在并删掉。子表由 FK CASCADE 处理。 */
  @Transactional
  public boolean deleteProduct(long productId) {
    return jdbc.sql(SQL_DELETE_PRODUCT).param("pid", productId).update() > 0;
  }

  /** 这个产品现在的变体名单（报重名时要说清"已经有哪几个"） */
  public List<String> variantsOf(long productId) {
    return jdbc.sql(SQL_VARIANTS_OF).param("pid", productId).query(String.class).list();
  }

  /** 变体名是否已被占用 */
  public boolean variantExists(long productId, String variant) {
    final Integer n = jdbc.sql(SQL_VARIANT_EXISTS)
        .param("pid", productId).param("variant", variant).query(Integer.class).optional().orElse(0);
    return n != null && n > 0;
  }

  /** 变体名 → 模型行 id；没有这个变体就返回 null（调用方负责把"没有"说出来） */
  public Long modelIdOf(long productId, String variant) {
    return jdbc.sql(SQL_MODEL_ID)
        .param("pid", productId).param("variant", variant).query(Long.class).optional().orElse(null);
  }

  /**
   * LOD 作业成功后的回写：填产物路径 + lod_json，并把产品转 active。
   *
   * ⚠️ 两条 UPDATE 必须在**同一个事务**里：只改一半的话会出现「产品是 active、模型却没有文件」，
   * 前台照着 file_path 去加载一个不存在的 GLB —— 这种半成品比干脆失败更难查。
   *
   * @param modelId 哪一个变体的模型行（**按行认**，不按产品认 —— 见 SQL_UPDATE_MODEL_LOD）
   */
  @Transactional
  public ProductQuality.Gate finishLod(long modelId, long productId, String filePath, int fileSize,
                                       String checksum, String lodJson) {
    final LocalDateTime now = LocalDateTime.now();
    jdbc.sql(SQL_UPDATE_MODEL_LOD)
        .param("mid", modelId).param("file", s(filePath)).param("size", fileSize)
        .param("sum", s(checksum)).param("lod", s(lodJson)).param("now", now)
        .update();

    // ① 产物文件刚写进去 → 立刻用这份新事实做 1:1 对账（不是等下一次手工编辑）
    refreshEnvelopeByModel(modelId);

    // ② 质量闸门：有 BLOCK 就**不许转 active**，把原因写进 lodError 让人能看见。
    //    这是「导入/激活路径要触发尺寸对账」的落点：只 WARN（如 envelope_ok=0）照常上岗。
    final ProductQuality.Gate gate = gateOf(modelId);
    if (gate.blocked()) {
      final String delta = Json.write(Json.obj("lodError", gate.summary(),
          "lodErrorAt", now.toString()), 0);
      jdbc.sql(SQL_MARK_LOD_FAILURE).param("mid", modelId).param("delta", delta)
          .param("now", now).update();
      return gate;
    }

    // active 的条件由 SQL 自己判（必须有 default 变体且它真有文件）—— 非默认变体跑完不会误盖章
    jdbc.sql(SQL_ACTIVATE).param("pid", productId).param("now", now).update();
    return gate;
  }

  /**
   * LOD 作业没跑成：**产品留在 draft**（前台看不见它），把原因写进唯一一个空着的可空列。
   *
   * 为什么不给 delta_vs_source_json 新加一个列：那是迁移的事（V12），而这一批不需要动表结构；
   * 放在这里也不会被误读成「尺寸偏差」—— 字段名就叫 lodError。
   */
  @Transactional
  public void failLod(long modelId, String reason) {
    final String delta = Json.write(Json.obj("lodError", s(reason),
        "lodErrorAt", LocalDateTime.now().toString()), 0);
    jdbc.sql(SQL_MARK_LOD_FAILURE).param("mid", modelId).param("delta", delta)
        .param("now", LocalDateTime.now()).update();
  }

  private static String s(Object o) { return o == null ? "" : String.valueOf(o); }

  private static int i(Object o) {
    if (o instanceof Number n) return n.intValue();
    try { return o == null ? 0 : Integer.parseInt(String.valueOf(o)); } catch (NumberFormatException e) { return 0; }
  }

  private static int b(Object o) {
    if (o instanceof Boolean v) return v ? 1 : 0;
    return i(o) == 0 ? 0 : 1;
  }

  /**
   * 三态版：**没给值就是 null**（未判），不是 0 也不是 1。
   *
   * 0 是"判为不正常"、1 是"判为正常" —— 两者都是替模型下结论。缺读数只能是 null。
   * 布尔与数字照旧，只有"没有这个键 / 值为 null"才落到 null。
   */
  // 包内可见：让「缺读数 → NULL」这条规矩能被单测钉住（private 就只能靠肉眼）
  static Integer nb(Object o) {
    if (o == null) return null;
    if (o instanceof String s && s.trim().isEmpty()) return null;
    return b(o);
  }
}
