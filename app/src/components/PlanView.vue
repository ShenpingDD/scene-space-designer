<script setup>
/**
 * PlanView —— 2D 平面图（SVG）
 *
 * 交互：点选设备 / 拖动设备 / 拖蓝点旋转 / 画内墙 / 选中墙体
 * 全部判断问内核：位置夹取、旋转吸附、墙的水平垂直吸附、墙长下限、墙数上限都在内核里，
 * 这里只做"把指针位置换算成房间坐标"这一件界面该做的事。
 *
 * 指针生命周期（R1 的 FIX-10）在这里天然不成立：
 * 用 pointer capture + pointerId 匹配，只可能有一个活动指针在改状态，
 * 不存在原型那种"第二个指针把第一个指针的半途状态接过去"的失败模式。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { cfg } from '@core/params.js';
import { wallOpacityOf } from '@core/wallstyle.js';
import { getProduct, placement, openings, rooms as roomsKernel, LIMITS } from '../kernel.js';
import { fmtLen, fmtArea } from '../fmt.js';
import { ROUTE_ARROW_D, routes2d, walls2d } from '../scene2d.js';
import { designer as d, planRoomPreview } from '../designer.js';
import RailFold from './RailFold.vue';
import { PX_PER_M, fitView, fitZoom, viewBoxOf, viewBoxText, zoomAt, panBy, focusZoom, centerOn } from '../viewport.js';

const svgRef = ref(null);
/**
 * 平面图坐标系：**viewBox 用像素**，所有几何（米）放在一层 scale(K) 的组里。
 *
 * 为什么必须这样：viewBox 用米的时候，CSS / 属性里所有长度都被当成"米"——
 *   stroke-width: 2    → 2 米（本图 64 px/米 → 128 px 描边，整张图像色块）
 *   font-size: 11px    → 11 米（实测文字包围盒 4171×919 px，整张图被巨字糊满）
 *   stroke-dasharray: 4 3 → 4 米/3 米（虚线看着像实线，等于没画）
 * 三者都不是"样式问题"，是**单位系统只能有一套**的问题。
 * 现在外面全是像素、里面全是米，靠这一层 transform 换算，以后加样式不用再想这件事。
 * 代价：房间越大图越大、字号按比例变小（平面图本来如此）；指针换算要除以 K。
 */
/* PX_PER_M 搬去 viewport.js 了：它现在不只是"平面图单位"，还是**「100%」的定义**（1 m = 64 px）。
   两者必须住在一起 —— 分开写就会各改各的。 */

// ── 视口（缩放/平移）：数学全在 viewport.js，这里只存"当前视图"和"容器量到多大" ──
const size = ref({ w: 0, d: 0 });
const view = ref({ zoom: 1, cx: 0, cz: 0 });
const pan = ref(null);        // { pointerId, x, y } —— 平移中
const spaceDown = ref(false);
const drag = ref(null);      // { id, dx, dz, pointerId }
const rotate = ref(null);    // { id, pointerId }
const drawStart = ref(null); // [x, z]
const hover = ref(null);
/** 画墙时是否按住 Shift（自由角度）：预览与落笔必须用**同一个**判断，否则看到的位置和存下来的不一样 */
const shiftNow = ref(false);

/* ---------------- 矩形柱（P2 2D）---------------- */
/** 拖两角画柱：`{ x0,z0,x1,z1,pointerId,moved }`；没 moved 的抬手 = 点放 0.5×0.5 */
const columnDraw = ref(null);
/** 拖柱身移动：`{ id, dx, dz, pointerId, moved, bad }` */
const columnDrag = ref(null);
/** 拖 8 向手柄：`{ id, handle, pointerId, start, moved, bad }` */
const columnResize = ref(null);

/* ---------------- 洞口（W1 门洞 / W2 窗）---------------- */
/** 放洞口模式（`d.openingMode` 是**三态**：'door' | 'window' | false）：
 *  按下时记下「哪面墙、哪个弧长、放的是门还是窗」，拖动则用这一段定宽 */
const openingStart = ref(null);      // { wallIndex, s, kind }
const openingHover = ref(null);      // { wallIndex, s }
/** 拖已有门洞（沿墙平移）：记下抓取偏移；`moved` 用来区分"点一下选中"与"拖了" */
const openingDrag = ref(null);       // { wallIndex, index, grabOff, pointerId, moved }

/* ---------------- 房间（M1）---------------- */
/** 画房：正在拖的那个矩形（已吸附）`{ x0, z0, x1, z1 }` */
const roomRect = ref(null);
/** 切分：正在拖的那条线 `{ a:[x,z], b:[x,z] }`（已吸附） */
const splitSeg = ref(null);

/* ---------------- 动线（W4/P2）---------------- */
/** 新动线草稿：`{ points: [[x,z],...] }`；只活在本次模式里，提交才进 layout */
const routeDraft = ref(null);
/** 按下但还没抬手：用来区分「点一下落点」与「拖出预览」；坐标在 up 时用同一套 toRoom */
const routePress = ref(null);
/** 拖已有站点：`{ id, index, points, pointerId, moved, blocked }`；首移才 beginEdit（一步撤销） */
const routeDrag = ref(null);
/** 「加途经点」的目标：`{ id, at }`；点一下地面就插进这条动线，成功后退出加站态 */
const routeAppend = ref(null);
/** 右栏 Teleport 目标必须等 Inspector 挂好；在同一个 tick 里查不到就下一 tick 再试 */
const railReady = ref(false);

const layout = computed(() => d.layout.value);
/** 视口 → viewBox 字符串。宽高比恒等于容器，所以 preserveAspectRatio 不会留白（viewport.js 口径③） */
const viewBox = computed(() => viewBoxText(viewBoxOf({ view: view.value, size: size.value })));
/** 缩放下限 = 适配：适配已经看得见全貌，再缩小只会让标注变成灰点 */
const zoomMin = computed(() => fitZoom({ room: layout.value, size: size.value }));
const zoomPct = computed(() => Math.round(view.value.zoom * 100));
const issueIds = computed(() => new Set(d.issues.value.map((x) => x.item.id)));
const issueById = computed(() => new Map(d.issues.value.map((x) => [x.item.id, x.reason])));

/** 2D 里设备只回答「这是什么/能不能动」；分类色留在左栏型号卡，不进画布。 */
function itemClearance(it) {
  return d.clearanceById.value.get(it.id) ?? null;
}
/**
 * 设备状态的**文字第二通道**：选中/问题/净空不靠颜色单独表达。
 * 同一句话同时进 aria-label 与 <title>，读屏和悬停看到的是同一份口径。
 */
function itemStatusText(it) {
  const parts = [];
  if (d.selectedId.value === it.id) parts.push('已选中');
  const issue = issueById.value.get(it.id);
  if (issue) parts.push(`布局问题：${issue}`);
  const level = itemClearance(it)?.level;
  if (level === 'warn') parts.push('门开启净空提醒');
  if (level === 'bad') parts.push('门开启净空不足');
  return parts.join('；');
}
function itemAria(it) {
  const status = itemStatusText(it);
  return status ? `${it.ariaLabel}；${status}` : it.ariaLabel;
}

/**
 * 画布下方视图栏的模式提示（docs/84 §五那张表，逐句照抄）。
 *
 * 为什么放在组件里算：它描述的是**PlanView 自己的交互状态**（画墙 / 放门 / 放窗 / 画房 / 切分），
 * 与三维视图无关；视图栏只负责显示。`id="plan-keys"` 由模板挂在这条提示上，
 * 画布 `aria-describedby` 指向它 —— 读屏念到的永远是当前模式那一句。
 */
const modeHint = computed(() => {
  if (d.columnMode.value) {
    return '画柱中 · 在空白处点一下放 0.5 × 0.5 m 柱；柱与墙可重叠 · Esc 退出';
  }
  if (d.routeMode.value) {
    if (routeDraft.value) return '画动线中 · 点地面依次加 A、B…（点空白处落点） · Enter 完成 · Backspace 退最后一站 · Esc 取消草稿';
    if (routeAppend.value) return '加途经点中 · 点地面把这个点插进选中动线 · Esc 取消';
    return '动线模式 · 点地面从 A 开始，或点已有动线选中；点工具条「动线」或按 Esc 退出';
  }
  if (d.roomMode.value === 'room') {
    return '画房间中 · 在画布上拖一个矩形（已有的墙会复用；触边、触墙会贴合） · Esc 退出';
  }
  if (d.roomMode.value === 'split') {
    return '切分中 · 在房间里拖一条线（两端会自动接到墙上） · Esc 退出';
  }
  if (d.openingMode.value === 'window') {
    return '放窗中 · 在墙上点一下放一扇默认尺寸的窗 · 拖一段则按那一段定宽 · Esc 退出';
  }
  if (d.openingMode.value) {
    return '放门中 · 在墙上点一下放一扇默认宽的门，拖一段则按那一段定宽 · 拖已有门洞可沿墙平移 · Esc 退出';
  }
  if (d.drawing.value) {
    return '画墙中 · 场内拖一笔是内墙；从场外起笔或两端贴场景边缘是外墙，会自动扩场景 · 默认吸附 15° 档，按住 Shift 自由角度 · Esc 退出';
  }
  return '拖动设备移动 · 拖蓝点旋转 · ＋ 放门在墙上开洞 · ＋ 放窗开一扇窗 · 滚轮缩放 · 右键拖动平移 · 双击设备聚焦 · Q/E 旋转 5° · Delete 删除';
});

/** 动线显隐是观看态（不进 layout）：只影响 2D/图例是否画它 */
function routeVisible(id) {
  return !d.routeHidden.value.has(id);
}

const visibleRouteRows = computed(() => d.routeRows.value.filter((r) => r.visible));
const visibleRoutes = computed(() => d.scene.value.routes.filter((r) => routeVisible(r.id)));

/**
 * 动线草稿预览：**与落笔共用 `d.planRouteDraft`**（它内部就是 P1 `planRoute`），
 * 这里只把结果交给 `routes2d` 拼图元。指针停在最后一点上时不再造一个重合点。
 */
const routePreview = computed(() => {
  const draft = routeDraft.value;
  if (!d.routeMode.value || !draft || !draft.points.length) return null;
  const candidate = draft.points.map((p) => [p[0], p[1]]);
  const h = hover.value;
  if (h) {
    const last = candidate[candidate.length - 1];
    const hx = snap(h[0]);
    const hz = snap(h[1]);
    if (!last || Math.hypot(hx - last[0], hz - last[1]) >= cfg.route.minAnchorGapM) candidate.push([hx, hz]);
  }
  const plan = d.planRouteDraft(candidate);
  const row = routes2d({ ...layout.value, routes: [{ id: 0, points: candidate }] }, [plan])[0];
  return { ...row, preview: true, draftCount: draft.points.length, candidate };
});

const routeCanFinish = computed(() => !!routeDraft.value && routeDraft.value.points.length >= 2);

const selectedRouteRow = computed(() => d.routeRows.value.find((r) => r.id === d.routeSelectedId.value) ?? null);

function routeStatusText(row) {
  if (!row) return '';
  if (row.status === 'ok') return `可通行 · ${fmtLen(row.length)} m · ${row.pointCount} 个点`;
  // v1 只有 ok|blocked（lead 2026-10-22 裁决）；CSS 的 warn 通道留给后续，不在界面上声称三态。
  return `走不通：${d.routeErrorText(row.plan)}`;
}

