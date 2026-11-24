package com.scene.spatial.scheme;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * SchemeStoreJdbc —— MySQL 实现（`scheme` / `scheme_revision`，见 V1__init.sql）
 *
 * ## 乐观锁为什么是这样写的
 *
 * 判定就是**一条带条件的 UPDATE**：
 *
 * ```sql
 * UPDATE scheme SET ... , rev = rev + 1
 *  WHERE id = ? AND owner_id = ? AND rev = ? AND deleted = 0
 * ```
 *
 * 影响行数 = 0 就是冲突 —— 检查与写入发生在**同一条语句**里，中间没有窗口。
 * 反过来，先 `SELECT` 判 rev 再 `UPDATE` 是**假锁**：两个请求都能通过检查，然后互相覆盖。
 * （数据库自己就是那个轮子：条件更新 + 行数判断，不需要自己写加锁协议。）
 *
 * ## 为什么用 JdbcClient 而不是 Spring Data JDBC 的 `@Version`
 *
 * 原计划是走 Spring Data JDBC 的 `@Version`，实测后**改掉了**，原因很具体：
 * `@Version` 的版本号从 **0** 起，而契约里 `rev` 从 **1** 起（0 留给"从未保存的草稿"）。
 * 硬凑就得在两套编号之间换算 —— 那正是我们在 R3-8 立过规矩要避免的东西（同一个东西只有一套单位）。
 * 所以：用 Spring 自己的 JDBC 门面（`JdbcClient`，不是手写 JDBC），锁靠一条条件 UPDATE。
 *
 * ## 为什么这里的 JSON 用 Jackson、而导出文件仍用 Json.java
 *
 * 库里的 `room_json` 只要**往返一致**（存进去的一定导得回来），不需要与浏览器逐字节相同；
 * 而"与 JS 的 `JSON.stringify(v,null,2)` 逐字节相同"那个要求只属于**导出文件**（FIX-05 验过的口径）。
 * 两件事、两个口径，各用各的轮子。（`Json.java` 的删除触发条件见 设计决策记录）
 */
@Repository
@ConditionalOnProperty(name = "spatial.store", havingValue = "jdbc")
public class SchemeStoreJdbc implements SchemeStore {

  private static final Logger log = LoggerFactory.getLogger(SchemeStoreJdbc.class);

  /**
   * 读取列清单。⚠️ **顺序与 {@link SchemeRow} 的字段顺序一致**（同一件事的一份声明，见 设计决策记录）。
   *
   * R6-3 之前这里**只有 10 列** —— 于是 `cover_*` / `status` / `tags` / `updated_by` 六个
   * **在 V1__init.sql 里就存在的列，从来没有被读出来过**。这是"字段在库里存在、在界面上不存在"
   * 的典型成因：不是没人写，是**没人读**。
   */
  /** 新方案的状态值。与 `scheme.status` 的 DDL 默认值同值，但**显式写**（两个实现给同一个值） */
  private static final String STATUS_DRAFT = SchemeStore.STATUS_DRAFT;

  private static final String COLS =
      "id, name, owner_id, room_json, format_version, params_rev, rev, deleted, "
          + "cover_file, cover_size, cover_checksum, status, tags, updated_by, created_at, updated_at, "
          + "audit_json";

  private static final String SQL_LIST =
      "SELECT " + COLS + " FROM scheme WHERE owner_id = :owner AND deleted = 0 "
          + "ORDER BY updated_at DESC, id DESC";

  /** 回收站（R6-3 3e 用）：「恢复」得先有个地方看得见它 —— 否则这个能力没有入口 */
  private static final String SQL_LIST_TRASHED =
      "SELECT " + COLS + " FROM scheme WHERE owner_id = :owner AND deleted = 1 "
          + "ORDER BY updated_at DESC, id DESC";

  /** 维护端方案库（U1）：全部账号，取数口径与 SQL_LIST 一致，只是没有 owner_id 条件 */
  private static final String SQL_LIST_ALL =
      "SELECT " + COLS + " FROM scheme WHERE deleted = 0 ORDER BY updated_at DESC, id DESC";

  private static final String SQL_LIST_ALL_TRASHED =
      "SELECT " + COLS + " FROM scheme WHERE deleted = 1 ORDER BY updated_at DESC, id DESC";

