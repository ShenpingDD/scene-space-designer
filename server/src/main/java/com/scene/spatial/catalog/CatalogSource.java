package com.scene.spatial.catalog;

import com.scene.spatial.kernel.Catalog;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.stereotype.Component;

/**
 * CatalogSource —— 内核型号目录的**当前值**（唯一入口）
 *
 * 为什么要有这一层：目录是会变的（加型号、补文案，将来还有维护端在后台改）。
 * 如果各处各持一份 `Catalog` 引用，改完就得重启，而且**没人知道自己手里那份是不是旧的**
 * —— 两个真假来源，比"要重启"更糟。于是口径统一成：**谁要目录，谁问 `current()`**。
 *
 * 刷新策略：**最长 1 秒延迟的自动重读**。表很小（个位数型号 + 十几条说明），一次重读几毫秒；
 * 比"每个请求都重读"省，比"重启才更新"诚实 —— 1 秒是"改完刷新页面就看得见"的量级。
 *
 * `version()` 只在**内容真的变了**时才 +1，供缓存键失效用：不带它的话，后台一改目录，
 * 体检缓存还会继续吐旧结论 —— 而且看起来一切正常（这是最难查的那类问题）。
 */
@Component
public class CatalogSource {

  private static final Logger log = LoggerFactory.getLogger(CatalogSource.class);

  /** 自动重读的最小间隔（毫秒）。这是"别每个请求都打库"的节流，不是缓存正确性 */
  private static final long TTL_MS = 1000;

  private final ObjectProvider<DbCatalog> db;
  private final Catalog caseCatalog;

  private volatile Catalog current;
  private volatile String origin;
  private volatile long version = 1;
  private volatile long readAt;
  /** 上一次装载的原始目录；`null` = 还没装载过（首次装载不算"变更"） */
  private volatile Map<String, Object> lastRaw;

  /**
   * 无数据库档（`spatial.store=memory`）与单元测试用：只有一份用例表内嵌目录。
   * 没有 DB 就是没有 DB —— 这里不装作"读一下也许有"。
   */
  public CatalogSource(Catalog caseCatalog) {
    this(null, caseCatalog);
  }

  @Autowired   // 有两个构造器就必须点明用哪个：否则 Spring 会退回找无参构造（起不来）
  public CatalogSource(ObjectProvider<DbCatalog> db, @Qualifier("caseCatalog") Catalog caseCatalog) {
    this.db = db;
    this.caseCatalog = caseCatalog;
    this.current = caseCatalog;
    this.origin = "用例表内嵌";
  }

  /** 拿当前目录（顺带按 TTL 自动重读）。**所有要目录的地方都走这里** */
  public Catalog current() {
    refreshIfStale();
    return current;
  }

  /** 目录版本：只在内容变化时 +1。**缓存键必须带上它** */
  public long version() {
    refreshIfStale();
    return version;
  }

  /** 目录来源（数据库 / 用例表内嵌）——"现在裁判用的是哪一份"要说得出来 */
  public String origin() {
    return origin;
  }

  /** 强制重读（维护端改完目录可立即调用，见 `POST /api/catalog/reload`） */
  public synchronized void reload() {
    rebuild();
  }

  private void refreshIfStale() {
    if (System.currentTimeMillis() - readAt < TTL_MS) return;
    rebuild();
  }

  private synchronized void rebuild() {
    readAt = System.currentTimeMillis();
    final DbCatalog d = db == null ? null : db.getIfAvailable();
    if (d != null) {
      d.evict();   // 先作废 DbCatalog 自己的行缓存再取 —— 否则拿到的还是它记住的那份
      final Map<String, Object> raw = d.kernelRaw();
      if (!raw.isEmpty()) {
        if (lastRaw == null) {
          lastRaw = raw;                        // 首次装载不是"变更"
        } else if (!raw.equals(lastRaw)) {
          lastRaw = raw;
          version++;
          log.info("[catalog] 目录已变更：{} 款（version {}）", raw.size(), version);
        }
        current = new Catalog(raw);
        origin = "数据库";
        return;
      }
      log.warn("[catalog] 库里没有可用目录（product / product_model 为空？）—— 退回用例表内嵌的 {} 款",
          caseCatalog.size());
    }
    if (lastRaw != null) {
      // 本来有库、现在读不到了：**这是变化，要响亮**（不能让裁判悄悄降级到夹具）
      lastRaw = null;
      version++;
      log.warn("[catalog] 目录来源从数据库降级到用例表内嵌（version {}）", version);
    }
    current = caseCatalog;
    origin = "用例表内嵌";
  }
}
