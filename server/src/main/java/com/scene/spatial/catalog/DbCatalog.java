package com.scene.spatial.catalog;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * DbCatalog —— 把 `product` / `product_model` / `product_note` 拼成**两种消费者要的形状**：
 *
 *   ① 前端运行时目录（`GET /api/catalog`）：米、facts/features 成行、模型文件与缩略图
 *   ② 内核 raw 目录（`Map<String,Object>`，与 `Cases.CATALOG` 同形）：`{w,d,h,doors}`
 *
 * 两者从**同一批行**推导，装配全是**静态纯函数**（不碰数据库、不看时间）—— 所以能直接断言。
 *
 * ## 为什么内核目录也必须来自库
 *
 * `Cases.CATALOG` 是**用例表内嵌的 3 款**，而目录里有 4 款。实测：`demo-freezer-upright`（立式低温保存箱系列）
 * 在库里存在、界面能摆放，服务端却报 `bad-item` —— **用户能摆、服务端不认**（保存直接被挡）。
 * 这正是 KernelConfig 注释里预留的那一步："上线后换成 product / product_model 两张表：
 * 内核不关心数据从哪来"。
 *
 * ## 口径（与 docs/27 一致）
 *
 *  - `w/d/h`（**占地口径**）= `recipe_json.w/d/h`（**声明包络**，库里存 mm）→ ÷1000 换成米。
 *    这是**唯一与界面一致**的来源：`app/src/data/catalog.js` 里 demo-freezer-dual=0.99 / demo-freezer-upright=0.70 /
 *    demo-freezer-chest=1.32 全部等于声明包络，而**实测包围盒**是另一回事（demo-freezer-dual 实测只有 525.5×517×990 mm，
 *    因为它是 `fit` 模型 —— 网格小、靠等比放大到包络）。刚才差点把这两个混成一个：
 *    混了以后"占地"会随模型网格大小变，而它与厂家规格无关。
 *  - `bboxMm` = `product_model.bbox_w/d/h`（**实测**）另放一个字段：校准/验收口径要它，
 *    占地不要它。两个口径分开存、分开用。
 *  - `doors` = `hinge_nodes`（**实测**，量出来的）；配方里声明的门在 `recipe_json.doors`。
 *    两者**不合并**：合并之后"供应商模型没按规范校准"就再也查不出来了。
 *  - 运行时 `id` 取 `recipe_json.id` —— recipe_json 的存在意义就是"前端拿到的运行时形状"（docs/27 §1）。
 */
