package com.scene.spatial.scheme;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/**
 * SchemeStore —— 方案持久化接口（**接缝**）
 *
 * 为什么定成接口、而不是直接写 JdbcTemplate：
 * MySQL 还没到位，但**接口形状与乐观锁语义今天就能验**。
 * 于是两个实现跑同一套契约：
 *   - {@link SchemeStoreInMemory} —— 仅 `local-nodb` 档使用，启动时大声警告（开发用）
 *   - `SchemeStoreJdbc`         —— MySQL（`scheme` / `scheme_revision` 两张表，见 V1__init.sql）
 *
 * 乐观锁的**判定必须落在实现里**（不是先查后写）：先查再写会有窗口，
 * 两个请求都能通过检查，然后一个覆盖另一个 —— 那这个锁就是假的。
 * 实现方要用一条带条件的 UPDATE（`WHERE rev = ?`，影响行数为 0 即冲突）或等价的临界区。
 */
public interface SchemeStore {

  /**
   * 方案行（与 `scheme` 表一一对应；`state` 就是前端 v4 的 `{w,d,h,walls,items}`）。
   *
   * ⚠️ **字段顺序与 `SchemeStoreJdbc.COLS` 保持一致**：两边都是"表长什么样"的一份声明，
   *    顺序不同会让后来改的人以为它们没关系（其实是同一件事，见 docs/21 §2.3）。
   *
   * ## 为什么 R6-3 要加这 6 个字段
   *
   * 这 6 列（`cover_*` / `status` / `tags` / `updated_by`）**在 `V1__init.sql` 里就有**，
   * 但 `SchemeStoreJdbc.COLS` 从来没把它们选出来过 —— 于是列里永远是空的
   * （`status` 靠 DDL 默认值、其余靠列默认值），界面上也永远看不到。
   *
   * 这不是"忘了加列"（列早就在），是**读取路径窄了**：
   * 一个字段在库里存在、在界面上不存在，往往是"没人读它"，而不是"没人写它"。
   *
   * `tags` 用 `String`（不是 `Map`）：它是一串自由标签，服务端**不解析**它，
   * 只原样存原样取；一旦这里变成结构体，就得为"标签长什么样"再定一套规矩 ——
   * 而这件事前端做更合适（也更好改）。
   *
   * `updatedBy` 存的是**操作者 id 的字符串**（`varchar(32)`），**不是人名**：
   * 写人名将来接用户体系就回不去了（人名会变）；界面上把它翻成显示名即可。
   */
  record SchemeRow(long id, String name, long ownerId, Map<String, Object> state,
                   String format, int paramsRev, int rev, boolean deleted,
                   String coverFile, long coverSize, String coverChecksum,
                   String status, String tags, String updatedBy,
                   LocalDateTime createdAt, LocalDateTime updatedAt,
                   /** 落库那一刻服务端判的结论（JSON 文本：report + paramsRev + catalogRev）。
                    *  **可为 null，而且 null 有话说**：老方案（本列存在之前存的）就是 null ——
                    *  界面必须说"没有存下当时的结论"，不许拿现在的结论冒充（R6-4 B4d）。 */
                   String auditJson) {
  }

