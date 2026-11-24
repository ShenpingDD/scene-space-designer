/**
 * fmt.js —— 长度显示口径（最多 3 位、不补零）
 *
 * 为什么值得单测：这个文件是"界面会不会说谎"的地方。`1.500` 看着比 `1.5` 精确，其实是编的。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtLen, fmtPos } from '../src/fmt.js';

test('毫米以内原样显示', () => {
  assert.equal(fmtLen(1.056), '1.056');
  assert.equal(fmtLen(2.345), '2.345');
});

test('不补零（补零是小谎）', () => {
  assert.equal(fmtLen(1.5), '1.5');
  assert.equal(fmtLen(2), '2');
  assert.equal(fmtLen(0), '0');
});

test('超过毫米的浮点长尾按毫米收', () => {
  assert.equal(fmtLen(1.0564999), '1.056');
  assert.equal(fmtLen(1.0565001), '1.057');
});

test('非有限数给破折号而不是 NaN', () => {
  assert.equal(fmtLen(NaN), '—');
  assert.equal(fmtLen(undefined), '—');
});

test('位置两轴一起', () => {
  assert.equal(fmtPos(1.05, 2.5), '1.05 m / 2.5 m');
});
