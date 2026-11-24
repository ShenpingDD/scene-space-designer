package com.scene.spatial.admin;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * ProductDraft -- 向导传上来的 payload → 落库要的形状(R6-2)
 *
 * 为什么单独立一个类、而且**全是静态纯函数**:同一个 payload 在任何环境下都必须得到
 * 同一个结论。校验(缺什么、哪里不对)和组装(recipe_json / lod_json)都是纯变换,
 * 不需要数据库就能断言 -- 而"不合法的新增请求"恰恰是最该被断言的东西
 * (它跑到生产上就是一行烂数据)。
 */
public final class ProductDraft {

  private ProductDraft() {}

  /** 目录 id 必须是 ASCII slug：它会进 URL、进文件名、进缓存键，带中文/空格迟早出事。 */
  private static final Pattern SLUG = Pattern.compile("[a-z0-9][a-z0-9_-]{0,31}");

  /** 变体名同一条纪律：它会进产物文件名、URL、日志（`default` / `v2` / `black` 都合法）。 */
  private static final Pattern VARIANT = Pattern.compile("[a-z0-9][a-z0-9._-]{0,31}");

  // ── 来源（product.origin）的词表 ────────────────────────────────────────
  //
  // 这一列 V1 就有，一直是自由文本 —— 但“自由文本”不等于“随便写”：
  // 它是判断**这份数据可不可信**的第一手依据（PROGRESS 决策⑨：供应商没按规范交 →
  // 人工代录 + `origin` 留痕）。**只有第一项是“供应商/用户按规范交的”**，其余都是人凑的。
  public static final String ORIGIN_SUPPLIER = "用户原始模型";
  public static final String ORIGIN_SITE_REBUILD = "官网外观重建";
  public static final String ORIGIN_SITE_SERIES = "官网系列外形";
  /** 连模型都没有，只有人从图册/规格表抄下来的尺寸 —— 走“先录一条”（见 noModelBad） */
  public static final String ORIGIN_MANUAL = "人工代录";
  /** 维护端新增（没写来源时的兜底）—— 它同样**不是**供应商交的，不许当实测 */
  public static final String ORIGIN_ADMIN_ADDED = "维护端新增";

  /** 词表：界面按它出选项（**选项与校验用同一个列表**，不允许界面自己再抄一份）。 */
  public static final List<String> ORIGINS =
      List.of(ORIGIN_SUPPLIER, ORIGIN_SITE_REBUILD, ORIGIN_SITE_SERIES, ORIGIN_MANUAL, ORIGIN_ADMIN_ADDED);

  /**
   * 这一条是不是“人凑的”（= 不是供应商按规范交的）。
   *
   * 判断**放在这里**（而不是让界面自己比字符串）：界面零业务判断，它只负责把结论写成一句人话。
   */
  public static boolean originIsManual(Object origin) {
    final String s = str(origin);
    return !s.isEmpty() && !ORIGIN_SUPPLIER.equals(s);
  }

  /**
   * 模型行的变体名：没写就是 `default`。**唯一出处** ——
   * 落库、后台作业、接口回执都读它，不允许各自再写一遍默认值。
   */
  public static String variantOf(Map<String, Object> model) {
    final String v = str(model == null ? null : model.get("variant"));
    return v.isEmpty() ? "default" : v;
  }

  /** 变体名校验（合法就原样返回，省得调用方再取一次）。 */
  public static String validateVariant(String variant) {
    final String v = str(variant);
    if (v.isEmpty()) {
      throw new IllegalArgumentException("变体名不能为空 —— 它是这一份模型在主数据里的名字（如 v2 / black）");
    }
    if (!VARIANT.matcher(v).matches()) {
      throw new IllegalArgumentException("变体名只能是 a-z0-9._- 组成的短串（收到：" + v
          + "）—— 它会进产物文件名与 URL；建议 v2 / black 这种写法");
    }
    return v;
  }