/** 画布上的原因只放一句短的；完整话术在右栏卡片与 title 里 */
function routeReasonShort(row) {
  const text = d.routeErrorText(row?.plan);
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

function renameRouteFromInput(row, evt) {
  const ok = d.renameRoute(row.id, evt.target.value);
  if (!ok) evt.target.value = row.name || '';
}

function isAppending(id) {
  return routeAppend.value?.id === id;
}

function removeRouteFromCard(id) {
  if (routeAppend.value?.id === id) routeAppend.value = null;
  d.removeRoute(id);
}

function stopLabel(index) {
  return String.fromCharCode(65 + index);
}

/** 当前选中的柱（scene2d 已带 selected/invalid 装饰） */
const selectedColumnRow = computed(() => d.selectedColumnInfo.value);
/** 8 向手柄：位置来自状态（x0/z0/x1/z1），不另存一份几何 */
const columnHandles = computed(() => {
  const c = selectedColumnRow.value;
  if (!c) return [];
  return [
    { name: 'nw', x: c.x0, z: c.z0 },
    { name: 'n', x: c.cx, z: c.z0 },
    { name: 'ne', x: c.x1, z: c.z0 },
    { name: 'e', x: c.x1, z: c.cz },
    { name: 'se', x: c.x1, z: c.z1 },
    { name: 's', x: c.cx, z: c.z1 },
    { name: 'sw', x: c.x0, z: c.z1 },
    { name: 'w', x: c.x0, z: c.cz },
  ];
});

/** 画柱预览：点一下（未移动）不显示；拖两角时与落笔共用内核检查，非法也保留红色理由 */
const previewColumn = computed(() => {
  const s0 = columnDraw.value;
  if (!s0 || !s0.moved) return null;
  const x0 = Math.min(s0.x0, s0.x1);
  const x1 = Math.max(s0.x0, s0.x1);
  const z0 = Math.min(s0.z0, s0.z1);
  const z1 = Math.max(s0.z0, s0.z1);
  const w = x1 - x0;
  const d0 = z1 - z0;
  const check = d.checkColumnDraft({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, w, d: d0 });
  return {
    x0, z0, x1, z1, w, d: d0,
    ok: check.ok,
    reason: check.reason,
    message: check.message,
    openingKind: check.openingKind,
    dPath: `M${x0} ${z0} L${x1} ${z0} L${x1} ${z1} L${x0} ${z1} Z`,
  };
});

function columnRectFromDraw(s0) {
  const x0 = Math.min(s0.x0, s0.x1);
  const x1 = Math.max(s0.x0, s0.x1);
  const z0 = Math.min(s0.z0, s0.z1);
  const z1 = Math.max(s0.z0, s0.z1);
  return { x0, z0, x1, z1, w: x1 - x0, d: z1 - z0, x: (x0 + x1) / 2, z: (z0 + z1) / 2 };
}

function columnPointAt(evt, free = false) {
  const p = toRoom(evt);
  return free ? { x: p.x, z: p.z } : { x: snap(p.x), z: snap(p.z) };
}

/** 拖 8 向：只改被拖的边，对边固定；低于 0.2 停在边界（不写非法 state） */
function resizeColumnTo(evt, at) {
  const rs = columnResize.value;
  if (!rs) return;
  const s0 = rs.start;
  let { x0, z0, x1, z1 } = s0;
  const h = rs.handle;
  const min = 0.2;
  if (h.includes('w')) x0 = Math.min(at.x, x1 - min);
  if (h.includes('e')) x1 = Math.max(at.x, x0 + min);
  if (h.includes('n')) z0 = Math.min(at.z, z1 - min);
  if (h.includes('s')) z1 = Math.max(at.z, z0 + min);
  const next = { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 };
  const ok = d.updateColumn(rs.id, next, { silent: true });
  if (!ok) rs.bad = true;
  else rs.bad = false;
}

function startColumnDraw(evt, p) {
  columnDraw.value = { x0: p.x, z0: p.z, x1: p.x, z1: p.z, pointerId: evt.pointerId, moved: false, startX: evt.clientX, startY: evt.clientY };
  grab(evt);
}

function commitColumnDraw() {
  const s0 = columnDraw.value;
  if (!s0) return;
  columnDraw.value = null;
  const r = columnRectFromDraw(s0);
  if (!s0.moved || (r.w < 0.05 && r.d < 0.05)) {
    d.addColumn({ x: s0.x0, z: s0.z0, w: 0.5, d: 0.5 });
    return;
  }
  d.addColumn(r);
}

const gridPath = computed(() => {
  const line = (seg) => `M${seg[0]} ${seg[1]} L${seg[2]} ${seg[3]}`;
  return {
    minor: d.scene.value.grid.minor.map(line).join(' '),
    major: d.scene.value.grid.major.map(line).join(' '),
  };
});

/**
 * 画墙预览。
 *
 * ⭐ 它不是"另画一条示意线"，而是**直接问内核要"这一拖会加出哪面墙"** ——
 *    连贴边/贴墙、夹取、毫米取整、太短判定都用落笔那一份（`addWall` 是纯函数，调它没有副作用）。
 *    这样"看到的"和"存下来的"**不可能不一样**，而不是靠两处代码长得像。
 *
 * ⚠️ 原来这里返回的是路径字符串，模板却写成 `<line :d="…">` —— SVG 的 `<line>` **没有 `d`**，
 *    属性被忽略、**也不报错**，所以预览从来没渲染过（用户反馈"移动鼠标看不到墙体路径"就是这个）。
 */
const previewWall = computed(() => {
  if (!drawStart.value || !hover.value) return null;
  const start = drawStart.value;
  const end = hover.value;
  const plan = d.planWall(start, end, { free: shiftNow.value });
  const rawLine = `M${start[0]} ${start[1]} L${end[0]} ${end[1]}`;
  if (!plan || plan.ok !== true) {
    // 非法预览**保留**：画一条危险色虚线把原因与差值说出来，而不是"拖了但什么都没发生"。
    return {
      ok: false,
      line: rawLine,
      len: Math.hypot(end[0] - start[0], end[1] - start[1]),
      mid: [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2],
      message: plan?.message ?? '这一笔还不能落墙',
      reason: plan?.reason ?? 'bad-point',
    };
  }
  // ⚠️ 预览必须按**落笔后的整份布局**取构件：只拿这一根墙去算，就漏掉了「公共端点缩半个墙厚」，
  //    于是预览比落笔多出两截（所见非所得）。
  const shapes = walls2d(plan.layout);
  const shape = shapes[plan.wallIndex] ?? shapes[shapes.length - 1];
  if (!shape) return null;
  // ⚠️ 左/上扩场景时，内核返回的是**新坐标系**：旧场景整体 +dx/+dz，预览墙自然也被推右/下。
  //    但此刻画布上其它墙还在旧坐标系，drawStart 也还是旧坐标 —— 不转回来就会
  //    “鼠标越往左，墙越往右长”（真机 验收 2026-10-22 第一项）。画房预览已有同一处理
  //    （designer.planRoomPreview 的 `-dx/-dz`），画墙这里必须一致。
  const ex = plan.expanded ?? null;
  const dx = Number(ex?.dx) || 0;
  const dz = Number(ex?.dz) || 0;
  const shift = (dx || dz) ? [-dx, -dz] : null;
  const mid = [shape.mid[0] - dx, shape.mid[1] - dz];
  return {
    ok: true,
    d: shape.d,
    shift,
    line: rawLine,
    len: shape.length,
    mid,
    wall: plan.wall,
    role: plan.role === 'exterior' || plan.role === 'interior' ? plan.role : shape.role,
    // ghost 也画在**当前**坐标系：新场景 = 旧场景向左/上扩 dx/dz，所以 x/y 取负偏移、宽高取 to。
    expanded: ex ? { ...ex, dx: -dx, dz: -dz } : null,
    overlapM: Number(plan.overlapM) || 0,
  };
});

/**
 * 放门预览。
 *
 * ⭐ 与落笔**共用内核那一条**（`openings.draftOpening`）—— 位置、夹取、毫米级取整、
 *    "太窄会被夹到多少"都用落笔那一份算。这样"看到的"与"存下来的"不可能不一样，
 *    而不是靠两处代码长得像（画墙预览就是这么做的，见 `previewWall`）。
 */
const previewOpening = computed(() => {
  if (!d.openingMode.value || !openingHover.value) return null;
  const { wallIndex, s } = openingHover.value;
  const wall = layout.value.walls[wallIndex];
  if (!wall) return null;
  const start = openingStart.value && openingStart.value.wallIndex === wallIndex ? openingStart.value : null;
  // 放的是门还是窗由当前模式决定：预览与落笔递的是**同一个 `kind`**（看到的 = 存下来的）
  const kind = d.openingMode.value === 'window' ? 'window' : 'door';
  const fit = openings.draftOpening(wall, start ? { span: [start.s, s], kind } : { at: s, kind },
    { roomH: layout.value.h, existing: openings.openingSpans(wall) });
  if (!fit.ok) return { ok: false, kind, width: 0, quad: null, mid: null, sill: 0 };
  const quad = openings.holeQuad(wall, fit.opening);
  const mid = quad.reduce((a, q) => [a[0] + q[0] / 4, a[1] + q[1] / 4], [0, 0]);
  return {
    ok: true, kind, width: fit.opening.w, height: fit.opening.h,
    sill: fit.opening.sill ?? 0, quad, mid,
  };
});

/**
 * 拖门洞预览的命中半径（米）：墙厚的好几倍，手指/鼠标都够得着，但不会碰到隔壁的墙。
 * ⚠️ 必须是**函数**：参数表是活引用，导入期抄成常量就再也跟踪不到后台改的值了。
 */
const grabDistM = () => Math.max(0.6, cfg.space.wallThicknessM * 6);

/**
 * 放门 / 放窗开关（同一个开关，只是记着放的是哪一种）。
 * 再点一次同一个按钮 = 退出（照旧）；点另一个按钮 = 直接换过去（不用先退再进）。
 */
function toggleOpening(kind = 'door') {
  const next = d.openingMode.value === kind ? false : kind;
  d.setOpeningMode(next);
  openingHover.value = null;
  if (next === 'window') d.toast('放窗模式：在墙上点一下放一扇窗（拖一段则按那一段定宽）· Esc 退出');
  else if (next) d.toast('放门模式：在墙上点一下放一扇门；拖一段则按那一段定宽（Esc 退出）');
}

/**
 * 画房间预览。
 *
 * ⭐ 与落笔**共用内核那一条**（`roomOutlineWalls`）—— 哪几条边会复用已有的墙、
 *    哪几条是新墙，都拿落笔那一份算。于是"看到的"与"存下来的"不可能不一样。
 */
const previewRoom = computed(() => {
  const rect = roomRect.value;
  if (!rect) return null;
  // 预览与落笔同源：先扩场景，再拿扩展后的 layout/rect 算外框墙；失败就不画（提交路径会 toast）。
  const p = planRoomPreview(layout.value, rect);
  if (!p.ok) return null;
  return {
    ...p,
    tooMany: p.total > LIMITS.walls,
    label: p.walls.length
      ? `${p.walls.length} 面新墙${p.reused ? ` · ${p.reused} 条边复用` : ''} → 房间 ${d.roomCount.value} → ${p.roomsAfter} 间`
      : '这块地方已经是房间了',
  };
});

/**
 * 切分预览：**直接问内核"这一拖会切成什么样"**（`planSplit`），
 * 切不开就把原因原话打在提示行上 —— 不许"拖了但什么都没发生"。
 */
const previewSplit = computed(() => {
  const seg = splitSeg.value;
  if (!seg) return null;
  const r = roomsKernel.planSplit(layout.value, seg);
  return { seg, ...r, line: r.ok ? [r.wall.a, r.wall.b] : [seg.a, seg.b] };
});

/**
 * 2D 墙体材质：与三维**同一份判据**（方案选了档位就按方案，没选就按参数 `space.wallOpacity`）。
 * 这里只把内核算出来的数字挂成 CSS 变量 —— 颜色与不透明度的**表现**全在 style.css 里，
 * 界面不写死任何一个色值（"档位在 2D 不生效"就是用户实测反馈的那条）。
 */
const wall2dOpacity = computed(() => wallOpacityOf(layout.value.view?.wallOpacity, cfg.space.wallOpacity));

/**
 * 旋转手柄的位置（画布坐标，米）。
 * ⚠️ **不许在这里手写三角函数**：手柄方位与角度换算必须共用内核那一份约定
 * （`placement.handlePoint` / `angleFromPointer` 互逆，单测钉着）。
 * 选中的设备换了、转了、型号换了，这里都跟着变。
 */
const handlePos = computed(() => {
  const it = d.selected.value;
  const p = d.selectedProduct.value;
  if (!it || !p) return null;
  return placement.handlePoint(it.x, it.z, it.r, placement.handleDistOf(p));
});

const snap = (v) => Math.round(v / cfg.space.snapM) * cfg.space.snapM;

function toRoom(evt) {
  return roomAtClient(evt.clientX, evt.clientY);
}

/** 屏幕坐标 → 房间坐标（米）。指针事件与自动平移的 rAF 共用这一份换算。 */
function roomAtClient(clientX, clientY) {
  const svg = svgRef.value;
  if (!svg) return { x: 0, z: 0 };
  const m = svg.getScreenCTM();
  if (!m) return { x: 0, z: 0 };
  const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
  // viewBox 是像素 → 除以 K 才是米（缩放/居中都在 getScreenCTM 里，这里只管单位）
  return { x: p.x / PX_PER_M, z: p.y / PX_PER_M };
}

/* ---------------- 画房时靠近画布边缘自动平移 ---------------- */
/**
 * 画房拖到画布边缘 / 画布外时，视口自动往那一侧平移。
 *
 * 为什么要它：房间可以画到现有空间外（落笔时由内核 `expandToInclude` 扩空间），
 * 但画布只显示当前视野 —— 想把落点继续往外拉，得先让视口跟着走。
 *
 * 口径：
 *  - 只在 `roomRect` 非空（画房拖动中）时启动；设备/墙/门洞的拖拽与右键平移不受影响。
 *  - 指针离画布边缘 ≤56px，或已经在画布外 → 按「伸进边缘的深度」给速度（越靠边越快，
 *    出界最多 2×）。平移只用现有 `panBy`，不在这里另写坐标换算。
 *  - 指针不动、视口在动时，矩形的活动角按**新视口**重算（`roomAtClient`），
 *    否则预览矩形会脱手、落点和眼睛看到的不一致。
 *  - 用 requestAnimationFrame 连续推：指针停在边缘也会继续走；回到中间就停。
 *  - 不做任何 `fit()`：只有 layout 尺寸真的变了，现有 watch 才重适配，拖拽中不抢视野。
 */
const AUTO_PAN_EDGE_PX = 56;
const AUTO_PAN_SPEED_PX_S = 420;
let autoPan = null;   // { x, y, raf, last, bounds }

/**
 * 指针离某条边多近 → 0..1 的推力（0 = 不用推；1 = 贴边）。
 * 只画布内有效：出画布/出窗口就由 `autoPanVelocity` 直接判 0，不在这里算。
 */
function edgePull(dist) {
  if (dist >= AUTO_PAN_EDGE_PX) return 0;
  return Math.min(1, (AUTO_PAN_EDGE_PX - Math.max(0, dist)) / AUTO_PAN_EDGE_PX);
}

/**
 * 屏幕像素/秒。`panBy` 的 dx>0 = 手往右拖（图跟手走、中心左移），
 * 所以「想看到右边」要传负数 —— 左边缘推正、右边缘推负。
 */
function autoPanVelocity(x, y) {
  const svg = svgRef.value;
  if (!svg) return { dx: 0, dz: 0 };
  const b = svg.getBoundingClientRect();
  if (!(b.width > 0 && b.height > 0)) return { dx: 0, dz: 0 };
  // ⚠️ 出画布立即停：之前按出界距离一直加速，用户向上/向左拖出去后手一停，
  //    视口还在飞，1 秒就能把整个场景推出屏幕（真机 验收 2026-10-22 截图的“视角坏了”）。
  if (x < b.left || x > b.right || y < b.top || y > b.bottom) return { dx: 0, dz: 0 };
  const vx = (edgePull(x - b.left) - edgePull(b.right - x)) * AUTO_PAN_SPEED_PX_S;
  const vz = (edgePull(y - b.top) - edgePull(b.bottom - y)) * AUTO_PAN_SPEED_PX_S;
  const mag = Math.hypot(vx, vz);
  const cap = AUTO_PAN_SPEED_PX_S;
  if (mag > cap) return { dx: (vx * cap) / mag, dz: (vz * cap) / mag };
  return { dx: vx, dz: vz };
}

function stopAutoPan() {
  if (autoPan?.raf) cancelAnimationFrame(autoPan.raf);
  autoPan = null;
}

function autoPanTick(ts) {
  const step = autoPan;
  if (!step) return;
  if (!roomRect.value && !(d.drawing.value && drawStart.value)
    && !routePress.value && !routeDrag.value) { stopAutoPan(); return; }
  // dt 上限 50ms：切后台再回来时不要一下跳出去很远
  const dt = step.last ? Math.min(0.05, (ts - step.last) / 1000) : 0;
  step.last = ts;
  const v = autoPanVelocity(step.x, step.y);
  if (Math.abs(v.dx) < 0.5 && Math.abs(v.dz) < 0.5) {
    autoPan = null;   // 指针回到中间：下一次 pointermove 会重新判断
    return;
  }
  if (dt > 0) {
    view.value = panBy({ view: view.value, dx: v.dx * dt, dz: v.dz * dt });
    const p = roomAtClient(step.x, step.y);
    const x1 = snap(p.x);
    const z1 = snap(p.z);
    // 画墙 / 画房拖动中：视口一动，活动端点必须按**新视口**重算，否则预览会脱手。
    if (roomRect.value) {
      if (roomRect.value.x1 !== x1 || roomRect.value.z1 !== z1) {
        roomRect.value = { ...roomRect.value, x1, z1 };
      }
    } else if (routeDrag.value) {
      moveRouteDragTo({ pointerId: routeDrag.value.pointerId, clientX: step.x, clientY: step.y });
    } else if (drawStart.value || routePress.value) {
      if (!hover.value || hover.value[0] !== p.x || hover.value[1] !== p.z) hover.value = [p.x, p.z];
    }
  }
  step.raf = requestAnimationFrame(autoPanTick);
}

/** 记下指针位置并保证循环在跑（画房/画墙拖动中每次 pointermove 都会调） */
function trackAutoPan(x, y) {
  if (autoPan) { autoPan.x = x; autoPan.y = y; return; }
  const v = autoPanVelocity(x, y);
  // 不在边缘就别起循环：否则每次 pointermove 都要白跑一帧
  if (Math.abs(v.dx) < 0.5 && Math.abs(v.dz) < 0.5) return;
  autoPan = { x, y, raf: 0, last: 0 };
  autoPan.raf = requestAnimationFrame(autoPanTick);
}

function grab(evt) {
  const svg = svgRef.value;
  try { svg.setPointerCapture(evt.pointerId); } catch { /* 忽略：某些环境不支持捕获 */ }
}

/**
 * 平移起手：右键 / 中键 / 空格+左键。
 * 为什么右键当主路径 —— 3D 那边 OrbitControls 就是右键平移，两个视图用同一套手势不用记两遍；
 * 而且平面图本来就没有右键菜单（模板里已 prevent）。
 */
function beginPan(evt) {
  pan.value = { pointerId: evt.pointerId, x: evt.clientX, y: evt.clientY };
  grab(evt);
}

/* ---------------- 动线手势（W4/P2）---------------- */

/** 指针 → 吸附后的站点。只做界面这一层换算，合法性一律交给 designer/P1。 */
function routePointAt(evt) {
  const p = toRoom(evt);
  return [snap(p.x), snap(p.z)];
}

function startRoutePress(evt) {
  routePress.value = {
    pointerId: evt.pointerId,
    startX: evt.clientX,
    startY: evt.clientY,
    moved: false,
  };
  grab(evt);
}

/**
 * 抬手落点：与预览共用 `d.planRouteDraft`；草稿点只在合法时追加。
 * 「加途经点」与「新动线」共用这条，区别只在提交函数。
 */
function commitRoutePress(evt) {
  const press = routePress.value;
  if (!press || press.pointerId !== evt.pointerId) return false;
  routePress.value = null;
  const point = routePointAt(evt);

  if (routeAppend.value) {
    const { id, at } = routeAppend.value;
    const ok = d.addRoutePoint(id, point, at);
    if (ok) routeAppend.value = null;
    return ok;
  }

  if (!routeDraft.value) {
    const bad = d.routePointProblem(point);
    if (bad) { d.toast(bad); return false; }
    d.clearRouteSelection();
    routeDraft.value = { points: [point] };
    return true;
  }

  const points = [...routeDraft.value.points, point];
  if (points.length > cfg.route.maxPoints) {
    d.toast(`一条动线最多 ${cfg.route.maxPoints} 个点；先按 Enter 完成`);
    return false;
  }
  const plan = d.planRouteDraft(points);
  if (!plan.ok) {
    d.toast(d.routeErrorText(plan));
    return false;
  }
  routeDraft.value = { points };
  return true;
}

/** 完成草稿：提交的是同一条 `points`（预览与落笔不会两套几何） */
function finishRouteDraft() {
  if (!routeDraft.value) return false;
  if (routeDraft.value.points.length < 2) {
    d.toast('至少要有 A、B 两个点才能成为一条动线');
    return false;
  }
  const r = d.addRoute(routeDraft.value.points);
  if (!r) return false;
  routeDraft.value = null;
  routePress.value = null;
  routeAppend.value = null;
  stopAutoPan();
  return true;
}

function beginRouteDrag(evt, el) {
  const [id, index] = String(el.dataset.routeHandle ?? '').split(':').map(Number);
  const route = d.routeById(id);
  if (!route || !Number.isInteger(index) || index < 0 || index >= route.points.length) return;
  d.selectRoutePoint(id, index);
  routePress.value = null;
  routeAppend.value = null;
  routeDrag.value = {
    id, index, pointerId: evt.pointerId, moved: false, blocked: false,
    points: route.points.map((p) => [p[0], p[1]]),
  };
  grab(evt);
}

/** 拖动站点：首移才开历史；即使这段被墙/设备挡住也保留用户点（失效路线保留，标红） */
function moveRouteDragTo(evt) {
  const drag = routeDrag.value;
  if (!drag || drag.pointerId !== evt.pointerId) return false;
  const point = routePointAt(evt);
  const cur = drag.points[drag.index];
  if (!cur || (cur[0] === point[0] && cur[1] === point[1])) return false;
  if (!drag.moved) {
    drag.moved = true;
    d.beginEdit();   // 一次站点拖拽 = 一个撤销步
  }
  const points = drag.points.map((p, i) => (i === drag.index ? point : p));
  const plan = d.planRouteDraft(points, drag.id);
  drag.points = points;
  drag.blocked = !plan.ok;
  drag.plan = plan;
  d.setRoutePoints(drag.id, points, { silent: true });
  return true;
}

function finishRouteDrag(evt) {
  const drag = routeDrag.value;
  if (!drag || drag.pointerId !== evt.pointerId) return;
  routeDrag.value = null;
  if (!drag.moved) return;
  if (drag.blocked) d.toast(d.routeErrorText(drag.plan));
}

function updateColumnField(row, field, evt) {
  const v = Number(evt.target.value);
  if (!Number.isFinite(v)) { evt.target.value = Number(row[field]).toFixed(2); return; }
  const ok = d.updateColumn(row.id, { [field]: v });
  if (!ok) evt.target.value = Number(row[field]).toFixed(2);
}

function toggleColumn() {
  if (d.columnMode.value) {
    d.setColumnMode(false);
    d.toast('已退出画柱模式');
    return;
  }
  d.setColumnMode(true);
  d.toast('画柱模式：在空白处点一下放 0.5 × 0.5 m 柱 · 柱与墙可重叠 · Esc 退出');
}

function toggleRoute() {
  if (d.routeMode.value) {
    routeDraft.value = null;
    routePress.value = null;
    routeDrag.value = null;
    routeAppend.value = null;
    stopAutoPan();
    d.setRouteMode(false);
    d.toast('已退出动线模式');
    return;
  }
  d.setRouteMode(true);
  d.toast('动线模式：点地面 A，再点 B…（自动避开墙体/设备；Enter 完成）');
}

function startRouteAppend(id) {
  const route = d.routeById(id);
  if (!route) return false;
  // 选中了某个站点就从它后面插；否则追加到末尾。动作名不变，但落点对用户可预期。
  const sel = d.routeSelectedPoint.value;
  const at = sel && sel.routeId === id ? Math.min(route.points.length, sel.index + 1) : route.points.length;
  d.setRouteMode(true);
  d.selectRoute(id);
  routeDraft.value = null;
  routeAppend.value = { id, at };
  d.toast(`加途经点：点地面，把新站插到「${route.name || `动线 ${id}`}」${at < route.points.length ? '选中站点之后' : '末尾'} · Esc 取消`);
  return true;
}

function cancelRouteAppend() {
  routeAppend.value = null;
}

function onDown(evt) {
  stopAutoPan();   // 上一次手势如果没收干净，先停掉自动平移
  if (evt.button === 1 || evt.button === 2 || (evt.button === 0 && spaceDown.value)) {
    evt.preventDefault();
    beginPan(evt);
    return;
  }
  if (evt.button !== 0) return;
  // 接管这次拖拽。少了这一句，浏览器会接着做它的默认动作 ——
  // 在画墙 / 拖设备时表现为"把画面上的文字选中了"，用户看到的结论就是"画不了墙"（首次上手实测反馈）。
  evt.preventDefault();
  // preventDefault 顺带吃掉了"点击聚焦"，而 Q/E/Delete 这些快捷键靠 svg 有焦点 —— 显式补回来。
  try { svgRef.value?.focus({ preventScroll: true }); } catch { /* 忽略：某些环境不支持 */ }
  const pt = toRoom(evt);
  const el = evt.target.closest?.('[data-item-id], [data-wall-index], [data-rotate-id], [data-opening]');

  // 动线模式：只认地面与动线自己的手柄/线；不进入设备/墙/房间的拖拽（模式互斥）
  if (d.routeMode.value) {
    const handleEl = evt.target.closest?.('[data-route-handle]');
    if (handleEl && !routeDraft.value && !routeAppend.value) {
      beginRouteDrag(evt, handleEl);
      return;
    }
    if (routeDraft.value || routeAppend.value) {
      startRoutePress(evt);
      return;
    }
    const hitEl = evt.target.closest?.('[data-route-hit]');
    if (hitEl) {
      const id = Number(hitEl.dataset.routeHit);
      if (d.selectRoute(id)) d.toast(`已选中${d.routeRows.value.find((r) => r.id === id)?.displayName ?? '动线'}`);
      return;
    }
    startRoutePress(evt);
    return;
  }

  // 非动线模式也允许点选已有动线/站点（选中是只读动作；改点仍要在动线模式里拖）
  const routeHitEl = evt.target.closest?.('[data-route-hit]');
  if (routeHitEl) {
    d.selectRoute(Number(routeHitEl.dataset.routeHit));
    return;
  }
  const routeStopEl = evt.target.closest?.('[data-route-handle]');
  if (routeStopEl) {
    const [rid, ri] = String(routeStopEl.dataset.routeHandle ?? '').split(':').map(Number);
    d.selectRoutePoint(rid, ri);
    return;
  }

  // 柱：8 向手柄优先于柱身；柱身按下先选中，再准备拖动（首移才开历史）
  const colHandleEl = evt.target.closest?.('[data-column-handle]');
  if (colHandleEl && selectedColumnRow.value) {
    const c = selectedColumnRow.value;
    columnResize.value = {
      id: c.id, handle: String(colHandleEl.dataset.columnHandle),
      pointerId: evt.pointerId, start: { x0: c.x0, z0: c.z0, x1: c.x1, z1: c.z1 }, moved: false, bad: false,
    };
    grab(evt);
    return;
  }
  // 柱：点柱选中（非画柱模式也允许）；这一层在设备/墙之前，柱优先被点中
  const colEl = evt.target.closest?.('[data-column-id]');
  if (colEl) {
    const id = colEl.dataset.columnId;
    d.selectColumn(id);
    const c = d.selectedColumnInfo.value;
    if (c) {
      columnDrag.value = {
        id: c.id, dx: c.cx - pt.x, dz: c.cz - pt.z,
        pointerId: evt.pointerId, moved: false, bad: false,
      };
      grab(evt);
    }
    return;
  }
  // 画柱：拖两角定宽深；只点一下（没拖动）抬手放 0.5×0.5。柱与墙可重叠，所以不要求点空白。
  if (d.columnMode.value) {
    startColumnDraw(evt, columnPointAt(evt, !!evt.shiftKey));
    return;
  }

  // 画房间：记下起点（矩形另一端跟着指针走）
  if (d.roomMode.value === 'room') {
    roomRect.value = { x0: snap(pt.x), z0: snap(pt.z), x1: snap(pt.x), z1: snap(pt.z) };
    grab(evt);
    return;
  }
  // 切分：记下起点
  if (d.roomMode.value === 'split') {
    splitSeg.value = { a: [snap(pt.x), snap(pt.z)], b: [snap(pt.x), snap(pt.z)] };
    grab(evt);
    return;
  }

  // 放门模式：只认墙 —— 点墙记弧长，拖动即用这一段定宽
  if (d.openingMode.value) {
    const proj = placement.projectOnWall(layout.value, pt, { maxDist: grabDistM() });
    if (!proj) {
      d.toast(d.openingMode.value === 'window'
        ? '请点在墙上：窗要开在一面墙上'
        : '请点在墙上：放门模式里，门洞要长在一面墙上');
      return;
    }
    // 起手就把"放的是门还是窗"钉在快照里：落笔那一刻再读模式，万一模式变了就会画错东西
    openingStart.value = {
      wallIndex: proj.wallIndex, s: proj.s,
      kind: d.openingMode.value === 'window' ? 'window' : 'door',
    };
    openingHover.value = { wallIndex: proj.wallIndex, s: proj.s };
    grab(evt);
    return;
  }

  // 门洞：点它选中（拖动则沿墙平移）—— 排在画墙/设备之前，优先于它所在的那面墙
  const openEl = evt.target.closest?.('[data-opening]');
  if (openEl) {
    const [wi, oi] = String(openEl.dataset.opening).split(':').map(Number);
    d.selectOpening(wi, oi);
    const wall = layout.value.walls[wi];
    const cur = wall?.openings?.[oi];
    const proj = placement.projectOnWall(layout.value, pt);
    if (cur && proj && proj.wallIndex === wi) {
      d.beginEdit();      // 一次拖动 = 一个撤销步
      openingDrag.value = { wallIndex: wi, index: oi, grabOff: cur.at - proj.s, pointerId: evt.pointerId, moved: false };
    }
    grab(evt);
    return;
  }

  // 画墙模式：只记起点，抬起时交给内核（内核负责水平/垂直吸附与长度校验）
  if (d.drawing.value) {
    shiftNow.value = !!evt.shiftKey;
    drawStart.value = [pt.x, pt.z];
    grab(evt);
    return;
  }

  const rot = evt.target.closest?.('[data-rotate-id]');
  if (rot) {
    const id = Number(rot.dataset.rotateId);
    d.selectItem(id);
    const item = layout.value.items.find((i) => i.id === id);
    // ⭐ **抓取偏移**：按下时记下"设备当前角度 − 指针方位"，拖动时加回去。
    //    没有它，只要指针没正好落在手柄圆心（几乎总是这样），按下的那一瞬间就会跳一下；
    //    旧实现连 180° 都差着 —— 偏移量算出来正好是 180。
    const grabOff = item ? item.r - placement.angleFromPointer(item.x, item.z, pt.x, pt.z) : 0;
    d.beginEdit(); // 一次旋转拖拽 = 一个撤销步（过程静默，不进历史）
    rotate.value = { id, pointerId: evt.pointerId, grabOff };
    grab(evt);
    return;
  }

  const itemEl = el?.dataset?.itemId ? el : null;
  if (itemEl) {
    const id = Number(itemEl.dataset.itemId);
    const item = layout.value.items.find((i) => i.id === id);
    if (!item) return;
    d.selectItem(id);
    d.beginEdit(); // 一次拖拽 = 一个撤销步
    drag.value = { id, dx: item.x - pt.x, dz: item.z - pt.z, moved: false, pointerId: evt.pointerId };
    grab(evt);
    return;
  }

  const wallEl = el?.dataset?.wallIndex !== undefined ? evt.target.closest('[data-wall-index]') : null;
  if (wallEl) {
    d.selectWall(Number(wallEl.dataset.wallIndex));
    return;
  }

  // 点房间 = 选中它（硬要求：切房间 **1 步**）
  const roomEl = evt.target.closest?.('[data-room-id]');
  if (roomEl) {
    d.selectRoom(roomEl.dataset.roomId);
    return;
  }

  d.clearSelection();
}

function onMove(evt) {
  if (pan.value && pan.value.pointerId === evt.pointerId) {
    // 平移用**屏幕位移**换算（panBy 自己除以 zoom）。这里绝不能走 toRoom ——
    // 视图一动、房间坐标就跟着动，用房间坐标算平移会变成自我追逐。
    view.value = panBy({ view: view.value, dx: evt.clientX - pan.value.x, dz: evt.clientY - pan.value.y });
    pan.value.x = evt.clientX;
    pan.value.y = evt.clientY;
    return;
  }
  const pt = toRoom(evt);
  shiftNow.value = !!evt.shiftKey;
  hover.value = [pt.x, pt.z];

  // 动线模式：拖站点 / 拖出预览 / 只更新悬停，绝不落到设备/墙的拖动分支
  if (d.routeMode.value) {
    if (routeDrag.value && routeDrag.value.pointerId === evt.pointerId) {
      moveRouteDragTo(evt);
      trackAutoPan(evt.clientX, evt.clientY);
      return;
    }
    if (routePress.value && routePress.value.pointerId === evt.pointerId) {
      const p = routePress.value;
      if (Math.hypot(evt.clientX - p.startX, evt.clientY - p.startY) > 3) p.moved = true;
      trackAutoPan(evt.clientX, evt.clientY);
      return;
    }
    return;
  }

  // 画柱拖动：Shift 只关吸附；两角都按当前指针更新（预览实时校验）
  if (columnDraw.value && columnDraw.value.pointerId === evt.pointerId) {
    const s0 = columnDraw.value;
    const p = columnPointAt(evt, !!evt.shiftKey);
    s0.x1 = p.x; s0.z1 = p.z;
    if (Math.hypot(evt.clientX - (s0.startX ?? evt.clientX), evt.clientY - (s0.startY ?? evt.clientY)) > 3) s0.moved = true;
    return;
  }
  if (columnDrag.value && columnDrag.value.pointerId === evt.pointerId) {
    const cd = columnDrag.value;
    if (!cd.moved) { cd.moved = true; d.beginEdit(); }  // 一次拖动 = 一步撤销
    const p = columnPointAt(evt, !!evt.shiftKey);
    const ok = d.updateColumn(cd.id, { x: p.x + cd.dx, z: p.z + cd.dz }, { silent: true });
    cd.bad = !ok;
    return;
  }
  if (columnResize.value && columnResize.value.pointerId === evt.pointerId) {
    const rs = columnResize.value;
    if (!rs.moved) { rs.moved = true; d.beginEdit(); }
    resizeColumnTo(evt, columnPointAt(evt, !!evt.shiftKey));
    return;
  }

  if (roomRect.value) {
    roomRect.value = { ...roomRect.value, x1: snap(pt.x), z1: snap(pt.z) };
    // 指针贴边时启动/续跑自动平移：视口一走，活动角在下一帧按新视口重算
    trackAutoPan(evt.clientX, evt.clientY);
    return;
  }
  if (splitSeg.value) {
    splitSeg.value = { ...splitSeg.value, b: [snap(pt.x), snap(pt.z)] };
    return;
  }
  // 画墙拖动中：指针贴边/出界时自动平移；端点按新视口重算（与画房同一条 autoPan）
  if (d.drawing.value && drawStart.value) {
    trackAutoPan(evt.clientX, evt.clientY);
    return;
  }

  // 放门模式：跟踪落在哪面墙的哪个弧长（预览跟着走）
  if (d.openingMode.value) {
    const proj = placement.projectOnWall(layout.value, pt, { maxDist: grabDistM() });
    openingHover.value = proj ? { wallIndex: proj.wallIndex, s: proj.s } : null;
    return;
  }
  if (openingDrag.value && openingDrag.value.pointerId === evt.pointerId) {
    const proj = placement.projectOnWall(layout.value, pt);
    if (proj && proj.wallIndex === openingDrag.value.wallIndex) {
      openingDrag.value.moved = true;
      // 沿墙平移：夹取与提示仍在内核（这里只是把鼠标位置换成弧长）
      d.updateOpening({ at: proj.s + openingDrag.value.grabOff }, { silent: true });
    }
    return;
  }

  if (drag.value && drag.value.pointerId === evt.pointerId) {
    drag.value.moved = true;
    // 内核 moveItem 负责夹取到 [0,w]×[0,d]
    d.setPosition(drag.value.id, snap(pt.x + drag.value.dx), snap(pt.z + drag.value.dz));
    return;
  }
  if (rotate.value && rotate.value.pointerId === evt.pointerId) {
    const item = layout.value.items.find((i) => i.id === rotate.value.id);
    // 角度吸附在内核里做（5° 一档），这里只把指针位置 + 抓取偏移递进去 —— 1:1 跟手，不跳
    if (item) {
      d.rotate(item.id, placement.angleFromPointer(item.x, item.z, pt.x, pt.z) + (rotate.value.grabOff || 0), { silent: true });
    }
  }
}

/**
 * 画墙落笔：与预览**共用** `d.planWall`，把同一份结果交给 `d.addWallPlan`（只 beginEdit 一次）。
 * 窗口级 pointerup 兜底也调它；`drawStart` 一清空就不会双提交。
 */
function commitWall(evt) {
  const s = drawStart.value;
  if (!s) return false;
  const end = toRoom(evt);
  const plan = d.planWall(s, end, { free: !!evt.shiftKey });
  drawStart.value = null;
  stopAutoPan();
  if (!plan || plan.ok !== true) {
    d.toast(plan?.message ?? `墙体太短：请拖动出至少 ${cfg.scheme.minWallLengthM} m`);
    return false;
  }
  return d.addWallPlan(plan);
}

/** 窗口级兜底：指针在画布外松开（或 lostpointercapture）时 svg 的 onUp 收不到。 */
function onWindowPointerUp(evt) {
  if (columnDraw.value || columnDrag.value || columnResize.value) {
    try { svgRef.value?.releasePointerCapture(evt.pointerId); } catch { /* 忽略 */ }
    onUp(evt);
    return;
  }
  if (d.drawing.value && drawStart.value) {
    try { svgRef.value?.releasePointerCapture(evt.pointerId); } catch { /* 忽略 */ }
    commitWall(evt);
    return;
  }
  if (routePress.value || routeDrag.value) {
    try { svgRef.value?.releasePointerCapture(evt.pointerId); } catch { /* 忽略 */ }
    if (routePress.value) commitRoutePress(evt);
    if (routeDrag.value) finishRouteDrag(evt);
  }
}

function onUp(evt) {
  stopAutoPan();
  if (columnDraw.value && columnDraw.value.pointerId === evt.pointerId) commitColumnDraw();
  if (columnDrag.value && columnDrag.value.pointerId === evt.pointerId) {
    if (columnDrag.value.bad) d.toast('柱不能放在这个位置（见柱卡/非法原因）');
    columnDrag.value = null;
  }
  if (columnResize.value && columnResize.value.pointerId === evt.pointerId) {
    if (columnResize.value.bad) d.toast('柱尺寸不合法：请保持在 0.20–3.00 m 且不要压设备/洞口');
    columnResize.value = null;
  }
  if (routePress.value) commitRoutePress(evt);
  if (routeDrag.value) finishRouteDrag(evt);
  if (roomRect.value) {
    const r = roomRect.value;
    roomRect.value = null;
    // 太小的矩形不当成一次"画房间"（手指抖一下不该在图上加四面墙）
    if (Math.abs(r.x1 - r.x0) < cfg.room.minW || Math.abs(r.z1 - r.z0) < cfg.room.minD) {
      d.toast(`这块太小了：房间至少 ${cfg.room.minW} × ${cfg.room.minD} m`);
    } else {
      d.addRoomRect({ x0: Math.min(r.x0, r.x1), z0: Math.min(r.z0, r.z1), x1: Math.max(r.x0, r.x1), z1: Math.max(r.z0, r.z1) });
    }
  }
  if (splitSeg.value) {
    const seg = splitSeg.value;
    splitSeg.value = null;
    d.splitRoom(seg);
  }
  if (d.openingMode.value && openingStart.value) {
    const start = openingStart.value;
    const hoverNow = openingHover.value;
    openingStart.value = null;
    const end = hoverNow && hoverNow.wallIndex === start.wallIndex ? hoverNow.s : start.s;
    // 拖够 0.25 m 才算「按这一段定宽」，否则就是「点一下放一个默认尺寸的洞口」
    const kind = start.kind === 'window' ? 'window' : 'door';
    d.addOpening(start.wallIndex, Math.abs(end - start.s) > 0.25
      ? { span: [start.s, end], kind }
      : { at: start.s, kind });
  }
  if (drawStart.value) commitWall(evt);
  openingDrag.value = null;
  drag.value = null;
  rotate.value = null;
  pan.value = null;
  try { svgRef.value.releasePointerCapture(evt.pointerId); } catch { /* 忽略 */ }
}

function onKey(evt) {
  // 画墙模式：Esc 退出。模式一开，光标变十字、提示行也换掉 —— 不能让用户"只能再点一次按钮"才出得来。
  // （这条放在最前面：下面的分支要先有选中设备才继续，Esc 不该依赖选中。）
  if (evt.key === 'Escape' && d.columnMode.value) {
    evt.preventDefault();
    d.setColumnMode(false);
    d.toast('已退出画柱模式');
    return;
  }
  if (evt.key === 'Escape' && d.drawing.value) {
    evt.preventDefault();
    d.drawing.value = false;
    drawStart.value = null;
    stopAutoPan();
    d.toast('已退出画墙模式');
    return;
  }
  if (evt.key === 'Escape' && d.openingMode.value) {
    evt.preventDefault();
    d.setOpeningMode(false);
    openingStart.value = null;
    openingHover.value = null;
    d.toast(d.openingMode.value === 'window' ? '已退出放窗模式' : '已退出放门模式');
    return;
  }
  if (evt.key === 'Escape' && d.roomMode.value) {
    evt.preventDefault();
    d.setRoomMode(d.roomMode.value);          // 再点一次同一个按钮 = 关掉
    roomRect.value = null;
    splitSeg.value = null;
    stopAutoPan();
    d.toast('已退出房间模式');
    return;
  }
  // 动线模式：Esc 逐层退出（草稿 → 选中 → 模式）；Enter 完成；Backspace 退站；Delete 删站/线
  if (d.routeMode.value) {
    if (evt.key === 'Escape') {
      evt.preventDefault();
      routePress.value = null;
      routeDrag.value = null;
      stopAutoPan();
      if (routeDraft.value) {
        routeDraft.value = null;
        d.toast('已取消当前动线草稿；点位没有写入方案');
      } else if (routeAppend.value) {
        routeAppend.value = null;
        d.toast('已取消加途经点');
      } else if (d.routeSelectedId.value) {
        d.clearRouteSelection();
        d.toast('已取消选中动线');
      } else {
        d.setRouteMode(false);
        d.toast('已退出动线模式');
      }
      return;
    }
    if (evt.key === 'Enter') {
      evt.preventDefault();
      if (routeDraft.value) finishRouteDraft();
      else if (routeAppend.value) cancelRouteAppend();
      return;
    }
    if (evt.key === 'Backspace') {
      evt.preventDefault();
      if (routeDraft.value && routeDraft.value.points.length) {
        const points = routeDraft.value.points.slice(0, -1);
        routeDraft.value = points.length ? { points } : null;
        if (!points.length) d.toast('已退回起点；再点地面重新开始');
      } else {
        const sel = d.routeSelectedPoint.value;
        if (sel) d.removeRoutePoint(sel.routeId, sel.index);
      }
      return;
    }
    if (evt.key === 'Delete') {
      evt.preventDefault();
      const sel = d.routeSelectedPoint.value;
      if (sel) d.removeRoutePoint(sel.routeId, sel.index);
      else if (d.routeSelectedId.value) d.removeRoute(d.routeSelectedId.value);
      return;
    }
    const step = cfg.space.snapM;
    const routeMap = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    const sel = d.routeSelectedPoint.value;
    if (sel && routeMap[evt.key]) {
      evt.preventDefault();
      const route = d.routeById(sel.routeId);
      if (route) {
        const p = route.points[sel.index];
        const next = route.points.map((q, i) => (i === sel.index ? [p[0] + routeMap[evt.key][0], p[1] + routeMap[evt.key][1]] : q));
        d.beginEdit({ throttleMs: 600 });       // 连按方向键只算一步
        d.setRoutePoints(sel.routeId, next, { silent: true });
      }
      return;
    }
  }
  // `C` = 画柱工具（与工具条同一个开关；不依赖选中）
  if (evt.key === 'c' || evt.key === 'C') {
    evt.preventDefault();
    toggleColumn();
    return;
  }
  // `L` = 动线工具（与工具条同一个开关；不依赖选中）
  if (evt.key === 'l' || evt.key === 'L') {
    evt.preventDefault();
    toggleRoute();
    return;
  }
  // 缩略图显隐（硬要求③：**1 步** —— 工具条按钮或 T；藏进二级菜单就是 2 步，判据会判红）
  if (evt.key === 't' || evt.key === 'T') {
    evt.preventDefault();
    const on = d.toggleRoomThumbs();
    d.toast(on ? '已显示房间缩略图' : '已隐藏房间缩略图');
    return;
  }
  // 缩放快捷键：不依赖选中，所以必须放在"有没有选中设备"那道门之前
  if (evt.key === '+' || evt.key === '=') { evt.preventDefault(); zoomBy(1.25); return; }
  if (evt.key === '-' || evt.key === '_') { evt.preventDefault(); zoomBy(1 / 1.25); return; }
  if (evt.key === '0') { evt.preventDefault(); fit(); return; }
  // 选中的门洞：Delete 删除，左右方向键沿墙平移（键盘也能全操作 —— 与设备那套一致）
  if (d.selectedOpeningInfo.value) {
    if (evt.key === 'Delete' || evt.key === 'Backspace') { evt.preventDefault(); d.removeOpening(); return; }
    const step = cfg.space.snapM;
    if (evt.key === 'ArrowLeft' || evt.key === 'ArrowRight') {
      evt.preventDefault();
      const cur = d.selectedOpeningInfo.value.opening;
      d.updateOpening({ at: cur.at + (evt.key === 'ArrowRight' ? step : -step) });
      return;
    }
  }
  // 选中的柱：Delete 删、Ctrl/Cmd+D 复制、方向键平移 0.1 m、Shift+方向键改宽深（一次撤销）
  if (d.selectedColumnInfo.value) {
    const cur = d.selectedColumnInfo.value;
    if (evt.key === 'Delete' || evt.key === 'Backspace') {
      evt.preventDefault();
      d.removeColumn(cur.id);
      return;
    }
    if ((evt.ctrlKey || evt.metaKey) && (evt.key === 'd' || evt.key === 'D')) {
      evt.preventDefault();
      d.copyColumn(cur.id);
      return;
    }
    const map = { ArrowLeft: [-0.1, 0], ArrowRight: [0.1, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] };
    if (map[evt.key]) {
      evt.preventDefault();
      d.beginEdit({ throttleMs: 600 }); // 连按只记一步
      if (evt.shiftKey) {
        const [dw, dd] = map[evt.key];
        d.updateColumn(cur.id, { w: evt.key === 'ArrowLeft' || evt.key === 'ArrowRight' ? cur.w + dw : cur.w,
          d: evt.key === 'ArrowUp' || evt.key === 'ArrowDown' ? cur.d + dd : cur.d }, { silent: true });
      } else {
        d.updateColumn(cur.id, { x: cur.cx + map[evt.key][0], z: cur.cz + map[evt.key][1] }, { silent: true });
      }
      return;
    }
  }
  const item = d.selected.value;
  if (!item) return;
  const step = cfg.space.snapM;
  const map = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
  if (map[evt.key]) {
    evt.preventDefault();
    d.beginEdit({ throttleMs: 600 }); // 连按只记一次
    d.setPosition(item.id, item.x + map[evt.key][0], item.z + map[evt.key][1]);
    return;
  }
  if (evt.key === 'q' || evt.key === 'Q') { evt.preventDefault(); d.rotateBy(item.id, -cfg.space.rotateStepDeg); }
  if (evt.key === 'e' || evt.key === 'E') { evt.preventDefault(); d.rotateBy(item.id, cfg.space.rotateStepDeg); }
  if (evt.key === 'Delete' || evt.key === 'Backspace') { evt.preventDefault(); d.remove(item.id); }
}

// ── 视口操作：适配 / 缩放 / 平移 / 聚焦 ─────────────────────────────────────

/** 适配：整间房装进画布（也就是缩放下限）。房间是"纸"，纸变了就重铺 */
function fit() {
  view.value = fitView({ room: layout.value, size: size.value });
}

/** 以视口正中为锚点缩放（按钮和键盘用）。滚轮不走这里 —— 它的锚点是指针 */
function zoomBy(factor) {
  view.value = zoomAt({ view: view.value, size: size.value, fx: 0.5, fz: 0.5, factor, min: zoomMin.value });
}

function onWheel(evt) {
  if (!size.value.w) return;
  evt.preventDefault();
  // deltaMode：0=像素、1=行、2=页。Firefox 给的是"行"，不换算的话滚一格跳一大截
  const unit = evt.deltaMode === 1 ? 16 : evt.deltaMode === 2 ? size.value.d : 1;
  const rect = svgRef.value.getBoundingClientRect();
  view.value = zoomAt({
    view: view.value,
    size: size.value,
    fx: (evt.clientX - rect.left) / rect.width,
    fz: (evt.clientY - rect.top) / rect.height,
    factor: Math.exp(-evt.deltaY * unit * 0.0015),
    min: zoomMin.value,
  });
}

/**
 * 双击设备：以它为中心放大到"主角"大小。
 * 双击空白**不动** —— 猜用户想回适配，猜错就是"图突然自己跳了"。
 */
function onDblClick(evt) {
  // 双击房间 = 相机聚焦到它（硬要求：相机聚焦 **1 步**）
  const roomEl = evt.target.closest?.('[data-room-id]');
  if (roomEl) {
    const id = roomEl.dataset.roomId;
    d.selectRoom(id);
    d.focusRoom(id);
    return;
  }
  const el = evt.target.closest?.('[data-item-id]');
  const id = el?.dataset?.itemId ? Number(el.dataset.itemId) : null;
  if (id === null) return;
  const item = layout.value.items.find((i) => i.id === id);
  const p = item ? getProduct(item.p) : null;
  if (!item || !p) return;
  d.selectItem(id);
  view.value = centerOn({
    view: view.value,
    cx: item.x,
    cz: item.z,
    zoom: Math.max(focusZoom({ rect: { w: p.w, d: p.d }, size: size.value }), zoomMin.value),
  });
  d.toast(`已聚焦 #${id} ${p.name}（滚轮缩放 · 右键拖动平移）`);
}

let ro = null;
function onWinKey(evt) {
  // 空格 + 左键拖动 = 平移（CAD 习惯）。在输入框里打字时不算 ——
  // 否则用户在房间尺寸里按空格，画布会莫名其妙进入平移预备态。
  if (evt.code !== 'Space' && evt.key !== ' ') return;
  const tag = evt.target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  spaceDown.value = evt.type === 'keydown';
}

function onWindowPointerOut(evt) {
  if (!evt.relatedTarget) stopAutoPan();
}

onMounted(() => {
  const el = svgRef.value;
  const measure = () => {
    const r = el.getBoundingClientRect();
    if (r.width !== size.value.w || r.height !== size.value.d) size.value = { w: r.width, d: r.height };
  };
  measure();
  fit();
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(measure);
    ro.observe(el);
  }
  window.addEventListener('keydown', onWinKey);
  window.addEventListener('keyup', onWinKey);
  // 画墙兜底只在 drawing 且有起点时提交；svg 自己收到 onUp 时 drawStart 已清空，不会双提交。
  window.addEventListener('pointerup', onWindowPointerUp);
  // 指针离开浏览器窗口 / 窗口失焦时停掉自动平移：否则最后一帧的坐标会被一直推下去。
  window.addEventListener('pointerout', onWindowPointerOut);
  window.addEventListener('blur', stopAutoPan);
  // 动线卡 Teleport 到右栏：PlanView 先挂、Inspector 后挂，必须等这一轮 DOM 落定再解析目标
  nextTick(() => { railReady.value = !!document.getElementById('rail-right'); });
});
onBeforeUnmount(() => {
  stopAutoPan();
  ro?.disconnect();
  window.removeEventListener('keydown', onWinKey);
  window.removeEventListener('keyup', onWinKey);
  window.removeEventListener('pointerup', onWindowPointerUp);
  window.removeEventListener('pointerout', onWindowPointerOut);
  window.removeEventListener('blur', stopAutoPan);
});

