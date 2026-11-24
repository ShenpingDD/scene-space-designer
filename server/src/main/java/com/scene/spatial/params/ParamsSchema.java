package com.scene.spatial.params;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ParamsSchema —— 参数表的**规格**（分组 / 每项的 label、单位、范围、是否可改、说明）
 *
 * ## 它从哪来
 *
 * `spatial-core/src/params.js` 里的 `PARAM_SPEC` 是**唯一一份**。
 * 由 `tools/export-params.mjs` 导出成 `server/src/main/resources/params-schema.json`（构建产物，勿手改）。
 * 所以后端**不重写一遍规则**：校验、表单、指纹三处用的是同一张表 —— 这是这张表能活下来的前提。
 *
 * ⚠️ **加载失败就响亮地失败**（构造器里抛）：这一份是接口契约的一部分。
 * 悄悄退化成"没有 schema、校验一律放过"是最坏的结果 —— 那等于后台可以写进任何东西。
 *
 * ## 为什么规格里 `admin:false` 也要留着
 *
 * `admin:false` 的 6 项（扫掠步长、扫掠容差、关门/全开位置、单步位移、出生点扫描步长）
 * 不是"藏起来"，而是「**不建议在后台改**」：它们和 Java 侧的口径必须一致，
 * 调了就会出现"两边算法不同口径"的隐蔽错。所以规格里留着，界面上显示但锁住并说明原因；
 * 接口也**拒绝**写它们，理由照 `help` 原文给出来。
 */
@Component
public class ParamsSchema {

  private static final ObjectMapper JSON = new ObjectMapper();
  private static final String RESOURCE = "/params-schema.json";

  /** 一项参数的全部规格 */
  public record Entry(String path, String group, String groupLabel, String key, String label, String unit,
                      double min, double max, double step, boolean admin, String help, Object def) {
  }

  private final Map<String, Object> raw;
  private final List<Map<String, Object>> groups;
  private final List<Entry> entries;
  private final Map<String, Entry> byPath;

  public ParamsSchema() {
    this.raw = load();
    this.groups = castList(raw.get("groups"));
    this.entries = buildEntries(groups);
    final Map<String, Entry> m = new LinkedHashMap<>();
    for (final Entry e : entries) m.put(e.path(), e);
    this.byPath = Map.copyOf(m);
  }

  @SuppressWarnings("unchecked")
  private static Map<String, Object> load() {
    try (InputStream in = ParamsSchema.class.getResourceAsStream(RESOURCE)) {
      if (in == null) {
        throw new IllegalStateException("类路径上找不到 " + RESOURCE
            + " —— 它由 tools/export-params.mjs 从 spatial-core/src/params.js 生成，"
            + "先跑 `npm run params`（构建里也会跑）");
      }
      return JSON.readValue(in, new TypeReference<Map<String, Object>>() {
      });
    } catch (Exception e) {
      throw new IllegalStateException("读不了参数规格 " + RESOURCE + "：" + e.getMessage(), e);
    }
  }

  @SuppressWarnings("unchecked")
  private static List<Map<String, Object>> castList(Object o) {
    return o instanceof List ? (List<Map<String, Object>>) o : List.of();
  }

  private static List<Entry> buildEntries(List<Map<String, Object>> groups) {
    final List<Entry> out = new ArrayList<>();
    for (final Map<String, Object> g : groups) {
      final String gid = String.valueOf(g.get("id"));
      final String glabel = String.valueOf(g.get("label"));
      for (final Map<String, Object> p : castList(g.get("params"))) {
        out.add(new Entry(
            String.valueOf(p.get("path")), gid, glabel, String.valueOf(p.get("key")),
            String.valueOf(p.get("label")), String.valueOf(p.get("unit")),
            num(p.get("min")), num(p.get("max")), num(p.get("step")),
            Boolean.TRUE.equals(p.get("admin")), String.valueOf(p.get("help")), p.get("default")));
      }
    }
    return List.copyOf(out);
  }

  private static double num(Object o) {
    return o instanceof Number ? ((Number) o).doubleValue() : 0;
  }

  /** 整份规格（`groups` + `flat` + 版本号）——**给前端表单直接用**，不要在后端重排一遍 */
  public Map<String, Object> raw() {
    return raw;
  }

  public List<Map<String, Object>> groups() {
    return groups;
  }

  public List<Entry> entries() {
    return entries;
  }

  public Entry entry(String path) {
    return byPath.get(path);
  }

  public int size() {
    return entries.size();
  }

  /** 默认值（path → 值）——方案指纹的基线、也是"没配就用它"的那一层 */
  public Map<String, Object> defaults() {
    final Map<String, Object> out = new LinkedHashMap<>();
    for (final Entry e : entries) out.put(e.path(), e.def());
    return out;
  }

