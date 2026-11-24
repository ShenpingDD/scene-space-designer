package com.scene.spatial.audit;

import com.scene.spatial.api.ApiProblem;
import com.scene.spatial.kernel.Audit;
import com.scene.spatial.catalog.CatalogSource;
import com.scene.spatial.kernel.Catalog;
import com.scene.spatial.kernel.Json;
import com.scene.spatial.kernel.Layout;
import com.scene.spatial.kernel.ParamsLive;
import com.scene.spatial.kernel.Scheme;
import com.scene.spatial.kernel.Wall;
import com.scene.spatial.scheme.Canon;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * AuditService —— 体检接口的业务（R4-3）
 *
 * 分工：{@link Audit} 是纯函数（布局 → 报告），这个类只管**规范化 + 缓存 + 统计**。
 * 判定的活一个字都不在这里 —— "服务端是唯一裁判"这句话的意思是裁判住在内核里，
 * 不是住在某个 Service 里（Service 里多出来的每一行判断，将来都得在别处再写一遍）。
 *
 * 两个入口，同一个内核：
 *   · `check(raw)` —— 外部递来一份 state（界面上还没保存的布局也走这里），先规范化再算
 *   · `summary(canonical)` —— 库里存的已经是规范化过的，只取几个数给列表页
 */
@Service
public class AuditService {

  private final CatalogSource catalogs;
  private final AuditCache cache;

  public AuditService(CatalogSource catalogs,
                      @Value("${spatial.audit.maxEntries:128}") int maxEntries,
                      @Value("${spatial.audit.ttlSeconds:600}") long ttlSeconds) {
    this.catalogs = catalogs;
    this.cache = new AuditCache(maxEntries, ttlSeconds);
  }

  /**
   * 一条结论 + 「它是按哪一版参数、哪一版目录算的」（R6-4 B4d）。
   *
   * 落库的结论必须能回答这两个问题 —— 少了它们，"按现参数复核"就无从比。
   * `cached` / `costMs` 也留着：缓存有没有在工作，请求本身就能回答。
   */
  public record Verdict(Map<String, Object> report, int paramsRev, long catalogRev,
                        boolean cached, long costMs) {}

  /** 体检一份 state。`cached` / `costMs` 一起回去 —— 缓存有没有在工作，请求本身就能回答 */
  public Map<String, Object> check(Object rawState) {
    final Verdict v = judge(rawState);
    final Map<String, Object> out = new LinkedHashMap<>();
    out.put("report", v.report());
    out.put("cached", v.cached());
    out.put("costMs", v.costMs());
    // ⚠️ 这一句以前是 `Params.fingerprint()`（**永远是出厂值那一个**）——
    //    于是"发布完参数，裁判自报的 rev 没变"看起来像"参数没生效"。实测证过，见 设计决策记录 §一。
    out.put("paramsRev", v.paramsRev());
    // 目录版本一起回去：后台改了目录之后，这里能看出裁判换的是哪一份
    out.put("catalogRev", v.catalogRev());
    return out;
  }

  /**
   * 判一份 state，并把「判的时候用的是哪一版参数」一起给出。
   *
   * **算前算后各读一次 rev，不一样就重算一次**：这说明计算正好跨过了一次发布
   * （`ParamsLive.install` 换的是引用，一次计算里不同调用点可能读到相邻两份）。
   * 现货计算其实不值得为这点概率付代价，但**要落库的那条结论**必须属于某一版 ——
   * 存下一条"半新半旧参数算出来的结论"比不存更坏（它看起来和其他结论一模一样）。
   */
  public Verdict judge(Object rawState) {
    final Catalog catalog = catalogs.current();
    final Canon.Canonical c = Canon.of(rawState, catalog);
    for (int attempt = 0; ; attempt++) {
      final int before = ParamsLive.rev();
      final AuditCache.Hit hit = reportOf(c.layout(), catalog);
      final int after = ParamsLive.rev();
      if (after == before || attempt >= 1) {
        return new Verdict(Audit.json(hit.report()), after, catalogs.version(),
            hit.cached(), hit.costMillis());
      }
      // 只有"正好在发布的那一刻"会走到这里。发布是人的动作，重算一次就够，不做无限重试
    }
  }

