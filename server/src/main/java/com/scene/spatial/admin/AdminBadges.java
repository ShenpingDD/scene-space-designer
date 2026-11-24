package com.scene.spatial.admin;

import com.scene.spatial.kernel.Params;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * AdminBadges —— 产品卡片上的**角标**（分诊）
 *
 * 维护端列表的价值不是"展示"，是**分诊**：管理员要一眼看出**哪条该动手**。
 * 所以每个角标都必须有**可核的判据**，判据全部来自库里的列 —— 不许猜、不许"大概有问题"。
 *
 * 「门型未确认」这个角标**曾经故意不发**：它要的 `product.door_verified` 列当时还不存在
 *   （那一列属 V9）。**宁可少一个角标，也不许假装能判** —— 假角标比没角标更坏。
 *   V9 把列补上了（V10 回填），**所以现在发了**；同理新增「缩放不均匀」（要 `anisotropy_ok`）。
 *
 * 纯函数：输入一行（Map），输出角标数组。这样它能被单测钉住（见 AdminBadgesTest）。
 */
public final class AdminBadges {

  private AdminBadges() {
  }

  /** 必须修：不修前台就是坏的 */
  public static final String BAD = "bad";
  /** 该修：不影响能用，但影响体验或可信度 */
  public static final String WARN = "warn";
  /** 仅提示：状态性的，不是毛病 */
  public static final String OFF = "off";

  /** “供应商/用户按规范交的” — 唯一一个这种来源（其余来源见 ProductDraft.ORIGINS） */
  public static final String SUPPLIER_ORIGIN = "用户原始模型";

