package com.scene.spatial.admin;

import com.scene.spatial.kernel.Json;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ProductAdminController —— 维护端 · 产品列表 / 上传 / 编辑 / 删除（R6-1 → 验收-2）
 *
 * 列表先做到"看得见、分得清"，再逐批补上写路径：上传、新增、停用/启用、
 * 编辑（验收-2）与物理删除（验收-2）。所有写入口都先过 `admin.requireMaintain()`。
 *
 * ⚠️ **只在连库档（`spatial.store=jdbc`）注册**（2026-10-12 补）：
 * 本控制器构造时要 `ProductWriteRepository`，而它只在 jdbc 档才存在 ——
 * 不给本类加同样的条件时，`--spring.profiles.active=local-nodb`（无库档）
 * **根本起不来**（容器里没有那个 bean → 上下文启动失败），而「无库档」在文档里一直写着「能用」。
 * 与同类保持一致：`CatalogController` / `AdminController` 早就是这么写的。
 * 加条件的后果是**无库档下维护端接口返回 404** —— 这正是 `--no-db` 该有的能力边界：
 * 要的是它**响亮地不存在**，而不是应用本身起不来。
 */
@RestController
@RequestMapping("/api/admin/products")
@org.springframework.boot.autoconfigure.condition.ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class ProductAdminController {

  /** 上传件在磁盘上的名字长这样（内容寻址：sha256 + .glb），用它把 URL 反推回文件。 */
  private static final java.util.regex.Pattern ASSET_URL =
      java.util.regex.Pattern.compile("^/api/assets/([a-f0-9]{64})[.]glb$");

  /**
   * LOD 失败的**最后一道出口**。
   *
   * 为什么必须有一个 logger：`runLod` 的兜底是"写进库（`lodError`）"，但**写库本身也会失败**
   * （库连不上、行被删了）—— 那时原来那行 `catch (Exception ignore)` 就把原因**彻底吃掉了**，
   * 产品永远停在 draft，而屏幕上只有"没就绪"三个字（第 2 轮审查 dev-4）。
   * 留痕链是：界面（lodError）→ 服务端日志（这里）→ 库。**最后一道不能没有。**
   */
  private static final Logger log = LoggerFactory.getLogger(ProductAdminController.class);

  private final AdminService admin;
  private final ProductWriteRepository writer;
  private final LodJob lod;
  private final AuditLog audit;
  private final Path uploadDir;
  private final Path thumbDir;

  /**
   * LOD 是 CPU/内存重活，**串行跑**：一台机器上并发压几个 LOD，谁都不会好过。
   * daemon 线程 —— 别因为一个后台作业把 JVM 关不掉。
   */
  private final ExecutorService lodPool = Executors.newSingleThreadExecutor(r -> {
    final Thread t = new Thread(r, "lod-job");
    t.setDaemon(true);
    return t;
  });

  public ProductAdminController(AdminService admin, ProductWriteRepository writer, LodJob lod,
                                AuditLog audit,
                                @Value("${spatial.uploads.dir:assets/uploads}") String uploadDir,
                                @Value("${spatial.assets-dir:assets}") String assetsDir) {
    this.admin = admin;
    this.writer = writer;
    this.lod = lod;
    this.audit = audit;
    this.uploadDir = Paths.get(uploadDir).toAbsolutePath().normalize();
    // 缩略图必须落到 /assets/** 的静态根下（SpaFallbackConfig 读 spatial.assets-dir）
    this.thumbDir = Paths.get(assetsDir).toAbsolutePath().normalize().resolve("thumbs");
  }

  /**
   * 上传**原始**模型（供应商给的 GLB）—— R6-2 第一步。
   *
   * 只做一件事：**把字节安全地存下来，并给一个可复现的名字**。
   * 刻意**不在这里**解析模型：解包、量尺寸、拾取门型都在浏览器端做（"浏览器就是模型分析器"），
   * 后端只管收、存、算校验和 —— 两套几何代码是迟早要打架的。
   *
   * 返回值里的 path 是**绝对 URL**（/api/assets/<sha>.glb）：上传件不在 assets/ 下
   * （那是构建产物目录），由后端下发、经 vite 代理 —— 前台用 assetUrl() 认这种写法。
   */
  @PostMapping("/upload")
  public Map<String, Object> upload(@RequestParam("file") MultipartFile file) {
    admin.requireMaintain();
    if (file == null || file.isEmpty()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "没收到文件");
    }
    final String original;
    try {
      original = Uploads.checkGlbName(file.getOriginalFilename());
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }
    final byte[] bytes;
    try {
      bytes = file.getBytes();
    } catch (Exception e) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "读上传内容失败：" + e.getMessage());
    }
    // "这次是新写了一份，还是命中了已有的一份" —— 必须在 store **之前**问，
    // 否则就成了拿 sha 跟它自己比（第一版就是这么写的，那个字段恒为 true，等于废话）。
    final String sha = Uploads.sha256(bytes);
    final boolean existedBefore = java.nio.file.Files.isRegularFile(uploadDir.resolve(sha + ".glb"));

    final Path saved;
    try {
      saved = Uploads.store(uploadDir, bytes);
    } catch (Exception e) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "落盘失败：" + e.getMessage());
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("originalName", original);
    out.put("sha256", sha);
    out.put("path", "/api/assets/" + saved.getFileName());
    out.put("bytes", bytes.length);
    out.put("unit", "bytes");            // 单位写进名字旁边，省得有人当成 KB
    out.put("deduped", existedBefore);   // 命中已有的一份 = 内容没变，可以省下后续的重活
    return out;
  }

  /**
   * 上传产品缩略图（验收-2）：只收 PNG / JPEG，≤1 MB，内容寻址写 `assets/thumbs/<sha>.<ext>`。
   *
   * 为什么和原始 GLB 分开：缩略图是**展示件**，走 `/assets/**` 静态根（构建产物优先、
   * 运行期目录回落）；GLB 是**上传源件**，走 `/api/assets/**`。两条地址的缓存与权限都不同，
   * 混在一起会让一次性静态资源带上 API 的鉴权/cache 语义。
   */
  @PostMapping("/upload-thumb")
  public Map<String, Object> uploadThumb(@RequestParam("file") MultipartFile file) {
    admin.requireMaintain();
    if (file == null || file.isEmpty()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "没收到缩略图文件");
    }
    if (file.getSize() > 1024 * 1024) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
          "缩略图不能超过 1 MB（收到 " + file.getSize() + " 字节）");
    }
    final String ext;
    try {
      ext = Uploads.checkThumbName(file.getOriginalFilename(), file.getContentType());
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }
    final byte[] bytes;
    try {
      bytes = file.getBytes();
    } catch (Exception e) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "读缩略图失败：" + e.getMessage());
    }
    final Path saved;
    try {
      saved = Uploads.storeThumb(thumbDir, bytes, ext);
    } catch (Exception e) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "缩略图落盘失败：" + e.getMessage());
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("path", "assets/thumbs/" + saved.getFileName());
    out.put("bytes", bytes.length);
    out.put("unit", "bytes");
    return out;
  }

  /**
   * 编辑产品（验收-2）：产品事实 + 声明尺寸 + 默认模型展示字段。
   *
   * modelNo 是产品身份，**不在这条更新里**；声明尺寸写回 recipe_json 的 w/d/h（JSON_SET，
   * 保留 id/unit 等其它键）。校验在 {@link ProductEdit}，这里只做「读旧值 → 调用 → 回卡片」。
   */
  @PutMapping("/{id}")
  public Map<String, Object> editProduct(@PathVariable long id,
                                         @RequestBody(required = false) Map<String, Object> body) {
    admin.requireMaintain();
    final Map<String, Object> card = admin.productCard(id);
    if (card == null) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有 id=" + id + " 这款产品");
    }
    final Map<String, Object> in = body == null ? Map.of() : body;
    final Map<String, Object> p = asMap(in.get("product"));
    if (p.containsKey("modelNo") && !ProductEdit.str(p.get("modelNo")).isEmpty()
        && !ProductEdit.str(p.get("modelNo")).equals(ProductEdit.str(card.get("modelNo")))) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
          "modelNo 是产品身份，不能通过编辑修改");
    }
    final Map<String, Object> m = asMap(in.get("model"));
    final Map<String, Object> currentModel = asMap(card.get("model"));

    final Map<String, Double> declared;
    try {
      declared = ProductEdit.declared(in.get("declared"));
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }
    final boolean verified = p.containsKey("doorVerified")
        ? ProductEdit.bool(p.get("doorVerified")) : ProductEdit.bool(card.get("doorVerified"));
    final String doorPart;
    final String thumb;
    final String hinge;
    try {
      doorPart = ProductEdit.doorPart(
          p.containsKey("doorPart") ? p.get("doorPart") : card.get("doorPart"), verified);
      thumb = ProductEdit.thumbFile(m.containsKey("thumbFile")
          ? m.get("thumbFile") : currentModel.get("thumbFile"));
      hinge = ProductEdit.hingeNodesJson(m.containsKey("hingeNodesJson")
          ? m.get("hingeNodesJson") : currentModel.get("hingeNodes"));
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    final String sizeNote;
    try {
      // 有模型也要写尺寸说明：它是「声明尺寸从哪来、多可信」的唯一交代（与新增同一条判据）
      sizeNote = ProductEdit.sizeNote(pick(p, "sizeNote", card.get("sizeNote")));
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    final Map<String, Object> product = new LinkedHashMap<>();
    product.put("name", pick(p, "name", card.get("name")));
    product.put("series", pick(p, "series", card.get("series")));
    product.put("description", pick(p, "description", card.get("description")));
    product.put("sourceUrl", pick(p, "sourceUrl", card.get("sourceUrl")));
    product.put("sizeNote", sizeNote);
    product.put("color", pick(p, "color", card.get("color")));
    product.put("doorPart", doorPart);
    product.put("doorVerified", verified ? 1 : 0);
    product.put("doorSource", pick(p, "doorSource", card.get("doorSource")));
    product.put("declaredW", declared.get("w"));
    product.put("declaredD", declared.get("d"));
    product.put("declaredH", declared.get("h"));

    final Map<String, Object> model = new LinkedHashMap<>();
    model.put("thumbFile", thumb);
    model.put("envMode", pick(m, "envelopeMode", currentModel.get("envelopeMode")));
    // envelope_ok **不由请求决定**：写库后由 ProductWriteRepository.refreshEnvelope 用库里的
    // 声明尺寸与实测包围盒逐轴重算（1:1 相符=1 / 超差=0 / 无可核对数据=NULL）。这里不再透传。
    model.put("anisoOk", m.containsKey("anisotropyOk") ? m.get("anisotropyOk") : currentModel.get("anisotropyOk"));
    model.put("hingeNodesJson", hinge);

    try {
      if (!writer.editProduct(id, product, model, admin.actor())) {
        throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有 id=" + id + " 这款产品");
      }
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    final Map<String, Object> d = new LinkedHashMap<>();
    d.put("declared", declared);
    d.put("thumbFile", thumb);
    d.put("doorPart", doorPart);
    d.put("doorVerified", verified);
    audit.write(admin.actor(), "product.edit", "product", String.valueOf(id), Json.write(d, 0));

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("product", admin.productCard(id));
    return out;
  }

  /**
   * 删除产品（验收-2）：物理删除，子表依赖既有 FK CASCADE；不存在 404。
   */
  @DeleteMapping("/{id}")
  public Map<String, Object> deleteProduct(@PathVariable long id) {
    admin.requireMaintain();
    final Map<String, Object> card = admin.productCard(id);
    if (card == null) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有 id=" + id + " 这款产品");
    }
    final String name = ProductEdit.str(card.get("name"));
    if (!writer.deleteProduct(id)) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有 id=" + id + " 这款产品");
    }
    audit.write(admin.actor(), "product.delete", "product", String.valueOf(id),
        Json.write(Map.of("id", id, "name", name), 0));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("deleted", true);
    out.put("id", id);
    out.put("name", name);
    return out;
  }

  /**
   * 新增产品（R6-2 第二步）—— **一次事务写三张表**，落到 draft。
   *
   * 为什么必须落 draft：product.status 这一列的表默认值是 'active'，而此刻
   * 这个产品的 LOD 还没跑、缩略图还没渲 —— 让它在列表里冒充成品，是这一整套里最坏的一种错。
   * （把 'draft' 写死在 SQL 而不是做成参数，也在 ProductWriteRepository 里。）
   *
   * 请求体：{product:{...}, model:{...}, notes:[{kind,label,value,sortOrder}]}
   * 这里**不解析模型**：尺寸/门型是浏览器算好传上来的（后端不碰几何，理由见 upload 的注释）。
   */
  @PostMapping
  public Map<String, Object> create(@RequestBody Map<String, Object> body) {
    admin.requireMaintain();
    final Map<String, Object> product = asMap(body == null ? null : body.get("product"));
    // ⚠️ 刻意区分“缺 model”与“model 是空对象”：前者 = **人工代录**（本来就没有模型文件）。
    //    若一律用 asMap(null)（它会给一个空 Map），createProduct 会往 product_model 插一行
    //    **没有任何尺寸**的行 —— 一行看起来“有模型”实际不能用的数据（比没有行更坏）。
    final Map<String, Object> model =
        (body != null && body.get("model") instanceof Map) ? asMap(body.get("model")) : null;
    final List<Map<String, Object>> notes = asListOfMaps(body == null ? null : body.get("notes"));

    try {
      ProductDraft.validate(product, model);
    } catch (IllegalArgumentException e) {
      // 校验层一次攒齐了全部问题，原样带给界面 —— 只报第一个会让用户来回改十几遍
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    final long dbId;
    try {
      dbId = writer.createProduct(ProductDraft.productRow(product), model, notes,
          String.valueOf(admin.me().get("userId")));
    } catch (Exception e) {
      // 只有**我们自己抛的**话（校验/状态）对用户有意义。别的（空指针、SQL）用户做不了任何事，
      // 贴出来只会让他以为“是自己填错了” —— 实际是服务端的毛病（本轮真发生过：界面上写着
      // 「入库失败：Cannot invoke "java.util.Map.get(Object)" because "m" is null」）。
      // 细节进日志，界面只说清“不是你的问题 + 我们记下来了”。
      // ⚠️ 上面那句"细节已记进服务端日志"以前**是假的** —— 这个 catch 里一行日志都没有
      //    （第 2 轮审查 dev-4 的另一半）。话说到哪，就得真写到哪。
      log.error("入库失败（非校验类）：product.modelNo={}", product.get("modelNo"), e);
      final String hint = (e instanceof IllegalArgumentException || e instanceof IllegalStateException)
          ? "入库失败：" + e.getMessage()
          : "入库时服务端出错了（细节已记进服务端日志，请联系维护者）";
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, hint);
    }

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("dbId", dbId);
    out.put("dbIdUnit", "product.id（自增主键，不是目录 id）");   // 两个 id 不是一回事，名字里说清
    out.put("catalogId", ProductDraft.jsonId(String.valueOf(product.get("recipeJson"))));
    out.put("status", ProductWriteRepository.NEW_PRODUCT_STATUS);
    out.put("notesWritten", notes.size());
    out.put("modelWritten", model != null);   // 没有模型行 ≠ 没入库（人工代录就是这种）
    out.put("lodEnabled", lod.enabled());
    out.put("next", model == null
        ? "人工代录：**没有模型文件** —— 产品停在 draft、也不会发 LOD 作业；"
            + "前台仍能按声明尺寸摆它（列表上会有「无模型」角标）；等拿到 GLB 后在卡片上加一个变体"
        : (lod.enabled()
            ? "LOD 作业已在后台排队；跑成才转 active，在此之前它不进程目录，前台看不到"
            : "LOD 被配置关掉了（spatial.lod.enabled=false）：产品会一直停在 draft，等人工处理"));

    // 后台把 LOD 做出来 —— **不在请求线程里跑**（要几十秒）、**不在事务里跑**（别占着连接）
    if (model != null) {
      final String srcPath = String.valueOf(model.get("sourceFilePath"));
      final String variant = ProductDraft.variantOf(model);
      final String assetId = assetIdOf(product);
      final Long mid = writer.modelIdOf(dbId, variant);
      if (mid == null) {
        // 理论上到不了这里（刚刚才插进去）；真到了就**说出来**，不能让 LOD 静默不发
        throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR,
            "刚写入的变体「" + variant + "」找不到模型行 —— LOD 作业不会排队，需要人工查库");
      }
      lodPool.submit(() -> runLod(mid, dbId, variant, assetId, srcPath));
    }
    return out;
  }

  /**
   * 给**已有产品**加一个变体（R6-4 B5 · 决策④：换模型 = 新增 variant，**不覆盖**）。
   *
   * 为什么是“加一行”而不是“改那一行”：老方案里的几何是**自己存的**，但前台的型号卡
   * 是按 `default` 变体那份模型渲的 —— 覆盖它等于**悄悄换掉所有人正在看的那份模型**；
   * 加一行则两边都成立：老的那份一动不动，新的那份等它自己的 LOD 跑完再上岗。
   *
   * 请求体：{model:{variant, sourceFilePath, unit, bboxW/D/H, envelopeMode, hingeNodesJson, ...}}
   * （与 `POST /` 的 model 部分**同一套字段、同一套判据**——见 validateModelOnly）
   */
  @PostMapping("/{id}/variants")
  public Map<String, Object> addVariant(@PathVariable long id, @RequestBody Map<String, Object> body) {
    admin.requireMaintain();
    final Map<String, Object> model =
        (body != null && body.get("model") instanceof Map) ? asMap(body.get("model")) : null;
    if (model == null || model.isEmpty()) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
          "缺 model：加变体就是加一份模型；没有模型文件时走「人工代录」那条路（它不加变体）");
    }
    final String variant = ProductDraft.variantOf(model);

    // ① 产品必须在 —— 不在就 404 说清（让外键去拦的话，报错没人看得懂）
    final Map<String, Object> p = admin.product(id);
    if (p == null) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有 id=" + id + " 这款产品");
    }
    // ② 变体名不能重 —— 撞名时**把已有的说出来**，用户才知道该换个什么名字
    if (writer.variantExists(id, variant)) {
      throw new ResponseStatusException(HttpStatus.CONFLICT, "这款产品已经有变体「" + variant
          + "」（现有：" + String.join(" / ", writer.variantsOf(id))
          + "）—— 换一个名字：一种型号可以有多个变体（颜色/版本），但不允许同名");
    }
    // ③ 模型那一半的判据与“新增产品”共用（同一套写法：一次攒齐全部问题）
    try {
      ProductDraft.validateModelOnly(model);
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }

    final long modelId;
    try {
      modelId = writer.addVariant(id, model, String.valueOf(admin.me().get("userId")));
    } catch (Exception e) {
      throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "入库失败：" + e.getMessage());
    }

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("productId", id);
    out.put("modelId", modelId);   // 后台作业按它认行（回写不再按 product_id）
    out.put("variant", variant);
    out.put("isDefault", "default".equals(variant));
    out.put("lodEnabled", lod.enabled());
    out.put("next", "default".equals(variant)
        ? (lod.enabled() ? "这是默认变体：LOD 跑完它就接替前台看的那一份（老方案里的几何不受影响）"
                         : "LOD 被配置关掉了：这一版永远不会有产物文件，产品也停在 draft")
        : "这是非默认变体：前台仍只看 default 那一份（**老方案不受影响**），它自己跑完 LOD 才可用");

    final String srcPath = String.valueOf(model.get("sourceFilePath"));
    final String assetId = String.valueOf(p.get("recipe_id") == null ? "" : p.get("recipe_id"));
    lodPool.submit(() -> runLod(modelId, id, variant, assetId.isEmpty() ? "unknown" : assetId, srcPath));
    return out;
  }

  /**
   * 后台作业：跑 LOD，然后把结论写回库。
   *
   * ⚠️ 回写认的是**模型行 id**（`modelId`）—— 一个产品可以有多个变体（B5），
   * 按 product_id 回写会把别人那一行的产物路径覆盖掉（详细理由见 ProductWriteRepository）。
   *
   * 两条路都很明确：跑成 → 填产物并转 active；没跑成 → **留在 draft** 并把原因写进库。
   * 最坏的做法是"没跑成但看起来像跑成了"——所以这里无论成败都要留下痕迹。
   */
  private void runLod(long modelId, long productId, String variant, String assetId, String sourcePath) {
    try {
      final Path src = resolveUpload(sourcePath);
      if (src == null) {
        writer.failLod(modelId, "源模型路径认不出来：" + sourcePath + "（应当是 /api/assets/<sha256>.glb）");
        return;
      }
      final LodJob.Result r = lod.run(assetId, src);
      if (!r.ok()) {
        writer.failLod(modelId, r.reason());
        return;
      }
      final String md5 = LodJob.md5Of(src);      // 与存量同口径：checksum 存源级 md5（32 位十六进制）
      final ProductQuality.Gate gate =
          writer.finishLod(modelId, productId, r.entryFile(), r.entryBytes(), md5, r.levelsJson());
      if (gate.blocked()) {
        // 留在 draft 这件事已经由 repository 写进 lodError；这里再留一条日志，方便按行排查
        log.warn("LOD 产物已写，但质量闸门 BLOCK，产品留在 draft：modelId={} productId={} gate={}",
            modelId, productId, gate.summary());
      } else if (gate.warnCount() > 0) {
        log.info("LOD 完成，质量闸门 WARN（不挡上岗）：modelId={} productId={} gate={}",
            modelId, productId, gate.summary());
      }
    } catch (Exception e) {
      // 后台线程里抛异常会被静默吞掉 —— 必须自己接住并写进库，否则产品永远停在 draft 而没人知道为什么
      try {
        writer.failLod(modelId, "变体「" + variant + "」的 LOD 后台作业异常："
            + e.getClass().getSimpleName() + " " + e.getMessage());
      } catch (Exception also) {
        // 连**写库**都失败了 —— 这时只剩日志这一条路。原来这里写的是 `catch (Exception ignore)`，
        // 而整个 admin 包里一个 logger 都没有（第 2 轮审查 dev-4）：原因到这一层就被吃干净了。
        log.error("LOD 作业异常，且失败原因也写不进库：modelId={} productId={} variant={}",
            modelId, productId, variant, also);
      }
    }
  }

  /**
   * 把 /api/assets/<sha>.glb 反推回磁盘文件。
   *
   * 严格只认我们自己发出去的那种格式（64 位十六进制 + .glb）—— 这里绝不能接受任意路径，
   * 否则一个请求就能让后台去读机器上任何文件。
   */
  private Path resolveUpload(String url) {
    if (url == null) return null;
    final java.util.regex.Matcher m = ASSET_URL.matcher(url.strip());
    if (!m.matches()) return null;
    final Path f = uploadDir.resolve(m.group(1) + ".glb").normalize();
    if (!f.startsWith(uploadDir) || !Files.isRegularFile(f)) return null;
    return f;
  }

  /** 优化器的 --asset-id：用目录里的 assetId（产物就按它命名），缺了才退回目录 id。 */
  @SuppressWarnings("unchecked")
  private static String assetIdOf(Map<String, Object> product) {
    final String recipe = String.valueOf(product.get("recipeJson"));
    for (final String key : new String[] { "assetId", "id" }) {
      final String v = jsonStr(recipe, key);
      if (!v.isEmpty()) return v;
    }
    return "unknown";
  }

  /** 从目录 JSON 里取一个字符串字段。刻意用极小解析：这里只需要一个值，不值得引依赖。 */
  static String jsonStr(String json, String key) {
    final String q = String.valueOf((char) 34);   // 双引号：不在源码里写反斜杠（本环境会吃）
    final int i = json.indexOf(q + key + q);
    if (i < 0) return "";
    final int colon = json.indexOf(':', i);
    if (colon < 0) return "";
    int j = colon + 1;
    while (j < json.length() && Character.isWhitespace(json.charAt(j))) j++;
    if (j >= json.length() || json.charAt(j) != q.charAt(0)) return "";
    final int end = json.indexOf(q.charAt(0), j + 1);
    return end < 0 ? "" : json.substring(j + 1, end);
  }


  @SuppressWarnings("unchecked")
  private static Object pick(Map<String, Object> in, String key, Object fallback) {
    return in.containsKey(key) ? in.get(key) : fallback;
  }

  private static Map<String, Object> asMap(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> asListOfMaps(Object o) {
    if (!(o instanceof List)) return List.of();
    final List<Map<String, Object>> out = new java.util.ArrayList<>();
    for (final Object x : (List<Object>) o) {
      if (x instanceof Map) out.add((Map<String, Object>) x);
    }
    return out;
  }

  /**
   * 停用 / 启用一款产品（决策③：产品**只停用不删除**）。
   *
   * 这是 9 条拍板决策里**唯一一条此前没有承接方**的（第 2 轮审查 req-1）：读侧全就绪
   * （目录查询是 `WHERE status='active'`、列表带"已停用"档位与角标），但**没有任何路径会写
   * `status='disabled'`** —— 也就是说"已停用"那一档永远空着。
   *
   * ## 这件事必须在界面上说清的两句话
   * ① **前台目录 1 秒内就看不到它了**（`CatalogSource` 会重读库），已经打开的设计器不受影响；
   * ② **已存的方案与分享链接照常打开** —— 它们存的是几何快照，不查目录。
   *    这两句都得说：只说了①，用户会以为"停用 = 我把别人的链接搞坏了"；
   *    只说了②，用户会以为"停用 = 什么都没变"。
   *
   * 请求体：{status:'disabled'|'active', note:'...'}（note 只进留痕，不回显）
   */
  @PostMapping("/{id}/status")
  public Map<String, Object> setStatus(@PathVariable long id, @RequestBody(required = false) Map<String, Object> body) {
    admin.requireMaintain();
    // 读就绪的**卡片**（不是原始行）：下面 out.put("product", …) 要把同一形状还给界面
    final Map<String, Object> p = admin.productCard(id);
    if (p == null) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有 id=" + id + " 这款产品");
    }
    final String before = String.valueOf(p.get("status"));
    final String want;
    try {
      want = ProductWriteRepository.checkStatusWritable(
          body == null ? null : String.valueOf(body.get("status")));
    } catch (IllegalArgumentException e) {
      throw new ResponseStatusException(HttpStatus.BAD_REQUEST, e.getMessage());
    }
    final String actor = String.valueOf(admin.me().get("userId"));
    final String note = body == null || body.get("note") == null ? "" : String.valueOf(body.get("note")).trim();

    if (!writer.setStatus(id, want, actor)) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND, "没有 id=" + id + " 这款产品");
    }
    // 留痕：谁在什么时候把哪一款下线了，必须查得到（audit_log 只增不删）
    audit.write(actor, "product.status", "product", String.valueOf(id),
        Json.write(Json.obj("from", before, "to", want, "note", note), 0));

    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("id", id);
    out.put("from", before);
    out.put("status", want);
    out.put("changed", !before.equals(want));   // "本来就是启用的" —— 不假装改了
    out.put("catalogVisibleNote", "目录会在 1 秒内重读：前台型号卡即时多出/少掉这一款；已存方案与分享链接不受影响");
    // 把**最新**的那张卡片原样带回去（形状与列表里的那一条逐键相同），界面不用再取一次列表。
    // 必须重新装配：status 变了，badges 也跟着变。**不能回原始行** —— 界面拿它整条替换卡片，
    // 在 `p.badges` 上是 undefined，角标区会抛 TypeError（第 3 轮审查 C-15）。
    out.put("product", admin.productCard(id));
    return out;
  }

  /**
   * 质量闸门（QA 复核接口，只读）：逐轴读数 + BLOCK/WARN 明细。
   *
   * 为什么要有它：envelope_ok 是 1/0/NULL 三态，光看一个 0 分不清「哪一轴差多少」，
   * 也分不清「判为否」和「根本没法判」。这个接口把**判据本身**摊开给 QA 复核。
   */
  @GetMapping("/{id}/quality")
  public Map<String, Object> quality(@PathVariable long id) {
    admin.requireMaintain();
    final Long mid = writer.modelIdOf(id, "default");
    if (mid == null) {
      throw new ResponseStatusException(HttpStatus.NOT_FOUND,
          "没有 id=" + id + " 这款产品的默认变体（人工代录产品没有模型行，也就没有尺寸对账）");
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("productId", id);
    out.put("modelId", mid);
    out.put("gate", writer.gateOf(mid).toMap());
    final List<Map<String, Object>> rows = writer.envelopeInputs();
    for (final Map<String, Object> row : rows) {
      if (row.get("model_id") instanceof Number n && n.longValue() == mid) {
        out.put("envelopeMode", row.get("envelope_mode"));
        out.put("envelopeOk", row.get("envelope_ok"));
        out.put("axes", ProductQuality.envelopeAxes(row.get("declared_w"), row.get("declared_d"),
            row.get("declared_h"), row.get("bbox_w"), row.get("bbox_d"), row.get("bbox_h")));
        out.put("tolMm", ProductQuality.tolMm());
        break;
      }
    }
    return out;
  }

  /** 全部产品的对账现状（只读，QA 用来找「1:1 却 envelope_ok=NULL」这类缺口）。 */
  @GetMapping("/quality")
  public Map<String, Object> qualityAll() {
    admin.requireMaintain();
    final List<Object> items = new java.util.ArrayList<>();
    for (final Map<String, Object> row : writer.envelopeInputs()) {
      final Map<String, Object> one = new LinkedHashMap<>();
      one.put("productId", row.get("product_id"));
      one.put("modelNo", row.get("model_no"));
      one.put("variant", row.get("variant"));
      one.put("envelopeMode", row.get("envelope_mode"));
      one.put("envelopeOk", row.get("envelope_ok"));
      one.put("axes", ProductQuality.envelopeAxes(row.get("declared_w"), row.get("declared_d"),
          row.get("declared_h"), row.get("bbox_w"), row.get("bbox_d"), row.get("bbox_h")));
      items.add(one);
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("items", items);
    out.put("count", items.size());
    out.put("tolMm", ProductQuality.tolMm());
    return out;
  }

  /**
   * 按同一规则重算 envelope_ok 并写回（维护端显式触发，只改这一列）。
   *
   * 用途：批量导入/历史数据在**导入路径之外**落库时补一次对账。它不修声明尺寸、
   * 不判死 `envelope_ok=0`（0 是结论，原样保留）。注意：本任务**不调用**它，只提供入口。
   */
  @PostMapping("/quality/recheck")
  public Map<String, Object> qualityRecheck() {
    admin.requireMaintain();
    final int changed = writer.recheckEnvelopes();
    audit.write(admin.actor(), "product.quality.recheck", "product", "-",
        Json.write(Json.obj("changed", changed), 0));
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("changed", changed);
    out.put("tolMm", ProductQuality.tolMm());
    out.put("note", "只重算 envelope_ok（1/0/NULL）；声明尺寸与实测包围盒一个字节都不改");
    return out;
  }

  @GetMapping
  public Map<String, Object> list() {
    // 列表是**读**：viewer 也该看得见（看不见就没法判断"要不要改"）。
    // 门设在"进维护端"这一档，写动作才要更高的 maintain
    admin.requireEnterAdmin();
    final List<Map<String, Object>> items = admin.products();
    // ⚠️ 单位：**产品条数**，不是角标个数。一条产品可以带 3 个角标 —— "4" 到底是
    // 4 款还是 4 个，读的人一定会猜错。所以字段名里把单位写出来（badProducts / warnProducts），
    // 并且统一用"款"来数：一个产品只要有一个该级角标就计一次（warn 那里 break 掉）。
    int badProducts = 0;
    int warnProducts = 0;
    for (final Map<String, Object> x : items) {
      if (Boolean.TRUE.equals(x.get("hasBad"))) badProducts++;
      @SuppressWarnings("unchecked")
      final List<Map<String, Object>> bs = (List<Map<String, Object>>) x.get("badges");
      for (final Map<String, Object> b : bs == null ? List.<Map<String, Object>>of() : bs) {
        if (AdminBadges.WARN.equals(b.get("level"))) {
          warnProducts++;
          break;              // 一条产品只算一次，否则又变成在数角标
        }
      }
    }
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("count", items.size());
    out.put("unit", "products");       // 机器可读的"单位"：省的以后再有人猜
    out.put("badProducts", badProducts);
    out.put("warnProducts", warnProducts);
    out.put("store", admin.storeMode());
    // 来源词表随列表一起下发：**界面不抄这张表**（它只管把选项画出来；校验在后端）
    out.put("origins", ProductDraft.ORIGINS);
    out.put("manualOrigin", ProductDraft.ORIGIN_MANUAL);
    out.put("products", items);
    return out;
  }
}