  private static final String SQL_FIND =
      "SELECT " + COLS + " FROM scheme WHERE id = :id AND owner_id = :owner AND deleted = 0";

  private static final String SQL_FIND_ANY =
      "SELECT " + COLS + " FROM scheme WHERE id = :id AND owner_id = :owner";

  /**
   * 新建。`status` **显式写 `draft`**（不靠 DDL 默认值）—— 与 `product` 侧
   * "新增时 status 必须显式写 draft" 是同一条规矩：默认值可以被改，写死的那一句不会被改。
   */
  private static final String SQL_INSERT =
      "INSERT INTO scheme (name, owner_id, room_json, format_version, params_rev, rev, deleted, "
          + "status, updated_by, created_at, updated_at, audit_json) "
          + "VALUES (:name, :owner, :room, :format, :paramsRev, 1, 0, :status, :by, :now, :now, :audit)";

  /** 乐观锁本体：检查与写入同一条语句 */
  /**
   * 乐观锁本体：检查与写入同一条语句。
   *
   * ⚠️ `format_version` 必须一起更新（设计决策记录 §四.2 的已确认 bug）：只写 `room_json` 的话，
   * 旧 W3/W4 方案保存后 JSON 已是新代、列还是旧代；GET 与分享都返回 `row.format()`，
   * 前端会拿旧格式去建 layout —— 今天三代都映射 `walls` 看不出来，语义一变就是静默错判。
   */
  private static final String SQL_SAVE =
      "UPDATE scheme SET name = COALESCE(:name, name), room_json = :room, "
          + "format_version = :format, params_rev = :paramsRev, "
          + "audit_json = :audit, rev = rev + 1, updated_by = :by, updated_at = :now "
          + "WHERE id = :id AND owner_id = :owner AND rev = :rev AND deleted = 0";

  private static final String SQL_DELETE =
      "UPDATE scheme SET deleted = 1, updated_by = :by, updated_at = :now "
          + "WHERE id = :id AND owner_id = :owner AND deleted = 0";

  /**
   * 写封面（R6-3 3f）：**不动 rev**（封面不是内容），但动 updated_by / updated_at
   * —— 库里那一行真的变了，谁换的必须查得出来。
   *
   * 只写真封面三列：一次"换个封面"不该顺手把 name / status / room_json 带到别的状态上。
   * 条件里的 `deleted = 0` 与 `SQL_RESTORE` 的 `deleted = 1` 正好相反 —— 两边都是同一句话：
   * **这个动作要在它该生效的那种行上生效**。
   */
  private static final String SQL_SET_COVER =
      "UPDATE scheme SET cover_file = :file, cover_size = :size, cover_checksum = :sum, "
          + "updated_by = :by, updated_at = :now "
          + "WHERE id = :id AND owner_id = :owner AND deleted = 0";

  /** 交付流转状态（A11）。**不动 rev** —— 理由写在接口上 */
  private static final String SQL_SET_STATUS =
      "UPDATE scheme SET status = :status, updated_by = :by, updated_at = :now "
          + "WHERE id = :id AND owner_id = :owner AND deleted = 0";

  /**
   * 只改名（验收 第二轮）。**只写 `name` 与 `updated_at`**：
   * 不动 `rev`、不写 `scheme_revision`、不动 `room_json` / `format_version` / `params_rev` /
   * `status` / `cover_*` / `audit_json` —— 理由写在 {@link SchemeStore#rename} 上。
   *
   * 条件带 `deleted = 0`：回收站里的方案不给改名（与 {@link #SQL_SET_COVER} 同款）。
   */
  private static final String SQL_RENAME =
      "UPDATE scheme SET name = :name, updated_at = :now "
          + "WHERE id = :id AND owner_id = :owner AND deleted = 0";

  @Override
  public Optional<SchemeRow> rename(long id, long ownerId, String name) {
    final int rows = jdbc.sql(SQL_RENAME)
        .param("name", name)
        .param("now", LocalDateTime.now())
        .param("id", id)
        .param("owner", ownerId)
        .update();
    if (rows > 0) {
      return find(id, ownerId);
    }
    // 影响 0 行：不存在 / 已删 / 不是本人的。**但同名重命名也可能算 0 行**
    // （驱动配置成「只算真正变化的行」时）—— 行还在且名字已经对得上就算成功，
    // 否则再点一次改名会莫名回 404。其余情况一律 empty（服务层翻成 404，与 save 同口径）。
    return find(id, ownerId).filter(r -> name.equals(r.name()));
  }

