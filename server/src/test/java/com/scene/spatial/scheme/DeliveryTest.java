package com.scene.spatial.scheme;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * DeliveryTest —— 交付包组装规则（**全是纯函数**，所以不碰库、不看时钟）
 *
 * 这一批用例想钉住的是"包里的每个数都是从哪儿来的"：
 *   · 位置是**方案里的原始 x/z**（不是推算的中心点）；
 *   · CSV 是 **Excel 打开不乱码**的那个形状（BOM + CRLF + 引号转义）；
 *   · README 里**参数版本**必须在（设计决策记录 §3.4 点名的那一条）；
 *   · 老方案没有结论时说的是「没有存下」而**不是**「当时没问题」。
 */
class DeliveryTest {

  /** 一份最小的方案 state（形状与真库一致：w/d/h 米、items 里 p 是运行时目录 id） */
  private static Map<String, Object> state() {
    final Map<String, Object> s = new LinkedHashMap<>();
    s.put("w", 8.0);
    s.put("d", 6.0);
    s.put("h", 2.8);
    s.put("walls", List.of());
    s.put("items", List.of(
        item("demo-cabinet-800", 0.7, 0.7, 0.0),
        item("demo-cabinet-800", 4.5, 1.2, 90.0),
        item("demo-freezer-chest", 6.0, 4.0, 180.0)));
    return s;
  }

  private static Map<String, Object> item(String p, double x, double z, double r) {
    final Map<String, Object> i = new LinkedHashMap<>();
    i.put("p", p);
    i.put("x", x);
    i.put("z", z);
    i.put("r", r);
    i.put("id", 1);
    i.put("doorAmount", 0.0);
    return i;
  }

  private static Map<String, Map<String, Object>> catalog() {
    final Map<String, Map<String, Object>> by = new LinkedHashMap<>();
    // ⚠️ 与真目录同口径：`DbCatalog.shapeProduct` 给的是**米**（库里 mm ÷ 1000）
    by.put("demo-cabinet-800", product("DEMO-CT-100", "超低温保存箱, 立式", 0.86, 0.99, 1.99, "厂家规格书 2024"));
    by.put("demo-freezer-chest", product("DEMO-FZ-25C", "低温保存箱", 1.32, 0.73, 0.85, ""));
    return by;
  }

  /** 名称里**故意带一个逗号** —— CSV 的引号转义要真的被走一遍 */
  private static Map<String, Object> product(String model, String name, double w, double d, double h, String sizeNote) {
    final Map<String, Object> p = new LinkedHashMap<>();
    p.put("model", model);
    p.put("name", name);
    p.put("w", w);
    p.put("d", d);
    p.put("h", h);
    p.put("sizeNote", sizeNote);
    p.put("file", "");
    return p;
  }

  @Test
  @DisplayName("柱读数：README 只在有柱时写「N 根（占 X m²）」，无柱方案一字不加")
  void readmeColumnReading() {
    final Map<String, Object> withColumns = state();
    withColumns.put("columns", List.of(column(1, 4.2, 2.5, 0.5, 0.5), column(2, 1.0, 1.0, 0.2, 0.3)));
    final String md = new String(Delivery.readme(withColumns, catalog(), "柱库房", 9L, 1, 85, 12L,
        "本地目录", "2026-10-23 09:00", "1", List.of(), false, List.of(), null),
        java.nio.charset.StandardCharsets.UTF_8);
    assertTrue(md.contains("柱：**2 根**（占 0.31 m²）"), "柱读数要跟着「房间」一行：\n" + md);

    final String noColumns = new String(Delivery.readme(state(), catalog(), "无柱库房", 9L, 1, 85, 12L,
        "本地目录", "2026-10-23 09:00", "1", List.of(), false, List.of(), null),
        java.nio.charset.StandardCharsets.UTF_8);
    assertFalse(noColumns.contains("柱："), "没有柱就不许出现这一行（旧 README 字节不变）");
  }

  private static Map<String, Object> column(int id, double x, double z, double w, double d) {
    final Map<String, Object> c = new LinkedHashMap<>();
    c.put("id", id);
    c.put("x", x);
    c.put("z", z);
    c.put("w", w);
    c.put("d", d);
    return c;
  }

