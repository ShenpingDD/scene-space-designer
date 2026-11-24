/**
 * P1 开放场景画墙—— 内核判据。
 *
 * 这里钉的是「去掉就会静默错」的事实，不是实现细节：
 *  - 角色是**持久化语义**，缺省才按几何回退（M2：去掉角色，中间那道显式外墙会被当内墙）；
 *  - 房间只取**边界全部来自墙**的面（M1：外框兜底一旦算房间，开放场景就出现假房间）；
 *  - 场外画墙**不夹取**，扩场景保留旧墙、旧贴边外墙同步改判；
 *  - 房间面积 + 开放面积 == w×d（N4）；
 *  - 双身份（墙一侧有房、另一侧开放）是常态，不是互斥（N5）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLayout, boundaryWalls, wallRole, isBoundaryWall, classifyWallRole, setWallRole,
  expandSceneKeepWalls, expandToInclude, planSceneSize, roomRangeText, roomLimits,
} from '../src/room.js';
import {
  roomsOf, openAreaTotal, roomAreaTotal, roomAt, roomAtPoint, roomOfItem, openFacesOf,
  wallAdjacency, planFaces, roomSemanticsOf, ROOM_SEMANTICS, ROOMS_DERIVE_VERSION,
} from '../src/rooms.js';
import { planDrawWall, MSG } from '../src/placement.js';
import { checkItem, checkAllWalls } from '../src/validate.js';
import { placeOpening, updateOpening, removeOpening } from '../src/openings.js';
import { mkWall, readWall, cloneWall, EXTERIOR, INTERIOR, isWallRole } from '../src/wall.js';

/* ---------------- 夹具 ---------------- */

