/**
 * designer.js —— 应用状态与动作（组合式，单实例）
 *
 * 分工铁律：
 *   这个文件**不做任何业务判断** —— 合法性、上限、夹取、格式校验全部问内核。
 *   它只负责：持有状态、调内核、把结果翻译成界面动作。
 *
 * 撤销口径：**改动前**记录快照（与原型一致），且快照必然带 nextId（FIX-25 的结构化固化）。
 * 拖拽/滑杆这类连续操作：按下时记录一次（beginEdit），过程静默 —— 否则一次拖拽会灌满 40 步历史。
 */

import { computed, ref, shallowRef, watch } from 'vue';
import {
  getProduct, productLabel, createHistory, areaOf, footprintOf, issuesOf, clearanceOf,
  checkAllWalls, rooms as roomsKernel, LIMITS,
  catalogState, onCatalogChange,
  doorTroubleClause,
  placement, room, scheme, validate, doors, geometry, openings, wall as wallKernel,
} from './kernel.js';
import { fmtLen, fmtArea } from './fmt.js';
import { scene2d } from './scene2d.js';
import { checkColumn, columnNextId, columnAreaTotal as coreColumnAreaTotal, usableAreaOf } from '@core/columns.js';
import { cfg } from '@core/params.js';
import {
  planRoute, planRoutes, pointWalkable, routePointInScene, routeSegments,
} from '@core/route.js';

/**
 * 画房预览（纯函数）：与落笔 `addRoomRect` **同源**，先扩场景再算外框墙。
 *
 * 为什么必须先 `expandToInclude`：把预览墙直接拼到旧 layout 上时，越界的那几条边落在旧
 * `w/d` 外，`roomsOf` 的守恒守卫会抛「房间面积超过场景」。落笔本来就会先扩场景，预览不做
 * 就会在每次 pointermove 抛一条 unhandledrejection（真实拖动时抓到的缺陷）。
 *
 * `roomsOf` **只调一次**：`roomsAfter` 与预览标签共用这一个结果。无效矩形/扩场景失败返回
 * `{ok:false,message}`，由调用方决定不画预览 —— 不在这里 throw，也不吞掉内核的守卫。
 *
 * @param {object} layout 当前布局（预览期间不改它）
 * @param {{x0:number,z0:number,x1:number,z1:number}} rect 当前坐标系里的拖拽矩形
 * @returns {{ok:false,message:string}
 *          |{ok:true,walls:Array,reused:number,overlaps:number,total:number,roomsAfter:number,
 *            expanded:null|{dx:number,dz:number,from:number[],to:number[]},at:number[]}}
 */
export function planRoomPreview(layout, rect) {
  const ex = room.expandToInclude(layout, rect);
  if (!ex || ex.ok !== true) {
    return { ok: false, message: ex?.error ?? '这块地方放不下：空间尺寸超出范围' };
  }
  // changed=false 时 layout / rect 就是入参本身；changed=true 时是内核新造的那一份
  const base = ex.layout;
  const r = roomsKernel.roomOutlineWalls(base, ex.rect);
  const next = { ...base, walls: [...base.walls, ...r.walls] };
  const roomsAfter = roomsKernel.roomsOf(next).length;
  // 预览画在**当前**坐标系：左/上扩时内核把整栋平移了 dx/dz，新墙要平移回来才不跳。
  const dx = Number(ex.dx) || 0;
  const dz = Number(ex.dz) || 0;
  return {
    ok: true,
    walls: r.walls.map((w) => [
      [w.a[0] - dx, w.a[1] - dz],
      [w.b[0] - dx, w.b[1] - dz],
    ]),
    reused: r.reused.length,
    overlaps: r.overlaps.length,
    total: r.total,
    roomsAfter,
    expanded: ex.changed
      ? { dx, dz, from: [layout.w, layout.d], to: [base.w, base.d] }
      : null,
    at: [(rect.x0 + rect.x1) / 2, (rect.z0 + rect.z1) / 2],
  };
}

