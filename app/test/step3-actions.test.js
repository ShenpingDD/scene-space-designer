/**
 * step3-actions.test.js —— 步骤 3B：产品动作库 + 热点绑定 + 详情执行
 *
 * 钉住的是**能被证伪的数值/契约**：
 *   ① 动作形状、key 唯一、热点只能引用存在的动作（未知 key 保存前就拦）；
 *   ② rotate 的 pivotMm 是**模型根局部毫米**：352 的 door-open 绕 [287.71,70,363]
 *      转 +105°，门自由边到柜前 z≈924mm；若 /1000 或按节点局部，pivotOk 与 bbox 立刻红；
 *   ③ toggle 回 0 恢复关门 bbox，不残留角度；
 *   ④ 379 没有任何可动件/动作，界面不得出现执行按钮；
 *   ⑤ 详情点击先执行 actionKey，维护端保存 body 带 actions。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';

import {
  actionsPayload, applyAction, bindAction, normalizeAction, resolveActionTarget,
  validateAction, validateActionRefs, validateActions,
} from '../src/actions.js';
import { doorsFromScene } from '../src/detail3d.js';
import { applyDoor, bindDoors, fitClone, parseGlbBuffer } from '../src/gltf.js';

globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

function glb(path) {
  const b = readFileSync(new URL(path, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const M352 = '../../assets/optimized/demo-storage-cabinet.lod0.glb';
const M379 = '../../assets/optimized/demo-storage-cabinet.lod0.glb';

// 公开仓只随仓库发布 **1 个**演示模型（`demo-ct-scanner.lod0.glb`）。其余演示模型不在版本库里，
// 依赖它们的用例在文件缺失时**显式跳过**（SKIP ≠ PASS：报告里会写明跳过了几条、为什么）。
const needModel = (path) => (existsSync(new URL(path, import.meta.url))
  ? {}
  : { skip: `公开仓未发布该演示模型：${path}` });

const PIVOT = [287.71, 70, 363];
const DOOR_OPEN = {
  key: 'door-open',
  name: '开门',
  kind: 'rotate',
  target: { path: ['#0', 'Scene', 'DEMO-SC-100', 'door'], index: 0 },
  motion: { axis: 'y', angleDeg: 105, direction: '+', pivotMm: PIVOT, durationMs: 600, toggle: true },
};

async function model352() {
  const root = await parseGlbBuffer(glb(M352));
  fitClone(root, { declared: { w: 595, h: 1990, d: 800 }, envelopeMode: '1:1' });
  return root;
}

function bboxMm(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  return { min: box.min.clone().multiplyScalar(1000), max: box.max.clone().multiplyScalar(1000) };
}

test('动作契约：合法动作通过；未知 kind / 缺 pivot / 重复 key / 未知热点引用被拦', () => {
  assert.deepEqual(validateAction(DOOR_OPEN), []);

  const badKind = validateAction({ ...DOOR_OPEN, key: 'x', kind: 'explode' });
  assert.ok(badKind.some((x) => x.code === 'action-kind-invalid'));

  const noPivot = validateAction({ ...DOOR_OPEN, key: 'x', motion: { ...DOOR_OPEN.motion, pivotMm: undefined } });
  assert.ok(noPivot.some((x) => x.code === 'action-pivot'), 'rotate 必须有 pivotMm 三轴');

  const dup = validateActions([DOOR_OPEN, { ...DOOR_OPEN, name: '重复' }]);
  assert.ok(dup.some((x) => x.code === 'action-duplicate-key'));

  const refs = validateActionRefs([{ id: 437, actionKey: 'door-open' }], []);
  assert.ok(refs.some((x) => x.code === 'hotspot-action-unknown'), '热点引用不存在的动作必须拦下');

  assert.equal(normalizeAction({ key: 'a', name: 'A', kind: 'rotate' }).target.index, 0);
  assert.deepEqual(actionsPayload([DOOR_OPEN])[0], DOOR_OPEN);
});

test('352：动作目标按 #0/Scene 对齐，并穿透 bindDoors 的 door:pivot 包装层', needModel(M352), async () => {
  const root = await model352();
  const scene = new THREE.Scene();
  scene.add(root);   // 详情查看器就是这样挂的；路径会多出 scene 的 `#0`
  assert.ok(resolveActionTarget(root, DOOR_OPEN.target), '挂进 scene 后仍应能找到 door');
  bindDoors(root, { doors: doorsFromScene(root) });
  root.updateMatrixWorld(true);
  const node = resolveActionTarget(root, DOOR_OPEN.target);
  assert.ok(node, 'bindDoors 包了 door:pivot 后仍要能找到同一个 door');
  assert.equal(node.name, 'door');
  assert.ok(node.parent.name.includes(':pivot'), '确实命中了被 pivot 包住的门');
});

test('352：rotate 的 pivotMm 按模型根局部毫米解释，+105° 朝外；/1000 会失败', needModel(M352), async () => {
  const root = await model352();
  const bound = bindAction(root, DOOR_OPEN);
  assert.equal(bound.ok, true);
  assert.equal(bound.pivotOk, true, 'pivot 世界点应与 [287.71,70,363] 对齐（≤2mm）');
  for (const k of ['x', 'y', 'z']) {
    assert.ok(Math.abs(bound.pivotDeltaMm[k]) <= 2,
      `pivot ${k} 偏差 ${bound.pivotDeltaMm[k]}mm；若把 pivotMm /1000 会差约 1000 倍`);
  }

  root.updateMatrixWorld(true);
  const closed = bboxMm(bound.target);
  applyAction(bound, 1);
  root.updateMatrixWorld(true);
  const open = bboxMm(bound.target);
  assert.ok(Math.abs(closed.max.z - 400) < 2, `关门 bbox max.z=${closed.max.z} 应≈400mm`);
  assert.ok(open.max.z > 900, `开门自由边 z=${open.max.z}mm 应 >900（朝柜前）`);
  assert.ok(open.min.z > 300, `开门 min.z=${open.min.z}mm 不应穿到柜后`);

  // toggle 语义：applyAction(0) 回到 rest，不能残留 105°
  applyAction(bound, 0);
  root.updateMatrixWorld(true);
  const back = bboxMm(bound.target);
  assert.ok(Math.abs(back.max.z - closed.max.z) < 1e-6);
  assert.ok(Math.abs(back.min.x - closed.min.x) < 1e-6);
});

test('352：门控件打开后再点动作，复用同一个 door:pivot，不会叠成 210°', needModel(M352), async () => {
  const root = await model352();
  const doors = bindDoors(root, { doors: doorsFromScene(root) });
  assert.equal(doors.length, 1);
  applyDoor(doors[0], 1);           // 门控件先开 105°
  root.updateMatrixWorld(true);

  const bound = bindAction(root, DOOR_OPEN);   // 动作在门已开时绑定
  assert.equal(bound.ok, true);
  assert.equal(bound.reusedDoorPivot, true, '必须复用 bindDoors 的 pivot，不能另包一层');
  applyAction(bound, 1);
  root.updateMatrixWorld(true);
  const box = bboxMm(bound.target);
  assert.ok(box.max.z > 900 && box.max.z < 1000,
    `复用后仍是 105°（z≈924），实测 max.z=${box.max.z}；若叠成 210° 会转回柜体`);
  assert.ok(box.min.z > 300, `门不应穿到柜后，min.z=${box.min.z}`);
});

test('352：direction="-" 时门反向转，自由边穿到柜后（符号只乘一次）', needModel(M352), async () => {
  const root = await model352();
  const bound = bindAction(root, {
    ...DOOR_OPEN,
    key: 'door-open-neg',
    motion: { ...DOOR_OPEN.motion, direction: '-' },
  });
  applyAction(bound, 1);
  root.updateMatrixWorld(true);
  const box = bboxMm(bound.target);
  assert.ok(box.min.z < 0, `反向开门 min.z=${box.min.z}mm 应 <0（穿到柜后）`);
});

test('379：无门/无动作；动作目标只能解析到 1200E 根，界面不得伪造执行按钮', needModel(M379), async () => {
  const root = await parseGlbBuffer(glb(M379));
  fitClone(root, { declared: { w: 1340.07, h: 2073.38, d: 833.29 }, envelopeMode: '1:1' });
  assert.equal(doorsFromScene(root).length, 0, '379 没有任何可动件 extras');
  assert.equal(resolveActionTarget(root, { path: ['#0', '#4', '1200E', 'door'], index: 0 }), null);
  assert.equal(bindAction(root, { ...DOOR_OPEN, target: { path: ['#0', '#4', '1200E', 'door'], index: 0 } }).ok, false);

  const board = readFileSync(new URL('../src/admin/HotspotBoard.vue', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../src/components/ProductDetail.vue', import.meta.url), 'utf8');
  assert.ok(board.includes('data-action-library'));
  assert.ok(board.includes('data-hs-field="actionKey"'));
  assert.ok(board.includes('actions: actionsPayload(actions.value)'));
  assert.ok(detail.includes('runHotspotAction'));
  assert.ok(detail.includes('viewer?.runAction'));
  assert.ok(detail.includes('data-detail-nonmovable'));
});
