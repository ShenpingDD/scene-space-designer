/**
 * columns.test.js —— 矩形柱 P1 最小闭环（设计决策记录 §二/§三）
 *
 * 先钉住最容易静默出错的三件事：
 *  - 0.2/3.0 的判据必须**先 1 mm 取整再比较**；
 *  - 柱-柱/设备/洞口是拒绝，柱-墙是允许（结构柱嵌墙常态）；
 *  - 柱不进 rooms 派生；空 columns 不改变导出形状，含柱必须逐字节往返。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { boundaryWalls, createLayout } from '../src/room.js';
import { mkWallSeg } from '../src/wall.js';
import { roomsOf } from '../src/rooms.js';
import { exportScheme, importScheme, FORMAT } from '../src/scheme.js';
import {
  checkColumn, cloneColumn, columnAreaTotal, columnAt, columnRect, columns2d,
  columnsInRect, columnsOf, columnsOutOfBounds, readColumn, readColumns,
  shiftColumns, usableAreaOf, COLUMN_REASON,
} from '../src/columns.js';

const W = (x, z, xx, zz, openings) => mkWallSeg(x, z, xx, zz, openings || []);
const box = (extra = {}) => ({
  ...createLayout({ w: 8, d: 6, h: 2.8 }),
  ...extra,
});
const col = (x, z, w = 0.5, d = 0.5) => ({ id: 1, x, z, w, d });
const getProduct = () => ({ w: 0.5, d: 0.5 });

test('默认：无 columns 是空数组，不因缺字段报错', () => {
  const l = box();
  assert.deepEqual(columnsOf(l), []);
  assert.equal(columnAt(l, 4, 3), null);
  assert.equal(columnAreaTotal(l), 0);
  assert.deepEqual(columns2d(l), []);
});

test('边界：四角必须完整在场景内；贴边合法，越界 1e-3 拒绝', () => {
  const l = box();
  assert.equal(checkColumn(l, col(0.25, 0.25)).ok, true, '贴左下角合法');
  assert.equal(checkColumn(l, col(7.75, 5.75)).ok, true, '贴右上角合法');
  const out = checkColumn(l, col(0.2, 3));
  assert.equal(out.ok, false);
  assert.equal(out.reason, COLUMN_REASON.OUT_OF_SCENE);
  assert.equal(out.message, '柱必须完整在场景内');
});

test('最小/最大：先 1 mm 取整再比较（0.1995→0.200 合法，0.1994→0.199 拒绝）', () => {
  const l = box();
  assert.equal(readColumn(col(4, 3, 0.1994, 0.5)).w, 0.199);
  assert.equal(checkColumn(l, col(4, 3, 0.1995, 0.5)).ok, true);
  assert.equal(checkColumn(l, col(4, 3, 0.1994, 0.5)).reason, COLUMN_REASON.TOO_SMALL);
  assert.equal(checkColumn(l, col(4, 3, 3.0004, 0.5)).ok, true);
  assert.equal(checkColumn(l, col(4, 3, 3.0006, 0.5)).reason, COLUMN_REASON.TOO_LARGE);
  assert.equal(checkColumn(l, col(4, 3, 0.1994, 0.5)).message, '柱边长小于下限（0.2 m）');
  assert.equal(checkColumn(l, col(4, 3, 3.0006, 0.5)).message, '柱边长超过上限（3.00 m）');
});

test('柱-柱：接触合法，实际相交拒绝；柱-墙允许', () => {
  const l = box({
    walls: [W(4, 0, 4, 6)],
    columns: [{ id: 1, x: 2, z: 2, w: 0.5, d: 0.5 }],
  });
  const touch = checkColumn(l, { id: 2, x: 2.5, z: 2, w: 0.5, d: 0.5 });
  assert.equal(touch.ok, true, '间隙 0 允许');
  const overlap = checkColumn(l, { id: 2, x: 2.4, z: 2, w: 0.5, d: 0.5 });
  assert.equal(overlap.reason, COLUMN_REASON.OVERLAP);
  assert.match(overlap.message, /与柱 #1 重叠/);
  // 柱压在墙上：柱-墙允许，不产生 wall 冲突
  assert.equal(checkColumn(l, { id: 3, x: 4, z: 3, w: 0.2, d: 0.2 }).ok, true);
});

test('柱-设备：设备 OBB 与柱相交拒绝；柱-洞口相交拒绝', () => {
  const l = box({
    walls: [W(0, 0, 8, 0, [{ at: 4, w: 0.9, h: 2.1 }])],
    items: [{ id: 7, p: 'p', x: 4, z: 3, r: 0, doorAmount: 0 }],
  });
  const hitItem = checkColumn(l, col(4, 3), { getProduct });
  assert.equal(hitItem.reason, COLUMN_REASON.ON_ITEM);
  assert.match(hitItem.message, /设备 #7/);

  const hitOpening = checkColumn(l, col(4, 0.3), { getProduct: () => null });
  assert.equal(hitOpening.reason, COLUMN_REASON.BLOCKS_OPENING);
  assert.match(hitOpening.message, /墙 #1/);
});

test('导入结构：重复编号/坏形状/越界/超量整份拒绝；关系冲突宽容', () => {
  const base = { w: 8, d: 6, columns: [] };
  assert.equal(readColumns([{ id: 1, x: 4, z: 3, w: 0.5 }], base).reason, 'bad-column');
  assert.equal(readColumns([col(4, 3), col(4, 4)], base).reason, 'duplicate-column-id');

  const overlap = readColumns([
    col(4, 3), { id: 2, x: 4.1, z: 3, w: 0.5, d: 0.5 },
  ], base);
  assert.equal(overlap.ok, true, '导入不因叠柱打不开');

  const many = Array.from({ length: 50 }, (_, i) => ({
    id: i + 1, x: 0.2 + (i % 10) * 0.6, z: 0.2 + Math.floor(i / 10) * 0.6, w: 0.2, d: 0.2,
  }));
  assert.equal(readColumns([...many, { id: 51, x: 7, z: 5, w: 0.2, d: 0.2 }], base).reason, 'too-many-columns');
});

test('格式：空柱不发射；含柱往返逐字节；旧 W4 仍可导入', () => {
  const empty = box();
  const emptyText = exportScheme(empty);
  assert.equal(emptyText.includes('"columns"'), false, '空 columns 不能出现在 state 里');
  assert.ok(emptyText.includes(FORMAT));

  let l = box({ columns: [col(4, 3), { id: 2, x: 2, z: 2, w: 0.2, d: 0.3 }] });
  const text = exportScheme(l);
  const round = importScheme(text);
  assert.equal(round.ok, true);
  assert.deepEqual(round.layout.columns, l.columns);
  assert.equal(round.nextColumnId, 3);
  assert.equal(exportScheme(round.layout), text);

  const old = importScheme({
    format: 'scene-space-designer-scene-routes',
    state: { w: 8, d: 6, h: 2.8, walls: [W(0, 0, 8, 0)], items: [] },
  });
  assert.equal(old.ok, true);
  assert.deepEqual(old.layout.columns, []);
  assert.equal(exportScheme(old.layout).includes('"columns"'), false);
});

test('rooms 派生不吃 columns；面积只扣四角都在面内的柱', () => {
  const walls = boundaryWalls(8, 6);
  const base = { w: 8, d: 6, h: 2.8, walls, items: [] };
  const withCol = { ...base, columns: [col(4, 3)] };
  assert.equal(roomsOf(withCol).length, roomsOf(base).length);
  assert.equal(roomsOf(withCol)[0].id, roomsOf(base)[0].id);
  assert.equal(roomsOf(withCol)[0].area, 48);

  const poly = [[0, 0], [8, 0], [8, 6], [0, 6]];
  const usable = usableAreaOf({ poly, area: 48 }, [
    col(4, 3),              // 完全在内
    col(9, 3),              // 完全在外
  ]);
  assert.equal(usable, 48 - 0.25);
});

test('查询/平移：columnAt/columnsInRect/shift/越界清单', () => {
  const l = box({ columns: [col(4, 3), { id: 2, x: 1, z: 1, w: 0.2, d: 0.2 }] });
  assert.equal(columnAt(l, 4.2, 3.2).id, 1);
  assert.equal(columnAt(l, 7, 5), null);
  assert.deepEqual(columnsInRect(l, { x0: 3, z0: 2, x1: 5, z1: 4 }).map((c) => c.id), [1]);
  assert.equal(shiftColumns(columnsOf(l), 1, 0)[1].x, 2);
  assert.deepEqual(columnsOutOfBounds([col(0.1, 0.1)], 8, 6).map((x) => x.id), [1]);
});

test('cloneColumn 只写 id→x→z→w→d，顺序稳定', () => {
  const c = cloneColumn({ id: 1, x: 4, z: 3, w: 0.5, d: 0.5, color: 'red' });
  assert.deepEqual(Object.keys(c), ['id', 'x', 'z', 'w', 'd']);
  assert.deepEqual(Object.values(c), [1, 4, 3, 0.5, 0.5]);
});


test('跨语言 fixture：columns-scheme.json 与 exportScheme 逐字节一致（JS/Java 同字节）', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixture = readFileSync(join(here, 'cases', 'columns-scheme.json'), 'utf8');
  const r = importScheme(fixture);
  assert.equal(r.ok, true);
  assert.equal(exportScheme(r.layout), fixture);
  assert.deepEqual(r.layout.columns.map((c) => c.id), [1, 2]);
});
