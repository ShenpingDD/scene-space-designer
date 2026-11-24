package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Json.java —— 极小的 JSON 读写（**临时件**：进 Spring 之后换成 Jackson）
 *
 * 为什么现在要自己写：内核是零依赖的纯函数，而方案导出/导入要能**真跑** ——
 * 用例 `scheme-roundtrip-identical` 就是"导出 → 导入 → 再导出"然后逐字节比对，
 * 没有解析器这条用例根本跑不起来。而这台机器上既没有 Maven 也没有依赖仓库。
 * 所以先写一个最小实现，把它钉在用例表上；换 Jackson 时判据不用改。
 *
 * 与 JS `JSON.stringify(v, null, 2)` 对齐的两件事（不对齐就会"服务端生成的文件与浏览器生成的
 * 文件逐字节不同" —— 不是语义问题，但会造成 diff 噪音，以及"同一份文件两个样子"的信任问题）：
 *   ① **整数不加 `.0`**（`0.7`→`0.7`、`4`→`4`；Java 默认会把 4.0 打成 `4.0`）
 *   ② 缩进 2 空格的换行方式（数组元素、对象成员各占一行）
 */
public final class Json {

  private Json() {
  }

  // ── 造数据（比 Map.ofEntries 好用的地方：允许 null）────────────────────
  public static Map<String, Object> obj(Object... kv) {
    final Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i + 1 < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
    return m;
  }

  public static List<Object> arr(Object... xs) {
    return new ArrayList<>(java.util.Arrays.asList(xs));
  }

  // ── 序列化 ──────────────────────────────────────────────────────────
  public static String write(Object v, int indent) {
    final StringBuilder sb = new StringBuilder();
    writeValue(sb, v, indent, 0);
    return sb.toString();
  }

  /** 数字文本：整数不带小数点（对齐 JS）；非有限数直接拒绝（不许 NaN/Infinity 流进文件） */
  static String numText(double d) {
    if (!Double.isFinite(d)) throw new IllegalArgumentException("JSON 无法表示 " + d);
    if (d == Math.rint(d) && Math.abs(d) < 1e15) return String.valueOf((long) d);
    return Double.toString(d);
  }

  private static void writeValue(StringBuilder sb, Object v, int indent, int depth) {
    if (v == null) {
      sb.append("null");
      return;
    }
    if (v instanceof String) {
      quote(sb, (String) v);
      return;
    }
    if (v instanceof Boolean) {
      sb.append(v);
      return;
    }
    if (v instanceof Number) {
      sb.append(numText(((Number) v).doubleValue()));
      return;
    }
    if (v instanceof Map<?, ?>) {
      final Map<?, ?> m = (Map<?, ?>) v;
      if (m.isEmpty()) {
        sb.append("{}");
        return;
      }
      sb.append('{');
      boolean first = true;
      for (final Map.Entry<?, ?> e : m.entrySet()) {
        if (!first) sb.append(',');
        first = false;
        sb.append('\n').append(pad(indent * (depth + 1)));
        quote(sb, String.valueOf(e.getKey()));
        sb.append(": ");
        writeValue(sb, e.getValue(), indent, depth + 1);
      }
      sb.append('\n').append(pad(indent * depth)).append('}');
      return;
    }
    if (v instanceof List<?>) {
      final List<?> l = (List<?>) v;
      if (l.isEmpty()) {
        sb.append("[]");
        return;
      }
      sb.append('[');
      boolean first = true;
      for (final Object x : l) {
        if (!first) sb.append(',');
        first = false;
        sb.append('\n').append(pad(indent * (depth + 1)));
        writeValue(sb, x, indent, depth + 1);
      }
      sb.append('\n').append(pad(indent * depth)).append(']');
      return;
    }
    throw new IllegalArgumentException("不能序列化：" + v.getClass());
  }

