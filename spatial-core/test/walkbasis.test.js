/**
 * walkbasis.test.js —— 第一人称「前/右」基准。
 *
 * 用户报的是"感觉 A/D 反了"。手感说不清哪条轴，所以这里把它变成**可计算的断言**：
 * ① 四个朝向的前/右向量逐个对表；
 * ② 「右」必须满足"前向顺时针 90°"（在 x 右 / z 下的平面里 = `(−f_z, f_x)`）；
 * ③ 与**相机基准**互证：`rotation.y = π + yaw` 的 three.js 相机，局部 +x 轴在世界里
 *    正好是 `(−cos yaw, sin yaw)` —— 用矩阵算一遍，跟 ② 的结果比对。
 *    （这条是"为什么不是另一种符号"的硬证据，不是我的偏好。）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveBasis, stepVector, DEG } from '../src/walkbasis.js';

// `-0` 与 `0` 在 deepEqual 里不相等（JS 的坑）；这里统一归一，免得断言在噪音上红
const round = (v) => (Math.round(v * 1e6) / 1e6) + 0;
const xy = (v) => [round(v.fx), round(v.fz)];
const rt = (v) => [round(v.rx), round(v.rz)];

/** three.js：绕 +Y 转 θ 的矩阵（与 three 的欧拉约定一致） */
function rotY(x, z, theta) {
  return [x * Math.cos(theta) + z * Math.sin(theta), -x * Math.sin(theta) + z * Math.cos(theta)];
}

test('yaw=0（面朝 +z / 平面图向下）：前 = +z，右 = −x', () => {
  const b = moveBasis(0);
  assert.deepEqual(xy(b), [0, 1]);
  assert.deepEqual(rt(b), [-1, 0]);
});

test('四个正朝向逐个对表', () => {
  assert.deepEqual(xy(moveBasis(90)), [1, 0], 'yaw=90 → 面朝 +x');
  assert.deepEqual(rt(moveBasis(90)), [0, 1], '面朝 +x 时右手指向 +z');
  assert.deepEqual(xy(moveBasis(180)), [0, -1], 'yaw=180 → 面朝 −z');
  assert.deepEqual(rt(moveBasis(180)), [1, 0], '面朝 −z 时右手指向 +x');
  assert.deepEqual(xy(moveBasis(270)), [-1, 0], 'yaw=270 → 面朝 −x');
  assert.deepEqual(rt(moveBasis(270)), [0, -1], '面朝 −x 时右手指向 −z');
});

test('⭐ 「右」= 相机局部 +x 轴（three.js 矩阵互证，四种朝向）', () => {
  for (const yaw of [0, 37, 90, 180, -60]) {
    const b = moveBasis(yaw);
    // 相机 rotation.y = π + yaw：局部 +x = (1,0,0) 绕 +Y 转 θ
    const theta = Math.PI + yaw * DEG;
    const [wx, wz] = rotY(1, 0, theta);
    assert.equal(round(b.rx), round(wx), `yaw=${yaw} 右向 x 与相机基准不符`);
    assert.equal(round(b.rz), round(wz), `yaw=${yaw} 右向 z 与相机基准不符`);
    // 顺手互证前向 = 局部 −z
    const [fx2, fz2] = rotY(0, -1, theta);
    assert.equal(round(b.fx), round(fx2), `yaw=${yaw} 前向 x 与相机基准不符`);
    assert.equal(round(b.fz), round(fz2), `yaw=${yaw} 前向 z 与相机基准不符`);
  }
});

test('「右」= 「前」按 −90° 旋转（平面图里就是向右转）', () => {
  for (const yaw of [0, 15, 90, 123]) {
    const b = moveBasis(yaw);
    // 转 −90°： (−90° 与 yaw 同向累加后，前后两向量必须一致)
    const b2 = moveBasis(yaw - 90);
    assert.equal(round(b.rx), round(b2.fx), `yaw=${yaw}：右向应等于"朝向−90°的前向"`);
    assert.equal(round(b.rz), round(b2.fz));
  }
});

test('单位长度：前/右都不缩放', () => {
  for (const yaw of [0, 30, 200, -75]) {
    const b = moveBasis(yaw);
    assert.equal(round(Math.hypot(b.fx, b.fz)), 1);
    assert.equal(round(Math.hypot(b.rx, b.rz)), 1);
  }
});

test('步向量：单按前 / 单按右 / 一起按', () => {
  const fwd = stepVector(0, 1, 0);
  assert.deepEqual([round(fwd.dx), round(fwd.dz)], [0, 1], '往前 = +z');

  const right = stepVector(0, 0, 1);
  assert.deepEqual([round(right.dx), round(right.dz)], [-1, 0], '⭐ 往右 = −x（面朝 +z 时的右手向）');

  const both = stepVector(0, 1, 1);
  assert.deepEqual([round(both.dx), round(both.dz)], [-1, 1], '斜着走 = 两组向量相加');
});

test('⭐ 反面证据：把右向取反（旧实现）会走到相机的左手边', () => {
  // 旧代码的右向是 (cos yaw, −sin yaw) = 现在这个的**反**
  const flip = (yaw) => {
    const b = moveBasis(yaw);
    return [-b.rx, -b.rz];
  };
  const b = moveBasis(90);
  // 面朝 +x（东）时，右手应指向 +z（南）；取反就成了 −z（北）—— 这就是用户说的"反着的"
  assert.deepEqual(rt(b), [0, 1]);
  assert.deepEqual(round2(flip(90)), [0, -1]);
});

function round2([x, z]) {
  return [(Math.round(x * 1e6) / 1e6) + 0, (Math.round(z * 1e6) / 1e6) + 0];
}

test('非数/缺参不炸（界面可能传 undefined）', () => {
  assert.deepEqual(xy(moveBasis(undefined)), [0, 1]);
  const v = stepVector(0, undefined, undefined);
  assert.deepEqual([v.dx, v.dz], [0, 0]);
});