  @Test
  @DisplayName("勾选名单：不认识的 id 要点名；必需的件无论勾没勾都在；顺序跟注册表走")
  void selectionIsExplicit() {
    final IllegalArgumentException e = assertThrows(IllegalArgumentException.class,
        () -> Delivery.selected(List.of("json", "shot")));
    assertTrue(e.getMessage().contains("shot"), "要把那串不认识的 id 原样说出来：" + e.getMessage());
    assertTrue(e.getMessage().contains("shots"), "也要把可选的那几项列出来：" + e.getMessage());

    final List<String> onlyJson = Delivery.selected(List.of("json")).stream().map(Delivery.Item::id).toList();
    // README 与 方案.json 是包的根：不勾也在
    assertTrue(onlyJson.contains("readme"), "README 是必需的：" + onlyJson);
    assertTrue(onlyJson.contains("json"), "方案.json 是必需的：" + onlyJson);
    assertFalse(onlyJson.contains("csv"), "没勾的不能自己冒出来：" + onlyJson);

    // 顺序 = 注册表顺序（README 第一，解压出来第一眼就该看到它）
    final List<String> all = Delivery.selected(Delivery.ITEMS.stream().map(Delivery.Item::id).toList())
        .stream().map(Delivery.Item::id).toList();
    assertEquals(List.of("json", "plan", "shots", "cover", "csv", "report", "readme"), all);
  }

  @Test
  @DisplayName("设备清单.csv：BOM + CRLF + 按型号汇总 + 位置是方案里的原始 x/z（米→毫米）+ 房间列")
  void csvIsExcelSafeAndKeepsRawPositions() {
    final String csv = new String(Delivery.csv(state(), catalog()), StandardCharsets.UTF_8);

    assertTrue(csv.startsWith("\uFEFF"), "必须有 UTF-8 BOM，否则 Excel 里中文型号是乱码");
    assertTrue(csv.contains("\r\n"), "行尾要用 CRLF");
    assertTrue(csv.contains("型号,名称,数量,位置(mm),房间,朝向(度),开门量,占地(宽×深×高 mm)"));
    // M1：没递房间名时**写「未分房间」，不许留空** —— 空格子会被当成"漏画了"
    assertTrue(csv.contains(Delivery.NO_ROOM), "没给房间时要如实写未分房间：" + csv);

    // demo-cabinet-800 摆了两台 → 一行、数量 2、两处位置都在；位置是原始值的毫米数
    final String row = lineOf(csv, "DEMO-CT-100");
    assertTrue(row.contains(",2,"), "同一型号要汇总成一行、数量 2：" + row);
    assertTrue(row.contains("(700,700)"), "位置要来自方案里的 x/z（0.7 → 700）：" + row);
    assertTrue(row.contains("(4500,1200)"), "第二台也要在：" + row);
    assertTrue(row.contains("\"超低温保存箱, 立式\""), "名称里有逗号 → 整格要用双引号包起来：" + row);
    assertTrue(row.contains("860×990×1990"), "占地要写出来（声明包络，毫米）：" + row);
  }

  @Test
  @DisplayName("设备清单.csv 的房间列：递进来就写那一间，同一型号分散在两间时按位置一一对应")
  void csvWritesRoomsItWasGiven() {
    // 房间名由**客户端**递进来（派生面只在 JS 内核里算一份，不在 Java 侧重写）——
    // 这里只验"给了就写对、没给就写未分房间"这一件事。
    // ⚠️ 夹具里的三台设备 id 都是 1（老测试用的够），这里要的是**两台分在两间**，
    //    所以就地造一份 id 不同的 state —— 改公共夹具会牵动别的用例。
    final Map<String, Object> local = new LinkedHashMap<>();
    local.put("w", 8.0);
    local.put("d", 6.0);
    local.put("h", 2.8);
    local.put("walls", List.of());
    local.put("items", List.of(itemWithId("demo-cabinet-800", 0.7, 0.7, 1), itemWithId("demo-cabinet-800", 4.5, 1.2, 2)));

    final Map<String, String> rooms = new LinkedHashMap<>();
    rooms.put("1", "冰箱间");
    rooms.put("2", "离心机房");
    final String csv = new String(Delivery.csv(local, catalog(), rooms), StandardCharsets.UTF_8);
    final String row = lineOf(csv, "DEMO-CT-100");
    assertTrue(row.contains("冰箱间; 离心机房"), "两台分在两间时要按位置一一对应：" + row);
    assertTrue(!row.contains(Delivery.NO_ROOM), "给全了就不该出现未分房间：" + row);

    // 只给一台：另一台如实写未分房间（不猜、不留空）
    final Map<String, String> half = new LinkedHashMap<>();
    half.put("1", "冰箱间");
    final String csv2 = new String(Delivery.csv(local, catalog(), half), StandardCharsets.UTF_8);
    final String row2 = lineOf(csv2, "DEMO-CT-100");
    assertTrue(row2.contains("冰箱间; " + Delivery.NO_ROOM), "缺的那台要写未分房间：" + row2);
  }

