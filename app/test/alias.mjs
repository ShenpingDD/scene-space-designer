/**
 * alias.mjs —— 让 `node --test` 认得 `@core/*`（前端与内核共用源码的那条别名）
 *
 * 为什么需要它：`app/vite.config.js` 里 `@core` → `spatial-core/src` 是**构建期**别名，
 * 浏览器里走 Vite、跑测试走 node —— node 不认这个词。于是"能测的模块"被悄悄截了一道：
 * 只要某个模块 import 了 `@core/...`，它就没法被测试碰到（`scene2d.js` 就是这么被漏了很久的）。
 *
 * 这里补上同一个映射，**只有一处**（跟 Vite 那份对齐；改一处要改两处，注释里互相指着）。
 */
import { registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));   // app/
const coreDir = path.join(appDir, '..', 'spatial-core', 'src');
const prefix = '@core/';

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(prefix)) {
      const target = path.join(coreDir, specifier.slice(prefix.length));
      return { url: pathToFileURL(target).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});