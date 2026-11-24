package com.scene.spatial.audit;

import com.scene.spatial.kernel.Audit;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * AuditCache —— 体检结论的缓存（R4-3）
 *
 * **为什么非要有缓存**：规则 7 是全屋扫掠 —— 100 台实测（Java 侧）**19.6 ms**，
 * 同一套规则在**浏览器**里是 ~140 ms（R3-9 粗筛优化后的 JS 值）。见 docs/25 §4。
 * 而"列表页给每个方案标一句'几台门开不到底'"这件事，本质上是 N 个方案各体检一次 ——
 * 没有缓存就只能放弃这个功能（或者让列表页慢到没人用）。有了缓存，只有"布局真变了的那一次"付钱。
 *
 * **为什么用 JDK 自带的 LinkedHashMap(accessOrder)**，不引 Caffeine（docs/21 判据①）：
 * 这里要的语义就是 LRU + TTL，JDK 一行 `removeEldestEntry` 就能表达；
 * Caffeine 是更专业的轮子，但引入它就多一份配置、一份统计、一份淘汰语义要对齐。
 * → **删除触发条件**：需要"按方案 id 精确失效"、或需要权重淘汰 / 异步刷新 / 进程内 QPS 上百时，换 Caffeine。
 *
 * **键 = 布局内容 + 参数表指纹**：参数一改指纹就变，老结论自动作废（不手工清缓存）。
 * **TTL 只是兜底**：内容变了键本来就变了；TTL 管的是"参数表热更新了但进程没重启"这类看不见的变化。
 *
 * 线程安全：Spring MVC 是多线程的，**所有读写都在同一把锁里** ——
 * 命中计数与 LRU 顺序都必须和取值是原子的，否则统计会说谎（而统计正是这个类存在的理由之一）。
 */
public class AuditCache {

  private final int maxEntries;
  private final long ttlMillis;
  private final LinkedHashMap<String, Entry> map;
  private final Object lock = new Object();

  private long hits;
  private long misses;
  private long evictions;
  private long expired;
  private long computedMillis;
  private long lastMillis;

  /** 一条结论：报告 + 落地时间（TTL 判据）+ 当时算了多久（统计用） */
  private record Entry(Audit.Report report, long atMillis, long costMillis) {}

  /** 一次取用：报告 + 是否命中缓存 + 这次实际算了多久 —— **缓存有没有用，必须从响应里看得见** */
  public record Hit(Audit.Report report, boolean cached, long costMillis) {}

  public AuditCache(int maxEntries, long ttlSeconds) {
    this.maxEntries = Math.max(1, maxEntries);
    this.ttlMillis = Math.max(1, ttlSeconds) * 1000L;
    this.map = new LinkedHashMap<>(16, 0.75f, true) {
      @Override
      protected boolean removeEldestEntry(Map.Entry<String, Entry> eldest) {
        final boolean drop = size() > AuditCache.this.maxEntries;
        if (drop) evictions++;
        return drop;
      }
    };
  }

  /**
   * 取结论；没有就算一次。`computeMillis` 由调用方传入实际耗时 —— 统计要报**算的那部分**，
   * 不是"包括加锁和查表"的总时间（后者会把缓存说成很慢）。
   */
  public Hit getOrCompute(String key, java.util.function.Supplier<Audit.Report> compute) {
    synchronized (lock) {
      final Entry hit = map.get(key);
      if (hit != null && System.currentTimeMillis() - hit.atMillis() < ttlMillis) {
        hits++;
        return new Hit(hit.report(), true, 0L);
      }
      if (hit != null) expired++;
      misses++;
    }

    // 计算放在锁外：它是唯一慢的部分，锁里跑就等于把整个缓存串行化
    final long t0 = System.nanoTime();
    final Audit.Report report = compute.get();
    final long cost = (System.nanoTime() - t0) / 1_000_000L;

    synchronized (lock) {
      lastMillis = cost;
      computedMillis += cost;
      map.put(key, new Entry(report, System.currentTimeMillis(), cost));
    }
    return new Hit(report, false, cost);
  }

  public Map<String, Object> stats() {
    synchronized (lock) {
      final Map<String, Object> m = new LinkedHashMap<>();
      m.put("size", map.size());
      m.put("maxEntries", maxEntries);
      m.put("ttlSeconds", ttlMillis / 1000L);
      m.put("hits", hits);
      m.put("misses", misses);
      m.put("evictions", evictions);
      m.put("expired", expired);
      m.put("computedTimes", misses);
      m.put("computedMsTotal", computedMillis);
      m.put("lastComputedMs", lastMillis);
      m.put("avgComputedMs", misses == 0 ? 0.0 : Math.round(computedMillis * 10.0 / misses) / 10.0);
      final long total = hits + misses;
      m.put("hitRate", total == 0 ? 0.0 : Math.round(hits * 1000.0 / total) / 10.0);
      return m;
    }
  }
}