/**
 * room-expand.test.js —— 房间画到空间外时**自动扩大整栋**（`room.expandToInclude`）
 *
 * 病灶：画房间的手势只加墙、不动 `layout.w/d`，于是"画到外面"会留下越界墙，
 * 服务端 import 判 `wall-out-of-room`、保存失败。用户拍板：房间画到空间外就
 * **把整栋扩到包含它**；向左/上扩时整体平移墙和设备，房名跟着迁移。
 *
 * 口径（`task-26`）：右/下/左/上/左上同时扩 · 新 w/d 过 `roomLimits()`（超限报错、不夹取）·
 * 旧外墙不留在墙池里、按新尺寸重建 · 老外墙上的门窗跟着**同一个物理位置**搬到新外墙 ·
 * 内墙和 items 整体平移 · 房名按"平移后的房间"迁移、不丢 · 返回 no-op / changed 两种结果。
 *
 * 每条判据都写清**变异点**（怎么改代码会让它变红）—— 本项目规矩：永远绿的用例比没有用例更坏。
 * 成对出现的判据（no-op / changed、名字搬走 / 名字留下、洞口保留 / 洞口丢弃）两条都在场。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resetParams } from '../src/params.js';
import {
  boundaryWalls, expandToInclude, isBoundaryWall, roomRangeText,
} from '../src/room.js';
import { checkAllWalls } from '../src/validate.js';
import { roomsOf, roomAreaTotal, roomAt } from '../src/rooms.js';
import { mkWallSeg, wallSeg, openingsOf, WINDOW } from '../src/wall.js';

const W = (x, z, xx, zz, openings) => mkWallSeg(x, z, xx, zz, openings ?? []);
const ITEM = (id, x, z, r = 0, doorAmount = 0) => ({ id, p: 'demo-cabinet-800', x, z, r, doorAmount });

/** 8×6 的整栋 + 可选内墙 / 设备 / 房名 */
const base = ({ w = 8, d = 6, inner = [], items = [], labels } = {}) => ({
  w,
  d,
  h: 2.8,
  walls: [...boundaryWalls(w, d), ...inner],
  items,
  ...(labels ? { roomLabels: labels } : {}),
});

/** 墙的无向比较键（端点顺序不重要：外墙重建时方向可能与旧的相反） */
const key = (wl) => {
  const [x, z, xx, zz] = wallSeg(wl);
  const r = (n) => Math.round(n * 1000) / 1000;
  return [Math.min(x, xx), Math.min(z, zz), Math.max(x, xx), Math.max(z, zz)].map(r).join(',');
};

/**
 * 一次扩空间之后**所有硬判据**（task-26 第 8 条）：新 layout 自身要干净、也要铺满。
 * 变异点：旧外墙留在墙池里 → 墙数/外墙集合变红；新 w/d 算错 → 面覆盖变红；
 *        新外墙没按新尺寸重建 → `checkAllWalls` 报 wall-out-of-room。
 */
function assertExpanded(r, w, d) {
  assert.equal(r.ok, true, '应当扩成功');
  assert.equal(r.changed, true, '越界时 changed 必须为 true');
  assert.equal(r.w, w);
  assert.equal(r.d, d);
  assert.equal(r.layout.w, w);
  assert.equal(r.layout.d, d);
  assert.equal(r.layout.h, 2.8, '墙高不跟着变');
  assert.deepEqual(checkAllWalls(r.layout), [], '新 layout 不许有任何墙落在空间外');
  const area = roomAreaTotal(r.layout);
  assert.ok(Math.abs(area - w * d) < 1e-6, `房面覆盖守恒：${area} ≠ ${w}×${d}`);
  const boundary = r.layout.walls.filter((wl) => isBoundaryWall(r.layout, wl));
  assert.equal(boundary.length, 4, '外墙恰好四面（旧外墙必须被剔除，不许两套并存）');
  assert.deepEqual(boundary.map(key).sort(), boundaryWalls(w, d).map(key).sort(),
    '外墙必须按新尺寸重建');
}

/* ---------------- 一、no-op：矩形已经在空间里 ---------------- */