  @Override
  public boolean setStatus(long id, long ownerId, String status, String actor) {
    return jdbc.sql(SQL_SET_STATUS)
        .param("status", status)
        .param("by", actor)
        .param("now", LocalDateTime.now())
        .param("id", id)
        .param("owner", ownerId)
        .update() > 0;
  }

  /** "恢复"用（R6-3 3e）：不产生新版本内容，所以**不动 rev** —— 与 softDelete 同一条原则 */
  private static final String SQL_RESTORE =
      "UPDATE scheme SET deleted = 0, updated_by = :by, updated_at = :now "
          + "WHERE id = :id AND owner_id = :owner AND deleted = 1";

  /**
   * 留痕：这一版是谁存下来的。
   *
   * ⚠️ 绑定名是 `:createdBy` 而**不是** `:by` —— 因为本类里已经有一个 `:by` 指
   * `scheme.updated_by`（String），而这里的 `created_by` 是 `scheme_revision` 的 bigint。
   * **同一个绑定名指两样东西，是改了之后最容易"看起来对、其实错"的那种坑**。
   */
  private static final String SQL_INSERT_REV =
      "INSERT INTO scheme_revision (scheme_id, rev, room_json, params_rev, note, created_by, created_at, "
          + "audit_json) "
          + "VALUES (:id, :rev, :room, :paramsRev, :note, :createdBy, :now, :audit)";

  /**
   * 留痕列表。⚠️ 3e 起**多读了两列**（`room_json` / `params_rev`）：
   * 服务层要给每一版算摘要（几米 × 几米 / 几台）—— 否则"回滚到第几版"是个掷骰子的选择。
   * 读全文不等于发全文：接口层只发摘要（见 {@link SchemeStore.RevisionRow}）。
   */
  private static final String SQL_REVS =
      "SELECT rev, note, created_at, room_json, params_rev, audit_json FROM scheme_revision "
          + "WHERE scheme_id = :id ORDER BY rev DESC";

  /** 某一版的快照（回滚的原料）。**单版查询**，与"列表"分开 —— 列表要的是摘要，这里要的是原料 */
  private static final String SQL_REV_ONE =
      "SELECT rev, note, created_at, room_json, params_rev, audit_json FROM scheme_revision "
          + "WHERE scheme_id = :id AND rev = :rev";

  /**
   * 回滚：把**目标版本的内容**写成新的一版（`rev + 1`）。
   *
   * ⚠️ 与 {@link #SQL_SAVE} 一样，检查与写入同一条语句（乐观锁）；
   *    并且它**不改 `name` / `status` / 封面** —— 回滚回滚的是房间内容与参数表指纹。
   *    方案名没进历史表（`scheme_revision` 只存 `room_json` + `params_rev`），
   *    所以"名字也一起回滚"这件事**做不到**；做不到就说做不到，不假装。
   */
  private static final String SQL_ROLLBACK =
      "UPDATE scheme SET room_json = :room, params_rev = :paramsRev, audit_json = :audit, "
          + "rev = rev + 1, updated_by = :by, updated_at = :now "
          + "WHERE id = :id AND owner_id = :owner AND rev = :rev AND deleted = 0";

  /**
   * 回滚前的自动留存（用户拍板 A1）：当前版本**历史里没有**才补写，已经有了就不动。
   *
   * 为什么用 `INSERT … SELECT … WHERE NOT EXISTS` 而不是下面两种写法：
   *   · `INSERT IGNORE` —— 它会连**真的错**（字段类型不对、超长）一起吞掉，那些错不该安静；
   *   · 先查再插 —— 两步之间有窗口，而 `uk_rev (scheme_id, rev)` 会让撞上的那一次直接报错。
   * 一条语句、一个原子动作，写与不写都是它自己判断的。
   *
   * `FROM DUAL` 不能省：MySQL 里带 `WHERE` 的 `SELECT` 必须有 `FROM`。
   */
  private static final String SQL_INSERT_REV_IF_ABSENT =
      "INSERT INTO scheme_revision (scheme_id, rev, room_json, params_rev, note, created_by, created_at, "
          + "audit_json) "
          + "SELECT :id, :rev, :room, :paramsRev, :note, :createdBy, :now, :audit FROM DUAL "
          + "WHERE NOT EXISTS (SELECT 1 FROM scheme_revision WHERE scheme_id = :id AND rev = :rev)";