// 房间尺寸变了才重新适配。**watch 的是尺寸、不是整个 layout** ——
// 摆一台设备也会让 layout 变，那种变化绝不能动视口（否则用户刚对准的视野会被抢走）。
watch(() => [layout.value.w, layout.value.d], () => { if (size.value.w) fit(); });

// 画墙模式被关掉（切工具 / 重置 / Esc）时，本地拖动起点必须一起清：
// 否则下一次进画墙模式会拿旧起点画，甚至窗口级 pointerup 会提交一个早已作废的起点。
watch(() => d.drawing.value, (on) => {
  if (on) return;
  drawStart.value = null;
  shiftNow.value = false;
  stopAutoPan();
});

// 动线模式被工具条/Esc/重置关掉：草稿与拖拽状态一起清，否则下一次进来会带着旧点
watch(() => d.routeMode.value, (on) => {
  if (on) return;
  routeDraft.value = null;
  routePress.value = null;
  routeDrag.value = null;
  routeAppend.value = null;
  stopAutoPan();
});

/**
 * 相机聚焦请求（2D 那一半）：聚焦某一间 → 以它的包围盒铺满画布；聚焦整栋 → 回适配。
 * 与 3D 各管各的（两边各有自己的数学），但听的是**同一个请求**（`d.focusWish`）——
 * 于是"点一下聚焦"在两种视图下说的是同一件事。
 */
