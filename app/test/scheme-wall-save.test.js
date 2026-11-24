import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('updateWall 拒绝短于最小长度的墙', () => {
  const s = read('src/designer.js');
  const fn = s.slice(s.indexOf('function updateWall('), s.indexOf('function removeWall('));
  assert.match(fn, /minWallLengthM/);
  assert.match(fn, /Math\.hypot\(xx - x, zz - z\)/);
  assert.match(fn, /MSG\.wallTooShort/);
});

test('保存前把短墙指出来并选中，不再只等服务端 400', () => {
  const s = read('src/components/SchemePanel.vue');
  const fn = s.slice(s.indexOf('async function save('), s.indexOf('async function takeServer('));
  assert.match(fn, /shortWalls/);
  assert.match(fn, /第 \$\{first\.i \+ 1\} 面墙/);
  assert.match(fn, /d\.selectWall\(first\.i\)/);
  assert.match(fn, /reason: 'short-wall'/);
});