  /**
   * 改动留痕行（对应 `scheme_revision`）。
   *
   * ## 为什么 3e 要加上 `state`（这一版的快照内容）
   *
   * R6-3 3b 时这里只有 `rev / note / createdAt` 三样 —— 于是"版本历史"是一串
   * **认不出来的编号**：第 3 版和第 4 版在界面上长得一模一样，而回滚是**一个用户必须做的选择**。
   * 让人在认不出的选项里选一个，等于让他掷骰子（本项目对"假信息"的一贯态度）。
   * 有了快照，服务层才能给出版本的**摘要**（几米 × 几米 / 几台 / 哪几个型号）。
   *
   * ⚠️ 拿到 `state` **不等于**要把它发出去：`room_json` 是整份方案（可能几百 KB），
   *    而版本列表最多几十行 —— 全发出去就是"列表页拖几 MB 的 JSON"那个老问题（见 `list`）。
   *    所以接口层只发摘要，快照留在服务端手里当**回滚的原料**。
   *
   * @param paramsRev 该版本的参数表指纹。“这一版是按哪版规则参数摆的”—— 回滚要把它一起带回来，
   *                  否则回滚后的行会声称自己是在**新**参数下摆的，而内容是旧的（两个都是假的）。
   * @param state     该版本的完整快照。**只有历史里真的有这一版时才有值** ——
   *                  别把"缺"当成常态：2026-09-29 实测当前 5 条方案的快照都是完整的。
   */
  record RevisionRow(int rev, String note, LocalDateTime createdAt, int paramsRev,
                     Map<String, Object> state,
                     /** 这一版**被创建时**的结论（同上形状）。留档：不随后来的参数改动而变化 */
                     String auditJson) {
  }

  /** 一次保存的结果：`saved` 成功；`conflict` 带**服务端当前行**（供 409 把 currentRev 回给前端）；`missing` 不存在/已删 */
  record SaveResult(SchemeRow saved, SchemeRow conflict, boolean notFound) {
    static SaveResult ok(SchemeRow r) {
      return new SaveResult(r, null, false);
    }

    static SaveResult conflict(SchemeRow current) {
      return new SaveResult(null, current, false);
    }

    static SaveResult missing() {
      return new SaveResult(null, null, true);
    }

    public boolean isOk() {
      return saved != null;
    }
  }

  /**
   * 一次回滚的结果。
   *
   * @param applied        回滚成功后服务端那一行（`rev` 已经是**新的**那一版）
   * @param conflict       版本对不上时，服务端当前行（供 409 把 currentRev 回给前端）
   * @param notFound       方案不存在 / 已删
   * @param targetMissing  **要回滚到的那一版没有快照** —— 老方案的历史是缺的，这是真会发生的情况
   * @param keptWasExisting "回滚前自动存的那一版"**本来就在历史里**（true）还是本次补写的（false）。
   *                       为什么要说出来：用户被告知"你的东西没丢"，而"没丢"的原因是
   *                       "本来就没走过"和"我刚给你补上了"是两件事 —— 前者不需要感谢服务端。
   */
  record RollbackResult(SchemeRow applied, SchemeRow conflict, boolean notFound,
                        boolean targetMissing, boolean keptWasExisting) {
    static RollbackResult ok(SchemeRow r, boolean keptWasExisting) {
      return new RollbackResult(r, null, false, false, keptWasExisting);
    }

    static RollbackResult conflict(SchemeRow current) {
      return new RollbackResult(null, current, false, false, false);
    }

    static RollbackResult missing() {
      return new RollbackResult(null, null, true, false, false);
    }

    static RollbackResult noSnapshot() {
      return new RollbackResult(null, null, false, true, false);
    }

    public boolean isOk() {
      return applied != null;
    }
  }

  /** 列表（**不带 state**：列表页不需要几 MB 的 JSON）。按更新时间倒序 */
  /**
   * 某人的方案列表。
   *
   * ⚠️ **`deleted` 不是"要不要包含已删的"，而是"要哪一半"**：
   *    `false` → 只给未删的（方案库）
   *    `true`  → 只给已软删的（回收站）
   *
   * 为什么不做成"包含/不包含"：那种设计下，一条流里混着两种行，界面每个地方都要再判一次
   * "这条算不算"，而且**调用方不必说出自己要哪一半**（默认值替他决定了）。
   * 做成"要哪一半"，签名本身就要求他说出来。
   *
   * ⚠️ 两个实现必须给出**同样的两半、同样的顺序**（顺序也一致 ——
   *    JDBC 的 ORDER BY 是 `updated_at DESC, id DESC`）。
   */
  List<SchemeRow> list(long ownerId, boolean deleted);