  private static String pad(int n) {
    final StringBuilder sb = new StringBuilder();
    for (int i = 0; i < n; i++) sb.append(' ');
    return sb.toString();
  }

  private static void quote(StringBuilder sb, String s) {
    sb.append('"');
    for (int i = 0; i < s.length(); i++) {
      final char c = s.charAt(i);
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        default:
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    sb.append('"');
  }

  // ── 解析 ────────────────────────────────────────────────────────────
  public static Object parse(String s) {
    final P p = new P(s);
    p.ws();
    final Object v = p.value();
    p.ws();
    if (p.i < p.s.length()) throw new IllegalArgumentException("JSON 尾部有多余内容");
    return v;
  }

  private static final class P {
    private final String s;
    private int i;

    P(String s) {
      this.s = s;
    }

    void ws() {
      while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
    }

    Object value() {
      ws();
      if (i >= s.length()) throw new IllegalArgumentException("JSON 意外结束");
      final char c = s.charAt(i);
      if (c == '{') return object();
      if (c == '[') return array();
      if (c == '"') return string();
      if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
      if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
      if (s.startsWith("null", i)) { i += 4; return null; }
      return number();
    }

    Map<String, Object> object() {
      final Map<String, Object> m = new LinkedHashMap<>();
      i++;  // {
      ws();
      if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
      while (true) {
        ws();
        final String k = string();
        ws();
        if (i >= s.length() || s.charAt(i) != ':') throw new IllegalArgumentException("缺少 ':'");
        i++;
        m.put(k, value());
        ws();
        if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
        if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
        throw new IllegalArgumentException("对象未闭合");
      }
    }

    List<Object> array() {
      final List<Object> l = new ArrayList<>();
      i++;  // [
      ws();
      if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
      while (true) {
        l.add(value());
        ws();
        if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
        if (i < s.length() && s.charAt(i) == ']') { i++; return l; }
        throw new IllegalArgumentException("数组未闭合");
      }
    }

    String string() {
      if (i >= s.length() || s.charAt(i) != '"') throw new IllegalArgumentException("期望字符串");
      i++;
      final StringBuilder sb = new StringBuilder();
      while (i < s.length()) {
        final char c = s.charAt(i++);
        if (c == '"') return sb.toString();
        if (c != '\\') { sb.append(c); continue; }
        if (i >= s.length()) break;
        final char e = s.charAt(i++);
        switch (e) {
          case '"': sb.append('"'); break;
          case '\\': sb.append('\\'); break;
          case '/': sb.append('/'); break;
          case 'b': sb.append('\b'); break;
          case 'f': sb.append('\f'); break;
          case 'n': sb.append('\n'); break;
          case 'r': sb.append('\r'); break;
          case 't': sb.append('\t'); break;
          case 'u':
            if (i + 4 > s.length()) throw new IllegalArgumentException("坏掉的 \\u 转义");
            sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
            i += 4;
            break;
          default: throw new IllegalArgumentException("未知转义");
        }
      }
      throw new IllegalArgumentException("字符串未闭合");
    }

    /**
     * 数字：**整数值返回 Integer，其余返回 Double** ——
     * 这样 `id` 才能当整数用（`Math.max` 比 id 大小），与 JS 里数字无差别的语义最接近。
     */
    Object number() {
      final int start = i;
      while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
      if (i == start) throw new IllegalArgumentException("不是合法的 JSON");
      final String t = s.substring(start, i);
      if (t.indexOf('.') < 0 && t.indexOf('e') < 0 && t.indexOf('E') < 0) {
        try {
          return Integer.valueOf(t);
        } catch (NumberFormatException ignore) {
          // 整数放不下就按长整数再来一次 —— 这里**吞掉异常是对的**：它不是失败，
          // 是"换一种更宽的表示"。理由写在当场（静默 catch 的守卫要求）。
          return Long.valueOf(t);
        }
      }
      return Double.valueOf(t);
    }
  }
}