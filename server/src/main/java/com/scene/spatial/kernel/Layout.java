package com.scene.spatial.kernel;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * Layout.java —— 领域模型：一个方案的房间 + 墙 + 柱 + 设备
 *
 * 字段与 JS 侧的 `state`（`{w, d, h, walls, columns?, items, routes?, view?, roomLabels?}`）**一一对应** ——
 * 方案 JSON 里存的就是它，所以这是"零迁移"那句话的落脚点：服务端不重排领域模型。
 *
 * 墙是 {@link Wall} 对象（`{a,b,openings}`，W1 起；镜像 `wall.js`）。以前它是 `double[4]`，
 * 而门洞必须长在墙上（用下标指墙会在墙列表重排时静默错指）—— 形状因此换代。
 * 老式四数读法（`wallBox` / 线段距离那类"拿四个数算"的地方）一律走 `wall.seg()`。
 */
public final class Layout {

  public double w;
  public double d;
  public double h;
  public final List<Wall> walls = new ArrayList<>();
  /**
   * 矩形结构柱（W5 柱，可选）：`{id, x, z, w, d}`，中心 + 完整边长，轴对齐、mm 精度。
   *
   * **不进 `walls`**：房间/开放面派生只读 `layout.walls`（`rooms.js` 的 `roomsOf`），
   * 一根 0.2 m 柱若进了墙列表，会把开放面闭合或把房间切两半 —— 房间数会在用户没改墙时静默变化。
   * 柱是独立的实心障碍：挡设备（`Validate.checkItem` 的 `hit-column`）、挡人、挡动线。
   * 面积（柱占/可用）是派生量，**不进 state**（设计决策记录 §2.4）。
   */
  public final List<Column> columns = new ArrayList<>();
  public final List<Item> items = new ArrayList<>();
  /**
   * 人员地面动线（W4，可选）：只存**用户点出的站点/途经点**。
   *
   * 自动折线、每段长度、箭头、状态、颜色全部是派生量，**不进 state**（设计决策记录 §四）——
   * 与"不存房间、不存开放面积"同一条纪律：存进去就会出现"同一个方案两套事实"。
   * 服务端只做形状/白名单镜像，**不寻路**（寻路在内核 `route.js`，只有一份）。
   */
  public final List<Route> routes = new ArrayList<>();
  /**
   * 视图档位（`solid` / `half` / `light`，可为 null）。内核**不解释**它 —— 只做透传，
   * 因为服务端存的是"规范化后的 state"（`Scheme.stateOf`）；不透传的话，
   * 前端保存一次就会把这个偏好悄悄抹掉。
   */
  public String wallStyle;

  /**
   * 房间名（可选，M1a）：键 = 房间的**几何稳定 id**，值 = 名字。
   *
   * 与 {@link #wallStyle} 同理 —— 内核**不解释**它（服务端没有面遍历，不判“这个 id 还在不在”），
   * 只做透传：不透传的话，前端保存一次就会把用户起的名字悄悄抹掉（FIX-05 的病因）。
   * ⚠️ 用 LinkedHashMap **保序**：导出要逐字节稳定，键的顺序也是比对的一部分；
   *    而“顺序”只能取自输入文件（服务端没有房间可拿来排序）。
   */
  public final LinkedHashMap<String, String> roomLabels = new LinkedHashMap<>();

  /** 新语义（`walls`）：房间 = 边界全部由墙组成的闭合面；矩形外框的剩余部分是开放场景 */
  public static final String SEMANTICS_WALLS = "walls";
  /** 旧语义（`legacy`）：矩形外框参与闭合，正面积面就算房间（旧方案导入后房间数不许变） */
  public static final String SEMANTICS_LEGACY = "legacy";

  /**
   * 房间派生语义（W3，**内部字段，不进 state**）：`walls` / `legacy`。
   *
   * 它由**格式标识**决定（`Scheme.semanticsOf(format)`）：新标识与新建 = `walls`，
   * 旧标识导入 = `legacy`。镜像 JS 的 `layout.roomSemantics`（读取器 `rooms.roomSemanticsOf`）。
   *
   * ⚠️ 服务端**不消费**它算房间（Java 侧没有面遍历 —— 见 设计决策记录修正：不重写第二份）；
   *    它只跟着 layout 走，供 `Scheme.importScheme` 的调用方（旧方案预检）读到正确语义。
   *    `Scheme.stateOf` 的白名单**不发射**它：派生口径不是数据。
   */
  public String roomSemantics = SEMANTICS_WALLS;

  public Layout(double w, double d, double h) {
    this.w = w;
    this.d = d;
    this.h = h;
  }

  /**
   * 一条动线（W4）：`{id, name?, points:[[x,z],...]}`，与 JS `route.js` 的契约一字不差。
   *
   * `points` 是用户点出的站点（2–20 个），**不是**自动算出的折线；`name` 可省略。
   * `id` 由 `max(id)+1` 分配，不建独立计数器（设计决策记录 §四）。
   */
  public static final class Route {
    public final int id;
    /** 可省略（null = 文件里没有这个字段；导出时也不写） */
    public final String name;
    /** 每个点固定 `{x, z}` 两项 */
    public final List<double[]> points;

    public Route(int id, String name, List<double[]> points) {
      this.id = id;
      this.name = name;
      this.points = points;
    }
  }

  /**
   * 一根矩形柱（W5）：`{id, x, z, w, d}`，与 JS `columns.js` 的契约一字不差。
   *
   * `x/z` 是柱脚**中心**（米），`w/d` 是**完整边长**（米）：四角 = `(x±w/2, z±d/2)`。
   * v1 轴对齐、无 `r` 字段（旋转是独立一期）；高度不入库，恒等于 `layout.h`。
   */
  public static final class Column {
    public final int id;
    public final double x;
    public final double z;
    public final double w;
    public final double d;

    public Column(int id, double x, double z, double w, double d) {
      this.id = id;
      this.x = x;
      this.z = z;
      this.w = w;
      this.d = d;
    }
  }

  /** 一台设备。字段与原型及方案 JSON 完全一致：`{id, p, x, z, r, doorAmount}` */
  public static final class Item {
    public final int id;
    public final String p;
    public final double x;
    public final double z;
    public final double r;
    public final double doorAmount;

    public Item(int id, String p, double x, double z, double r, double doorAmount) {
      this.id = id;
      this.p = p;
      this.x = x;
      this.z = z;
      this.r = r;
      this.doorAmount = doorAmount;
    }

    public Item movedTo(double nx, double nz) {
      return new Item(id, p, nx, nz, r, doorAmount);
    }

    @Override
    public String toString() {
      return "#" + id + "(" + p + " @ " + x + "," + z + " r=" + r + ")";
    }
  }

  /** 该墙是否为外墙（判定要走 {@link Room#isBoundaryWall} —— 它按**传入的**房间口径算） */
  public boolean isBoundaryWall(Wall wall) {
    return Room.isBoundaryWall(this, wall);
  }
}