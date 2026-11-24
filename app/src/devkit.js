/**
 * devkit.js —— 应用内 QA / 演示接口（挂到 `window.__spatial`）
 *
 * 为什么要有这个文件：
 *   ① 自动化验证需要一个**只由数字组成的调用面**（`window.__spatial.add(0)`），
 *      不能在外部拼字符串。所有"构造/读取"都在应用内部完成，外部只取值。
 *   ② 它就是给业务同事的那句"演示时按这个顺序点"的可执行版本 —— demo() 一键搭出演示场景。
 *   ③ R4 的接口契约（Spring Boot）会取代它做正式链路；在那之前，它是前后端共用的一套动作语义。
 *
 * 这里**不实现任何业务规则**：每个动作都转发给 designer（而 designer 转发给内核）。
 */

import { designer as d } from './designer.js';
import { scheme, validate, getProduct, room, geometry, placement, doors, collision, clearance, params, rooms as roomsKernel } from './kernel.js';
import { runCases, summarize } from '@core/case-runner.js';
import caseTable from '../../spatial-core/test/cases/rules.json';
import * as liveParams from './liveParams.js';
import { setWalking, walking } from './walkMode.js';
import { view3d } from './scene3d.js';

/** 运行时错误（由文件末尾的全局监听填充）—— 定位用，不影响业务 */
const runtimeErrors = [];

function stats() {
  const l = d.layout.value;
  const q = (sel) => document.querySelectorAll(sel).length;
  return {
    // 渲染面（用来证明"状态 → 界面"确实一致）
    svgMounted: !!document.querySelector('svg.plan'),
    domItems: q('.item'),
    domWalls: q('.wall'),
    // 门洞（W1）：DOM 面上的标记数（`scene2d` 一张墙上的洞就画一个）× 状态面上的真数
    // —— 两个数不一致就是"画丢了"或"存丢了"，探针直接比这一对。
    domOpenings: q('.opening-hit'),
    // 窗线（三线符号的第三线）：**只有窗有** —— 探针拿它证「窗在平面上没断墙身、画的是符号」
    domSash: q('.opening-sash'),
    openings: l.walls.reduce((n, w) => n + (w.openings?.length ?? 0), 0),
    // ⚠️ 用展开而不是手抄 `at/w/h`（W2）：手抄会让探针**看不见** `kind`/`sill`，
    //    于是「窗还在不在」这件事在探针里变成盲区 —— 与内核那 7 处窄门同一个病
    openingList: l.walls.flatMap((w, wi) => (w.openings ?? []).map((o, oi) => ({ wallIndex: wi, index: oi, ...o }))),
    doors: l.walls.reduce((n, w) => n + (w.openings ?? []).filter((o) => o.kind !== 'window').length, 0),
    windows: l.walls.reduce((n, w) => n + (w.openings ?? []).filter((o) => o.kind === 'window').length, 0),
    openingSelected: d.selectedOpeningInfo.value ? { ...d.selectedOpeningInfo.value, opening: { ...d.selectedOpeningInfo.value.opening } } : null,
    domDoorArcs: q('.door-arc'),
    domCards: q('.product'),
    domIssues: q('.issue-list li'),
    emptyHint: !!document.querySelector('.plan-empty'),
    // 状态面
    room: [l.w, l.d, l.h],
    items: l.items.length,
    walls: l.walls.length,
    interiorWalls: l.walls.filter((w) => !room.isBoundaryWall(l, w)).length,
    nextId: d.nextId.value,
    status: validate.statusText(l, getProduct),
    issues: d.issues.value.map((x) => ({ id: x.item.id, reason: x.reason })),
    canUndo: d.canUndo.value,
    canRedo: d.canRedo.value,
    message: d.message.value,
    area: d.area.value,
    occupancy: d.occupancy.value,
    mode: d.mode.value,
    items_detail: l.items.map((i) => ({ id: i.id, p: i.p, x: i.x, z: i.z, r: i.r, door: i.doorAmount })),
    selected: d.selectedId.value,
    // 房间（M1）：状态面的真数 × DOM 面的标记数 —— 两个数不一致就是"画丢了"或"存丢了"
    rooms: d.roomCount.value,
    domRooms: q('.room'),
    domRoomNames: q('.room-name'),
    domRoomThumbs: q('.rooms__thumb'),
    roomList: d.roomList.value.map((r) => ({
      id: r.id, name: r.name, displayName: r.displayName, area: r.area, sliver: r.sliver,
      walls: r.walls.length, items: r.items, openings: r.openings,
      centroid: r.centroid.map((v) => Math.round(v * 1000) / 1000),
    })),
    partyWalls: d.partyWalls.value,
    wallClasses: d.wallClasses.value,
    roomLabels: Object.keys(l.roomLabels ?? {}).length,
    waitingNames: d.waitingNames.value,
    roomThumbsVisible: d.roomThumbs.value,
    roomMode: d.roomMode.value,
    selectedRoom: d.selectedRoom.value,
    // 开放场景（P4）：语义 / 开放面积 / 每面墙的角色（持久化 role 优先，回退内核几何）。
    // `[data-wall-role]` 与这里是**同一个出处**（`d.wallRoleAt`）—— 探针读两边对账，
    // 差一个就说明"2D 样式没跟着角色走"或"角色没存下来"。
    semantics: d.roomSemantics.value,
    openArea: d.openArea.value,
    showRoomLayer: d.showRoomLayer.value,
    wallRoles: l.walls.map((_, i) => d.wallRoleAt(i)),
    wallRoleCount: {
      exterior: l.walls.filter((_, i) => d.wallRoleAt(i) === 'exterior').length,
      interior: l.walls.filter((_, i) => d.wallRoleAt(i) === 'interior').length,
    },
    // 三维渲染面（性能监测要的那几个数）：绘制调用 / 三角形 / 几何体 / 纹理 / 程序。
    // ⭐ 不在三维视图里时是 **null 而不是 0** —— 0 会被后续读成「在画但什么都没画」，
    //    null 才是「没在画」（「读不到」与「读到 0」必须分开）。
    renderInfo: view3d.attached ? view3d.probeRender() : null,
  };
}

