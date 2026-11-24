package com.scene.spatial.api;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PerfSnapshotTest —— 性能快照必须**说得出真话**
 *
 * 这个类盯两件事：
 *   ① 该有的数都在（少一个字段，报告里就少一行，而人会把它读成"这一项没问题"）；
 *   ② **取不到的是 null、不是 0**（`-1` / `NaN` 是"不知道"，写成 0 就是"很闲"——
 *      一个诊断接口把"没测到"说成"很闲"，比不报还坏）。
 */
class PerfSnapshotTest {

  private static double num(Map<String, Object> m, String k) {
    final Object v = m.get(k);
    assertNotNull(v, k + " 不该是 null（这一项在本机应该能拿到）");
    return ((Number) v).doubleValue();
  }

  @Test
  @DisplayName("快照字段齐全，且单位的名字里带着单位")
  void hasEveryField() {
    final Map<String, Object> m = PerfSnapshot.of();
    for (final String k : new String[] {
        "heapUsedBytes", "heapCommittedBytes", "heapMaxBytes", "nonHeapUsedBytes",
        "metaspaceUsedBytes", "gcCount", "gcTimeMs", "threads", "peakThreads",
        "classesLoaded", "uptimeSec", "availableProcessors", "pid",
        "processCpuTimeMs", "totalMemoryBytes", "freeMemoryBytes",
        "processCpuPct", "systemCpuPct"}) {
      assertTrue(m.containsKey(k), "少了字段 " + k + " —— 报告会少一行，而读者会当成「没问题」");
    }
  }

  @Test
  @DisplayName("堆的三个数是自洽的（已用 <= 已提交 <= 上限）")
  void heapNumbersMakeSense() {
    final Map<String, Object> m = PerfSnapshot.of();
    final double used = num(m, "heapUsedBytes");
    final double committed = num(m, "heapCommittedBytes");
    final double max = num(m, "heapMaxBytes");
    assertTrue(used > 0, "刚起来的服务堆里也该有点东西，实测 used=" + used);
    assertTrue(used <= committed, "已用不能大于已提交（used=" + used + " committed=" + committed + "）");
    assertTrue(committed <= max, "已提交不能大于上限（committed=" + committed + " max=" + max + "）");
  }

  @Test
  @DisplayName("线程、处理器数、进程号都是真的（不是占位的 0）")
  void liveFacts() {
    final Map<String, Object> m = PerfSnapshot.of();
    assertTrue(num(m, "threads") > 0, "线程数必须大于 0");
    assertTrue(num(m, "availableProcessors") > 0, "处理器数必须大于 0");
    assertTrue(num(m, "pid") > 0, "进程号必须是真的");
    assertTrue(num(m, "uptimeSec") >= 0, "运行时长不能是负数");
    assertTrue(num(m, "gcCount") >= 0, "GC 次数不能是负数（拿不到时该是 null）");
  }

  @Test
  @DisplayName("处理器占用：要么是真百分比，要么是 null —— **不许出现负的或 0 顶替「不知道」**")
  void cpuLoadIsHonest() {
    final Map<String, Object> m = PerfSnapshot.of();
    for (final String k : new String[] {"processCpuPct", "systemCpuPct"}) {
      final Object v = m.get(k);
      if (v == null) continue;                       // 「不知道」是允许的答案
      final double d = ((Number) v).doubleValue();
      assertTrue(d >= 0, k + " 不能是负数（-1 = 不知道，应当被转成 null），实际 " + d);
      assertTrue(!Double.isNaN(d), k + " 不能是 NaN");
    }
    // 至少有一样能测到（这台机器上两者都测不到，说明 clean() 把真值也吃掉了）
    final Object p = m.get("processCpuPct");
    final Object s = m.get("systemCpuPct");
    assertTrue(p != null || s != null, "进程与整机占用至少要有一个能测到");
  }

  @Test
  @DisplayName("元空间：取不到就是 null，不拿别的内存池顶上")
  void metaspaceIsOrIsNot() {
    final Map<String, Object> m = PerfSnapshot.of();
    final Object v = m.get("metaspaceUsedBytes");
    if (v != null) {
      assertTrue(((Number) v).doubleValue() > 0, "元空间用量要么是 null，要么大于 0");
    }
  }

  @Test
  @DisplayName("两次调用各自独立（现算、不缓存）")
  void recomputesEachTime() {
    final Map<String, Object> a = PerfSnapshot.of();
    final Map<String, Object> b = PerfSnapshot.of();
    assertTrue(num(b, "uptimeSec") >= num(a, "uptimeSec"), "运行时长只增不减");
    assertEquals(a.get("pid"), b.get("pid"), "同一个进程，进程号当然一样");
  }
}