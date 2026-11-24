/**
 * handle.test.js —— 旋转手柄的方位（用户反馈："手柄默认在 180° 的位置，一点就从 0 开始"）。
 *
 * 这条 bug 的本质是**两处约定不一致**：手柄画在 `(−sin r, +cos r)`（= 内核角度的反面），
 * 而 `angleFromPointer` 对同一个点算出来的是 `r + 180`。所以判据只有一条：
 *   **手柄必须画在 `angleFromPointer` 会算出 `r` 的那个位置上**（两者互逆）。
 * 互逆被钉住，"按一下模型就翻 180°"这类错就不可能再出现。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { angleFromPointer, handlePoint, handleDistOf, snapAngle, HANDLE_GAP_M } from '../src/placement.js';

const D = 0.8; // 进深 0.8 m
const dist = handleDistOf({ d: D });

test('手柄距离 = 半个进深 + 空隙', () => {
  assert.equal(handleDistOf({ d: D }), D / 2 + HANDLE_GAP_M);
  assert.equal(handleDistOf(null), HANDLE_GAP_M, '没有产品时至少有空隙那段（不炸、不 NaN）');
});

test('⭐ 互逆：手柄位置算出来的角度，就是设备自己的角度（0/90/180/270）', () => {
  for (const r of [0, 30, 90, 180, 270, 355]) {
    const p = handlePoint(1.5, 2.5, r, dist);
    assert.equal(angleFromPointer(1.5, 2.5, p.x, p.z), snapAngle(r), `r=${r} 时手柄方位与角度不一致`);
  }
});

test('⭐ 设备在 180° 时，手柄就在 180° 的方位（不是在 0°）', () => {
  const p180 = handlePoint(0, 0, 180, 1);
  // 180° 参考方向是 +z（屏幕下方）
  assert.deepEqual([nz(p180.x), nz(p180.z)], [0, 1]);
  assert.equal(angleFromPointer(0, 0, p180.x, p180.z), 180);

  const p0 = handlePoint(0, 0, 0, 1);
  // 0° 参考方向是 −z（屏幕上方）—— 旧实现把它画到了 +z 上，才出现"默认在 180° 的位置"
  assert.deepEqual([nz(p0.x), nz(p0.z)], [0, -1]);
  assert.equal(angleFromPointer(0, 0, p0.x, p0.z), 0);
});

// `-0` 与 `0` 在 deepEqual 里不相等（JS 的坑）—— 归一，免得断言红在噪音上
const nz = (v) => (Math.round(v * 1e6) / 1e6) + 0;

test('四个正朝向的坐标（对表，防「符号写反但看不出来」）', () => {
  const at = (r) => {
    const p = handlePoint(0, 0, r, 1);
    return [nz(p.x), nz(p.z)];
  };
  assert.deepEqual(at(0), [0, -1], '0° 在屏幕上方');
  assert.deepEqual(at(90), [1, 0], '90° 在屏幕右方');
  assert.deepEqual(at(180), [0, 1], '180° 在屏幕下方');
  assert.deepEqual(at(270), [-1, 0], '270° 在屏幕左方');
});

test('抓取偏移：从手柄上按下时，偏移量应当是 0（否则一按就跳）', () => {
  for (const r of [0, 45, 180, 300]) {
    const p = handlePoint(0.9, 1.1, r, dist);
    const off = r - angleFromPointer(0.9, 1.1, p.x, p.z);
    assert.equal(Math.round(off), 0, `r=${r}：在手柄上按下应当"零偏移"，实际差 ${off}°`);
  }
});

test('非数不炸（界面可能拿不到产品）', () => {
  assert.equal(handlePoint(undefined, 1, 0, 1), null);
  const p = handlePoint(0, 0, undefined, undefined);
  assert.deepEqual([p.x, p.z], [0, 0]);
});