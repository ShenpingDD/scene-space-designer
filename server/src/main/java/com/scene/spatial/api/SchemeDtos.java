package com.scene.spatial.api;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.List;
import java.util.Map;

/**
 * SchemeDtos —— 方案接口的请求体（**record + Bean Validation**）
 *
 * 为什么不用 `Map<String, Object> body` 再接 `body.get("name")`：
 *   ① 字段名与类型写在这里，**写错了编译不过**；用 Map 要等到运行时才发现；
 *   ② 校验交给 Bean Validation（`@NotBlank` / `@Size`），框架在进业务之前就挡掉 ——
 *      `isEmpty()` / `length() > 128` 这类手写判断不该有第二份（见 设计决策记录）；
 *   ③ springdoc 能照着它直接生成 OpenAPI，接口文档不必手写第二遍。
 *
 * 注意 `state` 仍然是 `Map`：它就是前端 v4 方案的可变结构（`{w,d,h,walls,items}`），
 * 逐字段建类会立刻变成"第二份领域模型"，而校验这件事**由内核负责**（服务端是唯一裁判）。
 */
public final class SchemeDtos {

  private SchemeDtos() {
  }

  /** 新建方案 */
  public record CreateRequest(
      @NotBlank(message = "方案名不能为空")
      @Size(max = 128, message = "方案名过长（上限 128 字）") String name,
      Map<String, Object> state) {
  }

  /**
   * 只改名（验收 第二轮：方案名内联编辑）。
   *
   * **没有 `rev`、没有 `state`**：改名不是保存，它不产生新版本（理由见
   * `SchemeService#rename`）。把 `rev` 放进来的话，调用方会以为这里有并发冲突要处理 ——
   * 而内容一个字都没动，根本没有那种冲突。
   *
   * 校验与新建方案同一条（非空、≤128 字）：`@NotBlank` 连纯空格也挡掉，
   * 否则会出现一份"名字看着是空的"方案，而界面上无从解释。
   */
  public record NameRequest(
      @NotBlank(message = "方案名不能为空")
      @Size(max = 128, message = "方案名过长（上限 128 字）") String name) {
  }

  /** 保存方案。`name` 为空 = 不改名；`rev` 缺失由服务层判成 400 `rev-required`（那是客户端写错了，不是并发冲突） */
  public record SaveRequest(
      Integer rev,
      @Size(max = 128, message = "方案名过长（上限 128 字）") String name,
      Map<String, Object> state,
      @Size(max = 255, message = "版本说明过长（上限 255 字）") String note) {
  }

  /**
   * 生成只读分享口令（R6-5）。
   *
   * `days` 缺省 = 30 天（`Share.DEFAULT_DAYS`）；**不给"不过期"选项** —— 见 `SchemeController.share`。
   *
   * ⚠️ 这里**没有 `note`**：`scheme_share` 表里没有存说明的列。收一个存不下的字段，
   * 就等于界面上让人填了、然后自己吞掉 —— 那比不收更坏（人会以为已经记下了）。
   * "为什么发"要留痕的话，目前只有撤销那一步会写 `audit_log`。
   */
  public record ShareRequest(Integer days) {
  }

  /** 撤销分享口令。`note` 选填 —— 写了就进 `audit_log`（与 A11 的"人工改回"同一口径） */
  public record RevokeRequest(
      @Size(max = 255, message = "说明过长（上限 255 字）") String note) {
  }

  /**
   * 复制一份。`name` 为空 = 服务端按 `<源名> 副本` 生成（并截到 128 字）。
   *
   * 为什么要允许传名字：现场最常见的用法就是"照这份拷一份改改"，
   * 而"拷完还得再改个名"是白干一次 —— 但**不传也能干活**（名字有默认值），所以它是可选的。
   */
  public record DuplicateRequest(
      @Size(max = 128, message = "方案名过长（上限 128 字）") String name) {
  }