  /** 无状态且线程安全。独立一份，不与 Web 层的 Jackson 配置共享 —— 本类的口径只有"往返一致" */
  private static final ObjectMapper JACKSON = new ObjectMapper();

  private final JdbcClient jdbc;

  public SchemeStoreJdbc(JdbcClient jdbc) {
    this.jdbc = jdbc;
    log.info("方案存储 = **MySQL**（spatial.store=jdbc）");
  }

  @Override
  public List<SchemeRow> list(long ownerId, boolean deleted) {
    // 用**两条完整语句**按需选，不做成 "… AND deleted = :deleted" 拼参数：
    // 拼片段的话，将来加条件就得在字符串里改，而"每条语句以动词开头"是能一眼看出来的
    // 那种规矩（见 AGENTS.md 的 SQL 规矩）。
    final String sql = deleted ? SQL_LIST_TRASHED : SQL_LIST;
    return jdbc.sql(sql).param("owner", ownerId).query(SchemeStoreJdbc::toRow).list();
  }

  @Override
  public List<SchemeRow> listAll(boolean deleted) {
    final String sql = deleted ? SQL_LIST_ALL_TRASHED : SQL_LIST_ALL;
    return jdbc.sql(sql).query(SchemeStoreJdbc::toRow).list();
  }

  @Override
  public Optional<SchemeRow> find(long id, long ownerId) {
    return jdbc.sql(SQL_FIND).param("id", id).param("owner", ownerId)
        .query(SchemeStoreJdbc::toRow).optional();
  }

  @Override
  @Transactional
  public SchemeRow create(long ownerId, String name, Map<String, Object> state,
                          String format, int paramsRev, String auditJson) {
    final LocalDateTime now = LocalDateTime.now();
    final KeyHolder keys = new GeneratedKeyHolder();
    jdbc.sql(SQL_INSERT)
        .param("name", name)
        .param("owner", ownerId)
        .param("room", toJson(state))
        .param("format", format)
        .param("paramsRev", paramsRev)
        .param("audit", auditJson)
        .param("status", STATUS_DRAFT)
        .param("by", String.valueOf(ownerId))
        .param("now", now)
        .update(keys);

    final long id = keys.getKey().longValue();
    // 第 1 版同时进留痕表：方案一旦存在，"它是怎么来的"就该有记录（与内存实现同款）
    jdbc.sql(SQL_INSERT_REV)
        .param("id", id).param("rev", 1).param("room", toJson(state))
        .param("paramsRev", paramsRev).param("note", "创建").param("createdBy", ownerId)
        .param("now", now).param("audit", auditJson)
        .update();

    return new SchemeRow(id, name, ownerId, state, format, paramsRev, 1, false,
        "", 0L, "", STATUS_DRAFT, null, String.valueOf(ownerId), now, now, auditJson);
  }

  @Override
  @Transactional
  public SaveResult save(long id, long ownerId, int expectedRev, String name,
                         Map<String, Object> state, String format, int paramsRev, String auditJson,
                         String note) {
    final LocalDateTime now = LocalDateTime.now();
    final int rows = jdbc.sql(SQL_SAVE)
        .param("name", name)
        .param("room", toJson(state))
        .param("format", format)
        .param("paramsRev", paramsRev)
        .param("audit", auditJson)
        .param("by", String.valueOf(ownerId))
        .param("now", now)
        .param("id", id)
        .param("owner", ownerId)
        .param("rev", expectedRev)
        .update();

    if (rows == 0) {
      // 影响 0 行只有两种可能，必须分开：**不存在**（404）与**版本对不上**（409）
      final Optional<SchemeRow> any = jdbc.sql(SQL_FIND_ANY).param("id", id).param("owner", ownerId)
          .query(SchemeStoreJdbc::toRow).optional();
      return any.isEmpty() || any.get().deleted() ? SaveResult.missing() : SaveResult.conflict(any.get());
    }

    jdbc.sql(SQL_INSERT_REV)
        .param("id", id).param("rev", expectedRev + 1).param("room", toJson(state))
        .param("paramsRev", paramsRev).param("note", note == null ? "" : note)
        .param("createdBy", ownerId).param("now", now).param("audit", auditJson)
        .update();

    final SchemeRow saved = jdbc.sql(SQL_FIND).param("id", id).param("owner", ownerId)
        .query(SchemeStoreJdbc::toRow)
        .optional()
        .orElseThrow(() -> new IllegalStateException("刚更新成功的方案读不回来：id=" + id));
    return SaveResult.ok(saved);
  }