  /**
   * **全部账号**的方案列表（维护端方案库用，U1）。
   *
   * 取数口径、顺序、`deleted` 的语义与 {@link #list} 逐条相同，只是没有 `owner_id` 条件。
   * 为什么不在接口层把各账号的列表拼起来：那样"要哪一半"与"按什么顺序"就散到调用方去判，
   * 两个实现也会各自长出排序规则。
   */
  List<SchemeRow> listAll(boolean deleted);

  Optional<SchemeRow> find(long id, long ownerId);

  /**
   * 查一行 —— **已删的也查得到**。
   *
   * `find` 与 `findAny` 是同一件事的两半（照 `list` 那对参数的同一条理由）：
   * 「恢复」这个动作**必须能看见已删的行**，否则它永远只会得到一句"不存在"，
   * 而调用方也就没法回答那个更要紧的问题 ——「它到底是**不存在**，还是**没被删**？」。
   * 这两种情况对用户是两句话，对状态码是两个码（404 与 400）。
   */
  Optional<SchemeRow> findAny(long id, long ownerId);

  /**
   * 新建：`rev` 从 1 起（0 留给"从未保存过的草稿"，避免"没保存过"和"保存过第 0 版"混淆）。
   *
   * @param auditJson 落库这一刻的结论（服务端自己判的，**不是前端递上来的** ——
   *                  判定权在服务端，收客户端递的结论等于让客户端写自己的成绩单）
   */
  SchemeRow create(long ownerId, String name, Map<String, Object> state, String format,
                   int paramsRev, String auditJson);

  /**
   * 保存（乐观锁）。
   *
   * @param expectedRev 前端手里的 `rev`
   * @param format      这次保存写入的格式标识（`Scheme.FORMAT`）。
   *                    ⚠️ 必须跟着 `room_json` 一起更新：只有 INSERT 写 `format_version` 的话，
   *                    旧方案保存后 JSON 已是新代、列还是旧代，GET/分享会拿旧格式驱动前端语义。
   * @param paramsRev   保存时生效的参数表指纹（**每次保存都要刷新**：它回答"这一版是按哪版规则参数摆的"）
   * @param note        版本说明（可空）
   */
  SaveResult save(long id, long ownerId, int expectedRev, String name,
                  Map<String, Object> state, String format, int paramsRev, String auditJson, String note);

  /**
   * 软删（置 `deleted`，不做回收站界面）。返回是否真的删掉了一条。
   *
   * ⚠️ **软删不动 `rev`**：它没有产生新版本内容（两个实现必须行为一致）。
   *    R6-3 新增的"恢复"走同一条原则 —— 恢复也不是一次内容编辑，同样不产生新 rev。
   */
  boolean softDelete(long id, long ownerId);

  /**
   * 恢复（从回收站回来）。返回是否真的恢复了一条。
   *
   * ⚠️ **不动 `rev`**：恢复不是一次内容编辑（与 {@link #softDelete} 同一条原则）。
   *    条件里带 `deleted = 1`：对一条没被删的方案调恢复，影响 0 行 —— 这是**实话**，
   *    服务层会把它翻译成 400「本来就没删」而不是 404「不存在」（两者对用户是两句话）。
   */
  boolean restore(long id, long ownerId);

