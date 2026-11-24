package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Scheme.java —— 规则 5：方案文件格式（墙 = 对象那一代）导出 / 导入 / 校验
 *
 * 移植自 `spatial-core/src/scheme.js`（原型 `$('save').onclick` 与 `$('file').onchange`）。
 * 这是 R1 修得最重的一块（**FIX-05「导出即丢数据」**）：**写入端与读取端必须共用同一套限制**，
 * 否则会重演"自己导出的文件自己导不回来"。在 Java 侧同样只有这一份限制（`limitXxx()`）。
 *
 * ## W1 门洞：格式标识换代（与 JS `scheme.js` 逐字同口径）
 *
 * 墙从 `[x1,z1,x2,z2]` 升成对象 `{a,b,openings}`。标识因此**换代**：
 * `scene-space-designer`（数组那一代）降为**只读历史**，与三个 `demo-*` 并排保留。
 * 两条规矩照旧（`docs/31` 的先例）：新标识**不带版本后缀**；**读取端宽容、写入端唯一**。
 *
 * ⚠️ `stateOf` 是**字段白名单**：它只发射它认识的字段。门洞/动线/柱（以及任何新字段）如果忘了加，
 * 会在"保存 → 分享 → 交付"链上**无警告消失** —— 这正是 FIX-05 的病因，所以用例表里有一条
 * `scheme-roundtrip-openings` 逐字盯它。
 *
 * 与原型唯一的差异（纯增强，FIX-21）：导入失败返回**分类原因**，
 * 让界面能说清"到底哪里不对"，而不是 4 类失败共用一句话。
 *
 * ⚠️ 检查顺序是判据的一部分：设备条数 → 墙体数组 → 墙体条数 → 设备逐台 → 编号重复 → 墙体逐面。
 *    顺序一改，用例 `scheme-typed-errors` 里那条"101 面墙"就可能被别的错误先拦下，报出另一个原因码。
 */
public final class Scheme {

  private Scheme() {
  }

  /**
   * W4（人员地面动线）这一代的标识。`state.routes` 是加法字段，换代理由与 W2/W3 同一条：
   * **让老构建响亮地拒绝，而不是把动线静默丢掉**（老构建保存一次就会抹掉设计师点好的站点）。
   */
  public static final String FORMAT = "scene-space-designer-scene-routes-columns";

  /**
   * W4 那一代（人员地面动线）：只读历史，但**语义仍是 `walls`**。
   *
   * 换代后不能继续拿"当前 FORMAT"当 W4 —— `FORMAT` 已经指向 W5 了；
   * 这张字面量是 `WALLS_SEMANTICS_FORMATS` 的一部分，漏了会让 W4 方案重开时退回 `legacy`。
   */
  public static final String W4_FORMAT = "scene-space-designer-scene-routes";

  /**
   * W3 那一代（开放场景）：只读历史，但**语义仍是 `walls`** —— 它正是开放场景口径的起点。
   * 只按"等于 FORMAT 吗"判断语义，会让已有开放场景方案重开时退回 legacy：
   * 院子被算回房间、开放面积变 0，而用户什么都没改（docs/97 §四点名的坑）。
   */
  public static final String W3_FORMAT = "scene-space-designer-scene";

  /** 必须继续兼容的历史格式（用户手里已有这些文件） */
  public static final List<String> ACCEPTED_FORMATS = List.of(
      FORMAT,
      W4_FORMAT,                       // W4 动线：只读历史，语义仍是 `walls`
      W3_FORMAT,                       // W3 开放场景：只读历史，语义仍是 `walls`
      "scene-space-designer-windows",  // W2 那一代：窗（`kind`/`sill`），房间按矩形外框兜底
      "scene-space-designer-openings", // W1 那一代：洞口只有门（没有 `kind`/`sill`）
      "scene-space-designer",        // W1 之前那一代：墙是扁平数组 [x1,z1,x2,z2]
      "legacy-spatial-v2",
      "legacy-spatial-v3",
      "legacy-spatial-doors-v4");

  /**
   * 房间语义是 `walls` 的格式标识（与 JS `WALLS_SEMANTICS_FORMATS` 同一张表、同一顺序）：
   * 当前代 + W4 + W3。**换代时只改 FORMAT 不加这张表 = 旧方案房间口径静默回退**。
   */
  public static final List<String> WALLS_SEMANTICS_FORMATS = List.of(FORMAT, W4_FORMAT, W3_FORMAT);

