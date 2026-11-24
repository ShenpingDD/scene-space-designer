package com.scene.spatial.scheme;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.scene.spatial.kernel.Scheme;
import com.scene.spatial.scheme.SchemeStore.RevisionRow;
import com.scene.spatial.scheme.SchemeStore.RollbackResult;
import com.scene.spatial.scheme.SchemeStore.SaveResult;
import com.scene.spatial.scheme.SchemeStore.SchemeRow;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * SchemeStoreContractTest —— 两个存储实现的**同一套契约**
 *
 * ## 为什么要有这个测试
 *
 * `SchemeStore` 是个**接缝**（内存实现给没库的机器用，JDBC 实现给真实环境用）。
 * 接缝最容易烂的地方不是"某一个实现写错了"，而是**两个实现悄悄长得不一样** ——
 * 那么"我本地是好的"就成了假话。所以：同一套断言，跑两遍。
 *
 * ## 关于 skip
 *
 * JDBC 那一条在**连不上库 / 没跑过迁移**时判 **skip**，不假装绿（`Assumptions`）。
 * 判据：**"没跑起来"和"跑起来没问题"必须是两种颜色** —— 与"怕安静"是同一条纪律
 * （见 设计决策记录修正记录）。
 *
 * ## 只碰自己造的数据
 *
 * JDBC 侧只操作本测试自己创建的方案 id，结束在 `finally` 里按 id 清掉，
 * 不 `DELETE FROM scheme WHERE owner_id=1`（那会把开发同学手里的方案一起清空）。
 */
class SchemeStoreContractTest {

  /** V4 种下的本机用户。`scheme.owner_id` 有外键，所以这个 id 必须真实存在 */
  private static final long OWNER = 1L;

  /** 不存在的 owner，用来验隔离：换个 owner 就查不到别人的方案 */
  private static final long OTHER_OWNER = 999_999L;

  private static final String FORMAT = "scene-space-designer";

  /** 三串**字面量** md5（不是现算的）：断言要钉住"库里的值原样进出"，现算会把两处一起改错 */
  private static final String MD5_A = "0123456789abcdef0123456789abcdef";
  private static final String MD5_B = "fedcba9876543210fedcba9876543210";
  private static final String MD5_X = "ffffffffffffffffffffffffffffffff";

  /** 封面固定名（用户拍板：不跟版本走，一次方案一张图，新的覆盖旧的） */
  private static String coverPathOf(long id) {
    return "assets/covers/" + id + ".png";
  }

  @Test
  @DisplayName("内存实现 · 契约")
  void inMemoryStore() {
    contract(new SchemeStoreInMemory(), null, "内存");
  }