  /**
   * 只改方案名（验收 第二轮：方案名内联编辑）。
   *
   * ## 为什么要一个专门的写操作
   *
   * 改名走 {@link #save} 的话，一次"换个名字"会**顺带产生一个新版本**（`rev + 1` + 一条
   * `scheme_revision`）。而版本号回答的是「图形改过几次」，名字不是内容 ——
   * 混进去之后，历史里会多出一串"内容完全一样、只是标题不同"的版本，
   * 用户回滚时看到它们根本分不清差别（与 {@link #setCover} / {@link #setStatus} 同一条原则）。
   *
   * ## 三条口径（两个实现必须一致）
   *
   * ① **只写 `name` 与 `updated_at`**：不动 `rev`、不写 `scheme_revision`、不动
   *    `room_json` / `format_version` / `params_rev` / `status` / `cover_*` / `audit_json`。
   * ② 条件带 `deleted = 0`：回收站里的方案不给改名（与 {@link #setCover} 同款）。
   * ③ 影响 0 行时**再查一次**：同名重命名在"只算真正变化的行"的驱动上也是 0 行，
   *    那种情况是**幂等成功**（再点一次改名不该报错），不是"不存在"。
   *
   * @return 改后的行；不存在 / 已删 / 不是本人的 → empty（服务层据此回 404，与 save 同口径）
   */
  Optional<SchemeRow> rename(long id, long ownerId, String name);

  /**
   * 写封面（R6-3 3f）。返回是否真的写上了（方案不存在 / 已删 → false）。
   *
   * ## 三条口径（两个实现必须一致）
   *
   * ⚠️ ① **不动 `rev`**：封面不是内容，它不产生新版本 —— 与 {@link #softDelete} / {@link #restore}
   *       同一条原则。但它**要动 `updated_at` / `updated_by`**：库里那一行真的变了，
   *       "谁在什么时候换的封面"必须查得出来（否则审计里会凭空少一次写）。
   *
   * ② **只写真封面相关三列**，绝不顺手覆写别的列：封面是**附加物**，
   *    一次"换个封面"不该把 `name` / `status` / `room_json` 带到某个别的状态上。
   *
   * ③ **条件带 `deleted = 0`**：回收站里的方案不接新封面（它在回收站里连列表都没回去，
   *    而"在回收站里换封面"这件事本身也说不通）。
   *
   * ## 为什么文件名固定、指纹单独一列（用户拍板 2026-09-29：封面不跟版本走）
   * 一次方案一张图，新的覆盖旧的。代价是 **URL 不变** → 浏览器可能把旧图从缓存里还给你。
   * 所以 `coverChecksum` 必须**每次跟着内容变** —— `V9` 建这一列时的注释原文就是
   * 「改了封面必须变 → 前端缓存键」。前端拿它当 `?v=`，缓存问题就到此为止。
   *
   * @param coverFile     写进库的相对路径（**给人看的**，下发走 `/api/schemes/{id}/cover`）
   * @param coverSize     字节数
   * @param coverChecksum 内容 md5（小写 32 位）
   * @param actor         谁换的（进 `updated_by`）
   */
  boolean setCover(long id, long ownerId, String coverFile, long coverSize,
                   String coverChecksum, String actor);

  /**
   * 复制一份：把源方案**当前这一版**的内容拷成一份新方案（新 id、`rev` 从 1 起）。
   *
   * ## 三条口径（两个实现必须一致）
   * ① **只复制方案库里的**（源方案已删 → 返回 null）：回收站里的东西先恢复再复制，
   *    否则"复制"这条流会同时横跨方案库与回收站两份列表，界面与语义都会变糊。
   * ② **状态一律重置成 `draft`**："已交付"说的是**那一份**的生命周期，
   *    新复制出来的这一份还没交付过。照抄过来就是**假状态**。
   * ③ **不复制封面**：封面是那一次保存时渲的图，内容一改它就成了**旧图冒充新方案**。
   *    宁可让卡片老老实实显示"无封面"（占位），也不搬一张过期图过来。
   *
   * @param name 新方案名；null = 由实现按 `<源名> 副本` 生成
   * @return 新方案行；源方案不存在/已删时为 null
   */
  SchemeRow duplicate(long id, long ownerId, String name);

