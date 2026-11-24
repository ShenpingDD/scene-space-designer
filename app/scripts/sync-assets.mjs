/**
 * sync-assets.mjs —— 把仓库根目录的 `assets/` 同步到 `app/public/assets/`
 *
 * 为什么要有这一步（而不是直接让 vite 去读 ../assets）：
 *   ① 只发布**运行时真的需要**的东西：压缩产物（1.21 MB）+ 三份 JSON。
 *      原始 45 MB 模型**不进网站目录** —— 打开一个网页不该顺带下载 45 MB。
 *   ② `public/assets/...` 映射成 URL `/assets/...`，与 LOD 清单里的 `file` 字段
 *      （`assets/optimized/xxx.lod0.glb`）**逐字对上**，两边不需要任何路径改写。
 *   ③ 挂在 npm 生命周期 `predev` / `prebuild` 上，不会忘记执行、也不会过期。
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.dirname(appDir);
const from = path.join(root, 'assets');
const to = path.join(appDir, 'public', 'assets');

const FILES = [
  'optimized/lod.manifest.json',
  'catalog/products.json',
  'catalog/models.verified.json',
];

const mb = (b) => (b / 1048576).toFixed(2);

async function sizeOf(dir) {
  let total = 0;
  let count = 0;
  for (const name of await readdir(dir)) {
    const s = await stat(path.join(dir, name));
    if (s.isFile()) { total += s.size; count += 1; }
  }
  return { total, count };
}

async function main() {
  await mkdir(path.join(to, 'optimized'), { recursive: true });
  await mkdir(path.join(to, 'catalog'), { recursive: true });

  // 1) 压缩产物（GLB + LOD 清单）整目录拷 —— 里面只有站点需要的文件
  await cp(path.join(from, 'optimized'), path.join(to, 'optimized'), { recursive: true });

  // 2) 目录与验收报告
  for (const rel of FILES.filter((f) => !f.startsWith('optimized/'))) {
    await cp(path.join(from, rel), path.join(to, rel));
  }

  const glb = (await readdir(path.join(to, 'optimized'))).filter((f) => f.endsWith('.glb'));
  const { total } = await sizeOf(path.join(to, 'optimized'));
  console.log(`[assets] 已同步 ${glb.length} 个 GLB + 3 份 JSON → app/public/assets（${mb(total)} MB）`);
  if (!glb.length) {
    console.warn('[assets] 警告：一个 GLB 都没有。先确认 assets/optimized/ 下有产物，或跑 `cd tools/models && npm run optimize`');
  }
}

main().catch((err) => {
  console.error('[assets] 同步失败：', err.message);
  console.error('        （先确认 assets/optimized 里有产物；原始模型由建模脚本导出，不入库）');
  process.exitCode = 1;
});