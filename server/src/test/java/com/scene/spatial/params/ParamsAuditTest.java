package com.scene.spatial.params;

import com.scene.spatial.api.ApiProblem;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ParamsAuditTest —— 审计查询的组装（R6-4 B4c）
 *
 * 存储层那一半在 `ParamsStoreContractTest`（两份实现同一套断言）。这里钉的是**上层**的三件事：
 *
 *   ① `total` 是"**一共**几条"，不是"这一页几条" —— 少了它，界面就没法写「显示 3 / 共 20 条」，
 *      筛选立刻变成静默筛选（这是这个项目最不许犯的错之一）；
 *   ② 时间**只给日期**时，`to` 必须补到当天 `23:59:59` —— 否则「到 2026-09-29」会把 9-29
 *      一整天排除掉（经典错法，而且没人看得出来）；
 *   ③ 时间读不懂就 **400**，**绝不忽略** —— "填了时间却拿到全量"是最坏的一种静默。
 */
class ParamsAuditTest {

  private final ParamsSchema schema = new ParamsSchema();
  private final ParamsStoreInMemory store = new ParamsStoreInMemory();
  private final ParamsSource source = new ParamsSource(new Provider(store), schema);
  private final ParamsService service = new ParamsService(schema, source, new Provider(store));

  @Test
  @DisplayName("一条留痕都没有：total 0、rows 空 —— 这是「没有」，不是错")
  void emptyIsNotAnError() {
    final Map<String, Object> out = service.audit(null, null, null, null, 50, 0);
    assertEquals(0, out.get("total"));
    assertEquals(0, out.get("returned"));
    assertTrue(((List<?>) out.get("rows")).isEmpty());
  }

  @Test
  @DisplayName("三条留痕：新的在前；total 说「一共」而不是「这一页」")
  void newestFirstAndTotalIsTotal() {
    add("door.openOkDeg", 90, 85, "先改这个");
    add("space.rotateStepDeg", 5, 15, "");
    add("door.openOkDeg", 85, 80, "再改回来一点");

    final Map<String, Object> page = service.audit(null, null, null, null, 2, 0);
    assertEquals(3, page.get("total"), "★ total 必须是「一共 3 条」，不是「这一页 2 条」");
    assertEquals(2, page.get("returned"));
    final List<Map<String, Object>> rows = rows(page);
    assertEquals(80, num(rows.get(0).get("newValue")), "最新那条要在最前面");
    assertEquals("再改回来一点", rows.get(0).get("note"));

    // 第二页
    final Map<String, Object> page2 = service.audit(null, null, null, null, 2, 2);
    assertEquals(3, page2.get("total"), "翻页不该改变 total");
    assertEquals(1, page2.get("returned"));
    assertEquals(90, num(rows(page2).get(0).get("oldValue")));
  }

  @Test
  @DisplayName("按项筛 / 按人筛：条件生效，而且 total 跟着条件走")
  void filters() {
    add("door.openOkDeg", 90, 85, "");
    add("space.rotateStepDeg", 5, 15, "");

    final Map<String, Object> byKey = service.audit(null, null, "door.openOkDeg", null, 50, 0);
    assertEquals(1, byKey.get("total"));
    assertEquals("door.openOkDeg", rows(byKey).get(0).get("key"));

    assertEquals(0, service.audit(null, null, null, "不存在的用户", 50, 0).get("total"));
    assertEquals(2, service.audit(null, null, null, "1", 50, 0).get("total"), "按人也要能用");
    assertEquals(0, service.audit(null, null, "没有这一项", null, 50, 0).get("total"));
  }

  @Test
  @DisplayName("★ 时间只给日期：to 补到当天 23:59:59（含当天），不是把当天排除掉")
  void dateOnlyMeansWholeDay() {
    add("door.openOkDeg", 90, 85, "刚刚改的（用来验「含当天」）");

    final String today = LocalDate.now().toString();
    final Map<String, Object> out = service.audit(today, today, null, null, 50, 0);
    assertEquals(1, out.get("total"),
        "★ 「从今天到今天」必须包含今天刚写的那条（to 补成 23:59:59）—— 这是最常见的错法");

    // 只给 from（今天）也应当包含它
    assertEquals(1, service.audit(today, null, null, null, 50, 0).get("total"));
  }

  @Test
  @DisplayName("★ 时间读不懂 → 400，而且说清「没有忽略它」")
  void badTimeIsRejectedNotIgnored() {
    final ApiProblem e = assertThrows(ApiProblem.class,
        () -> service.audit("昨天", null, null, null, 50, 0));
    assertEquals(400, e.status());
    assertEquals("bad-time", e.reason());
    assertTrue(e.getMessage().contains("昨天"), "要把读不懂的那个原样带回去：" + e.getMessage());
    assertTrue(e.getMessage().contains("没有忽略"), "还得说清它没有被静默忽略：" + e.getMessage());
  }

  @Test
  @DisplayName("详情：found + 64 项全量快照；不存在的 id → found=false（不抛异常）")
  void detail() {
    final Map<String, Object> snap = new LinkedHashMap<>(schema.defaults());
    snap.put("door.openOkDeg", 85);
    store.audit(new ParamsStore.AuditRow("door.openOkDeg", ParamsStore.SCOPE_GLOBAL,
        ParamsStore.SCOPE_ID_NONE, 49717190, 90, 85, snap, "1", "验快照"));

    final long id = ((Number) rows(service.audit(null, null, null, null, 50, 0)).get(0).get("id")).longValue();
    final Map<String, Object> one = service.auditOne(id);
    assertEquals(true, one.get("found"));
    assertEquals(85, num(one.get("newValue")));
    assertEquals(49717190, num(one.get("rev")));
    @SuppressWarnings("unchecked")
    final Map<String, Object> back = (Map<String, Object>) one.get("snapshot");
    assertEquals(schema.defaults().size(), back.size(), "快照必须是全量那一份（B4d 要靠它复现结论）");
    assertEquals(85, num(back.get("door.openOkDeg")));

    final Map<String, Object> none = service.auditOne(id + 999_999L);
    assertEquals(false, none.get("found"), "查不到就说 found=false，不抛异常、不给半个空壳");
    assertFalse(none.containsKey("key"), "没有的那条不该带任何字段");
  }

  /** 写一条留痕（`rev` 用真指纹的形态，`changed_by` 用真实的数字 id 形态） */
  private void add(String path, int from, int to, String note) {
    store.audit(new ParamsStore.AuditRow(path, ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE,
        49717190, from, to, schema.defaults(), "1", note));
  }

  private static List<Map<String, Object>> rows(Map<String, Object> out) {
    final List<Map<String, Object>> list = new ArrayList<>();
    for (final Object o : (List<?>) out.get("rows")) {
      @SuppressWarnings("unchecked")
      final Map<String, Object> m = (Map<String, Object>) o;
      list.add(m);
    }
    assertNotNull(list);
    return list;
  }

  private static int num(Object o) {
    return ((Number) o).intValue();
  }

  /** 测试用的最小 ObjectProvider（生产里由 Spring 给） */
  private record Provider(ParamsStore store)
      implements org.springframework.beans.factory.ObjectProvider<ParamsStore> {

    @Override
    public ParamsStore getObject() {
      return store;
    }

    @Override
    public ParamsStore getObject(Object... args) {
      return store;
    }

    @Override
    public ParamsStore getIfAvailable() {
      return store;
    }

    @Override
    public ParamsStore getIfUnique() {
      return store;
    }
  }
}