test('no-op：矩形已在空间内 → 同一个 layout / 同一个 rect，不复制、不改', () => {
  resetParams();
  const layout = base({ inner: [W(4, 0, 4, 6)], items: [ITEM(1, 2, 2)] });
  layout.view = { wallOpacity: 'glass' };
  const before = JSON.stringify(layout);
  const rect = { x0: 1, z0: 1, x1: 5, z1: 5 };
  const r = expandToInclude(layout, rect);

  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  // 变异点：no-op 也走复制 → 下面两条立刻红（调用方会拿到"看起来一样但不是同一份"的布局）
  assert.equal(r.layout, layout, 'no-op 必须原样返回同一个 layout 对象');
  assert.equal(r.rect, rect, 'no-op 必须原样返回同一个 rect');
  assert.equal(JSON.stringify(layout), before, 'no-op 不许改动入参');

  // 贴边（画到 0..w 正好铺满）也算"在里面"，不许为 1e-9 级差异重建整栋
  const edge = expandToInclude(layout, { x0: 0, z0: 0, x1: 8, z1: 6 });
  assert.equal(edge.changed, false);
  assert.equal(edge.layout, layout);
});

/* ---------------- 二、四个方向 + 左上同时扩 ---------------- */

test('右扩：w 变大、d 不变；dx=dz=0；内墙与设备原地不动', () => {
  resetParams();
  const layout = base({ inner: [W(4, 0, 4, 6)], items: [ITEM(1, 6, 4, 90, 2)] });
  const before = JSON.stringify(layout);
  const r = expandToInclude(layout, { x0: 6, z0: 1, x1: 10, z1: 5 });

  assertExpanded(r, 10, 6);
  assert.equal(JSON.stringify(layout), before, '纯函数：扩空间不许改动入参 layout');
  assert.equal(r.dx, 0);
  assert.equal(r.dz, 0);
  assert.deepEqual(r.rect, { x0: 6, z0: 1, x1: 10, z1: 5 }, '右扩不需要平移画的那个矩形');
  assert.ok(r.layout.walls.some((wl) => key(wl) === key(W(4, 0, 4, 6))), '内墙不该被挪位置');
  assert.deepEqual(r.layout.items, [ITEM(1, 6, 4, 90, 2)], '设备原地不动（含 r / doorAmount）');
  assert.equal(roomsOf(r.layout).length, 2, '竖向隔墙仍到底，两间仍是两间');
});

test('下扩：d 变大、w 不变；dz=0；横向隔墙把新深度照样切开（两间）', () => {
  resetParams();
  const layout = base({ inner: [W(0, 3, 8, 3)], items: [ITEM(1, 2, 4)] });
  const r = expandToInclude(layout, { x0: 1, z0: 4, x1: 5, z1: 9 });

  assertExpanded(r, 8, 9);
  assert.equal(r.dx, 0);
  assert.equal(r.dz, 0);
  assert.deepEqual(r.rect, { x0: 1, z0: 4, x1: 5, z1: 9 });
  assert.deepEqual(r.layout.items, [ITEM(1, 2, 4)]);
  assert.equal(roomsOf(r.layout).length, 2);
  assert.equal(roomAreaTotal(r.layout), 72);
});

test('左扩：w 变大、dx>0 —— 所有内墙/设备整体右移；旧左外墙不许以隔墙形式留下', () => {
  resetParams();
  const layout = base({
    inner: [W(4, 0, 4, 6, [{ at: 3, w: 0.9, h: 2.1 }])],
    items: [ITEM(1, 6, 4, 45, 1)],
  });
  const r = expandToInclude(layout, { x0: -2, z0: 1, x1: 2, z1: 5 });

  assertExpanded(r, 10, 6);
  assert.equal(r.dx, 2);
  assert.equal(r.dz, 0);
  assert.deepEqual(r.rect, { x0: 0, z0: 1, x1: 4, z1: 5 }, '返回的 rect 要跟着新坐标系平移');
  // 变异点：内墙不跟着 dx → 下面的 x=6 找不到、x=4 那条旧墙还在
  const moved = r.layout.walls.find((wl) => key(wl) === key(W(6, 0, 6, 6)));
  assert.ok(moved, '内墙整体右移 2 m');
  assert.equal(openingsOf(moved).length, 1, '内墙上的洞口连墙一起走');
  assert.equal(openingsOf(moved)[0].at, 3, '洞口 at 是相对墙的弧长，墙平移时不变');
  assert.equal(r.openingsKept, 1);
  assert.equal(r.openingsDropped, 0);
  // 旧左外墙被剔除：它平移后是 x=2 的一条通墙，留着就会凭空多出一间
  assert.ok(!r.layout.walls.some((wl) => key(wl) === key(W(2, 0, 2, 6))),
    '旧左外墙不许以 x=2 的隔墙形式留在墙池里');
  assert.deepEqual(r.layout.items, [ITEM(1, 8, 4, 45, 1)], '设备整体右移 2 m，其余字段不变');
  assert.equal(roomsOf(r.layout).length, 2);
  assert.equal(r.keptWalls, 1);
});

