package com.scene.spatial.scheme;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.zip.Deflater;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

/**
 * Delivery —— 交付包的**组装规则**（全是纯函数：输入进、字节出，不碰库、不看时钟以外的外部状态）
 *
 * 用户拍板 A10：包里的东西按 设计决策记录 §3.4 的 **7 件**；GLB 作**可选附件、默认不带**（决策⑧）；
 * 界面要给勾选框让用户多选。A13：三维截图 **3 张固定视角**。
 *
 * ## 谁生成哪一件（这条分工是刻意的，不是随手分的）
 *
 *   · **图形类**（平面图.svg / 三维截图 ×3）—— **浏览器**给。只有浏览器手里有渲染器，
 *     服务端重画一遍就会长出第二套渲染口径（"服务端画的平面图与界面看到的不一样"是最坏的失败）。
 *   · **数据类**（方案.json / 设备清单.csv / 体检报告.json / README.md）—— **服务端**生成。
 *     方案内容、目录、结论唯一的真相都在它手里；从浏览器递上来的话，
 *     交付团队拿到的可能是"用户屏幕上那份"而不是"库里那一版" —— 而交付包必须钉在**某一版**上。
 *   · **封面.png** —— 服务端从自己盘上取（`GET /api/schemes/{id}/cover` 的那一份，与列表同款），
 *     不让浏览器再传一遍：它已经有权威副本了。
 *
 * ## 为什么每件都能单独勾
 *
 * 交付团队要的东西不一样：只出平面图给车间、只出 CSV 进 BOM 系统、全套归档。
 * 固定一件不落地地打一个大包，他们会自己在 Windows 里删 —— 而**删完的那份没有任何记录**。
 * 勾选框一次说清"这一包里有哪几件"，记录落在 `scheme_delivery.files_json` 里，事后可对账。
 */
public final class Delivery {

  /** 目录里的一行字节：`name` 是包内路径（用 `/`，跨平台），`bytes` 是内容 */
  public record Entry(String name, byte[] bytes) {
  }

  /**
   * 交付包里的一件（**唯一出处**：接口下发的可选项、包的清单、README 的说明都来自这一张表）。
   *
   * `fromBrowser = true` 表示"这一件的原料只有浏览器有"（渲染类）—— 请求里少了它就没法生成。
   * `required` 表示"不勾也得有"：**README 与方案.json 是包的根**，一个包没有这两件就不是交付包
   * （它没法被对账、也没法再导回来）。
   */
  public record Item(String id, String name, String label, String why,
                     boolean fromBrowser, boolean required) {
  }

  /** 三维截图的三个固定视角（A13）。**顺序 = 请求里三张图的顺序**。 */
  public record View(String id, String name, String label, String how) {
  }

  public static final List<View> VIEWS = List.of(
      new View("top", "三维截图-1-俯视.png", "正上方俯视",
          "画布中央正上方往下看（方位角 0°、俯仰 90°）"),
      new View("front45", "三维截图-2-正面斜45.png", "正面斜 45°",
          "站在画布中轴正前方、半空中往房间看（方位角 0°、俯仰 45°）"),
      new View("corner45", "三维截图-3-斜角45.png", "斜角 45°",
          "站在画布一角、半空中往对角看（方位角 45°、俯仰 45°）"));

  public static final List<Item> ITEMS = List.of(
      new Item("json", "方案.json", "方案数据（可再导回）",
          "含格式标识、房间、布局、参数版本 —— 导回编辑器就是这一份", false, true),
      new Item("plan", "平面图.svg", "平面图（矢量，可放大打印）",
          "浏览器按当前画布画的，与屏幕上看到的一致", true, false),
      new Item("shots", "三维截图-1~3.png", "三维截图 3 张（固定视角）",
          "俯视 / 正面斜 45° / 斜角 45°，都由浏览器当前场景截取", true, false),
      new Item("cover", "封面.png", "封面（方案库列表同款）",
          "保存那一刻的三维视角截屏；这一份从没截过封面时**包里就没有它**", false, false),
      new Item("csv", "设备清单.csv", "设备清单（型号 / 数量 / 位置 / 房间 / 开门方向 / 占地）",
          "按型号汇总，位置与朝向逐台列出（Excel 直接打开）", false, false),
      new Item("report", "体检报告.json", "体检报告（规则 7 开门净空等结论）",
          "**落库那一刻存下的结论**（含当时用的参数版本）—— 老方案没存过就会写成「没有存下」", false, false),
      new Item("readme", "README.md", "README（房间尺寸 / 清单 / 参数版本 / 生成人）",
          "交付包里第一件该看的东西：参数版本与数据血缘都写在这里", false, true));

