/**
 * hotspot-pivot-anchor.test.js —— 热点锚点穿过运行时 pivot 包装层
 *
 * `bindDoors` 会在门/盖外再包一层 `${name}:pivot`。这是编辑器/查看器为了
 * 绕真实铰链旋转而加的**合成节点**，不属于模型作者路径；热点 `nodePath`
 * 仍写 `#0/Scene/door`。解析时必须忽略 `:pivot` 合成段，否则所有
 * “门/盖上的热点”都会被误报 anchor-missing。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';

import { resolveNode } from '../src/hotspot.js';

function sceneWithPivot() {
  const outer = new THREE.Group();
  outer.name = '#0';
  const scene = new THREE.Group();
  scene.name = 'Scene';
  outer.add(scene);
  const pivot = new THREE.Group();
  pivot.name = 'door:pivot';
  const door = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 0.1), new THREE.MeshBasicMaterial());
  door.name = 'door';
  pivot.add(door);
  scene.add(pivot);
  const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
  body.name = 'body';
  scene.add(body);
  return { outer, scene, door, body };
}

test('热点锚点 #0/Scene/door 能穿过 door:pivot 包装层找到门节点', () => {
  const { outer, door } = sceneWithPivot();
  const hit = resolveNode(outer, ['#0', 'Scene', 'door'], 0);
  assert.equal(hit, door);
  assert.equal(hit.parent.name, 'door:pivot');
});

test('普通锚点仍逐段精确解析，不会因为清理 pivot 而按名字乱配', () => {
  const { outer, body } = sceneWithPivot();
  assert.equal(resolveNode(outer, ['#0', 'Scene', 'body'], 0), body);
  assert.equal(resolveNode(outer, ['#0', 'Scene', 'missing'], 0), null);
});
