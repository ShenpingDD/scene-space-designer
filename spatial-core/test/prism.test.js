/**
 * 棱柱断言 —— 墙体构件斜接之后不再是矩形，三维得靠"多边形挤出棱柱"。
 * 这里只用**几何恒等式**验它，不看渲染：
 *   ① 有向体积（散度定理）= 底面积 × 高 —— 一条式子同时验了"面是闭合的"和"缠绕朝外"；
 *   ② 每个法线都是单位向量；
 *   ③ 三角形个数 = 2·(n−2) + 2n（上下两个扇形 + n 个侧面各 2 个）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { prismFaces } from '../src/prism.js';
import { polyArea } from '../src/wallpieces.js';

const vol = (positions) => {
  let v = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const a = [positions[i], positions[i + 1], positions[i + 2]];
    const b = [positions[i + 3], positions[i + 4], positions[i + 5]];
    const c = [positions[i + 6], positions[i + 7], positions[i + 8]];
    // a · (b × c) / 6
    const cx = b[1] * c[2] - b[2] * c[1];
    const cy = b[2] * c[0] - b[0] * c[2];
    const cz = b[0] * c[1] - b[1] * c[0];
    v += (a[0] * cx + a[1] * cy + a[2] * cz) / 6;
  }
  return v;
};

const SQUARE = [[0, 0], [1, 0], [1, 1], [0, 1]];
const SQUARE_CW = [...SQUARE].reverse();
const PENTA = [[0, 0], [0.5, 0], [0.8, 0.3], [0.4, 0.7], [-0.1, 0.5]];   // 斜接后那种五边形

test('正方形：体积 = 底面积 × 高（缠绕朝外）', () => {
  const g = prismFaces(SQUARE, 2.8);
  assert.ok(Math.abs(vol(g.positions) - 1 * 2.8) < 1e-9, `有向体积：${vol(g.positions)}`);
  assert.equal(g.triangles, 2 * (4 - 2) + 2 * 4);
});

test('顶点顺序反过来（顺时针）也一样：缠绕是当场算的，不靠约定', () => {
  const g = prismFaces(SQUARE_CW, 2.8);
  assert.ok(Math.abs(vol(g.positions) - 2.8) < 1e-9, `有向体积必须仍为正：${vol(g.positions)}`);
});

test('五边形（斜接后的构件形状）：体积也对', () => {
  const area = Math.abs(polyArea(PENTA));
  const g = prismFaces(PENTA, 2.6);
  assert.ok(Math.abs(vol(g.positions) - area * 2.6) < 1e-9, `体积：${vol(g.positions)} vs ${area * 2.6}`);
  assert.equal(g.triangles, 2 * (5 - 2) + 2 * 5);
});

test('法线都是单位向量，且顶面朝上、底面朝下', () => {
  const g = prismFaces(PENTA, 2.6);
  let up = 0;
  let down = 0;
  for (let i = 0; i < g.normals.length; i += 3) {
    const l = Math.hypot(g.normals[i], g.normals[i + 1], g.normals[i + 2]);
    assert.ok(Math.abs(l - 1) < 1e-9, `法线不是单位向量：${l}`);
    if (g.normals[i + 1] > 0.999) up++;
    if (g.normals[i + 1] < -0.999) down++;
  }
  assert.ok(up >= 3, '顶面至少 3 个三角形（五边形扇形）');
  assert.equal(up, down, '顶面与底面三角形一样多');
});

test('侧面法线是水平的，而且指向多边形外面', () => {
  const g = prismFaces(PENTA, 2.6);
  // ⚠️ 三角形要按 9 个浮点一组走；按 3 个一组走会把"顶点"和"法线"两串错位地读，
  //    算出来的"重心"是垃圾 —— 断言就会冤枉好人（第一版就是这么红了一条）。
  const gx = PENTA.reduce((s, p) => s + p[0], 0) / PENTA.length;
  const gz = PENTA.reduce((s, p) => s + p[1], 0) / PENTA.length;
  let sides = 0;
  for (let t = 0; t < g.triangles; t++) {
    const i = t * 9;
    const ny = g.normals[i + 1];
    if (Math.abs(ny) > 0.5) continue;                      // 上下底面跳过
    sides++;
    assert.ok(Math.abs(ny) < 1e-9, '侧面法线必须是水平的');
    const mid = [
      (g.positions[i] + g.positions[i + 3] + g.positions[i + 6]) / 3,
      (g.positions[i + 2] + g.positions[i + 5] + g.positions[i + 8]) / 3,
    ];
    assert.ok(g.normals[i] * (mid[0] - gx) + g.normals[i + 2] * (mid[1] - gz) > 0, '侧面法线指向了里面');
  }
  assert.equal(sides, 10, '五边形 → 10 个侧面三角形');
});

test('少于 3 个点：什么都不出，也不抛异常', () => {
  const g = prismFaces([[0, 0], [1, 0]], 2);
  assert.equal(g.triangles, 0);
  assert.equal(g.positions.length, 0);
});