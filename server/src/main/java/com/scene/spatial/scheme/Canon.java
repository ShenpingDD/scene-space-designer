package com.scene.spatial.scheme;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.kernel.Catalog;
import com.scene.spatial.kernel.Json;
import com.scene.spatial.kernel.Layout;
import com.scene.spatial.kernel.Scheme;

import java.util.Map;

/**
 * Canon.java —— "能导得回来"的那一份 state
 *
 * 写路径（{@link SchemeService}）和体检（`com.scene.spatial.audit.AuditService`）都用它，
 * 于是**只有一处定义"什么算规范化"**：内核会补齐缺省字段、丢掉不认识的字段，
 * 存进去的和体检的都是同一份形状。
 *
 * 为什么值得单独一个类：R4-3 要按"布局内容"给体检结论做缓存 ——
 * 如果两个入口各自规范化一遍，同样的方案可能得到两个不同的缓存键，
 * 而"缓存看起来在工作、其实永远命中不了"是最难查的那种问题（设计决策记录判据⑤ 怕安静）。
 */
public final class Canon {

  private Canon() {}

  /**
   * 一次导入，两处用：`state` 给写路径（存进库的就是它），`layout` 给体检（算的就是它）。
   *
   * 为什么要把两者一起返回：入口处 import 一遍、体检里再 import 一遍是**同一件事做两次**
   * （实测 100 台时这一遍就是十几毫秒）—— 而"重复做同一件事"正是这项目最想避免的那类浪费。
   */
  public record Canonical(Map<String, Object> state, Layout layout) {}

  /** 任意 state → 规范化结果；不合法就抛 400，`reason` 直接用**内核原因码** */
  public static Canonical of(Object raw, Catalog catalog) {
    final Scheme.ImportResult r = Scheme.importScheme(
        Json.obj("format", Scheme.FORMAT, "state", raw), catalog, true);
    if (!r.ok()) throw ApiProblem.badRequest(r.error().reason(), r.error().message());
    return new Canonical(Scheme.stateOf(r.layout()), r.layout());
  }
}