  /**
   * 按一行产品（含默认变体）算角标。
   *
   * 顺序即**重要度顺序**：列表上先看到"必须修的"。
   */
  public static List<Map<String, Object>> of(Map<String, Object> row) {
    final List<Map<String, Object>> out = new ArrayList<>();
    final boolean hasModel = !blank(row.get("file_path"));
    final boolean disabled = "disabled".equals(str(row.get("status")));

    if (!hasModel) {
      out.add(b(BAD, "无模型", "没有 GLB —— 前台放不出 3D，必须补"));
    } else {
      if (blank(row.get("thumb_file"))) {
        out.add(b(WARN, "缺缩略图", "前台型号卡会退化成色块（现渲染仍可用）"));
      }
      // ⚠️ 这一列的语义**随 mode 变**（见 tools/models/verify-models.py:399-415）：
      //   mode=1:1 → envelope_ok 说的是"声明尺寸与实测是否一致" ← 这才是"对账"
      //   mode=fit → envelope_ok 说的是"缩放后能不能放进声明包络" ← **不是**"尺寸对不对"
      // 第一版不分 mode 一律报「尺寸未对账」，把 demo-freezer-dual 冤枉了：它是 fit（实测 525.5×990×517
      // vs 声明 990×1980×871），本来就不同 —— 这是常态，不是毛病。
      // **同一个字段在不同模式下不是同一件事**，这种地方不写清楚必然误报。
      final String mode = str(row.get("envelope_mode"));
      if ("1:1".equals(mode)) {
        // ⚠️ 三态：**没读数 ≠ 判为否**。以前这一列是 NOT NULL DEFAULT 1，缺读数被写成 0/1 两个结论，
        //    而"没判过"这个真实状态根本没地方放（第 2 轮审查 dev-1/dev-2；V15 把列改成可为空）。
        if (isNull(row.get("envelope_ok"))) {
          out.add(b(WARN, "尺寸未判", "这份模型没带尺寸对账读数（旧记录，或入库时没填声明尺寸）—— "
              + "1:1 的声明与实测是否一致，现在答不上来；改完声明尺寸重存一次就会判"));
        } else if (!truthy(row.get("envelope_ok"))) {
          // 容差**从参数表拼出来**，不在文案里写第二份（第 3 轮审查 C-10：这句原来写死「1 mm」，
          // 而设计端 scene3d.js 判 5 mm —— 同一个模型在维护端挂角标、在设计端报合格）。
          out.add(b(WARN, "尺寸未对账", "1:1 模型的声明尺寸与实测不符（差 > "
              + Params.modelEnvelopeTolMm + " mm）—— 引用它的方案几何不可信"));
        }
      } else if (!mode.isEmpty()) {
        // fit 模型只能报"它不是 1:1"这个**事实**，不能报成"有问题"。
        // （真正该查的各轴缩放是否均匀 = anisotropy_ok，**V9 补上了** → 见下面那条角标）
        out.add(b(WARN, "非 1:1", "按声明尺寸缩放（envelope_mode=" + mode + "）：声明包络与实物不同，属常态；倍率由前端按配方算"));
        // 「缩放不均匀」：fit 下真正该查的判据（V9 新增列）。各轴缩放不一致 = 模型被按轴拉伸过
        // → 比例失真。**只在 fit 下看**：1:1 根本没做缩放，这一列对它无意义（V11 里已说明）。
        if (isNull(row.get("anisotropy_ok"))) {
          out.add(b(WARN, "缩放未判", "这份模型没带比例读数（旧记录，或入库时没填声明尺寸）—— "
              + "各轴缩放是否均匀现在答不上来"));
        } else if (!truthy(row.get("anisotropy_ok"))) {
          out.add(b(WARN, "缩放不均匀", "各轴缩放不一致 → 模型比例被拉伸过；量出来的是声明包络，不是实物比例"));
        }
      }
    }
    // 「门型未填」与「门型未确认」是**两件事**：
    //   · 没填（空值） = 连"是什么门"都没有，旧代码会兜底成柜门 → 凭空造一扇门。角标要说出来。
    //   · 未确认（door_verified=0）= 填了但没人确认过 → 规则7 的开门净空体检**算不准**。
    // 显式 none（已验证无门）两者都不发：那是已知事实，不是缺口。
    final String doorPart = str(row.get("door_part"));
    if (doorPart.isEmpty()) {
      out.add(b(WARN, "门型未填", "门型（door_part）是空的 —— 没填 ≠ 没有门；"
          + "请填 single/double/top/drawer；确无任何可动件时显式写 none 并置 door_verified=1"));
    } else if (!truthy(row.get("door_verified")) && !"none".equals(doorPart)) {
      // 判据来自 product.door_verified（V9 新增 + V10 回填）。来源代码一起带上，便于判断可不可信。
      final String src = str(row.get("door_source"));
      out.add(b(WARN, "门型未确认", "门型没确认过 → 规则7 开门净空体检算不准（这不是「没有门」）；来源代码=" + (src.isEmpty() ? "(空)" : src)));
    }
    // 「非供应商交付」（决策⑨：供应商未按规范交 → 人工代录 + origin 留痕）。
    // 判据就是库里的字面值，不是我猜的：只有「用户原始模型」是供应商/用户按规范交的，
    // 其余（官网外观重建 / 官网系列外形 / 人工代录 / 维护端新增）都是**人从别处凑出来的** →
    // 尺寸与门型的可信度要按 size_note 那一列读，不能当实测。
    // ⚠️ size_note 空着**本身就是问题**（这一列的意义就是让人写清楚），所以这句话要说到。
    final String origin = str(row.get("origin"));
    if (!origin.isEmpty() && !SUPPLIER_ORIGIN.equals(origin)) {
      final String note = str(row.get("size_note"));
      out.add(b(WARN, "非供应商交付", "来源：" + origin + "（不是供应商按规范交的模型）；尺寸可信度："
          + (note.isEmpty() ? "**没写** —— size_note 空着就是说不上来有多可信" : note)));
    }
    if (disabled) {
      out.add(b(OFF, "已停用", "不再出现在料仓里；已存的方案照常打开"));
    }
    return out;
  }

  /** 有没有"必须修"的角标（给列表做一键筛选用） */
  public static boolean hasBad(List<Map<String, Object>> badges) {
    for (final Map<String, Object> x : badges) {
      if (BAD.equals(x.get("level"))) return true;
    }
    return false;
  }

  private static Map<String, Object> b(String level, String text, String why) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("level", level);
    m.put("text", text);
    m.put("why", why);
    return m;
  }

  private static String str(Object o) {
    return o == null ? "" : String.valueOf(o).trim();
  }

  private static boolean blank(Object o) {
    return str(o).isEmpty();
  }

  /** 这一格**根本没读数**（NULL / 空串）—— 与"读了、结论是否"是两件事 */
  private static boolean isNull(Object o) {
    if (o == null) return true;
    return o instanceof String s && s.trim().isEmpty();
  }

  private static boolean truthy(Object o) {
    if (o == null) return false;
    if (o instanceof Boolean b) return b;
    if (o instanceof Number n) return n.intValue() != 0;
    final String s = str(o);
    return "1".equals(s) || "true".equalsIgnoreCase(s);
  }
}