  /**
   * 校验一份补丁。返回**问题清单**（空 = 通过）。
   *
   * 规则与 JS 侧 `validatePatch()` **一模一样**（同一份规格、同一套判据、同一批说法）：
   * 未知项 / 不是数字 / 超出范围 / 不允许在后台改 / 黄灯阈值不得高于或等于绿灯阈值。
   * 两边不一致的话，界面能改的接口改不了、或者反过来 —— 都很难查。
   *
   * ⚠️ **有一处是刻意不同的，别当成 bug**：JS 侧多一个 `allowNonAdmin` 选项，
   * 用于「把服务端发布的**整份生效值**装进内核」那条路（那份里本来就含 `admin:false` 的项：
   * 它们该生效，只是不许在后台改）。**这里（发布路径）永远拦**，
   * 因为"能不能改"这道门本来就该守在**写端**。读端跟着拦过一次，代价是内核整份被拒、
   * 退回默认值 —— 而界面上完全看不出来（只有 console 里一条 warn）。
   *
   * @param patch   要改的补丁（`{door: {openOkDeg: 85}}`）
   * @param current 当前生效值（算跨字段规则要用，如黄灯 vs 绿灯）
   */
  public List<Map<String, Object>> validate(Map<String, Object> patch, Map<String, Object> current) {
    final List<Map<String, Object>> errors = new ArrayList<>();
    if (patch == null || patch.isEmpty()) {
      errors.add(err("", "参数必须是对象（如 { door: { openOkDeg: 85 } }）"));
      return errors;
    }
    for (final Map.Entry<String, Object> g : patch.entrySet()) {
      final String gid = g.getKey();
      final Map<String, Object> group = groups.stream()
          .filter(x -> gid.equals(String.valueOf(x.get("id")))).findFirst().orElse(null);
      if (group == null) {
        errors.add(err(gid, "未知分组：" + gid + "（可用：" + groups.stream()
            .map(x -> String.valueOf(x.get("id"))).reduce((a, b) -> a + " / " + b).orElse("") + "）"));
        continue;
      }
      if (!(g.getValue() instanceof Map)) {
        errors.add(err(gid, "分组 " + gid + " 必须是对象"));
        continue;
      }
      @SuppressWarnings("unchecked")
      final Map<String, Object> fields = (Map<String, Object>) g.getValue();
      for (final Map.Entry<String, Object> f : fields.entrySet()) {
        final String path = gid + "." + f.getKey();
        final Object v = f.getValue();
        final Entry e = byPath.get(path);
        if (e == null) {
          errors.add(err(path, "未知参数：" + path + "（" + group.get("label") + " 里没有这一项）"));
          continue;
        }
        if (!(v instanceof Number) || !Double.isFinite(((Number) v).doubleValue())) {
          errors.add(err(path, path + " 必须是数字，收到 " + json(v)));
          continue;
        }
        final double d = ((Number) v).doubleValue();
        if (d < e.min() || d > e.max()) {
          errors.add(err(path, path + "（" + e.label() + "）超出范围：" + ParamsFingerprint.canonicalValue(v)
              + " 不在 " + ParamsFingerprint.canonicalValue(e.min()) + "~"
              + ParamsFingerprint.canonicalValue(e.max()) + e.unit() + " 之间"));
          continue;
        }
        if (!e.admin()) {
          errors.add(err(path, path + "（" + e.label() + "）不允许改：" + e.help()));
        }
      }
    }
    // 跨字段：单看每项都合法，组合起来是错的（与 JS 侧同两条）
    final double ok = dbl(patch, "door.openOkDeg", current);
    final double warn = dbl(patch, "door.openWarnDeg", current);
    if (warn > ok) {
      errors.add(err("door.openWarnDeg", "黄灯阈值（" + ParamsFingerprint.canonicalValue(warn)
          + "°）不能高于绿灯阈值（" + ParamsFingerprint.canonicalValue(ok) + "°）"
          + "—— 否则「黄灯」这个级别就没意义了"));
    } else if (warn == ok) {
      errors.add(err("door.openWarnDeg", "黄灯阈值与绿灯阈值相同：等于取消了黄灯级别（要取消请把黄灯设为 0）"));
    }
    return errors;
  }

  @SuppressWarnings("unchecked")
  private static double dbl(Map<String, Object> patch, String path, Map<String, Object> current) {
    final String[] parts = path.split("\\.");
    final Object fromPatch = patch.get(parts[0]) instanceof Map
        ? ((Map<String, Object>) patch.get(parts[0])).get(parts[1]) : null;
    final Object v = fromPatch != null ? fromPatch : current.get(path);
    return v instanceof Number ? ((Number) v).doubleValue() : Double.NaN;
  }

  private static Map<String, Object> err(String path, String message) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("path", path);
    m.put("message", message);
    return m;
  }

  private static String json(Object v) {
    try {
      return JSON.writeValueAsString(v);
    } catch (Exception e) {
      return String.valueOf(v);
    }
  }
}