  /**
   * 格式标识 → 房间派生语义（与 JS `scheme.js roomSemanticsOfFormat()` 同一条判据）：
   * W4 / W3 是 `walls`（房间只取"边界全部由墙组成"的面，其余是开放场景）；
   * 其余全部是只读历史 → `legacy`（矩形外框参与闭合，**旧方案房间数不许变**）。
   */
  public static String semanticsOf(String format) {
    return WALLS_SEMANTICS_FORMATS.contains(format) ? Layout.SEMANTICS_WALLS : Layout.SEMANTICS_LEGACY;
  }

  // 限制一律用方法：配置值可被后台改，写成常量会在类初始化时被"抄"死（JS 侧同款纪律）
  public static int limitFileBytes() {
    return ParamsLive.p().schemeMaxFileBytes;
  }

  public static int limitItems() {
    return ParamsLive.p().layoutMaxItems;
  }

  public static int limitWalls() {
    return ParamsLive.p().layoutMaxWalls;
  }

  public static int limitCoordM() {
    return ParamsLive.p().schemeMaxCoordM;
  }

  public static double limitMinWallLengthM() {
    return ParamsLive.p().schemeMinWallLengthM;
  }

  public static double[][] roomLimit() {
    return Room.roomLimits();
  }

  /** 导入失败原因（FIX-21） */
  public record Error(String reason, String message) {
  }

  public static final Error NOT_JSON = new Error("not-json", "无法导入：文件不是有效的 JSON");
  public static final Error BAD_FORMAT = new Error("bad-format", "无法导入：不是本应用的方案文件（格式标识不符）");
  public static final Error BAD_ITEM = new Error("bad-item", "无法导入：设备数据不合法（型号、编号、坐标或角度异常）");
  public static final Error DUP_ID = new Error("duplicate-id", "无法导入：设备编号重复");
  public static final Error GENERIC = new Error("invalid", "无法导入：请使用本应用导出的有效方案文件");

  public static Error badRoom() {
    return new Error("bad-room", "无法导入：空间尺寸超出范围（" + Room.roomRangeText() + "）");
  }

  public static Error tooManyItems() {
    return new Error("too-many-items", "无法导入：设备数量超过上限（" + limitItems() + " 台）");
  }

  public static Error tooManyWalls() {
    return new Error("too-many-walls", "无法导入：墙体数量超过上限（" + limitWalls() + " 面）");
  }

  /** B19：墙落在空间之外。与 JS `IMPORT_ERROR.WALL_OUT_OF_ROOM` 同一句话 */
  public static Error wallOutOfRoom() {
    return new Error("wall-out-of-room", "无法导入：有墙体落在空间之外");
  }

  public static Error badWall() {
    return new Error("bad-wall", "无法导入：墙体数据不合法（两点之间的直墙，长度 ≥" + limitMinWallLengthM() + " m）");
  }

  /** W1 门洞：与 JS `IMPORT_ERROR.BAD_OPENING` 同一句话 */
  public static Error badOpening() {
    return new Error("bad-opening", "无法导入：门洞数据不合法（洞口跑到墙外、比墙高、或两个洞重叠）");
  }

  /**
   * W4 动线（docs/97 §四）：**结构**不对就整份拒绝，不静默跳过 ——
   * 静默丢一条动线，等于用户画好的参观路线在一次保存之后消失了，而且没有任何提示。
   * 四个原因码与 JS `IMPORT_ERROR.*` 同名同句（界面按 reason 分类说话）。
   */
  public static Error badRoute() {
    return new Error("bad-route", "无法导入：动线数据不合法（每条动线需要 2–20 个 [x,z] 点，id 为不重复的正整数）");
  }

  public static Error duplicateRouteId() {
    return new Error("duplicate-route-id", "无法导入：动线编号重复");
  }

  public static Error tooManyRoutes() {
    return new Error("too-many-routes", "无法导入：动线数量超过上限（" + MAX_ROUTES + " 条）");
  }

  public static Error routeOutOfRoom() {
    return new Error("route-out-of-room", "无法导入：有动线的点落在场景之外");
  }

  /**
   * W5 柱（docs/101 §2.3）：六个原因码与 JS `columns.js` 同名同句。
   * 文案**不加「无法导入」前缀**：`column-out-of-scene` 等码在交互落笔时也要显示，
   * 同一句两处用，避免"导入说一套、画布说另一套"（docs/101 §2.3）。
   */
  public static Error badColumn() {
    return new Error("bad-column", "柱数据不合法（每条柱需要 id 与 x/z/w/d）");
  }

  public static Error duplicateColumnId() {
    return new Error("duplicate-column-id", "柱编号重复");
  }

  public static Error columnOutOfScene() {
    return new Error("column-out-of-scene", "柱必须完整在场景内");
  }

