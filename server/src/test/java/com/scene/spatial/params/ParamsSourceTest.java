package com.scene.spatial.params;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ParamsSourceTest —— 当前生效值从哪来、坏值怎么办（R6-4 B4a）
 *
 * 钉的是「**库里的值不合法 → 拒绝它，并且说出来**」。
 * 静默用默认值是这个模块最坏的结果：「后台明明改了却没生效」和「改错了没人知道」
 * 会长得一模一样 —— 所以下面每一条都断言了 `ignored()` 里有话说。
 */
class ParamsSourceTest {

  private final ParamsSchema schema = new ParamsSchema();
  private final ParamsStoreInMemory store = new ParamsStoreInMemory();

  private ParamsSource sourceWithStore() {
    return new ParamsSource(new TestStoreProvider(store), schema);
  }

  @Test
  @DisplayName("没有库：用参数表默认值，来源说清楚，指纹是那个基线")
  void defaultsWhenNoStore() {
    final ParamsSource s = new ParamsSource(schema);
    assertEquals(1831018939, s.version());
    assertEquals("参数表默认值", s.origin());
    assertEquals(0, s.changedCount());
    assertTrue(s.ignored().isEmpty());
    assertEquals(3, ((Number) s.current().get("room.minW")).intValue());
  }

  @Test
  @DisplayName("库里有值：覆盖默认值，来源变成「数据库」，指纹跟着变")
  void dbOverridesDefaults() {
    store.put(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE, "room.maxW", 25, "number", 1L);
    final ParamsSource s = sourceWithStore();
    assertEquals(25, ((Number) s.current().get("room.maxW")).intValue());
    assertEquals("数据库（改过 1 项）", s.origin(), "改了 1 项就要说 1 项，不能只说「数据库」");
    assertEquals(1, s.changedCount());
    assertNotEquals(1831018939, s.version());
    assertTrue(s.ignored().isEmpty());
  }

  @Test
  @DisplayName("库里的值超范围 / 不是数字 / 参数表里没有：一律不采用，并逐条说出来")
  void refusesBadRows() {
    store.put(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE, "room.maxW", 9999, "number", 1L);
    store.put(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE, "room.minW", "abc", "string", 1L);
    store.put(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE, "nope.key", 1, "number", 1L);
    final ParamsSource s = sourceWithStore();

    assertEquals(20, ((Number) s.current().get("room.maxW")).intValue(), "超范围的值不能被采用");
    assertEquals(3, ((Number) s.current().get("room.minW")).intValue(), "不是数字的值不能被采用");
    assertEquals(3, s.ignored().size(), s.ignored().toString());
    assertTrue(s.ignored().get(0).contains("超出"), s.ignored().toString());
    // 三项全被拒 → 生效值等于默认值 → 指纹回到基线（这说明拒绝是**真的**拒绝，不是记一笔就算了）
    assertEquals(1831018939, s.version());
  }

  @Test
  @DisplayName("reload() 之后新值立刻可见（发布后前台不用重启）")
  void reloadPicksUpChanges() {
    final ParamsSource s = sourceWithStore();
    final int before = s.version();
    store.put(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE, "door.openOkDeg", 85, "number", 1L);
    s.reload();
    assertEquals(85, ((Number) s.current().get("door.openOkDeg")).intValue());
    assertNotEquals(before, s.version());
    assertFalse(s.ignored().size() > 0);
  }

  @Test
  @DisplayName("两个形状各司其职：current() 扁平（给规则/指纹）、grouped() 嵌套（给界面 configure）")
  void keepsTwoShapesStraight() {
    store.put(ParamsStore.SCOPE_GLOBAL, ParamsStore.SCOPE_ID_NONE, "room.maxW", 25, "number", 1L);
    final ParamsSource s = sourceWithStore();
    // 扁平：按 path 取，指纹也读它
    assertEquals(25, ((Number) s.current().get("room.maxW")).intValue());
    // 嵌套：接口发给前端的形状 —— 前端 configure() 收的就是这个（第一版发错成扁平的，
    // 前端第一句就报「未知分组：room.maxW」）
    final Map<String, Object> grouped = s.grouped();
    assertEquals(12, grouped.size(), grouped.keySet().toString());
    @SuppressWarnings("unchecked")
    final Map<String, Object> room = (Map<String, Object>) grouped.get("room");
    assertEquals(25, ((Number) room.get("maxW")).intValue());
    assertTrue(!grouped.containsKey("room.maxW"), "分组那份不许有扁平的键");
  }

  /** 测试用的最小 ObjectProvider（生产里由 Spring 给；这里只为把内存 store 递进去） */
  private record TestStoreProvider(ParamsStore store) implements org.springframework.beans.factory.ObjectProvider<ParamsStore> {
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

    @Override
    public java.util.stream.Stream<ParamsStore> stream() {
      return java.util.stream.Stream.of(store);
    }

    @Override
    public java.util.Iterator<ParamsStore> iterator() {
      return java.util.List.of(store).iterator();
    }

    @Override
    public java.util.stream.Stream<ParamsStore> orderedStream() {
      return java.util.stream.Stream.of(store);
    }
  }
}