test('上扩：d 变大、dz>0 —— 内墙/设备整体下移；旧上外墙不许以 z=1.5 的隔墙形式留下', () => {
  resetParams();
  const layout = base({ inner: [W(0, 3, 8, 3)], items: [ITEM(1, 2, 4)] });
  const r = expandToInclude(layout, { x0: 1, z0: -1.5, x1: 5, z1: 2 });

  assertExpanded(r, 8, 7.5);
  assert.equal(r.dx, 0);
  assert.equal(r.dz, 1.5);
  assert.deepEqual(r.rect, { x0: 1, z0: 0, x1: 5, z1: 3.5 });
  assert.ok(r.layout.walls.some((wl) => key(wl) === key(W(0, 4.5, 8, 4.5))), '横向隔墙下移 1.5 m');
  assert.ok(!r.layout.walls.some((wl) => key(wl) === key(W(0, 1.5, 8, 1.5))),
    '旧上外墙不许以 z=1.5 的通墙形式留下');
  assert.deepEqual(r.layout.items, [ITEM(1, 2, 5.5)]);
  assert.equal(roomsOf(r.layout).length, 2);
});

test('左上同时扩：dx=2、dz=1.5、w=10、d=7.5；内墙/设备一次平移到位', () => {
  resetParams();
  const layout = base({ inner: [W(4, 0, 4, 6)], items: [ITEM(1, 6, 4)] });
  const r = expandToInclude(layout, { x0: -2, z0: -1.5, x1: 1, z1: 1 });

  assertExpanded(r, 10, 7.5);
  assert.equal(r.dx, 2);
  assert.equal(r.dz, 1.5);
  assert.deepEqual(r.rect, { x0: 0, z0: 0, x1: 3, z1: 2.5 });
  assert.ok(r.layout.walls.some((wl) => key(wl) === key(W(6, 1.5, 6, 7.5))));
  assert.deepEqual(r.layout.items, [ITEM(1, 8, 5.5)]);
  assert.equal(r.layout.walls.length, 5, '四面新外墙 + 一面内墙');
  // 已知几何后果：竖隔墙与**新上外墙**之间留了 1.5 m 缺口 → 上面那条带子把两间连通
  // （旧外墙剔除 + 内墙整体平移的必然结果，房名的处理见房名用例）
  assert.equal(roomsOf(r.layout).length, 1, '左+上同时扩会把平行于扩张轴的房间连通');
});

/* ---------------- 三、外墙上的门窗：跟着同一个物理位置搬 ---------------- */

test('门洞随外墙搬：左扩后顶墙上的门在**同一个物理位置**（at + dx），不是留在原地', () => {
  resetParams();
  const layout = base();
  layout.walls[0] = W(0, 0, 8, 0, [{ at: 3, w: 0.9, h: 2.1 }]);   // 顶墙（T：a=(0,0)）
  const r = expandToInclude(layout, { x0: -2, z0: 1, x1: 2, z1: 5 });

  assertExpanded(r, 10, 6);
  const top = r.layout.walls.find((wl) => key(wl) === key(W(0, 0, 10, 0)));
  assert.ok(top, '顶墙按新长度重建');
  const os = openingsOf(top);
  assert.equal(os.length, 1, '门洞必须搬到新顶墙上（不许留在已剔除的旧顶墙上）');
  // 变异点：沿用旧 at（=3）→ 下面变红；那会把门悄悄挪进新扩出来的左侧空带
  assert.equal(os[0].at, 5, '物理位置不变：旧 at=3 + dx=2');
  assert.equal(os[0].w, 0.9);
  assert.equal(os[0].h, 2.1);
  assert.equal(r.openingsKept, 1);
  assert.equal(r.openingsDropped, 0);
  // 全屋只有一个洞：不许"旧墙丢一个、新墙又来一个"
  assert.equal(r.layout.walls.reduce((n, wl) => n + openingsOf(wl).length, 0), 1);
});

