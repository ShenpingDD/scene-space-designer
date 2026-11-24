/**
 * open-scene-ui.test.js —— P2 前端开放场景的**可执行判据**
 *
 * 分两层：
 *   ① 纯函数：scene2d 的 role / T 端头 / 开放面积读数（几何来自内核，界面只读）；
 *   ② 源码挂点：PlanView 的预览=落笔、窗口级 pointerup、房间层条件、全墙命中，
 *      以及右栏三张卡的开放面积/分组/角色/归属入口。
 *
 * ② 不伪造 DOM：Vue 组件没有测试渲染器，这一层只钉住"接线存在且没被改回旧分支"；
 * 真机行为由 QA 的 P4 探针负责。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { scene2d, walls2d } from '../src/scene2d.js';
import { createLayout } from '@core/room.js';
import { mkWallSeg } from '@core/wall.js';
import { openAreaTotal } from '@core/rooms.js';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

/* ---------------- ① scene2d：角色 / 端头 / 开放面积 ---------------- */

test('scene2d：四面外墙都有 exterior 角色与 T 端头，内墙没有端头', () => {
  const base = createLayout({ w: 5, d: 4, h: 2.6 });
  const outer = walls2d(base);
  assert.equal(outer.length, 4);
  for (const w of outer) {
    assert.equal(w.role, 'exterior');
    assert.ok(w.caps.includes('M'), '外墙两端要画 T 端头');
  }
  const inner = mkWallSeg(2, 1, 2, 3);
  const withInner = { ...base, walls: [...base.walls, inner] };
  const last = walls2d(withInner).at(-1);
  assert.equal(last.role, 'interior');
  assert.equal(last.caps, '');
});

test('scene2d：显式 role 优先于几何回退（改判后 2D 跟着 role 走）', () => {
  const base = createLayout({ w: 5, d: 4, h: 2.6 });
  const walls = base.walls.map((w, i) => (i === 0 ? { ...w, role: 'interior' } : w));
  const s = walls2d({ ...base, walls });
  assert.equal(s[0].role, 'interior', '显式 interior 不许被几何回退成外墙');
});

test('scene2d：开放面积来自内核，缺一面墙的新方案是 0 间房 + 正开放面积', () => {
  const base = createLayout({ w: 5, d: 4, h: 2.6 });
  const open = { ...base, walls: base.walls.slice(0, -1) };
  const area = openAreaTotal(open);
  assert.ok(area > 0, '缺一面外墙就应产生开放面积');
  assert.equal(scene2d(open).openArea, area);
});

/* ---------------- ② 源码挂点：接线不能改回旧分支 ---------------- */

test('PlanView：预览与落笔共用 planWall，窗口级 pointerup 兜底存在', () => {
  const plan = read('app/src/components/PlanView.vue');
  assert.match(plan, /d\.planWall\(/, '预览必须走 designer 的 planWall（内核 planDrawWall 的 UI 出口）');
  assert.match(plan, /d\.addWallPlan\(/, '落笔必须提交预览同一份结果');
  assert.match(plan, /window\.addEventListener\('pointerup', onWindowPointerUp\)/, '画布外松手要有窗口级兜底');
  assert.match(plan, /data-preview-invalid/, '非法预览要保留并带原因');
  assert.match(plan, /preview-ghost/, '扩场景要有 ghost 矩形');
});

test('PlanView：房间层条件与全墙命中、外墙斜纹/端头都还在', () => {
  const plan = read('app/src/components/PlanView.vue');
  assert.match(plan, /v-if="d\.showRoomLayer\.value"/, '房间层必须按 房间数>1 或 开放面积>0 渲染');
  assert.match(plan, /wall-ext-hatch/, '外墙要有 45° 斜纹层');
  assert.match(plan, /wall-ext-cap/, '外墙要有 T 端头');
  assert.match(plan, /data-wall-role/, '墙要暴露 role 供探针/样式读取');
  assert.match(plan, /data-scene-chip="open-area"/, '画布开放徽标只在该出现时出现');
  assert.match(plan, /data-site-ghost/, '扩场景 ghost 要有探针钩子');
  assert.match(plan, /data-preview-role/, '预览角色徽标要有探针钩子');
  assert.doesNotMatch(plan, /v-if="!w\.boundary"/, '命中带不许再只给内墙');
  assert.doesNotMatch(plan, /d\.addWall\(s, end/, '落笔不许再走旧 addWall 入口');
});

test('RoomList / 墙体卡 / Inspector：开放面积、分组、角色、归属入口齐全', () => {
  const rooms = read('app/src/components/RoomList.vue');
  assert.match(rooms, /data-open-area/, '房间卡要有开放面积只读行');
  assert.match(rooms, /data-open-room-empty/, '0 间房空态要说明开放场景');
  assert.match(rooms, /不可命名/, '开放面积必须说明不可命名');

  const walls = read('app/src/components/InteriorWallCard.vue');
  assert.match(walls, /title="墙体"/, '卡名要从「内墙」改成「墙体」');
  assert.match(walls, /data-wall-group="exterior"/, '外墙要单独分组');
  assert.match(walls, /data-wall-group="interior"/, '内墙要单独分组');
  assert.match(walls, /data-wall-row/, '所有墙都要能选中');

  const insp = read('app/src/components/Inspector.vue');
  assert.match(insp, /data-item-scope/, '设备要显示「所属」');
  assert.match(insp, /data-wall-role-switch/, '选中墙要能切换角色');
  assert.match(insp, /data-open-area/, '空间体检脚注要有开放面积');
  assert.match(insp, /d\.roomArea\.value/, '房间面积 KPI 只算房间，不拿 w*d 冒充');
  assert.match(insp, /d\.setWallRole\(/, '角色切换要接内核动作');
});

test('designer：planDrawWall/addWallPlan/planSceneSize/schemeMeta 接线存在', () => {
  const src = read('app/src/designer.js');
  assert.match(src, /function planWall\(/, '预览入口');
  assert.match(src, /function addWallPlan\(/, '落笔入口（一次 beginEdit）');
  assert.match(src, /placement\.planDrawWall/, '必须调 P1 的 planDrawWall');
  assert.match(src, /room\.planSceneSize/, '新语义改尺寸必须走 planSceneSize');
  assert.match(src, /schemeFormat/, '服务端/导入返回的 format 要保留');
  assert.match(src, /openAreaTotal/, '开放面积读内核');
});
