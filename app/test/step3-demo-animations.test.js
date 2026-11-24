/**
 * step3-demo-animations.test.js —— t23：472–481 演示模型的开合几何
 *
 * 这些 GLB 的门/盖节点 translation 接近 0，几何顶点已按世界坐标落位，
 * 所以不能拿节点原点当铰链。测试钉住的是**从 Box3 推出来的铰链线**和**开合后的包围盒**：
 *   · 475 双门、478/481 单门：绕门宽外侧边转，开门后门体在柜体前方；
 *   · 476/477/479 顶盖：绕后侧上沿转，开盖后盖体抬到柜体顶面之上；
 *   · 473 双滑门：沿 x 轴各向外滑 700mm，不是 0° 旋转；
 *   · 480 sash：进入门表并按 x 轴滑 420mm；
 *   · 472/474 无可动件，379 仍无门，464 不回归。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as THREE from 'three';

import { doorsFromScene, isHingedDoorPart } from '../src/detail3d.js';
import { applyDoor, bindDoors, parseGlbBuffer } from '../src/gltf.js';

globalThis.self = globalThis;
globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });

function glb(path) {
  const b = readFileSync(new URL(path, import.meta.url));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

const ASSET = (slug) => `../../assets/optimized/${slug}.lod0.glb`;

// 公开仓只随仓库发布 **1 个**演示模型（`demo-ct-scanner.lod0.glb`）。其余演示模型不在版本库里，
// 依赖它们的用例在文件缺失时**显式跳过**（SKIP ≠ PASS：报告里会写明跳过了几条、为什么）。
const needModel = (path) => (existsSync(new URL(path, import.meta.url))
  ? {}
  : { skip: `公开仓未发布该演示模型：${path}` });

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

async function model(slug) {
  const root = await parseGlbBuffer(glb(ASSET(slug)));
  root.updateMatrixWorld(true);
  const body = new THREE.Box3().setFromObject(root).clone();
  const derived = doorsFromScene(root).filter(isHingedDoorPart);
  const bound = bindDoors(root, { doors: derived });
  root.updateMatrixWorld(true);
  return { root, body, derived, bound };
}

function boxOf(node) {
  node.updateWorldMatrix(true, false);
  return new THREE.Box3().setFromObject(node);
}
function boxMm(box) {
  return { min: box.min.clone().multiplyScalar(1000), max: box.max.clone().multiplyScalar(1000) };
}

test('475 双门：pivot 落在左右门宽外侧边，开门后两扇都在柜体前方', needModel(ASSET('demo-sample-cabinet')), async () => {
  const { body, derived, bound } = await model('demo-sample-cabinet');
  assert.deepEqual(derived.map((d) => d.node), ['door_L', 'door_R']);
  assert.equal(bound.length, 2);
  const [L, R] = bound;
  assert.equal(L.motion, 'rotate');
  assert.equal(R.motion, 'rotate');
  assert.equal(L.pivotOk, true);
  assert.equal(R.pivotOk, true);
  assert.equal(L.openDirection, '+');
  assert.equal(R.openDirection, '-');
  assert.ok(L.pivotMm[0] < 0 && R.pivotMm[0] > 0, '左右门铰链分别在门宽外侧');

  for (const b of bound) {
    const closed = boxOf(b.nodeRef);
    applyDoor(b, 1);
    const open = boxOf(b.nodeRef);
    applyDoor(b, 0);
    const center = open.getCenter(new THREE.Vector3());
    assert.equal(body.containsPoint(center), false, `${b.node} 开门后不应留在柜体内`);
    assert.ok(open.min.z < body.min.z - 0.1, `${b.node} 开门后自由边应在柜体前脸之外，实测 z=${open.min.z}`);
    assert.ok(closed.max.z > open.max.z, `${b.node} 开门应朝 -z 摆出`);
  }
});

test('478/481 单门：extras 的 openDirection 与几何相反时按几何翻正，朝外开', needModel(ASSET('demo-medical-fridge')), async () => {
  for (const [slug, node, expectedDir] of [
    ['demo-medical-fridge', 'door', '+'],
    ['demo-medical-preservation-box', 'door', '-'],
  ]) {
    const { body, derived, bound } = await model(slug);
    assert.equal(derived.length, 1);
    assert.equal(bound.length, 1);
    const b = bound[0];
    assert.equal(b.node, node);
    assert.equal(b.pivotOk, true);
    assert.equal(b.openDirection, expectedDir, `${slug} 的摆动符号按铰链边+门面重算`);
    assert.equal(b.openDirectionRaw, expectedDir === '+' ? '-' : '+', '原始 extras 方向应保留可追溯');
    const closed = boxOf(b.nodeRef);
    applyDoor(b, 1);
    const open = boxOf(b.nodeRef);
    applyDoor(b, 0);
    assert.equal(body.containsPoint(open.getCenter(new THREE.Vector3())), false);
    assert.ok(open.min.z < body.min.z - 0.1, `${slug} 开门后自由边应在柜体前方，实测 z=${open.min.z}`);
    assert.ok(closed.max.z > open.max.z, `${slug} 应朝外摆`);
  }
});

test('476/477/479 顶盖：绕后侧上沿转，开盖后抬到柜体顶面之上', needModel(ASSET('demo-centrifuge')), async () => {
  for (const slug of ['demo-centrifuge', 'demo-ln2-tank', 'demo-medical-transport-box']) {
    const { body, derived, bound } = await model(slug);
    assert.equal(derived.length, 1, `${slug} 顶盖必须被识别`);
    const b = bound[0];
    assert.equal(b.motion, 'rotate');
    assert.equal(b.pivotOk, true);
    assert.equal(b.axis, 'x');
    const mm = boxMm(boxOf(b.nodeRef));
    assert.ok(near(b.pivotMm[1], mm.max.y, 3), `${slug} 铰链 y 取盖体上沿`);
    assert.ok(b.pivotMm[2] === mm.min.z || b.pivotMm[2] === mm.max.z, `${slug} 铰链 z 取后侧边`);
    const closed = boxOf(b.nodeRef);
    applyDoor(b, 1);
    const open = boxOf(b.nodeRef);
    applyDoor(b, 0);
    const center = open.getCenter(new THREE.Vector3());
    assert.equal(body.containsPoint(center), false, `${slug} 开盖后盖体不应仍在柜体内`);
    assert.ok(center.y > body.max.y, `${slug} 开盖后中心应高于柜顶，center.y=${center.y}`);
    assert.ok(open.max.y > closed.max.y + 0.1, `${slug} 开盖应向上抬`);
  }
});

test('473 双滑门：进入门表、door_L/R 反向沿 x 各滑 700mm，不是 0° 旋转', needModel(ASSET('demo-cnc-machining-center')), async () => {
  const { body, derived, bound } = await model('demo-cnc-machining-center');
  assert.deepEqual(derived.map((d) => d.node), ['door_L', 'door_R']);
  assert.deepEqual(bound.map((b) => b.motion), ['translate', 'translate']);
  assert.deepEqual(bound.map((b) => b.slideMm), [700, 700]);
  assert.ok(near(bound[0].slideLocal, -0.7, 1e-6) && near(bound[1].slideLocal, 0.7, 1e-6), 'door_L 向左、door_R 向右，各 700mm');
  for (const b of bound) {
    const closed = boxOf(b.nodeRef).getCenter(new THREE.Vector3());
    applyDoor(b, 1);
    const open = boxOf(b.nodeRef).getCenter(new THREE.Vector3());
    applyDoor(b, 0);
    assert.ok(near((open.x - closed.x) * 1000, b.slideLocal * 1000, 2), `${b.node} x 位移`);
    const ob = boxOf(b.nodeRef);
    assert.ok(ob.max.z <= body.max.z + 10 && ob.min.z >= body.min.z - 10, `${b.node} 滑门应留在柜体前平面附近`);
    assert.equal(b.obj.rotation.x, 0);
    assert.equal(b.obj.rotation.y, 0);
  }
});

test('480 sash：被识别为滑门，沿 y 轴上滑 +420mm；472/474 无可动件、379 仍无门', needModel(ASSET('demo-biosafety-cabinet')), async () => {
  const { derived, bound } = await model('demo-biosafety-cabinet');
  assert.deepEqual(derived.map((d) => d.node), ['sash']);
  assert.equal(bound.length, 1);
  assert.equal(bound[0].motion, 'translate');
  assert.equal(bound[0].slideMm, 420);
  assert.equal(bound[0].axis, 'y');
  assert.equal(bound[0].pivotOk, true);
  const closed = boxOf(bound[0].nodeRef).getCenter(new THREE.Vector3());
  applyDoor(bound[0], 1);
  const open = boxOf(bound[0].nodeRef).getCenter(new THREE.Vector3());
  assert.ok(near((open.y - closed.y) * 1000, 420, 2), `sash 应上滑 420mm，实测 ${((open.y - closed.y) * 1000).toFixed(1)}`);

  for (const slug of ['demo-robot-arm', 'demo-ct-scanner', 'demo-storage-cabinet']) {
    const m = await model(slug);
    assert.equal(m.derived.length, 0, `${slug} 不应有假门表`);
  }
});

test('464 不回归：真实铰链 pivot 仍对齐，开门朝 +z', needModel(ASSET('demo-blender-001')), async () => {
  const { bound } = await model('demo-blender-001');
  assert.equal(bound.length, 1);
  assert.equal(bound[0].pivotOk, true);
  for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(bound[0].pivotDeltaMm[axis]) <= 2);
  const closed = boxOf(bound[0].nodeRef);
  applyDoor(bound[0], 1);
  const open = boxOf(bound[0].nodeRef);
  assert.ok(open.max.z > 0.7, `464 开门应朝 +z，实测 max.z=${open.max.z}`);
  assert.ok(closed.max.z < open.max.z);
});

test('热点第二次点击也执行动作（F2）：activeId===m.id 分支必须调用 runHotspotAction', () => {
  const src = readFileSync(new URL('../src/components/ProductDetail.vue', import.meta.url), 'utf8');
  const start = src.indexOf('function pickMarker');
  const end = src.indexOf('function openFromIndex', start);
  const body = src.slice(start, end);
  assert.match(body, /activeId\.value === m\.id/);
  assert.match(body, /runHotspotAction\(m\)/);
  assert.ok(body.indexOf('runHotspotAction(m)') < body.indexOf('activeId.value = null'),
    '二次点击要先执行动作，再收起弹层');
});