watch(() => d.focusWish.value, (wish) => {
  if (!wish || !size.value.w) return;
  if (wish.kind === 'building') { fit(); return; }
  if (wish.kind === 'item') {
    const item = layout.value.items.find((i) => i.id === wish.id);
    const p = item ? getProduct(item.p) : null;
    if (!item || !p) return;
    view.value = centerOn({
      view: view.value,
      cx: item.x,
      cz: item.z,
      zoom: Math.max(focusZoom({ rect: { w: p.w, d: p.d }, size: size.value }), zoomMin.value),
    });
    return;
  }
  const room = d.roomById.value.get(wish.id);
  if (!room) return;
  const xs = room.poly.map((p) => p[0]);
  const zs = room.poly.map((p) => p[1]);
  const box = { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...zs) - Math.min(...zs) };
  view.value = centerOn({
    view: view.value,
    cx: room.centroid[0],
    cz: room.centroid[1],
    zoom: Math.max(focusZoom({ rect: box, size: size.value }), zoomMin.value),
  });
});

function toggleDraw() {
  if (!d.drawing.value) { d.setRouteMode(false); d.setColumnMode(false); }
  d.drawing.value = !d.drawing.value;
  drawStart.value = null;
  d.clearSelection();
  if (d.drawing.value) d.toast('画墙模式：拖一笔就成墙；场内是内墙，贴场景边缘或从场外起笔是外墙（Shift 自由角度）');
}
</script>

