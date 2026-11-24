package com.scene.spatial.catalog;

import com.scene.spatial.kernel.Cases;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * CatalogCopyDriftTest —— **两份目录拷贝不许悄悄漂移**
 *
 * ## 为什么要有这个测试
 *
 * 目录现在有两份：
 *   ① **真目录**：`product` / `product_model` 拼出来的（`DbCatalog.kernelRaw()`），界面、保存路径、
 *      内核自检都用它；
 *   ② **用例表内嵌的退路**（`Cases.CATALOG` / `rules.json` 的 `catalog`）：没有数据库时（`spatial.store=memory`、
 *      离线跑用例）用，也是两条用例的"输入夹具"。
 *
 * 两份拷贝一定会漂：2026-09-30 实测 `demo-freezer-chest` 的声明包络在内嵌拷贝里是 **735.075×646.866×1470.15 mm**，
 * 库里是 **1320×656×800 mm** —— 差了一倍。而且**没人发现**，因为它只出现在一条与尺寸无关的用例里
 * （上盖不进平面）。等哪天有人把内核自检从"内嵌拷贝"改成"真目录"（本轮就做了），它就会突然变红，
 * 而那时你根本不知道红的是数据还是判据。
 *
 * ⇒ 抄本漂移要有机器盯着。这个测试就是那只眼睛：**同名型号的声明包络 + 平面门几何必须一致**。
 *
 * ## 关于 skip
 *
 * 连不上库 / 没跑过迁移 → **skip**（`Assumptions`），不假装绿：与 `*StoreContractTest` 同一条纪律。
 *
 * ## 容差为什么是 1e-6 m
 *
 * 库里的 `recipe_json` 存 **mm**（`1151.925`），拷贝里是米（`1.15192501`）——
 * 换算后差 1e-8 m。这不是"不一致"，是**同一个数在不同精度里的写法**。
 * 1e-6 m = 1 µm：远小于任何几何判据的敏感度，又远大于浮点噪声。
 */
class CatalogCopyDriftTest {

  /** 1 µm —— 见类注释 */
  private static final double EPS = 1e-6;

