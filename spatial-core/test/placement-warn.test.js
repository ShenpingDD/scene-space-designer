/**
 * moveItem 的"不哄人"行为：id 不在布局里要**出声**（不能静默无操作）。
 *
 * 来历：`setPosition(不存在的 id)` 过去是静默无操作 —— 界面看起来"拖了没反应"，
 * 而真正的原因往往在别处（拿到旧快照 / 时序错）。这类问题没有日志就只能靠猜。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem } from '../src/placement.js';

const layout = () => ({
  w: 8, d: 6, h: 2.8, walls: [],
  items: [{ id: 1, p: 'demo-cabinet-800', x: 1, z: 1, r: 0, doorAmount: 0 }],
});

test('moveItem: 不存在的 id 要吼一声，并且原样返回', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const l = layout();
    const out = moveItem(l, 999, 2, 2);
    assert.equal(out, l, '原样返回同一份布局（不改动）');
    assert.equal(warns.length, 1, '应当恰好有一条 warn');
    assert.ok(warns[0].includes('999'), 'warn 里要带上是哪个 id：' + warns[0]);
  } finally {
    console.warn = orig;
  }
});

test('moveItem: 存在的 id 照旧不吼，并且落位到毫米（不再是 0.1 m）', () => {
  const warns = [];
  const orig = console.warn;
  console.warn = (m) => warns.push(String(m));
  try {
    const out = moveItem(layout(), 1, 2.34, 3.66);
    assert.equal(warns.length, 0, '正常移动不该有 warn');
    const it = out.items[0];
    // 规则变更（用户拍板）：输入精度到毫米。拖动吸附仍是 0.1 m —— 走的是 round1 那条路。
    assert.equal(it.x, 2.34);
    assert.equal(it.z, 3.66);
  } finally {
    console.warn = orig;
  }
});