  /** 可选附件（决策⑧：体积大、默认不带）—— 它不是"第 8 件"，勾了才夹带 */
  public static final String ATTACH_DIR = "附件/";

  private static final ObjectMapper JSON = new ObjectMapper();

  private Delivery() {
  }

  // ── 选择与校验 ──────────────────────────────────────────────────────

  public static Optional<Item> item(String id) {
    return ITEMS.stream().filter(i -> i.id().equals(id)).findFirst();
  }

  /**
   * 这一件会落成哪些文件（`shots` 是三张 —— 它是唯一"一件多文件"的）。
   *
   * 为什么要发这个：界面上要能回答「我勾了封面，包里到底有没有封面」——
   * 只给一个件名（「封面.png」）的话，它与实际文件名只能靠**约定**对上，
   * 而约定在两边各写一遍迟早会错开（错开的后果是少一件而没人发现）。
   */
  public static List<String> namesOf(Item item) {
    return "shots".equals(item.id()) ? VIEWS.stream().map(View::name).toList() : List.of(item.name());
  }

  /**
   * 把界面传来的勾选名单翻成"要生成哪几件"。
   *
   * **不认识的 id 要当场说清是哪一串**（不是默默忽略）：
   * 静默忽略的后果是"用户勾了 7 件、包里 6 件"，而他会以为是打包漏了 —— 于是开始不信任这个包。
   * 必需的几件（`required`）无论有没有勾都在（见 {@link Item} 的理由）。
   */
  public static List<Item> selected(List<String> ids) {
    final List<String> wanted = ids == null ? List.of() : ids;
    final List<String> unknown = new ArrayList<>();
    for (final String id : wanted) {
      if (item(id).isEmpty()) unknown.add(id);
    }
    if (!unknown.isEmpty()) {
      throw new IllegalArgumentException("不认识的交付项：" + String.join(" / ", unknown)
          + "（可选的是：" + String.join(" / ", ITEMS.stream().map(Item::id).toList()) + "）");
    }
    final List<Item> out = new ArrayList<>();
    for (final Item i : ITEMS) {
      if (i.required() || wanted.contains(i.id())) out.add(i);
    }
    return out;
  }

  // ── 数据类生成器 ────────────────────────────────────────────────────