function createDesigner() {
  const layout = ref(room.createLayout({ w: 8, d: 6, h: 2.8 }));
  /** 方案来源格式（服务端/导入返回的 `format`）。本轮只保存，旧方案预检与尺寸分支由 task-36 读。 */
  const schemeFormat = ref(null);
  const nextId = ref(4);
  const selectedId = ref(null);
  const selectedWall = ref(null);
  /** 选中的柱 id（`null` = 未选）；与设备/墙/洞口/房间/动线互斥 */
  const selectedColumn = ref(null);
  /** 画柱模式（与画墙/放门/画房/切分/动线互斥） */
  const columnMode = ref(false);
  const message = ref('');
  const mode = ref('2d'); // '2d' | '3d' —— 3D 在 R3 下一批接
  const drawing = ref(false);
  const drawStart = ref(null);
  /** 放门模式（与画墙互斥）：点墙即放，拖一段则按那一段定宽 */
  const openingMode = ref(false);
  /** 选中的门洞：`{ wallIndex, index }`（门洞没有 id —— 它的身份就是"哪面墙上的第几个"） */
  const selectedOpening = ref(null);
  /* ---------------- 房间（M1：**派生**自墙，不进 state） ---------------- */
  /** 选中的房间 id（几何稳定 id，见 `rooms.js` 的 `ringId`） */
  const selectedRoom = ref(null);
  /** 房间缩略图显隐（用户硬要求③：一键显隐 = 1 步） */
  const roomThumbs = ref(true);
  /** 画房 / 切分模式（与画墙、放门三者互斥：它们的手指动作都是"在画布上拖"） */
  const roomMode = ref('');            // '' | 'room' | 'split'
  /* ---------------- 动线（W4/P2：只存用户点，折线全部派生） ---------------- */
  /** 动线工具模式（与画墙/门/窗/房/切分互斥；它也是"在画布上点/拖"的手势模式） */
  const routeMode = ref(false);
  /** 选中的动线与站点（`routePoint` = { routeId, index }；index 是用户点序号，不是自动拐点） */
  const routeSelectedId = ref(null);
  const routeSelectedPoint = ref(null);
  /** 观看态：显隐**不进 layout/历史**（设计决策记录 T5）；只在本页面内生效 */
  const routeHidden = ref(new Set());
  /** 重新规划的手动触发（自动折线本来就是派生量；这个数只用来让 computed 失效） */
  const routePlanNonce = ref(0);
  /** 相机聚焦请求：`{ kind:'room'|'building', id, n }`（n 是流水号 —— 同一间房连点两次也要重新聚焦） */
  const focusWish = ref(null);
  let focusSeq = 0;

  const history = createHistory();
  const undoDepth = ref(0);
  const redoDepth = ref(0);

  let toastTimer = 0;
  function toast(text) {
    message.value = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { message.value = ''; }, 2600);
  }

  function syncHistory() {
    undoDepth.value = history.size();
    redoDepth.value = history.canRedo() ? 1 : 0;
  }

  let lastEditAt = 0;
  /**
   * 改动前记录快照。
   * `throttleMs` 用于**连续手势**（方向键连发、滑杆拖动）：同一连发只记一次，
   * 否则 40 步历史会被一次操作灌满。
   */
  function beginEdit({ throttleMs = 0 } = {}) {
    const now = Date.now();
    if (throttleMs && now - lastEditAt < throttleMs) return;
    lastEditAt = now;
    history.push(layout.value, nextId.value);
    syncHistory();
  }

  /* ---------------- 派生量（全部来自内核） ---------------- */

  /** 当前方案的用户点（没有动线时返回 []；旧方案没有 routes 字段也走这里） */
  const routes = computed(() => (Array.isArray(layout.value.routes) ? layout.value.routes : []));
  /**
   * 所有动线的规划结果。`planRoutes` 是 P1 纯函数，内部按 layout/opts 缓存导航网格；
   * 预览也走 `planRoute`（同一函数），不在这里复制任何墙/门/设备几何。
   */
  const routePlans = computed(() => {
    // 读一下 nonce，让「重新规划」能把 computed 撞失效（结果本身仍由 layout 决定）
    routePlanNonce.value;
    return planRoutes(layout.value, { getProduct });
  });
  /**
   * 右栏/图例/2D 共用的一行动线读数：名字、颜色槽、两态（v1 只有 ok/blocked）、长度、错误原因。
   * 颜色/显隐/名称显示都在这里派生，**不写进 layout**。
   */
  const routeRows = computed(() => routes.value.map((route, index) => {
    const plan = routePlans.value[index] ?? null;
    const status = plan?.ok ? 'ok' : 'blocked';
    return {
      id: route.id,
      index,
      number: index + 1,
      colorIndex: (index % 6) + 1,
      name: typeof route.name === 'string' && route.name ? route.name : '',
      displayName: typeof route.name === 'string' && route.name ? route.name : `动线 ${route.id}`,
      points: Array.isArray(route.points) ? route.points : [],
      pointCount: Array.isArray(route.points) ? route.points.length : 0,
      plan,
      status,
      reason: plan?.reason ?? null,
      message: plan?.message ?? '',
      length: Number(plan?.length) || 0,
      visible: !routeHidden.value.has(route.id),
    };
  }));
  const routeSummary = computed(() => {
    const rows = routeRows.value;
    if (!rows.length) return '';
    const bad = rows.filter((r) => r.status === 'blocked').length;
    const total = rows.reduce((n, r) => n + (r.status === 'ok' ? r.length : 0), 0);
    return bad ? `${rows.length} 条 · ${bad} 条走不通` : `${rows.length} 条 · ${fmtLen(total)} m`;
  });
  const scene = computed(() => scene2d(layout.value, { routePlans: routePlans.value, selectedColumn: selectedColumn.value }));
  const issues = computed(() => issuesOf(layout.value));
  // ⭐ 墙的问题**不并进 issues**（B19）：issues 是「几台设备放不下」，墙是「几面墙在屋外」 ——
  // 两个数单位都不一样，并起来就只能胡说（本项目在这上面付过学费）。
  const wallIssues = computed(() => checkAllWalls(layout.value));
  const area = computed(() => areaOf(layout.value));
  const footprint = computed(() => footprintOf(layout.value));
  const occupancy = computed(() => (area.value ? Math.round((footprint.value / area.value) * 100) : 0));
  // 目录是**运行时**的：服务端目录到了要整体换掉。catalog.js 里那份是纯数据（不依赖 vue），
  // 这里负责响应性 —— 换完界面自动变，`d.catalog.length` 这种旧写法照旧能用。
  const catalogRows = ref(catalogState.rows);
  const catalogSource = ref(catalogState.source);
  onCatalogChange((st) => { catalogRows.value = st.rows; catalogSource.value = st.source; });

  const status = computed(() => validate.statusText(layout.value, getProduct));
  /**
   * 规则 7（开门净空）—— 接缝 A 的 A3 决策：**不阻断放置**，只如实告诉用户"门最多能开多少"。
   * 与 issues（合法性）并列，不是同一件事：布局可以完全合法，门却打不开（见 设计决策记录）。
   *
   * ⚠️ 这里是全量逐度扫掠（含粗筛后 100 台仍约 140 ms），而平面图要按分级着色 → **每次改动都会重算**。
   * 所以不能挂在 computed 上跟着每帧跑（拖动会顿）。做法：变化后**安静 90 ms 再算一次**。
   * 连续拖动时定时器不断被重置 → 拖动过程中一次都不算、松手后补一次，手上不会有卡顿。
   * 代价是拖动期间平面图沿用上一次的结论（颜色短暂滞后）——
   * 这比"规则口径打折"划算：**算得慢可以等，算错不能忍**。
   */
  const clearance = shallowRef([]);
  let clearanceTimer = 0;
  watch(layout, () => {
    if (clearanceTimer) clearTimeout(clearanceTimer);
    clearanceTimer = setTimeout(() => {
      clearanceTimer = 0;
      clearance.value = clearanceOf(layout.value);
    }, 90);
  }, { immediate: true });
  const clearanceById = computed(() => new Map(clearance.value.map((r) => [r.id, r])));
  /** 门有麻烦（黄/红）的条目：红在前，方便用户先看最要紧的 */
  const doorTrouble = computed(() =>
    clearance.value
      .filter((r) => r.level === 'bad' || r.level === 'warn')
      .sort((a, b) => (a.level === b.level ? a.freeDeg - b.freeDeg : a.level === 'bad' ? -1 : 1)));
  const isClean = computed(() => issues.value.length === 0);
  const selected = computed(() => layout.value.items.find((i) => i.id === selectedId.value) ?? null);
  const selectedProduct = computed(() => (selected.value ? getProduct(selected.value.p) : null));
  /** 选中门洞的实际值 + 策略提示（净宽是否低于当前下限之类）—— 界面直接显示，不自己算 */
  const selectedOpeningInfo = computed(() => {
    const sel = selectedOpening.value;
    if (!sel) return null;
    const wall = layout.value.walls[sel.wallIndex];
    const o = wall ? (wall.openings ?? [])[sel.index] : null;
    if (!wall || !o) return null;
    const insp = openings.inspectOpening(wall, o, layout.value.h);
    return { ...sel, opening: o, warnings: insp.warnings, bad: insp.structural };
  });
  const openingCount = computed(() => layout.value.walls.reduce((n, w) => n + (w.openings?.length ?? 0), 0));
  /** 门洞数 / 窗数（**分开数**：窗这一批之后「有几个洞口」这个总数已经说明不了什么了） */
  const doorCount = computed(() => layout.value.walls.reduce((n, w) => n + openings.doorOpenings(w).length, 0));
  const windowCount = computed(() => layout.value.walls.reduce((n, w) => n + openings.windowOpenings(w).length, 0));

  /* ---------------- 房间（派生量） ---------------- */

  /** 房间清单（名称/面积/形心/窄缝/设备数，全部来自内核）—— 界面只读它 */
  const roomList = computed(() => roomsKernel.roomSummary(layout.value, layout.value.roomLabels));
  const roomCount = computed(() => roomList.value.length);
  /** 房间语义：`'walls'`（新，房间=闭合墙围出的面）或 `'legacy'`（旧矩形外框）。
   *  字段住在 layout 内部（内核 `createLayout` 显式写 walls；旧导入缺省 legacy），**永不进 state/导出**。 */
  const roomSemantics = computed(() => layout.value.roomSemantics ?? roomsKernel.roomSemanticsOf(layout.value));
  /** 房间面积（米²）：只算闭合房间；开放面积另计（`roomArea + openArea ≈ w*d`）。 */
  const roomArea = computed(() => roomsKernel.roomAreaTotal(layout.value));
  /** 开放面积（米²）：新语义 = 开放面之和；旧语义为 0。 */
  const openArea = computed(() => roomsKernel.openAreaTotal(layout.value));
  /** 2D 房间层渲染条件：>1 间，或 1 间房 + 开放面积（否则用户分不清房间与开放区）。 */
  const showRoomLayer = computed(() => roomCount.value > 1 || openArea.value > 1e-9);
  /** 给 task-36 的换方案/尺寸分流用：来源格式 + 当前语义（都不进 state）。 */
  const schemeMeta = computed(() => ({ format: schemeFormat.value, roomSemantics: roomSemantics.value }));
  const roomById = computed(() => new Map(roomList.value.map((r) => [r.id, r])));
  const selectedRoomInfo = computed(() => (selectedRoom.value ? roomById.value.get(selectedRoom.value) ?? null : null));
  /** 墙的三值（外墙 / 隔墙 / 房内隔断）—— 界面/探针读数用，界面不自己分类 */
  const wallClasses = computed(() => roomsKernel.wallClasses(layout.value));
  const partyWalls = computed(() => wallClasses.value.filter((c) => c === 'party').length);
  /** 名字在"等房间"（墙改过形状、暂时对不上任何一间）—— 如实提示，不静默丢 */
  const waitingNames = computed(() => {
    const labels = layout.value.roomLabels ?? {};
    const ids = new Set(roomList.value.map((r) => r.id));
    return Object.entries(labels).filter(([k]) => !ids.has(k)).map(([, v]) => v);
  });
  const canUndo = computed(() => undoDepth.value > 0);
  const canRedo = computed(() => redoDepth.value > 0);
  const count = computed(() => layout.value.items.length);

  /* ---------------- 动作 ---------------- */

  function add(productId) {
    const before = layout.value;
    const beforeId = nextId.value;
    const r = placement.addItem(before, productId, { getProduct, id: nextId.value });
    if (!r.ok) {
      toast(r.message ?? placement.MSG.unknown);
      return null;
    }
    history.push(before, beforeId);
    layout.value = r.layout;
    nextId.value = r.item.id + 1;
    selectedId.value = r.item.id;
    selectedWall.value = null;
    selectedColumn.value = null;
    syncHistory();
    // 规则 7 的"主动提示"（接缝 A / C 方案）：**不阻断放置**，但摆完立刻说一句
    // "这几台的门开不到底" —— 否则用户得自己盯着扇形看才发现的。
    //
    // 这里顺手把去抖的那份净空也刷新掉（并清掉定时器），于是：
    //   ① 只算一次，不是"提示算一遍、着色再算一遍"；
    //   ② 提示里的台数与平面图的分级**必然一致**（R3-9：分级与文案必须严格一致）；
    //   ③ 新放进去那台的颜色立刻就对，不用等那 90 ms。
    // 代价是点击路径上多一次全屋净空（十来台约十几毫秒；100 台约 140 ms ——
    // 这条路径是"点一下"，不是拖动，可以接受；拖动走的仍是去抖那条路）。
    if (clearanceTimer) { clearTimeout(clearanceTimer); clearanceTimer = 0; }
    clearance.value = clearanceOf(r.layout);
    const clause = doorTroubleClause(clearance.value, r.item.id);
    const base = `已放入「${productLabel(productId)}」，当前 ${r.layout.items.length} 台`;
    toast(clause ? `${base}；${clause}` : base);
    return r.item;
  }

  /**
   * 落位置。**改了就报出来**：毫米取整是内核的规则（`roundMm`），但"把用户输入改掉了"
   * 这件事必须由界面说出口 —— 静默改数是这个项目最不能接受的一类 bug（B4b 的教训）。
   */
  /** 换外墙外观档位（进方案 → 可撤销 → 交付图可复现） */
  function setWallStyle(style) {
    const next = style ?? 'solid';
    if ((layout.value.view?.wallOpacity ?? 'solid') === next) return;
    beginEdit();
    layout.value = { ...layout.value, view: { ...(layout.value.view ?? {}), wallOpacity: next } };
  }

  function setPosition(id, x, z) {
    const before = layout.value.items.find((i) => i.id === id);
    const rx = geometry.roundMm(x);
    const rz = geometry.roundMm(z);
    const changed = [];
    if (before && (Math.abs(rx - x) > 1e-9)) changed.push(`x ${x} → ${rx}`);
    if (before && (Math.abs(rz - z) > 1e-9)) changed.push(`z ${z} → ${rz}`);
    beginEdit();
    layout.value = placement.moveItem(layout.value, id, x, z);
    if (changed.length) toast(`位置按毫米取整：${changed.join('，')} m`);
  }

  function rotate(id, deg, { silent = false } = {}) {
    if (!silent) beginEdit();
    layout.value = placement.rotateItem(layout.value, id, deg);
  }

  function rotateBy(id, delta) {
    const item = layout.value.items.find((i) => i.id === id);
    if (!item) return;
    rotate(id, item.r + delta);
  }

  function remove(id) {
    beginEdit();
    layout.value = placement.removeItem(layout.value, id);
    if (selectedId.value === id) selectedId.value = null;
  }

  function clearAll() {
    if (!layout.value.items.length) return;
    beginEdit();
    layout.value = { ...layout.value, items: [] };
    selectedId.value = null;
    toast('已清空全部设备（可撤销）');
  }

  function setDoor(id, amount, { silent = false } = {}) {
    if (!silent) beginEdit({ throttleMs: 600 });
    layout.value = doors.setDoorAmount(layout.value, id, amount);
  }

  function applyRoom(size) {
    // 新语义：只校验、不重建墙（越界返回墙/设备序号，不静默删）。旧方案仍走原重建分支。
    if (roomSemantics.value === 'walls') {
      const p = room.planSceneSize(layout.value, size, { getProduct });
      if (!p || p.ok === false) {
        // 内核 message 已用 1 起编号（`墙 #1、#2`）；只在它没写序号时补，绝不追加第二套 0 起编号。
        const msg = p?.message ?? '场景范围不合法';
        const parts = [msg];
        if (p?.wallIndexes?.length && !/墙\s*#/.test(msg)) {
          parts.push(`越界墙：${p.wallIndexes.map((i) => `#${i + 1}`).join('、')}`);
        }
        if (p?.itemIndexes?.length && !/设备\s*#/.test(msg)) {
          parts.push(`越界设备：${p.itemIndexes.map((i) => `#${i + 1}`).join('、')}`);
        }
        toast(parts.join('；'));
        return false;
      }
      if (!p.changed) {
        toast('场景范围没有变化');
        return false;
      }
      beginEdit();
      layout.value = p.layout;
      selectedOpening.value = null;
      selectedRoom.value = null;
      toast(`已更新场景范围为 ${fmtLen(p.layout.w)} × ${fmtLen(p.layout.d)} m（墙与设备保留）`);
      return true;
    }
    const r = room.applyRoomSize(layout.value, size);
    if (!r.ok) {
      toast(r.error);
      return false;
    }
    beginEdit();
    layout.value = r.layout;
    selectedOpening.value = null;
    selectedRoom.value = null;
    const kept = r.kept ?? 0;
    const removed = r.removed ?? 0;
    // 门洞：跟走的与丢掉的都要说出来（`applyRoomSize` 把它们当成计数返回，界面只是转述）
    const gates = r.openingsDropped ? `；${r.openingsDropped} 个放不下的洞口已随墙删除` : '';
    if (removed) toast(`空间已更新；${removed} 面超出新范围的内墙已移除${gates}`);
    else if (kept) toast(`已重建外墙，保留 ${kept} 面内墙${gates}`);
    else toast(`空间已更新为 ${r.layout.w} × ${r.layout.d} m${gates}`);
    return true;
  }

  /**
   * 放洞口模式开关 —— **三态**：`'door'` / `'window'` / `false`（W2 窗）。
   *
   * 窗**不新开一套状态机**：放窗、选中、改数、Delete、撤销全部复用门那一条路径，
   * 只有「画的是门还是窗」这一个 bit 不同。与画墙/画房间互斥的理由照旧：
   * 几件事的手指动作都是「在画布上点/拖」，同时开着就只能有一个说话。
   * `setOpeningMode(true)` 照旧 = 放门（老调用点不用改）。
   */
  function setOpeningMode(kind) {
    openingMode.value = kind === 'window' ? 'window' : (kind ? 'door' : false);
    if (openingMode.value) {
      drawing.value = false;
      drawStart.value = null;
      routeMode.value = false;
      columnMode.value = false;
      clearSelection();
    }
  }

  /**
   * 放一个门洞（**全部判断在内核**：位置夹取、净宽上下限、离墙角间隙、重叠、上限）。
   * @param {number} wallIndex
   * @param {{at?:number,w?:number,h?:number,span?:[number,number]}} want
   */
  function addOpening(wallIndex, want = {}) {
    const r = openings.placeOpening(layout.value, wallIndex, want);
    if (!r.ok) {
      toast(r.message ?? openings.MSG.badOpening());
      return null;
    }
    beginEdit();
    layout.value = r.layout;
    selectedOpening.value = { wallIndex, index: r.index };
    selectedId.value = null;
    selectedWall.value = null;
    const isWin = wallKernel.kindOf(r.opening) === 'window';
    const base = isWin
      ? `已放窗：净宽 ${r.opening.w.toFixed(2)} m · 净高 ${r.opening.h.toFixed(2)} m · 离地 ${wallKernel.sillOf(r.opening).toFixed(2)} m`
      : `已放门洞：净宽 ${r.opening.w.toFixed(2)} m · 净高 ${r.opening.h.toFixed(2)} m`;
    // 夹取必须出声（静默改数是这个项目最不能接受的一类 bug）
    toast(r.clamps.length ? `${base}；${r.clamps.join('；')}` : base);
    return r.opening;
  }

  function removeOpening(wallIndex = selectedOpening.value?.wallIndex, index = selectedOpening.value?.index) {
    if (wallIndex === undefined || index === undefined) return false;
    const r = openings.removeOpening(layout.value, wallIndex, index);
    if (!r.ok) {
      toast(r.message ?? openings.MSG.badOpening());
      return false;
    }
    beginEdit();
    layout.value = r.layout;
    selectedOpening.value = null;
    toast('已删除洞口（可撤销）');
    return true;
  }

  /** 改净宽/净高/位置（输入框与拖动都走这一条）—— 夹取与提示仍在内核 */
  function updateOpening(patch, { silent = false } = {}) {
    const sel = selectedOpening.value;
    if (!sel) return false;
    const r = openings.updateOpening(layout.value, sel.wallIndex, sel.index, patch);
    if (!r.ok) {
      toast(r.message ?? openings.MSG.badOpening());
      return false;
    }
    if (!silent) beginEdit();
    layout.value = r.layout;
    selectedOpening.value = { wallIndex: sel.wallIndex, index: r.index };
    if (!silent && r.clamps?.length) toast(r.clamps.join('；'));
    return true;
  }

  function selectOpening(wallIndex, index) {
    selectedOpening.value = { wallIndex, index };
    selectedId.value = null;
    selectedWall.value = null;
    selectedColumn.value = null;
    selectedRoom.value = null;
    clearRouteSelection();
  }

  /**
   * 墙一变，房间 id 就可能跟着变 —— 名字不能凭空消失。
   * 规则：按旧房间的形心找它现在落在哪一间；两间并一间时**面积大的名字活下来**，
   * 被并掉的 / 没地方去的 **都报出来**（不静默选一个、不静默丢）。
   * @returns {string} note = 要报给用户的那句话（'' = 没什么可说的）
   */
  function carryNames(prev, next) {
    const labels = prev.roomLabels ?? {};
    if (!Object.keys(labels).length) return '';
    const out = roomsKernel.carryLabels(roomsKernel.roomsOf(prev), labels, roomsKernel.roomsOf(next));
    const kept = Object.keys(out.labels).length ? out.labels : undefined;
    const merged = out.dropped.filter((d) => d.reason === 'merged');
    const gone = out.dropped.filter((d) => d.reason !== 'merged');
    const parts = [];
    if (merged.length) parts.push(`「${merged[0].name}」已并入「${merged[0].into}」`);
    if (gone.length) parts.push(`「${gone[0].name}」暂时没有对应的房间了（形状改回去就回来）`);
    if (!parts.length && out.carried.length) parts.push(`房间名跟着形状走：${out.carried.map((c) => `「${c.name}」`).join('、')}`);
    next.roomLabels = kept;
    return parts.join('；');
  }

  /** 换上一份新墙（名字先搬过去）；返回"名字那句语"，由调用方决定怎么一起报 */
  function applyWalls(next) {
    const note = carryNames(layout.value, next);
    layout.value = next;
    return note;
  }

  /**
   * 画墙的**只读预算**：预览与落笔共用，直接调内核 `placement.planDrawWall`。
   * 场外不夹取（先扩场景再落墙）、角色由内核判；界面只读返回值，不在这里复制吸附/长度规则。
   */
  function planWall(start, end, opts = {}) {
    return placement.planDrawWall(layout.value, start, end, opts);
  }

  /**
   * 落笔：预览拿到的那份结果**原样提交**，只 `beginEdit()` 一次（扩场景 + 墙 + 角色一个撤销步）。
   * 场景扩了就不能再走 `applyWalls` 的 `carryNames` —— 内核已按新坐标系迁过房名。
   */
  function addWallPlan(plan) {
    if (!plan || plan.ok !== true) {
      toast(plan?.message ?? placement.MSG.wallLimit);
      return false;
    }
    const next = plan.layout;
    if (!next || !Array.isArray(next.walls)) {
      toast(placement.MSG.wallLimit);
      return false;
    }
    const beforeRooms = roomsKernel.roomSummary(layout.value, layout.value.roomLabels);
    beginEdit();
    const note = plan.expanded ? '' : applyWalls(next);
    if (plan.expanded) layout.value = next;
    const afterRooms = roomsKernel.roomSummary(next, next.roomLabels);
    const beforeIds = new Set(beforeRooms.map((r) => r.id));
    const afterIds = new Set(afterRooms.map((r) => r.id));
    const fresh = afterRooms.filter((r) => !beforeIds.has(r.id));
    const gone = beforeRooms.filter((r) => !afterIds.has(r.id));
    selectedWall.value = Number.isInteger(plan.wallIndex) ? plan.wallIndex : next.walls.length - 1;
    selectedId.value = null;
    selectedRoom.value = null;

    const parts = [];
    if (Number(plan.overlapM) > 0) parts.push(`与已有墙重叠 ${fmtLen(plan.overlapM)} m（不会自动裁）`);
    const splitN = Number(plan.split?.count) || 0;
    if (splitN > 0) parts.push(`已在接头处把 ${splitN} 面旧墙断成两段（可分别删除）`);
    if (plan.split?.skipped?.length) {
      parts.push(`${plan.split.skipped.length} 面墙的洞口跨过接头，未拆分（洞口不许切一半）`);
    }
    if (plan.expanded) {
      const { from, to, dx = 0, dz = 0, reclassified = [] } = plan.expanded;
      parts.push(`已把场景扩到 ${fmtLen(to[0])} × ${fmtLen(to[1])} m`);
      if (from && (Math.abs(from[0] - to[0]) > 1e-9 || Math.abs(from[1] - to[1]) > 1e-9)) {
        const shift = [];
        if (Math.abs(dx) > 1e-9) shift.push(`整体${dx > 0 ? '右' : '左'}移 ${fmtLen(Math.abs(dx))} m`);
        if (Math.abs(dz) > 1e-9) shift.push(`整体${dz > 0 ? '下' : '上'}移 ${fmtLen(Math.abs(dz))} m`);
        if (shift.length) parts.push(`墙与设备${shift.join('、')}`);
      }
      if (reclassified.length) parts.push(`原外墙已变为内墙（${reclassified.length} 面，可撤销）`);
    }
    const roleText = plan.role === 'exterior' ? '外墙' : '内墙';
    parts.push(`已添加${roleText}（共 ${next.walls.length} 面）`);
    // 只有房间数真的增加才说「围出/切开」：扩场景会让房间 id 跟着形心变，
    // 1 间房扩完还是 1 间 —— 不能把 id 换了当成"新房间"（真机探针当场抓到的误报）。
    if (afterRooms.length > beforeRooms.length) {
      if (fresh.length && gone.length) {
        parts.push(`新墙切开了「${gone[0].displayName}」，房间 ${beforeRooms.length} → ${afterRooms.length} 间`);
      } else if (fresh.length) {
        parts.push(`这圈墙围出了一间 ${fmtArea(fresh[0].area)} 的房间，可在右栏命名；想做院子就删掉一面墙`);
      } else {
        parts.push(`房间 ${beforeRooms.length} → ${afterRooms.length} 间`);
      }
    } else if (afterRooms.length < beforeRooms.length) {
      parts.push(`房间 ${beforeRooms.length} → ${afterRooms.length} 间`);
    }
    if (plan.note) parts.push(plan.note);
    if (note) parts.push(note);
    toast(parts.join('；'));
    return true;
  }

  /** 旧的同步入口：保留给 devkit/已有测试，行为与新画墙一致（不再直接调旧 `placement.addWall`）。 */
  function addWall(start, end, opts = {}) {
    return addWallPlan(planWall(start, end, opts));
  }

  /** 墙的当前角色（持久化 role 优先；旧墙回退内核几何）—— 界面只读，不自己判端点。 */
  function wallRoleAt(index) {
    const wall = layout.value.walls[index];
    if (!wall) return null;
    if (wall.role === 'exterior' || wall.role === 'interior') return wall.role;
    return room.wallRole(layout.value, wall);
  }

  /**
   * 角色切换（一步可撤销）：只调内核 `room.setWallRole`。
   * 非贴边墙设为外墙时内核返回 `wall-not-on-edge` —— UI 原话转述，不自己放行。
   */
  function setWallRole(index, role) {
    const r = room.setWallRole(layout.value, index, role);
    if (!r || r.ok === false) {
      const why = r?.reason === 'wall-not-on-edge'
        ? '只有贴当前场景边缘的墙才能设为外墙（否则它会显示成外墙、却挡不住设备）'
        : (r?.message ?? '墙体类型没有改成功');
      toast(why);
      return false;
    }
    if (!r.changed) return false;
    beginEdit();
    const note = applyWalls(r.layout);
    selectedWall.value = index;
    toast(`${role === 'exterior' ? '已设为外墙' : '已设为内墙'}（可撤销）${note ? `；${note}` : ''}`);
    return true;
  }

  /** 设备归属：有房间→房间名；否则新语义下是「开放场景」，旧语义仍是「未分房间」。 */
  function itemScope(item) {
    if (!item) return '';
    const r = roomsKernel.roomOfItem(layout.value, item);
    if (r) {
      const row = roomList.value.find((x) => x.id === r.id);
      return row?.displayName ?? '未命名房间';
    }
    return openArea.value > 1e-9 ? '开放场景' : '未分房间';
  }

  /**
   * 改一面墙的端点。
   *
   * ⚠️ 两条都是**真 bug 的修法**（2026-10-09 M1 探针当场抓出来的）：
   *  ① **两种形状都收、只写对象**：调用方（历史上的 Inspector）给的是 4 个数数组。
   *    原来 `walls[index] = wall` 于是把**数组**塞进了 `layout.walls` —— 墙池里混着两种形状，
   *    导出时 `cloneWall(数组)` 直接炸（`wl.a` 是 undefined）。现在一律归一成对象。
   *  ② **门洞跟着墙走**：门洞长在墙上（`{at,w,h}`），改端点绝不能把它悄悄扔掉。
   *    放不进新墙长的（墙被改短了）**丢掉并报出来** —— 静默丢数据是这个项目最不能接受的一类 bug。
   */
  function updateWall(index, wall) {
    const prevWall = layout.value.walls[index];
    const seg = wallKernel.wallSeg(wallKernel.readWall(wall) ?? {});
    const nums = Array.isArray(seg) ? seg : [];
    if (nums.length !== 4 || !nums.every((v) => Number.isFinite(v))) {
      toast('墙体坐标不合法（坐标必须是有限数字）');
      return false;
    }
    const [x, z, xx, zz] = nums;
    // 长度与画墙同一道门槛：拖短到 0.1 m 以下时**当场拦住**，否则画布上看着有一面墙，
    // 保存到服务端才被 `bad-wall` 整份拒绝 —— 用户只知道“保存失败”，不知道是哪一面。
    // 判据用内核的 `minWallLengthM`，不在界面写死 0.1。
    if (Math.hypot(xx - x, zz - z) < cfg.scheme.minWallLengthM) {
      toast(placement.MSG.wallTooShort);
      return false;
    }
    const candidate = wallKernel.mkWallSeg(x, z, xx, zz);
    // 判据问内核（同一句话：端点必须落在房间里）—— 界面不自己定几何
    const reason = validate.checkWall(layout.value, candidate);
    if (reason) {
      toast(reason === 'wall-out-of-room' ? '墙体两端都要落在空间范围内' : '墙体数据不合法');
      return false;
    }
    const oldOpenings = wallKernel.openingsOf(prevWall);
    const kept = oldOpenings.filter((o) => !openings.checkOpeningShape(candidate, o, layout.value.h));
    const dropped = oldOpenings.length - kept.length;
    const nextWall = {
      a: [x, z],
      b: [xx, zz],
      // ⚠️ 走 `cloneOpening`（形状的唯一定义）：手抄 `{at,w,h}` 会把**窗降级成落地洞**
      ...(kept.length ? { openings: kept.map(wallKernel.cloneOpening) } : {}),
    };
    beginEdit();
    const walls = layout.value.walls.slice();
    walls[index] = nextWall;
    applyWalls({ ...layout.value, walls });
    if (dropped) toast(`${dropped} 个门洞放不进新的墙长，已随这次修改删除（可撤销）`);
    return true;
  }

  function removeWall(index) {
    const before = roomsKernel.roomsOf(layout.value).length;
    const openBefore = openArea.value;
    beginEdit();
    const next = { ...layout.value, walls: layout.value.walls.filter((_, i) => i !== index) };
    const after = roomsKernel.roomsOf(next).length;
    const note = applyWalls(next);
    selectedWall.value = null;
    const openAfter = roomsKernel.openAreaTotal(next);
    // 用户 2026-10-09 拍板④：删掉共享隔墙 = 两间合成一间（米家/智家就是这个效果）。
    // 但拆掉闭合环的一面墙不是"合并"，是这间房变成开放场景 —— 两种结果必须说不同的话。
    if (openAfter - openBefore > 1e-9 && after < before) {
      toast(`已删除墙（可撤销）；这间房变成开放场景了，墙围回去就回来`);
    } else if (after < before) {
      toast(`已删除墙（可撤销）；${before} 间已合成 ${after} 间`);
    } else if (note) toast(`已删除墙（可撤销）；${note}`);
    return { ok: true, roomsBefore: before, roomsAfter: after };
  }

  function undo() {
    const r = history.undo(layout.value, nextId.value);
    if (!r) return;
    layout.value = r.layout;
    if (Number.isFinite(r.nextId)) nextId.value = r.nextId;
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    clearRouteSelection();
    syncHistory();
    toast('已撤销');
  }

  function redo() {
    const r = history.redo(layout.value, nextId.value);
    if (!r) return;
    layout.value = r.layout;
    if (Number.isFinite(r.nextId)) nextId.value = r.nextId;
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    clearRouteSelection();
    syncHistory();
    toast('已重做');
  }

  /**
   * 回到「新方案」的默认状态，**不打招呼**。
   *
   * 与整篇刷新之后进 `/design/new` 得到的是同一份东西：默认那一间房、编号从头开始、撤销历史空。
   * 换账号之后接着用同一篇文档时要用它 —— 退出登录与登录成功都是同一篇文档里的客户端跳转，
   * 内存里那份布局不会自己回到默认，于是新账号会看到上一个账号没保存的那一间房。
   */
  function resetNewDesign() {
    history.clear();
    syncHistory();
    schemeFormat.value = null;
    layout.value = room.createLayout({ w: 8, d: 6, h: 2.8 });
    nextId.value = 4;
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    openingMode.value = false;
    // 画墙/画房/切分都是「模式」：重置要一起退出去（不然按钮还亮着，用户以为还在那个模式里）
    drawing.value = false;
    roomMode.value = '';
    routeMode.value = false;
    routeHidden.value = new Set();
    clearRouteSelection();
    selectedRoom.value = null;
  }

  /** 用户自己点「重置」：与 `resetNewDesign` 是同一件事，只是要告诉他发生了什么 */
  function reset() {
    resetNewDesign();
    toast('已重置为新方案');
  }

  /* ---------------- 文件 ---------------- */

  function download() {
    const text = scheme.exportScheme(layout.value);
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '场景空间设计方案.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`已导出方案：${layout.value.items.length} 台设备，${blob.size} 字节`);
  }

  async function importFile(file) {
    if (!file) return;
    if (!scheme.checkFileSize(file.size).ok) {
      toast('无法导入：文件过大（上限 1 MB）');
      return;
    }
    const text = await file.text();
    const r = scheme.importScheme(text, { getProduct });
    if (!r.ok) {
      toast(r.message);
      return;
    }
    beginEdit();
    schemeFormat.value = r.format ?? null;
    layout.value = r.layout;
    nextId.value = r.nextId;
    selectedId.value = null;
    selectedWall.value = null;
    selectedColumn.value = null;
    columnMode.value = false;
    routeMode.value = false;
    routeHidden.value = new Set();
    clearRouteSelection();
    toast(`方案已导入：${r.layout.items.length} 台设备 · ${r.layout.w} × ${r.layout.d} m`);
  }

  /**
   * 从服务端取回的 state 灌回界面。
   *
   * 走的是与 `importFile` **同一条内核路径**（`scheme.importScheme`）—— 不特判、不绕开校验。
   * 之所以能这样偷懒，是因为服务端**只存规范化后的 state**：能存进去的一定导得回来。
   *
   * 历史清空：与 `reset()` 同款 —— 换了一份方案，撤销栈不该还能撤回上一份方案里去。
   */
  function applyServerState(state, format) {
    const r = scheme.importScheme(JSON.stringify({ format, state }), { getProduct });
    if (!r.ok) {
      toast(r.message);
      return false;
    }
    history.clear();
    syncHistory();
    // format 与语义一起留下：旧方案预检/尺寸分流（task-36）要按来源判断，不能只看当前 w/d。
    // `roomSemantics` 住在 layout 内部，永不进 state/导出；这里不把它抄进 layout 之外。
    schemeFormat.value = r.format ?? format ?? null;
    layout.value = r.layout;
    nextId.value = r.nextId;
    selectedId.value = null;
    selectedWall.value = null;
    selectedColumn.value = null;
    columnMode.value = false;
    selectedRoom.value = null;
    routeMode.value = false;
    routeHidden.value = new Set();
    clearRouteSelection();
    return true;
  }

  function selectItem(id) {
    selectedId.value = id;
    selectedWall.value = null;
    selectedOpening.value = null;
    selectedRoom.value = null;
    selectedColumn.value = null;
    clearRouteSelection();
  }

  function selectWall(index) {
    selectedWall.value = index;
    selectedId.value = null;
    selectedOpening.value = null;
    selectedRoom.value = null;
    selectedColumn.value = null;
    clearRouteSelection();
  }

  function clearSelection() {
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    selectedRoom.value = null;
    selectedColumn.value = null;
    clearRouteSelection();
  }

  /* ---------------- 矩形柱（P2 2D）---------------- */
  const columns = computed(() => (Array.isArray(layout.value.columns) ? layout.value.columns : []));
  const columnRows = computed(() => scene.value.columns ?? []);
  const columnCount = computed(() => columns.value.length);
  const columnLimit = computed(() => Number(cfg.column?.maxCount) || 50);
  const columnAreaTotal = computed(() => coreColumnAreaTotal(columns.value));
  /** 可用面积：各房间面积减「四角都在同一房间面内」的柱；柱占不改房间/开敞面积 */
  const usableArea = computed(() => roomList.value.reduce((sum, r) => sum + usableAreaOf(r, columns.value), 0));
  const selectedColumnInfo = computed(() => columnRows.value.find((c) => c.id === selectedColumn.value) ?? null);
  /** 下一根柱 id：直接走内核 `columnNextId`（max+1，不建独立计数器） */
  function nextColumnId() {
    return columnNextId(layout.value);
  }

  /** 画柱预览：只问内核「这一拖能不能落」，不写 state */
  function checkColumnDraft(rect) {
    return columnCandidate(rect).check;
  }

  /** 清柱选择（不动模式） */
  function clearColumn() {
    selectedColumn.value = null;
  }

  function selectColumn(id) {
    const hit = columns.value.find((c) => String(c.id) === String(id));
    if (!hit) return false;
    selectedColumn.value = hit.id;
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    selectedRoom.value = null;
    clearRouteSelection();
    return true;
  }

  /** 画柱模式：与现有手势模式互斥；只切换模式，不改选中 */
  function setColumnMode(next) {
    const want = typeof next === 'boolean' ? next : !columnMode.value;
    columnMode.value = want;
    if (want) {
      drawing.value = false;
      drawStart.value = null;
      openingMode.value = false;
      roomMode.value = '';
      routeMode.value = false;
      clearRouteSelection();
    }
    return columnMode.value;
  }

  /** 写入前的统一检查 + 夹取：不合法返回原因，绝不静默改数 */
  function columnCandidate(patch, { ignoreId = null } = {}) {
    const raw = { ...patch };
    const col = {
      id: raw.id ?? (ignoreId ?? nextColumnId()),
      x: geometry.roundMm(Number(raw.x)),
      z: geometry.roundMm(Number(raw.z)),
      w: geometry.roundMm(Number(raw.w)),
      d: geometry.roundMm(Number(raw.d)),
    };
    // 更新已有柱：先从现有清单摘掉自己，内核按“其余 49 根”算，不会误报 column-limit。
    const base = ignoreId === null || ignoreId === undefined
      ? layout.value
      : { ...layout.value, columns: columns.value.filter((c) => String(c.id) !== String(ignoreId)) };
    const check = checkColumn(base, col, { ignoreId, getProduct });
    return { col, check };
  }

  /** 新增一根柱；失败时不写 state（0.2 以下拒绝，不夹取） */
  function addColumn(rect) {
    if (columnCount.value >= columnLimit.value) {
      toast(`柱最多 ${columnLimit.value} 根；先删几根再加`);
      return null;
    }
    const before = layout.value;
    const beforeId = nextId.value;
    const { col, check } = columnCandidate({
      x: rect?.x, z: rect?.z, w: rect?.w, d: rect?.d,
    });
    if (!check.ok) {
      toast(check.message);
      return null;
    }
    const added = check.column ?? col;
    history.push(before, beforeId);
    layout.value = { ...layout.value, columns: [...columns.value, added] };
    selectedColumn.value = added.id;
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    selectedRoom.value = null;
    clearRouteSelection();
    syncHistory();
    toast(`已放置柱 #${added.id}，${added.w.toFixed(2)} × ${added.d.toFixed(2)} m`);
    return added;
  }

  /** 改柱（移动/改宽深共用）；`silent` 用于拖拽过程，一次手势只记一次快照 */
  function updateColumn(id, patch, { silent = false } = {}) {
    const cur = columns.value.find((c) => String(c.id) === String(id));
    if (!cur) return false;
    const { col, check } = columnCandidate({ ...cur, ...patch, id: cur.id }, { ignoreId: cur.id });
    if (!check.ok) {
      if (!silent) toast(check.message);
      return false;
    }
    if (!silent) beginEdit();
    const next = check.column ?? col;
    layout.value = {
      ...layout.value,
      columns: columns.value.map((c) => (String(c.id) === String(id) ? next : c)),
    };
    if (!silent && selectedColumn.value === null) selectedColumn.value = next.id;
    return true;
  }

  function removeColumn(id = selectedColumn.value) {
    if (id === null || id === undefined) return false;
    const hit = columns.value.find((c) => String(c.id) === String(id));
    if (!hit) return false;
    beginEdit();
    layout.value = { ...layout.value, columns: columns.value.filter((c) => String(c.id) !== String(id)) };
    if (String(selectedColumn.value) === String(id)) selectedColumn.value = null;
    toast(`已删除柱 #${hit.id}（可撤销）`);
    return true;
  }

  /** 复制到右侧紧邻，柱间净距 0.20 m；放不下按 设计决策记录在 2 m 内找最近合法位 */
  function copyColumn(id = selectedColumn.value) {
    const cur = columns.value.find((c) => String(c.id) === String(id));
    if (!cur) return null;
    const before = layout.value;
    const beforeId = nextId.value;
    const gap = 0.2;
    const baseX = Number(cur.x) + Number(cur.w) / 2 + gap + Number(cur.w) / 2;
    const candidates = [baseX, ...Array.from({ length: 41 }, (_, i) => Number(cur.x) + (i - 20) * 0.1 + Number(cur.w) + gap)];
    for (const x of candidates) {
      const { col, check } = columnCandidate({ ...cur, x, id: nextColumnId() });
      if (!check.ok) continue;
      const added = check.column ?? col;
      history.push(before, beforeId);
      layout.value = { ...layout.value, columns: [...columns.value, added] };
      selectedColumn.value = added.id;
      syncHistory();
      toast(`已复制柱 #${cur.id} → #${added.id}（右侧 +0.20 m 净距）`);
      return added;
    }
    toast('右侧放不下（2 m 内没有合法位置）；没有复制');
    return null;
  }

  /* ---------------- 动线（W4/P2）---------------- */

  /** 关掉动线的选中（不动模式；模式由 setRouteMode 管） */
  function clearRouteSelection() {
    routeSelectedId.value = null;
    routeSelectedPoint.value = null;
  }

  function routeById(id) {
    return routes.value.find((r) => r.id === id) ?? null;
  }

  function routeNextId() {
    return routes.value.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  }

  /** 统一调用 P1：预览、落笔、失效重算共用这一条；异常也翻成 blocked，不把异常抛给渲染 */
  function planRouteData(route) {
    try {
      return planRoute(layout.value, route, { getProduct });
    } catch (err) {
      return {
        ok: false, status: 'blocked', routeId: route?.id ?? null,
        points: Array.isArray(route?.points) ? route.points : [], legs: [], length: 0,
        reason: 'bad-route', message: err?.message || '动线规划失败',
      };
    }
  }

  /** P1 原因码 → 用户话术（只翻译，不重写几何结论） */
  function routeErrorText(plan) {
    // P1 的几何词是「拐点」（内核视角）；界面统一说「站点」，避免用户以为自动拐点也能点
    if (plan?.message) return String(plan.message).replace(/拐点/g, '站点');
    const table = {
      'route-point-out-of-scene': '点落在场景外了：动线只能走在场景地面内',
      'anchor-blocked': '这个点放不下：不能落在墙、设备里，或贴边太近',
      'door-too-narrow': '门太窄，人（含余量）过不去；先换一扇宽一点的门',
      'door-blocked': '门两侧被墙或设备挡住了，动线过不去',
      unreachable: '这两点之间没有可走的路：先给墙放一扇门，或把点挪开',
      'route-too-long': '动线太长了，超过内核允许的长度上限',
      'bad-route': '动线数据不合法（需要 2–20 个点，且相邻点不能重合）',
      'nav-too-large': '场景太大，寻路网格超出上限；先缩小场景再试',
    };
    return table[plan?.reason] ?? '这条动线暂时走不通';
  }

  /** 首个站点还没有段可规划；用 P1 的点判据先挡掉场外/墙里/设备里 */
  function routePointProblem(point) {
    if (!Array.isArray(point) || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
      return '这个点没有合法坐标';
    }
    if (!routePointInScene(layout.value, point)) {
      return `点落在场景外了：动线只能走在 ${fmtLen(layout.value.w)} × ${fmtLen(layout.value.d)} m 地面内`;
    }
    if (!pointWalkable(layout.value, point, { getProduct })) {
      return '这个点放不下：不能落在墙或设备里，也不能贴边太近';
    }
    return '';
  }

  function routeStatus(id) {
    return routeRows.value.find((r) => r.id === id)?.status ?? 'blocked';
  }

  function setRouteMode(next) {
    const want = typeof next === 'boolean' ? next : !routeMode.value;
    routeMode.value = want;
    if (want) {
      drawing.value = false;
      drawStart.value = null;
      openingMode.value = false;
      roomMode.value = '';
      columnMode.value = false;
      selectedId.value = null;
      selectedWall.value = null;
      selectedOpening.value = null;
      selectedRoom.value = null;
      selectedColumn.value = null;
    }
    return routeMode.value;
  }

  function selectRoute(id) {
    if (!routeById(id)) return false;
    routeSelectedId.value = id;
    routeSelectedPoint.value = null;
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    selectedRoom.value = null;
    selectedColumn.value = null;
    return true;
  }

  function selectRoutePoint(routeId, index) {
    const route = routeById(routeId);
    if (!route || !Number.isInteger(index) || index < 0 || index >= route.points.length) return false;
    routeSelectedId.value = routeId;
    routeSelectedPoint.value = { routeId, index };
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    selectedRoom.value = null;
    selectedColumn.value = null;
    return true;
  }

  /** 一次点/拖的预览：与落笔 `addRoute`/`appendRoutePoint` 共用 planRoute */
  function planRouteDraft(points, id = null) {
    const clean = (Array.isArray(points) ? points : [])
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [geometry.roundMm(p[0]), geometry.roundMm(p[1])]);
    return planRouteData({ id, points: clean });
  }

  function setRoutePoints(id, points, { silent = false } = {}) {
    const route = routeById(id);
    if (!route) return false;
    const clean = (Array.isArray(points) ? points : [])
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [geometry.roundMm(p[0]), geometry.roundMm(p[1])]);
    if (!silent) beginEdit();
    layout.value = {
      ...layout.value,
      routes: routes.value.map((r) => (r.id === id ? { ...r, points: clean } : r)),
    };
    return true;
  }

  function addRoute(points) {
    if (routes.value.length >= cfg.route.maxRoutes) {
      toast(`动线最多 ${cfg.route.maxRoutes} 条；先删一条再加`);
      return null;
    }
    const clean = (Array.isArray(points) ? points : [])
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p) => [geometry.roundMm(p[0]), geometry.roundMm(p[1])]);
    if (clean.length < 2) { toast('至少要有 A、B 两个点才能成为一条动线'); return null; }
    if (clean.length > cfg.route.maxPoints) {
      toast(`一条动线最多 ${cfg.route.maxPoints} 个点`); return null;
    }
    const id = routeNextId();
    const plan = planRouteData({ id, points: clean });
    if (!plan.ok) { toast(routeErrorText(plan)); return null; }
    beginEdit();
    layout.value = { ...layout.value, routes: [...routes.value, { id, points: clean }] };
    selectRoute(id);
    toast(`已添加动线 ${id}：${clean.length} 个点 · ${fmtLen(plan.length)} m`);
    return { id, plan };
  }

  /** 加一个途经点：`at` 省略 = 末尾；传序号 = 插在该点之后（选中站点时右栏用） */
  function addRoutePoint(id, point, at = null) {
    const route = routeById(id);
    if (!route) return false;
    if (route.points.length >= cfg.route.maxPoints) {
      toast(`一条动线最多 ${cfg.route.maxPoints} 个点`); return false;
    }
    const p = [geometry.roundMm(point?.[0]), geometry.roundMm(point?.[1])];
    const index = Number.isInteger(at) ? Math.max(0, Math.min(route.points.length, at)) : route.points.length;
    const next = [...route.points.slice(0, index), p, ...route.points.slice(index)];
    const plan = planRouteData({ id, points: next });
    if (!plan.ok) { toast(routeErrorText(plan)); return false; }
    beginEdit();
    layout.value = {
      ...layout.value,
      routes: routes.value.map((r) => (r.id === id ? { ...r, points: next } : r)),
    };
    selectRoutePoint(id, index);
    toast(`已加途经点 ${String.fromCharCode(65 + index)}；动线 ${fmtLen(plan.length)} m`);
    return true;
  }

  function removeRoutePoint(id, index) {
    const route = routeById(id);
    if (!route || !Number.isInteger(index) || index < 0 || index >= route.points.length) return false;
    if (route.points.length <= 2) {
      toast('一条动线至少要有 2 个点；要删整条请用「删除这条动线」');
      return false;
    }
    beginEdit();
    const next = route.points.filter((_, i) => i !== index);
    layout.value = {
      ...layout.value,
      routes: routes.value.map((r) => (r.id === id ? { ...r, points: next } : r)),
    };
    clearRouteSelection();
    selectRoute(id);
    toast('已删除这个点（可撤销）');
    return true;
  }

  function removeRoute(id) {
    const route = routeById(id);
    if (!route) return false;
    beginEdit();
    layout.value = { ...layout.value, routes: routes.value.filter((r) => r.id !== id) };
    routeHidden.value = new Set([...routeHidden.value].filter((x) => x !== id));
    if (routeSelectedId.value === id) clearRouteSelection();
    toast(`已删除${route.name ? `「${route.name}」` : `动线 ${id}`}（可撤销）`);
    return true;
  }

  function renameRoute(id, name) {
    const route = routeById(id);
    if (!route) return false;
    const next = String(name ?? '').trim();
    if (Array.from(next).length > 20) { toast('名字最多 20 个字'); return false; }
    const cur = typeof route.name === 'string' ? route.name : '';
    if (next === cur) return false;
    beginEdit();
    layout.value = {
      ...layout.value,
      routes: routes.value.map((r) => {
        if (r.id !== id) return r;
        const copy = { ...r };
        if (next) copy.name = next;
        else delete copy.name;
        return copy;
      }),
    };
    toast(next ? `已改名为「${next}」` : '已清空动线名，显示默认名');
    return true;
  }

  /** 显隐是观看态：不进历史、不进 state（设计决策记录 T5） */
  function toggleRouteVisible(id) {
    if (!routeById(id)) return false;
    const next = new Set(routeHidden.value);
    if (next.has(id)) next.delete(id); else next.add(id);
    routeHidden.value = next;
    return !next.has(id);
  }

  function replanRoutes() {
    routePlanNonce.value += 1;
    const blocked = routeRows.value.filter((r) => r.status === 'blocked');
    toast(blocked.length
      ? `已按当前墙/设备重算：${blocked.length} 条走不通（${routeErrorText(blocked[0].plan)}）`
      : '已按当前墙/设备重算动线');
    return blocked.length;
  }

  /* ---------------- 房间：选中 / 命名 / 缩略图 / 两个手势 / 相机 ---------------- */

  function selectRoom(id) {
    selectedRoom.value = id ?? null;
    selectedId.value = null;
    selectedWall.value = null;
    selectedOpening.value = null;
    clearRouteSelection();
  }

  /** 换个名字（空串 = 清掉名字，回到「未命名房间」）—— 上限在内核（`cleanRoomName`） */
  function setRoomName(id, name) {
    const next = roomsKernel.cleanRoomName(name);
    const cur = layout.value.roomLabels?.[id] ?? '';
    if (next === cur) return false;
    beginEdit();
    const labels = { ...(layout.value.roomLabels ?? {}) };
    if (next) labels[id] = next;
    else delete labels[id];
    layout.value = { ...layout.value, roomLabels: Object.keys(labels).length ? labels : undefined };
    toast(next ? `已命名为「${next}」` : '已清空房间名（显示为「未命名房间」）');
    return true;
  }

  /** 缩略图显隐（硬要求③：1 步可达；探针拿返回值当读数） */
  function toggleRoomThumbs() {
    roomThumbs.value = !roomThumbs.value;
    return roomThumbs.value;
  }

  /** 画房 / 切分模式（与画墙、放门互斥 —— 三个模式的手指动作都是"在画布上拖"） */
  function setRoomMode(mode) {
    roomMode.value = roomMode.value === mode ? '' : mode;
    if (roomMode.value) {
      drawing.value = false;
      drawStart.value = null;
      routeMode.value = false;
      columnMode.value = false;
      setOpeningMode(false);
      clearSelection();
      toast(roomMode.value === 'room'
        ? '画房间：在画布上拖一个矩形（已有的墙会复用，不会画成两条）'
        : '切分房间：在房间里拖一条线，两端会自动接到墙上');
    }
    return roomMode.value;
  }

  /**
   * 画一间房（硬要求②：**2 步** —— 点按钮 + 拖一个矩形）。
   * 已存在的边**复用**（两间共享的那面墙永远只有一条记录），部分重叠的**报出来**。
   *
   * 画到现有空间外时先问内核 `expandToInclude`：整栋扩到包含它（左/上扩会整体平移
   * 墙与设备、房名跟着搬家）。扩空间与加墙合成**一个撤销步**；用内核返回的 `rect`
   *（已在新坐标系里平移/夹好）继续算墙，不要拿原 rect。
   */
  function addRoomRect(rect) {
    const ex = room.expandToInclude(layout.value, rect);
    if (!ex.ok) {
      toast(ex.error ?? '这块地方放不下：空间尺寸超出范围');
      return false;
    }
    // changed=false 时 layout / rect 就是入参本身；changed=true 时是内核新造的那一份
    const base = ex.layout;
    const r = roomsKernel.roomOutlineWalls(base, ex.rect);
    const dropNote = ex.openingsDropped ? `${ex.openingsDropped} 个放不下的洞口已随外墙重建删除` : '';
    const parts = [];
    if (ex.changed) parts.push(`空间已扩到 ${fmtLen(base.w)} × ${fmtLen(base.d)} m`);
    if (dropNote) parts.push(dropNote);

    if (!r.walls.length) {
      if (!ex.changed) {
        toast('这块地方已经是房间了 —— 四条边都在墙上');
        return false;
      }
      // 扩了空间但四条边都压在墙上：尺寸也得落下去，否则"提示扩了、图上没变"
      beginEdit();
      // 内核已把房名迁到新 id；这里不能再走 applyWalls 的 carryNames ——
      // 它按**旧**房间形心去**新**（已平移）房间多边形里找，会找不到名字。
      layout.value = base;
      toast(`已把空间扩到 ${fmtLen(base.w)} × ${fmtLen(base.d)} m；这块地方已经是房间了（四条边都在墙上）${dropNote ? `；${dropNote}` : ''}`);
      return true;
    }
    if (r.total > LIMITS.walls) {
      toast(`墙的数量会超过上限（${LIMITS.walls} 面）—— 先删几面`);
      return false;
    }
    const before = roomsKernel.roomsOf(layout.value).length;
    beginEdit();
    const next = { ...base, walls: [...base.walls, ...r.walls] };
    if (ex.changed) layout.value = next;   // 同上：房名已由内核迁移，不能再 carryNames
    else applyWalls(next);
    const after = roomsKernel.roomsOf(layout.value).length;
    parts.push(`已加 ${r.walls.length} 面墙`, `房间 ${before} → ${after} 间`);
    if (r.reused.length) parts.push(`${r.reused.length} 条边复用了已有的墙`);
    if (r.overlaps.length) parts.push(`${r.overlaps.length} 面已有的墙与新画的边重叠（都留着，没改你的墙）`);
    toast(parts.join('；'));
    return true;
  }

  /** 切分房间（硬要求②：**2 步** —— 点按钮 + 拖一条线）；切不开就说清为什么（内核给话） */
  function splitRoom(seg) {
    if (layout.value.walls.length >= LIMITS.walls) {
      toast(`墙的数量已到上限（${LIMITS.walls} 面）—— 先删一面再画`);
      return false;
    }
    const r = roomsKernel.planSplit(layout.value, seg);
    if (!r.ok) {
      toast(r.message);
      return false;
    }
    beginEdit();
    applyWalls({ ...layout.value, walls: [...layout.value.walls, r.wall] });
    const ext = Math.round((r.extendedA + r.extendedB) * 100) / 100;
    toast(ext > 0.001 ? `已切成 ${r.roomsAfter} 间；两端自动接到了墙上（共 ${ext} m）` : `已切成 ${r.roomsAfter} 间`);
    return true;
  }

  /** 选中一台设备并把 2D 相机挪到它身上（空间体检里的 #编号）——
   *  选中与聚焦是两件事：选中决定右栏编辑哪一件，聚焦决定画布看哪里。 */
  function focusItem(id) {
    selectItem(id);
    focusSeq += 1;
    focusWish.value = { kind: 'item', id, n: focusSeq };
    return true;
  }

  /** 把相机挪到某一间（或整栋）—— 2D/3D 各自监听这个请求，各用自己那套数学 */
  function focusRoom(id) {
    focusSeq += 1;
    focusWish.value = { kind: 'room', id, n: focusSeq };
    return true;
  }

  function focusBuilding() {
    focusSeq += 1;
    focusWish.value = { kind: 'building', n: focusSeq };
    return true;
  }

  /** 「走进去」（缩略图/房间卡上的按钮，2 步）：切三维 + 站到这间房里 */
  function walkInto(id) {
    focusSeq += 1;
    focusWish.value = { kind: 'room', id, n: focusSeq, walk: true };
    mode.value = '3d';
    return true;
  }

  return {
    // state
    layout, nextId, selectedId, selectedWall, selectedOpening, message, mode, drawing, drawStart,
    openingMode,
    // 柱（P2 2D）
    selectedColumn, columnMode, columns, columnRows, columnCount, columnLimit, columnAreaTotal, usableArea, selectedColumnInfo,
    // derived
    scene, issues, wallIssues, clearance, clearanceById, doorTrouble,
    area, footprint, occupancy, status, isClean, selected, selectedProduct,
    selectedOpeningInfo, openingCount, doorCount, windowCount,
    canUndo, canRedo, count,
  // getter（不是 ref）：模板里一直写的是 `d.catalog.length`，换成 ref 就得改所有调用点
  get catalog() { return catalogRows.value; },
  get catalogSource() { return catalogSource.value; },
    // 房间（M1）
    selectedRoom, roomThumbs, roomMode, focusWish,
    // 动线（W4/P2）：选中、显隐、计划读数、操作
    routeMode, routeSelectedId, routeSelectedPoint, routeHidden, routeRows, routeSummary, routePlans,
    // 开放场景（P2）：面积/语义/房间层条件/角色/归属
    roomSemantics, roomArea, openArea, showRoomLayer, schemeMeta,
    // actions
    add, setPosition, rotate, rotateBy, remove, clearAll, setDoor, applyRoom,
    addWall, planWall, addWallPlan, wallRoleAt, setWallRole, itemScope,
    updateWall, removeWall, setWallStyle, undo, redo, reset, resetNewDesign, download, importFile, applyServerState,
    selectItem, focusItem, selectWall, clearSelection, beginEdit, toast,
    selectColumn, clearColumn, setColumnMode, nextColumnId, checkColumnDraft,
    addColumn, updateColumn, removeColumn, copyColumn,
    setOpeningMode, addOpening, removeOpening, updateOpening, selectOpening,
    // actions（房间）
    roomList, roomCount, roomById, selectedRoomInfo, wallClasses, partyWalls, waitingNames,
    selectRoom, setRoomName, toggleRoomThumbs, setRoomMode, addRoomRect, splitRoom,
    focusRoom, focusBuilding, walkInto,
    // actions（动线 W4/P2）
    setRouteMode, selectRoute, selectRoutePoint, clearRouteSelection, routeById, routeStatus,
    routePointProblem, routeErrorText, planRouteDraft, setRoutePoints,
    addRoute, addRoutePoint, removeRoutePoint, removeRoute, renameRoute, toggleRouteVisible,
    replanRoutes,
  };
}

/** 单实例：整个应用共享一份设计状态 */
export const designer = createDesigner();