  private static Map<String, Object> itemWithId(String p, double x, double z, int id) {
    final Map<String, Object> i = item(p, x, z, 0.0);
    i.put("id", id);
    return i;
  }

  @Test
  @DisplayName("目录里没有那一款时，CSV/README 都要如实写「没有」，不许编一个名字")
  void missingCatalogEntryIsSaidOutLoud() {
    final Map<String, Map<String, Object>> partial = new LinkedHashMap<>();
    partial.put("demo-freezer-chest", catalog().get("demo-freezer-chest"));   // demo-cabinet-800 故意不给
    final String csv = new String(Delivery.csv(state(), partial), StandardCharsets.UTF_8);
    assertTrue(csv.contains("（目录里没有这一款）"), csv);
    final String readme = new String(Delivery.readme(state(), partial, "测试方案", 7L, 3, 85, 12L,
        "数据库", "2026-09-30T10:00", "local", List.of(new Delivery.Entry("README.md", new byte[]{1})),
        false, List.of(), null), StandardCharsets.UTF_8);
    assertTrue(readme.contains("（目录里没有这一款）"), readme);
  }

  @Test
  @DisplayName("README：参数版本必须在最前面，三个固定视角要写清楚，没带的要列出来")
  void readmeLeadsWithTheParamsVersion() {
    final Map<String, Object> stored = new LinkedHashMap<>();
    stored.put("paramsRev", 85);
    stored.put("catalogRev", 12);
    stored.put("at", "2026-09-30T09:00");
    final Map<String, Object> report = new LinkedHashMap<>();
    report.put("items", 3);
    report.put("issues", 0);
    report.put("trouble", 1);
    stored.put("report", report);

    final List<Delivery.Entry> entries = new ArrayList<>();
    entries.add(new Delivery.Entry("README.md", "x".getBytes(StandardCharsets.UTF_8)));
    entries.add(new Delivery.Entry("平面图.svg", "<svg/>".getBytes(StandardCharsets.UTF_8)));
    final String md = new String(Delivery.readme(state(), catalog(), "冷藏库房 B 区", 5L, 3, 85, 12L,
        "数据库", "2026-09-30T10:00", "local", entries, true, List.of("封面.png（这一份还没有封面）"), stored),
        StandardCharsets.UTF_8);

    assertTrue(md.contains("**规则参数版本**"), "参数版本要有一行且写全：" + md);
    assertTrue(md.contains("| 85（") || md.contains("85（体检结论"), "要写第 85 版：" + md);
    assertTrue(md.contains("第 3 版"), "方案版本要写：" + md);
    assertTrue(md.contains("正上方俯视") && md.contains("正面斜 45°") && md.contains("斜角 45°"),
        "三个视角要说清是哪三个（A13）：" + md);
    assertTrue(md.contains("封面.png（这一份还没有封面）"), "没带上的要说出来：" + md);
    assertTrue(md.contains("门开不到底"), "体检结论里规则 7 那一条要有人话：" + md);
    assertTrue(md.contains("尺寸可信度"), "规格没核对的要提醒（不能让人以为是核对过的）：" + md);
  }

  @Test
  @DisplayName("老方案（没有结论）说的是「没有存下」＋「不等于当时没问题」，不是「没问题」")
  void oldSchemeSaysNotStoredNotAllClear() {
    final String md = new String(Delivery.readme(state(), catalog(), "老方案", 1L, 1, 358430008, 12L,
        "数据库", "2026-09-30T10:00", "local", List.of(), false, List.of(), null),
        StandardCharsets.UTF_8);
    assertTrue(md.contains("没有存下当时的结论"), md);
    assertTrue(md.contains("这不等于当时没问题"), "这一句是必须的 —— 少它就是拿沉默当好话：" + md);

    final String rep = new String(Delivery.reportJson(null, Map.of("items", 3), 358430008, 85, 12L,
        1L, 1), StandardCharsets.UTF_8);
    assertTrue(rep.contains("\"stored\" : null"), rep);
    assertTrue(rep.contains("storedWhy"), "要说清为什么没有：" + rep);
    assertTrue(rep.contains("不等于当时没问题"), rep);
  }