  /** 列表页要的几个数（不给明细：列表页不该拖几十台设备的行数据） */
  public Map<String, Object> summary(Map<String, Object> canonicalState) {
    final Catalog catalog = catalogs.current();
    return Audit.summary(reportOf(layoutOf(canonicalState, catalog), catalog).report());
  }

  public Map<String, Object> stats() {
    return cache.stats();
  }

  private AuditCache.Hit reportOf(Layout layout, Catalog catalog) {
    return cache.getOrCompute(keyOf(layout, catalogs.version()), () -> Audit.of(layout, catalog));
  }

  /** 库里存的一定"能导得回来"；导不回来就是数据坏了，要响亮（不能悄悄给个空报告） */
  private Layout layoutOf(Map<String, Object> canonical, Catalog catalog) {
    final Scheme.ImportResult r = Scheme.importScheme(
        Json.obj("format", Scheme.FORMAT, "state", canonical), catalog, true);
    if (!r.ok()) throw ApiProblem.badRequest(r.error().reason(), r.error().message());
    return r.layout();
  }

  /**
   * 缓存键：**布局内容** + 参数表指纹 + **目录版本**。
   *
   * 为什么不直接拿 state 的 JSON 文本当键：MySQL 的 JSON 列**不保证键的顺序**，
   * 同一个方案两次读出来可能键序不同 → 用它当键会得到"看起来有缓存、其实永远不命中"
   * —— 最难查的那种问题（设计决策记录判据⑤）。这里只用布局本身的值，与字典顺序无关。
   *
   * **目录版本也在键里**：占地的判据来自目录（产品的 `w/d`），目录一改，同一份布局的结论就可能变。
   * 不带版本的话，"后台加了个型号"之后旧结论还会继续被吐出来 —— 而且看起来一切正常。
   *
   * ⚠️ 参数那一半**必须是生效值**（`ParamsLive.rev()`）。B4d 之前这里读的是 `Params.fingerprint()`
   * （出厂值那一个）—— 后台改了参数、缓存键纹丝不动 → 继续吐旧结论，而界面上看不出来。
   */
  static String keyOf(Layout l, long catalogVersion) {
    final StringBuilder sb = new StringBuilder();
    sb.append(l.w).append(',').append(l.d).append(',').append(l.h).append('|');
    // ⚠️ W1：门洞**必须进缓存键**。两份布局只差"门上有没有洞"时，占地判据可能不同
    // （门口那块地方不能停车）—— 键里不带它，后台就会拿旧结论回答新布局，而且界面上看不出来。
    for (final Wall w : l.walls) {
      sb.append(w.a[0]).append(',').append(w.a[1]).append(',').append(w.b[0]).append(',').append(w.b[1]);
      for (final Wall.Opening o : w.openings) {
        sb.append(",o:").append(o.at()).append(',').append(o.w()).append(',').append(o.h());
      }
      sb.append(';');
    }
    sb.append('|');
    for (final Layout.Item it : l.items) {
      sb.append(it.id).append(',').append(it.p).append(',').append(it.x).append(',')
          .append(it.z).append(',').append(it.r).append(',').append(it.doorAmount).append(';');
    }
    return sha256(sb.append('|').append(ParamsLive.rev()).append("|c").append(catalogVersion).toString());
  }

  /** 取 8 字节（16 个十六进制字符）做键就够了 —— 这不是防篡改，只是要"不同内容不同键" */
  private static String sha256(String s) {
    try {
      final byte[] d = MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8));
      final StringBuilder hex = new StringBuilder();
      for (int i = 0; i < 8; i++) hex.append(String.format("%02x", d[i] & 0xff));
      return hex.toString();
    } catch (Exception e) {
      throw new IllegalStateException("SHA-256 不可用", e);
    }
  }
}