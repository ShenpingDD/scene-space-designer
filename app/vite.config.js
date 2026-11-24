import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const src = fileURLToPath(new URL('./src', import.meta.url));
const core = fileURLToPath(new URL('../spatial-core/src', import.meta.url));
const runtimeAssets = fileURLToPath(new URL('../assets', import.meta.url));

export default defineConfig({
  plugins: [
    vue(),
    {
      // 运行期 LOD 写到仓库根 assets/optimized，不在 app/public 的构建期副本里。
      // 开发服务器先从这里回落，避免「新上传模型只有接口有、页面却拿到 SPA index.html」。
      // 只接管 /assets/；找不到就 next()，public 的旧副本与 Vite 自己的行为不变。
      name: 'serve-runtime-assets',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const raw = (req.url || '').split('?')[0];
          if (!raw.startsWith('/assets/')) return next();
          const rel = decodeURIComponent(raw.slice('/assets/'.length));
          const file = path.resolve(runtimeAssets, rel);
          if (file !== runtimeAssets && !file.startsWith(runtimeAssets + path.sep)) return next();
          fs.stat(file, (err, st) => {
            if (err || !st.isFile()) return next();
            const ext = path.extname(file).toLowerCase();
            const types = { '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
              '.bin': 'application/octet-stream', '.json': 'application/json',
              '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
            res.statusCode = 200;
            res.setHeader('Content-Type', types[ext] || 'application/octet-stream');
            res.setHeader('Content-Length', st.size);
            fs.createReadStream(file).pipe(res);
          });
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': src,
      // 内核以**源码**方式直接引用（不是打包副本）：
      // 前端、断言、将来的 Java 侧读的是同一份规则定义。
      // 任何"前端偷偷改了一版规则"的情况都不可能再发生。
      '@core': core,
    },
  },
  server: {
    port: 5180,
    host: '127.0.0.1',
    strictPort: true,
    fs: { allow: ['..'] }, // 允许读取 ../spatial-core
    // 这台机器上另有一个进程会短暂持有刚写过的文件（编辑器的临时文件、杀毒扫描都这样），
    // 原生 `fs.watch` 一碰就抛 `EBUSY: resource busy or locked`，而 Vite 把这个错误直接抛成进程级
    // 错误：整个开发服务器退出，页面再也打不开。实测撞过三次（`App.vue.tmpdir\App.vue.tmp`、
    // `src/assets/login/login-bg.png`、`src/pages/login.css`）。因此改成**轮询**：
    // 轮询不开文件句柄，这个错误不会发生；代价是每 `interval` 毫秒 stat 一遍源码树。
    // 图片与大模型不进监视器：它们换一次就够了，不需要热更新。
    // 这里要连默认忽略一起写全：给了 `ignored` 就会替掉 Vite 自己的默认值。
    watch: {
      usePolling: true,
      interval: 400,
      ignored: [
        '**/.git/**', '**/node_modules/**', '**/test-results/**', '**/*.tmpdir/**', '**/*.tmp',
        '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.webp', '**/*.glb',
      ],
    },
    // /api 代理到后端：前端因此**不需要 CORS**，也不写死后端地址。
    // 目标地址可用环境变量覆盖（例如后端换了端口）：SPATIAL_API=http://127.0.0.1:9090 npm run dev
    proxy: {
      '/api': {
        target: process.env.SPATIAL_API || 'http://127.0.0.1:8080',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1200,
  },
  // 生产构建的预览（`npm run preview`）的端口**在 `package.json` 里**：
  //   "preview": "vite preview --port 4180 --strictPort"
  // 不在这里再写一遍 `preview.port` —— 同一个事实只许一处出处（两处早晚会不一致）。
  // 与 `start.sh --prod` / `stop.sh` 探的 4180 是同一个数。
});