@Service
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class DbCatalog {

  private static final Logger log = LoggerFactory.getLogger(DbCatalog.class);
  private static final ObjectMapper JSON = new ObjectMapper();

  private final CatalogRepository repo;
  private volatile Map<String, Object> cachedUi;
  private volatile Map<String, Object> cachedKernel;

  public DbCatalog(CatalogRepository repo) {
    this.repo = repo;
  }

  /** 目录变更后重读 —— 运维不该为了刷新一次目录重启进程 */
  public synchronized void evict() {
    cachedUi = null;
    cachedKernel = null;
  }

  public Map<String, Object> kernelRaw() {
    if (cachedKernel == null) refresh();
    return cachedKernel;
  }

  public Map<String, Object> uiPayload() {
    if (cachedUi == null) refresh();
    return cachedUi;
  }

  private synchronized void refresh() {
    if (cachedUi != null && cachedKernel != null) return;
    final List<Map<String, Object>> rows = repo.products();
    final Map<Object, List<Map<String, Object>>> notesByProduct = new LinkedHashMap<>();
    for (final Map<String, Object> n : repo.notes()) {
      notesByProduct.computeIfAbsent(n.get("product_id"), k -> new ArrayList<>()).add(n);
    }
    final List<Map<String, Object>> products = new ArrayList<>();
    final Map<String, Object> kernel = new LinkedHashMap<>();
    for (final Map<String, Object> r : rows) {
      final Map<String, Object> p = shapeProduct(r, notesByProduct.get(r.get("db_id")));
      if (p == null) continue;
      products.add(p);
      kernel.put((String) p.get("id"), kernelEntry(p));
    }
    cachedUi = Map.of("source", "db", "count", products.size(), "products", products);
    cachedKernel = Collections.unmodifiableMap(kernel);
    log.info("[catalog] 目录来自数据库：{} 款型号（内核可用 {} 款）", products.size(), kernel.size());
  }

  /** **纯函数**：一行产品 → 前端运行时目录的一条。数据不够就返回 null 并**响亮报警**（不静默跳过）。 */
  public static Map<String, Object> shapeProduct(Map<String, Object> r, List<Map<String, Object>> notes) {
    final String modelNo = s0(r.get("model_no"));
    final Map<String, Object> recipe = asMap(r.get("recipe_json"));
    final String id = recipe == null ? null : s0(recipe.get("id"));
    if (id.isBlank()) {
      log.warn("[catalog] {} 的 recipe_json 里没有 id —— 跳过（运行时 id 就在 recipe_json.id）", modelNo);
      return null;
    }
    // 占地用**声明包络**（recipe_json），不是实测包围盒 —— 见类注释
    final Double w = recipe == null ? null : num(recipe.get("w"));
    final Double d = recipe == null ? null : num(recipe.get("d"));
    final Double h = recipe == null ? null : num(recipe.get("h"));
    if (w == null || d == null) {
      log.warn("[catalog] {} 的 recipe_json 里没有声明包络（w/d）—— 跳过：没有占地就没法摆", modelNo);
      return null;
    }
    final String thumb = s0(r.get("thumb_file"));
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("id", id);
    p.put("dbId", r.get("db_id"));
    p.put("model", modelNo);
    p.put("name", s0(r.get("name")));
    p.put("series", s0(r.get("series")));
    p.put("w", w / 1000.0);   // 库里是 mm（实测）—— 界面用米
    p.put("d", d / 1000.0);
    p.put("h", h == null ? null : h / 1000.0);
    p.put("color", s0(r.get("color")));
    p.put("origin", s0(r.get("origin")));
    p.put("sizeNote", s0(r.get("size_note")));
    // 门部件名是**产品事实**（一列），不从门几何推：demo-freezer-dual 是"双门"，而它的实测门只有 1 扇
    final String doorPart = s0(r.get("door_part"));
    if (doorPart.isBlank()) {
      log.warn("[catalog] {} 没有 door_part —— 界面会退回几何推导，而推导对多门产品是会错的", modelNo);
    }
    p.put("doorPart", doorPart);
    p.put("desc", s0(r.get("description")));
    p.put("sourceUrl", r.get("source_url"));
    p.put("variant", s0(r.get("variant")));
    p.put("file", s0(r.get("file_path")));
    p.put("sourceFile", s0(r.get("source_file_path")));
    p.put("envelopeMode", s0(r.get("envelope_mode")));
    p.put("thumbFile", thumb);
    p.put("thumbUrl", thumb.isBlank() ? null : "/" + thumb);
    p.put("modelMd5", lodMd5(r.get("lod_json")));
    final Map<String, Object> bbox = new LinkedHashMap<>();
    bbox.put("w", num(r.get("bbox_w")));
    bbox.put("d", num(r.get("bbox_d")));
    bbox.put("h", num(r.get("bbox_h")));
    p.put("bboxMm", bbox);   // 实测包围盒（校准口径）—— 与上面的声明包络分开
    p.put("doors", asList(r.get("hinge_nodes")));                                       // 实测
    p.put("recipeDoors", recipe == null ? List.of() : asListView(recipe.get("doors")));  // 声明
    p.put("notes", shapeNotes(notes));
    // docs/105 §6.1：目录只加摘要，不返回正文/热点；旧产品 hotspotCount=0、contentRev=0
    final int publishedRev = int0(r.get("content_published_rev"));
    p.put("hotspotCount", int0(r.get("content_hotspot_count")));
    p.put("hasDetail", publishedRev > 0 || !s0(r.get("description")).isEmpty());
    p.put("contentRev", publishedRev);
    return p;
  }

  /**
   * 说明条目（`product_note` 的**第一个消费方**）：按 kind 分成 facts / features，
   * 形状与前端既有目录一致（`[[label, value], ...]`）—— 这样适配层不用做第二次搬运。
   */
  public static Map<String, Object> shapeNotes(List<Map<String, Object>> notes) {
    final List<Object> facts = new ArrayList<>();
    final List<Object> features = new ArrayList<>();
    if (notes != null) {
      for (final Map<String, Object> n : notes) {
        final List<String> row = List.of(s0(n.get("label")), s0(n.get("value")));
        if ("feature".equals(s0(n.get("kind")))) features.add(row);
        else facts.add(row);
      }
    }
    return Map.of("facts", facts, "features", features);
  }

  /**
   * 内核要的 raw 条目：与 `Cases.CATALOG` 同形（w/d/h 米 + doors）。
   *
   * ## 门的两个口径，谁进内核
   *
   * 优先 `doors`（= `product_model.hinge_nodes`，**实测**）。没有模型行（演示机型里 4 款
   * 只有配方、没有 GLB）时退回 `recipeDoors`（= `recipe_json.doors`，**声明**）——
   * 不退回的话，这些机型在运行时内核里"一扇门都没有"，门净空判据会整片失败：
   * 实测过一次，`demo-cabinet-800` 缺退回分支时有 7 条 `door-clearance-*` 失败。
   *
   * 两个口径**不合并**：`doors` 留着实测值、`recipeDoors` 留着声明值，
   * 这里只是"内核该拿哪一份"，并用 `doorsSource` 把结论的出处一并带出去 ——
   * 「这条净空是拿实测门算的、还是拿声明门算的」必须能回答。
   */
  public static Map<String, Object> kernelEntry(Map<String, Object> p) {
    final Map<String, Object> e = new LinkedHashMap<>();
    e.put("w", p.get("w"));
    e.put("d", p.get("d"));
    e.put("h", p.get("h"));
    final List<?> measured = p.get("doors") instanceof List<?> l ? l : List.of();
    final List<?> declared = p.get("recipeDoors") instanceof List<?> l ? l : List.of();
    final boolean useMeasured = !measured.isEmpty();
    e.put("doors", useMeasured ? measured : declared);
    e.put("doorsSource", useMeasured ? "measured" : (declared.isEmpty() ? "none" : "declared"));
    return e;
  }

  private static String s0(Object o) {
    return o == null ? "" : String.valueOf(o);
  }

  private static int int0(Object o) {
    if (o instanceof Number n) return n.intValue();
    if (o == null) return 0;
    try {
      return Integer.parseInt(String.valueOf(o).trim());
    } catch (NumberFormatException e) {
      return 0;
    }
  }

  private static Double num(Object o) {
    return o instanceof Number n ? n.doubleValue() : null;
  }

  private static Map<String, Object> asMap(Object json) {
    if (!(json instanceof String s) || s.isBlank()) return null;
    try {
      return JSON.readValue(s, new TypeReference<Map<String, Object>>() {});
    } catch (Exception e) {
      log.warn("[catalog] JSON 解析失败：{}", e.getMessage());
      return null;
    }
  }

  /**
   * 取**已经解析好的** List（`recipe_json` 是解析过的对象，不是字符串）。
   * 别拿它当 {@link #asList} 用 —— 单测抓过这个错：传对象进去会静默返回空表，
   * 后果是"配方里声明的门全丢了"，而界面上只表现为 3D 门绑不上（很难查）。
   */
  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> asListView(Object v) {
    return v instanceof List<?> list ? (List<Map<String, Object>>) list : List.of();
  }

  private static List<Map<String, Object>> asList(Object json) {
    if (!(json instanceof String s) || s.isBlank()) return List.of();
    try {
      return JSON.readValue(s, new TypeReference<List<Map<String, Object>>>() {});
    } catch (Exception e) {
      log.warn("[catalog] 门数据解析失败：{}", e.getMessage());
      return List.of();
    }
  }

  /** 缩略图缓存的键 = 第一级 LOD 的 md5：**内容寻址**，模型一换键就变，缓存自动失效 */
  private static String lodMd5(Object lodJson) {
    final Map<String, Object> l = asMap(lodJson);
    if (l == null) return null;
    final Object levels = l.get("levels");
    if (!(levels instanceof List<?> list) || list.isEmpty()) return null;
    return list.get(0) instanceof Map<?, ?> m ? s0(m.get("md5")) : null;
  }
}