  public static Error columnTooSmall() {
    return new Error("column-too-small", "柱边长小于下限（" + COLUMN_MIN_SIDE_M + " m）");
  }

  public static Error columnTooLarge() {
    return new Error("column-too-large",
        "柱边长超过上限（" + String.format(java.util.Locale.ROOT, "%.2f", COLUMN_MAX_SIDE_M) + " m）");
  }

  public static Error tooManyColumns() {
    return new Error("too-many-columns", "柱数量超过上限（" + MAX_COLUMNS + " 根）");
  }

  /**
   * 柱的参数默认值（docs/101 §2.3 / docs/99 §8.2），直接取生成物 `Params`
   * （来源 `config/params.default.json` 的 `column.*`，由 `tools/server/gen-java-data.mjs` 生成）：
   * `minSideM=0.2`、`maxSideM=3`、`maxCount=50`、`defaultSideM=0.5`。
   *
   * ⚠️ JS 侧读 `cfg.column.*`（后台可改），这里读的是**编译期默认基线** —— 与 `MAX_ROUTES`
   * 的过渡写法同一条纪律：不手抄第二个数。等 `ParamsLive` 接上 `column.*` 后再改成活值。
   */
  public static final int MAX_COLUMNS = Params.columnMaxCount;
  public static final double COLUMN_MIN_SIDE_M = Params.columnMinSideM;
  public static final double COLUMN_MAX_SIDE_M = Params.columnMaxSideM;
  /** 柱的四角容差：与外墙/动线同一条纪律 */
  private static final double COLUMN_EPS = 1e-6;

  /**
   * 动线上限（v1 冻结：6 条 × 20 点，docs/97 §四）。
   *
   * ⚠️ JS 侧读 `cfg.route.maxRoutes/maxPoints`（后台可改），Java 侧**目前没有这两个参数项**
   * （`config/params.default.json` 里还没有 route.*，ParamsLive 也没有）—— 因此这里写成常量。
   * 两边数值一致由用例与测试钉；等 route.* 进参数表时，这里改成 `ParamsLive` 读法即可。
   */
  public static final int MAX_ROUTES = 6;
  public static final int MAX_ROUTE_POINTS = 20;

  /** 单条动线的点位容差：与外墙容差同一条纪律（UI 算出的 8.000000000000002 不该让方案打不开） */
  private static final double ROUTE_EPS = 1e-6;

  /**
   * 一面墙 → JSON（字段顺序 `a` / `b` / `openings` / `role`，与 JS `scheme.js wallForFile()` 一致
   * —— 顺序也是逐字节比对的一部分）。
   *
   * ⚠️ `role` 是**有值才写**：旧墙（没有角色）导出字节必须逐字不变；
   *    写端的合法值只有 `exterior` / `interior`（`Wall.readRole` 认不得的一律当没写）。
   *    漏了这一句，角色会在「保存 → 分享 → 交付」链上无警告消失 —— 与 `openings`/`roomLabels`
   *    同一种 FIX-05 形状，用例 `scheme-roundtrip-wall-role` 就是盯它的。
   */
  public static Map<String, Object> wallJson(Wall w) {
    final Map<String, Object> m = Json.obj("a", Json.arr(w.a[0], w.a[1]), "b", Json.arr(w.b[0], w.b[1]));
    if (!w.openings.isEmpty()) {
      final List<Object> list = new ArrayList<>();
      for (final Wall.Opening o : w.openings) {
        // ⚠️ 字段顺序必须与 JS `wall.js mkOpening()` 一致（顺序也是逐字节比对的一部分）；
        //    **`kind`/`sill` 只在窗上写** —— 漏了这两个字段就是 FIX-05 复发：
        //    窗会在「保存 → 分享 → 交付」链上无警告消失（或被当成门）。
        final Map<String, Object> om = Json.obj("at", o.at(), "w", o.w(), "h", o.h());
        if (o.isWindow()) {
          om.put("kind", Wall.WINDOW);
          om.put("sill", o.sill());
        }
        list.add(om);
      }
      m.put("openings", list);
    }
    final String role = w.roleOrNull();
    if (role != null) m.put("role", role);
    return m;
  }

  /**
   * 一根柱 → JSON：`{id, x, z, w, d}`（顺序固定 id → x → z → w → d，与 JS `columnForFile()`
   * 一字不差 —— 顺序也是逐字节比对的一部分）。
   *
   * ⚠️ 只写用户画下的几何：高度（= `layout.h`）、面积、可用面积都是派生量，**不进 state**。
   */
  public static Map<String, Object> columnJson(Layout.Column c) {
    return Json.obj("id", c.id, "x", c.x, "z", c.z, "w", c.w, "d", c.d);
  }

