/**
 * viewport.js —— 2D 视口的**纯数学**
 *
 * 这个文件里没有 DOM、没有 Vue、没有事件 —— 输入是数字，输出是数字，所以它可以单测。
 * 界面层只做两件事：把指针位置换算成"视口比例"，把结果塞进 viewBox。
 *
 * ── 三条口径（先说清楚，后面所有代码都从这里推）──────────────────────────
 * ① zoom = 1 ⟺ 界面上的「100%」⟺ **1 m 正好 64 px**（= PX_PER_M）。所以百分比标签是诚实的，
 *    不是"相对某个基准的比例"。
 * ② 适配（fit）= 让整间房 + 四周留白正好装进视口的那个 zoom。**它同时就是 zoom 的下限** ——
 *    适配已经看得见全貌，再缩小只会让标注变成灰点，没有任何信息增益。
 * ③ viewBox 的两个方向**按容器尺寸分别算**（w = 尺寸/zoom、d = 尺寸/zoom），
 *    于是 viewBox 的宽高比**恒等于**容器宽高比，preserveAspectRatio="meet" 的缩放系数
 *    就正好是 zoom，没有留白、没有二次缩放。窗口变大 = 看到更大范围，而不是把图拉大。
 *
 * ── 为什么不做"缩放时描边不变细"──────────────────────────────────────
 * 样式里的长度都是 calc(N * var(--u))，var(--u) = 1/64 px 是**常数**（viewBox 单位）。
 * 视口一缩，描边**按比例变粗**——这正是 CAD 缩放该有的样子，也让"放大到能看清"真的看得清。
 * 老办法（vector-effect: non-scaling-stroke）在这套单位系统里会把内联的"米"变成像素，
 * 直接看不见东西，style.css 里已经留了这条教训，别走回头路。
 */

export const PX_PER_M = 64;
export const MARGIN_M = 0.45;
export const ZOOM_MAX = 8;

const r = (v) => Math.round(v * 1000) / 1000;

/** 适配缩放：整间房 + 留白装进视口。还没量到容器尺寸时返回 1（中性值，别返回 0/NaN）。 */
export function fitZoom({ room, size }) {
  if (!(size.w > 0 && size.d > 0)) return 1;
  return Math.min(
    size.w / ((room.w + 2 * MARGIN_M) * PX_PER_M),
    size.d / ((room.d + 2 * MARGIN_M) * PX_PER_M),
  );
}

/** zoom 夹取：下限默认就是适配（见口径②），上限 ZOOM_MAX（1 m = 512 px，够精调了） */
export function clampZoom(z, min) {
  return Math.min(ZOOM_MAX, Math.max(min ?? 0, z));
}

/** 初始视图：整间房居中 + 适配 */
export function fitView({ room, size }) {
  return { zoom: fitZoom({ room, size }), cx: room.w / 2, cz: room.d / 2 };
}

/** 视图 → viewBox（viewBox 单位就是"k=1 时的设备像素"，与 .plan 的 --u 同一套） */
export function viewBoxOf({ view, size }) {
  const w = size.w / view.zoom;
  const d = size.d / view.zoom;
  return { x: view.cx * PX_PER_M - w / 2, y: view.cz * PX_PER_M - d / 2, w, d };
}

export function viewBoxText(v) {
  return `${r(v.x)} ${r(v.y)} ${r(v.w)} ${r(v.d)}`;
}

/** 视口内一点（fx/fz 是 0..1 的视口比例）对应的房间坐标（米） */
export function roomAt({ view, size, fx, fz }) {
  const wM = size.w / view.zoom / PX_PER_M;
  const dM = size.d / view.zoom / PX_PER_M;
  return { x: view.cx + (fx - 0.5) * wM, z: view.cz + (fz - 0.5) * dM };
}

/**
 * 以视口内某点为锚点缩放 —— **锚点下面的房间点必须一动不动**。
 * 这是滚轮缩放唯一的正确性要求：不满足它，用户会感觉"图在乱跑"。
 */
export function zoomAt({ view, size, fx, fz, factor, min }) {
  const anchor = roomAt({ view, size, fx, fz });
  const zoom = clampZoom(view.zoom * factor, min);
  const wM = size.w / zoom / PX_PER_M;
  const dM = size.d / zoom / PX_PER_M;
  return { zoom, cx: anchor.x - (fx - 0.5) * wM, cz: anchor.z - (fz - 0.5) * dM };
}

/** 平移：屏幕位移（px）→ 房间中心位移（米）。向右拖，图跟着手走，所以中心往左走 */
export function panBy({ view, dx, dz }) {
  const k = view.zoom * PX_PER_M;
  return { ...view, cx: view.cx - dx / k, cz: view.cz - dz / k };
}

/** 换中心（zoom 不变；给了 zoom 就一起换） */
export function centerOn({ view, cx, cz, zoom }) {
  return { zoom: zoom ?? view.zoom, cx, cz };
}

/**
 * 双击聚焦：以某个矩形（米）为中心，缩放到它大约占视口短边的 1/3。
 * 用"占几分之一"而不是固定 zoom —— 26 L 的箱子和 829 L 的箱子都该在屏幕上是"主角"。
 */
export function focusZoom({ rect, size, frac = 1 / 3 }) {
  if (!(size.w > 0 && size.d > 0)) return 1;
  const side = Math.max(rect.w, rect.d, 0.2) * PX_PER_M;
  return clampZoom(Math.min(size.w, size.d) * frac / side);
}
