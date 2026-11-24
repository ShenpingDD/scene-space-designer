/**
 * clearance.test.js —— 规则 7 开门净空
 *
 * 这里放**用例表放不下的东西**：几何不变式。
 * 业务场景（谁能开多少度）都在 `test/cases/rules.json` 里，那份表还要给 Java 当验收标准，
 * 所以不重复写一遍；这里钉的是"门板几何本身对不对"。
 *
 * 门数据是**实测**的（demo-cabinet-800，来自 tools/models/verify-models.py）。
 * 数值照抄自实测产物，不是因为方便 —— 它是这套几何与真实模型之间唯一的接口。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  doorPlateAt, doorFreeAngle, clearanceLevel, clearanceReport, clearanceText, clearanceSkipText,
  doorTroubleClause,
} from '../src/clearance.js';
import { cfg } from '../src/params.js';

/** 实测门几何：DEMO-CT-100 的 outer_door（铰链在右端、门板在前脸） */
const DW829_DOOR = {
  node: 'outer_door',
  axis: 'y',
  openAngleDeg: 106,
  hinge: { x: 0.56298, y: 1.22, z: 0.42566 },
  swing: 1.14635,
  leaf: { x0: -0.57596, x1: 0.57193, z0: 0.29557, z1: 0.54742 },
};
/** 实测门几何：DEMO-FZ-040 的 upper_door */
const DW510_DOOR = {
  node: 'upper_door',
  axis: 'y',
  openAngleDeg: 106,
  hinge: { x: 0.41748, y: 1.25119, z: 0.32944 },
  swing: 0.86676,
  leaf: { x0: -0.44276, x1: 0.43939, z0: 0.2831, z1: 0.4356 },
};

const getProduct = (id) =>
  ({
    'demo-cabinet-800': { w: 1.15192501, d: 1.09483496, h: 1.98669948, doors: [DW829_DOOR] },
    'demo-freezer-dual': { w: 0.99, d: 0.8712, h: 1.98, doors: [DW510_DOOR] },
    // 没有门数据的型号（比如还没换开门版）：不给数，不许编
    plain: { w: 0.8, d: 0.8, h: 1.5 },
    // 上盖：绕水平轴，平面净空不适用
    lid: { w: 0.7, d: 0.7, h: 1.5, doors: [{ ...DW829_DOOR, axis: 'x', openAngleDeg: -88.81 }] },
    // demo-blender-001 的真实门数据形状：有 pivotMm（3D 能开），但没有 2D 净空所需的 hinge/leaf/swing
    demo: { w: 0.676, d: 0.672, h: 1.1, doors: [{
      axis: 'y', node: 'door_single', pivotMm: [-260, 190.5, 285],
      openAngleDeg: 106, openDirection: '-',
    }] },
    // 同一台设备上既有完整门、也有一条不完整门：完整门必须照算，不完整门只计数
    mixed: { w: 1.2, d: 1.1, h: 1.99, doors: [DW829_DOOR, {
      axis: 'y', node: 'door_single', openAngleDeg: 106, openDirection: '-',
    }] },
  })[id];

const item = (id, p, x, z, r = 0) => ({ id, p, x, z, r, doorAmount: 0 });
const layout = (items, walls = []) => ({ w: 8, d: 6, h: 2.8, walls, items });

test('门板几何：开门比例 0（关门位）时，设备在原点且不旋转 → 就是实测的门板轮廓', () => {
  const plate = doorPlateAt({ x: 0, z: 0, r: 0 }, DW829_DOOR, 0);
  assert.deepEqual(plate, [
    [DW829_DOOR.leaf.x0, DW829_DOOR.leaf.z0],
    [DW829_DOOR.leaf.x1, DW829_DOOR.leaf.z0],
    [DW829_DOOR.leaf.x1, DW829_DOOR.leaf.z1],
    [DW829_DOOR.leaf.x0, DW829_DOOR.leaf.z1],
  ]);
});

test('门板几何：关门位最远角到铰链的距离 == 验收器报的扫掠半径（±0.5 mm）', () => {
  for (const d of [DW829_DOOR, DW510_DOOR]) {
    const far = Math.max(
      ...doorPlateAt({ x: 0, z: 0, r: 0 }, d, 0).map(([x, z]) => Math.hypot(x - d.hinge.x, z - d.hinge.z)),
    );
    assert.ok(Math.abs(far - d.swing) < 0.0005, `${d.node}: 门板最远角 ${far.toFixed(5)} vs 扫掠半径 ${d.swing}`);
  }
});

