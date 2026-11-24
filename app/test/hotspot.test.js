import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  nodePathOf, preorder, resolveNode, anchorOf,
  uniformWorldScale, toStoredPosition, toWorldPosition, reanchorStoredPosition,
  toStoredNormal, toWorldNormal, doorStateVisible, normalizeCamera,
} from '../src/hotspot.js';

function makeScene() {
  const root = new THREE.Group();
  root.name = 'DEMO-TEST';
  const cabinet = new THREE.Group();
  cabinet.name = 'Cabinet';
  const door = new THREE.Group();
  door.name = 'door_upper';
  const ventA = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  ventA.name = 'Vent slot';
  const ventB = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
  ventB.name = 'Vent slot';
  root.add(cabinet);
  cabinet.add(door);
  door.add(ventA, ventB);
  return { root, cabinet, door, ventA, ventB };
}

test('nodePath includes root and duplicate names use preorder index', () => {
  const { root, ventA, ventB } = makeScene();
  assert.deepEqual(nodePathOf(ventA), ['DEMO-TEST', 'Cabinet', 'door_upper', 'Vent slot']);
  assert.deepEqual(nodePathOf(ventB), ['DEMO-TEST', 'Cabinet', 'door_upper', 'Vent slot']);
  const list = preorder(root);
  const a = list.find((x) => x.node === ventA);
  const b = list.find((x) => x.node === ventB);
  assert.equal(a.index, 0);
  assert.equal(b.index, 1);
  assert.equal(resolveNode(root, a.path, 0), ventA);
  assert.equal(resolveNode(root, b.path, 1), ventB);
  assert.equal(resolveNode(root, b.path, 0), ventA);
  assert.deepEqual(anchorOf(root, ventB), { path: b.path, index: 1 });
});

test('resolveNode returns null for missing path/index instead of falling back by name', () => {
  const { root, ventA } = makeScene();
  assert.equal(resolveNode(root, ['DEMO-TEST', 'Cabinet', 'nope'], 0), null);
  assert.equal(resolveNode(root, nodePathOf(ventA), 9), null);
  assert.equal(resolveNode(root, null, 0), null);
});

test('position round-trips through node-local meters with uniform root scale', () => {
  const { root, door, ventA } = makeScene();
  root.scale.setScalar(2);
  root.updateMatrixWorld(true);
  const world = new THREE.Vector3(1, 2, 3);
  const stored = toStoredPosition(ventA, world);
  assert.ok(stored);
  const back = toWorldPosition(ventA, stored);
  assert.ok(back);
  assert.ok(back.distanceTo(world) < 1e-9);
  assert.equal(uniformWorldScale(door), 2);
  // 存储值 = 节点局部 × 世界缩放；本例节点在原点，所以数值恰等于世界点
  assert.ok(Math.abs(stored.x - 1) < 1e-9);
  assert.ok(Math.abs(stored.y - 2) < 1e-9);
  assert.ok(Math.abs(stored.z - 3) < 1e-9);
});

test('change anchor keeps the world point, not the old local number (验收-3)', () => {
  const { root, cabinet, door, ventA } = makeScene();
  root.scale.setScalar(2);
  door.position.set(0, 1, 0);
  root.updateMatrixWorld(true);
  const world = new THREE.Vector3(1, 2, 3);
  const oldStored = toStoredPosition(ventA, world);
  assert.ok(oldStored);
  const next = reanchorStoredPosition(ventA, cabinet, oldStored);
  assert.ok(next);
  const back = toWorldPosition(cabinet, next);
  assert.ok(back);
  assert.ok(back.distanceTo(world) < 1e-9, '换锚点后世界点必须保持不变');
  // 直接拿新锚点解释旧局部值会错；回归测试要能抓住这种写法
  const wrong = toWorldPosition(cabinet, oldStored);
  assert.ok(wrong);
  assert.ok(wrong.distanceTo(world) > 1e-4, '旧局部值直接套新锚点应当偏离，测试不能假绿');
});

test('change anchor refuses when either side cannot convert', () => {
  const { root, cabinet, ventA } = makeScene();
  root.updateMatrixWorld(true);
  assert.equal(reanchorStoredPosition(ventA, null, { x: 0, y: 0, z: 0 }), null);
  assert.equal(reanchorStoredPosition(null, cabinet, { x: 0, y: 0, z: 0 }), null);
  const broken = new THREE.Group();
  broken.scale.set(1, 2, 1);
  broken.updateMatrixWorld(true);
  assert.equal(reanchorStoredPosition(ventA, broken, { x: 0, y: 0, z: 0 }), null);
});

test('non-uniform scale is rejected, not silently approximated', () => {
  const { root, ventA } = makeScene();
  root.scale.set(1, 2, 1);
  root.updateMatrixWorld(true);
  assert.equal(uniformWorldScale(ventA), null);
  assert.equal(toStoredPosition(ventA, new THREE.Vector3(1, 1, 1)), null);
  assert.equal(toWorldPosition(ventA, { x: 1, y: 1, z: 1 }), null);
});

test('normal round-trips as a direction and ignores translation', () => {
  const { root, ventA } = makeScene();
  root.position.set(10, 20, 30);
  root.updateMatrixWorld(true);
  const n = new THREE.Vector3(0, 0, 1);
  const stored = toStoredNormal(ventA, n);
  const back = toWorldNormal(ventA, stored);
  assert.ok(back);
  assert.ok(back.distanceTo(n) < 1e-9);
});

test('door state follows one shared amount in v1', () => {
  assert.equal(doorStateVisible('any', 0), true);
  assert.equal(doorStateVisible('open', 0), false);
  assert.equal(doorStateVisible('open', 1), true);
  assert.equal(doorStateVisible('closed', 0), true);
  assert.equal(doorStateVisible('closed', 1), false);
});

test('camera normalization clamps and fills defaults', () => {
  const c = normalizeCamera({ azimuthDeg: 999, elevationDeg: -99, distFactor: 9, target: [2, -1, 0.3], fov: 1 });
  assert.deepEqual(c, { azimuthDeg: 180, elevationDeg: -5, distFactor: 4, target: [1, 0, 0.3], fov: 20 });
  assert.deepEqual(normalizeCamera(null), {
    azimuthDeg: 30, elevationDeg: 12, distFactor: 1.8, target: [0.5, 0.5, 0.5], fov: 42,
  });
});
