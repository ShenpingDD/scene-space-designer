/**
 * wall-join.test.js —— 画墙的「贴边 / 贴墙」吸附（用户反馈：内墙贴不到外墙，差 5 cm）。
 *
 * 为什么单独一组：这条规则会**动用户拖出来的坐标**，所以它必须被钉死在三件事上 ——
 *   ① 够近才吸（0.15 m），远了**一个字都不许改**；
 *   ② 吸完要**真的贴上**（坐标精确等于边界/墙线，不是"差不多"）；
 *   ③ 改动幅度 ≤ 容差（不许借"吸附"之名把墙悄悄拉长/挪位）；
 *   ④ Shift（free）= 一点都不吸（半吸不吸最难受）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addWall, joinPoint, WALL_JOIN_M } from '../src/placement.js';
import { mkWallSeg, wallSeg } from '../src/wall.js';
/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);


// 与 wallpieces.test.js 同一个房间夹具（createLayout 不接受参数，别用它造测试房间）
const room = (w = 4.05, d = 3, walls = [], h = 2.6) => ({ w, d, h, walls, items: [] });

test('远离一切 → 一个字都不改（kind=none）', () => {
  const L = room();
  const j = joinPoint(L, { x: 2.0, z: 1.5 });
  assert.equal(j.kind, 'none');
  assert.deepEqual([j.x, j.z], [2.0, 1.5]);
});

test('贴右边界：只动 x，z 保持用户拖到的位置', () => {
  const L = room(4.05, 3);
  const j = joinPoint(L, { x: 4.0, z: 1.5 });
  assert.equal(j.kind, 'boundary');
  assert.equal(j.x, 4.05, '⭐ 必须精确落在边界上（4.05 不是 4.0）');
  assert.equal(j.z, 1.5, 'z 不该被动');
});

test('贴四条边界（各轴独立）', () => {
  const L = room(4.05, 3.02);
  assert.equal(joinPoint(L, { x: 0.05, z: 1.5 }).x, 0);
  assert.equal(joinPoint(L, { x: 2, z: 2.95 }).z, 3.02);
  assert.equal(joinPoint(L, { x: 2, z: 0.04 }).z, 0);
});

test('超出容差就不吸', () => {
  const L = room(4.05, 3);
  const j = joinPoint(L, { x: 4.05 - WALL_JOIN_M - 0.01, z: 1.5 });
  assert.equal(j.kind, 'none');
});

test('投影到已有墙的线上（T 形接头）', () => {
  const L = room(6, 4, [W(2, 0, 2, 4)]);
  const j = joinPoint(L, { x: 2.02, z: 1.5 });
  assert.equal(j.kind, 'wall-line');
  assert.equal(j.x, 2, '⭐ 精确落在墙线 x=2 上');
  assert.equal(j.z, 1.5);
});

test('吸附到已有墙的端点（线段之外时）', () => {
  const L = room(6, 4, [W(2, 0, 2, 3)]);
  const j = joinPoint(L, { x: 2.05, z: 3.04 });
  assert.equal(j.kind, 'wall-end');
  assert.deepEqual([j.x, j.z], [2, 3]);
});

test('线段之内的点走线、线段之外的点走端点（同一根墙，两种规则）', () => {
  // 短墙 [2,2]→[2,3]，两个端点都离边界很远，免得边界规则先命中
  const L = room(6, 4, [W(2, 2, 2, 3)]);
  assert.equal(joinPoint(L, { x: 2.03, z: 2.5 }).kind, 'wall-line', '线段之内 → 投到线上');
  assert.equal(joinPoint(L, { x: 2.03, z: 3.05 }).kind, 'wall-end', '线段之外、离端点很近 → 吸到端点');
});

test('端点：点在线段之外时吸到最近的那个端点', () => {
  const L = room(6, 4, [W(2, 0.5, 2, 0.5 + 1)]);
  const j = joinPoint(L, { x: 2.03, z: 1.54 });
  assert.equal(j.kind, 'wall-end');
  assert.deepEqual([j.x, j.z], [2, 1.5]);
});

test('⭐ 多个候选都够近 → 谁近谁生效（不做优先级，行为才说得清）', () => {
  // 点离墙线 0.02、离左边界 0.03 → 吸到墙线（而不是"因为边界更硬"就吸边界）
  const L = room(6, 4, [W(0, 0.5, 2, 0.5)]);
  const j = joinPoint(L, { x: 0.03, z: 0.52 });
  assert.equal(j.kind, 'wall-line');
  assert.deepEqual([j.x, j.z], [0.03, 0.5]);
});

test('⭐ 差分：房间 4.05 宽时，内墙真的贴到外墙（旧行为停在 4.0）', () => {
  const L = room(4.05, 3);
  const r = addWall(L, { x: 0.3, z: 1.0 }, { x: 4.0, z: 1.05 });
  assert.equal(r.ok, true);
  const w = r.layout.walls[0];
  assert.deepEqual(w, W(0.3, 1.0, 4.05, 1.0), '终点必须精确贴在右外墙（4.05）上，且方向吸附成水平');
});

test('起点的贴边也生效（用户是从外墙起笔的）', () => {
  const L = room(4.05, 3);
  const r = addWall(L, { x: 0.05, z: 1.0 }, { x: 3.0, z: 1.02 });
  const w = r.layout.walls[0];
  assert.equal(seg(w)[0], 0, '起点精确贴左外墙');
  assert.equal(seg(w)[3], seg(w)[1], '水平（方向吸附仍需在贴边之后成立）');
});

test('贴到已有墙的端点 = 两根墙真正共用同一个点', () => {
  const L = room(6, 4, [W(2, 0, 2, 3)]);
  const r = addWall(L, { x: 4.0, z: 3.03 }, { x: 2.04, z: 3.04 });
  const w = r.layout.walls[1];
  assert.deepEqual([seg(w)[2], seg(w)[3]], [2, 3], '第二根墙的终点 = 第一根墙的端点（不是差几毫米）');
});

test('⭐ 改动幅度 ≤ 容差（不许借吸附把墙拉长）', () => {
  const L = room(4.05, 3);
  for (const z of [0.4, 1.0, 2.2]) {
    const r = addWall(L, { x: 0.3, z }, { x: 4.05 - 0.1, z });
    const w = r.layout.walls[0];
    const before = Math.hypot(4.05 - 0.1 - 0.3, 0);
    const after = Math.hypot(seg(w)[2] - seg(w)[0], seg(w)[3] - seg(w)[1]);
    assert.ok(Math.abs(after - before) <= WALL_JOIN_M + 1e-9, `长度变化 ${after - before} 超过容差`);
  }
});

test('Shift（free）：角度不吸、贴边也不吸', () => {
  const L = room(4.05, 3);
  const r = addWall(L, { x: 0.05, z: 1.0 }, { x: 4.0, z: 1.05 }, { free: true });
  const w = r.layout.walls[0];
  assert.equal(seg(w)[0], 0.05, '起点保持用户拖到的位置');
  assert.equal(seg(w)[2], 4.0, '终点保持用户拖到的位置');
  assert.equal(seg(w)[3], 1.05, '方向也不吸');
});

test('贴边之后仍不会越界（自己生成的文件自己读得回来）', () => {
  const L = room(4.05, 3.02);
  const r = addWall(L, { x: 0.1, z: 0.1 }, { x: 4.04, z: 3.01 });
  const [x, z, xx, zz] = seg(r.layout.walls[0]);
  assert.ok(x >= 0 && x <= 4.05 && xx >= 0 && xx <= 4.05, 'x 在房间内');
  assert.ok(z >= 0 && z <= 3.02 && zz >= 0 && zz <= 3.02, 'z 在房间内');
});

test('没有墙 / 空参数不炸', () => {
  assert.equal(joinPoint(room(), null), null);
  assert.equal(joinPoint({ w: 4, d: 3 }, { x: 1, z: 1 }).kind, 'none');
  assert.equal(joinPoint(room(), { x: 1, z: 1 }, { join: NaN }).kind, 'none');
});