test('门板几何：门板整体绕铰链自转 → 铰链到最远角的距离恒定（扫掠半径不变）', () => {
  const dist = (deg) =>
    Math.max(...doorPlateAt({ x: 0, z: 0, r: 0 }, DW829_DOOR, deg).map(([x, z]) => Math.hypot(x - DW829_DOOR.hinge.x, z - DW829_DOOR.hinge.z)));
  for (const deg of [0, 15, 45, 90, 106]) {
    assert.ok(Math.abs(dist(deg) - DW829_DOOR.swing) < 0.0005, `${deg}° 时 ${dist(deg).toFixed(5)}`);
  }
});

test('门板几何：设备旋转=房间旋转 —— 转 180° 后门板的 x/z 关于设备中心镜像', () => {
  const a = doorPlateAt({ x: 0, z: 0, r: 0 }, DW829_DOOR, 0);
  const b = doorPlateAt({ x: 0, z: 0, r: 180 }, DW829_DOOR, 0);
  a.forEach(([x, z], i) => {
    assert.ok(Math.abs(b[i][0] + x) < 1e-9 && Math.abs(b[i][1] + z) < 1e-9, `角点 ${i} 未镜像`);
  });
});

test('拒绝编造：没有门数据的型号 → freeDeg=null（不是 0、也不是 106）', () => {
  const body = layout([item(1, 'plain', 2, 2)]);
  const r = doorFreeAngle(body, body.items[0], getProduct);
  assert.equal(r.freeDeg, null);
  assert.equal(clearanceLevel(r.freeDeg), 'n/a');
  assert.deepEqual(clearanceReport(body, getProduct), [], '不该出现在净空体检里');
});

test('缺铰链的 y 门不参与净空，但不会被静默吞成「无门」', () => {
  const body = layout([item(1, 'demo', 2, 2)]);
  let r;
  assert.doesNotThrow(() => { r = doorFreeAngle(body, body.items[0], getProduct); },
    'demo-blender 只有 pivotMm、没有 hinge，不能抛 TypeError');
  assert.equal(r.freeDeg, null);
  assert.equal(r.doors, 0);
  assert.equal(r.skippedDoors, 1);
  assert.equal(r.skipReason, 'missing-hinge');
  assert.equal(clearanceLevel(r.freeDeg), 'n/a', '不能补 0° / 猜一个角度');

  const row = clearanceReport(body, getProduct)[0];
  assert.equal(row.level, 'n/a', '有门但算不了 → 留一行 n/a，界面才有话可说');
  assert.match(clearanceSkipText(row), /1 扇门缺铰链位置/);
  assert.equal(doorTroubleClause(clearanceReport(body, getProduct), 1), '', 'n/a 不算“开不到底”的麻烦');
});

test('同一台设备：完整门照算，不完整门只计数、不影响结果', () => {
  const body = layout([item(1, 'mixed', 2, 2)]);
  const r = doorFreeAngle(body, body.items[0], getProduct);
  assert.equal(r.freeDeg, 106);
  assert.equal(r.level, undefined);
  assert.equal(r.skippedDoors, 1);
  assert.equal(r.skipReason, 'missing-hinge');
  const row = clearanceReport(body, getProduct)[0];
  assert.equal(row.level, 'ok');
  assert.match(clearanceSkipText(row), /缺铰链/);
});

test('上盖（axis=x）不参与平面净空：它往竖直方向扫', () => {
  const body = layout([item(1, 'lid', 2, 2)]);
  assert.equal(doorFreeAngle(body, body.items[0], getProduct).freeDeg, null);
});

