import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QR_EC, QR_QUIET, qrMatrix, qrPath, qrSvg } from '../src/qr.js';

/**
 * qr.test.js —— 二维码的**形状**判据（能不能真扫出来由 `tools/verify/verify-qr.py` 管）
 *
 * 这一层只钉"矩阵被忠实地画成了 SVG"：path 里的每一个方块必须与矩阵**一一对应**
 * —— 少了是缺角，多了是污点，两种都会让码扫不出来，而**从屏幕上根本看不出来**。
 *
 * ⚠️ 判据不拿生成库自证：这里检查的是**输出**（矩阵与 path 的一致性 + 定位图案的标准形状），
 * 而"这条链接真的能被扫出来"由一份**独立写的矩阵级解码器**（Python）验证（见 docs/52 的 C25）。
 */
// U1 起分享链接是真实路径（`/view/<口令>`）：夹具跟着换成真在用的那种地址
const URL_TEXT = 'http://10.0.0.10:5180/view/abcd2345';

test('矩阵：定位图案是标准形状（三个角）+ 分隔带是空的', () => {
  const m = qrMatrix(URL_TEXT);
  assert.ok(m.size >= 21, '最小版本是 21×21，实际 ' + m.size);
  assert.equal(m.ec, QR_EC);
  assert.equal(QR_EC, 'Q', '容错级别用 Q（25%）：现场是屏幕对屏幕扫，反光/脏屏很常见');

  const dark = (r, c) => m.rows[r][c] === 1;
  // 左上定位图案：外框 7×7 全黑边、里面 3×3 实心、中间一圈白
  for (let i = 0; i < 7; i++) {
    assert.ok(dark(0, i) && dark(i, 0), '左上的外框边要黑');
    assert.ok(dark(6, i) && dark(i, 6), '左上的外框边要黑（下/右边）');
  }
  assert.ok(!dark(1, 1), '定位图案里第一圈是白的');
  assert.ok(dark(3, 3), '定位图案中心是黑的');
  assert.ok(!dark(0, 7) && !dark(7, 0), '定位图案外要有一圈分隔带（白）');
  // 定位图案在**左上 / 右上 / 左下**三个角（右下是数据区）—— 写这条时把右下当成了第三个，
  // 是这条断言自己错了（跑起来就红），不是矩阵错了。
  const n = m.size;
  assert.ok(dark(0, n - 1) && dark(0, n - 7), '右上定位图案的上边要黑');
  assert.ok(dark(n - 7, 0) && dark(n - 1, 0), '左下定位图案的左边要黑');
  assert.ok(!dark(0, n - 8), '右上定位图案左边要有分隔带');
  assert.ok(!dark(n - 8, 0), '左下定位图案上边要有分隔带');
});

test('矩阵：只含 0/1，且不是一片同色', () => {
  const m = qrMatrix(URL_TEXT);
  let ones = 0;
  for (const row of m.rows) {
    assert.equal(row.length, m.size, '每行长度等于边长');
    for (const v of row) {
      assert.ok(v === 0 || v === 1, '只能是 0/1，实际 ' + v);
      ones += v;
    }
  }
  const ratio = ones / (m.size * m.size);
  assert.ok(ratio > 0.25 && ratio < 0.75, '黑白比例应当在 25%~75%，实际 ' + ratio.toFixed(3));
});

test('⭐ path 与矩阵**一一对应**（多一个方块 / 少一个方块都会让码扫不出来）', () => {
  const m = qrMatrix(URL_TEXT);
  const { d, extent } = qrPath(m);
  assert.equal(extent, m.size + QR_QUIET * 2, '含静区（两边各 4 模块）');

  // 把 path 解析回矩阵：`M x y h w v1 h -w z` 一根横条 = 一行上连续的一串黑块
  const painted = Array.from({ length: m.size }, () => new Array(m.size).fill(0));
  const re = /M(\d+) (\d+)h(\d+)v1h-\d+z/g;
  let n = 0;
  let hit;
  while ((hit = re.exec(d)) !== null) {
    n += 1;
    const x = Number(hit[1]) - QR_QUIET;
    const y = Number(hit[2]) - QR_QUIET;
    const w = Number(hit[3]);
    assert.ok(y >= 0 && y < m.size, '行号落在矩阵里：' + y);
    assert.ok(x >= 0 && x + w <= m.size, '横条不越界：x=' + x + ' w=' + w);
    for (let i = 0; i < w; i++) painted[y][x + i] += 1;
  }
  assert.ok(n > 0, 'path 里一根横条都没有？');
  assert.equal(d.replace(re, '').trim(), '', 'path 里除了这些横条不该有别的东西：' + d.slice(0, 120));

  for (let r = 0; r < m.size; r++) {
    for (let c = 0; c < m.size; c++) {
      assert.equal(painted[r][c], m.rows[r][c],
        `(${r},${c}) 对不上：矩阵说 ${m.rows[r][c]}，画出来 ${painted[r][c]}`);
    }
  }
});

test('qrSvg：给的就是画 SVG 要的那几样（viewBox 用 extent）', () => {
  const q = qrSvg(URL_TEXT, { px: 6 });
  assert.equal(q.extent, q.matrix.size + QR_QUIET * 2);
  assert.equal(q.sizePx, q.extent * 6);
  assert.ok(q.path.startsWith('M'), 'path 以 M 开头');
  assert.ok(q.sizePx >= 200, '面板里给手机扫，建议边长至少 200px，实际 ' + q.sizePx);
  assert.ok(q.path.length > 0);
});

test('同一文本 → 同一个矩阵（判据要能复现）', () => {
  assert.deepEqual(qrMatrix(URL_TEXT).rows, qrMatrix(URL_TEXT).rows);
  assert.notDeepEqual(qrMatrix(URL_TEXT).rows, qrMatrix(URL_TEXT + 'x').rows,
    '内容变了矩阵必须变（不然判据是瞎的）');
});