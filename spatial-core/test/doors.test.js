/**
 * 规则 4 断言集：门语义 + 通行碰撞
 * 基准：`02_walkthrough.js` / `09_model-factory.js` 的原始实现；
 *      末尾两条是**故意钉住的已知缺陷**（FIX-16/17），R3 修好时这两条必须改。
 */

import { cfg } from '../src/params.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout } from '../src/room.js';
import { addItem } from '../src/placement.js';
import {
  canOpen, hingeRotation, clampDoorAmount, doorButtonLabel, doorPartLabel, doorStateText,
  setDoorAmount, NO_HINGES,
} from '../src/doors.js';
import {
  blocked, doorIsBlocking, safeSpawn, moveWithCollision, isStuck,
} from '../src/collision.js';

const CATALOG = new Map([['demo-freezer-dual', { id: 'demo-freezer-dual', w: 0.99, d: 0.8712, h: 1.98 }]]);
const get = (id) => CATALOG.get(id);

/* ---------------- 门语义 ---------------- */

test('门能不能开取决于模型有没有铰链，而不是 UI 判断（FIX-12 的来源）', () => {
  assert.equal(canOpen({ hinges: [{ axis: 'y', openAngle: 1.85 }] }), true);
  assert.equal(canOpen({ hinges: [] }), false);
  assert.equal(canOpen(null), false);
  assert.equal(NO_HINGES, '当前模型缺少门体节点，请更新开门版模型');
});

test('铰链旋转公式全项目唯一：rotation[axis] = openAngle × amount', () => {
  assert.deepEqual(hingeRotation({ axis: 'y', openAngle: 1.85 }, 1), { y: 1.85 });
  assert.deepEqual(hingeRotation({ axis: 'x', openAngle: -1.55 }, 0.5), { x: -0.775 });
  assert.deepEqual(hingeRotation({ axis: 'y', openAngle: 1.85 }, 0), { y: 0 });
});

test('开度夹取到 [0,1]，非法值归 0', () => {
  assert.equal(clampDoorAmount(-0.5), cfg.door.amountMin);
  assert.equal(clampDoorAmount(3), cfg.door.amountMax);
  assert.equal(clampDoorAmount(NaN), 0);
  assert.equal(clampDoorAmount('x'), 0);
});

test('文案与原型一致（部位按型号）', () => {
  // V8 起：参数是**门型代码**（不是产品 id）—— 文案保持不变，钉子也换成字面量
  assert.equal(doorButtonLabel('double', 0), '打开双门');
  assert.equal(doorButtonLabel('double', 1), '关闭双门');
  assert.equal(doorButtonLabel('top', 1), '关闭上盖');
  assert.equal(doorButtonLabel('single', 1), '关闭柜门');
  assert.equal(doorPartLabel('drawer'), '抽屉', '预留代码也得有文案');
  assert.equal(doorPartLabel('none'), '无门', '⚠️ 显式无门 = 已验证的事实，不能说成柜门');
  assert.equal(doorPartLabel('柜门'), '柜门', '过渡期：认不出的原样显示，不假装认识');
  assert.equal(doorPartLabel(''), '未确认', '⚠️ 空值 = 没填，不是柜门（旧兜底会凭空造一扇门）');
  assert.equal(doorPartLabel(null), '未确认', 'null 也不许炸，更不许冒充柜门');
  assert.equal(doorStateText(0), '已关闭');
  assert.equal(doorStateText(0.375), '已打开 38%');
});

test('开门写进方案（纯函数，不改原对象）', () => {
  const layout = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get }).layout;
  const next = setDoorAmount(layout, layout.items[0].id, 0.6);
  assert.equal(next.items[0].doorAmount, 0.6);
  assert.equal(layout.items[0].doorAmount, 0);
});

/* ---------------- 通行碰撞 ---------------- */

test('房间边界内缩一个身位', () => {
  const layout = createLayout({ w: 8, d: 6 });
  assert.equal(blocked(0.2, 3, layout, get), true);
  assert.equal(blocked(cfg.walk.radiusM + 0.4, cfg.walk.radiusM + 0.4, layout, get), false);
});

test('墙的安全距离是 radius + 0.06（原型口径）', () => {
  const layout = createLayout({ w: 8, d: 6 });
  const near = cfg.walk.radiusM + cfg.walk.wallClearanceM - 0.02;
  assert.equal(blocked(4, near, layout, get), true);
  assert.equal(blocked(4, cfg.walk.radiusM + cfg.walk.wallClearanceM + 0.02, layout, get), false);
});

test('站在设备里会被判被挡（这就是 FIX-17 卡死的成因）', () => {
  const layout = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get, pos: { x: 4, z: 3 } }).layout;
  assert.equal(blocked(4, 3, layout, get), true);
  assert.equal(blocked(6.5, 4.5, layout, get), false);
});

test('门只在人体高度区间内算障碍', () => {
  assert.equal(doorIsBlocking({ minY: 0.5, maxY: 1.9 }), true);
  assert.equal(doorIsBlocking({ minY: 1.9, maxY: 2.4 }), false); // 高位柜门不挡人
});

test('safeSpawn 一定返回可站立点；全被占满时返回 null', () => {
  const layout = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get }).layout;
  const spawn = safeSpawn(layout, get);
  assert.ok(Array.isArray(spawn));
  assert.equal(blocked(spawn[0], spawn[1], layout, get), false);
  const tiny = createLayout({ w: 3, d: 3 });
  tiny.items = Array.from({ length: 9 }, (_, k) => ({ id: k + 1, p: 'demo-freezer-dual', x: 0.5 + (k % 3), z: 0.5 + Math.floor(k / 3), r: 0, doorAmount: 0 }));
  assert.equal(safeSpawn(tiny, get), null);
});

test('撞墙时沿墙滑动，而不是完全停住', () => {
  const layout = createLayout({ w: 8, d: 6 });
  const test1 = (x, z) => x > 4; // 右侧被挡
  const [x, z] = moveWithCollision(4, 3, 1, 1, test1);
  assert.ok(x <= 4, 'x 方向不应越过障碍');
  assert.ok(z > 3, 'z 方向应继续前进（滑动）');
});

/* ---------------- 已知缺陷（R3 修复时这两条必须显式改掉） ---------------- */

test('已知缺陷 FIX-16：开门后的 AABB 会在空地上造出隐形障碍', () => {
  const layout = createLayout({ w: 8, d: 6 });
  // 门板全开时扫掠成一个 1.2×1.2 的 AABB（真实门板只是一片薄板）
  const doorBox = { minX: 4, minZ: 3, maxX: 5.2, maxZ: 4.2, minY: 0.1, maxY: 1.9 };
  // 这一点在几何上是一片空地板（门板只占其中一条边），原型却会挡住
  assert.equal(blocked(5.1, 4.1, layout, get, [doorBox]), true);
});

test('已知缺陷 FIX-17：被嵌入后无法自行脱困', () => {
  const layout = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get, pos: { x: 4, z: 3 } }).layout;
  const stuck = isStuck(4, 3, layout, get);
  assert.equal(stuck, true);
  // 原型在卡死时任何方向都动不了（moveWithCollision 只拒绝、不推出）
  const [x, z] = moveWithCollision(4, 3, 0.6, 0, (px, pz) => blocked(px, pz, layout, get));
  assert.deepEqual([x, z], [4, 3]);
});