test('可见文案：绿灯说"不受阻"，被挡说清被谁挡', () => {
  const free = layout([item(1, 'demo-cabinet-800', 2, 2)]);
  const r1 = clearanceReport(free, getProduct)[0];
  assert.equal(r1.level, 'ok');
  assert.match(clearanceText(r1, getProduct), /不受阻/);

  const hit = layout([item(1, 'demo-cabinet-800', 2, 2), item(2, 'demo-freezer-dual', 2, 2.6)]);
  const r2 = clearanceReport(hit, getProduct).find((x) => x.id === 1);
  assert.equal(r2.freeDeg, 0);
  assert.equal(r2.level, 'bad');
  assert.match(clearanceText(r2, getProduct), /#2/);
});

test('分级阈值与步长是导出常量（Java 侧必须同口径）', () => {
  assert.equal(cfg.door.openOkDeg, 90);
  assert.equal(cfg.door.openWarnDeg, 60);
  assert.equal(cfg.door.sweepStepDeg, 1);
  assert.equal(clearanceLevel(90), 'ok');
  assert.equal(clearanceLevel(89), 'warn');
  assert.equal(clearanceLevel(60), 'warn');
  assert.equal(clearanceLevel(59), 'bad');
  assert.equal(clearanceLevel(0), 'bad');
  assert.equal(clearanceLevel(null), 'n/a');
});

test('不阻断：布局**合法**（无重叠无压墙）但门开不了 —— 这正是这条规则存在的理由', async () => {
  const { checkItem } = await import('../src/validate.js');
  // 两台相隔 0.37 m：柜体互不重叠（占地合法），但 demo-cabinet-800 的门只能开 19°
  const body = layout([item(1, 'demo-cabinet-800', 2, 2), item(2, 'demo-freezer-dual', 2, 3.35)]);
  assert.equal(checkItem(body, body.items[0], getProduct), null, '占地本身必须合法');
  const row = clearanceReport(body, getProduct).find((x) => x.id === 1);
  assert.equal(row.freeDeg, 19);
  assert.equal(row.level, 'bad');
});

test('耦合事实：freeDeg=0 时占地必然也已经重叠（关门位的门板在占地框内）', async () => {
  const { checkItem } = await import('../src/validate.js');
  const body = layout([item(1, 'demo-cabinet-800', 2, 2), item(2, 'demo-freezer-dual', 2, 2.6)]);
  assert.equal(clearanceReport(body, getProduct).find((x) => x.id === 1).freeDeg, 0);
  assert.match(String(checkItem(body, body.items[0], getProduct)), /overlap-item/, '重叠判据应当同时报出来');
  // 所以净空规则真正独立贡献的区间是 (0, maxDeg]：重叠判据管不到那里（上面 19° 那条就是证据）。
});

test('自动摆放后的一句话：都开得到底 → 空串（界面照旧，不多话）', () => {
  const body = layout([item(1, 'demo-cabinet-800', 2, 2)]);
  assert.equal(doorTroubleClause(clearanceReport(body, getProduct), 1), '');
});

test('自动摆放后的一句话：台数 / 最差的那台 / 阈值全都对得上', () => {
  // 合法摆放（无重叠），但门只能开 19° —— 这正是规则 7 存在的理由
  const body = layout([item(1, 'demo-cabinet-800', 2, 2), item(2, 'demo-freezer-dual', 2, 3.35)]);
  const rows = clearanceReport(body, getProduct);
  const n = rows.filter((r) => r.level !== 'ok').length;
  const worst = rows.filter((r) => r.level !== 'ok').reduce((a, b) => (b.freeDeg < a.freeDeg ? b : a));

  const mine = doorTroubleClause(rows, 1);
  assert.match(mine, new RegExp(`其中 ${n} 台`), '台数要和体检报告一模一样');
  assert.match(mine, new RegExp(`开不到 ${cfg.door.openOkDeg}°`), '阈值必须来自参数表，不是写死的 90');
  assert.match(mine, new RegExp(`最多 ${worst.freeDeg}°`), '最差那台的角度要对');

  // 说话的对象不同，指代也不同：最差的就是刚放的那台时说"刚放的这台"，否则点名 #id
  const other = doorTroubleClause(rows, worst.id === 1 ? 2 : 1);
  assert.match(other, worst.id === 1 ? /#1/ : /刚放的这台/);
});

test('自动摆放后的一句话：只数开不到底的（绿的不算），一个人都没有时就是空串', () => {
  // 纯函数断言：不猜几何，直接喂报告形状 —— 几何那一半由上一条用例负责
  // （写这条时我先猜过 demo-cabinet-800 在 (6,4.5) 是绿的，其实它的门会撞到房间边界 —— 门板几何里
  //   "出房间"和"撞到柜子"同样算挡住，见 outOfRoom）
  const rows = [
    { id: 1, freeDeg: 106, level: 'ok' },
    { id: 2, freeDeg: 62, level: 'warn' },
  ];
  const clause = doorTroubleClause(rows, 2);
  assert.match(clause, /其中 1 台/, '绿的那台不该被数进去');
  assert.match(clause, /刚放的这台/, '最差的就是刚放的那台，就该这么说');
  assert.equal(doorTroubleClause([{ id: 1, freeDeg: 106, level: 'ok' }], 1), '');
});