/** 手搓墙（`extra` 用来加 role） */
const W = (x, z, xx, zz, extra = {}) => ({ a: [x, z], b: [xx, zz], ...extra });
const base = (w = 8, d = 6) => createLayout({ w, d });
const close = (a, b, msg, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${msg}：${a} vs ${b}`);
const getProduct = (id) => (id === 'x' ? { w: 0.6, d: 0.6 } : undefined);

/** 删掉顶面外墙的开放场景（三面墙 + 开口） */
const openScene = (w = 8, d = 6) => ({ ...base(w, d), walls: boundaryWalls(w, d).slice(1) });

/* ============================================================
 * 一、wall.js：role 的读 / 写 / 拷（字段顺序 = 导出字节）
 * ============================================================ */

test('wall.role：字段顺序固定 a,b,openings?,role?，有值才写；非法值当没写', () => {
  const plain = mkWall([0, 0], [4, 0]);
  assert.deepEqual(Object.keys(plain), ['a', 'b'], '没角色就不写字段');
  assert.equal(JSON.stringify(plain), '{"a":[0,0],"b":[4,0]}', '旧墙字节必须一字不差');

  const ext = mkWall([0, 0], [4, 0], [], EXTERIOR);
  assert.deepEqual(Object.keys(ext), ['a', 'b', 'role']);
  assert.equal(JSON.stringify(ext), '{"a":[0,0],"b":[4,0],"role":"exterior"}');

  const withHole = mkWall([0, 0], [4, 0], [{ at: 2, w: 0.9, h: 2.1 }], INTERIOR);
  assert.deepEqual(Object.keys(withHole), ['a', 'b', 'openings', 'role'], 'role 永远在 openings 之后');

  const bad = mkWall([0, 0], [4, 0], [], 'wall');
  assert.equal('role' in bad, false, '非法角色必须当没写（F4 宽容），不能写进导出');
  assert.equal(isWallRole('wall'), false);
  assert.equal(isWallRole(EXTERIOR), true);
  assert.equal(isWallRole(INTERIOR), true);
});

test('readWall：合法 role 保留、非法 role 宽容丢弃；数组墙没有 role；cloneWall 拷角色且不共享数组', () => {
  assert.deepEqual(readWall({ a: [0, 0], b: [4, 0], role: 'exterior' }),
    { a: [0, 0], b: [4, 0], role: 'exterior' });
  assert.deepEqual(readWall({ a: [0, 0], b: [4, 0], role: 'wall' }),
    { a: [0, 0], b: [4, 0] }, 'F4：非法 role 不拒绝整份文件，按缺省处理');
  assert.deepEqual(readWall([0, 0, 4, 0]), { a: [0, 0], b: [4, 0] }, '老数组墙照旧可读');

  const src = { a: [0, 0], b: [4, 0], openings: [{ at: 1, w: 0.9, h: 2.1 }], role: 'exterior' };
  const copy = cloneWall(src);
  assert.deepEqual(copy, src);
  assert.notEqual(copy.a, src.a, '拷贝不能共享端点数组');
  assert.notEqual(copy.openings[0], src.openings[0]);
  assert.equal('role' in cloneWall({ a: [0, 0], b: [4, 0], role: 'wall' }), false, '非法角色不被拷贝出去');
});

test('openings.withOpenings：放 / 改 / 删门窗后墙的角色不丢（跨文件丢角色点）', () => {
  let layout = { ...base(), walls: [{ a: [0, 0], b: [8, 0], role: EXTERIOR }] };
  let r = placeOpening(layout, 0, { at: 3, w: 1, h: 2.1 });
  assert.equal(r.ok, true);
  assert.equal(r.layout.walls[0].role, EXTERIOR, '放门后角色不能丢');

  r = updateOpening(r.layout, 0, 0, { w: 1.2 });
  assert.equal(r.ok, true);
  assert.equal(r.layout.walls[0].role, EXTERIOR, '改门后角色不能丢');

  r = removeOpening(r.layout, 0, 0);
  assert.equal(r.ok, true);
  assert.equal(r.layout.walls[0].role, EXTERIOR, '删门后角色不能丢');
  assert.equal('openings' in r.layout.walls[0], false);
});

/* ============================================================
 * 二、wallRole / classifyWallRole / setWallRole
 * ============================================================ */

test('wallRole：显式角色优先于几何；旧墙缺角色才按「两端同一条边」回退（M2 的靶子）', () => {
  const mid = W(2, 2, 5, 2, { role: EXTERIOR });
  const layout = { ...base(), walls: [...boundaryWalls(8, 6), mid] };
  assert.equal(wallRole(layout, layout.walls[4]), EXTERIOR, '中间墙显式写着外墙 → 就是外墙（不按几何改判）');
  assert.equal(isBoundaryWall(layout, layout.walls[4]), true);

  const noRole = { ...layout, walls: [...boundaryWalls(8, 6), W(2, 2, 5, 2)] };
  assert.equal(wallRole(noRole, noRole.walls[4]), INTERIOR, '缺角色 + 不贴边 → 内墙（几何回退）');
  assert.equal(wallRole(noRole, noRole.walls[0]), EXTERIOR, '缺角色 + 贴顶边 → 外墙');

  const edgeButInterior = { ...base(), walls: boundaryWalls(8, 6).map((w, i) => (i === 0 ? { ...w, role: INTERIOR } : w)) };
  assert.equal(wallRole(edgeButInterior, edgeButInterior.walls[0]), INTERIOR, '贴边也可以显式是内墙');
  assert.equal(isBoundaryWall(edgeButInterior, edgeButInterior.walls[0]), false);
});

test('classifyWallRole：起笔在场外 → 外墙；两端同一条边 → 外墙；其余 → 内墙（斜墙两端不同边是内墙）', () => {
  const l = base();
  assert.equal(classifyWallRole(l, W(0, 2, 4, 2)), INTERIOR, '只有一端贴边、起笔在场内 → 内墙');
  assert.equal(classifyWallRole(l, W(0, 2, 4, 2), { fromOutside: true }), EXTERIOR, '起笔在场景外 → 外墙');
  assert.equal(classifyWallRole(l, W(0, 0, 4, 0)), EXTERIOR, '两端都贴同一条顶边 → 外墙');
  assert.equal(classifyWallRole(l, W(0, 2, 0, 5)), EXTERIOR, '两端都贴同一条左边 → 外墙');
  assert.equal(classifyWallRole(l, W(0, 2, 3, 0)), INTERIOR,
    '斜墙两端各在不同边：不沿场景外缘走，不许判成外墙（Lead 审查口径）');
  assert.equal(classifyWallRole(l, W(2, 2, 5, 4)), INTERIOR, '场中间斜墙 → 内墙');
});

test('setWallRole：中间墙拒绝 exterior（wall-not-on-edge），贴边才允许；interior/清空永远允许', () => {
  const layout = { ...base(), walls: [...boundaryWalls(8, 6), W(2, 2, 5, 2)] };
  const bad = setWallRole(layout, 4, EXTERIOR);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'wall-not-on-edge');
  assert.equal(bad.code, 'wall-not-on-edge');
  assert.match(bad.message, /场景边缘/, '文案要回答为什么不让设');

  const diag = { ...base(), walls: [...boundaryWalls(8, 6), W(0, 2, 3, 0)] };
  assert.equal(setWallRole(diag, 4, EXTERIOR).reason, 'wall-not-on-edge', '斜墙两端不同边 → 同样拒绝');

  const toInner = setWallRole(layout, 0, INTERIOR);
  assert.equal(toInner.ok, true);
  assert.equal(toInner.changed, true);
  assert.equal(toInner.layout.walls[0].role, INTERIOR);
  assert.equal(layout.walls[0].role, undefined, '纯函数：原 layout 不变');

  const toExt = setWallRole(layout, 0, EXTERIOR);
  assert.equal(toExt.ok, true);
  assert.equal(toExt.layout.walls[0].role, EXTERIOR);

  const cleared = setWallRole(toExt.layout, 0, null);
  assert.equal(cleared.ok, true);
  assert.equal('role' in cleared.layout.walls[0], false, 'null = 清掉显式角色、回几何回退');
  assert.equal(cleared.changed, true);

  assert.equal(setWallRole(base(), 0, null).changed, false, '本来就没角色 → 没变化');
  assert.equal(setWallRole(base(), 9, EXTERIOR).reason, 'bad-wall');
  assert.equal(setWallRole(base(), 0, 'wall').reason, 'bad-role');
});

/* ============================================================
 * 三、expandSceneKeepWalls：保留旧墙 + 左/上平移 + 旧贴边外墙改判
 * ============================================================ */

test('expandSceneKeepWalls：矩形已在场景内 → 原样返回（同一 layout/rect 引用）', () => {
  const layout = base();
  const rect = { x0: 1, z0: 1, x1: 3, z1: 4 };
  const r = expandSceneKeepWalls(layout, rect);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.layout, layout);
  assert.equal(r.rect, rect);
  assert.equal(r.dx, 0);
  assert.equal(r.dz, 0);
  assert.deepEqual(r.reclassified, []);
});

test('expandSceneKeepWalls（右扩）：墙数不变、不重建；旧右外墙改判 interior，其余贴边墙保持 exterior', () => {
  const layout = { ...base(), walls: boundaryWalls(8, 6).map((w) => ({ ...w, role: EXTERIOR })) };
  const r = expandSceneKeepWalls(layout, { x0: 8, z0: 2, x1: 10, z1: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.w, 10);
  assert.equal(r.d, 6);
  assert.equal(r.dx, 0);
  assert.equal(r.dz, 0);
  assert.equal(r.layout.walls.length, 4, '扩场景不增删墙（与 expandToInclude 的重建不同）');
  assert.deepEqual(r.reclassified, [{ index: 1, from: EXTERIOR, to: INTERIOR, explicit: true }]);
  assert.deepEqual(r.layout.walls.map((w) => w.role), [EXTERIOR, INTERIOR, EXTERIOR, EXTERIOR],
    '旧右墙（x=8）现在在中间 → 内墙；顶/底/左还在新外缘 → 外墙');
  assert.deepEqual(checkAllWalls(r.layout), []);
  assert.equal(r.layout.roomSemantics, 'walls', '语义跟着 layout 走');
});

test('expandSceneKeepWalls（左扩）：墙/设备/门洞/房名整体平移；旧左墙改判、房名迁到新 id', () => {
  const layout = {
    ...base(),
    walls: [
      ...boundaryWalls(8, 6),
      W(3, 1, 3, 5, { openings: [{ at: 2, w: 0.9, h: 2.1 }] }),
    ],
    items: [{ id: 1, p: 'x', x: 2, z: 2, r: 0, doorAmount: 0 }],
  };
  const oldRoom = roomsOf(layout)[0];
  layout.roomLabels = { [oldRoom.id]: '主卧' };
  const r = expandSceneKeepWalls(layout, { x0: -2, z0: 0, x1: 8, z1: 6 });
  assert.equal(r.ok, true);
  assert.equal(r.dx, 2);
  assert.equal(r.dz, 0);
  assert.equal(r.w, 10);
  assert.equal(r.layout.walls.length, 5, '旧墙全部保留（含那面竖隔墙）');
  assert.deepEqual(r.layout.walls[0].a, [2, 0], '顶墙整体右移 2');
  assert.deepEqual(r.layout.walls[0].b, [10, 0]);
  assert.deepEqual(r.layout.walls[4].a, [5, 1], '内墙整体右移 2');
  assert.deepEqual(r.layout.walls[4].openings, [{ at: 2, w: 0.9, h: 2.1 }], '内墙门洞 at 是相对弧长，不随平移变');
  assert.deepEqual([r.layout.items[0].x, r.layout.items[0].z], [4, 2], '设备整体右移');
  assert.equal(r.reclassified.length, 1, '旧左墙（x=0 → 2）离开外缘');
  assert.equal(wallRole(r.layout, r.layout.walls[3]), INTERIOR, '旧左墙没显式角色 → 几何回退给出内墙');
  const migrated = roomsOf(r.layout);
  assert.equal(migrated.length, 1);
  assert.equal(r.layout.roomLabels[migrated[0].id], '主卧', '房名跟着房间迁到新 id');
  assert.equal(r.layout.roomLabels[oldRoom.id], undefined);

  assert.equal(layout.w, 8, '纯函数：入参不变');
  assert.equal(layout.items[0].x, 2);
});

test('expandSceneKeepWalls：左 + 上同时扩（dx=dz=1），端点与设备都平移', () => {
  const layout = { ...base(), items: [{ id: 1, p: 'x', x: 1, z: 1, r: 0, doorAmount: 0 }] };
  const r = expandSceneKeepWalls(layout, { x0: -1, z0: -1, x1: 8, z1: 6 });
  assert.equal(r.dx, 1);
  assert.equal(r.dz, 1);
  assert.equal(r.w, 9);
  assert.equal(r.d, 7);
  assert.deepEqual(r.layout.walls[0].a, [1, 1]);
  assert.deepEqual([r.layout.items[0].x, r.layout.items[0].z], [2, 2]);
  assert.deepEqual(checkAllWalls(r.layout), []);
});

test('expandSceneKeepWalls：旧文件没 role 的贴边墙改判事实要报出来，但**不凭空写 role 字段**', () => {
  const layout = base();                    // createLayout 的四面墙没有 role（几何回退）
  const r = expandSceneKeepWalls(layout, { x0: 8, z0: 2, x1: 10, z1: 5 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reclassified, [{ index: 1, from: EXTERIOR, to: INTERIOR, explicit: false }]);
  assert.equal(r.layout.walls[1].role, undefined, '旧墙不因为扩场景就多出 role 字段（旧方案零迁移）');
  assert.equal(wallRole(r.layout, r.layout.walls[1]), INTERIOR, '几何回退自动给出内墙');
});

test('expandSceneKeepWalls：与 expandToInclude 语义不同 —— 同一输入，前者墙数 = 旧+新，后者替换旧四面', () => {
  const layout = base();
  const keep = expandSceneKeepWalls(layout, { x0: 4, z0: 8, x1: 6, z1: 10 }); // 下扩
  assert.equal(keep.layout.walls.length, 4, '保留旧四面墙');
  assert.equal(keep.w, 8);
  assert.equal(keep.d, 10);

  const rebuilt = expandToInclude(layout, { x0: 4, z0: 8, x1: 6, z1: 10 });
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.layout.walls.length, 4, 'expandToInclude 剔除旧外墙后按新尺寸重建（仍是四面）');
  assert.equal(rebuilt.layout.walls.at(-1).b[1], 0, '重建的墙从新边界起（旧墙不在墙池里）');
});

test('expandSceneKeepWalls：坏 rect / 超范围都报错且不带 layout；超范围给**真实**尺寸', () => {
  const layout = base();
  const bad = expandSceneKeepWalls(layout, { x0: NaN, z0: 0, x1: 1, z1: 1 });
  assert.deepEqual([bad.ok, bad.code], [false, 'bad-rect']);

  const big = expandSceneKeepWalls(layout, { x0: 0, z0: 0, x1: 25, z1: 6 });
  assert.equal(big.ok, false);
  assert.equal(big.code, 'room-too-large');
  assert.equal(big.w, 25, '给真实要扩到的尺寸，不夹取');
  assert.equal(big.d, 6);
  assert.equal(big.layout, undefined, '失败不许带半份 layout');
  assert.match(big.error, /25\.0 × 6\.0 m/);
});

/* ============================================================
 * 四、rooms.js：面两分 / 开放面积 / 守恒 / 双身份
 * ============================================================ */

test('roomSemantics：缺省 legacy（旧布局零迁移）；createLayout 显式 walls；语义进缓存键版本', () => {
  assert.equal(roomSemanticsOf({ w: 8, d: 6, walls: [] }), ROOM_SEMANTICS.LEGACY);
  assert.equal(roomSemanticsOf(base()), ROOM_SEMANTICS.WALLS);
  assert.equal(base().roomSemantics, 'walls');
  assert.equal(typeof ROOMS_DERIVE_VERSION, 'number');
  assert.ok(ROOMS_DERIVE_VERSION >= 2);
});

test('N2 开放场景：三面墙 + 开口 → 0 间房、开放面积 = w×d、房间面积 0（M1 的靶子）', () => {
  const layout = openScene();
  assert.equal(roomsOf(layout).length, 0, '外框兜底不许再兜出一间假房间');
  assert.equal(roomAreaTotal(layout), 0);
  close(openAreaTotal(layout), 48, '开放面积 = 8×6');
  const faces = planFaces(layout).faces;
  assert.ok(faces.some((f) => f.kind === 'open' && f.area > 0), '开放面必须被标成 open');
  assert.ok(faces.every((f) => f.kind === 'room' || f.kind === 'open' || f.kind === 'outside'));
});

test('N3 闭合外墙环：4 面墙围出的面算 1 间房，面积 = 环面积', () => {
  const layout = {
    ...base(),
    walls: [W(1, 1, 5, 1), W(5, 1, 5, 4), W(5, 4, 1, 4), W(1, 4, 1, 1)],
  };
  const rooms = roomsOf(layout);
  assert.equal(rooms.length, 1);
  close(rooms[0].area, 12, '3×4 的环');
  close(roomAreaTotal(layout), 12);
  close(openAreaTotal(layout), 36);
  close(roomAreaTotal(layout) + openAreaTotal(layout), 48, 'N4 守恒');
});

test('N4 3 间房 + 1 块开放场地：房间数只数房间，房间 + 开放 == w×d', () => {
  const walls = [...boundaryWalls(8, 6).slice(1)];   // 缺顶边 → 场地开放
  for (const [x0, z0] of [[1, 1], [4, 1], [1, 4]]) {
    walls.push(W(x0, z0, x0 + 2, z0), W(x0 + 2, z0, x0 + 2, z0 + 1.5),
      W(x0 + 2, z0 + 1.5, x0, z0 + 1.5), W(x0, z0 + 1.5, x0, z0));
  }
  const layout = { ...base(), walls };
  const rooms = roomsOf(layout);
  assert.equal(rooms.length, 3, '三间闭合的小房');
  close(roomAreaTotal(layout), 3 * 3, '每间 2×1.5');
  close(openAreaTotal(layout), 48 - 9);
  close(roomAreaTotal(layout) + openAreaTotal(layout), 48, 'N4：总数不许漏一侧');
});

test('N5 双身份：一段外墙一侧有房、另一侧 null，角色仍是 exterior（不因"有房"强制成内墙）', () => {
  const layout = {
    ...base(),
    walls: [
      ...boundaryWalls(8, 6).slice(1),         // R/B/L（L 的序号 = 2）
      W(0, 2, 4, 2), W(4, 2, 4, 5), W(4, 5, 0, 5),
    ],
  };
  const rooms = roomsOf(layout);
  assert.equal(rooms.length, 1);
  close(rooms[0].area, 12, '4×3 的房间靠左外墙围合');
  const adj = wallAdjacency(layout)[2];      // L 面外墙：0..6 与房间共用 2..5
  assert.equal(adj.cls, 'boundary');
  assert.equal(adj.rooms.length, 1, '一侧是房间、另一侧是场景外 → 开放');
  assert.equal(wallRole(layout, layout.walls[2]), EXTERIOR, '双身份不是互斥：外墙同时是房间边界');
  close(openAreaTotal(layout), 36);
});

test('N6 开放场景里的设备：checkItem / roomAt / roomOfItem 全都不用「必须属于房间」', () => {
  const layout = { ...openScene(), items: [{ id: 1, p: 'x', x: 4, z: 3, r: 0, doorAmount: 0 }] };
  const item = layout.items[0];
  assert.equal(checkItem(layout, item, getProduct), null);
  assert.equal(roomAt(layout, 4, 3), null);
  assert.equal(roomAtPoint(layout, 4, 3), roomAt(layout, 4, 3), 'roomAtPoint 是别名，不许两套算法');
  assert.equal(roomOfItem(layout, item), null);
  close(openAreaTotal(layout), 48);
});

test('旧语义（legacy）保持旧行为：外框兜底参与闭合、正面积面都算房间、开放面积恒 0', () => {
  const legacy = { w: 8, d: 6, h: 2.8, walls: boundaryWalls(8, 6).slice(1), items: [] }; // 没有 roomSemantics
  assert.equal(roomSemanticsOf(legacy), 'legacy');
  assert.equal(roomsOf(legacy).length, 1, '旧方案缺一面墙仍算 1 间（C1：房间数不变）');
  close(roomAreaTotal(legacy), 48);
  assert.equal(openAreaTotal(legacy), 0);
});

test('缓存键：语义/角色改变必须让派生读数失效（不许拿旧缓存冒充新结论）', () => {
  const layout = { ...base(), walls: [...boundaryWalls(8, 6), W(2, 2, 5, 2)] };
  const a = roomsOf(layout);
  const withRole = { ...layout, walls: layout.walls.map((w, i) => (i === 4 ? { ...w, role: INTERIOR } : w)) };
  assert.notEqual(roomsOf(withRole), a, 'role 变化没进缓存键 → 这里会拿到同一个数组');

  const b = openScene();
  const c = { ...b, roomSemantics: ROOM_SEMANTICS.LEGACY };
  assert.notEqual(roomsOf(b), roomsOf(c), 'legacy/walls 语义不同 → 缓存不能串');
  assert.equal(roomsOf(c).length, 1);
});

/* ============================================================
 * 五、placement.planDrawWall：场外不夹取 + 扩场景 + 落墙 + 角色
 * ============================================================ */

test('N1 场外起笔（左）：端点不被夹到边界，场景恰好扩到包含它（容差 1e-6）', () => {
  const layout = base();
  const p = planDrawWall(layout, [-1, 2], [3, 2]);
  assert.equal(p.ok, true);
  assert.deepEqual(p.wall.a, [0, 2], '起点 = 吸附后的指针位置整体平移 dx；不是被夹回旧边界');
  assert.deepEqual(p.wall.b, [4, 2]);
  assert.equal(p.layout.w, 9, 'w 恰好扩到包含墙（旧 8 + 左扩 1）');
  assert.equal(p.layout.d, 6);
  assert.equal(p.expanded.dx, 1);
  close(p.layout.w, 8 + p.expanded.dx, 'w = 旧 w + dx（恰好包含它）');
  assert.equal(p.role, EXTERIOR);
  assert.equal(p.wall.role, EXTERIOR);
  // 新墙从场外穿过旧左边墙：旧墙在交点处拆成两段（验收 2026-10-22 起的接头语义）
  assert.equal(p.split.count, 1, '穿过旧左边墙 → 拆成两段');
  assert.equal(p.wallIndex, 5);
  assert.equal(p.layout.walls.length, 6, '4 面旧墙 → 左墙拆 2 段 + 新墙 = 6');
  assert.deepEqual(checkAllWalls(p.layout), []);
  assert.equal(layout.w, 8, '纯函数：入参不变');
  assert.equal(layout.walls.length, 4);
});

test('N1 场外起笔（右）：场景右扩，墙端点保留在指针位置', () => {
  const p = planDrawWall(base(), [9, 1], [9, 4]);
  assert.equal(p.ok, true);
  assert.equal(p.layout.w, 9);
  assert.equal(p.layout.d, 6);
  assert.deepEqual(p.wall.a, [9, 1]);
  assert.deepEqual(p.wall.b, [9, 4]);
  assert.equal(p.role, EXTERIOR);
  assert.equal(p.expanded.from[0], 8);
  assert.equal(p.expanded.to[0], 9);
});

test('场内画墙 → 内墙、不扩场景；起笔在场外但吸附回边缘 → 仍是外墙（但不必扩）', () => {
  const inside = planDrawWall(base(), [1, 1], [5, 1]);
  assert.equal(inside.ok, true);
  assert.equal(inside.role, INTERIOR);
  assert.equal(inside.expanded, null);
  assert.equal(inside.layout.w, 8);

  // 顶边缺墙的开放场景：起笔在 z=-0.1（场外），吸附回 z=0 的新边缘；不需要扩场景
  const edge = planDrawWall(openScene(), [2, -0.1], [5, -0.1]);
  assert.equal(edge.ok, true);
  assert.equal(edge.wall.a[1], 0, '贴边吸附到 0');
  assert.deepEqual(edge.wall.a, [2, 0]);
  assert.equal(edge.wall.b[1], 0, '终点也吸附回边缘');
  close(edge.wall.b[0], 5.002, '15° 吸附保住长度 → 终点比指针略长（毫米取整）');
  assert.equal(edge.role, EXTERIOR, '起笔在场景外 → 外墙（即使吸附回边缘）');
  assert.equal(edge.expanded, null, '吸附后已包含，没必要扩场景');
});

test('F1 扩到超范围：ok:false / code room-too-large，带真实 w、d，不夹取也不落墙', () => {
  const layout = createLayout({ w: 20, d: 6 });
  const p = planDrawWall(layout, [19, 2], [21, 2]);
  assert.equal(p.ok, false);
  assert.equal(p.code, 'room-too-large');
  assert.equal(p.reason, 'room-too-large');
  assert.equal(p.w, 21);
  assert.equal(p.d, 6);
  assert.equal(p.layout, undefined);
  assert.equal(p.message, '场景要扩到 21.0 × 6.0 m，超出范围（长宽 3–20 m）', '文案与 设计决策记录原话一致');
  assert.equal(layout.w, 20, '失败不改入参');
});

test('F2 落笔失败各有专属原因码：bad-point / zero-length / too-short / duplicate / wall-limit', () => {
  const l = base();
  assert.equal(planDrawWall(l, [NaN, 1], [2, 2]).reason, 'bad-point');
  assert.equal(planDrawWall(l, [2, 2], [2, 2]).reason, 'zero-length');
  const short = planDrawWall(l, [2, 2], [2, 2.05]);
  assert.equal(short.reason, 'too-short');
  assert.match(short.message, /请拖动出至少 0\.10 m/);

  const dup = planDrawWall(l, [1, 0], [5, 0]);
  assert.equal(dup.reason, 'duplicate');
  assert.equal(dup.message, '这段已经有墙了');
  assert.equal(dup.layout, undefined);

  const walls = [...boundaryWalls(20, 20)];
  for (let i = 0; i < 96; i += 1) {                 // 4 + 96 = 100 = cfg.layout.maxWalls
    const x = 0.4 + (i % 19) * 0.5;
    const z = 1 + Math.floor(i / 19) * 0.5;
    walls.push(W(x, z, x + 0.2, z));
  }
  assert.equal(walls.length, 100);
  const full = planDrawWall({ ...base(20, 20), walls }, [2, 2], [5, 2]);
  assert.equal(full.reason, 'wall-limit');
  assert.match(full.message, /墙体数量已达上限（100 面）/);
});

test('Shift（free）：不吸角度、不贴边 —— 端点就是用户拖到的位置（毫米取整）', () => {
  const free = planDrawWall(base(), [1, 1], [5, 3.7], { free: true });
  assert.equal(free.ok, true);
  assert.equal(free.wall.b[1], 3.7, 'free 不许被 15° 吸附拉回水平');
  const snapped = planDrawWall(base(), [1, 1], [5, 3.7]);
  assert.notEqual(snapped.wall.b[1], 3.7, '非 free 时端点被 15° 档挪过（不是用户拖到的位置）');
  const deg = (Math.atan2(snapped.wall.b[1] - snapped.wall.a[1], snapped.wall.b[0] - snapped.wall.a[0]) * 180) / Math.PI;
  close(deg % 15, 0, '方向必须落在 15° 档上', 0.01);
});

test('重合只拒绝「完全覆盖」：部分重叠允许并报 overlapM（不自动裁）', () => {
  const l = base();
  const partial = planDrawWall(l, [2, 0], [6, 0]);   // 顶墙上再画一段，完全在墙内 → duplicate
  assert.equal(partial.reason, 'duplicate');
  const inner = { ...l, walls: [...l.walls, W(2, 2, 6, 2)] };
  const half = planDrawWall(inner, [4, 2], [8, 2]);  // 与内墙共线、部分重叠，超出部分到 x=8
  assert.equal(half.ok, true);
  close(half.overlapM, 2, '重叠 2 m 要报出来（不静默）');
});

/* ============================================================
 * 六、planSceneSize：新语义只校验不重建；旧语义走兼容分支
 * ============================================================ */

test('planSceneSize：同尺寸 → changed:false 且返回同一 layout 引用', () => {
  const l = base();
  const r = planSceneSize(l, { w: 8, d: 6, h: 2.8 });
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(r.layout, l);
  assert.equal(r.rebuilt, false);
});

test('planSceneSize（新语义放大）：不重建墙；房间 + 开放 == 新 w×d', () => {
  const l = base();
  const r = planSceneSize(l, { w: 9, d: 7, h: 2.8 });
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(r.rebuilt, false);
  assert.deepEqual(r.layout.walls, l.walls, '新语义只改 w/d/h，墙原样保留');
  assert.equal(r.layout.w, 9);
  assert.equal(r.layout.d, 7);
  close(roomAreaTotal(r.layout), 48);
  close(openAreaTotal(r.layout), 15);
  close(roomAreaTotal(r.layout) + openAreaTotal(r.layout), 63);
  assert.deepEqual(checkAllWalls(r.layout), []);
});

test('F3 改小且墙越界：返回越界墙序号清单、layout 不变（不许静默删墙）', () => {
  const l = base();
  const r = planSceneSize(l, { w: 7, d: 6, h: 2.8 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'walls-out-of-bounds');
  assert.deepEqual(r.wallIndexes, [0, 1, 2], '顶/右/底三面墙端点越界（0 基）');
  assert.equal(r.layout, undefined);
  assert.match(r.message, /3 面墙/);
  assert.equal(l.walls.length, 4, '原 layout 不变');
});

test('planSceneSize：设备占地四角越界也报序号（传 getProduct），不只报墙', () => {
  const l = {
    ...base(),
    walls: [W(1, 1, 1, 5)],
    items: [{ id: 1, p: 'x', x: 6.5, z: 3, r: 0, doorAmount: 0 }],
  };
  const r = planSceneSize(l, { w: 6.6, d: 6, h: 2.8 }, { getProduct });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'items-out-of-bounds');
  assert.deepEqual(r.itemIndexes, [0]);
  assert.deepEqual(r.wallIndexes, [], '墙没越界，不许混报');
  assert.match(r.message, /1 台设备/);
});

test('planSceneSize：坏尺寸 / 超范围各有专属原因码', () => {
  assert.equal(planSceneSize(base(), { w: NaN, d: 6, h: 2.8 }).reason, 'bad-size');
  const big = planSceneSize(base(), { w: 25, d: 6, h: 2.8 });
  assert.equal(big.reason, 'size-out-of-range');
  assert.equal(big.message, roomRangeText());
  const [, wMax] = roomLimits().w;
  assert.equal(wMax, 20, '范围文案与配置同源；这里钉住当前参数（20 m）');
});

test('planSceneSize（旧语义）：走 applyRoomSize 兼容分支 —— 重建外墙、报 rebuilt 与洞口增减', () => {
  const legacy = {
    w: 8, d: 6, h: 2.8,
    walls: [{ ...W(0, 0, 8, 0), openings: [{ at: 4, w: 1, h: 2.1 }] }, ...boundaryWalls(8, 6).slice(1)],
    items: [],
  };
  const r = planSceneSize(legacy, { w: 10, d: 6, h: 2.8 });
  assert.equal(r.ok, true);
  assert.equal(r.rebuilt, true);
  assert.equal(r.roomSemantics, 'legacy');
  assert.equal(r.layout.walls.length, 4, '旧口径按新尺寸重建四面外墙');
  assert.equal(r.layout.walls[0].b[0], 10);
  assert.deepEqual(r.layout.walls[0].openings, [{ at: 4, w: 1, h: 2.1 }], '外墙洞口按面搬家');
  close(roomAreaTotal(r.layout), 60, '旧语义：正面积面都算房间');
});


/* ============================================================
 * 七、嵌套闭合房：面面积按包含关系扣洞（task-38）
 * ============================================================ */

/** 8×6 场景里一圈 3×3 的闭合机房（与外框断开） */
const INV_3X3 = [W(2, 2, 5, 2), W(5, 2, 5, 5), W(5, 5, 2, 5), W(2, 5, 2, 2)];
const nestedBox = () => ({ ...base(), walls: [...boundaryWalls(8, 6), ...INV_3X3] });

test('task-38：8×6 里画 3×3 闭合房 → 2 间 39 + 9 = 48，开放面积 0（不再 57 超算）', () => {
  const layout = nestedBox();
  const rooms = roomsOf(layout);
  assert.equal(rooms.length, 2);
  const areas = rooms.map((r) => r.area).sort((a, b) => a - b);
  close(areas[0], 9, '机房面积');
  close(areas[1], 39, '大厅扣掉机房后的有效面积');
  close(roomAreaTotal(layout), 48, '房间面积和必须回到场景面积');
  assert.equal(openAreaTotal(layout), 0, '闭合外框内没有开放面积');

  const outer = rooms.find((r) => r.areaGross === 48);
  assert.ok(outer, '外圈面的毛面积仍是面遍历原始值（诊断用）');
  assert.equal(outer.area, 39, '对外读数用扣洞后的有效面积');
  assert.ok(roomAreaTotal(layout) <= 48 + 1e-6, '保守护据：房间面积不允许超过 w×d');
  assert.ok(rooms.every((r) => r.areaGross >= r.area), 'areaGross 只是诊断，不小于 area');
});

test('task-38：多层嵌套逐层扣洞（48 / 24 / 4 的毛面积 → 24 + 20 + 4 = 48）', () => {
  const layout = {
    ...base(),
    walls: [
      ...boundaryWalls(8, 6),
      W(1, 1, 7, 1), W(7, 1, 7, 5), W(7, 5, 1, 5), W(1, 5, 1, 1),   // 中层 6×4
      W(2, 2, 4, 2), W(4, 2, 4, 4), W(4, 4, 2, 4), W(2, 4, 2, 2),   // 内层 2×2
    ],
  };
  const rooms = roomsOf(layout);
  assert.equal(rooms.length, 3);
  const byGross = new Map(rooms.map((r) => [r.areaGross, r.area]));
  close(byGross.get(48), 24, '外圈 = 48 − 24（只减直接子面）');
  close(byGross.get(24), 20, '中层 = 24 − 4（自己再扣自己的孩子）');
  close(byGross.get(4), 4, '最内层 = 毛面积');
  close(roomAreaTotal(layout), 48);
  assert.equal(openAreaTotal(layout), 0);

  // 外圈的名字/代表点不能落在洞里：否则「大厅」的房名会画在机房中间
  const outer = rooms.find((r) => r.areaGross === 48);
  assert.ok(!(outer.labelAt[0] > 1 && outer.labelAt[0] < 7 && outer.labelAt[1] > 1 && outer.labelAt[1] < 5),
    '外圈 labelAt 必须落在有效区域（不在中层/内层洞里）');
});

test('task-38：内外设备的归属取最内层，外圈不重复计数', () => {
  const layout = {
    ...nestedBox(),
    items: [
      { id: 1, p: 'x', x: 3.5, z: 3.5, r: 0, doorAmount: 0 },   // 机房正中
      { id: 2, p: 'x', x: 1, z: 1, r: 0, doorAmount: 0 },       // 大厅
    ],
  };
  const inner = roomOfItem(layout, layout.items[0]);
  const hall = roomOfItem(layout, layout.items[1]);
  assert.equal(inner.area, 9, '机房里的设备归机房（最内层）');
  assert.equal(hall.area, 39, '大厅里的设备归大厅');
  assert.equal(roomAt(layout, 3.5, 3.5).id, inner.id, 'roomAt 嵌套时也取最内层');
  assert.equal(roomAtPoint(layout, 3.5, 3.5).id, inner.id);

  const rooms = roomsOf(layout);
  assert.equal(rooms.find((r) => r.area === 9).items, 1);
  assert.equal(rooms.find((r) => r.area === 39).items, 1, '大厅不许把机房的设备再数一遍');
});

test('task-38：开放场地里的闭合房间 → 房间 9、开放 39；openFacesOf 用有效面积', () => {
  const layout = { ...openScene(), walls: [...openScene().walls, ...INV_3X3] };
  assert.equal(roomsOf(layout).length, 1);
  close(roomAreaTotal(layout), 9);
  close(openAreaTotal(layout), 39, '开放面积 = 48 − 9（不再被毛面积算成 48）');
  const faces = openFacesOf(layout);
  close(faces.reduce((n, f) => n + f.area, 0), 39, '开放面的 area 是扣洞后的有效面积');
  close(roomAreaTotal(layout) + openAreaTotal(layout), 48, '守恒');
  assert.equal(roomAt(layout, 3.5, 3.5).area, 9, '机房仍是房间');
  assert.equal(roomAt(layout, 1, 1), null, '开放场地没有房间');
});

test('task-38：扣洞是几何口径，不改变语义；legacy 嵌套同样不超算、普通旧方案不回归', () => {
  const legacyNested = {
    w: 8, d: 6, h: 2.8,
    walls: [...boundaryWalls(8, 6), ...INV_3X3],
    items: [],
  };
  assert.equal(roomSemanticsOf(legacyNested), 'legacy');
  const rooms = roomsOf(legacyNested);
  assert.equal(rooms.length, 2, 'legacy 仍把正面积面都当房间（M1 不变）');
  close(roomAreaTotal(legacyNested), 48);
  assert.equal(openAreaTotal(legacyNested), 0);

  const legacyPlain = { w: 8, d: 6, h: 2.8, walls: boundaryWalls(8, 6), items: [] };
  assert.equal(roomsOf(legacyPlain).length, 1);
  close(roomsOf(legacyPlain)[0].area, 48);
  close(openAreaTotal(legacyPlain), 0);
});

/* ============================================================
 * 五、画墙落在旧墙中间：旧墙必须断成两段（验收 2026-10-22）
 * ============================================================ */

test('验收：从顶边中点往里画 → 顶边在接头处断成两段，两段都可单独选中删除', () => {
  const layout = { ...base(), walls: boundaryWalls(8, 6).map((w) => ({ ...w, role: EXTERIOR })) };
  const r = planDrawWall(layout, [4, 0], [4, 3]);
  assert.equal(r.ok, true);
  assert.equal(r.split.count, 1, '只断被接上的那一面顶边');
  assert.equal(r.layout.walls.length, 6, '4 面旧墙 → 顶边拆 2 段 + 新墙 = 6');
  assert.equal(r.wallIndex, 5, '新墙固定在末尾；前两段是拆出来的旧墙');
  const pieces = r.layout.walls.slice(0, 2);
  assert.deepEqual(pieces.map((w) => [w.a, w.b]), [
    [[0, 0], [4, 0]],
    [[4, 0], [8, 0]],
  ]);
  assert.deepEqual(pieces.map((w) => w.role), [EXTERIOR, EXTERIOR], '拆出来的两段都保留外墙角色');
  assert.equal(r.layout.walls[5].role, INTERIOR);
  assert.equal(roomsOf(r.layout).length, 1, '接头拆分不改变房间数');
});

test('验收：新墙从旧墙中间穿过 → 旧墙在交点断开；十字/T 形都不整面留着', () => {
  const layout = {
    ...base(),
    walls: [
      ...boundaryWalls(8, 6),
      W(0, 3, 8, 3), // 场内一道横墙
    ],
  };
  const r = planDrawWall(layout, [4, 1], [4, 5]);
  assert.equal(r.ok, true);
  assert.equal(r.split.count, 1);
  assert.equal(r.split.skipped.length, 0);
  const horizontal = r.layout.walls.filter((w) => Math.abs(w.a[1] - 3) < 1e-9 && Math.abs(w.b[1] - 3) < 1e-9);
  assert.deepEqual(horizontal.map((w) => [w.a, w.b]), [
    [[0, 3], [4, 3]],
    [[4, 3], [8, 3]],
  ], '横墙在交点 x=4 处变成两段');
});

test('验收：拆分保留洞口；洞口整体落在左段时 at 不变，落在右段时重算 at', () => {
  const withDoor = mkWall([0, 0], [8, 0], [{ at: 2, w: 0.9, h: 2.1 }], EXTERIOR);
  const layout = {
    ...base(),
    walls: [withDoor, ...boundaryWalls(8, 6).slice(1)],
  };
  const r = planDrawWall(layout, [4, 0], [4, 3]);
  assert.equal(r.split.count, 1);
  const [left, right] = r.layout.walls;
  assert.equal(left.openings?.[0]?.at, 2, '左段门洞位置不变');
  assert.equal(right.openings, undefined, '右段没有洞口时不写空数组');
  assert.equal(left.role, EXTERIOR);
  assert.equal(right.role, EXTERIOR);
});

test('验收：洞口跨过接头 → 这一面不拆并明确回报，新墙仍落、洞口不被切一半', () => {
  const crossing = mkWall([0, 0], [8, 0], [{ at: 4, w: 1.2, h: 2.1 }], EXTERIOR);
  const layout = {
    ...base(),
    walls: [crossing, ...boundaryWalls(8, 6).slice(1)],
  };
  const r = planDrawWall(layout, [4, 0], [4, 3]);
  assert.equal(r.ok, true);
  assert.equal(r.split.count, 0);
  assert.equal(r.split.skipped.length, 1);
  assert.equal(r.split.skipped[0].reason, 'opening-crosses-split');
  assert.equal(r.layout.walls.length, 5, '旧墙保留整面，只加新墙');
  assert.equal(r.layout.walls[0].openings[0].at, 4, '门洞原样保留');
});

test('验收：端点到端点不制造零长段（画到墙角不该把角拆碎）', () => {
  const layout = base();
  const r = planDrawWall(layout, [0, 0], [2, 3]);
  assert.equal(r.ok, true);
  assert.equal(r.split.count, 0);
  assert.equal(r.layout.walls.length, 5);
});

test('验收：洞口整体落在右段时，右段的 at 重算为“距新端点”的距离', () => {
  const withDoor = mkWall([0, 0], [8, 0], [{ at: 6, w: 0.9, h: 2.1 }], EXTERIOR);
  const layout = { ...base(), walls: [withDoor, ...boundaryWalls(8, 6).slice(1)] };
  const r = planDrawWall(layout, [4, 0], [4, 3]);
  assert.equal(r.split.count, 1);
  const [left, right] = r.layout.walls;
  assert.equal(left.openings, undefined, '左段没有洞口');
  assert.equal(right.openings?.[0]?.at, 2, '右段 at = 6 − 4 = 2');
  assert.equal(right.role, EXTERIOR);
});