const api = {
  stats,
  report: () => JSON.stringify(stats()),

  /**
   * 运行时错误捕获处：
   * 控制台里能看到错误，但"哪一步触发的、哪一行"经常丢。这里把 message + 文件行号 + 堆栈前几帧存下来，
   * 事后一次 `__spatial.errors()` 就能定位。按需渲染 + 异步载模型这类流程，没这个就等于在黑箱里改代码。
   */
  /**
   * R3-7 的对账：平面图的开门几何 vs 三维里真实节点。
   *
   * 平面那边读的是"验收器量出来 + 生成器换算"的静态数据；三维那边是 three.js 加载完的真实节点。
   * 两套来源完全不同，所以对得上才是证据：
   *   hingeMilli  —— 铰链位置差（毫米，平面点 vs 节点世界坐标）；
   *   leafMm      —— 门扇从铰链伸出的长度（三维按门盒子离铰链最远的角点取，会略长一点）；
   *   out2d/out3d —— 沿设备正面法线（局部 +z）的外扩量：必须都是正数（门往柜外开）。
   */
  doorParity: async () => {
    const { item2d } = await import('./scene2d.js');
    const { view3d } = await import('./scene3d.js');
    const { DOORS_MEASURED } = await import('./data/doors.measured.js');
    const rows = [];
    for (const item of d.layout.value.items) {
      const it = item2d(item);
      const w3 = view3d.doorWorld(item.id);
      const md = DOORS_MEASURED[item.p];
      const isLid = !!it?.door?.lidLines?.length;
      if (!it?.door?.measured) {
        rows.push({ id: item.id, p: item.p, kind: 'estimate', ok: null, note: '该型号没有实测门数据，平面走估算路径' });
        continue;
      }
      if (!w3?.doors?.length) {
        rows.push({ id: item.id, p: item.p, kind: isLid ? 'lid' : 'swing', ok: false, note: '三维里没绑到门节点' });
        continue;
      }
      const d3 = w3.doors[0];
      const r = (item.r * Math.PI) / 180;
      const n = [Math.sin(r), Math.cos(r)];          // 设备局部 +z（正面）在平面上的方向
      const h2 = it.door.hinge;
      const h3 = [d3.hinge[0], d3.hinge[2]];
      const dHinge = Math.hypot(h3[0] - h2[0], h3[1] - h2[1]) * 1000;
      const row = {
        id: item.id,
        p: item.p,
        door: d3.node,
        kind: isLid ? 'lid' : 'swing',
        amount: item.doorAmount ?? 0,
        hingeMilli: [Math.round((h3[0] - h2[0]) * 1000), Math.round((h3[1] - h2[1]) * 1000)],
      };
      if (isLid) {
        // 上盖：对账"铰链线在后沿" + "铰链离地高度"（模型里 920 mm 那种）
        const y2 = Math.round(((md?.doors?.[0]?.hinge?.y) ?? 0) * 1000);
        const y3 = Math.round(d3.hinge[1] * 1000);
        row.lidLineZ = it.door.lidLines[0][0][1];
        row.hingeYmm = [y2, y3];
        row.ok = dHinge <= 5 && Math.abs(y2 - y3) <= 5 && it.door.sectors.length === 0;
      } else {
        const sec = it.door.sectors[0];
        // 三维侧取"最朝外"的盒子角点，与平面的门扇末端同口径比
        let tip3 = null;
        let best = -Infinity;
        for (const bx of [d3.boxMin[0], d3.boxMax[0]]) {
          for (const bz of [d3.boxMin[2], d3.boxMax[2]]) {
            const t = (bx - h3[0]) * n[0] + (bz - h3[1]) * n[1];
            if (t > best) { best = t; tip3 = [bx, bz]; }
          }
        }
        const out2 = (sec.leafEnd[0] - h2[0]) * n[0] + (sec.leafEnd[1] - h2[1]) * n[1];
        const out3 = (tip3[0] - h3[0]) * n[0] + (tip3[1] - h3[1]) * n[1];
        row.leafMm = [Math.round(Math.hypot(sec.leafEnd[0] - h2[0], sec.leafEnd[1] - h2[1]) * 1000), Math.round(Math.hypot(tip3[0] - h3[0], tip3[1] - h3[1]) * 1000)];
        row.swingMm = Math.round(sec.radius * 1000);
        row.outMm = [Math.round(out2 * 1000), Math.round(out3 * 1000)];
        // 判据：铰链对得上（≤5 mm）；开门时两边都要往外走；关门时外扩量为 0 是正常的
        row.ok = dHinge <= 5 && (row.amount <= 0.001 ? true : out2 > 0 && out3 > 0);
      }
      rows.push(row);
    }
    const checked = rows.filter((x) => typeof x.ok === 'boolean');
    return JSON.stringify({ passed: checked.filter((x) => x.ok).length, total: checked.length, rows });
  },

  errors: () => JSON.stringify(runtimeErrors),
  clearErrors: () => { runtimeErrors.length = 0; return '[]'; },

  /** 目录索引 0..3 → 放入布局 */
  add: (i) => { d.add(d.catalog[i].id); return api.report(); },
  remove: (id) => { d.remove(id); return api.report(); },
  move: (id, x, z) => { d.beginEdit(); d.setPosition(id, x, z); return api.report(); },
  rotate: (id, deg) => { d.rotate(id, deg); return api.report(); },
  door: (id, amount) => { d.setDoor(id, amount); return api.report(); },
  select: (id) => { d.selectItem(id); return api.report(); },
  /** 画一面墙（探针用）—— 走的是设计器那条路，所以吸附/校验/撤销口径与界面完全一致 */
  addWall: (a, b, opts = {}) => { d.addWall(a, b, opts); return api.report(); },
  /** 改一面墙的端点（探针用：跨房墙编辑一致 —— 改一处、两间边界同变、墙池只改 1 条） */
  updateWall: (i, x1, z1, x2, z2) => { d.updateWall(i, { a: [x1, z1], b: [x2, z2], openings: [] }); return api.report(); },
  removeWall: (i) => { d.removeWall(i); return api.report(); },
  /**
   * 改一面墙的角色（P4）：走 `designer.setWallRole` —— 与右栏那个开关同一条路，
   * 所以「非贴边墙设成外墙会被内核拒（`wall-not-on-edge`）」这件事在探针里也成立。
   */
  setWallRole: (i, role) => { d.setWallRole(i, role); return api.report(); },
  wallStyle: (k) => { d.setWallStyle(k); return api.report(); },
  /**
   * 门洞（W1）：放/删/改/选。
   * 走的是与界面同一个 `designer` 动作 —— 夹取、上限、提示口径完全一致（探针测的就是用户按的那条路）。
   */
  addOpening: (wallIndex, at, w, h) => { d.addOpening(wallIndex, { at, w, h }); return api.report(); },
  /** 拖一段定宽那条路（span = [起, 止] 弧长） */
  addOpeningSpan: (wallIndex, s0, s1) => { d.addOpening(wallIndex, { span: [s0, s1] }); return api.report(); },
  /** 窗（W2）：`sill` 不传就用参数表的默认离地；`kind: 'window'` 走的是与界面同一个动作 */
  addWindow: (wallIndex, at, w, h, sill) => { d.addOpening(wallIndex, { at, w, h, sill, kind: 'window' }); return api.report(); },
  removeOpening: () => { d.removeOpening(); return api.report(); },
  updateOpening: (patch = {}) => { d.updateOpening(patch); return api.report(); },
  selectOpening: (wi, oi) => { d.selectOpening(wi, oi); return api.report(); },
  openingMode: (v) => { d.setOpeningMode(v); return api.report(); },
  clear: () => { d.clearAll(); return api.report(); },
  undo: () => { d.undo(); return api.report(); },
  redo: () => { d.redo(); return api.report(); },

  /**
   * ⭐ 漫游态的开关（FIX-15 的机器断言口）。
   *
   * 真机里进第一人称要 pointer lock，headless 里做不稳 —— 但没有指针锁定也**能**验这条规矩：
   * 探针自己把「漫游中」置上，再发一次真的 Ctrl+Z，看画布有没有被改。
   * 两侧都做（置上→不动、取下→会动）才叫证据。
   */
  setWalking: (v) => { setWalking(v); return JSON.stringify({ walking: walking.value }); },
  isWalking: () => JSON.stringify({ walking: walking.value }),
  reset: () => { d.reset(); return api.report(); },

  room: (w, dd, h) => {
    const ok = d.applyRoom({ w, d: dd, h });
    return JSON.stringify({ ok, ...stats() });
  },
  /* ---------------- 房间（M1）---------------- */
  /** 画一间房（拖一个矩形）：`addRoomRect(0,0,4,6)` = 从 (0,0) 到 (4,6) */
  addRoomRect: (x0, z0, x1, z1) => { d.addRoomRect({ x0, z0, x1, z1 }); return api.report(); },
  /** 切分：`splitRoom(3,3,5,3)` = 在 (3,3)→(5,3) 拖一条线（两端自动接到墙上） */
  splitRoom: (x1, z1, x2, z2) => { d.splitRoom({ a: [x1, z1], b: [x2, z2] }); return api.report(); },
  selectRoom: (id) => { d.selectRoom(id); return api.report(); },
  /** 这个点在哪一间？（-1 = 不在任何一间：墙上/整栋外）—— 探针用它断言"人走到哪一间了" */
  roomAtPoint: (x, z) => {
    const r = roomsKernel.roomAt(d.layout.value, x, z);
    const list = d.roomList.value;
    return JSON.stringify({ id: r ? r.id : null, index: r ? list.findIndex((q) => q.id === r.id) : -1 });
  },
  renameRoom: (id, name) => { d.setRoomName(id, name); return api.report(); },
  toggleRoomThumbs: () => JSON.stringify({ roomThumbsVisible: d.toggleRoomThumbs() }),
  roomMode: (m) => { if (d.roomMode.value !== m) d.setRoomMode(m); return api.report(); },
  focusRoom: (id) => { d.focusRoom(id); return api.report(); },
  focusBuilding: () => { d.focusBuilding(); return api.report(); },
  walkInto: (id) => { d.walkInto(id); return api.report(); },
  /** 房间读数（专门给探针用的一份，比 stats 短） */
  rooms: () => JSON.stringify({
    count: d.roomCount.value,
    list: d.roomList.value.map((r) => ({ id: r.id, displayName: r.displayName, area: r.area, sliver: r.sliver })),
    labels: d.layout.value.roomLabels ?? {},
    waiting: d.waitingNames.value,
    party: d.partyWalls.value,
    thumbs: d.roomThumbs.value,
  }),

  wall: (x1, z1, x2, z2) => {
    const ok = d.addWall([x1, z1], [x2, z2]);
    return JSON.stringify({ ok, ...stats() });
  },

  /** 导出文本（验证格式与字节数） */
  export: () => scheme.exportScheme(d.layout.value),

  /** 往返一致性：导出 → 导入 → 再导出，逐字节比较（FIX-05 的现场版） */
  roundtrip: () => {
    const a = scheme.exportScheme(d.layout.value);
    const r = scheme.importScheme(a, { getProduct });
    if (!r.ok) return JSON.stringify({ ok: false, reason: r.reason, message: r.message });
    const b = scheme.exportScheme(r.layout);
    return JSON.stringify({ ok: true, identical: a === b, bytes: a.length, nextId: r.nextId, items: r.layout.items.length });
  },

  /**
   * 导入一段**导出文本**（探针用）：走的是与界面「导入方案」同一条内核路
   * （`scheme.importScheme`，经 `designer.applyServerState`），所以旧标识文件在这里
   * 也会得到 `roomSemantics = legacy` —— 旧方案转换预检（P4）就靠这条造现场。
   * 传 `{format, state}` 的对象或它的 JSON 文本都行。
   */
  importText: (input) => {
    let obj = input;
    if (typeof input === 'string') {
      try { obj = JSON.parse(input); } catch (e) { return JSON.stringify({ ok: false, message: '不是合法的 JSON' }); }
    }
    if (!obj || typeof obj !== 'object' || !obj.state) return JSON.stringify({ ok: false, message: '缺少 state' });
    const ok = d.applyServerState(obj.state, obj.format ?? null);
    return JSON.stringify({ ok, ...stats() });
  },

  /** 内核自检：把内核的对外约定当场跑一遍（界面无关，纯函数） */
  kernel: () => {
    const l = room.createLayout({ w: 8, d: 6 });
    const item = { id: 1, p: 'demo-ct-scanner', x: 0.576, z: 0.576, r: 0, doorAmount: 0 };
    const flush = validate.checkItem({ ...l, items: [] }, item, getProduct);
    const out = validate.checkItem({ ...l, items: [] }, { ...item, x: 0.1 }, getProduct);
    const overlap = validate.checkItem(
      { ...l, items: [{ ...item, id: 2, x: 0.7, z: 0.7 }] },
      item,
      getProduct,
    );
    return JSON.stringify({
      flushWallOk: flush === null,
      outOfRoom: out,
      overlap: overlap,
      hinge: doors.hingeRotation({ axis: 'y', openAngle: 1.85 }, 0.5),
      maxItems: params.cfg.layout.maxItems,
      formats: scheme.ACCEPTED_FORMATS,
      roomLimits: room.roomLimits(),
      ext90: geometry.extents(1.2, 0.6, 90),
    });
  },

  /**
   * 规则 7 的算力体检：满员（布置上限）时算一次开门净空要多少毫秒。
   * 为什么值得单独量：逐度扫掠是 O(台数² × 度数)，它是这套界面里最贵的一次计算，
   * 而且是**每次改动都会重算**的（平面图要按分级着色）。100 台时的数字决定它能不能这么用。
   */
  clearancePerf: () => {
    const t0 = performance.now();
    const rows = clearance.clearanceReport(d.layout.value, getProduct);
    const ms = performance.now() - t0;
    const steps = Math.ceil(106 / params.cfg.door.sweepStepDeg);
    return JSON.stringify({
      items: d.layout.value.items.length,
      doors: rows.length,
      sweepStepsPerDoor: steps,
      ms: +ms.toFixed(1),
      msPer: +(ms / Math.max(1, rows.length)).toFixed(3),
    });
  },

  /**
   * 规则参数表：`__spatial.params()` 看当前生效值 + 默认值 + 后台表单定义（schema）。
   * `__spatial.configure({door:{openOkDeg:70}})` 现场改配置 —— **不用改代码、不用重新构建**。
   * 这是"后台做好之前的临时入口"，也是"配置真的生效"最容易验证的地方。
   */
  params: () => JSON.stringify({
    active: params.snapshot(),
    defaults: params.defaultParams(),
    schema: params.schema(),
    // 内核**此刻按哪一版在算**（本地算的指纹）。它与 `live.rev` 不一致时说明中间出了岔子 ——
    // 这正是"配置到底生效没有"要能回答的那一个问题（R6-4 B4d 的"双显"也读这里）。
    rev: params.fingerprint(),
    // 服务端那一版：从哪来（server/default）、rev、有没有被拒的库值
    live: liveParams.state,
  }),

  /** 现场改配置（校验不过就抛错，不会改一半） */
  configure: (patch) => {
    try {
      params.configure(patch);
      return JSON.stringify({ ok: true, active: params.snapshot(), errors: [] });
    } catch (e) {
      return JSON.stringify({ ok: false, errors: e.errors ?? [], message: e.message });
    }
  },

  /** 恢复出厂默认（同样原地改，界面引用不会失效） */
  resetParams: () => { params.resetParams(); return JSON.stringify({ ok: true, active: params.snapshot() }); },

  /**
   * 在内核上现场跑那张用例表（与 `npm test` 跑的是**同一个执行器**）。
   * 意义：证明界面调用的规则与断言验证的规则是**同一份实现**，不是两份各自碰巧一致。
   * （新增规则时记得把模块也传进来 —— 漏传的表现是“Cannot read properties of undefined”，
   *   而且只有那一组用例失败、其余照常通过，很容易误看成“新规则写错了”。）
   */
  parity: () => {
    const results = runCases(caseTable, { room, validate, placement, scheme, doors, clearance, collision, geometry, getProduct });
    return JSON.stringify({
      ...summarize(results),
      failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, why: r.why, mismatches: r.mismatches })),
    });
  },

  /** 上限与空位：连添 101 次，第 101 次应被拦下（FIX-06 的现场版） */
  stress: () => {
    d.reset();
    d.applyRoom({ w: 20, d: 20, h: 2.8 });
    for (let i = 0; i < 101; i++) d.add('demo-freezer-dual');
    return JSON.stringify({
      items: d.layout.value.items.length,
      cap: params.cfg.layout.maxItems,
      blocked: d.layout.value.items.length === params.cfg.layout.maxItems,
      message: d.message.value,
      status: validate.statusText(d.layout.value, getProduct),
      idsUnique: new Set(d.layout.value.items.map((i) => i.id)).size === d.layout.value.items.length,
      roundtrip: JSON.parse(api.roundtrip()),
    });
  },

  /** 一键搭出演示场景：3 台设备 + 2 面内墙 + 90° 旋转 */
  demo: () => {
    d.reset();
    d.add('demo-ct-scanner');
    d.add('demo-freezer-dual');
    d.add('demo-freezer-dual');
    const ids = d.layout.value.items.map((i) => i.id);
    d.setPosition(ids[0], 0.7, 0.7);
    d.setPosition(ids[1], 2.2, 0.7);
    d.setPosition(ids[2], 4.0, 2.6);
    d.rotate(ids[2], 90);
    d.addWall([0.5, 4.2], [7.5, 4.2]);
    d.addWall([7.5, 4.2], [7.5, 5.6]);
    d.selectItem(ids[0]);
    d.setDoor(ids[0], 0.5);
    return api.report();
  },

  /* ---------------- 三维 ----------------
   * 全部用动态 import：没打开三维视图时，three.js（~600 KB）不会被拖进入口包。
   * 这几个探针不是"界面截图"，而是**可判定的量**：模型面数、包围盒、铰链坐标、当前帧绘制量。
   */
  mode: (m) => { d.mode.value = m; return JSON.stringify({ mode: d.mode.value }); },

  /** 等一个条件成立（隐藏标签页里 setTimeout 会被拖慢到 ~1s 一次，所以给足宽限） */
  waitFor: (fn, timeoutMs = 8000) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      let v = null;
      try { v = fn(); } catch { v = null; }
      if (v) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 40);
    };
    tick();
  }),

  /**
   * 三个固定视角各截一张（R6-5 / A13）。
   *
   * 为什么放进 QA 接口：交付包里的三张图**只有浏览器画得出来**，而真机探针需要
   * 把这三张图**拿出来给人核对**（相机参数是用户口述、由我译成方位角/俯仰角的 ——
   * 给他看图比给他读参数直接得多）。
   *
   * 与面板里那条路走的是**同一个函数**（`view3d.shotView`）：探针看到的机位，
   * 就是用户打交付包时用的机位 —— 不是另算一套。
   */
  shots: async () => {
    const { view3d } = await import('./scene3d.js');
    const { SHOT_VIEWS } = await import('./views3d.js');
    return JSON.stringify(SHOT_VIEWS.map((v) => ({
      id: v.id,
      label: v.label,
      how: `${v.azimuthDeg}° / ${v.elevationDeg}°`,
      url: view3d.shotView(v),
    })));
  },

  three: async () => {
    const { view3d } = await import('./scene3d.js');
    return JSON.stringify(view3d.probe());
  },
  /**
   * 离屏截一张封面（#5）—— 走的是**保存方案时同一条路**（`scene3d.snapshotOffscreen` + 固定 front45）。
   * 放进 QA 接口是为了能在**平面图模式下**断言它真的出图（用户报的"列表缺封面"就出在这里）。
   */
  coverShot: async () => {
    const { view3d } = await import('./scene3d.js');
    const { SHOT_VIEWS } = await import('./views3d.js');
    const view = SHOT_VIEWS.find((v) => v.id === 'front45') || SHOT_VIEWS[0];
    const url = await view3d.snapshotOffscreen(d.layout.value, view);
    return JSON.stringify({
      bytes: url ? url.length : 0,
      view: view && view.id,
      size: url ? view3d.probe().size : null,
      errors: runtimeErrors.slice(-3),
    });
  },
  /** 强制渲染一帧并回报绘制量 —— 本环境 rAF 暂停，必须能手动出帧 */
  threeRender: async () => {
    const { view3d } = await import('./scene3d.js');
    return JSON.stringify(view3d.renderOnce());
  },
  threeLevel: async (l) => {
    const { view3d } = await import('./scene3d.js');
    await view3d.setLevel(l);
    return JSON.stringify(view3d.probe());
  },
  threeView: async (v) => {
    const { view3d } = await import('./scene3d.js');
    view3d.setView(v);
    return JSON.stringify(view3d.probe());
  },
  /** 第一人称：不用鼠标也能验（键盘/脚本驱动），汇报位置与朝向 */
  threeWalk: async (fwd, right) => {
    const { view3d } = await import('./scene3d.js');
    return JSON.stringify(view3d.walkMove(fwd, right));
  },
  threeLook: async (yaw, pitch) => {
    const { view3d } = await import('./scene3d.js');
    return JSON.stringify(view3d.walkLook(yaw, pitch));
  },
  /** 模型自检：每一款每一级都真加载 + 量尺寸 + 核对铰链（与离线验收器对账） */
  threeSelf: async () => {
    const { view3d } = await import('./scene3d.js');
    return JSON.stringify(await view3d.selfTest());
  },
  /** 切到三维 + 搭演示场景（等组件挂上再继续） */
  threeDemo: async () => {
    d.mode.value = '3d';
    const { view3d } = await import('./scene3d.js');
    await api.waitFor(() => view3d.attached);
    api.demo();
    await view3d.setLayout(d.layout.value);
    return JSON.stringify(view3d.probe());
  },
};

if (typeof window !== 'undefined') {
  const push = (kind, e) => {
    if (runtimeErrors.length >= 30) return;
    const err = e?.error ?? e?.reason ?? null;
    runtimeErrors.push({
      t: new Date().toISOString().slice(11, 19),
      kind,
      msg: e?.message ?? e?.reason?.message ?? String(e?.reason ?? ''),
      at: e?.filename ? `${String(e.filename).split('/').pop()}:${e.lineno}` : null,
      stack: err?.stack ? String(err.stack).split('\n').slice(0, 4).map((s) => s.trim()).join(' ← ') : null,
    });
  };
  window.addEventListener('error', (e) => push('error', e));
  window.addEventListener('unhandledrejection', (e) => push('rejection', e));
  window.__spatial = api;
}
export default api;