  /**
   * 校验。**一次把所有问题都报出来** -- 只报第一个的话,用户得来回改十几遍。
   *
   * @throws IllegalArgumentException 消息里逐条列出问题
   */
  /** `model` 为空 = **人工代录**（没有模型文件），走 noModelBad 那一套更严的判据。 */
  public static void validate(Map<String, Object> product, Map<String, Object> model) {
    final List<String> bad = new java.util.ArrayList<>();
    productBad(product, bad);
    if (model == null || model.isEmpty()) {
      noModelBad(product, bad);
    } else {
      modelBad(model, bad);
      // 有模型也要两件事——它们不是「代录才需要」的补丁，而是 1:1 尺寸对账的两个前提：
      //   ① 声明三轴（recipe_json 的 w/d/h）是**对账的另一半**，缺了 envelope_ok 只能 NULL；
      //   ② size_note 说明这些声明数字从哪来、可信到什么程度，缺了就是「没人负责」。
      // 旧版本只卡代录这一路，于是演示产品带着 1:1 + NULL 混进了库（用户 22:18 记录的缺陷）。
      sizeNoteBad(product, bad);
      dimsBad(product, bad, "声明尺寸是 1:1 尺寸对账与占地轮廓的依据");
    }

    if (!bad.isEmpty()) {
      // 刻意不用换行转义：本仓库的构建环境会把源码里的换行转义变成**真换行**，
      // 于是这句被断成三行、字符串没闭合（这一批就踩了）。全角分号读起来更顺，也不惹这个麻烦。
      throw new IllegalArgumentException("新增产品被拒，共 " + bad.size() + " 条；" + String.join("；", bad));
    }
  }

  /**
   * 只校验**模型那一半**（“加一个变体”走这里）。
   *
   * 为什么单开一个入口：产品行是现成的，重复校验它只会把“产品没问题”当成“这个变体没问题”——
   * 两件事分开报，用户才知道该改哪一半。
   */
  public static void validateModelOnly(Map<String, Object> model) {
    final List<String> bad = new java.util.ArrayList<>();
    modelBad(model, bad);
    if (!bad.isEmpty()) {
      throw new IllegalArgumentException("加变体被拒，共 " + bad.size() + " 条；" + String.join("；", bad));
    }
  }

  /** 产品那一半：型号 / 名称 / 目录 id（它住在 recipe_json.id，不在产品表的任何一列）。 */
  private static void productBad(Map<String, Object> product, List<String> bad) {

    need(product, "modelNo", "型号（model_no）—— 目录、前台、交付包都靠它认人", bad);
    need(product, "name", "名称", bad);

    // ⚠️ 踩过的坑:**目录 id 住在 recipe_json.id**,不在 product 表的任何一列里。
    //    上一批做数据迁移时就拿它去对 model_no,结果 WHERE 永远不命中(Flyway 照样 success=1)。
    final String recipe = str(product.get("recipeJson"));
    if (recipe.isEmpty()) {
      // 报错要把**两个名字都说出来**:填表的人认 payload 字段名,查库的人认列名。
      // 只说一个的话,总有一半人得猜。
      bad.add("缺 recipeJson(库里的 recipe_json 列):它就是前台的目录条目,没有它前台根本不认这款产品");
    } else {
      final String rid = jsonId(recipe);
      if (rid.isEmpty()) {
        bad.add("recipeJson(库里的 recipe_json 列)里没有 id -- 目录 id 必须放在 recipe_json.id,它不是产品表的任何一列");
      } else if (!SLUG.matcher(rid).matches()) {
        bad.add("目录 id 只能是 a-z0-9_- 组成的短串(收到:" + rid + ")-- 它会进 URL 与缓存键");
      }
    }

  }

  /**
   * 没有模型文件的那一条路（人工代录）。
   *
   * 它比“有模型”**更该被卡**：一没有 GLB 可量、二尺寸是抄来的。所以这里额外要两件事 ——
   * ① 来源必须明写「人工代录」（否则库里分不清“还没跑完 LOD”和“本来就没有模型”）；
   * ② 尺寸可信度必须人自己说（没有实测包围盒可对账，`size_note` 空着就只能靠猜）。
   */
  private static void noModelBad(Map<String, Object> product, List<String> bad) {
    final String origin = str(product.get("origin"));
    if (!ORIGIN_MANUAL.equals(origin)) {
      bad.add("没有模型文件时 origin（库里的 origin 列）必须写「" + ORIGIN_MANUAL + "」（收到："
          + (origin.isEmpty() ? "(空)" : origin) + "）—— 否则库里分不清「LOD 还没跑完」和「本来就没有模型」");
    }
    sizeNoteBad(product, bad);
    dimsBad(product, bad, "没有模型文件时，占地只能靠它");
  }

  /** 尺寸说明：有模型 / 没有模型都要写，只是理由不同（见两处调用点的 why）。 */
  private static void sizeNoteBad(Map<String, Object> product, List<String> bad) {
    if (str(product.get("sizeNote")).isEmpty()) {
      bad.add("缺 sizeNote（库里的 size_note 列）：尺寸是从哪来的、可信到什么程度**必须人自己写**，"
          + "不许留空 —— 没有它就分不清「声明尺寸是实测还是估读」");
    }
  }