test('底墙方向相反也要算对：右扩后底墙的 at 变 w−x（不是原样带走）', () => {
  resetParams();
  const layout = base();
  layout.walls[2] = W(8, 6, 0, 6, [{ at: 2, w: 1, h: 2.1 }]);     // 底墙（B：a=(w,d)，向左走）
  // 旧底墙 at=2 → 洞口中心在世界 x = 8−2 = 6
  const r = expandToInclude(layout, { x0: 6, z0: 1, x1: 10, z1: 5 });

  assertExpanded(r, 10, 6);
  const bottom = r.layout.walls.find((wl) => key(wl) === key(W(10, 6, 0, 6)));
  assert.ok(bottom, '底墙按新长度重建');
  assert.equal(openingsOf(bottom)[0].at, 4, '世界 x=6 在新底墙（a=(10,6) 向左）上是 at=4');
  // 变异点：不看墙的端点方向、把 at 原样搬到新墙 → 门会从 x=6 跳到 x=8
  assert.equal(r.openingsKept, 1);
  assert.equal(r.openingsDropped, 0);
});

test('窗同样搬家，且不许降级成门：kind / sill 原样带走', () => {
  resetParams();
  const layout = base();
  layout.walls[0] = W(0, 0, 8, 0, [{ at: 5, w: 1.2, h: 1, kind: WINDOW, sill: 0.9 }]);
  const r = expandToInclude(layout, { x0: -2, z0: 1, x1: 2, z1: 5 });

  assertExpanded(r, 10, 6);
  const top = r.layout.walls.find((wl) => key(wl) === key(W(0, 0, 10, 0)));
  // 变异点：手抄 {at,w,h}（不走 cloneOpening）→ 窗降级成落地门洞，这里红
  assert.deepEqual(openingsOf(top), [{ at: 7, w: 1.2, h: 1, kind: WINDOW, sill: 0.9 }]);
  assert.equal(r.openingsKept, 1);
  assert.equal(r.openingsDropped, 0);
});

test('放不下的洞口要丢，但**报出来**（openingsDropped），不许静默留在新墙上', () => {
  resetParams();
  const layout = base();
  // 旧数据本身就不合法：at=0.2 / w=1 → 洞口跨到墙外（span −0.3..0.7）
  layout.walls[0] = W(0, 0, 8, 0, [{ at: 0.2, w: 1, h: 2.1 }]);
  const r = expandToInclude(layout, { x0: 6, z0: 1, x1: 10, z1: 5 });

  assertExpanded(r, 10, 6);
  assert.equal(r.openingsKept, 0);
  // 变异点：只保留不计数（或干脆不看结构合法性）→ 这条红
  assert.equal(r.openingsDropped, 1, '放不下的洞口必须计数');
  const top = r.layout.walls.find((wl) => key(wl) === key(W(0, 0, 10, 0)));
  assert.equal(openingsOf(top).length, 0, '放不下的洞口不许留在新墙上');
});

/* ---------------- 四、房名迁移（保证不丢） ---------------- */

test('房名迁移（左扩 · 两间不合并）：名字全搬到新 id，且跟着**同一间房**走', () => {
  resetParams();
  const layout = base({ inner: [W(4, 0, 4, 6)] });
  const oldRooms = roomsOf(layout);
  assert.equal(oldRooms.length, 2);
  const labels = Object.fromEntries(oldRooms.map((rm, i) => [rm.id, i === 0 ? '冷藏间' : '操作间']));
  layout.roomLabels = labels;

  const r = expandToInclude(layout, { x0: -2, z0: 1, x1: 2, z1: 5 });
  assertExpanded(r, 10, 6);
  const nextRooms = roomsOf(r.layout);
  assert.equal(nextRooms.length, 2, '左扩时竖隔墙仍到底，间数不变');
  assert.equal(Object.keys(r.layout.roomLabels).length, 2, '两个名字都在，一个都不许丢');
  assert.deepEqual(Object.values(r.layout.roomLabels).sort(), ['冷藏间', '操作间'].sort());
  // 旧 id 一个都不许再当键（几何一变 id 就变；留着等于名字挂在空气上）
  for (const old of oldRooms) assert.ok(!(old.id in r.layout.roomLabels), `旧 id ${old.id} 应当搬走`);

  // 变异点：只按"房间顺序"瞎配、或拿未平移的旧位置去找 → 名字会挂到隔壁间
  for (const old of oldRooms) {
    const p = old.labelAt;
    const target = roomAt(r.layout, p[0] + r.dx, p[1] + r.dz);
    assert.ok(target, '平移后的旧房间位置要落在某一间新房里');
    assert.equal(r.layout.roomLabels[target.id], labels[old.id], '名字必须跟着这一间房');
  }
});