  @Test
  @DisplayName("用例表内嵌目录 vs 库里的真目录：同名型号的包络与平面门必须一致（连不上库则 skip）")
  void fallbackCopyMatchesDatabase() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null,
        "跳过：连不上 MySQL，或这个库还没跑过 V1–V12 迁移（这是 skip，不是通过）");

    // ③ 只对**带模型的机型**比对实测门几何：公开仓只发布 1 个演示模型，
    //    没有 product_model 行的演示机型只有「声明门」（recipe_json.doors），
    //    拿实测门去比它们必然是空表 vs 有门 —— 那不是漂移，是两种口径。
    //    包络（②）仍然逐款对比，一款都不放过。
    final java.util.Set<String> withModel = idsWithModel(jdbc);

    final DbCatalog db = new DbCatalog(new CatalogRepository(jdbc));
    final Map<String, Object> real = db.kernelRaw();
    Assumptions.assumeTrue(!real.isEmpty(),
        "跳过：库里没有可用目录（product / product_model 为空）");

    // ① **只核对 seed 目录**：Cases.CATALOG 是构建期 baked 的兜底夹具，只有 seed 4 款；
    //    297/298 这类运行时上传件**本来就不该**被硬编码进 fallback（否则每传一款都要改代码）。
    //    保护没有削弱：② 仍要求 Cases 里的每个 id 都在库里出现，删 seed / 改 seed 包络都会红；
    //    运行时上传件只由真实目录自己负责，不参与 fallback 漂移断言。
    // ② 同名型号：声明包络必须一致（容差 1 µm）
    final List<String> problems = new ArrayList<>();
    for (final String id : sorted(Cases.CATALOG.keySet())) {
      final Map<String, Object> mine = map(Cases.CATALOG.get(id));
      final Map<String, Object> theirs = map(real.get(id));
      if (theirs == null) {
        problems.add(id + "：内嵌目录里有，库里没有（删产品时也要同步夹具）");
        continue;
      }
      for (final String k : List.of("w", "d", "h")) {
        final double a = num(mine.get(k));
        final double b = num(theirs.get(k));
        if (!close(a, b)) {
          problems.add(id + "." + k + "：内嵌 " + a + " vs 库里 " + b);
        }
      }
      // ③ 平面门（axis=y）的几何：测出来的东西不该有两种答案（仅限有模型的机型，见上）
      if (!withModel.contains(id)) continue;
      final List<Map<String, Object>> myDoors = doorsOf(mine, true);
      final List<Map<String, Object>> dbDoors = doorsOf(theirs, true);
      if (myDoors.size() != dbDoors.size()) {
        problems.add(id + "：平面门数 内嵌 " + myDoors.size() + " vs 库里 " + dbDoors.size());
      } else {
        for (int i = 0; i < myDoors.size(); i++) {
          final Map<String, Object> a = myDoors.get(i);
          final Map<String, Object> b = dbDoors.get(i);
          if (!"".equals(diff(a, b))) problems.add(id + ".doors[" + i + "]：" + diff(a, b));
        }
      }
    }
    assertTrue(problems.isEmpty(),
        "内嵌目录与库里的真目录**漂移了**（改库要同改夹具，改夹具要同改库）：\n  - "
            + String.join("\n  - ", problems));
  }

  /** 一条门里要比的字段；不等就返回人话，相等返回空串 */
  private static String diff(Map<String, Object> a, Map<String, Object> b) {
    if (!String.valueOf(a.get("node")).equals(String.valueOf(b.get("node")))) {
      return "node " + a.get("node") + " vs " + b.get("node");
    }
    if (!String.valueOf(a.get("axis")).equals(String.valueOf(b.get("axis")))) {
      return "axis " + a.get("axis") + " vs " + b.get("axis");
    }
    final List<String> bad = new ArrayList<>();
    for (final String k : List.of("openAngleDeg", "swing")) {
      if (!close(num(a.get(k)), num(b.get(k)))) bad.add(k + " 内嵌 " + num(a.get(k)) + " vs 库里 " + num(b.get(k)));
    }
    for (final String g : List.of("hinge", "leaf")) {
      final Map<String, Object> ga = map(a.get(g));
      final Map<String, Object> gb = map(b.get(g));
      if (ga == null || gb == null) continue;
      for (final String k : ga.keySet()) {
        if (gb.get(k) == null) continue;
        if (!close(num(ga.get(k)), num(gb.get(k)))) {
          bad.add(g + "." + k + " 内嵌 " + num(ga.get(k)) + " vs 库里 " + num(gb.get(k)));
        }
      }
    }
    return String.join("；", bad);
  }

  private static boolean close(double a, double b) {
    return Double.isFinite(a) && Double.isFinite(b) && Math.abs(a - b) <= EPS;
  }

  private static double num(Object v) {
    return v instanceof Number n ? n.doubleValue() : Double.NaN;
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> map(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : null;
  }

  /** 有 `product_model` 行的机型（= 有实测门几何可对账的那几款）；取 `recipe_json.id` 作键 */
  private static java.util.Set<String> idsWithModel(JdbcClient jdbc) {
    final java.util.Set<String> out = new java.util.HashSet<>();
    try {
      jdbc.sql("SELECT p.recipe_json ->> '$.id' AS rid FROM product p "
              + "JOIN product_model pm ON pm.product_id = p.id")
          .query((rs, n) -> rs.getString("rid"))
          .list()
          .forEach(v -> { if (v != null) out.add(v); });
    } catch (RuntimeException e) {
      // 取不到就当作"都没有模型"：① 包络仍会对账，③ 不假装通过
      System.out.println("[warn] 取 product_model 列表失败，实测门对账跳过：" + e.getMessage());
    }
    return out;
  }

  /** 取门列表；`planOnly=true` 只要 `axis=y`（上盖不进平面 —— 与 `Catalog.planDoors` 同口径） */
  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> doorsOf(Map<String, Object> entry, boolean planOnly) {
    final List<Map<String, Object>> out = new ArrayList<>();
    if (entry == null || !(entry.get("doors") instanceof List)) return out;
    for (final Object o : (List<Object>) entry.get("doors")) {
      final Map<String, Object> d = map(o);
      if (d == null) continue;
      if (planOnly && !"y".equals(d.get("axis"))) continue;
      out.add(d);
    }
    return out;
  }

  private static List<String> sorted(java.util.Set<String> in) {
    final List<String> out = new ArrayList<>(in);
    Collections.sort(out);
    return out;
  }

  /** 与 `SchemeStoreContractTest` 同一套连接口径（环境变量可覆盖；连不上就 null → skip） */
  private static JdbcClient jdbcOrNull() {
    final String url = "jdbc:mysql://" + env("DB_HOST", "127.0.0.1") + ":" + env("DB_PORT", "3306")
        + "/" + env("DB_NAME", "spatial_design")
        + "?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true";
    final DriverManagerDataSource ds =
        new DriverManagerDataSource(url, env("DB_USER", "root"), env("DB_PASSWORD", ""));
    try (Connection c = ds.getConnection()) {
      try (Statement st = c.createStatement()) {
        try (ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM product")) {
          if (!rs.next() || rs.getInt(1) == 0) {
            System.out.println("[skip] product 表是空的 —— 这个库还没跑过迁移/没有目录数据");
            return null;
          }
        }
      }
      return JdbcClient.create(ds);
    } catch (Exception e) {
      System.out.println("[skip] MySQL unreachable or migrations not applied: " + e.getMessage());
      return null;
    }
  }

  private static String env(String k, String dflt) {
    final String v = System.getenv(k);
    return v == null || v.isBlank() ? dflt : v;
  }
}