<template>
  <div
    class="plan-wrap"
    :class="{ 'is-drawing': d.drawing.value, 'is-opening': d.openingMode.value, 'is-panning': !!pan, 'is-room': d.roomMode.value === 'room', 'is-split': d.roomMode.value === 'split', 'is-route': d.routeMode.value, 'is-column': d.columnMode.value }"
    :data-column-mode="d.columnMode.value ? 'on' : 'off'"
    :style="{ '--wall-2d-op': wall2dOpacity }"
    @selectstart.prevent
  >
    <!-- 画布上方工具条（docs/84 §五；docs/97 加第六个「动线」）：互斥的模式按钮。
         按钮的**可见文案恒定**，激活只换前缀图标（未激活「＋」/激活「✓」）与底色 ——
         不再把文案换成「结束…」，否则激活前后按钮宽度不同，整排按钮会被推着走。
         前五个 `data-tool` 原样保留（探针按它取元素）；动线是 `route`，快捷键 L。 -->
    <div class="plan-tools">
      <button
        class="btn tool"
        :class="{ 'btn--primary': d.drawing.value }"
        data-tool="wall"
        :aria-pressed="d.drawing.value"
        :title="d.drawing.value ? '画墙中 · 再点一次结束（Esc）' : '画墙：在平面图上拖一笔；场外起笔会自动扩场景'"
        @click="toggleDraw"
      ><span class="tool__icon" aria-hidden="true">{{ d.drawing.value ? '✓' : '＋' }}</span>画墙</button>
      <!-- 放门（W1）/ 放窗（W2）：与画墙互斥 —— 这几个模式的手指动作都是「在画布上点/拖」，
           同时开着就只能有一个说话。两个按钮共用同一个三态开关（点另一个 = 直接换过去） -->
      <button
        class="btn tool"
        :class="{ 'btn--primary': d.openingMode.value === 'door' }"
        data-tool="opening"
        :aria-pressed="d.openingMode.value === 'door'"
        :title="d.openingMode.value === 'door' ? '放门中 · 再点一次结束（Esc）' : '放门：在墙上点一下放一扇门'"
        @click="toggleOpening('door')"
      ><span class="tool__icon" aria-hidden="true">{{ d.openingMode.value === 'door' ? '✓' : '＋' }}</span>放门</button>
      <button
        class="btn tool"
        :class="{ 'btn--primary': d.openingMode.value === 'window' }"
        data-tool="window"
        :aria-pressed="d.openingMode.value === 'window'"
        :title="d.openingMode.value === 'window' ? '放窗中 · 再点一次结束（Esc）' : '放窗：在墙上点一下放一扇窗'"
        @click="toggleOpening('window')"
      ><span class="tool__icon" aria-hidden="true">{{ d.openingMode.value === 'window' ? '✓' : '＋' }}</span>放窗</button>
      <!-- 画房间（M1）：与画墙/放门互斥。硬要求②：建第二间 = 点这里 + 拖一个矩形 = **2 步** -->
      <button
        class="btn tool"
        :class="{ 'btn--primary': d.roomMode.value === 'room' }"
        data-tool="room"
        :aria-pressed="d.roomMode.value === 'room'"
        :title="d.roomMode.value === 'room' ? '画房间中 · 再点一次结束（Esc）' : '画房间：在画布上拖一个矩形'"
        @click="d.setRoomMode('room')"
      ><span class="tool__icon" aria-hidden="true">{{ d.roomMode.value === 'room' ? '✓' : '＋' }}</span>画房间</button>
      <!-- 切分（M1）：点这里 + 拖一条线 = **2 步**；两端会自动接到墙上 -->
      <button
        class="btn tool"
        :class="{ 'btn--primary': d.roomMode.value === 'split' }"
        data-tool="split"
        :aria-pressed="d.roomMode.value === 'split'"
        :title="d.roomMode.value === 'split' ? '切分中 · 再点一次结束（Esc）' : '切分房间：在房间里拖一条线'"
        @click="d.setRoomMode('split')"
      ><span class="tool__icon" aria-hidden="true">{{ d.roomMode.value === 'split' ? '✓' : '＋' }}</span>切分房间</button>
      <!-- 动线（W4/P2）：点 A/B 后自动寻路；只存用户点，折线/长度/状态全部派生。
           文案压成「动线」二字，1280 下六按钮仍单行（docs/94 §5.7 的实测纪律）。 -->
      <button
        class="btn tool"
        :class="{ 'btn--primary': d.routeMode.value }"
        data-tool="route"
        :aria-pressed="d.routeMode.value"
        :title="d.routeMode.value ? '动线模式中 · 再点一次结束（Esc）' : '动线：点地面依次点 A、B…，自动避开墙体和设备'"
        @click="toggleRoute"
      ><span class="tool__icon" aria-hidden="true">{{ d.routeMode.value ? '✓' : '＋' }}</span>动线</button>
      <!-- 柱（P2 2D）：独立结构对象；点空白放 0.5×0.5，柱与墙可重叠 -->
      <button
        class="btn tool"
        :class="{ 'btn--primary': d.columnMode.value }"
        data-tool="column"
        :aria-pressed="d.columnMode.value"
        :title="d.columnMode.value ? '画柱中 · 再点一次结束（Esc）' : '画柱：在空白处点一下放 0.5 × 0.5 m 柱'"
        @click="toggleColumn"
      ><span class="tool__icon" aria-hidden="true">{{ d.columnMode.value ? '✓' : '＋' }}</span>画柱</button>
    </div>

    <!-- 开放面积读数：只读派生量（房间/开放不进 state）；点它把右栏滚到房间卡 -->
    <button
      v-if="d.openArea.value > 1e-9"
      type="button"
      class="scene-chip"
      data-scene-chip="open-area"
      title="开放场景面积（不可命名）；房间面积 + 开放面积 = 场景范围"
      @click="d.toast(`开放场景 ${fmtArea(d.openArea.value)}；画一圈闭合的墙就能围成房间`)"
    >开放 {{ fmtArea(d.openArea.value) }} m²</button>

    <!-- 动线图例（docs/97 四通道：颜色/线型/编号/名称）：画布左上角一条，右栏卡片里有完整行。
         显隐是观看态（不进 state）：隐藏的动线在图例里仍然点得到，只是 2D 不画。 -->
    <div v-if="d.routeRows.value.length" class="flow-legend" data-flow-legend data-scene-chip="routes" aria-label="动线图例">
      <span class="flow-legend__title">动线</span>
      <button
        v-for="row in d.routeRows.value"
        :key="`leg${row.id}`"
        type="button"
        class="flow-legend__item"
        :class="{ 'is-hidden': !row.visible, 'is-blocked': row.status === 'blocked' }"
        :style="{ '--route-color': `var(--route-${row.colorIndex})` }"
        :data-route-id="row.id"
        :data-route-status="row.status"
        :data-route-visible="row.visible ? '1' : '0'"
        :title="`${row.displayName}：${routeStatusText(row)}`"
        @click="d.selectRoute(row.id)"
      >
        <i class="flow-legend__swatch" aria-hidden="true"></i>
        <span>{{ row.number }}</span>
      </button>
    </div>

    <!-- 这一块是一个**键盘可以全操作的编辑器**（方向键移动、Q/E 旋转、Delete 删除、±/0 缩放），
         所以 role=application 而不是 role=img：role=img 会把里面的按键全吃掉。
         `aria-describedby` 指向画布下方视图栏里的模式提示（`id="plan-keys"`）——
         提示只有一条、随模式换文案，读屏念到的永远是当前那一条。 -->
    <svg
      ref="svgRef"
      class="plan"
      role="application"
      aria-label="平面图编辑器"
      aria-describedby="plan-keys"
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
      tabindex="0"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @keydown="onKey"
      @wheel="onWheel"
      @dblclick="onDblClick"
      @contextmenu.prevent
    >
      <defs>
        <!-- 外墙 45° 斜纹：pattern 的坐标在 world 组里，单位是米（0.6 m 一道，墙厚 0.12 m） -->
        <pattern id="wall-ext-hatch" patternUnits="userSpaceOnUse" width="0.6" height="0.6">
          <path d="M0 0 L0.6 0.6" fill="none" />
        </pattern>
      </defs>
      <!-- 世界坐标层：几何一律用米，由这一层 transform 换算成像素。
           外面（viewBox / CSS）全是像素 → stroke-width、font-size、dasharray 都是真像素。
           内联属性里那些米（门铰链点 r=0.045、画墙预览线 stroke-width=0.06）在这里是正确的米。 -->
      <g class="world" :transform="`scale(${PX_PER_M})`">
      <!-- 地面与网格 -->
      <rect class="floor" :x="0" :y="0" :width="layout.w" :height="layout.d" />
      <path class="grid-line" :d="gridPath.minor" fill="none" />
      <path class="grid-line grid-line--major" :d="gridPath.major" fill="none" />

      <!-- 房间层（M1，**派生**）：画在墙下面，只是底色与分区。
           ⭐ 房间数 >1，或「1 间房 + 开放面积」才渲染 —— 1 间房且全封闭时它就是整块地面，
              铺底色没有信息量；但一旦有开放区，那间房必须画出来，否则分不清房间与开放。
              开放区域没有房间面，自然不会铺房间底色。 -->
      <g v-if="d.showRoomLayer.value" class="rooms">
        <path
          v-for="r in d.scene.value.rooms"
          :key="`r${r.id}`"
          class="room"
          :class="{ 'is-selected': d.selectedRoom.value === r.id, 'is-sliver': r.sliver }"
          :d="r.d"
          :data-room-id="r.id"
          :aria-label="`房间 ${r.displayName}，${r.area.toFixed(2)} 平方米`"
        />
      </g>

      <!-- 接头补角：三根以上墙在一个点收头时，斜接铺不满的那几块多边形。
           画在墙体**下面**：选中/悬停把墙涂成品牌色时不露出一块灰的。 -->
      <path v-if="d.scene.value.fills.d" class="wall-fill" :d="d.scene.value.fills.d" />

      <!-- 动线线身（W4/P2）：**画在墙下面** —— 穿过门洞时能看见线，墙本身仍然压住线。
           颜色/线型/编号/名称是四条通道：颜色来自 --route-N，线型按同一序号；名称/编号在右栏与图例。
           这里只渲染派生结果（r.d 来自 P1 planRoute 的 legs），不在这里寻路。 -->
      <g v-if="visibleRoutes.length" class="route-lines">
        <template v-for="r in visibleRoutes" :key="`rl${r.id}`">
          <path
            class="route-line"
            :class="[`route-pattern-${r.colorIndex}`, `route-line--${r.status}`, { 'is-selected': d.routeSelectedId.value === r.id }]"
            :style="{ '--route-color': `var(--route-${r.colorIndex})` }"
            :d="r.d"
            :data-route-id="r.id"
            :data-route-status="r.status"
            :data-route-invalid-reason="r.status === 'blocked' ? (r.message || r.reason || 'blocked') : undefined"
          />
          <!-- 命中带：线身只有 2.5px，透明描边撑到 0.34 m；透明不遮挡墙体本身 -->
          <path
            class="route-hit"
            :style="{ '--route-color': `var(--route-${r.colorIndex})` }"
            :d="r.d"
            :data-route-hit="r.id"
            :data-route-id="r.id"
            :data-route-status="r.status"
          />
        </template>
      </g>

      <!-- 墙体：按持久化 role 分外墙/内墙（旧墙由 scene2d 走内核几何回退）。
           外墙另铺 45° 斜纹 + 两端 T 端头；内墙保持实心。视觉差异不取代文字/列表里的类型。 -->
      <path
        v-for="w in d.scene.value.walls"
        :key="`w${w.index}`"
        :class="['wall', w.role === 'exterior' ? 'wall-ext' : 'wall-int', { 'is-selected': d.selectedWall.value === w.index }]"
        :d="w.d"
        :data-wall-index="w.index"
        :data-wall-role="w.role"
      />
      <template v-for="w in d.scene.value.walls" :key="`ext${w.index}`">
        <path
          v-if="w.role === 'exterior'"
          class="wall-ext-hatch"
          :class="{ 'is-selected': d.selectedWall.value === w.index }"
          :d="w.d"
          aria-hidden="true"
        />
        <path
          v-if="w.role === 'exterior'"
          class="wall-ext-cap"
          :class="{ 'is-selected': d.selectedWall.value === w.index }"
          :d="w.caps"
          aria-hidden="true"
        />
      </template>

      <!-- 短墙命中带：**所有墙**（含外墙）都可以选中；可见墙身只有 12cm，0.1m 的墙几乎点不中。
           透明描边（0.44m）把可点范围撑开。层级在墙之后、房间名/设备/门洞之前：
           设备与洞口仍然优先命中。 -->
      <path
        v-for="w in d.scene.value.walls"
        :key="`wh${w.index}`"
        class="wall-hit"
        :d="w.d"
        :data-wall-index="w.index"
      />

      <!-- 房间名（M1）：画在墙**上面**（不然被墙压住）、设备**下面**（设备才是主角）。
           没命名且只有一间房时不写字（默认名铺在整块地面上只是噪声）。 -->
      <g v-if="d.roomCount.value > 1 || d.waitingNames.value.length" class="room-labels">
        <text
          v-for="r in d.scene.value.rooms"
          :key="`rn${r.id}`"
          class="room-name"
          :class="{ 'is-selected': d.selectedRoom.value === r.id }"
          :x="r.at[0]"
          :y="r.at[1]"
          text-anchor="middle"
          :data-room-name="r.id"
        >{{ r.displayName }}<tspan v-if="d.roomCount.value > 1" class="room-area"> · {{ r.area.toFixed(1) }}㎡</tspan></text>
      </g>

      <!-- 画房 / 切分预览（与落笔共用内核那一条） -->
      <g v-if="previewRoom" class="room-preview" :class="{ 'is-bad': previewRoom.tooMany }">
        <path v-for="(seg, i) in previewRoom.walls" :key="`rp${i}`" class="preview-wall" :d="`M${seg[0][0]} ${seg[0][1]} L${seg[1][0]} ${seg[1][1]}`" />
      </g>
      <g v-if="previewSplit" class="split-preview" :class="{ 'is-bad': !previewSplit.ok }">
        <path class="preview-wall" :d="`M${previewSplit.line[0][0]} ${previewSplit.line[0][1]} L${previewSplit.line[1][0]} ${previewSplit.line[1][1]}`" />
      </g>

      <!-- 门洞（W1）：画在墙体**上面** —— 缺口是墙自己断开的（`blocks` 已经把洞挖掉了），
           这里补的是门框两条短线、净宽读数与命中区。命中区做成透明多边形：
           洞口那里是地板色，没有可点的东西，不铺一块透明命中区就只能"点门框那两根线"才选得中。 -->
      <g class="openings">
        <template v-for="w in d.scene.value.walls" :key="`ow${w.index}`">
          <template v-for="o in w.openings" :key="`o${w.index}_${o.index}`">
            <polygon
              class="opening-hit"
              :class="{ 'is-selected': d.selectedOpening.value && d.selectedOpening.value.wallIndex === w.index && d.selectedOpening.value.index === o.index, 'is-window': o.kind === 'window' }"
              :points="o.hit.map((q) => q.join(' ')).join(' ')"
              :data-opening="`${w.index}:${o.index}`"
              role="img"
              :aria-label="`${o.text}（墙 ${w.index}）`"
            />
            <path class="opening-jamb" :class="{ 'is-window': o.kind === 'window' }" :d="o.path" :data-opening="`${w.index}:${o.index}`" />
            <!-- 窗线（三线符号的第三线）：**只有窗有**（门是 null）。窗不断墙身，平面图就靠这三条线认它 -->
            <path v-if="o.sashPath" class="opening-sash" :d="o.sashPath" :data-opening="`${w.index}:${o.index}`" />
            <text class="opening-width" :class="{ 'is-window': o.kind === 'window' }" :x="o.mid[0]" :y="o.mid[1]" text-anchor="middle" :data-opening="`${w.index}:${o.index}`">{{ o.short }}</text>
          </template>
        </template>
      </g>

      <!-- 柱（P2 2D）：独立层，画在墙/洞口之上、设备之下；不塞 walls2d。
           第一片只做点放 0.5×0.5 与选中/非法描边，拖两角/8 向/柱卡在下一片。 -->
      <g class="columns" aria-label="矩形柱">
        <path
          v-for="col in d.scene.value.columns"
          :key="`c${col.id}`"
          class="column-body"
          :class="{ 'is-selected': col.selected, 'is-invalid': !!col.invalid }"
          :d="col.dPath"
          :data-column-id="col.id"
          :data-column-status="col.invalid ? 'invalid' : 'ok'"
          :data-column-w="col.w"
          :data-column-d="col.d"
          :data-column-x="col.x"
          :data-column-z="col.z"
          :data-column-area="col.area.toFixed(2)"
          :data-column-invalid-reason="col.invalid?.reason"
          :data-column-opening-kind="col.invalid?.openingKind"
          :fill="col.invalid ? 'var(--bad-soft)' : 'var(--wall-2d)'"
          :fill-opacity="col.selected ? 1 : 'var(--wall-2d-op)'"
          :stroke="col.invalid ? 'var(--bad)' : (col.selected ? 'var(--brand)' : 'var(--panel)')"
          :stroke-width="col.selected ? 0.035 : 0.018"
          :stroke-dasharray="col.invalid ? '0.08 0.05' : undefined"
          role="img"
          :aria-label="`柱 #${col.id}，${col.w.toFixed(2)} × ${col.d.toFixed(2)} 米，全高`"
        >
          <title>{{ `柱 #${col.id} · ${col.w.toFixed(2)} × ${col.d.toFixed(2)} m · 全高` }}</title>
        </path>
      </g>

      <!-- 设备 -->
      <g
        v-for="it in d.scene.value.items"
        :key="`i${it.id}`"
        :class="['item', `lv-${d.clearanceById.value.get(it.id)?.level ?? 'na'}`, { 'is-selected': d.selectedId.value === it.id }]"
        :data-item-id="it.id"
        :data-item-selected="d.selectedId.value === it.id ? 'true' : 'false'"
        :data-item-issue="issueById.has(it.id) ? 'true' : 'false'"
        :data-item-clearance="itemClearance(it)?.level ?? 'na'"
        role="img"
        :aria-label="itemAria(it)"
      >
        <title>{{ itemAria(it) }}</title>
        <!-- 选中第二通道：品牌色外圈 + 虚线，不只靠颜色/加粗 -->
        <path v-if="d.selectedId.value === it.id" class="item-select-ring" :d="it.d" />
        <path class="item-body" :d="it.d" />
        <!-- 前脸（门所在的一侧）：同属中性色，但更深更粗，只做方向提示 -->
        <path class="item-front" :d="`M${it.front}`" fill="none" />
        <!-- 开门：几何来自实测（doors.measured.js）。铰链位置与扇半径都是量出来的，
             不是"前脸左端 + 柜宽"的估算；实测缺席的型号退回估算路径，形状一样、成色不同。
             上盖（绕水平轴）只给铰链线 —— 它的扫掠半径是竖直方向的，在平面上当半径用就是错的。 -->
        <path v-for="(lr, i) in it.door.leafRects" :key="`lr${i}`" class="door-leaf" :d="lr" />
        <line
          v-for="(l, i) in it.door.lidLines" :key="`hl${i}`" class="door-hinge"
          :x1="l[0][0]" :y1="l[0][1]" :x2="l[1][0]" :y2="l[1][1]"
        />
        <line
          v-for="(l, i) in it.door.closedLines" :key="`cl${i}`" class="door-closed"
          :x1="l[0][0]" :y1="l[0][1]" :x2="l[1][0]" :y2="l[1][1]"
        />
        <template v-for="(s, i) in it.door.sectors" :key="`sec${i}`">
          <path v-if="s.arc" class="door-arc" :d="s.arc" />
          <line
            v-if="s.arc" class="door-open"
            :x1="s.hinge[0]" :y1="s.hinge[1]" :x2="s.leafEnd[0]" :y2="s.leafEnd[1]"
          />
        </template>
        <circle
          v-if="it.door.hinge" class="door-hinge-dot"
          :cx="it.door.hinge[0]" :cy="it.door.hinge[1]" r="0.045"
        />
        <path v-if="issueIds.has(it.id)" class="item-bad" :d="it.d" />
        <text v-if="it.showLabel" class="item-label" :x="it.center[0]" :y="it.center[1] - 0.02">{{ it.label }}</text>
        <text class="item-id" :x="it.center[0]" :y="it.center[1] + 0.16">#{{ it.id }}</text>
      </g>

      <!-- 动线站点/编号（W4/P2）：画在设备**上面** —— 用户点的站是编辑对象，不能被柜体吞掉；
           自动拐点不是站点、不给手柄（docs/97：不做自动拐点拖动）。 -->
      <g
        v-for="r in visibleRoutes"
        :key="`rn${r.id}`"
        class="route-nodes"
        :class="{ 'is-selected': d.routeSelectedId.value === r.id, 'is-blocked': r.status === 'blocked' }"
        :style="{ '--route-color': `var(--route-${r.colorIndex})` }"
        :data-route-id="r.id"
        :data-route-status="r.status"
        :data-route-visible="1"
        :data-route-invalid-reason="r.status === 'blocked' ? (r.message || r.reason || 'blocked') : undefined"
      >
        <!-- 箭头画在墙和设备上面（docs/97 §5.3）：线身在墙下，箭头不能被墙压住 -->
        <path
          v-for="(a, ai) in r.arrows"
          :key="`ra${r.id}_${ai}`"
          class="route-arrow"
          :d="ROUTE_ARROW_D"
          :transform="`translate(${a.x} ${a.z}) rotate(${a.angle})`"
          aria-hidden="true"
        />
        <g
          v-for="stop in r.stops"
          :key="`rs${r.id}_${stop.index}`"
          class="route-stop"
          :class="{ 'is-selected': d.routeSelectedPoint.value && d.routeSelectedPoint.value.routeId === r.id && d.routeSelectedPoint.value.index === stop.index }"
          :data-route-handle="`${r.id}:${stop.index}`"
          :data-route-point="`${r.id}:${stop.index}`"
          :data-route-stop="`${r.id}:${stop.index}`"
        >
          <circle class="route-stop__hit" :cx="stop.x" :cy="stop.z" r="0.36" />
          <circle class="route-stop__dot" :cx="stop.x" :cy="stop.z" r="0.105" />
          <text class="route-stop__label" :x="stop.x + 0.14" :y="stop.z - 0.13">{{ stop.label }}</text>
        </g>
        <text
          v-if="r.status === 'blocked'"
          class="route-reason"
          :x="r.stops[0]?.x ?? 0"
          :y="(r.stops[0]?.z ?? 0) - 0.36"
        >{{ routeReasonShort(r) }}</text>
      </g>

      <!-- 动线草稿预览（W4/P2）：与落笔共用 `d.planRouteDraft`；不写 state，所以不可能与提交两套几何。
           指针停在最后一点时 preview 不造重合点；失效时红虚线 + 一句原因（完整话术在右栏/ title）。 -->
      <g
        v-if="routePreview"
        class="route-preview"
        :class="routePreview.draftCount >= 2 ? `is-${routePreview.status}` : 'is-draft'"
        :style="{ '--route-color': routePreview.status === 'blocked' ? 'var(--bad)' : 'var(--brand)' }"
        data-route-preview
        :data-route-status="routePreview.draftCount >= 2 ? routePreview.status : undefined"
        :data-route-invalid-reason="routePreview.draftCount >= 2 && routePreview.status === 'blocked' ? (routePreview.message || routePreview.reason || 'blocked') : undefined"
        aria-hidden="true"
      >
        <path
          v-if="routePreview.d"
          class="route-line route-line--preview"
          :class="`route-line--${routePreview.status}`"
          :d="routePreview.d"
          :style="{ '--route-color': routePreview.status === 'blocked' ? 'var(--bad)' : 'var(--brand)' }"
        />
        <g v-for="stop in routePreview.stops" :key="`p${stop.index}`" class="route-stop is-preview">
          <circle class="route-stop__dot" :cx="stop.x" :cy="stop.z" r="0.105" />
          <text class="route-stop__label" :x="stop.x + 0.14" :y="stop.z - 0.13">{{ stop.label }}</text>
        </g>
        <text
          v-if="routePreview.draftCount >= 2 && routePreview.status === 'blocked'"
          class="route-reason"
          :x="routePreview.stops[0]?.x ?? 0"
          :y="(routePreview.stops[0]?.z ?? 0) - 0.36"
        >{{ routeReasonShort(routePreview) }}</text>
      </g>

      <!-- 柱的选中态与 8 向手柄：手柄是编辑对象，必须在设备/墙/动线之上；
           隐藏的 `pointer-events:none` 预览层在下面，绝不吞掉拖动。 -->
      <g v-if="selectedColumnRow" class="column-selected" :data-column-selected-id="selectedColumnRow.id" aria-hidden="true">
        <path class="column-selected-outline" :d="selectedColumnRow.dPath" />
        <g
          v-for="h in columnHandles"
          :key="`ch-${h.name}`"
          class="column-handle-group"
          :data-column-handle="h.name"
        >
          <rect class="column-handle-hit" :x="h.x - 0.05" :y="h.z - 0.05" width="0.1" height="0.1" rx="0.02" />
          <circle class="column-handle" :cx="h.x" :cy="h.z" r="0.085" />
        </g>
        <text
          class="column-size"
          :x="selectedColumnRow.cx"
          :y="selectedColumnRow.z0 - 0.16"
          text-anchor="middle"
        >{{ fmtLen(selectedColumnRow.w) }} × {{ fmtLen(selectedColumnRow.d) }} m</text>
        <text
          class="column-tag"
          :x="selectedColumnRow.cx"
          :y="selectedColumnRow.z0 - 0.42"
          text-anchor="middle"
        >柱 #{{ selectedColumnRow.id }} · 选中</text>
      </g>

      <!-- 画柱非法预览：保留指针实际拖出的矩形，红虚线 + 内核真实原因；不写 state、不吞指针 -->
      <g
        v-if="previewColumn"
        class="column-preview"
        :class="{ 'is-bad': !previewColumn.ok }"
        :data-column-preview="previewColumn.ok ? 'ok' : 'invalid'"
        :data-column-invalid-reason="previewColumn.ok ? undefined : previewColumn.reason"
        :data-column-opening-kind="previewColumn.openingKind"
        aria-hidden="true"
      >
        <path class="column-preview-body" :d="previewColumn.dPath" />
        <text
          v-if="!previewColumn.ok"
          class="column-preview-reason"
          :x="(previewColumn.x0 + previewColumn.x1) / 2"
          :y="previewColumn.z0 - 0.14"
          text-anchor="middle"
        >{{ previewColumn.message }}</text>
      </g>

      <!-- 选中设备的旋转手柄。
           ⭐ 位置由**内核**算（`placement.handlePoint`）—— 它和 `angleFromPointer` 是**互逆**的：
              手柄画在哪儿，抓它就等于抓"当前角度"那个方位。旧实现这里手写 `(−sin, +cos)`
              （= 内核角度的**反面**），而角度那一侧算的是 `r + 180` → 一按一拖模型瞬间翻 180°，
              也就是用户报的"手柄默认在 180° 的位置、一点就从 0 开始"。两处各写一套，谁都不报错。
           ⚠️ 这里**刻意不做**成 tab 停靠点：旋转的键盘路径在画布上（Q/E 与 Inspector 里的读数），
              再给把手一个停靠点，Tab 顺序会变成「N 台设备 × 每台一个把手」—— 那不是无障碍，是障碍。 -->
      <g v-if="handlePos" :data-rotate-id="d.selected.value.id" aria-hidden="true">
        <title>拖动旋转（键盘：Q / E 各转一步）</title>
        <circle class="handle-rotate" :cx="handlePos.x" :cy="handlePos.z" r="0.13" />
        <line
          class="dim-line"
          :x1="d.selected.value.x" :y1="d.selected.value.z"
          :x2="handlePos.x" :y2="handlePos.z"
        />
      </g>

      <!-- 画墙预览：形状与落笔后的墙**同一个来源**（带厚度），另加实时长度读数。
           `pointer-events: none`（见样式）—— 预览绝不能吞掉拖动。 -->
      <g
        v-if="previewWall"
        class="preview"
        :class="{ 'is-bad': previewWall.ok === false, 'is-overlap': previewWall.ok && previewWall.overlapM > 0 }"
        :data-preview-invalid="previewWall.ok === false ? previewWall.reason : undefined"
        aria-hidden="true"
      >
        <path
          class="preview-wall"
          :d="previewWall.ok ? previewWall.d : previewWall.line"
          :transform="previewWall.shift ? `translate(${previewWall.shift[0]} ${previewWall.shift[1]})` : undefined"
          data-wall-preview
        />
        <!-- 场景扩展 ghost：画在**当前**坐标系。左/上扩时新场景从负偏移开始，宽高取扩后的 to。 -->
        <rect
          v-if="previewWall.expanded"
          class="preview-ghost"
          data-site-ghost
          :x="previewWall.expanded.dx"
          :y="previewWall.expanded.dz"
          :width="previewWall.expanded.to[0]"
          :height="previewWall.expanded.to[1]"
        />
        <text class="preview-len" :x="previewWall.mid[0]" :y="previewWall.mid[1] - 0.18" text-anchor="middle">
          {{ fmtLen(previewWall.len) }} m
        </text>
        <text
          v-if="previewWall.ok"
          class="preview-role"
          data-preview-role
          :class="{ 'is-ext': previewWall.role === 'exterior' }"
          :x="previewWall.mid[0]"
          :y="previewWall.mid[1] + 0.24"
          text-anchor="middle"
        >{{ previewWall.role === 'exterior' ? '外墙' : '内墙' }}</text>
        <text
          v-if="previewWall.ok && previewWall.expanded"
          class="preview-role"
          :x="previewWall.expanded.dx + previewWall.expanded.to[0] / 2"
          :y="previewWall.expanded.dz - 0.18"
          text-anchor="middle"
        >场景 {{ fmtLen(previewWall.expanded.from[0]) }} × {{ fmtLen(previewWall.expanded.from[1]) }} → {{ fmtLen(previewWall.expanded.to[0]) }} × {{ fmtLen(previewWall.expanded.to[1]) }} m</text>
        <text
          v-if="previewWall.ok && previewWall.overlapM > 0"
          class="preview-overlap"
          :x="previewWall.mid[0]"
          :y="previewWall.mid[1] + 0.48"
          text-anchor="middle"
        >与已有墙重叠 {{ fmtLen(previewWall.overlapM) }} m（不会自动裁）</text>
        <text
          v-if="previewWall.ok === false"
          class="preview-reason"
          :x="previewWall.mid[0]"
          :y="previewWall.mid[1] + 0.28"
          text-anchor="middle"
        >{{ previewWall.message }}</text>
      </g>

      <!-- 放门预览：形状与落笔后**同一个来源**（`openings.draftOpening`），另加实时净宽读数。
           `pointer-events: none`（见样式）—— 预览绝不能吞掉拖动。 -->
      <g v-if="previewOpening && previewOpening.ok" class="preview" aria-hidden="true">
        <polygon class="preview-opening" :class="{ 'is-window': previewOpening.kind === 'window' }" :points="previewOpening.quad.map((q) => q.join(' ')).join(' ')" />
        <text class="preview-len" :x="previewOpening.mid[0]" :y="previewOpening.mid[1]" text-anchor="middle">
          {{ previewOpening.kind === 'window'
            ? `窗 ${previewOpening.width.toFixed(2)} × ${previewOpening.height.toFixed(2)} m · 离地 ${previewOpening.sill.toFixed(2)} m`
            : `净宽 ${previewOpening.width.toFixed(2)} m` }}
        </text>
      </g>

      <!-- 房间尺寸标注 -->
      <path class="dim-line" :d="`M0 ${layout.d + 0.22} L${layout.w} ${layout.d + 0.22}`" />
      <text class="ruler" :x="layout.w / 2" :y="layout.d + 0.38" text-anchor="middle">{{ fmtLen(layout.w) }} m</text>
      <path class="dim-line" :d="`M${-0.22} 0 L${-0.22} ${layout.d}`" />
      <text
        class="ruler"
        :x="-0.34" :y="layout.d / 2" text-anchor="middle"
        :transform="`rotate(-90 ${-0.34} ${layout.d / 2})`"
      >{{ fmtLen(layout.d) }} m</text>
      </g>
    </svg>

    <!-- 画布下方视图栏（docs/84 §五）：左边一行模式提示，右边缩略图开关 + 缩放簇。
         提示与缩放都从上方工具条搬下来 —— 工具条只留五个模式按钮，手不用在一条里找两件事。
         三维预览下这一整条不在 PlanView 里（PlanView 只在平面设计时渲染）。 -->
    <div class="plan-views">
      <span class="hint view-hint" id="plan-keys" :title="modeHint">{{ modeHint }}</span>
      <!-- 缩略图显隐（硬要求③：**1 步**，快捷键 T；与房间卡头那颗是同一个开关） -->
      <button
        class="btn view-btn"
        data-tool="thumbs"
        :aria-pressed="d.roomThumbs.value"
        title="显示/隐藏房间缩略图（T）"
        @click="d.toggleRoomThumbs()"
      >{{ d.roomThumbs.value ? '缩略图：开' : '缩略图：关' }}</button>
      <!-- 视口控件：首次上手反馈里"看不见全貌"那条，缺的就是这几个按钮 ——
           没有按钮的缩放能力等于没有，必须让手指找得到 -->
      <div class="zoom">
        <button class="btn view-btn" title="缩小（-）" @click="zoomBy(1 / 1.25)">−</button>
        <button class="btn view-btn zoom__pct" title="100% = 1 m 屏幕 64 px（点一下回适配，快捷键 0）" @click="fit">{{ zoomPct }}%</button>
        <button class="btn view-btn" title="放大（+）" @click="zoomBy(1.25)">＋</button>
        <button class="btn view-btn" title="适配：整间房装进画布（0）" @click="fit">适配</button>
      </div>
    </div>

    <div v-if="!d.count.value" class="plan-empty">
      <b>空房间</b>
      <span class="hint">从左侧型号卡点击「放入布局」，或在房间尺寸里先改大小</span>
    </div>

    <!-- 动线卡：**Teleport 进右栏**，不改 Inspector.vue 的写作用域。
         PlanView 先挂、Inspector 后挂，`railReady` 等这一轮 DOM 落定后再解析目标；
         右栏收起时这张卡随栏一起隐藏（inert 由 App 给），展开就回来。 -->
    <Teleport v-if="railReady" to="#rail-right">
      <!-- 柱卡（P2 2D）：计数/柱占/可用面积 + 列表 + 选中宽深/复制/删除。
           柱是结构对象，优先于动线；卡在右栏，不抢画布。 -->
      <RailFold id="column" title="柱" :summary="`${d.columnCount.value} 根`">
        <template #head>
          <span class="column-card__count" data-column-card-count data-column-count>{{ d.columnCount.value }}/{{ d.columnLimit.value }}</span>
        </template>
        <div data-column-card>
          <div v-if="!d.columnRows.value.length" class="column-card__empty" data-column-empty>
            还没有柱。点工具条「＋画柱」，在平面图上拖两个角（或点一下放 0.5 × 0.5 m）。
          </div>
          <div v-else class="column-card__list" role="list" aria-label="柱列表">
            <div
              v-for="row in d.columnRows.value"
              :key="`col${row.id}`"
              class="column-card__row"
              :class="{ 'is-selected': d.selectedColumn.value === row.id, 'is-invalid': !!row.invalid }"
              :data-column-row="row.id"
              :data-column-invalid-reason="row.invalid?.reason"
              :data-column-opening-kind="row.invalid?.openingKind"
              role="listitem"
            >
              <button
                type="button"
                class="column-card__main"
                :aria-pressed="d.selectedColumn.value === row.id"
                :aria-current="d.selectedColumn.value === row.id ? 'true' : undefined"
                :title="row.invalid?.message || `柱 #${row.id} · ${fmtLen(row.w)} × ${fmtLen(row.d)} m`"
                @click="d.selectColumn(row.id)"
              >
                <b>柱 #{{ row.id }}</b>
                <span>{{ fmtLen(row.w) }} × {{ fmtLen(row.d) }} m · {{ fmtArea(row.area) }}</span>
                <span v-if="row.invalid" class="column-card__bad">非法</span>
              </button>
              <button
                type="button"
                class="column-card__icon"
                title="复制到右侧 +0.20 m（Ctrl/Cmd+D）"
                @click="d.copyColumn(row.id)"
              >复制</button>
              <button
                type="button"
                class="column-card__icon column-card__icon--danger"
                title="删除这根柱（可撤销）"
                @click="d.removeColumn(row.id)"
              >删除</button>
            </div>

            <div v-if="selectedColumnRow" class="column-card__detail" data-column-selected>
              <p v-if="selectedColumnRow.invalid" class="column-card__reason" :data-column-invalid-reason="selectedColumnRow.invalid.reason" :data-column-opening-kind="selectedColumnRow.invalid.openingKind">
                {{ selectedColumnRow.invalid.message }}
              </p>
              <label class="column-card__field">
                <span>宽 W</span>
                <input
                  type="number" min="0.2" max="3" step="0.01"
                  :value="Number(selectedColumnRow.w).toFixed(2)"
                  data-column-width-input
                  @change="updateColumnField(selectedColumnRow, 'w', $event)"
                > m
              </label>
              <label class="column-card__field">
                <span>深 D</span>
                <input
                  type="number" min="0.2" max="3" step="0.01"
                  :value="Number(selectedColumnRow.d).toFixed(2)"
                  data-column-depth-input
                  @change="updateColumnField(selectedColumnRow, 'd', $event)"
                > m
              </label>
              <div class="column-card__actions">
                <button type="button" class="btn" @click="d.copyColumn(selectedColumnRow.id)">复制</button>
                <button type="button" class="btn btn--danger" @click="d.removeColumn(selectedColumnRow.id)">删除</button>
              </div>
            </div>
          </div>
          <div class="column-card__stats">
            <span data-column-area>柱占 {{ fmtArea(d.columnAreaTotal.value) }}</span>
            <span data-column-usable>可用面积 {{ fmtArea(d.usableArea.value) }}</span>
          </div>
          <p v-if="d.columnCount.value >= d.columnLimit.value" class="hint column-card__limit" data-column-limit>
            已达上限 {{ d.columnLimit.value }} 根；先删一根再加。
          </p>
          <p v-else class="hint column-card__hint">
            柱与墙可重叠；压设备/门窗洞或叠柱会被拒绝。点一下放 0.5×0.5，拖两角定尺寸，Shift 只关吸附。
          </p>
        </div>
      </RailFold>
      <RailFold id="route" title="动线" :summary="d.routeSummary.value">
        <template #head>
          <span class="route-card__count" data-route-card-count>{{ d.routeRows.value.length }} 条</span>
        </template>
        <div data-route-card>
          <div v-if="!d.routeRows.value.length" class="route-card__empty" data-route-empty>
            还没有动线。点工具条「＋动线」，在平面图上依次点 A、B、C…
          </div>
          <div v-else class="route-card__list" role="list" aria-label="动线列表">
            <div
              v-for="row in d.routeRows.value"
              :key="`card${row.id}`"
              class="route-card__row"
              :class="{ 'is-selected': d.routeSelectedId.value === row.id, 'is-blocked': row.status === 'blocked', 'is-hidden': !row.visible }"
              :data-route-id="row.id"
              :data-route-status="row.status"
              :data-route-visible="row.visible ? '1' : '0'"
              role="listitem"
            >
              <button
                type="button"
                class="route-card__main"
                :aria-pressed="d.routeSelectedId.value === row.id"
                :aria-current="d.routeSelectedId.value === row.id ? 'true' : undefined"
                :title="`${row.displayName} · ${routeStatusText(row)}`"
                @click="d.selectRoute(row.id)"
              >
                <span class="route-swatch" :style="{ '--route-color': `var(--route-${row.colorIndex})` }" aria-hidden="true"></span>
                <span class="route-card__name">{{ row.displayName }}</span>
                <span class="route-card__meta">{{ row.status === 'ok' ? `${row.pointCount} 点 · ${fmtLen(row.length)} m` : '走不通' }}</span>
              </button>
              <button
                type="button"
                class="route-card__icon"
                :aria-pressed="row.visible"
                :title="row.visible ? '隐藏这条动线（只影响本页显示）' : '显示这条动线（只影响本页显示）'"
                @click="d.toggleRouteVisible(row.id)"
              >{{ row.visible ? '隐藏' : '显示' }}</button>
              <button
                type="button"
                class="route-card__icon route-card__icon--danger"
                title="删除这条动线（可撤销）"
                @click="removeRouteFromCard(row.id)"
              >删除</button>
            </div>

            <div v-if="selectedRouteRow" class="route-card__detail" :data-route-status="selectedRouteRow.status">
              <label class="route-card__field">
                <span>名称</span>
                <input
                  :value="selectedRouteRow.name"
                  maxlength="20"
                  placeholder="默认「动线 N」"
                  @change="renameRouteFromInput(selectedRouteRow, $event)"
                  @keydown.enter.prevent="$event.target.blur()"
                >
              </label>
              <p class="hint route-card__status" :class="{ 'is-blocked': selectedRouteRow.status === 'blocked' }">
                {{ routeStatusText(selectedRouteRow) }}
              </p>
              <!-- 站点列表：站点/拐点不抢 SVG 焦点；这里每站一个真按钮，Tab 可达（docs/95 §7.3） -->
              <div class="route-card__stops" role="list" aria-label="站点列表">
                <div
                  v-for="(point, index) in selectedRouteRow.points"
                  :key="`st${selectedRouteRow.id}_${index}`"
                  class="route-card__stop"
                  :class="{ 'is-selected': d.routeSelectedPoint.value?.routeId === selectedRouteRow.id && d.routeSelectedPoint.value?.index === index }"
                  role="listitem"
                >
                  <button
                    type="button"
                    class="route-card__stop-main"
                    :aria-current="d.routeSelectedPoint.value?.routeId === selectedRouteRow.id && d.routeSelectedPoint.value?.index === index ? 'true' : undefined"
                    :aria-label="`站点 ${stopLabel(index)}，坐标 ${point[0].toFixed(1)}, ${point[1].toFixed(1)} 米`"
                    @click="d.selectRoutePoint(selectedRouteRow.id, index)"
                  >
                    <b>{{ stopLabel(index) }}</b>
                    <span>{{ point[0].toFixed(1) }}, {{ point[1].toFixed(1) }} m</span>
                  </button>
                  <button
                    type="button"
                    class="route-card__icon route-card__icon--danger"
                    :disabled="selectedRouteRow.points.length <= 2"
                    title="删除这个站点（至少保留 2 个点）"
                    @click="d.removeRoutePoint(selectedRouteRow.id, index)"
                  >删点</button>
                </div>
              </div>
              <div class="route-card__actions">
                <button type="button" class="btn" @click="isAppending(selectedRouteRow.id) ? cancelRouteAppend() : startRouteAppend(selectedRouteRow.id)">
                  {{ isAppending(selectedRouteRow.id) ? '取消加站' : '加途经点' }}
                </button>
                <button type="button" class="btn" title="按当前墙体/设备重新算一遍（只重算派生折线）" @click="d.replanRoutes()">重新规划</button>
                <button type="button" class="btn btn--danger" @click="removeRouteFromCard(selectedRouteRow.id)">删除这条</button>
              </div>
            </div>
          </div>
          <p v-if="routeAppend" class="hint route-card__append" data-route-append-hint>
            加站中：在平面图上点地面，把新站插进「{{ d.routeRows.value.find((r) => r.id === routeAppend.id)?.displayName }}」末尾 · Esc 取消
          </p>
        </div>
      </RailFold>
    </Teleport>
  </div>
