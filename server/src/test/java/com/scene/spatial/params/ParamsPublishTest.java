package com.scene.spatial.params;

import com.scene.spatial.api.ApiProblem;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * ParamsPublishTest —— 发布：校验 → 写 → 审计 → 刷新（R6-4 B4a）
 *
 * 钉四件事：
 *  ① 不合法就**一处都不写**（"改一半生效一半"是最坏的）；
 *  ② 只写**真的变了**的项，没变的不写、也不留审计（发布一份一样的值不该污染审计）；
 *  ③ 审计行带 `old` / `new` / **全量快照**（已存方案要靠快照复现当时的结论）+ note；
 *  ④ 审计里记的 `rev` 就是**改完之后的指纹**，与刷新后 `source.version()` 一致
 *     （不一致的话，"这份方案是按哪版参数判的"就指不到真正那一版）。
 */
class ParamsPublishTest {

  private final ParamsSchema schema = new ParamsSchema();
  private final ParamsStoreInMemory store = new ParamsStoreInMemory();
  private final ParamsSource source = new ParamsSource(new Provider(store), schema);
  private final ParamsService service = new ParamsService(schema, source, new Provider(store));

  private static Map<String, Object> me() {
    return Map.of("userId", 1, "roleCode", "admin");
  }

  @Test
  @DisplayName("发布一项：写进去、留审计（带全量快照）、刷新后立刻生效")
  void publishesOne() {
    final Map<String, Object> out = service.publish(Map.of("door", Map.of("openOkDeg", 85)), "现场说 85 更合适", me());

    assertEquals(List.of("door.openOkDeg"), out.get("changed"));
    assertEquals(85, ((Number) source.current().get("door.openOkDeg")).intValue(), "发布后当前值要立刻变");
    assertEquals(source.version(), out.get("rev"), "返回值里的版本要与刷新后的指纹一致");

    final List<ParamsStore.AuditRow> audits = store.audits();
    assertEquals(1, audits.size());
    final ParamsStore.AuditRow a = audits.get(0);
    assertEquals("door.openOkDeg", a.path());
    assertEquals(90, ((Number) a.oldValue()).intValue());
    assertEquals(85, ((Number) a.newValue()).intValue());
    assertEquals(64, a.snapshot().size(), "快照必须是**全量**（64 项：M1a 多房间加了 2 项，第 3 轮审查 C-10 加了 model.envelopeTolMm，W2 窗加了 8 条 window.*，W4 动线加了 6 条 route.*，W5 柱加了 4 条 column.*），不能只存改的那一项");
    assertEquals(85, ((Number) a.snapshot().get("door.openOkDeg")).intValue());
    assertEquals("现场说 85 更合适", a.note());
    assertEquals("1", a.changedBy());
  }

  @Test
  @DisplayName("不合法就一处都不写（未知项 + 超范围一次全报出来）")
  void rejectsAllOrNothing() {
    final ApiProblem e = assertThrows(ApiProblem.class, () -> service.publish(
        Map.of("door", Map.of("openOkDeg", 200), "nope", Map.of("x", 1)), "试试", me()));
    assertEquals(400, e.status());
    assertEquals("bad-params", e.reason());
    final Object errors = e.extra().get("errors");
    assertTrue(errors instanceof List && ((List<?>) errors).size() == 2, String.valueOf(errors));
    assertTrue(store.audits().isEmpty(), "被拒的发布不能留审计");
    assertEquals(90, ((Number) source.current().get("door.openOkDeg")).intValue(), "被拒的发布不能改到值");
  }

  @Test
  @DisplayName("发布一份一样的值：一项都不写、不留审计，并且**明说**没有改动")
  void unchangedWritesNothing() {
    final Map<String, Object> out = service.publish(Map.of("door", Map.of("openOkDeg", 90)), "（其实没改）", me());
    assertTrue(((List<?>) out.get("changed")).isEmpty());
    assertTrue(store.audits().isEmpty());
    assertTrue(String.valueOf(out.get("message")).contains("没有任何改动"), String.valueOf(out.get("message")));
  }

  @Test
  @DisplayName("只改一项时别的项不动（不是整份覆盖）")
  void onlyTouchesPatchedKeys() {
    service.publish(Map.of("room", Map.of("maxW", 25)), "放宽一点", me());
    assertEquals(25, ((Number) source.current().get("room.maxW")).intValue());
    assertEquals(3, ((Number) source.current().get("room.minW")).intValue());
    assertEquals(20, ((Number) source.current().get("room.maxD")).intValue());
    assertEquals(1, store.audits().size());
  }

  @Test
  @DisplayName("没有库（memory 档）：发布被明确拒绝，不是静默成功")
  void noStoreRefused() {
    final ParamsService memory = new ParamsService(schema, new ParamsSource(schema), new Provider(null));
    final ApiProblem e = assertThrows(ApiProblem.class,
        () -> memory.publish(Map.of("room", Map.of("maxW", 25)), "", me()));
    assertEquals("no-store", e.reason());
    assertNotEquals(0, e.getMessage().length());
  }

  /** 测试用的最小 ObjectProvider（`store` 为 null 就是"这一档没有库"） */
  private record Provider(ParamsStore store) implements org.springframework.beans.factory.ObjectProvider<ParamsStore> {
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
      return store == null ? java.util.stream.Stream.empty() : java.util.stream.Stream.of(store);
    }

    @Override
    public java.util.Iterator<ParamsStore> iterator() {
      return store == null ? java.util.List.<ParamsStore>of().iterator() : java.util.List.of(store).iterator();
    }

    @Override
    public java.util.stream.Stream<ParamsStore> orderedStream() {
      return stream();
    }
  }
}