  /**
   * 回滚。**两个版本号都写全名** —— 这一个请求里同时出现两个 rev，
   * 只写一个 `rev` 的话，读的人一定会把它当成另一个（本项目最忌讳的"同一个词指两样东西"）。
   *
   * · `targetRev` 要回到哪一版（用户点的那一行）
   * · `expectRev` 你手里是哪一版（乐观锁：对不上就是 409，而不是默默覆盖别人的改动）
   *
   * 两个都不给默认值：这里**猜错一次的代价是丢掉别人的工作**，所以宁可回 400 让人把话说清。
   */
  public record RollbackRequest(
      @NotNull(message = "回滚必须说清要回到哪一版（targetRev）") Integer targetRev,
      @NotNull(message = "回滚必须带上你手里的版本号（expectRev）") Integer expectRev,
      @Size(max = 255, message = "版本说明过长（上限 255 字）") String note) {
  }

  /**
   * 收封面（R6-3 3f）。字段名就叫 `dataUrl`，不叫 `png` / `image`：
   * 它不是"一段 base64"，而是**浏览器 `canvas.toDataURL()` 的整串输出**（含 `data:image/png;base64,` 头）——
   * 名字说清来源，前端与后端对"该交什么"就不会各理解一半。
   *
   * 上限 2 MB 是**字符串**长度上的粗挡（真正的判据在 `CoverImage`：解码后的字节数、PNG 文件头、
   * IHDR 里的真实宽高）。这里只挡"没带东西"与"一眼就知道太大"，不重复实现那三条。
   */
  public record CoverRequest(
      @NotBlank(message = "dataUrl 不能为空")
      @Size(max = 3_000_000, message = "封面数据过大（上限约 2 MB）")
      String dataUrl) {
  }

  /**
   * 生成交付包（R6-5 / A10）。
   *
   * `expectRev` 必填且**不是**乐观锁的可选项 —— 包上要写"钉在第几版"，没有它那句话就是编的。
   * `items` 是勾选名单（不传 = 只出必需的两件：README 与方案.json，见 `Delivery.selected`）。
   * `planSvg` / `shots` 是**只有浏览器能产的图形**（服务端没有渲染器，也不该有第二套）。
   * `shots` 的**顺序**就是三个固定视角的顺序（俯视 / 正面斜 45° / 斜角 45°），服务端按序命名。
   */
  public record DeliveryRequest(
      @NotNull(message = "必须带上你手里的版本号 expectRev")
      Integer expectRev,
      List<String> items,
      /**
       * 要不要把模型文件一起打进包。**用包装类型**：这一项与其它可选项一样可以不传，
       * 不传就是不出模型文件 —— `boolean` 那种写法会让"整个请求体"在少写这一项时被判成读不懂的 JSON。
       */
      Boolean withAssets,
      @Size(max = 255, message = "交付备注不超 255 字")
      String note,
      @Size(max = 4_000_000, message = "平面图 SVG 过大")
      String planSvg,
      List<String> shots,
      /** 三张图各自的视角 id（`top` / `front45` / `corner45`）—— 服务端按它核对顺序 */
      List<String> shotViews,
      /**
       * 每台设备所在的**房间名**（M1 多房间；键 = 设备 id 的字符串、值 = 房名）。
       *
       * 为什么由**客户端**给：房间是墙剖出来的派生面，那段面遍历在 JS 内核里**只有一份**
       * （`spatial-core/src/rooms.js`）。为了设备清单上的一列房間，把最难的几何算法在 Java 侧再写一遍，
       * 正是本项目最贵的那个教训（同一样东西两处实现，迟早一边改一边漏）。
       * 服务端只负责**把它写进那一列**；缺了就如实写「未分房间」，不猜。
       */
      Map<String, String> rooms) {
  }

  /**
   * 人工改交付状态（A11）。
   *
   * `note` **必填**：改的是"已经交出去了"这条事实，改的人要留下为什么（进 `audit_log`）。
   */
  public record DeliveryStateRequest(
      @NotBlank(message = "必须给出要改成哪个状态（draft / delivered）")
      String status,
      @Size(max = 255, message = "原因不超 255 字")
      String note) {
  }
}