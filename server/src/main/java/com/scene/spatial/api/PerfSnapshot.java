package com.scene.spatial.api;

import com.sun.management.OperatingSystemMXBean;

import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryUsage;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PerfSnapshot —— 后端自己的性能事实（给性能监测用，不是业务接口）
 *
 * ## 为什么要有这个
 *
 * 机器卡的时候，一个必问的问题是"服务端这一头占了多少" —— 而服务端**自己最清楚**：
 * 堆用了多少、元空间涨没涨、GC 跑了多少趟、多少线程、进程吃了多少处理器。
 * 从外面看（任务管理器、perfmon）只能看到一个工作集合与一个 CPU 百分比；
 * 这里面才有"是堆在涨还是元空间在涨""是不是在反复 GC"。
 *
 * ## 三条设计
 *
 * 1. **每次现算，不缓存、不起定时任务**：一个诊断接口自己去开线程定时采数，
 *    就成了"为了测卡顿而制造卡顿"。采开源里全是 O(1) 的 MXBean 读取，一次请求的代价可以忽略。
 * 2. **拿不到就 null，不写 0**：`getProcessCpuLoad()` 在某些平台/某些时刻会返回 -1（"不知道"）。
 *    把它报成 0 会被读成"后端很闲"，而真相是"这次没测到"。
 * 3. **单位写在字段名里**（`...Bytes` / `...Ms` / `...Sec` / `...Pct`）：采样脚本与报告要跨进程取值，
 *    名字里不带单位迟早会有人把字节当 KB 用。
 */
public final class PerfSnapshot {

  private PerfSnapshot() {}

  /** 一次快照。**无副作用、可重复调用**。 */
  public static Map<String, Object> of() {
    final Map<String, Object> out = new LinkedHashMap<>();

    final MemoryMXBean mem = ManagementFactory.getMemoryMXBean();
    final MemoryUsage heap = mem.getHeapMemoryUsage();
    out.put("heapUsedBytes", heap.getUsed());
    out.put("heapCommittedBytes", heap.getCommitted());
    // 没有上限时 JVM 返回 -1 —— 那是"不知道上限"，不是"上限是 -1"
    out.put("heapMaxBytes", heap.getMax() < 0 ? null : heap.getMax());
    out.put("nonHeapUsedBytes", mem.getNonHeapMemoryUsage().getUsed());

    out.put("metaspaceUsedBytes", metaspaceUsed());

    long gcCount = 0L;
    long gcTimeMs = 0L;
    for (final GarbageCollectorMXBean gc : ManagementFactory.getGarbageCollectorMXBeans()) {
      if (gc.getCollectionCount() >= 0) gcCount += gc.getCollectionCount();
      if (gc.getCollectionTime() >= 0) gcTimeMs += gc.getCollectionTime();
    }
    out.put("gcCount", gcCount);
    out.put("gcTimeMs", gcTimeMs);

    out.put("threads", ManagementFactory.getThreadMXBean().getThreadCount());
    out.put("peakThreads", ManagementFactory.getThreadMXBean().getPeakThreadCount());
    out.put("classesLoaded", ManagementFactory.getClassLoadingMXBean().getLoadedClassCount());
    out.put("uptimeSec", ManagementFactory.getRuntimeMXBean().getUptime() / 1000L);
    out.put("availableProcessors", Runtime.getRuntime().availableProcessors());
    out.put("pid", ProcessHandle.current().pid());

    // 进程与整机的处理器占用（com.sun.management 专有接口；取不到就是 null）
    final java.lang.management.OperatingSystemMXBean os = ManagementFactory.getOperatingSystemMXBean();
    Double processCpu = null;
    Double systemCpu = null;
    if (os instanceof OperatingSystemMXBean sun) {
      processCpu = clean(sun.getProcessCpuLoad());
      systemCpu = clean(sun.getCpuLoad());
      out.put("processCpuTimeMs", sun.getProcessCpuTime() / 1_000_000L);
      out.put("totalMemoryBytes", sun.getTotalMemorySize());
      out.put("freeMemoryBytes", sun.getFreeMemorySize());
    } else {
      out.put("processCpuTimeMs", null);
      out.put("totalMemoryBytes", null);
      out.put("freeMemoryBytes", null);
    }
    // 归一化成百分比（接口给的是 0..1；取不到给 null —— **不写 0**）
    out.put("processCpuPct", processCpu == null ? null : processCpu * 100.0);
    out.put("systemCpuPct", systemCpu == null ? null : systemCpu * 100.0);

    return out;
  }

  /** 元空间用量：从内存池里找那个叫 Metaspace 的；找不着就 null（不拿别的池顶上） */
  private static Long metaspaceUsed() {
    for (final MemoryPoolMXBean pool : ManagementFactory.getMemoryPoolMXBeans()) {
      if ("Metaspace".equals(pool.getName()) || "Metaspace".equals(pool.getType().name())) {
        final MemoryUsage u = pool.getUsage();
        if (u != null) return u.getUsed();
      }
    }
    return null;
  }

  /** 0..1 之外的读数（-1 / NaN）= "不知道"，转成 null */
  private static Double clean(double v) {
    if (Double.isNaN(v) || v < 0) return null;
    return v;
  }
}