  @Test
  @DisplayName("方案.json：格式与 state 与界面导出的同一形状，多出来的元信息在外层")
  void planJsonKeepsTheImportableShape() {
    final String json = new String(Delivery.planJson(state(), "legacy-spatial-doors-v4", 5L,
        "冷藏库房 B 区", 3, 85, 12, "2026-09-30T10:00"), StandardCharsets.UTF_8);
    assertTrue(json.contains("\"format\" : \"legacy-spatial-doors-v4\""), json);
    // state 里就是 {w,d,h,walls,items} —— 内核要能照着导回来
    assertTrue(json.contains("\"state\""), json);
    assertTrue(json.contains("\"w\" : 8.0"), json);
    assertTrue(json.contains("\"paramsRev\" : 85"), json);
    assertTrue(json.contains("\"schemeRev\" : 3"), json);
    // 元信息在 delivery 里，**不在 state 里** —— 塞进 state 会被内核当未知字段丢掉
    final int stateAt = json.indexOf("\"state\"");
    assertTrue(json.indexOf("packagedAt") > stateAt, "元信息应当排在 state 之后（外层）：" + json);
  }

  @Test
  @DisplayName("打包：能解回来、中文文件名不乱码、顺序就是给的顺序")
  void zipRoundTripsWithChineseNames() throws Exception {
    final List<Delivery.Entry> entries = List.of(
        new Delivery.Entry("README.md", "说明".getBytes(StandardCharsets.UTF_8)),
        new Delivery.Entry("三维截图-1-俯视.png", new byte[]{(byte) 0x89, 'P', 'N', 'G'}),
        new Delivery.Entry("附件/DEMO-86.glb", new byte[]{1, 2, 3, 4}));
    final byte[] zip = Delivery.zip(entries);
    assertEquals('P', zip[0]);
    assertEquals('K', zip[1]);

    final List<String> names = new ArrayList<>();
    final Map<String, byte[]> byName = new LinkedHashMap<>();
    try (ZipInputStream in = new ZipInputStream(new ByteArrayInputStream(zip), StandardCharsets.UTF_8)) {
      ZipEntry e;
      while ((e = in.getNextEntry()) != null) {
        names.add(e.getName());
        byName.put(e.getName(), in.readAllBytes());
      }
    }
    assertEquals(List.of("README.md", "三维截图-1-俯视.png", "附件/DEMO-86.glb"), names);
    assertEquals("说明", new String(byName.get("README.md"), StandardCharsets.UTF_8));
    assertEquals(4, byName.get("附件/DEMO-86.glb").length);
    assertNotNull(byName.get("三维截图-1-俯视.png"));
  }

  @Test
  @DisplayName("按型号分组：认的是 item 的 p（运行时目录 id），不是行 id")
  void groupByModelUsesRuntimeId() {
    final Map<String, List<Map<String, Object>>> g = Delivery.groupByModel(state());
    assertEquals(2, g.size());
    assertEquals(2, g.get("demo-cabinet-800").size());
    assertEquals(1, g.get("demo-freezer-chest").size());
  }

  @Test
  @DisplayName("人读的大小与 md5：README 里写的是 KB/MB，不是一长串字节数")
  void humanAndMd5() {
    assertEquals("512 B", Delivery.human(512));
    assertTrue(Delivery.human(2048).startsWith("2.0 KB"));
    assertTrue(Delivery.human(3 * 1024 * 1024).startsWith("3.0 MB"));
    assertEquals(32, Delivery.md5("abc".getBytes(StandardCharsets.UTF_8)).length());
  }

  private static String lineOf(String csv, String contains) {
    for (final String line : csv.split("\r\n")) {
      if (line.contains(contains)) return line;
    }
    throw new AssertionError("CSV 里没有含 " + contains + " 的行：\n" + csv);
  }
}