  @Override
  public Optional<SchemeRow> findAny(long id, long ownerId) {
    return jdbc.sql(SQL_FIND_ANY).param("id", id).param("owner", ownerId)
        .query(SchemeStoreJdbc::toRow).optional();
  }

  @Override
  public boolean softDelete(long id, long ownerId) {
    // 软删不动 rev：它没有产生新版本内容（与内存实现保持一致 —— 两个实现必须行为一致）
    return jdbc.sql(SQL_DELETE).param("by", String.valueOf(ownerId))
        .param("now", LocalDateTime.now())
        .param("id", id).param("owner", ownerId).update() > 0;
  }

  @Override
  public boolean restore(long id, long ownerId) {
    // 恢复也不动 rev（与 softDelete 同一条原则）。条件里的 deleted = 1 是**这道闸门**：
    // 对一条没被删的方案调恢复 → 影响 0 行 → 服务层翻译成 400「本来就没删」
    return jdbc.sql(SQL_RESTORE).param("by", String.valueOf(ownerId))
        .param("now", LocalDateTime.now())
        .param("id", id).param("owner", ownerId).update() > 0;
  }

  @Override
  public boolean setCover(long id, long ownerId, String coverFile, long coverSize,
                          String coverChecksum, String actor) {
    return jdbc.sql(SQL_SET_COVER)
        .param("file", coverFile)
        .param("size", coverSize)
        .param("sum", coverChecksum)
        .param("by", actor)
        .param("now", LocalDateTime.now())
        .param("id", id)
        .param("owner", ownerId)
        .update() > 0;
  }

  @Override
  @Transactional
  public SchemeRow duplicate(long id, long ownerId, String name) {
    // find（不是 findAny）：口径① —— 只复制方案库里的，回收站里的先恢复再复制
    final Optional<SchemeRow> found = find(id, ownerId);
    if (found.isEmpty()) return null;
    final SchemeRow src = found.get();
    if (src.rev() < 1) return null; // 理论上不会发生；真发生说明历史行被改过

    final LocalDateTime now = LocalDateTime.now();
    final String newName = copyName(src.name(), name);
    final KeyHolder keys = new GeneratedKeyHolder();
    // 复用 SQL_INSERT（同一份列清单，不另写一份）：
    // 与"新建"的差别只有三个参数 —— name / format / paramsRev 来自源方案 —— 而 status 仍然是 draft
    jdbc.sql(SQL_INSERT)
        .param("name", newName)
        .param("owner", ownerId)
        .param("room", toJson(src.state()))
        .param("format", src.format())
        .param("paramsRev", src.paramsRev())
        // 结论照搬（与内存实现同款）：内容是同一份，结论就是同一条 —— 不重判（重判会用"现在"的参数）
        .param("audit", src.auditJson())
        .param("status", STATUS_DRAFT)
        .param("by", String.valueOf(ownerId))
        .param("now", now)
        .update(keys);

    final long newId = keys.getKey().longValue();
    // 第 1 版的备注写清"它从哪来"：副本是照哪一份、哪一版拷的，将来对不上时能查
    jdbc.sql(SQL_INSERT_REV)
        .param("id", newId).param("rev", 1).param("room", toJson(src.state()))
        .param("paramsRev", src.paramsRev())
        .param("note", "复制自 #" + src.id() + " 第 " + src.rev() + " 版")
        .param("createdBy", ownerId).param("now", now).param("audit", src.auditJson())
        .update();

    // 返回行必须与库里那一行一致：tags / 封面留空（口径②③）—— 不拿源方案的值冒充
    return new SchemeRow(newId, newName, ownerId, src.state(), src.format(), src.paramsRev(), 1, false,
        "", 0L, "", STATUS_DRAFT, null, String.valueOf(ownerId), now, now, src.auditJson());
  }

