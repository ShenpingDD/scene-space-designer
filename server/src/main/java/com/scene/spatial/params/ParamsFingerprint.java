package com.scene.spatial.params;

import com.scene.spatial.kernel.Params;

import java.math.BigDecimal;
import java.util.Map;

/**
 * ParamsFingerprint —— 参数表指纹（**按生效值算**，与 JS 侧 `fingerprint()` 逐位等价）
 *
 * ## 为什么要有这个类（把一个真实的缺口说清楚）
 *
 * `Params.fingerprint()`（**生成**的那个）的输入是 `FINGERPRINT_INPUT` = `path=默认值` ——
 * 也就是说**它只随代码里的默认值变，不随后台改过的值变**。而它的注释写着
 * 「参数一改指纹就变」。后台真上线之后，这句话就不成立了 ✗：
 * 改了 `door.openOkDeg` 90 → 85，指纹**一动不动**，于是「这份方案是按哪版参数摆的」也答不出来。
 *
 * 所以指纹的输入改成**生效值**（默认值被 `app_config` 覆盖后的那一份），
 * 顺序仍取 `FINGERPRINT_INPUT`（它是按 `PARAM_SPEC` 顺序生成的，两边同序）。
 *
 * ## 三条必须一起读
 *
 * 1. **必须与 JS 侧算出同一个数。** 方案落库时是这里写 `params_rev`，
 *    前端与内核缓存键用 JS 侧那个值。两边不一致 = 同一个配置有两个指纹 ——
 *    而这种错**不会报错**，只会让缓存莫名失效、"同一份方案复现不出来"。
 * 2. 所以两边**各有一条钉住同一个字面量的测试**：默认配置 = `1050039603（W2 加了 8 条 window.* —— 上一版是 W1 之后的 809753233；两处必须一起改）`。
 * 3. 值一律走 {@link #canonicalValue}（**两边写出一模一样的字符串**）。
 */
public final class ParamsFingerprint {

  private ParamsFingerprint() {
  }

  /**
   * 值的规范化写法。**这是两边一致的关键**，不是随手挑的格式化方式：
   *
   * - 整数就按整数写：`3` → `"3"`（不能是 `"3.0"` —— JS 的 `String(3)` 是 `"3"`）
   * - 小数按最短往返写法：`0.005` → `"0.005"`
   * - 布尔/字符串照原样
   *
   * ⚠️ 已知边界：科学计数法的写法两边不同（JS `1e-7` vs Java `1.0E-7`）。
   *    参数表里 46 项的取值范围与步长都到不了那个量级（最小步长 0.001），所以现在不会踩；
   *    真踩了的话，两边的字面量测试会立刻炸 —— **那正是它该干的事**。
   */
  public static String canonicalValue(Object v) {
    if (v == null) return "null";
    if (v instanceof Boolean || v instanceof String) return String.valueOf(v);
    if (v instanceof BigDecimal) {
      final BigDecimal b = ((BigDecimal) v).stripTrailingZeros();
      return b.scale() <= 0 ? b.toBigIntegerExact().toString() : b.toPlainString();
    }
    if (v instanceof Number) {
      final double d = ((Number) v).doubleValue();
      if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1e15) {
        return String.valueOf((long) d);
      }
      return String.valueOf(d);
    }
    return String.valueOf(v);
  }

  /**
   * 算指纹。`values` 为 `null` 时用**默认值**（= 生成的那份基线，也就是老方案里那个数）。
   *
   * @param values path → 值（如 `door.openOkDeg` → 90）。缺的项回落到默认值。
   */
  public static int of(Map<String, Object> values) {
    int h = 17;
    for (final String line : Params.FINGERPRINT_INPUT) {
      final int eq = line.indexOf('=');
      final String path = line.substring(0, eq);
      final String def = line.substring(eq + 1);
      final Object v = values == null ? null : values.get(path);
      final String canonical = v == null ? def : canonicalValue(v);
      h = h * 31 + (path + "=" + canonical).hashCode();
    }
    return h & 0x7fffffff;
  }

  /** 默认值那版的指纹（老方案里存的 `params_rev` 就是它） */
  public static int defaults() {
    return of(null);
  }
}