  /**
   * 方案.json —— **能再导回编辑器**的那一份，外加包的元信息。
   *
   * 与前端 `exportScheme` 的产物同形（`{format, state}`），这一条不能变：
   * 包里的 JSON 与界面导出的 JSON 若是两套，"同一个方案两个样"就永远说不清。
   * 多出来的那几个字段（`packagedAt` / `paramsRev` / `deliveryId`）放在**外层**，
   * 因为 `state` 是要交给内核导入的 —— 往里塞东西会被内核当未知字段丢掉（或者更糟：报错）。
   */
  public static byte[] planJson(Map<String, Object> state, String format, long id, String name,
                                int rev, int paramsRev, long catalogRev, String at) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("format", format);
    out.put("state", state);
    out.put("delivery", mapOf(
        "schemeId", id, "schemeName", name, "schemeRev", rev,
        "paramsRev", paramsRev, "catalogRev", catalogRev, "packagedAt", at));
    return json(out);
  }

  /**
   * 设备清单.csv（A10 里点名的一件）。
   *
   * 三件必须做对的事：
   *   ① **UTF-8 BOM** —— 没有它，Windows 上的 Excel 会把中文型号读成乱码（实测很多次了）；
   *   ② **CRLF** —— Excel 对 LF 的容忍度不如对 CRLF；
   *   ③ **引号转义** —— 名称里有逗号的产品（"超低温保存箱，立式"）会把整列挤歪。
   *
   * 位置是**方案里的原始 x/z（米 → 毫米）**，不是我们推算的中心点：
   * 施工队照着这个数在房间里放线，推算过一次的数就再也对不上图纸了。
   *
   * ⭐ 「型号」那一列写的是**厂家型号码**（`DEMO-CT-100`），不是运行时目录 id（`demo-ct-scanner`）——
   * 方案里 items 的 `p` 是 id，直接写出去施工队谁也认不得（本项目的测试先拓到这个：
   * 第一版把 id 当型号写进了列里）。目录里查不到那一款时才退回写 id，并注明它是什么。
   */
  public static byte[] csv(Map<String, Object> state, Map<String, Map<String, Object>> byId) {
    return csv(state, byId, java.util.Map.of());
  }

  /**
   * 未分房间时的说法（M1）：**不许留空** —— 空格子会被当成"漏画了"，而它说的是"这台不在任何一间房里"。
   *
   * ⚠️ W3 起"不在任何一间房里"分成两件**不同**的事，不能共用一句话：
   *   · {@link #OPEN_SCENE} = **开放场景**（院子/开口场地）：它在场景里，只是那一片没有被墙围成房间；
   *   · `未分房间` = 真的**不知道**（客户端没算出来、墙太厚算不出归属等）。
   * 两者都如实写出、都不猜，但用户看到的是不同的结论 —— 合成一句会把"开放场地"说成"漏算了"。
   */
  public static final String NO_ROOM = "未分房间";

  /**
   * 开放场景（W3）：设备落在**开放面**（不构成房间的剩余区域）时，房间列写这四个字。
   *
   * 为什么由客户端递这个名字：开放面与房间一样是**墙剖出来的派生面**，那段面遍历在内核里只有一份
   * （`spatial-core/src/rooms.js`）。服务端不重算（重写一遍是本项目最贵的教训），只负责
   * **原样写进那一列** —— 所以这里要有一个常量，让"原样"有一个被断言的参照物，
   * 而不是又一处手抄中文字面量。缺项仍写 {@link #NO_ROOM}（不猜）。
   */
  public static final String OPEN_SCENE = "开放场景";

  /**
   * 房间列的一格：给了合法名字就原样写（含 {@link #OPEN_SCENE}），缺项/空白写 {@link #NO_ROOM}。
   * 判据只有这一处 —— 列头、README、CSV 三处都从它取，免得"一处改成开放场景、另一处还是未分房间"。
   */
  public static String roomCell(String name) {
    return name == null || name.isBlank() ? NO_ROOM : name;
  }

  /**
   * 设备清单.csv（带**房间列**，M1 多房间）。
   *
   * @param rooms 每台设备所在的房间名（键 = 设备 id 的字符串）。**由客户端算好递进来** ——
   *              房间是墙剖出来的派生面，那段面遍历在 JS 内核里只有一份，
   *              不为清单上的一列在 Java 侧重写一遍（本项目最贵的教训）。缺项一律写「未分房间」。
   */
  public static byte[] csv(Map<String, Object> state, Map<String, Map<String, Object>> byId,
                           Map<String, String> rooms) {
    final Map<String, String> where = rooms == null ? java.util.Map.of() : rooms;
    final StringBuilder sb = new StringBuilder();
    sb.append('\uFEFF');
    sb.append("型号,名称,数量,位置(mm),房间,朝向(度),开门量,占地(宽×深×高 mm)\r\n");
    // 按型号汇总（同一型号出现几台就是几台）—— 施工队要的是"这个型号定几台、摆哪几处"
    for (final Map.Entry<String, List<Map<String, Object>>> e : groupByModel(state).entrySet()) {
      final String code = e.getKey();
      final Map<String, Object> p = byId.get(code);
      final List<String> pos = new ArrayList<>();
      final List<String> rot = new ArrayList<>();
      final List<String> amount = new ArrayList<>();
      final List<String> room = new ArrayList<>();
      for (final Map<String, Object> it : e.getValue()) {
        pos.add("(" + mm(it.get("x")) + "," + mm(it.get("z")) + ")");
        rot.add(numText(it.get("r")));
        amount.add(numText(it.get("doorAmount")));
        final String name = where.get(str(it.get("id")));
        room.add(roomCell(name));
      }
      sb.append(field(modelOf(code, p))).append(',')
          .append(field(p == null ? "（目录里没有这一款）" : str(p.get("name")))).append(',')
          .append(e.getValue().size()).append(',')
          .append(field(String.join("; ", pos))).append(',')
          .append(field(String.join("; ", room))).append(',')
          .append(field(String.join("; ", rot))).append(',')
          .append(field(String.join("; ", amount))).append(',')
          .append(field(footprint(p)))
          .append("\r\n");
    }
    return sb.toString().getBytes(StandardCharsets.UTF_8);
  }

  /**
   * 一个型号在纸上的名字：优先用厂家的 **model_no**；目录里查不到那一款时退回运行时 id 并Ƒ写分明。
   *
   * 退回时**不能只写 id** —— 收到 CSV 的人会把它当成型号去下单，而它不是。
   */
  private static String modelOf(String id, Map<String, Object> p) {
    if (p == null) return id + "（目录 id，目录里已无此款）";
    final String model = str(p.get("model"));
    if (model.isEmpty()) return id + "（目录里没写型号）";
    return model;
  }

  /**
   * 体检报告.json —— **落库那一刻存下的结论**，不是现算的。
   *
   * 现算的话，交付团队拿到的结论说不清是哪一版参数下得出的（而参数会改 —— B4a/B4d 那一整条就是为它做的）。
   * 老方案（`audit_json` 为 NULL）**不补**、不假装：写成 `"stored": null` + 一句为什么，
   * 并明确 **"没有存下当时的结论" ≠ "当时没问题"**。
   */
  public static byte[] reportJson(Map<String, Object> storedAudit, Map<String, Object> nowReport,
                                  int contentParamsRev, int nowParamsRev, long catalogRev,
                                  long id, int rev) {
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("schemeId", id);
    out.put("schemeRev", rev);
    out.put("contentParamsRev", contentParamsRev);
    out.put("stored", storedAudit);
    if (storedAudit == null) {
      out.put("storedWhy", "这一份方案存得比「记结论」这个功能早（`scheme.audit_json` 是 NULL），"
          + "**没有存下当时的结论 —— 这不等于当时没问题**");
    }
    // 现算的那条只作参考，字段名说清它是"现在按第 X 版参数算的"
    out.put("recheck", mapOf("report", nowReport, "paramsRev", nowParamsRev, "catalogRev", catalogRev));
    return json(out);
  }

  /**
   * README.md —— 交付包里**第一件该看的东西**。
   *
   * 设计决策记录 §3.4 点名要它写四样：房间尺寸 / 产品清单 / **参数版本** / 生成时间 + 生成人。
   * 参数版本排在最前面不是排版偏好：体检结论、门能不能开到底，全都取决于它；
   * 后面有人问"这个包当时按什么规则算的"，答案只可能在这一份里。
   */
  @SuppressWarnings("unchecked")
  public static byte[] readme(Map<String, Object> state, Map<String, Map<String, Object>> byId,
                              String schemeName, long id, int rev, int paramsRev, long catalogRev,
                              String catalogOrigin, String at, String by, List<Entry> entries,
                              boolean withAssets, List<String> notIncluded, Map<String, Object> storedAudit) {
    final StringBuilder sb = new StringBuilder();
    sb.append("# ").append(schemeName).append(" —— 交付包\n\n");
    sb.append("> 这一包由「场景空间设计器」生成，**钉在第 ").append(rev).append(" 版方案 + 第 ")
        .append(paramsRev).append(" 版规则参数**上。\n\n");

    sb.append("## 先说版本（对账用）\n\n");
    sb.append("| 项 | 值 |\n| --- | --- |\n");
    sb.append("| 方案 id / 名字 | ").append(id).append(" / ").append(schemeName).append(" |\n");
    sb.append("| **方案版本** | 第 ").append(rev).append(" 版（`scheme.rev`） |\n");
    sb.append("| **规则参数版本** | ").append(paramsRev).append("（体检结论是在这一版下得出的） |\n");
    sb.append("| 目录版本 | ").append(catalogRev).append("（来源：").append(catalogOrigin).append("） |\n");
    sb.append("| 生成时间 | ").append(at).append(" |\n");
    sb.append("| 生成人 | ").append(blankTo(by, "（没记到人）")).append(" |\n");
    sb.append("| 含 GLB 附件 | ").append(withAssets ? "**是**（`附件/` 目录）" : "否（可选附件，这一包没带）").append(" |\n");
    sb.append('\n');

    sb.append("## 房间与产品清单\n\n");
    sb.append("房间：**").append(numText(state.get("w"))).append(" × ").append(numText(state.get("d")))
        .append(" × ").append(numText(state.get("h"))).append(" m**（宽 × 深 × 高）\n\n");
    // 柱（W5，设计决策记录「交付」）：**只在有柱时写**，无柱方案的 README 字节不变。
    // 只报根数与柱占面积（Σw×d）——「可用面积」需要房间面，服务端不重算。
    final String columnLine = columnReading(state);
    if (!columnLine.isEmpty()) sb.append(columnLine).append('\n');
    sb.append("| 型号 | 名称 | 数量 | 占地(宽×深×高 mm) | 尺寸可信度 |\n| --- | --- | --- | --- | --- |\n");
    for (final Map.Entry<String, List<Map<String, Object>>> e : groupByModel(state).entrySet()) {
      final Map<String, Object> p = byId.get(e.getKey());
      sb.append("| ").append(modelOf(e.getKey(), p)).append(" | ")
          .append(p == null ? "（目录里没有这一款）" : blankTo(str(p.get("name")), "（没有名字）")).append(" | ")
          .append(e.getValue().size()).append(" | ")
          .append(footprint(p)).append(" | ")
          .append(p == null ? "—" : blankTo(str(p.get("sizeNote")), "**目录里没写**（别当成已核实）")).append(" |\n");
    }
    sb.append('\n');

    sb.append("## 包里有什么\n\n");
    for (final Entry en : entries) {
      sb.append("- `").append(en.name()).append("` —— ").append(human(en.bytes().length))
          .append("（md5 ").append(md5(en.bytes()).substring(0, 8)).append("）\n");
    }
    if (!notIncluded.isEmpty()) {
      sb.append("- ⚠️ **这一包没带**：").append(String.join("；", notIncluded)).append('\n');
    }
    sb.append('\n');

    sb.append("## 怎么打开\n\n");
    sb.append("- `平面图.svg`：**任意浏览器**直接打开（矢量，放大到 A1 也不模糊；也可导入 CAD 类软件）\n");
    sb.append("- `三维截图-*.png`：任意看图软件（三张分别是：");
    for (int i = 0; i < VIEWS.size(); i++) {
      sb.append(i > 0 ? "、**" : "**").append(VIEWS.get(i).label()).append("**");
    }
    sb.append("）\n");
    sb.append("- `设备清单.csv`：Excel（已带 UTF-8 BOM，中文不乱码）\n");
    sb.append("- `方案.json`：可再导回设计器（`{format, state}`，与界面「导出方案」同一个形状）\n");
    sb.append("- `体检报告.json`：文本编辑器 / 任何 JSON 工具\n\n");

    sb.append("## 体检结论\n\n");
    if (storedAudit == null) {
      sb.append("**这一份没有存下当时的结论**（存得比「记结论」这个功能早）。"
          + "**这不等于当时没问题** —— 要现在复核请在设计器里点「按现参数复核」。\n\n");
    } else {
      final Object report = storedAudit.get("report");
      final Map<String, Object> r = report instanceof Map ? (Map<String, Object>) report : Map.of();
      sb.append("判定时用的是第 ").append(numText(storedAudit.get("paramsRev"))).append(" 版参数、第 ")
          .append(numText(storedAudit.get("catalogRev"))).append(" 版目录（")
          .append(blankTo(str(storedAudit.get("at")), "没记时间")).append("）。\n\n");
      sb.append("- 设备：**").append(numText(r.get("items"))).append("** 台\n");
      sb.append("- 问题：**").append(numText(r.get("issues"))).append("** 条\n");
      if (r.get("trouble") != null) {
        sb.append("- 门开不到底（规则 7）：**").append(numText(r.get("trouble"))).append("** 处\n");
      }
      sb.append("\n> 规则 7 判的是**开门净空**（门扇扫过的范围里有没有别的设备）。")
          .append("它依赖产品的门型是否**确认过** —— 目录里 `尺寸可信度` 那一列写着「没写」的，")
          .append("说明这一款的规格还没有人核对过。\n");
    }
    sb.append("## 这个界面自带的「QA / 演示接口」（**能力边界写在这里**）\n\n");
    sb.append("界面上挂着一个 `window.__spatial`。它**不是隐藏后门，但也有边界**，写清楚免得两边误解：\n\n");
    sb.append("- **能做**：读界面状态；按数字走一遍自动化验证（`window.__spatial.add(0)` 这种）；**改这一次运行中的规则参数**（只在这一页有效，刷新就回到库里那一版，不会写进库）。\n");
    sb.append("- **不能做**：改数据库、改方案/产品、绕过后端 —— 需要角色的动作一律还得过后端那道门。\n");
    sb.append("- **想关掉**：前端构建时不要在 `app/src/main.js` 里 `import './devkit.js'`（那一行就是开关）。\n");
    sb.append("  关掉之后**界面上一切照旧**，只是真机探针套件（`logs/probe-sweep.py`）失去入口 —— 它们是靠它驱动的，所以本项目**默认保留**。\n\n");
    return sb.toString().getBytes(StandardCharsets.UTF_8);
  }

  /** 逐型号分组（**方案里 items 的 `p` 是运行时目录 id**，不是数据库主键） */
  public static Map<String, List<Map<String, Object>>> groupByModel(Map<String, Object> state) {
    final Map<String, List<Map<String, Object>>> out = new LinkedHashMap<>();
    final Object items = state == null ? null : state.get("items");
    if (!(items instanceof List<?> list)) return out;
    for (final Object o : list) {
      if (o instanceof Map<?, ?> raw) {
        @SuppressWarnings("unchecked")
        final Map<String, Object> it = (Map<String, Object>) raw;
        final String p = str(it.get("p"));
        if (p.isEmpty()) continue;
        out.computeIfAbsent(p, k -> new ArrayList<>()).add(it);
      }
    }
    return out;
  }

  // ── 打包 ────────────────────────────────────────────────────────────

  /**
   * 打成一个 zip（Java 自带 `ZipOutputStream`，**不需要新依赖** —— 设计决策记录 §3.4 的原话）。
   *
   * entry 的时间用**打包时刻**：交付包解压出来一眼能看出是哪天做的，
   * 这比"两次生成逐字节相同"更有用（真要可比对，`files_json` 里存着每件的 md5）。
   * 中文文件名用 UTF-8 写（`ZipOutputStream(OutputStream, Charset)`）——
   * 不然 Windows 资源管理器里会是一串乱码，用户会以为包坏了。
   */
  public static byte[] zip(List<Entry> entries) {
    final ByteArrayOutputStream out = new ByteArrayOutputStream();
    final long now = System.currentTimeMillis();
    try (ZipOutputStream z = new ZipOutputStream(out, StandardCharsets.UTF_8)) {
      z.setLevel(Deflater.DEFAULT_COMPRESSION);
      for (final Entry e : entries) {
        final ZipEntry ze = new ZipEntry(e.name());
        ze.setTime(now);
        z.putNextEntry(ze);
        z.write(e.bytes());
        z.closeEntry();
      }
    } catch (IOException e) {
      // 往内存流里写不会失败；真失败就是 JDK 出了问题 —— 大声抛，别吞
      throw new IllegalStateException("打包失败（内存流写出错，这不该发生）", e);
    }
    return out.toByteArray();
  }

  // ── 小工具 ──────────────────────────────────────────────────────────

  public static String md5(byte[] b) {
    try {
      final byte[] d = MessageDigest.getInstance("MD5").digest(b);
      final StringBuilder sb = new StringBuilder();
      for (final byte x : d) sb.append(String.format("%02x", x));
      return sb.toString();
    } catch (Exception e) {
      throw new IllegalStateException("MD5 不可用", e);
    }
  }

  /**
   * 柱读数（README 用）：`柱：**12 根**（占 0.75 m²）`；没有柱返回空串（不写这一行）。
   *
   * 面积是 `Σ(w×d)` 的**派生量**：服务端不存、也不重算「可用面积」（那需要房间面，属于内核）。
   */
  @SuppressWarnings("unchecked")
  static String columnReading(Map<String, Object> state) {
    final Object box = state.get("columns");
    if (!(box instanceof List<?> list) || list.isEmpty()) return "";
    double area = 0;
    for (final Object o : list) {
      if (!(o instanceof Map<?, ?> c)) continue;
      final double w = num(c.get("w"));
      final double d = num(c.get("d"));
      if (Double.isFinite(w) && Double.isFinite(d)) area += w * d;
    }
    return "柱：**" + list.size() + " 根**（占 " + numText(Math.round(area * 100) / 100.0) + " m²）";
  }

  private static double num(Object o) {
    return o instanceof Number n ? n.doubleValue() : Double.NaN;
  }

  /** 人读的大小（README 里写 "1.2 MB"，不写 1234567 字节） */
  public static String human(long bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return String.format(Locale.ROOT, "%.1f KB", bytes / 1024.0);
    return String.format(Locale.ROOT, "%.1f MB", bytes / 1048576.0);
  }

  private static byte[] json(Map<String, Object> o) {
    try {
      return JSON.writerWithDefaultPrettyPrinter().writeValueAsBytes(o);
    } catch (Exception e) {
      throw new IllegalStateException("交付包里的 JSON 无法序列化（这是代码缺陷，不是数据问题）", e);
    }
  }

  private static Map<String, Object> mapOf(Object... kv) {
    final Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) m.put(String.valueOf(kv[i]), kv[i + 1]);
    return m;
  }

  /** 米 → 毫米整数（位置列用）。空值写空串，**不写 0**（0 与"不知道"长得一样） */
  private static String mm(Object meters) {
    if (!(meters instanceof Number n)) return "";
    return String.valueOf(Math.round(n.doubleValue() * 1000));
  }

  /** 数字：整数就不带小数点（90 而不是 90.0 / 90.00000001） */
  private static String numText(Object v) {
    if (!(v instanceof Number n)) return "";
    final double d = n.doubleValue();
    if (Math.abs(d - Math.rint(d)) < 1e-9) return String.valueOf((long) Math.rint(d));
    return String.format(Locale.ROOT, "%.3f", d).replaceAll("0+$", "").replaceAll("\\.$", "");
  }

  private static String footprint(Map<String, Object> p) {
    if (p == null) return "（目录里没有这一款）";
    return mm(p.get("w")) + "×" + mm(p.get("d")) + "×" + mm(p.get("h"));
  }

  private static String str(Object o) {
    return o == null ? "" : String.valueOf(o).trim();
  }

  private static String blankTo(String s, String fallback) {
    return s == null || s.isBlank() ? fallback : s;
  }

  /** CSV 字段：含逗号/引号/换行时用双引号包起来，内部引号翻倍（RFC4180） */
  private static String field(String s) {
    final String v = s == null ? "" : s;
    if (v.contains(",") || v.contains("\"") || v.contains("\n") || v.contains("\r")) {
      return "\"" + v.replace("\"", "\"\"") + "\"";
    }
    return v;
  }
}