</template>

<style scoped>
/* 画布上方工具条（docs/84 §二：高 40 px）：只放五个模式按钮 */
.scene-chip {
  position: absolute; top: 48px; left: 12px; z-index: 2;
  padding: 3px 9px; border: 1px solid var(--line); border-radius: 999px;
  background: color-mix(in srgb, var(--panel) 92%, transparent);
  color: var(--ink-2); font-size: 12px; line-height: 1.4; cursor: pointer;
}
.scene-chip:hover { border-color: var(--brand); color: var(--brand-dark); }

.plan-tools {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 40px;
  padding: 0 12px;
  border-bottom: 1px solid var(--line-2);
  background: #fbfdfe;
  overflow-x: auto;
}
.plan-tools .tool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 11px;
  font-size: 13px;
  line-height: 1.25;
  flex: none;
}
/* 固定 14 px 的前置图标槽：未激活「＋」/激活「✓」在这里换，槽宽不随状态变 ——
   按钮可见文案恒定，激活前后宽度差为 0，整排按钮不会被推着走（验收 #1）。 */
.plan-tools .tool__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  min-width: 14px;
  flex: none;
  font-size: 12px;
  line-height: 1;
}

/* 画布下方视图栏（docs/84 §二 / §五）：左一行模式提示，右缩略图开关与缩放簇 */
.plan-views {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  height: 40px;
  padding: 0 12px;
  border-top: 1px solid var(--line-2);
  background: #fbfdfe;
}
/* 提示写全、显示按一行省略：完整文案挂 title，读屏读的仍是这一整句 */
.plan-views .view-hint {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.plan-views .view-btn { padding: 4px 9px; line-height: 1.1; min-width: 30px; flex: none; }
.plan-views .zoom { display: inline-flex; align-items: center; gap: 4px; flex: none; }
.plan-views .zoom__pct { min-width: 56px; font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* 预览：外框虚线 + 半透明填充 —— 一眼看出"这是还没落笔的那面墙"。
   颜色与墙同一套变量（主题色只该有一个出处：src/style.css 的 --brand）。 */
.preview,
.preview * { pointer-events: none; }
.preview-wall {
  fill: var(--brand);
  /* 预览的不透明度跟着墙体档位走（乘一个 0.5 的系数当"高亮"，但"很透"在预览里也一眼看得出） */
  fill-opacity: calc(var(--wall-2d-op, 1) * .5);
  stroke: var(--brand);
  stroke-width: calc(1.5 * var(--u));
  stroke-dasharray: calc(4 * var(--u)) calc(3 * var(--u));
}
.preview-len {
  font-family: var(--mono);
  font-size: calc(11 * var(--u));
  fill: var(--brand-dark);
  paint-order: stroke;
  stroke: var(--panel);
  stroke-width: calc(2.5 * var(--u));
}
/* 放洞口预览：洞口轮廓（与墙体同一套品牌色变量，主题只有一个出处）；
   窗用底色区分「这一下放的是窗不是门」—— 形状与落笔后是**同一份几何**，只有色不同 */
.preview-opening.is-window { fill: var(--brand-soft); fill-opacity: .6; }
.preview-opening {
  fill: var(--brand);
  fill-opacity: .35;
  stroke: var(--brand);
  stroke-width: calc(1.5 * var(--u));
  stroke-dasharray: calc(4 * var(--u)) calc(3 * var(--u));
}

/* 触屏：模式按钮至少 44 px 高（docs/92 的命中口径；鼠标环境保持 40 px 工具条不跳） */
@media (pointer: coarse) {
  .plan-tools { height: auto; min-height: 44px; }
  .plan-tools .tool { min-height: 44px; }
}
</style>