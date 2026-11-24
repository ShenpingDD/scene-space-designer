/**
 * wall-bounds.test.js —— B19：墙也要跟房间比（纯函数级）
 *
 * 洞在哪：导入校验与体检都只把墙当成"线"查（4 个数 / 水平或垂直 / 够长）。
 * 一面待在房间外的墙会被**原样收下** —— 它不挡设备、也不进任何结论，安安静静留在方案里。
 * 手改过的文件就能带进来（`exportScheme` 产的文件不会，因为画墙有吸附）。
 *
 * 所以这里最值钱的两条是**一正一反**：
 *   ① 手改出来的越界墙必须被拒（带得出原因码）；
 *   ② **正常文件必须照样能导入** —— 尤其是那四面贴在边界上的外墙（判据对它们是"恰好合法"）。
 * 只做 ① 很危险：把判据写严一点就能让所有正常文件都进不来，而测试还是绿的。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WALL_REASON, checkAllWalls, checkWall } from '../src/validate.js';
import { IMPORT_ERROR, exportScheme, importScheme } from '../src/scheme.js';
import { mkWallSeg, wallSeg } from '../src/wall.js';
/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);

const CAT = { 'demo-cabinet-800': { id: 'demo-cabinet-800', w: 0.6, d: 0.66, h: 1.8 } };
const getProduct = (id) => CAT[id];

/** 8×6 的房间，四面外墙 + 一面内墙（2,2)–(2,5) */
const base = () => ({
  w: 8, d: 6, h: 2.8,
  walls: [W(0, 0, 8, 0), W(8, 0, 8, 6), W(8, 6, 0, 6), W(0, 6, 0, 0), W(2, 2, 2, 5)],
  items: [{ id: 1, p: 'demo-cabinet-800', x: 0.7, z: 0.7, r: 0, doorAmount: 0 }],
});

test('B19：贴边合法 —— 外墙正好压着边界（x=0..w），判据不许把它算成"越界"', () => {
  const l = base();
  assert.equal(checkWall(l, W(0, 0, 8, 0)), WALL_REASON.OK, '外墙跳过');
  assert.equal(checkWall(l, W(2, 2, 2, 5)), WALL_REASON.OK, '屋里的内墙');
  assert.equal(checkWall(l, W(0, 1, 0, 4)), WALL_REASON.OK, '内墙贴着边界也不算越界（x=0 是合法的）');
  assert.deepEqual(checkAllWalls(l), [], '整间房干净');
});

test('B19：探出去的墙必须报 wall-out-of-room，而且要报出**序号**', () => {
  const l = base();
  l.walls.push(W(9, 1, 9, 4));          // x=9 > w=8
  l.walls.push(W(1, -2, 4, -2));        // z=-2 < 0
  const bad = checkAllWalls(l);
  assert.deepEqual(bad.map((b) => b.index), [5, 6], '墙没有 id，用序号（与 data-wall-index 同编号）');
  assert.ok(bad.every((b) => b.reason === WALL_REASON.WALL_OUT_OF_ROOM));
});

test('B19：⭐ 一正一反 —— 手改的越界墙被拒，而**正常文件照样进得来**', () => {
  const good = `{"format":"scene-space-designer","state":${JSON.stringify(base())}}`;
  const r1 = importScheme(good, { getProduct });
  assert.equal(r1.ok, true, '正常文件（含四面贴边外墙）必须能导入 —— 判据不许把边界当越界');
  assert.equal(r1.layout.walls.length, 5);

  const l = base();
  l.walls.push(W(9, 1, 9, 4));
  const r2 = importScheme(exportScheme(l), { getProduct });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, IMPORT_ERROR.WALL_OUT_OF_ROOM.reason);
  assert.equal(r2.message, IMPORT_ERROR.WALL_OUT_OF_ROOM.message);
});