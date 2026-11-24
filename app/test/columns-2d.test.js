/**
 * columns-2d.test.js —— P2 2D 柱（画/选/移/8 向/删/复制/撤销/柱卡/非法）
 *
 * 纯函数与 designer 的动作在这里钉；Vue 的 DOM/手势由真机探针负责。
 * 校验/几何一律来自 `spatial-core/src/columns.js`，2D 只做 selected/invalid 装饰。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { columns2d, scene2d } from '../src/scene2d.js';
import { checkColumn, usableAreaOf } from '@core/columns.js';
import { designer as d } from '../src/designer.js';
import { createLayout } from '@core/room.js';
import { mkWallSeg } from '@core/wall.js';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const base = () => ({ ...createLayout({ w: 8, d: 6, h: 2.8 }), columns: [] });
const col = (id, x, z, w = 0.5, dd = 0.5) => ({ id, x, z, w, d: dd });

test('columns2d：独立层、矩形路径、AABB、选中态与面积都不进 walls2d', () => {
  const l = { ...base(), columns: [col(1, 2, 2, 0.2, 0.3)] };
  const wallsBefore = JSON.stringify(scene2d(l).walls);
  const s = scene2d(l, { selectedColumn: 1 });
  assert.equal(s.walls.length, 4, '柱不能增加墙');
  assert.equal(JSON.stringify(s.walls), wallsBefore, '柱不能改 walls2d');
  const c = s.columns[0];
  assert.deepEqual([c.id, c.x, c.z, c.w, c.d], [1, 2, 2, 0.2, 0.3]);
  assert.deepEqual([c.x0, c.z0, c.x1, c.z1], [1.9, 1.85, 2.1, 2.15]);
  assert.equal(c.selected, true);
  assert.ok(Math.abs(c.area - 0.06) < 1e-9);
  assert.ok(c.dPath.startsWith('M1.9 1.85'), c.dPath);
  assert.equal(c.invalid, null);
  assert.equal(JSON.stringify(l.columns), JSON.stringify([col(1, 2, 2, 0.2, 0.3)]), '派生不得改 state');
});

test('checkColumn：0.2/3.0 边界、出场景、叠柱、设备、门窗洞口原因', () => {
  const l = { ...base(), items: [{ id: 7, p: 'x', x: 2, z: 2, r: 0 }] };
  assert.equal(checkColumn(l, col(1, 2, 2, 0.1994, 0.5)).reason, 'column-too-small');
  assert.equal(checkColumn(l, col(1, 2, 2, 0.1995, 0.5)).ok, true, '0.1995 量化到 0.200 应合法');
  assert.equal(checkColumn(l, col(1, 2, 2, 3.0004, 0.5)).ok, true, '3.0004 量化到 3.000 应合法');
  assert.equal(checkColumn(l, col(1, 2, 2, 3.0006, 0.5)).reason, 'column-too-large');
  assert.equal(checkColumn(l, col(1, 7.9, 2, 0.5, 0.5)).reason, 'column-out-of-scene');
  const two = { ...base(), columns: [col(1, 2, 2), col(2, 2.2, 2)] };
  assert.equal(checkColumn(two, col(3, 2.3, 2)).reason, 'column-overlap');
  const withDoor = {
    ...base(),
    walls: [mkWallSeg(0, 3, 8, 3)],
    columns: [],
  };
  withDoor.walls[0].openings = [{ at: 4, w: 1, h: 2.1 }];
  const blocked = checkColumn(withDoor, col(1, 4, 3, 0.5, 0.5));
  assert.equal(blocked.reason, 'column-blocks-opening');
  const imported = { ...withDoor, columns: [col(1, 4, 3, 0.5, 0.5)] };
  assert.equal(columns2d(imported)[0].invalid.openingKind, 'door');
});

test('designer：add/select/remove = 一步撤销，nextColumnId = max+1，选择互斥', () => {
  d.layout.value = base();
  d.nextId.value = 4;
  d.selectedId.value = null;
  d.selectedWall.value = null;
  d.selectedColumn.value = null;

  const a = d.addColumn({ x: 2, z: 2, w: 0.5, d: 0.5 });
  assert.equal(a.id, 1);
  assert.equal(d.columnCount.value, 1);
  assert.equal(d.selectedColumn.value, 1);
  assert.equal(d.nextColumnId(), 2);
  assert.equal(d.canUndo.value, true);

  const b = d.addColumn({ x: 4, z: 2, w: 0.2, d: 0.2 });
  assert.equal(b.id, 2);
  d.selectColumn(1);
  assert.equal(d.selectedColumn.value, 1);
  d.selectWall(0);
  assert.equal(d.selectedColumn.value, null, '选墙必须清柱选中');
  d.selectColumn(2);
  assert.equal(d.selectedWall.value, null, '选柱必须清墙选中');

  d.removeColumn(2);
  assert.equal(d.columnCount.value, 1);
  assert.equal(d.selectedColumn.value, null);
  d.undo();
  assert.equal(d.columnCount.value, 2, '删柱 = 一步撤销');
  d.undo();
  assert.equal(d.columnCount.value, 1, '再加一根可继续撤销');
  d.undo();
  assert.equal(d.columnCount.value, 0);
});

test('PlanView：第 7 颗按钮、点放默认 0.5、渲染 data-column-*；不加墙', () => {
  const plan = read('app/src/components/PlanView.vue');
  const toolsAt = plan.indexOf('class="plan-tools"');
  const canvasAt = plan.indexOf('class="plan"');
  const tools = plan.slice(toolsAt, canvasAt);
  assert.match(tools, /data-tool="column"/);
  assert.equal((tools.match(/data-tool="/g) || []).length, 7);
  assert.match(plan, /d\.addColumn\(\{ x: s0\.x0, z: s0\.z0, w: 0\.5, d: 0\.5 \}\)/);
  assert.match(plan, /class="columns"/);
  assert.match(plan, /data-column-id/);
  assert.match(plan, /data-column-invalid-reason/);
  assert.match(plan, /data-column-handle="h\.name"/);
  assert.match(plan, /data-column-preview/);
  assert.match(plan, /data-column-card/);
  assert.match(plan, /data-column-count/);
  assert.match(plan, /data-column-area/);
  assert.match(plan, /data-column-usable/);
  assert.match(plan, /data-column-mode/);
  assert.match(plan, /d\.checkColumnDraft/);
  assert.match(plan, /Shift 只关吸附/);
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    assert.match(plan, new RegExp(`column-handle[^>]*|${h}`), '8 向手柄的 handle 名要齐全');
  }
});


test('designer：0.2 拒绝不落 state；拖拽 silent 更新 = 一步撤销；复制 +0.2；可用面积', () => {
  d.layout.value = base();
  d.nextId.value = 1;
  d.selectedColumn.value = null;
  const bad = d.addColumn({ x: 2, z: 2, w: 0.19, d: 0.5 });
  assert.equal(bad, null, '0.19 必须拒绝，不夹到 0.20');
  assert.equal(d.columnCount.value, 0);

  const a = d.addColumn({ x: 2, z: 2, w: 0.5, d: 0.5 });
  const oldX = a.x;
  d.beginEdit();
  assert.equal(d.updateColumn(a.id, { x: 3.3 }, { silent: true }), true);
  assert.equal(d.selectedColumnInfo.value.cx, 3.3);
  d.undo();
  assert.equal(d.columns.value[0].x, oldX, '一次拖拽只回退到拖动前，不是回到删除前');

  const cp = d.copyColumn(a.id);
  assert.ok(cp);
  assert.ok(Math.abs((cp.x - cp.w / 2) - (a.x + a.w / 2)) >= 0.199, '复制右侧净距至少 0.20 m');
  assert.equal(d.columns.value.length, 2);
  d.removeColumn(cp.id);
  d.removeColumn(a.id);

  // 可用面积：四角都在房间面内才扣；柱占独立统计，不改房间面积
  const room = { poly: [[0, 0], [4, 0], [4, 4], [0, 4]], area: 16 };
  assert.equal(usableAreaOf(room, [{ id: 1, x: 2, z: 2, w: 1, d: 1 }]), 15);
  const boundary = { id: 2, x: 0.05, z: 2, w: 0.2, d: 0.2 };
  assert.equal(usableAreaOf(room, [boundary]), 16, '边界柱四角不全在面内，不扣可用面积');
});
