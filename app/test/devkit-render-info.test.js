// 判据：devkit 的性能面必须**真的来自三维视图**，而且「没在画」是 null、不是 0。
//
// 为什么值得单独钉：
//   · 「绘制调用 / 三角形」这几个数只有三维视图自己知道；devkit 只是转发。
//     一旦转发链断了（没导出 / 导错对象），stats() 会照样返回、只是**这些数永远缺**，
//     而缺了不会报错 —— 典型「不会发声」的坏法。
//   · `null` 与 `0` 必须分开：0 会被读成「在画，但什么都没画」，null 才是「没在画」。
//     这正是本项目反复栽的那一条（缺数据不补、读不到≠读到 0）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, '..', p), 'utf8');

test('scene3d 必须导出 probeRender（不然 devkit 根本拿不到渲染面）', () => {
  const s = read('src/scene3d.js');
  assert.match(s, /function probeRender\(\)/, 'probeRender 要在 scene3d 里有定义');
  assert.match(s, /^\s*probe, probeRender, selfTest,$/m,
    'probeRender 必须挂在 createView3D 的返回对象上（只定义不导出 = 外面看不见）');
});

test('devkit 的 stats() 报 renderInfo：没挂三维时是 null，绝不是 0', () => {
  const s = read('src/devkit.js');
  assert.match(s, /import \{ view3d \} from '\.\/scene3d\.js'/,
    'devkit 要真的 import 三维视图');
  assert.match(s, /renderInfo: view3d\.attached \? view3d\.probeRender\(\) : null,/,
    'renderInfo 必须写成「挂了才问、没挂是 null」；写成 0 会被读成「在画但什么都没画」');
});