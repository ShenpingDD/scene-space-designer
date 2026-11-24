import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shortcutAllowed, setWalking, walking } from '../src/walkMode.js';

/**
 * walk.test.js —— 漫游中「快捷键要让路」这条规矩（FIX-15 那张老账）
 *
 * 老毛病（原型就有、2026-09-30 逐条重核时发现**新界面也复现了**）：
 * 漫游时工具栏只是不可点，但撤销/重做/导出的快捷键挂在 `window` 上，照样生效 ——
 * 于是**漫游者眼皮底下的场景被改掉了**，而他还在往前走。
 *
 * ⚠️ 这条只做了**纯函数级**断言：真机里进第一人称要 pointer lock，headless 里做不稳，
 * 所以"漫游时按 Ctrl+Z 真的没反应吗"没有页面级断言（如实记在 docs/45 §五 的已知边界里）。
 */
test('不在漫游里：快捷键照常接', () => {
  assert.equal(shortcutAllowed(false, { key: 'z', ctrlKey: true }), true);
});

test('⭐ 漫游里：一个全局快捷键都不接（撤销/重做/导出都会改掉他正在看的场景）', () => {
  assert.equal(shortcutAllowed(true, { key: 'z', ctrlKey: true }), false);
  assert.equal(shortcutAllowed(true, { key: 'z', ctrlKey: true, shiftKey: true }), false);
  assert.equal(shortcutAllowed(true, { key: 'y', ctrlKey: true }), false);
  assert.equal(shortcutAllowed(true, { key: 's', ctrlKey: true }), false);
});

test('共享状态：默认不在漫游里，且 setWalking 只认真布尔', () => {
  assert.equal(walking.value, false);
  setWalking(true);
  assert.equal(walking.value, true);
  setWalking(0);
  assert.equal(walking.value, false, '不是真值就当没在漫游（0 / undefined / null）');
  setWalking('walk');
  assert.equal(walking.value, true);
  setWalking(false);
  assert.equal(walking.value, false);
});