  /**
   * 一条动线 → JSON：`{id, name?, points}`（`name` 有值才写；顺序固定 id → name → points，
   * 与 JS `routeForFile()` 一字不差 —— 顺序也是逐字节比对的一部分）。
   *
   * ⚠️ 只写**用户点出的站点**：自动折线/长度/状态/颜色都是派生量，写进文件就是"两套事实"。
   */
  public static Map<String, Object> routeJson(Layout.Route r) {
    final Map<String, Object> m = Json.obj("id", r.id);
    if (r.name != null && !r.name.isEmpty()) m.put("name", r.name);
    final List<Object> pts = new ArrayList<>();
    for (final double[] p : r.points) pts.add(Json.arr(p[0], p[1]));
    m.put("points", pts);
    return m;
  }

  /** 方案的 `state`（字段顺序与 JS 的 exportScheme 一致 —— 顺序也是逐字节比对的一部分） */
  public static Map<String, Object> stateOf(Layout l) {
    final List<Object> walls = new ArrayList<>();
    for (final Wall w : l.walls) walls.add(wallJson(w));
    final List<Object> columns = new ArrayList<>();
    for (final Layout.Column c : l.columns) columns.add(columnJson(c));
    final List<Object> items = new ArrayList<>();
    for (final Layout.Item i : l.items) {
      items.add(Json.obj("id", i.id, "p", i.p, "x", i.x, "z", i.z, "r", i.r, "doorAmount", i.doorAmount));
    }
    // 字段顺序即契约（与 JS `exportScheme` 逐字节比对）：`w,d,h,walls,columns?,items,...`。
    // columns 必须**在 items 之前**发射，而 `Json.obj` 是"参数顺序 = 键顺序"，
    // 所以这里分段 put —— 先建 walls，再决定 columns，最后 items（不能先 items 再回头插）。
    final Map<String, Object> m = Json.obj("w", l.w, "d", l.d, "h", l.h, "walls", walls);
    // 柱（W5，可选）：空 columns 不发射（与 routes/view/roomLabels 同一条规矩），
    // 旧方案导出字节不被无意义改写。⚠️ 漏了这一句 = 柱在「保存 → 分享 → 交付」链上静默消失。
    if (!l.columns.isEmpty()) m.put("columns", columns);
    m.put("items", items);
    // 动线（W4，可选）：**只在真有动线时写** —— 空 routes 不发射（与 view / roomLabels 同一条规矩），
    // 旧方案导出字节不被无意义改写。字段顺序在 items 之后、view 之前（与 JS 同序）。
    // ⚠️ 漏了这一句就是又一次 FIX-05：站点在「保存 → 分享 → 交付」链上无警告消失。
    if (!l.routes.isEmpty()) {
      final List<Object> routes = new ArrayList<>();
      for (final Layout.Route r : l.routes) routes.add(routeJson(r));
      m.put("routes", routes);
    }
    // ⚠️ List.of(...).contains(null) 会抛 NullPointerException（不可变集合拒收 null 查找）——
    // 先判 null 再 contains，顺序不能反（第一次就踩了：132 条里 3 条报 NPE）。
    if (l.wallStyle != null && WALL_STYLES.contains(l.wallStyle)) m.put("view", Json.obj("wallOpacity", l.wallStyle));
    // 房间名（M1a，可选）：**只在真有名字时写**（与 JS `exportScheme` 同口径）——
    // 这样「旧文件（连字段都没有）」与「新文件但没命名」长得一模一样，同代往返逐字节稳定。
    // ⚠️ 漏了这一句就回到 FIX-05 的形状：名字在「保存 → 分享 → 交付」链上无警告消失。
    if (!l.roomLabels.isEmpty()) m.put("roomLabels", new LinkedHashMap<>(l.roomLabels));
    return m;
  }

  /** 导出：与原型完全一致的 JSON 文本（缩进 2） */
  public static String exportScheme(Layout l) {
    return exportScheme(l, 2);
  }

  public static String exportScheme(Layout l, int indent) {
    return Json.write(Json.obj("format", FORMAT, "state", stateOf(l)), indent);
  }

  /** 造一份最小方案文档（用例 `scheme-accept`：三种历史格式都要能打开） */
  public static Map<String, Object> sampleDoc(String format, Layout empty) {
    return Json.obj("format", format, "state", stateOf(empty));
  }

