package com.scene.spatial.scheme;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

/**
 * SchemeStoreInMemory —— 内存实现（**仅开发档**：`spatial.store=memory`）
 *
 * 它存在的唯一理由：MySQL 还没到位时，**接口形状与乐观锁语义也能被真实验证**。
 * 所以它必须与 JDBC 实现**行为一致**（同一套契约、同一套测试），包括冲突判定。
 *
 * ⚠️ 生产档绝不会装配到它：默认 `spatial.store=jdbc`（见 application.yml），
 *    只有显式开 `local-nodb` 档才会用内存 —— **配置错了要响亮**，所以构造函数会 WARN 一遍。
 *
 * 线程安全：方法都 `synchronized`。不是为了性能（开发用），而是为了让"检查 rev → 写入"
 * 成为一个**临界区** —— 否则乐观锁在并发下就是假的（先查后写中间有窗口）。
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "memory")
public class SchemeStoreInMemory implements SchemeStore {

  private static final Logger log = LoggerFactory.getLogger(SchemeStoreInMemory.class);

  private final Map<Long, SchemeRow> rows = new LinkedHashMap<>();
  private final Map<Long, List<RevisionRow>> history = new LinkedHashMap<>();
  private final AtomicLong seq = new AtomicLong(1);

  /** 新方案的状态。与 `scheme.status` 的 DDL 默认值同值，但**显式写**：两边实现必须给同一个值 */
  private static final String STATUS_DRAFT = "draft";

  public SchemeStoreInMemory() {
    log.warn("方案存储 = **内存**（spatial.store=memory）：重启即丢、不落库。仅用于没有 MySQL 的开发环境。");
  }

  @Override
  public synchronized List<SchemeRow> list(long ownerId, boolean deleted) {
    return ordered(r -> r.ownerId() == ownerId && r.deleted() == deleted);
  }

  @Override
  public synchronized List<SchemeRow> listAll(boolean deleted) {
    return ordered(r -> r.deleted() == deleted);
  }

  /**
   * 挑出要的那一半并按同一个顺序排。
   *
   * ⚠️ 并列时按 id 倒序：JDBC 那侧的 ORDER BY 一直是 `updated_at DESC, id DESC`，
   *    而这里原来只有 updatedAt —— **两个实现在"同一时刻保存的两条谁在前"上不一致**。
   *    契约测试建的行都来自同一次操作，撞不上这个差别，所以一直没暴露。
   *    （`list` 与 `listAll` 共用这一处，维护端方案库不会再长出第二套排序规则。）
   */
  private List<SchemeRow> ordered(java.util.function.Predicate<SchemeRow> keep) {
    final List<SchemeRow> out = new ArrayList<>();
    for (final SchemeRow r : rows.values()) {
      if (keep.test(r)) out.add(r);
    }
    out.sort((a, b) -> {
      final int c = b.updatedAt().compareTo(a.updatedAt());
      return c != 0 ? c : Long.compare(b.id(), a.id());
    });
    return out;
  }

  @Override
  public synchronized Optional<SchemeRow> find(long id, long ownerId) {
    final SchemeRow r = rows.get(id);
    return r == null || r.deleted() || r.ownerId() != ownerId ? Optional.empty() : Optional.of(r);
  }

  @Override
  public synchronized SchemeRow create(long ownerId, String name, Map<String, Object> state,
                                       String format, int paramsRev, String auditJson) {
    final long id = seq.getAndIncrement();
    final LocalDateTime now = LocalDateTime.now();
    // 与 JDBC 实现同口径：新方案 status 显式给 draft（不靠默认值 —— 两边行为一致是铁律）
    final SchemeRow row = new SchemeRow(id, name, ownerId, state, format, paramsRev, 1, false,
        "", 0L, "", STATUS_DRAFT, null, String.valueOf(ownerId), now, now, auditJson);
    rows.put(id, row);
    // 第 1 版同时进历史，且**带上快照与参数指纹**（3e 起）：
    // 没有快照的版本历史只能显示一串编号，而"回滚到哪一版"是个必须做的选择
    history.put(id, new ArrayList<>(List.of(new RevisionRow(1, "创建", now, paramsRev, state, auditJson))));
    return row;
  }

  @Override
  public synchronized SaveResult save(long id, long ownerId, int expectedRev, String name,
                                      Map<String, Object> state, String format, int paramsRev,
                                      String auditJson, String note) {
    final SchemeRow cur = rows.get(id);
    if (cur == null || cur.deleted() || cur.ownerId() != ownerId) return SaveResult.missing();
    if (cur.rev() != expectedRev) return SaveResult.conflict(cur);

    final int nextRev = cur.rev() + 1;
    final LocalDateTime now = LocalDateTime.now();
    // 封面/标签/status 保持原样（保存方案不改这三样），只有 updated_by 跟着这次操作走
    // format 与 JDBC 实现同口径：保存时写**当前代**（不是沿用旧行的列值）
    final SchemeRow next = new SchemeRow(id, name == null ? cur.name() : name, ownerId, state,
        format, paramsRev, nextRev, false,
        cur.coverFile(), cur.coverSize(), cur.coverChecksum(),
        cur.status(), cur.tags(), String.valueOf(ownerId), cur.createdAt(), now, auditJson);
    rows.put(id, next);
    history.computeIfAbsent(id, k -> new ArrayList<>())
        .add(new RevisionRow(nextRev, note == null ? "" : note, now, paramsRev, state, auditJson));
    return SaveResult.ok(next);
  }

  @Override
  public synchronized Optional<SchemeRow> findAny(long id, long ownerId) {
    final SchemeRow r = rows.get(id);
    // 与 find 的唯一差别：**不排已删的**（恢复动作必须看得见已删的行）
    return r == null || r.ownerId() != ownerId ? Optional.empty() : Optional.of(r);
  }

  @Override
  public synchronized boolean softDelete(long id, long ownerId) {
    final SchemeRow cur = rows.get(id);
    if (cur == null || cur.deleted() || cur.ownerId() != ownerId) return false;
    rows.put(id, new SchemeRow(cur.id(), cur.name(), cur.ownerId(), cur.state(), cur.format(),
        cur.paramsRev(), cur.rev(), true,
        cur.coverFile(), cur.coverSize(), cur.coverChecksum(),
        cur.status(), cur.tags(), String.valueOf(ownerId), cur.createdAt(), LocalDateTime.now(),
        cur.auditJson()));
    return true;
  }

  @Override
  public synchronized boolean restore(long id, long ownerId) {
    final SchemeRow cur = rows.get(id);
    // 条件与 JDBC 那条 SQL 的 `deleted = 1` 一一对应：没被删 → false（服务层翻成 400，不是 404）
    if (cur == null || !cur.deleted() || cur.ownerId() != ownerId) return false;
    // 恢复不动 rev（与 softDelete 同一条原则）
    rows.put(id, new SchemeRow(cur.id(), cur.name(), cur.ownerId(), cur.state(), cur.format(),
        cur.paramsRev(), cur.rev(), false,
        cur.coverFile(), cur.coverSize(), cur.coverChecksum(),
        cur.status(), cur.tags(), String.valueOf(ownerId), cur.createdAt(), LocalDateTime.now(),
        cur.auditJson()));
    return true;
  }

  @Override
  public synchronized boolean setStatus(long id, long ownerId, String status, String actor) {
    final SchemeRow cur = rows.get(id);
    // 条件与 JDBC 那条 SQL 的 `deleted = 0` 一一对应（契约测试两个实现跑同一套断言）
    if (cur == null || cur.deleted() || cur.ownerId() != ownerId) return false;
    // 不动 rev（交付流转不是内容）；只换 status，其余列原样搬过去
    rows.put(id, new SchemeRow(cur.id(), cur.name(), cur.ownerId(), cur.state(), cur.format(),
        cur.paramsRev(), cur.rev(), cur.deleted(),
        cur.coverFile(), cur.coverSize(), cur.coverChecksum(),
        status, cur.tags(), actor, cur.createdAt(), LocalDateTime.now(), cur.auditJson()));
    return true;
  }

  @Override
  public synchronized boolean setCover(long id, long ownerId, String coverFile, long coverSize,
                                       String coverChecksum, String actor) {
    final SchemeRow cur = rows.get(id);
    // 条件与 JDBC 那条 SQL 的 `deleted = 0` 一一对应
    if (cur == null || cur.deleted() || cur.ownerId() != ownerId) return false;
    // 不动 rev（封面不是内容）；只换封面三列，其余列原样搬过去
    rows.put(id, new SchemeRow(cur.id(), cur.name(), cur.ownerId(), cur.state(), cur.format(),
        cur.paramsRev(), cur.rev(), cur.deleted(),
        coverFile, coverSize, coverChecksum,
        cur.status(), cur.tags(), actor, cur.createdAt(), LocalDateTime.now(), cur.auditJson()));
    return true;
  }

  @Override
  public synchronized Optional<SchemeRow> rename(long id, long ownerId, String name) {
    final SchemeRow cur = rows.get(id);
    // 条件与 JDBC 那条 SQL 的 `deleted = 0` 一一对应；不是本人的也当不存在（对外都是 404）
    if (cur == null || cur.deleted() || cur.ownerId() != ownerId) return Optional.empty();
    // 不动 rev、不写历史（与 JDBC 实现同款：改名不是一次内容编辑）；
    // 只换 name 与 updated_at，其余列原样搬过去 —— 包括 updated_by（这一列记的是谁动过这一行，
    // 而本次口径只动 name / updated_at，见 SchemeStore#rename）
    final SchemeRow next = new SchemeRow(cur.id(), name, cur.ownerId(), cur.state(), cur.format(),
        cur.paramsRev(), cur.rev(), cur.deleted(),
        cur.coverFile(), cur.coverSize(), cur.coverChecksum(),
        cur.status(), cur.tags(), cur.updatedBy(), cur.createdAt(), LocalDateTime.now(),
        cur.auditJson());
    rows.put(id, next);
    return Optional.of(next);
  }

  @Override
  public synchronized SchemeRow duplicate(long id, long ownerId, String name) {
    final SchemeRow src = rows.get(id);
    if (src == null || src.deleted() || src.ownerId() != ownerId) return null;

    final long newId = seq.getAndIncrement();
    final LocalDateTime now = LocalDateTime.now();
    final String newName = copyName(src.name(), name);
    // 口径②③：status 重置成 draft、封面留空、tags 不搬 —— 复制的是"房间与设备"，
    // 不复制"这一份的档案信息"（那些字段说的是源方案，搬过来就是假信息）
    // 结论照搬：内容是同一份，结论就是同一条。**不重判** —— 重判会用"现在"的参数，
    // 与"复制的是这一份内容"这句话对不上（参数改过时，两条结论会不一样，而内容一模一样）
    final SchemeRow copy = new SchemeRow(newId, newName, ownerId, src.state(), src.format(),
        src.paramsRev(), 1, false,
        "", 0L, "", STATUS_DRAFT, null, String.valueOf(ownerId), now, now, src.auditJson());
    rows.put(newId, copy);
    history.put(newId, new ArrayList<>(List.of(
        new RevisionRow(1, "复制自 #" + src.id() + " 第 " + src.rev() + " 版", now,
            src.paramsRev(), src.state(), src.auditJson()))));
    return copy;
  }

  @Override
  public synchronized RollbackResult rollback(long id, long ownerId, int expectRev, int targetRev,
                                              String auditJson, String note) {
    final SchemeRow cur = rows.get(id);
    if (cur == null || cur.deleted() || cur.ownerId() != ownerId) return RollbackResult.missing();

    final RevisionRow target = findRev(id, targetRev).orElse(null);
    if (target == null) return RollbackResult.noSnapshot();

    // 闸门（与 JDBC 那条带 rev 条件的 UPDATE 对应）：对不上就返回冲突，且**什么都没写**
    if (cur.rev() != expectRev) return RollbackResult.conflict(cur);

    final LocalDateTime now = LocalDateTime.now();
    final List<RevisionRow> revs = history.computeIfAbsent(id, k -> new ArrayList<>());

    // ① A1：回滚前先自动存一版 —— 当前内容历史里已有就不动，如实带回"是本来就有还是本次补写"
    final boolean keptWasExisting = findRev(id, expectRev).isPresent();
    if (!keptWasExisting) {
      revs.add(new RevisionRow(expectRev, "回滚前自动留存（第 " + expectRev + " 版）", now,
          cur.paramsRev(), cur.state(), cur.auditJson()));
    }

    // ② 内容 ← 目标版本，rev 仍然递增（乐观锁的序号不能往回走）
    final int nextRev = expectRev + 1;
    final SchemeRow applied = new SchemeRow(id, cur.name(), ownerId, target.state(), cur.format(),
        target.paramsRev(), nextRev, false,
        cur.coverFile(), cur.coverSize(), cur.coverChecksum(),
        cur.status(), cur.tags(), String.valueOf(ownerId), cur.createdAt(), now, auditJson);
    rows.put(id, applied);

    // ③ 新版本行：内容 = 目标版本
    Collections.sort(revs, (a, b) -> Integer.compare(a.rev(), b.rev()));
    revs.add(new RevisionRow(nextRev,
        note == null || note.isBlank() ? "回滚到第 " + targetRev + " 版" : note, now,
        target.paramsRev(), target.state(), auditJson));
    return RollbackResult.ok(applied, keptWasExisting);
  }

  @Override
  public synchronized List<RevisionRow> revisions(long id, long ownerId) {
    if (find(id, ownerId).isEmpty()) return List.of();
    final List<RevisionRow> list = new ArrayList<>(history.getOrDefault(id, List.of()));
    Collections.reverse(list);
    return list;
  }

  @Override
  public synchronized Optional<RevisionRow> revision(long id, long ownerId, int rev) {
    if (find(id, ownerId).isEmpty()) return Optional.empty();
    return findRev(id, rev);
  }

  /** 在历史里找某一版（不做可见性判断 —— 那是调用方的事，见 {@link #revision}） */
  private Optional<RevisionRow> findRev(long id, int rev) {
    for (final RevisionRow r : history.getOrDefault(id, List.of())) {
      if (r.rev() == rev) return Optional.of(r);
    }
    return Optional.empty();
  }

  /** 与 JDBC 实现同名同义（两实现必须一字不差） */
  private static String copyName(String srcName, String wanted) {
    if (wanted != null && !wanted.isBlank()) {
      return wanted.length() > 128 ? wanted.substring(0, 128) : wanted;
    }
    final String base = (srcName == null ? "" : srcName) + " 副本";
    return base.length() > 128 ? base.substring(0, 128) : base;
  }
}