test('房名迁移（上扩 · 两间不合并）：dz 方向的平移也要算进去', () => {
  resetParams();
  const layout = base({ inner: [W(0, 3, 8, 3)] });
  const oldRooms = roomsOf(layout);
  const labels = Object.fromEntries(oldRooms.map((rm, i) => [rm.id, i === 0 ? '备餐间' : '洗涤间']));
  layout.roomLabels = labels;

  const r = expandToInclude(layout, { x0: 1, z0: -1.5, x1: 5, z1: 2 });
  assertExpanded(r, 8, 7.5);
  assert.equal(roomsOf(r.layout).length, 2);
  assert.deepEqual(Object.values(r.layout.roomLabels).sort(), ['备餐间', '洗涤间'].sort());
  for (const old of oldRooms) {
    const target = roomAt(r.layout, old.labelAt[0], old.labelAt[1] + 1.5);
    assert.ok(target);
    assert.equal(r.layout.roomLabels[target.id], labels[old.id]);
  }
});

test('房间被并成一间时：一个名字继承，另一个**不删**（留在旧 id 上等房间回来）', () => {
  resetParams();
  const layout = base({ inner: [W(4, 0, 4, 6)] });
  const oldRooms = roomsOf(layout);
  const labels = Object.fromEntries(oldRooms.map((rm, i) => [rm.id, i === 0 ? '冷藏间' : '操作间']));
  layout.roomLabels = labels;

  // 下扩：竖隔墙到 z=6 就停了，新 d=9 → 下面那条带子把两间连通（几何上真的只有一间）
  const r = expandToInclude(layout, { x0: 1, z0: 4, x1: 5, z1: 9 });
  assertExpanded(r, 8, 9);
  assert.equal(roomsOf(r.layout).length, 1, '竖隔墙够不到新底墙 → 两间并成一间');
  assert.equal(Object.keys(r.layout.roomLabels).length, 2, '名字一个都不许丢（与 cleanRoomLabels 同口径）');
  assert.deepEqual(Object.values(r.layout.roomLabels).sort(), ['冷藏间', '操作间'].sort());
  const named = roomsOf(r.layout).filter((rm) => rm.id in r.layout.roomLabels);
  assert.equal(named.length, 1, '存活的这间拿到一个名字');
  const waiting = oldRooms.filter((rm) => rm.id in r.layout.roomLabels);
  assert.equal(waiting.length, 1, '被并掉的那间名字留在旧 id 上（界面显示「在等房间」，撤销即回来）');
});

test('没有房名时不许写 roomLabels 字段（方案文件要能逐字节稳定）', () => {
  resetParams();
  const r = expandToInclude(base(), { x0: 6, z0: 1, x1: 10, z1: 5 });
  assertExpanded(r, 10, 6);
  assert.equal('roomLabels' in r.layout, false);
});

/* ---------------- 五、范围上限：超了就报错，不夹取 ---------------- */

test('坏 rect（坐标不是有限数）→ 报错，不许把 NaN 灌进 layout', () => {
  resetParams();
  const layout = base();
  const r = expandToInclude(layout, { x0: NaN, z0: 1, x1: 10, z1: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad-rect');
  assert.equal(r.layout, undefined);
  assert.equal(layout.w, 8, '入参照旧不变');
});

test('超过 roomLimits → 报错且不改 layout、不夹取（静默夹取会让用户画的和提示对不上）', () => {
  resetParams();
  const layout = base();
  const before = JSON.stringify(layout);

  const right = expandToInclude(layout, { x0: 6, z0: 1, x1: 25, z1: 5 });
  assert.equal(right.ok, false);
  assert.equal(right.code, 'room-too-large');
  assert.equal(right.w, 25, '报出真实要扩到的尺寸（不许夹到 20）');
  assert.ok(right.error.includes(roomRangeText()), '报错要带唯一那份范围文案');

  const left = expandToInclude(layout, { x0: -15, z0: 1, x1: 2, z1: 5 });
  assert.equal(left.ok, false);
  assert.equal(left.w, 23);

  const down = expandToInclude(layout, { x0: 1, z0: 4, x1: 5, z1: 21 });
  assert.equal(down.ok, false);
  assert.equal(down.d, 21);

  assert.equal(JSON.stringify(layout), before, '失败不许改动入参 layout');
});