  /**
   * 导入结果。失败时 `layout` 为 null，`error.reason` 给界面分类提示。
   *
   * `roomSemantics`（W3）是**加法字段**：旧标识 → `legacy`、新标识 → `walls`。
   * 它同时挂在 `layout.roomSemantics` 上（JS 侧同名字段，`rooms.roomSemanticsOf` 消费）；
   * 单独回一个是因为调用方（旧方案转换预检）常常只拿到结果、不拆 layout。
   */
  public record ImportResult(boolean ok, Error error, Layout layout, int nextId, String format,
                             String roomSemantics) {
    static ImportResult fail(Error e) {
      return new ImportResult(false, e, null, 0, null, null);
    }
  }

  @SuppressWarnings("unchecked")
  /** 与 JS `wallstyle.js` 一字不差的三档 —— 服务端只认这三档，别的当没写 */
  public static final java.util.List<String> WALL_STYLES = java.util.List.of("solid", "half", "light");

  private static Map<String, Object> asMap(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : null;
  }

  @SuppressWarnings("unchecked")
  private static List<Object> asList(Object o) {
    return o instanceof List ? (List<Object>) o : new ArrayList<>();
  }

  private static Double numOrNull(Object o) {
    return o instanceof Number ? ((Number) o).doubleValue() : null;
  }

  /**
   * 与 JS `Number(v)` 同口径的宽容数值读法（给宽容读墙用）。
   * 差别写清楚：`null → 0`（JS `Number(null) === 0`）、字符串按十进制解、其余 → NaN。
   * 写端永远不会产生这些形状，这里只是"读旧文件/手改文件"时的宽容面。
   */
  /** 1 mm 量化（镜像 JS `geometry.roundMm`）：用户输入/落库的精度 */
  static double roundMm(double v) {
    return Math.round(v * 1000) / 1000.0;
  }

  private static double jsNum(Object o) {
    if (o == null) return 0;
    if (o instanceof Number n) return n.doubleValue();
    if (o instanceof String s) {
      try {
        return Double.parseDouble(s.trim());
      } catch (RuntimeException e) {
        return Double.NaN;
      }
    }
    return Double.NaN;
  }

  /**
   * 与 JS `readRoomLabel` 同口径的房间名读法：只认字符串，空白折叠成一个空格再首尾去空。
   * **不截断**（界面输入才截断 —— 昨天的长名字不该被今天的上限切掉）。
   */
  static String readRoomLabel(Object v) {
    return v instanceof String s ? s.replaceAll("\\s+", " ").trim() : "";
  }

  /**
   * 宽容读一面墙（镜像 JS `wall.js` 的 `readWall`）：
   * **数组**（W1 之前那一代）与**对象**（新形状）都能读 —— 两种形状无歧义（数组只能是一种东西），
   * 所以不靠 format 标识判别，标识只管"认不认得这个文件"。
   * 形状彻底不认识（不是四数数组、也没有 a/b）→ null。
   * ⚠️ 门洞字段缺/畸形时**保留 NaN 往下传**（与 JS 一致）：让**结构体检**去拒它、
   *   报出 `bad-opening`，而不是在这里混成 `bad-wall`（两个原因码是给界面说不同话用的）。
   */
  private static Wall wallOf(Object o) {
    if (o instanceof List<?> list) {
      if (list.size() != 4) return null;
      final double[] v = new double[4];
      for (int k = 0; k < 4; k++) {
        v[k] = jsNum(list.get(k));
        if (Double.isNaN(v[k]) || Double.isInfinite(v[k])) return null;
      }
      return Wall.of(v[0], v[1], v[2], v[3]);
    }
    final Map<String, Object> m = asMap(o);
    if (m == null) return null;
    final List<Object> a = asList(m.get("a"));
    final List<Object> b = asList(m.get("b"));
    if (a.size() != 2 || b.size() != 2) return null;
    final double[] av = {jsNum(a.get(0)), jsNum(a.get(1))};
    final double[] bv = {jsNum(b.get(0)), jsNum(b.get(1))};
    for (final double v : av) {
      if (Double.isNaN(v) || Double.isInfinite(v)) return null;
    }
    for (final double v : bv) {
      if (Double.isNaN(v) || Double.isInfinite(v)) return null;
    }
    final Wall w = Wall.of(av[0], av[1], bv[0], bv[1]);
    // W3 角色：**宽容读**（缺省 / 认不得 → null = 当没写）。不因为一个角色值认不得就拒整份文件 ——
    // 那会让"未来版本多了一个角色"变成"昨天的方案打不开"（与 `wallOpacity` 同一条规矩）。
    w.role = Wall.readRole(m.get("role"));
    final Object ops = m.get("openings");
    if (ops == null) return w;
    if (!(ops instanceof List<?> ol)) return w;
    final List<Wall.Opening> openings = new ArrayList<>();
    for (final Object oo : ol) {
      final Map<String, Object> om = asMap(oo);
      if (om == null) {
        openings.add(new Wall.Opening(Double.NaN, Double.NaN, Double.NaN));
        continue;
      }
      // 宽容读：老文件（没有 `kind`）读进来就是门；`sill` 只有在真的是窗时才读
      // （门身上挂着一个多余的 `sill` 当没写 —— 写出去时会被擦掉，同代往返才稳）
      if (Wall.WINDOW.equals(om.get("kind"))) {
        openings.add(new Wall.Opening(jsNum(om.get("at")), jsNum(om.get("w")), jsNum(om.get("h")),
            Wall.WINDOW, jsNum(om.get("sill"))));
      } else {
        openings.add(new Wall.Opening(jsNum(om.get("at")), jsNum(om.get("w")), jsNum(om.get("h"))));
      }
    }
    return w.withOpenings(openings);
  }

