/**
 * walk-collision.test.js —— B17：漫游碰撞（`walkStep`）
 *
 * 这条规则来源是旧原型的 `moveWithCollision`，但**新版漫游从来没调用过它** ——
 * 界面上"能走进柜子里"不是规则写错，是**没接线**。接线之后这里钉三件事：
 *
 *   ① 撞上就停/沿墙滑（不是穿过去）；
 *   ② **FIX-17**：已经陷进几何体里时必须能走出来（原型的"只拒绝"会把人焊死）；
 *   ③ **FIX-16**：关着的门不挡人（挡不挡由调用方传进来的门叶包围盒决定）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blocked, walkStep } from '../src/collision.js';
import { mkWallSeg, wallSeg } from '../src/wall.js';
/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);

/** demo-freezer-dual 的占地包络（与目录夹具一致：0.99 × 0.87） */
const CAT = { 'demo-freezer-dual': { id: 'demo-freezer-dual', w: 0.99, d: 0.87, h: 1.98 } };
const getProduct = (id) => CAT[id];

/** 8×6 的房间，四面外墙；设备 #1 在 (4,3) */
const room = (items = [{ id: 1, p: 'demo-freezer-dual', x: 4, z: 3, r: 0, doorAmount: 0 }]) => ({
  w: 8, d: 6, h: 2.8,
  walls: [W(0, 0, 8, 0), W(8, 0, 8, 6), W(8, 6, 0, 6), W(0, 6, 0, 0)],
  items,
});

test('B17：撞上设备就停住 —— 走不进去', () => {
  const l = room();
  const from = [4, 1.0];
  assert.equal(blocked(4, 1.0, l, getProduct), false, '前提：起点是空的');
  const r = walkStep(4, 1.0, 0, 3.0, l, getProduct);      // 朝设备直冲 3 m
  assert.equal(r.stuck, false);
  assert.ok(r.z < 3 - 0.4, '停在设备外（0.87/2 + 半径），没有被放过去：z=' + r.z);
  assert.equal(blocked(r.x, r.z, l, getProduct), false, '停下的位置必须是站得住的');
});

test('B17：沿墙滑动 —— 一侧被挡，另一侧照走（不是整体停住）', () => {
  const l = room([]);
  // 贴着左外墙(半径+间隙)往前挪：斜着走，x 分量被墙吃掉，z 分量应当照走
  const from = [0.30, 1.0];
  assert.equal(blocked(from[0], from[1], l, getProduct), false, '前提：起点贴着墙但站得住');
  const r = walkStep(from[0], from[1], -0.5, 0.5, l, getProduct);
  assert.ok(r.z > from[1] + 0.3, 'z 方向必须走掉了：' + r.z);
  assert.ok(r.x >= 0.24, 'x 方向被墙挡住（不许穿墙）：' + r.x);
  assert.equal(r.stuck, false);
});

test('B17 / FIX-17：⭐ 已经陷在几何体里时，必须能走出来（放行），并且**说出来**', () => {
  const l = room();
  const inside = [4, 3];                                   // 设备正中心
  assert.equal(blocked(inside[0], inside[1], l, getProduct), true, '前提：确实嵌在里面');
  const r = walkStep(inside[0], inside[1], 0, -0.4, l, getProduct);
  assert.equal(r.stuck, true, 'stuck 必须报出来 —— 界面靠它说明"碰撞临时关闭"');
  assert.equal(r.z, 3 - 0.4, '放行：这一步走了（不是拒绝 —— 拒绝就是永久卡死）');
});

test('B17：走出去之后再走一步就恢复碰撞（放行不是永久的）', () => {
  const l = room();
  const r1 = walkStep(4, 3, 0, -1.2, l, getProduct);
  assert.equal(r1.stuck, true);
  const out = [r1.x, r1.z];
  assert.equal(blocked(out[0], out[1], l, getProduct), false, '这一步之后已经在外面了');
  const r2 = walkStep(out[0], out[1], 0, -3.0, l, getProduct);
  assert.equal(r2.stuck, false, '恢复碰撞：再一次直冲就必须被挡住');
  assert.ok(r2.z > out[1] - 3.0, '没被放过去：' + r2.z);
});

test('B17 / FIX-16：门障碍是**调用方给的门叶盒子** —— 关着的门不挡人', () => {
  const l = room();
  const doorBox = { minX: 4.4, maxX: 5.4, minZ: 2.6, maxZ: 3.4, minY: 0, maxY: 1.95 };
  // ① 关门（amount=0）→ 调用方根本不传这个盒子 → 门框那一带能站人
  assert.equal(blocked(4.9, 3.0, l, getProduct, []), false, '关着的门不挡人（原型漏了这条）');
  // ② 开门（amount>0）→ 盒子被传进来 → 被挡
  assert.equal(blocked(4.9, 3.0, l, getProduct, [doorBox]), true, '开着的门叶挡人');
  // ③ 而上盖（整个盒子都高于人体区间）不该挡 —— 人体区间是 [0.08, 1.8]（walk.* 参数）
  assert.equal(blocked(4.9, 3.0, l, getProduct,
    [{ ...doorBox, minY: 1.9, maxY: 2.4 }]), false, '整个盒子都在 1.8 m 之上（顶盖）→ 不挡人');
});