  /**
   * 回滚到历史里的某一版（**用户拍板 A1：回滚前先自动存一版**）。
   *
   * ## 语义（写死在契约里，两个实现一字不差）
   *
   * 回滚**不是"把 rev 改回旧数字"**，而是"把旧版本的内容**当作一次新的编辑**存进去"：
   *
   * ```
   * 回滚前：  行内是第 5 版的内容 C5，历史里有 1,2,5
   * 回滚到 2：  ① 先确认 C5 在历史里存着（不在就补写成第 5 版）  ← A1 的那一句
   *            ② 行内内容 ← C2，rev ← 6（单调递增，乐观锁才有意义）
   *            ③ 历史补一行：第 6 版 = C2，备注说明"回滚到第 2 版"
   * 回滚后：  行内是第 6 版的内容 C2，历史里有 1,2,5,6   ← **C5 还在，没丢**
   * ```
   *
   * 为什么要 ①：**没有东西保证历史是完整的** —— `scheme_revision` 上没有任何约束说"每版必须有快照"，
   *导入/种数据的路径完全可以只写主表。当前库里那 5 条方案**碰巧都是完整的**
   *（2026-09-29 实测：rev 2/2/1/1/1 ↔ 留痕 2+2+1+1+1=7，正好对上），
   *所以这条不是"现在就有问题"，而是"**没有东西拦着它出问题**"。
   * 所以"回滚会把当前内容永久丢掉"这件事**真的可能发生** —— ① 就是拦它的那一句。
   *
   * 为什么不把 `rev` 改回 `targetRev`：`rev` 是乐观锁的序号，它一旦能往回走，
   * 手里的旧 token 就会"突然又有效了" —— 那等于把锁拆掉（见类注释）。
   *
   * ## 顺序（为什么先 UPDATE 再补快照）
   * ① 的"补写"不能放在乐观锁判定之前：判定失败（409）时不该已经写了东西。
   * 所以先用**带 `rev = :expectRev` 条件的 UPDATE**当闸门，影响 0 行就直接返回冲突，
   * 一条记录都没动；通过了才补快照与新版本行。整个方法在一个事务里。
   * （这就是类注释那句"判定必须落在实现里"的具体做法。）
   *
   * @param expectRev 前端手里那一版（乐观锁）；对不上 → 冲突
   * @param targetRev 要回滚到的那一版；该版没有快照 → `targetMissing`
   */
  RollbackResult rollback(long id, long ownerId, int expectRev, int targetRev,
                          String auditJson, String note);

  /** 留痕列表（新的在前）。**每行带该版的快照**，供服务层算版本摘要（见 {@link RevisionRow}） */
  List<RevisionRow> revisions(long id, long ownerId);

  /** 某一版的快照（回滚要拿它当原料）。**已删的方案不给**（与 `find` 同口径） */
  Optional<RevisionRow> revision(long id, long ownerId, int rev);

  /**
   * 「交付流转状态」的两个值 —— `V9` 建这一列时写的定义域就是 `draft / submitted / delivered`。
   *
   * 常量放接口上（而不是各实现里各写一份字面量）：两个实现必须给同一个值，
   * 而"两处各写一份 draft"这种重复，早晚会在其中一个被改成 `DRAFT` 的那天分裂。
   */
  String STATUS_DRAFT = "draft";

  /** 「已交付」（A11）：由**交付包生成时自动置位**，不是人勾的 —— 见 `scheme_delivery` 那条表注释 */
  String STATUS_DELIVERED = "delivered";

  /**
   * 置交付流转状态（A11：自动置位 ✅ / 允许人工改回 ✅ / 留痕在 service 层写 `audit_log`）。
   *
   * **不动 `rev`**：交付流转不是一次**内容**编辑 —— 与 {@link #setCover} 同一条口径
   * （内容版本号回答的是"图形改过几次"，混进别的动作之后它就什么也回答不了了）。
   * 但 `updated_by` 要写：**有人动过这一行**，这件事必须留得下来。
   *
   * 条件同样带 `deleted = 0`：回收站里的方案不参与交付流转（它在回收站里连列表都没回去）。
   *
   * @return 影响 0 行（方案不在方案库里）→ false，调用方据此回 404
   */
  boolean setStatus(long id, long ownerId, String status, String actor);
}