  /** 声明包络（recipe_json 的 w/d/h）在不在 —— 缺了既摆不进方案，也无从对账 */
  private static void dimsBad(Map<String, Object> product, List<String> bad, String why) {
    final String recipe = str(product.get("recipeJson"));
    if (recipe.isEmpty()) {
      bad.add("缺 recipeJson：前台目录条目就在它里面（声明尺寸 w/d/h 也在里面）");
      return;
    }
    for (final String k : List.of("w", "d", "h")) {
      if (numOf(recipe, k) == null) {
        bad.add("recipeJson 里缺 " + k + "（声明尺寸，单位 mm）—— " + why);
      }
    }
  }

  /** 从 recipe_json 文本里取一个数字字段（`"w": 990`）。刻意用极小解析：这里只要三个数。 */
  static Double numOf(String json, String key) {
    final java.util.regex.Matcher m = java.util.regex.Pattern
        .compile(String.valueOf((char) 34) + key + String.valueOf((char) 34) + "[ \\t]*:[ \\t]*(-?[0-9.]+)")
        .matcher(json);
    if (!m.find()) return null;
    try {
      return Double.valueOf(m.group(1));
    } catch (NumberFormatException e) {
      return null;
    }
  }

  /** 模型那一半（源文件路径 / 单位 / 实测包围盒）—— 新增产品与“加一个变体”**共用同一套判据**。 */
  private static void modelBad(Map<String, Object> model, List<String> bad) {

    // 变体名要在**写库之前**拦住：它在 product_model 上有唯一键，让数据库去抛的话
    // 用户看到的是一句 SQL 报错（“Duplicate entry '7-v2' for key...”），没人知道该怎么办。
    // ⚠️ 但**没写变体名是合法的**（落库会给它 `default`，见 variantOf）——
    //    “没写”和“写了个错的”是两件事，校验不许比落库更严（这一版就踩了，ProductDraftTest 当场抓到）。
    final String variant = str(model.get("variant"));
    if (!variant.isEmpty()) {
      try {
        validateVariant(variant);
      } catch (IllegalArgumentException e) {
        bad.add(e.getMessage());
      }
    }

    need(model, "sourceFilePath", "源模型路径 —— 没有它，优化器无从下手", bad);
    if (str(model.get("unit")).isEmpty()) {
      bad.add("缺 unit:分析器给的是 mm,落到别的单位说明中间被谁改过");
    } else if (!"mm".equals(str(model.get("unit")))) {
      bad.add("unit 必须是 mm(收到:" + model.get("unit") + ")-- 场景里全部几何按 mm 换算");
    }
    for (final String k : List.of("bboxW", "bboxD", "bboxH")) {
      if (model.get(k) == null) {
        bad.add("缺 " + k + ":实测包围盒是「占地轮廓」与「尺寸对账」的依据");
      }
    }

  }

  /** 拼落库用的产品行：把 envelope_mode 这类“可以由人覆盖，但必须有默认”的字段补齐。 */
  public static Map<String, Object> productRow(Map<String, Object> in) {
    final Map<String, Object> out = new LinkedHashMap<>(in);
    out.putIfAbsent("origin", ORIGIN_ADMIN_ADDED);
    out.putIfAbsent("sizeNote", "待核实");
    out.putIfAbsent("doorSource", "manual");     // 新增由人确认 → 这一列如实写 manual,不要冒充 auto
    out.putIfAbsent("sortOrder", nextSortHint());
    return out;
  }

  /** 新产品的排序:放在最后(999),由人在维护端里再调 -- 猜一个"看起来合适"的位置只会让人找不到它。 */
  private static int nextSortHint() { return 999; }

  private static void need(Map<String, Object> m, String key, String why, List<String> bad) {
    if (m == null || str(m.get(key)).isEmpty()) bad.add("缺 " + key + ":" + why);
  }

  /** 从 recipe_json 里取 id。刻意用极小的手写解析而不是引入依赖:这里只需要一个字符串字段。 */
  static String jsonId(String recipeJson) {
    final int i = recipeJson.indexOf("\"id\"");
    if (i < 0) return "";
    final int colon = recipeJson.indexOf(':', i);
    if (colon < 0) return "";
    int j = colon + 1;
    while (j < recipeJson.length() && Character.isWhitespace(recipeJson.charAt(j))) j++;
    if (j >= recipeJson.length() || recipeJson.charAt(j) != '"') return "";
    final int end = recipeJson.indexOf('"', j + 1);
    return end < 0 ? "" : recipeJson.substring(j + 1, end);
  }

  private static String str(Object o) { return o == null ? "" : String.valueOf(o).trim(); }
}