  @Test
  @DisplayName("JDBC 实现 · 契约（连不上库则 skip，不假装绿）")
  void jdbcStore() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null,
        "跳过：连不上 MySQL，或这个库还没跑过 V1–V4 迁移（这是 skip，不是通过）");

    final List<Long> mine = new ArrayList<>();
    try {
      contract(new SchemeStoreJdbc(jdbc), mine, "JDBC");
    } finally {
      cleanup(jdbc, mine);
    }
  }

  /**
   * **A1 真正要拦的那种情况**：历史里**没有**当前这一版的快照。
   *
   * 为什么单独一个用例、而且只有 JDBC 侧：它不是接口能造出来的状态，
   * 而是**库里可能出现的形态** —— `scheme_revision` 上没有任何约束保证"每版都有快照"。
   * ⚠️ 注意分寸：2026-09-29 实测当前 5 条方案的快照**都是完整的**（rev 2/2/1/1/1 ↔ 留痕 7 条），
   * 所以这个用例是**模拟**出来的缺口，不是"现在库里就有"。它值得留着，因为缺口一旦出现，
   * 代价是永久丢掉内容，而修它的成本就是这一句 —— 内存实现造不出这种历史，所以它只跑在 JDBC 侧；
   * 与其为了对称去假造一个接口来造它（那会让「不可能发生的事」多一条假路径），
   * 不如说清它只属于真库。
   *
   * 这个用例去掉的话，A1 那句「回滚前先自动存一版」就**只剩一条断言**（本来就留着的那种），
   * 而那条断言在任何完整历史下都会通过 —— 它证明不了那句规矩真的救了东西。
   */
  @Test
  @DisplayName("JDBC · 老数据缺口：回滚会把当前内容补存成快照（否则它就永久没了）")
  void rollbackSavesCurrentWhenHistoryHasGap() {
    final JdbcClient jdbc = jdbcOrNull();
    Assumptions.assumeTrue(jdbc != null,
        "跳过：连不上 MySQL，或这个库还没跑过 V1–V4 迁移（这是 skip，不是通过）");

    final List<Long> mine = new ArrayList<>();
    try {
      final SchemeStoreJdbc store = new SchemeStoreJdbc(jdbc);
      final SchemeRow s = store.create(OWNER, "缺口用例", room(8, 6, 2.8), FORMAT, 111, null);
      mine.add(s.id());
      assertTrue(store.save(s.id(), OWNER, 1, null, room(9, 7, 3.0), Scheme.FORMAT, 222, null, "改房间").isOk());

      // 造出缺口：**只删第 2 版的快照**（不是删行、不是删方案）——
      // 模拟"只写了主表、没写留痕"的那种历史（接口本身造不出来，所以直接删一行）
      jdbc.sql("DELETE FROM scheme_revision WHERE scheme_id = :id AND rev = 2")
          .param("id", s.id()).update();
      assertTrue(store.revision(s.id(), OWNER, 2).isEmpty(), "缺口造好了：第 2 版没有快照");

      final RollbackResult r = store.rollback(s.id(), OWNER, 2, 1, null, null);
      assertTrue(r.isOk(), "第 1 版有快照 → 回滚能成");
      assertFalse(r.keptWasExisting(),
          "A1：回滚前那一版**本来没留着** → 服务端要如实说「本次补存」，而不是冒功说「一直都有」");
      assertEquals(3, r.applied().rev(), "回滚产生新的第 3 版");
      assertEquals(8, r.applied().state().get("w"), "行内容回到第 1 版");

      // ⬇ 核心：那份**差点被永久丢掉**的内容现在拿得回来了
      final RevisionRow kept = store.revision(s.id(), OWNER, 2).orElseThrow();
      assertEquals(9, kept.state().get("w"), "A1：回滚前的第 2 版内容被补存下来了（不补就永远没了）");
      assertEquals(222, kept.paramsRev(), "补存的快照连参数指纹一起留（否则它回滚后会声称自己是在旧参数下摆的）");
      assertTrue(kept.note().contains("回滚前自动留存"),
          "备注要写清它是怎么来的，而不是冒充一次普通保存：[" + kept.note() + "]");
    } finally {
      cleanup(jdbc, mine);
    }
  }

  // ───────────────────────── 契约本体：两实现一字不差地跑同一段 ─────────────────────────

  /**
   * @param mine 非 null 时，把本测试创建的 id 记下来，供调用方收尾清理
   */
  private void contract(SchemeStore store, List<Long> mine, String tag) {
    // ① 新建：rev 必须从 1 起 —— 0 留给"从未保存过的草稿"，否则"没保存过"和"保存过第 0 版"分不清
    final SchemeRow a = store.create(OWNER, tag + "库房 A", room(8, 6, 2.8), FORMAT, 111, null);
    track(mine, a.id());
    assertEquals(1, a.rev(), tag + "：新建的 rev 从 1 起");
    assertEquals(OWNER, a.ownerId(), tag + "：owner 写对");
    assertFalse(a.deleted(), tag + "：新建不是已删");
    assertEquals(111, a.paramsRev(), tag + "：创建时记下参数表指纹");
    assertEquals(FORMAT, a.format(), tag + "：格式版本落库");
    assertEquals(8, a.state().get("w"), tag + "：state 原样带回（往返一致）");
    assertNotNull(a.createdAt(), tag + "：created_at 必须有值");

    // ② 归属隔离：换 owner 就查不到
    assertTrue(store.find(a.id(), OWNER).isPresent(), tag + "：按 owner 查得到");
    assertTrue(store.find(a.id(), OTHER_OWNER).isEmpty(), tag + "：换 owner 查不到（单租户也按 owner 过滤）");

    // ③ 列表按更新时间倒序：让 b 比 a 晚一点，b 应排在 a 前面
    sleep(5);
    final SchemeRow b = store.create(OWNER, tag + "库房 B", room(8, 6, 2.8), FORMAT, 111, null);
    track(mine, b.id());
    assertTrue(indexOf(store, b.id()) < indexOf(store, a.id()), tag + "：列表按更新时间倒序（新的在前）");

    // ④ 乐观锁：rev 对不上 → 冲突，且要带回**服务端当前 rev**（前端才能说"刷新到最新 or 另存"）
    final SaveResult stale = store.save(a.id(), OWNER, 999, null, room(9, 7, 3.0), Scheme.FORMAT, 222, null, "错版本");
    assertFalse(stale.isOk(), tag + "：rev 对不上必须判冲突");
    assertNotNull(stale.conflict(), tag + "：冲突要带服务端当前行");
    assertEquals(1, stale.conflict().rev(), tag + "：冲突带回的 currentRev 是服务端的真实版本");
    assertFalse(stale.notFound(), tag + "：版本冲突**不是**\"不存在\"（两者状态码不同）");

    // ⑤ 正常保存：rev 加一、name=null 表示不改名、参数指纹要刷新、存的是新 state
    sleep(5);
    final SaveResult ok = store.save(a.id(), OWNER, 1, null, room(9, 7, 3.0), Scheme.FORMAT, 222, null, "改房间");
    assertTrue(ok.isOk(), tag + "：rev 正确时保存成功");
    assertEquals(2, ok.saved().rev(), tag + "：保存成功 rev 加一");
    assertEquals(tag + "库房 A", ok.saved().name(), tag + "：name 传 null = 不改名");
    assertEquals(222, ok.saved().paramsRev(), tag + "：**每次保存都要刷新参数指纹**（否则永远停在创建时的值）");
    assertEquals(9, ok.saved().state().get("w"), tag + "：存的是新 state");
    assertEquals(Scheme.FORMAT, ok.saved().format(),
        tag + "：保存也要刷新 format_version（只写 room_json 会让旧方案出现「JSON 新代、列旧代」）");
    assertTrue(indexOf(store, a.id()) < indexOf(store, b.id()), tag + "：改过的排到前面");

    // ⑤b W5 柱：create→save→find 柱逐字段相等，且 format_version 跟着刷成**当前代**
    //     （设计决策记录 §四.2：SQL_SAVE 原先不写 format_version，旧方案会出现「JSON 新代、列旧代」）
    final Map<String, Object> colState = room(8, 6, 2.8);
    final Map<String, Object> col = new LinkedHashMap<>();
    col.put("id", 3);
    col.put("x", 4.2);
    col.put("z", 2.5);
    col.put("w", 0.5);
    col.put("d", 0.2);
    colState.put("columns", List.of(col));
    final SchemeRow cc = store.create(OWNER, tag + "柱库房", colState, FORMAT, 111, null);
    track(mine, cc.id());
    assertTrue(store.save(cc.id(), OWNER, 1, null, colState, Scheme.FORMAT, 222, null, "加柱").isOk(),
        tag + "：含柱方案能保存");
    final SchemeRow reread = store.find(cc.id(), OWNER).orElseThrow();
    assertEquals(Scheme.FORMAT, reread.format(), tag + "：保存要把 format_version 刷成当前代（否则 GET/分享拿旧格式）");
    @SuppressWarnings("unchecked")
    final List<Map<String, Object>> cols = (List<Map<String, Object>>) reread.state().get("columns");
    assertEquals(1, cols.size(), tag + "：柱不许在存储往返里丢");
    assertEquals(3, cols.get(0).get("id"), tag + "：柱 id 原样");
    assertEquals(4.2, ((Number) cols.get(0).get("x")).doubleValue(), 1e-12, tag + "：柱 x 原样");
    assertEquals(2.5, ((Number) cols.get(0).get("z")).doubleValue(), 1e-12, tag + "：柱 z 原样");
    assertEquals(0.5, ((Number) cols.get(0).get("w")).doubleValue(), 1e-12, tag + "：柱 w 原样");
    assertEquals(0.2, ((Number) cols.get(0).get("d")).doubleValue(), 1e-12, tag + "：柱 d 原样");

    // ⑥ 留痕：新的在前，含"创建"与本次备注
    final List<RevisionRow> revs = store.revisions(a.id(), OWNER);
    assertEquals(2, revs.size(), tag + "：两次写入 = 两条留痕");
    assertEquals(2, revs.get(0).rev(), tag + "：留痕按 rev 倒序");
    assertEquals("改房间", revs.get(0).note(), tag + "：备注原样保存");
    assertEquals(1, revs.get(1).rev(), tag + "：新建那一条在里面");
    assertEquals("创建", revs.get(1).note(), tag + "：新建那条的备注是\"创建\"（两实现同款）");
    assertNotNull(revs.get(0).createdAt(), tag + "：留痕要有时间");
    // 3e：**每一版带自己的快照**，而不能是「最新版的内容从头到尾」。
    // 这个断言盯的是一个很容易写错的形态：历史里存的是同一份内容的引用，于是所有版本
    // 看起来都等于最新版 —— 那时版本列表与回滚都会**安静地用错内容**。
    assertEquals(9, revs.get(0).state().get("w"), tag + "：第 2 版的快照是第 2 版的内容");
    assertEquals(8, revs.get(1).state().get("w"), tag + "：第 1 版的快照还是第 1 版的内容（不是最新版顶上）");
    assertEquals(222, revs.get(0).paramsRev(), tag + "：每版记下自己的参数指纹");
    assertEquals(111, revs.get(1).paramsRev(), tag + "：第 1 版记的是创建时的指纹");

    // ⑦ 软删：删得掉、删两次返回 false、删了查不到、**删了不能再保存**（是 notFound 不是 conflict）
    assertTrue(store.softDelete(b.id(), OWNER), tag + "：软删返回 true");
    assertFalse(store.softDelete(b.id(), OWNER), tag + "：重复软删返回 false");
    assertTrue(store.find(b.id(), OWNER).isEmpty(), tag + "：软删后查不到");
    assertTrue(store.list(OWNER, false).stream().noneMatch(r -> r.id() == b.id()), tag + "：软删后不在列表里");

    // R6-3 3e：**另一半也得给得出来** —— 否则「恢复」没有任何入口（只能靠直接改库）。
    // 两个实现都要给出同样两半：这里跑在内存实现与真库实现上各一遍，所以钉得住。
    final List<SchemeRow> trash = store.list(OWNER, true);
    assertTrue(trash.stream().anyMatch(r -> r.id() == b.id()), tag + "：软删后应该出现在回收站那一半");
    assertTrue(trash.stream().allMatch(SchemeRow::deleted), tag + "：回收站里不许混进没删的");
    assertTrue(store.list(OWNER, false).stream().noneMatch(SchemeRow::deleted), tag + "：方案库里不许混进删过的");
    assertTrue(trash.stream().noneMatch(r -> store.list(OWNER, false).stream().anyMatch(x -> x.id() == r.id())),
        tag + "：两半不许重叠");

    // ⑦-bis 维护端方案库那一半（U1）：`listAll` 给**全部账号**的方案，两半的语义与 list 一致。
    // 真库里还有别人的方案，所以这里钉的是"我们这两行在不在、两半重不重叠、顺序对不对"，
    // 而不是"一共几行"。
    final List<SchemeRow> all = store.listAll(false);
    final List<SchemeRow> allTrash = store.listAll(true);
    assertTrue(all.stream().anyMatch(r -> r.id() == a.id()), tag + "：全部方案里有 a（未删的）");
    assertTrue(all.stream().noneMatch(r -> r.id() == b.id()), tag + "：b 已软删 → 不在方案库那一半");
    assertTrue(all.stream().noneMatch(SchemeRow::deleted), tag + "：listAll 的方案库那一半不许混进删过的");
    assertTrue(allTrash.stream().anyMatch(r -> r.id() == b.id()), tag + "：b 出现在 listAll 的回收站那一半");
    assertTrue(allTrash.stream().allMatch(SchemeRow::deleted), tag + "：listAll 的回收站那一半只含已删的");
    assertTrue(all.stream().noneMatch(r -> allTrash.stream().anyMatch(x -> x.id() == r.id())),
        tag + "：listAll 的两半不许重叠");
    for (int i = 1; i < all.size(); i++) {
      final SchemeRow prev = all.get(i - 1);
      final SchemeRow cur = all.get(i);
      final int c = prev.updatedAt().compareTo(cur.updatedAt());
      assertTrue(c > 0 || (c == 0 && prev.id() > cur.id()),
          tag + "：listAll 按 updated_at 倒序、同一时刻按 id 倒序（第 " + i + " 位不满足）");
    }
    final SaveResult afterDelete = store.save(b.id(), OWNER, 1, null, room(8, 6, 2.8), Scheme.FORMAT, 111, null, "");
    assertTrue(afterDelete.notFound(), tag + "：已删的方案不能再保存（notFound，不是冲突）");
    assertTrue(store.revisions(b.id(), OWNER).isEmpty(), tag + "：已删的方案不给留痕");

    // ⑧ 完全不存在的 id：四种操作都要说"没有"，而不是抛异常或误判冲突
    final long ghost = 987_654_321L;
    assertTrue(store.find(ghost, OWNER).isEmpty(), tag + "：不存在的 id 查不到");
    assertTrue(store.save(ghost, OWNER, 1, null, room(8, 6, 2.8), Scheme.FORMAT, 111, null, "").notFound(), tag + "：不存在的 id 保存 → notFound");
    assertFalse(store.softDelete(ghost, OWNER), tag + "：不存在的 id 删除 → false");
    assertTrue(store.revisions(ghost, OWNER).isEmpty(), tag + "：不存在的 id 留痕为空");

    // ── ⑨～⑪ 是 R6-3 3e 新增的三个写操作（恢复 / 复制 / 回滚）────────────────────
    //    为什么全放进这份契约：它们也是**签名的一部分**，两个实现必须一字不差地同行为 ——
    //    而这三个动作都要读历史，"我本地（内存档）是好的"在这儿尤其容易变成假话

    // ⑨ 恢复：回收站那一半得有出口，而且「本来就没删」必须是句**真话**，不是一句「不存在」
    assertFalse(store.restore(ghost, OWNER), tag + "：不存在的 id 恢复 → false");
    assertTrue(store.findAny(ghost, OWNER).isEmpty(), tag + "：findAny 对不存在的 id 也是空");
    assertTrue(store.findAny(b.id(), OWNER).isPresent(), tag + "：findAny 看得见已删的行");
    assertTrue(store.find(b.id(), OWNER).isEmpty(), tag + "：同一个 id，find 看不见已删的行（两半的分工）");
    assertTrue(store.restore(b.id(), OWNER), tag + "：恢复已删的 → true");
    assertFalse(store.restore(b.id(), OWNER), tag + "：重复恢复 → false（服务层据此回 400「本来就没删」而不是 404）");
    assertEquals(1, store.find(b.id(), OWNER).orElseThrow().rev(), tag + "：**恢复不动 rev**（它不是一次内容编辑）");
    assertTrue(store.list(OWNER, false).stream().anyMatch(r -> r.id() == b.id()), tag + "：恢复后回到方案库那一半");
    assertTrue(store.list(OWNER, true).stream().noneMatch(r -> r.id() == b.id()), tag + "：恢复后不在回收站里了");
    // 再把 b 删回去：下面要验「已删的不给复制」，需要一个已删的样本
    assertTrue(store.softDelete(b.id(), OWNER), tag + "：再把 b 删回去");

    // ⑩ 复制一份：带的是**源方案当前这一版**的内容；档案信息（状态/封面/标签）一律重新开始
    final SchemeRow copy = store.duplicate(a.id(), OWNER, null);
    assertNotNull(copy, tag + "：复制库里的方案 → 有结果");
    track(mine, copy.id());
    assertNotEquals(a.id(), copy.id(), tag + "：副本是新 id");
    assertEquals(1, copy.rev(), tag + "：副本从第 1 版起");
    assertEquals(tag + "库房 A 副本", copy.name(), tag + "：不传名字 → <源名> 副本");
    assertEquals(9, copy.state().get("w"), tag + "：带的是源方案**当前这一版**的内容");
    assertEquals(222, copy.paramsRev(), tag + "：参数指纹跟着内容走");
    assertEquals("draft", copy.status(), tag + "：状态重置成 draft（「已交付」说的是源方案那一份）");
    assertEquals("", copy.coverFile(), tag + "：不复制封面（旧图会变成假封面）");
    assertNull(copy.tags(), tag + "：不复制标签（档案信息说的是源方案）");
    assertFalse(copy.deleted(), tag + "：副本不是已删");
    assertTrue(store.list(OWNER, false).stream().anyMatch(r -> r.id() == copy.id()), tag + "：副本出现在方案库里");
    final List<RevisionRow> copyRevs = store.revisions(copy.id(), OWNER);
    assertEquals(1, copyRevs.size(), tag + "：副本只有第 1 版");
    assertEquals("复制自 #" + a.id() + " 第 2 版", copyRevs.get(0).note(), tag + "：第 1 版的备注说清它从哪来");
    assertEquals(9, copyRevs.get(0).state().get("w"), tag + "：副本第 1 版的快照 = 源方案的内容");
    assertEquals(222, copyRevs.get(0).paramsRev(), tag + "：副本第 1 版的参数指纹也一起拷过来");
    assertNull(store.duplicate(b.id(), OWNER, null), tag + "：已删的方案不给复制（先恢复再复制）");
    assertNull(store.duplicate(ghost, OWNER, null), tag + "：不存在的 id → null");
    final SchemeRow named = store.duplicate(a.id(), OWNER, tag + "自定义名");
    assertNotNull(named, tag + "：传了名字也能复制");
    track(mine, named.id());
    assertEquals(tag + "自定义名", named.name(), tag + "：传了名字就用传的");
    final SchemeRow clipped = store.duplicate(a.id(), OWNER, "x".repeat(200));
    assertNotNull(clipped, tag + "：超长名字也要能复制成");
    track(mine, clipped.id());
    assertEquals(128, clipped.name().length(), tag + "：名字截到 128（不截的话这条 INSERT 会因超长报错）");

    // ⑪ 回滚：**用户拍板 A1 —— 回滚前先自动存一版**
    //    此刻 a 是第 2 版（内容 9×7×3.0），历史里 1、2 都在
    final RollbackResult rb = store.rollback(a.id(), OWNER, 2, 1, null, null);
    assertTrue(rb.isOk(), tag + "：回滚到第 1 版应该成功");
    assertEquals(3, rb.applied().rev(), tag + "：回滚**产生新的一版**（rev 继续往前走，不往回退）");
    assertEquals(8, rb.applied().state().get("w"), tag + "：行内容回到第 1 版");
    assertEquals(111, rb.applied().paramsRev(), tag + "：参数指纹也回到第 1 版（否则行会声称自己是在新参数下摆的）");
    assertEquals(tag + "库房 A", rb.applied().name(), tag + "：回滚不动方案名（名字没进历史表，回不了）");
    assertTrue(rb.keptWasExisting(), tag + "：A1：回滚前那一版本来就在历史里 → 如实说「已有」，不冒功");
    final List<RevisionRow> hist = store.revisions(a.id(), OWNER);
    assertEquals(3, hist.size(), tag + "：回滚后历史多了一条");
    assertEquals(3, hist.get(0).rev(), tag + "：最新的是回滚那一版");
    assertEquals("回滚到第 1 版", hist.get(0).note(), tag + "：备注写成一句人话（从第几版回到第几版）");
    assertEquals(8, hist.get(0).state().get("w"), tag + "：回滚那一版的内容 = 目标版本");
    // ⬇ A1 的**核心断言**：回滚前的内容没丢
    assertTrue(hist.stream().anyMatch(r -> r.rev() == 2 && "9".equals(String.valueOf(r.state().get("w")))),
        tag + "：A1：回滚前的内容还在历史里（第 2 版没被抹掉）");

    // 单版查询：回滚拿原料用的那一句
    assertEquals(8, store.revision(a.id(), OWNER, 1).orElseThrow().state().get("w"), tag + "：能单拿第 1 版的快照");
    assertTrue(store.revision(a.id(), OWNER, 99).isEmpty(), tag + "：没有的那一版 → 空");
    assertTrue(store.revision(b.id(), OWNER, 1).isEmpty(), tag + "：已删的方案不给快照（与 find 同口径）");

    // 目标版本没有快照 —— **单独一种结果**，它既不是「方案不存在」也不是「版本冲突」
    assertTrue(store.rollback(a.id(), OWNER, 3, 99, null, null).targetMissing(),
        tag + "：那一版没有快照 → targetMissing（缺快照与「方案不存在」是两种结果，不能被混成一个 404）");
    assertTrue(store.rollback(ghost, OWNER, 1, 1, null, null).notFound(), tag + "：不存在的方案 → notFound");
    assertTrue(store.rollback(b.id(), OWNER, 1, 1, null, null).notFound(), tag + "：已删的方案不给回滚");

    // 冲突时**一条留痕都不能写**：A1 那一步补写快照必须在乐观锁闸门**之后**
    final int revsBefore = store.revisions(a.id(), OWNER).size();
    final RollbackResult stale2 = store.rollback(a.id(), OWNER, 999, 1, null, null);
    assertFalse(stale2.isOk(), tag + "：expectRev 对不上 → 冲突");
    assertNotNull(stale2.conflict(), tag + "：冲突要带回服务端当前行（前端才能说「刷新到最新」）");
    assertEquals(3, stale2.conflict().rev(), tag + "：带回的 currentRev 是服务端的真实版本");
    assertEquals(3, store.find(a.id(), OWNER).orElseThrow().rev(), tag + "：冲突时行内容没被动过");
    assertEquals(revsBefore, store.revisions(a.id(), OWNER).size(),
        tag + "：冲突时**一条留痕都没写**（把补写放在闸门之后，就是为了这一句）");

    // ── ⑫ 是 R6-3 3f 新增的写操作（换封面）────────────────────────────────────
    //    为什么也放进契约：它是签名的一部分，而这里**两个实现最容易长得不一样** ——
    //    「不动 rev / 只换封面三列 / 回收站里的不接」这三句话，任何一句漏在一边都看不出来，
    //    而漏掉的后果会以"我本地是好的"的形式出现在别人机器上。

    final SchemeRow beforeCover = store.find(a.id(), OWNER).orElseThrow();
    assertFalse(store.setCover(ghost, OWNER, "assets/covers/x.png", 10, MD5_X, "封面手"),
        tag + "：不存在的 id → false");
    assertFalse(store.setCover(b.id(), OWNER, "assets/covers/x.png", 10, MD5_X, "封面手"),
        tag + "：**回收站里的方案不接新封面**（它在列表里都还没回去）");
    assertTrue(store.setCover(a.id(), OWNER, coverPathOf(a.id()), 4096, MD5_A, "封面手"),
        tag + "：方案库里的方案 → true");

    final SchemeRow afterCover = store.find(a.id(), OWNER).orElseThrow();
    assertEquals(beforeCover.rev(), afterCover.rev(),
        tag + "：**换封面不动 rev**（封面不是内容，不产生新版本 —— 与 softDelete / restore 同一条原则）");
    assertEquals(coverPathOf(a.id()), afterCover.coverFile(), tag + "：cover_file 写上了");
    assertEquals(4096, afterCover.coverSize(), tag + "：cover_size 写上了");
    assertEquals(MD5_A, afterCover.coverChecksum(),
        tag + "：cover_checksum 写上了（V9 建列时的用途就是「前端缓存键」）");
    assertEquals("封面手", afterCover.updatedBy(), tag + "：updated_by 记下是谁换的");
    assertFalse(afterCover.updatedAt().isBefore(beforeCover.updatedAt()),
        tag + "：updated_at 也跟着走（库里那一行真的变了，审计不该少这一次写）");
    // 封面是**附加物**：换一次封面不许顺手动别的列
    assertEquals(beforeCover.name(), afterCover.name(), tag + "：名字不许被动");
    assertEquals(beforeCover.status(), afterCover.status(), tag + "：状态不许被动");
    assertEquals(beforeCover.paramsRev(), afterCover.paramsRev(), tag + "：参数指纹不许被动");
    assertEquals(beforeCover.state().get("w"), afterCover.state().get("w"), tag + "：内容不许被动");
    assertEquals(beforeCover.state().get("d"), afterCover.state().get("d"), tag + "：内容不许被动");

    // 再换一次（**覆盖式**：文件名固定、新的盖旧的）—— 这一条钉的是缓存问题
    assertTrue(store.setCover(a.id(), OWNER, coverPathOf(a.id()), 8192, MD5_B, "封面手2"),
        tag + "：重复换封面要成功（覆盖式，不是「只能换一次」）");
    final SchemeRow again = store.find(a.id(), OWNER).orElseThrow();
    assertNotEquals(MD5_A, again.coverChecksum(),
        tag + "：**指纹必须跟着内容变** —— 它不变的话前端 ?v= 也不变，用户就一直看缓存里的旧图");
    assertEquals(8192, again.coverSize(), tag + "：大小跟着变");
    assertEquals(MD5_B, again.coverChecksum(), tag + "：换成了第二张的指纹");
    assertEquals("封面手2", again.updatedBy(), tag + "：谁换的跟着更新");
    assertEquals(beforeCover.rev(), again.rev(), tag + "：换了两次 rev 也一动没动");

    // ── ⑮ 是 R6-5 新增的写操作（交付流转状态置位 / 人工改回）─────────────────────
    //    与封面同一条口径：**不动 rev**（它不是内容编辑），但 status 与 updated_by 要真的变；
    //    回收站里的方案不参与交付流转（它连列表都还没回去）。
    //    这一条必须进契约：「改回也要能改」这句话漏在一边，就成了「只能置位、改不回去」
    //    —— 而那与 A11 说的「允许人工改回」是相反的。
    final SchemeRow beforeStatus = store.find(a.id(), OWNER).orElseThrow();
    assertEquals(SchemeStore.STATUS_DRAFT, beforeStatus.status(),
        tag + "：新建的方案状态应当是 draft（两个实现都要显式写它）");
    assertFalse(store.setStatus(ghost, OWNER, SchemeStore.STATUS_DELIVERED, "交付手"),
        tag + "：不存在的 id → false");
    assertFalse(store.setStatus(b.id(), OWNER, SchemeStore.STATUS_DELIVERED, "交付手"),
        tag + "：**回收站里的方案不参与交付流转**");
    assertTrue(store.setStatus(a.id(), OWNER, SchemeStore.STATUS_DELIVERED, "交付手"),
        tag + "：方案库里的方案 → true");
    final SchemeRow afterStatus = store.find(a.id(), OWNER).orElseThrow();
    assertEquals(SchemeStore.STATUS_DELIVERED, afterStatus.status(), tag + "：状态真的变成已交付");
    assertEquals(beforeStatus.rev(), afterStatus.rev(),
        tag + "：**置交付状态不动 rev**（交付流转不是内容编辑 —— 与 setCover 同一条口径）");
    assertEquals("交付手", afterStatus.updatedBy(), tag + "：updated_by 记下是谁置的");
    assertTrue(store.setStatus(a.id(), OWNER, SchemeStore.STATUS_DRAFT, "交付手"),
        tag + "：**人工改回也要能改**（A11 的后半句）");
    final SchemeRow back = store.find(a.id(), OWNER).orElseThrow();
    assertEquals(SchemeStore.STATUS_DRAFT, back.status(), tag + "：改回来了");
    assertEquals(afterStatus.name(), back.name(), tag + "：改状态不许顺手动别的列");
    assertEquals(afterStatus.coverChecksum(), back.coverChecksum(), tag + "：封面不许被动");
    assertEquals(afterStatus.paramsRev(), back.paramsRev(), tag + "：参数指纹不许被动");
    assertEquals(afterStatus.rev(), back.rev(), tag + "：改回来也不动 rev");

    // ── ⑬ 只改名（验收 第二轮：方案名内联编辑）──────────────────────────────────
    //    这一条的全部意义是「**不产生新版本**」：一次改名如果顺手多出一版，
    //    版本列表与回滚都会跟着变糊（用户分不清"这两版差在哪"）。
    //    两个实现都必须做到，所以放进同一份契约里。
    final SchemeRow beforeRename = store.find(a.id(), OWNER).orElseThrow();
    final int revsBeforeRename = store.revisions(a.id(), OWNER).size();
    assertTrue(store.rename(ghost, OWNER, tag + "改个名").isEmpty(), tag + "：不存在的 id → empty");
    assertTrue(store.rename(b.id(), OWNER, tag + "改个名").isEmpty(), tag + "：回收站里的方案不给改名");
    assertTrue(store.rename(a.id(), OTHER_OWNER, tag + "改个名").isEmpty(),
        tag + "：别人的方案 → empty（对外就是 404，与 save 同口径）");
    final SchemeRow renamed = store.rename(a.id(), OWNER, tag + "库房 A（改名）").orElseThrow();
    assertEquals(tag + "库房 A（改名）", renamed.name(), tag + "：名字真的换了");
    assertEquals(beforeRename.rev(), renamed.rev(), tag + "：**改名不动 rev**（它不是一次内容编辑）");
    assertEquals(beforeRename.state().get("w"), renamed.state().get("w"), tag + "：内容不许被动");
    assertEquals(beforeRename.status(), renamed.status(), tag + "：状态不许被动");
    assertEquals(beforeRename.paramsRev(), renamed.paramsRev(), tag + "：参数指纹不许被动");
    assertEquals(beforeRename.coverChecksum(), renamed.coverChecksum(), tag + "：封面不许被动");
    assertFalse(renamed.updatedAt().isBefore(beforeRename.updatedAt()),
        tag + "：updated_at 跟着走（库里那一行真的变了）");
    assertEquals(revsBeforeRename, store.revisions(a.id(), OWNER).size(),
        tag + "：**改名不写版本记录**（写了一条的话，历史里就多出一版内容一样的）");
    assertEquals(tag + "库房 A（改名）", store.find(a.id(), OWNER).orElseThrow().name(),
        tag + "：读回来是新名字");
    assertTrue(store.list(OWNER, false).stream()
            .anyMatch(r -> r.id() == a.id() && (tag + "库房 A（改名）").equals(r.name())),
        tag + "：列表里也是新名字");
    assertTrue(store.rename(a.id(), OWNER, tag + "库房 A（改名）").isPresent(),
        tag + "：同一个名字再改一次 → 幂等成功（再点一次不该报错）");

    // ⑫ R6-4 B4d：**结论（audit_json）要能原样进出，而且两份实现同语义**
    //
    // 为什么这一列必须落在契约测试里：它的两个坑都是"看起来没问题"的那种 ——
    //   ① 写得进、读不出（`COLS` 漏了它 → 界面上永远是"没存下当时的结论"，和真没存过的老方案长得一样）；
    //   ② 某一份实现忘了带（内存版对、JDBC 版漏 → "我本地是好的"又成了假话）。
    final String verdictA = "{\"report\":{\"items\":2,\"trouble\":1,\"clean\":true},"
        + "\"paramsRev\":358430008,\"catalogRev\":3}";
    final String verdictB = "{\"report\":{\"items\":3,\"issues\":1,\"clean\":false},"
        + "\"paramsRev\":351788645,\"catalogRev\":3}";
    // ⚠️ 实测（2026-09-30）：**MySQL 的 JSON 列会重排格式**（加空格、按它自己的顺序放键）——
    //    所以这一列只能**按语义**比，按文本比会红得莫名其妙。这条不是测试的将就，
    //    是这一列的契约：读它的人（服务层 / 界面）都是先 parse 再用，没有一处依赖字节。

    final SchemeRow v = store.create(OWNER, tag + "结论方案", room(8, 6, 2.8), FORMAT, 111, verdictA);
    track(mine, v.id());
    assertVerdict(verdictA, v.auditJson(), tag + "：创建时带回来的行就要有结论");
    assertVerdict(verdictA, store.find(v.id(), OWNER).orElseThrow().auditJson(),
        tag + "：结论要读得回来（COLS 里漏了它就会永远是 null）");
    assertVerdict(verdictA, store.revisions(v.id(), OWNER).get(0).auditJson(), tag + "：第 1 版的留痕也带结论");

    assertTrue(store.save(v.id(), OWNER, 1, null, room(9, 7, 3.0), Scheme.FORMAT, 222, verdictB, "改过").isOk());
    assertVerdict(verdictB, store.find(v.id(), OWNER).orElseThrow().auditJson(),
        tag + "：保存要**换掉**结论（内容变了，旧结论就作废）");
    assertVerdict(verdictB, store.revision(v.id(), OWNER, 2).orElseThrow().auditJson(),
        tag + "：第 2 版的结论跟着这次保存走");

    assertTrue(store.rollback(v.id(), OWNER, 2, 1, verdictB, null).isOk());
    assertVerdict(verdictB, store.find(v.id(), OWNER).orElseThrow().auditJson(), tag + "：回滚后的结论写得进");

    final SchemeRow vcopy = store.duplicate(v.id(), OWNER, null);
    assertNotNull(vcopy, tag + "：能复制");
    track(mine, vcopy.id());
    assertVerdict(verdictB, vcopy.auditJson(), tag + "：复制要把结论一起带过来（内容是同一份）");
    assertVerdict(verdictB, store.find(vcopy.id(), OWNER).orElseThrow().auditJson(), tag + "：副本的结论也读得回来");

    // 老方案（这一列存在之前存的）就是 null —— 而且 null 必须**原样**回来，不许变成空串
    final SchemeRow old = store.create(OWNER, tag + "老方案", room(8, 6, 2.8), FORMAT, 111, null);
    track(mine, old.id());
    assertNull(store.find(old.id(), OWNER).orElseThrow().auditJson(),
        tag + "：没结论就是 null（界面靠它区分「没存过」和「存了个空的」）");
  }

  // ───────────────────────── 工具 ─────────────────────────

  /**
   * 比两条结论：**按语义**（parse 之后比内容）。
   *
   * MySQL 的 JSON 列会把文本重排（实测），所以不能按字符串比 —— 但"重排"不影响任何人：
   * 读它的地方都是先 parse 再用。这个帮手就是把这条契约写下来。
   */
  private static void assertVerdict(String expected, String actual, String msg) {
    assertNotNull(actual, msg + "（是 null —— 那就是没存进去）");
    try {
      final ObjectMapper m = new ObjectMapper();
      assertEquals(m.readTree(expected), m.readTree(actual), msg);
    } catch (Exception e) {
      throw new AssertionError(msg + "：JSON 读不回来 —— " + e.getMessage(), e);
    }
  }

  private static void track(List<Long> mine, long id) {
    if (mine != null) mine.add(id);
  }

  private static int indexOf(SchemeStore store, long id) {
    final List<SchemeRow> rows = store.list(OWNER, false);
    for (int i = 0; i < rows.size(); i++) {
      if (rows.get(i).id() == id) return i;
    }
    return Integer.MAX_VALUE;
  }

  private static Map<String, Object> room(int w, int d, double h) {
    final Map<String, Object> m = new LinkedHashMap<>();
    m.put("w", w);
    m.put("d", d);
    m.put("h", h);
    m.put("walls", List.of(List.of(0, 0, w, 0), List.of(w, 0, w, d), List.of(w, d, 0, d), List.of(0, d, 0, 0)));
    m.put("items", List.of());
    return m;
  }

  private static void sleep(long ms) {
    try {
      Thread.sleep(ms);
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
    }
  }

  /** 连不上库、或没跑过迁移就返回 null —— 让上面的 assumeTrue 判成 skip */
  private static JdbcClient jdbcOrNull() {
    final String url = "jdbc:mysql://" + env("DB_HOST", "127.0.0.1") + ":" + env("DB_PORT", "3306")
        + "/" + env("DB_NAME", "spatial_design")
        + "?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&useSSL=false&allowPublicKeyRetrieval=true";
    final DriverManagerDataSource ds =
        new DriverManagerDataSource(url, env("DB_USER", "root"), env("DB_PASSWORD", ""));
    try (Connection c = ds.getConnection()) {
      if (count(c, "SELECT COUNT(*) FROM scheme") < 0) return null;
      if (count(c, "SELECT COUNT(*) FROM sys_user WHERE id = " + OWNER) == 0) {
        System.out.println("[skip] missing seeded local user id=1 -- run migration V4");
        return null;
      }
      return JdbcClient.create(ds);
    } catch (Exception e) {
      System.out.println("[skip] MySQL unreachable or migrations not applied: " + e.getMessage());
      return null;
    }
  }

  private static int count(Connection c, String sql) throws Exception {
    try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
      return rs.next() ? rs.getInt(1) : -1;
    }
  }

  /** 只清本测试自己造的行（先留痕后主表，外键顺序不能反） */
  private static void cleanup(JdbcClient jdbc, List<Long> mine) {
    for (final long id : mine) {
      jdbc.sql("DELETE FROM scheme_revision WHERE scheme_id = :id").param("id", id).update();
      jdbc.sql("DELETE FROM scheme WHERE id = :id").param("id", id).update();
    }
  }

  private static String env(String key, String fallback) {
    final String v = System.getenv(key);
    return v == null || v.isBlank() ? fallback : v;
  }
}