  @Override
  @Transactional
  public RollbackResult rollback(long id, long ownerId, int expectRev, int targetRev,
                                 String auditJson, String note) {
    // 两个前置条件，分别说清：① 方案在不在（不在/已删 → notFound，404）
    final Optional<SchemeRow> cur = find(id, ownerId);
    if (cur.isEmpty()) return RollbackResult.missing();
    final SchemeRow before = cur.get();

    // ② 目标版本有没有快照（没有 → 单独一种结果，400 —— 它不是"找不到方案"）。
    // ⚠️ 实测（2026-09-29）：当前 5 条方案的逐版快照**都是完整的**。所以走不到这一分支不等于它多余 ——
    //    成立的是"没有东西保证它完整"（没有约束、导入路径可以只写主表），而代价是**永久丢内容**。
    final Optional<RevisionRow> target = revisionRow(id, targetRev);
    if (target.isEmpty()) return RollbackResult.noSnapshot();

    final LocalDateTime now = LocalDateTime.now();

    // ── 闸门：带 rev 条件的一条 UPDATE。影响 0 行 = 冲突，此时**一条记录都还没写**
    final int rows = jdbc.sql(SQL_ROLLBACK)
        .param("room", toJson(target.get().state()))
        .param("paramsRev", target.get().paramsRev())
        // 回滚出来的这一版，内容是"目标版本"的，**结论是现在判的**（参数改过的时候这两个 rev 会不一样，
        // 而那正是 B4d 的"双显"要说的事 —— 界面上必须写成两句，不能合成一句）
        .param("audit", auditJson)
        .param("by", String.valueOf(ownerId))
        .param("now", now)
        .param("id", id).param("owner", ownerId).param("rev", expectRev)
        .update();
    if (rows == 0) {
      final Optional<SchemeRow> any = findAny(id, ownerId);
      return any.isEmpty() || any.get().deleted()
          ? RollbackResult.missing() : RollbackResult.conflict(any.get());
    }

    // ── ① A1：回滚前先自动存一版。历史里已有这一版就不动（返回 0 行），
    //     并把"是本来就有、还是本次补写"如实带回去 —— 两件事对用户不是一句话
    final int kept = jdbc.sql(SQL_INSERT_REV_IF_ABSENT)
        .param("id", id).param("rev", expectRev)
        .param("room", toJson(before.state()))
        .param("paramsRev", before.paramsRev())
        .param("note", "回滚前自动留存（第 " + expectRev + " 版）")
        .param("createdBy", ownerId).param("now", now)
        // 补写的这一版就是**当前这一版**，它的结论 = 主表现在存着的那条（一模一样的内容，别重判）
        .param("audit", before.auditJson())
        .update();

    // ── ③ 新版本行：内容 = 目标版本。备注把"从第几版回到第几版"写成一句人话
    jdbc.sql(SQL_INSERT_REV)
        .param("id", id).param("rev", expectRev + 1)
        .param("room", toJson(target.get().state()))
        .param("paramsRev", target.get().paramsRev())
        .param("note", note == null || note.isBlank()
            ? "回滚到第 " + targetRev + " 版" : note)
        .param("createdBy", ownerId).param("now", now).param("audit", auditJson)
        .update();

    final SchemeRow applied = jdbc.sql(SQL_FIND).param("id", id).param("owner", ownerId)
        .query(SchemeStoreJdbc::toRow).optional()
        .orElseThrow(() -> new IllegalStateException("刚回滚成功的方案读不回来：id=" + id));
    return RollbackResult.ok(applied, kept == 0);
  }

  @Override
  public List<RevisionRow> revisions(long id, long ownerId) {
    if (find(id, ownerId).isEmpty()) return List.of();
    return jdbc.sql(SQL_REVS).param("id", id).query(SchemeStoreJdbc::toRevision).list();
  }

  @Override
  public Optional<RevisionRow> revision(long id, long ownerId, int rev) {
    if (find(id, ownerId).isEmpty()) return Optional.empty();
    return revisionRow(id, rev);
  }