  private static Integer intOrNull(Object o) {
    if (o instanceof Integer) return (Integer) o;
    if (o instanceof Long && ((Long) o) <= Integer.MAX_VALUE) return ((Long) o).intValue();
    return null;
  }

  /**
   * 校验并解析（可传文本或已解析对象）。
   *
   * @param checkProduct 传 true 则校验型号是否存在（原型行为）；
   *                     传 false 时内核保持"无目录依赖"，服务端可先做纯结构校验
   */
  public static ImportResult importScheme(Object input, Catalog catalog, boolean checkProduct) {
    Map<String, Object> raw;
    if (input instanceof String) {
      try {
        raw = asMap(Json.parse((String) input));
      } catch (RuntimeException e) {
        return ImportResult.fail(NOT_JSON);
      }
    } else {
      raw = asMap(input);
    }
    if (raw == null) return ImportResult.fail(NOT_JSON);

    final Object fmt = raw.get("format");
    final Map<String, Object> s = asMap(raw.get("state"));
    if (!(fmt instanceof String) || !ACCEPTED_FORMATS.contains(fmt) || s == null) {
      return ImportResult.fail(BAD_FORMAT);
    }

    final Double w = numOrNull(s.get("w"));
    final Double d = numOrNull(s.get("d"));
    final Double h = numOrNull(s.get("h"));
    if (w == null || d == null || h == null) return ImportResult.fail(badRoom());
    final double[][] rl = roomLimit();
    if (w < rl[0][0] || w > rl[0][1]) return ImportResult.fail(badRoom());
    if (d < rl[1][0] || d > rl[1][1]) return ImportResult.fail(badRoom());
    if (h < rl[2][0] || h > rl[2][1]) return ImportResult.fail(badRoom());

    if (!(s.get("items") instanceof List)) return ImportResult.fail(BAD_ITEM);
    final List<Object> items = asList(s.get("items"));
    if (items.size() > limitItems()) return ImportResult.fail(tooManyItems());
    if (!(s.get("walls") instanceof List)) return ImportResult.fail(badWall());
    final List<Object> walls = asList(s.get("walls"));
    if (walls.size() > limitWalls()) return ImportResult.fail(tooManyWalls());

    // 设备逐台校验（口径逐条对齐原型）
    final List<Layout.Item> parsedItems = new ArrayList<>();
    final List<Integer> ids = new ArrayList<>();
    for (final Object o : items) {
      final Map<String, Object> i = asMap(o);
      if (i == null) return ImportResult.fail(BAD_ITEM);
      final Object pId = i.get("p");
      if (!(pId instanceof String)) return ImportResult.fail(BAD_ITEM);
      if (checkProduct && catalog.footprint((String) pId) == null) return ImportResult.fail(BAD_ITEM);
      final Object da = i.get("doorAmount");
      final Double dav = da == null ? null : numOrNull(da);
      if (da != null && (dav == null || dav < 0 || dav > 1)) return ImportResult.fail(BAD_ITEM);
      final Double ix = numOrNull(i.get("x"));
      final Double iz = numOrNull(i.get("z"));
      final Double ir = numOrNull(i.get("r"));
      final Integer iid = intOrNull(i.get("id"));
      if (ix == null || iz == null || ir == null || iid == null) return ImportResult.fail(BAD_ITEM);
      if (ir < 0 || ir >= 360) return ImportResult.fail(BAD_ITEM);
      if (Math.abs(ix) > limitCoordM() || Math.abs(iz) > limitCoordM()) return ImportResult.fail(BAD_ITEM);
      parsedItems.add(new Layout.Item(iid, (String) pId, ix, iz, ir, dav == null ? 0 : dav));
      ids.add(iid);
    }
    if (new HashSet<>(ids).size() != ids.size()) return ImportResult.fail(DUP_ID);

    // 墙体逐面校验：形状宽容（老文件是数组、新文件是对象）、长度达标、端点落在房间内
    final List<Wall> parsedWalls = new ArrayList<>();
    for (final Object o : walls) {
      final Wall wl = wallOf(o);   // ⚠️ 变量名不能叫 `w`：房间宽度就叫 w，遮蔽了会让下面比错东西
      if (wl == null) return ImportResult.fail(badWall());
      if (Math.abs(wl.a[0]) > limitCoordM() || Math.abs(wl.a[1]) > limitCoordM()
          || Math.abs(wl.b[0]) > limitCoordM() || Math.abs(wl.b[1]) > limitCoordM()) {
        return ImportResult.fail(badWall());
      }
      // 斜墙合法（与 JS 同口径）：不再要求横平竖直，只要求长度达标；端点由下面的
      // wallOutOfRoom 兜住。
      if (wl.len() < limitMinWallLengthM()) return ImportResult.fail(badWall());
      // B19：还要在屋里。外墙正好贴在边界上（x=0..w）→ 恰好合法，不用特判。
      final boolean outA = wl.a[0] < 0 || wl.a[0] > w || wl.a[1] < 0 || wl.a[1] > d;
      final boolean outB = wl.b[0] < 0 || wl.b[0] > w || wl.b[1] < 0 || wl.b[1] > d;
      if (outA || outB) return ImportResult.fail(wallOutOfRoom());
      // 门洞：**只查结构**（跑到墙外 / 比墙高 / 两洞重叠 / 个数超格式上限）。
      // 与可改参数有关的边界（最小净宽、离墙角间隙、每墙上限）不在导入侧拒绝 ——
      // 那些是现场可改的策略，拿"今天的策略"拒"昨天导出的文件"就是在制造 FIX-05 的反面。
      if (Openings.checkWallOpenings(wl, h, true) != null) return ImportResult.fail(badOpening());
      parsedWalls.add(wl);
    }

    // 柱（W5，docs/101 §2.3）：结构非法**整份拒绝**；关系冲突（叠柱/压设备/压洞口）**宽容收下**。
    // 量化的顺序有讲究：先按 1 mm 量化，再用量化后的值判边长与四角 ——
    // 这样 JS/Java 在 0.1996~0.2004 这类边界上判同一边，不会一个判小、一个判合法。
    final Object colsBox = s.get("columns");
    final List<Layout.Column> parsedColumns = new ArrayList<>();
    if (colsBox != null) {
      if (!(colsBox instanceof List)) return ImportResult.fail(badColumn());
      final List<Object> colList = asList(colsBox);
      if (colList.size() > MAX_COLUMNS) return ImportResult.fail(tooManyColumns());
      final java.util.Set<Integer> colIds = new java.util.HashSet<>();
      for (final Object o : colList) {
        final Map<String, Object> c = asMap(o);
        if (c == null) return ImportResult.fail(badColumn());
        final Integer cid = intOrNull(c.get("id"));
        if (cid == null || cid < 1) return ImportResult.fail(badColumn());
        if (!colIds.add(cid)) return ImportResult.fail(duplicateColumnId());
        final Double cx = numOrNull(c.get("x"));
        final Double cz = numOrNull(c.get("z"));
        final Double cw = numOrNull(c.get("w"));
        final Double cd = numOrNull(c.get("d"));
        if (cx == null || cz == null || cw == null || cd == null) return ImportResult.fail(badColumn());
        final double x = roundMm(cx);
        final double z = roundMm(cz);
        final double cwid = roundMm(cw);
        final double cdep = roundMm(cd);
        // 容差与 JS `checkColumn` 同口径（1e-6）：先量化再比，且两侧都留 EPS ——
        // 0.1999999 这类"差一丝"的输入两边判同一边，不会一个判小、一个判合法。
        if (cwid < COLUMN_MIN_SIDE_M - COLUMN_EPS || cdep < COLUMN_MIN_SIDE_M - COLUMN_EPS) {
          return ImportResult.fail(columnTooSmall());
        }
        if (cwid > COLUMN_MAX_SIDE_M + COLUMN_EPS || cdep > COLUMN_MAX_SIDE_M + COLUMN_EPS) {
          return ImportResult.fail(columnTooLarge());
        }
        // 四角完整在场景内（容差 1e-6：贴边恰好合法）
        final double hw = cwid / 2;
        final double hd = cdep / 2;
        if (x - hw < -COLUMN_EPS || x + hw > w + COLUMN_EPS
            || z - hd < -COLUMN_EPS || z + hd > d + COLUMN_EPS) {
          return ImportResult.fail(columnOutOfScene());
        }
        parsedColumns.add(new Layout.Column(cid, x, z, cwid, cdep));
      }
    }

    final Layout layout = new Layout(w, d, h);
    layout.walls.addAll(parsedWalls);
    layout.columns.addAll(parsedColumns);
    layout.items.addAll(parsedItems);
    // 视图档位（可选）：认得的收下，别的一律当没写（与 JS wallstyle.js 同口径）
    final Map<String, Object> viewMap = asMap(s.get("view"));
    final Object styleBox = viewMap == null ? null : viewMap.get("wallOpacity");
    if (styleBox instanceof String styleStr && WALL_STYLES.contains(styleStr)) layout.wallStyle = styleStr;
    // 房间名（可选，M1a）：**只收字符串键 + 字符串值**，空名字丢掉、名字本身不截断；
    // 键是房间的几何稳定 id，墙一改形状就会变 —— 所以**不在这里校验「这个房间还在不在」**：
    // 暂时对不上的名字也要活下来（墙改回去名字就回来，与 JS 同一规则）。
    // 顺序 = 文件里的顺序（LinkedHashMap）：导出要逐字节稳定。
    final Map<String, Object> labelsMap = asMap(s.get("roomLabels"));
    if (labelsMap != null) {
      for (final Map.Entry<String, Object> e : labelsMap.entrySet()) {
        final String name = readRoomLabel(e.getValue());
        if (!name.isEmpty()) layout.roomLabels.put(e.getKey(), name);
      }
    }
    // 动线（W4，可选）：坏形状**整份拒绝**（静默丢一条 = 用户点好的路线在保存后消失）。
    // 只做结构校验（数量 / 点位数 / id 唯一 / 点在场景内），**不在这里寻路**：
    // 寻路在内核 `route.js` 只有一份，服务端不为「方案里带不带路线」写第二套（本项目最贵的教训）。
    final Object routesBox = s.get("routes");
    if (routesBox != null) {
      if (!(routesBox instanceof List)) return ImportResult.fail(badRoute());
      final List<Object> routeList = asList(routesBox);
      if (routeList.size() > MAX_ROUTES) return ImportResult.fail(tooManyRoutes());
      final java.util.Set<Integer> routeIds = new java.util.HashSet<>();
      for (final Object o : routeList) {
        final Map<String, Object> r = asMap(o);
        if (r == null) return ImportResult.fail(badRoute());
        final Integer rid = intOrNull(r.get("id"));
        if (rid == null || rid < 1) return ImportResult.fail(badRoute());
        if (!routeIds.add(rid)) return ImportResult.fail(duplicateRouteId());
        final Object ptsBox = r.get("points");
        if (!(ptsBox instanceof List)) return ImportResult.fail(badRoute());
        final List<Object> pts = asList(ptsBox);
        if (pts.size() < 2 || pts.size() > MAX_ROUTE_POINTS) return ImportResult.fail(badRoute());
        final List<double[]> clean = new ArrayList<>();
        for (final Object po : pts) {
          final List<Object> pp = asList(po);
          if (pp.size() != 2) return ImportResult.fail(badRoute());
          final Double px = numOrNull(pp.get(0));
          final Double pz = numOrNull(pp.get(1));
          if (px == null || pz == null) return ImportResult.fail(badRoute());
          if (px < -ROUTE_EPS || px > w + ROUTE_EPS || pz < -ROUTE_EPS || pz > d + ROUTE_EPS) {
            return ImportResult.fail(routeOutOfRoom());
          }
          clean.add(new double[]{px, pz});
        }
        // name 是装饰性字段：非字符串/空串当没写、**不截断**（与 roomLabels 同一条规矩）
        final Object nameBox = r.get("name");
        final String routeName = nameBox instanceof String str && !str.isEmpty() ? str : null;
        layout.routes.add(new Layout.Route(rid, routeName, clean));
      }
    }
    // W3：房间派生语义由**文件标识**决定（旧文件按旧语义算房间，房间数不许静默变少）。
    // 与 JS `importScheme` 同一行赋值；`stateOf` 不发射它（派生口径不是数据）。
    layout.roomSemantics = semanticsOf((String) fmt);
    return new ImportResult(true, null, layout, Placement.nextIdFor(layout), (String) fmt,
        layout.roomSemantics);
  }

  /** 文件大小预检（原型 `file.size > 1e6` 直接 throw） */
  public static Error checkFileSize(long bytes) {
    return bytes <= limitFileBytes()
        ? null
        : new Error("too-large", "无法导入：文件过大（上限 " + (limitFileBytes() / 1000) + " KB）");
  }
}