  /** 单版快照的原始查询（不重复做可见性判断 —— 那是调用方的事，见 {@link #revision}） */
  private Optional<RevisionRow> revisionRow(long id, int rev) {
    return jdbc.sql(SQL_REV_ONE).param("id", id).param("rev", rev)
        .query(SchemeStoreJdbc::toRevision).optional();
  }

  /**
   * 副本名：优先级 = 调用方给的名字 > `<源名> 副本`。
   * 上限 128 与建表/校验同值，超出就截 —— 不截的话这条 INSERT 会因超长报错，
   * 而用户看到的会是"复制失败"（一个他无法理解、也无法绕过的错）。
   */
  private static String copyName(String srcName, String wanted) {
    if (wanted != null && !wanted.isBlank()) {
      return wanted.length() > 128 ? wanted.substring(0, 128) : wanted;
    }
    final String base = (srcName == null ? "" : srcName) + " 副本";
    return base.length() > 128 ? base.substring(0, 128) : base;
  }

  /** 行映射：`room_json` → `Map`（列 CDC 之外的字段一律从库里读，不在代码里写死顺序） */
  private static SchemeRow toRow(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
    Map<String, Object> state = Map.of();
    final String room = rs.getString("room_json");
    if (room != null && !room.isBlank()) {
      try {
        state = JACKSON.readValue(room, new TypeReference<LinkedHashMap<String, Object>>() {
        });
      } catch (Exception e) {
        // 库里存了读不回来的 JSON = 数据损坏（缺陷，不是规则失败）→ 大声抛，不要当成"空房间"悄悄过去
        throw new IllegalStateException("scheme.room_json 无法解析（id=" + rs.getLong("id") + "）", e);
      }
    }
    return new SchemeRow(
        rs.getLong("id"),
        rs.getString("name"),
        rs.getLong("owner_id"),
        state,
        rs.getString("format_version"),
        rs.getInt("params_rev"),
        rs.getInt("rev"),
        rs.getBoolean("deleted"),
        // 三个封面列 NOT NULL 且默认是空串/0 → 直接用（nullToEmpty 只防"实现了但没写"的意外）
        nullToEmpty(rs.getString("cover_file")),
        rs.getLong("cover_size"),
        nullToEmpty(rs.getString("cover_checksum")),
        rs.getString("status"),
        // tags 是 json 列、可为 null：**原样取出，服务端不解析**（前端形状自由）
        rs.getString("tags"),
        nullToEmpty(rs.getString("updated_by")),
        rs.getObject("created_at", LocalDateTime.class),
        rs.getObject("updated_at", LocalDateTime.class),
        // 可为 null（老方案）—— 原样带出去，服务层不许拿"空"当"没问题"
        rs.getString("audit_json"));
  }

  /** 留痕行映射。`room_json` 读不回来同样大声抛（与 {@link #toRow} 同一条理由：数据损坏不是规则失败） */
  private static RevisionRow toRevision(java.sql.ResultSet rs, int rowNum)
      throws java.sql.SQLException {
    final String room = rs.getString("room_json");
    Map<String, Object> state = Map.of();
    if (room != null && !room.isBlank()) {
      try {
        state = JACKSON.readValue(room, new TypeReference<LinkedHashMap<String, Object>>() {
        });
      } catch (Exception e) {
        throw new IllegalStateException(
            "scheme_revision.room_json 无法解析（rev=" + rs.getInt("rev") + "）", e);
      }
    }
    return new RevisionRow(
        rs.getInt("rev"),
        rs.getString("note") == null ? "" : rs.getString("note"),
        rs.getObject("created_at", LocalDateTime.class),
        rs.getInt("params_rev"),
        state,
        rs.getString("audit_json"));
  }

  /** 列上写着 NOT NULL default '' 的字符串列：真读出 null 说明库被动过，兜住但不假装它是正常值 */
  private static String nullToEmpty(String v) {
    return v == null ? "" : v;
  }

  private String toJson(Map<String, Object> state) {
    try {
      return JACKSON.writeValueAsString(state == null ? Map.of() : state);
    } catch (Exception e) {
      throw new IllegalStateException("方案状态无法序列化", e);
    }
  }
}