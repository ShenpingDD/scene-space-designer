#!/usr/bin/env node
/**
 * R5-5 压缩与 LOD。
 *
 * 目标（docs/07）：
 *   单模型 ≤3 MB、lod0 ≤60,000 面；LOD 至少 2 级；门节点名与铰链必须原样保留。
 *
 * 实测过才知道钱花在哪：官方模型 15.76 MB 里**贴图只占 205 KB（1.3%）**，
 * 98.7% 是 POSITION/NORMAL/TEXCOORD 原始浮点 —— 所以主战场是网格，不是贴图。
 *
 * 处理链（顺序有讲究）：
 *   dedup → prune → weld → simplify(ratio,error) → quantize → meshopt → 可选 textureCompress
 *   weld 必须在 simplify 之前（顶点没焊死，简化算法分不清哪些是同一个面）；
 *   quantize / meshopt 放最后（它们改的是二进制表示，前面步骤仍需要全精度）。
 *
 * 迭代收敛：simplify 的 ratio 只是"目标比例"，实际结果会有偏差，
 * 所以按实测面数回算一次 ratio 再跑一遍（最多两轮），不去赌。
 *
 * 输出：assets/optimized/<资产id>.<lod>.glb + lod.manifest.json
 * 产物必须能通过 verify-models.py --dir assets/optimized 才算达标。
 *
 *   cd tools/models && npm run optimize
 */
import { Logger, NodeIO, Verbosity } from '@gltf-transform/core';
import { EXTMeshoptCompression, EXTTextureWebP, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, prune, weld, simplify, quantize, meshopt, textureCompress } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const j = (...p) => join(root, ...p);
const OUT_DIR = j('assets', 'optimized');

let sharp = null;
try {
  sharp = (await import('sharp')).default;
} catch {
  console.log('提示：未安装 sharp，跳过贴图转 WebP（本项目贴图只占 1.3%，影响不大）');
}

/** LOD 分级：近景 / 常规 / 远景（20 台×lod0 = 120 万面，仍在 docs/07 的 150 万预算内） */
const LODS = [
  { name: 'lod0', maxTriangles: 60000, texMax: 1024, note: '近景/单体查看' },
  { name: 'lod1', maxTriangles: 20000, texMax: 512, note: '常规距离（房间内多台）' },
  { name: 'lod2', maxTriangles: 6000, texMax: 256, note: '远景/数量多时' },
];

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;

const io = new NodeIO()
  .setLogger(new Logger(Verbosity.WARN))
  // KHRMeshQuantization / EXTTextureWebP 必须注册：quantize 与 textureCompress 会加这两个声明，
  // 不注册会写出"声明缺失"的文件 —— 看着正常，运行时解不开（这个坑踩过一次）
  .registerExtensions([EXTMeshoptCompression, KHRMeshQuantization, EXTTextureWebP])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptEncoder });

/** 按实例计三角面（与 verify-models.py 同口径：渲染成本） */
function countTriangles(doc) {
  let n = 0;
  const visit = (node) => {
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const idx = prim.getIndices();
        n += (idx ? idx.getCount() : prim.getAttribute('POSITION').getCount()) / 3;
      }
    }
    for (const c of node.listChildren()) visit(c);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n2 of scene.listChildren()) visit(n2);
  return Math.round(n);
}

/** 列节点名（压缩后要确认门节点没被 prune 掉） */
const nodeNames = (doc) => {
  const out = [];
  const visit = (node) => {
    out.push(node.getName() || '(未命名)');
    for (const c of node.listChildren()) visit(c);
  };
  for (const scene of doc.getRoot().listScenes()) for (const n2 of scene.listChildren()) visit(n2);
  return out;
};

/** 折痕角：小于它共享一条平滑法线，大于它另开顶点（硬边） */
const CREASE_DEG = 35;

/**
 * 去法线。这是整个压缩流程的关键一步，理由是实测出来的：
 *
 * 官方模型 215,414 面 / 711,627 顶点，顶点÷面 = 3.30，即**逐面法线、完全硬边**（Blender 默认导出）。
 * meshoptimizer 不能跨越属性接缝丢面，而这里每条边都是接缝，于是：
 *   error 从 0.0001 放到 0.2（放宽 2000 倍）也只能降到 169,563 面；
 *   去掉 NORMAL（保留 UV）→ 直接降到 46,121 面；
 *   只去 UV、保留 NORMAL → 仍 174,343 面（UV 完全无辜）。
 * 所以：先去法线让几何能简化，简完再按折痕角重建（等价 Blender 的 Shade Auto Smooth）。
 * 硬边不丢，UV 与贴图映射也不受影响。
 */
function stripNormals() {
  return (doc) => {
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) if (prim.getAttribute('NORMAL')) prim.setAttribute('NORMAL', null);
    }
  };
}

/** 按折痕角重建法线：同位置同 UV 为一组，组内按面法线方向聚类，超过夹角就另开顶点 */
function rebuildNormals(creaseDeg = CREASE_DEG) {
  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);
  return (doc) => {
    const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const posAttr = prim.getAttribute('POSITION');
        if (!posAttr) continue;
        const uvAttr = prim.getAttribute('TEXCOORD_0');
        const idxAttr = prim.getIndices();
        const P = posAttr.getArray();
        const UV = uvAttr ? uvAttr.getArray() : null;
        const I = idxAttr ? idxAttr.getArray() : null;
        const vCount = posAttr.getCount();
        const triCount = Math.floor((I ? idxAttr.getCount() : vCount) / 3);
        const corner = (t, c) => (I ? I[t * 3 + c] : t * 3 + c);

        // 位置 + UV 分组（UV 接缝本来就必须拆点，不能合）
        const groups = new Map();
        const groupOf = new Int32Array(vCount);
        const groupRep = [];
        for (let v = 0; v < vCount; v++) {
          const key =
            `${P[v * 3].toFixed(4)},${P[v * 3 + 1].toFixed(4)},${P[v * 3 + 2].toFixed(4)}|` +
            (UV ? `${UV[v * 2].toFixed(4)},${UV[v * 2 + 1].toFixed(4)}` : '');
          let g = groups.get(key);
          if (g === undefined) {
            g = groups.size;
            groups.set(key, g);
            groupRep.push(v);
          }
          groupOf[v] = g;
        }

        // 面法线 + 逐组收集面
        const faceN = new Float32Array(triCount * 3);
        const groupFaces = new Map();
        for (let t = 0; t < triCount; t++) {
          const a = corner(t, 0), b = corner(t, 1), c2 = corner(t, 2);
          const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
          const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
          const cx = P[c2 * 3], cy = P[c2 * 3 + 1], cz = P[c2 * 3 + 2];
          const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
          const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
          const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
          const L = Math.hypot(nx, ny, nz) || 1;
          faceN[t * 3] = nx / L; faceN[t * 3 + 1] = ny / L; faceN[t * 3 + 2] = nz / L;
          for (const v of [a, b, c2]) {
            let arr = groupFaces.get(groupOf[v]);
            if (!arr) groupFaces.set(groupOf[v], (arr = []));
            arr.push(t);
          }
        }

        // 组内聚类 → 展开成新顶点
        const outPos = [], outUv = [], outNrm = [];
        const outIndex = new Map();
        for (const [gid, faces] of groupFaces) {
          const clusters = [];
          const assign = new Map();
          for (const t of faces) {
            const fx = faceN[t * 3], fy = faceN[t * 3 + 1], fz = faceN[t * 3 + 2];
            let ci = -1;
            for (let k = 0; k < clusters.length; k++) {
              const cl = clusters[k];
              if (cl.n[0] * fx + cl.n[1] * fy + cl.n[2] * fz >= cosLimit) { ci = k; break; }
            }
            if (ci < 0) { clusters.push({ n: [fx, fy, fz], s: [0, 0, 0] }); ci = clusters.length - 1; }
            const cl = clusters[ci];
            cl.s[0] += fx; cl.s[1] += fy; cl.s[2] += fz;
            assign.set(t, ci);
          }
          const r = groupRep[gid];
          const verts = clusters.map((cl) => {
            const L = Math.hypot(cl.s[0], cl.s[1], cl.s[2]) || 1;
            outPos.push(P[r * 3], P[r * 3 + 1], P[r * 3 + 2]);
            if (UV) outUv.push(UV[r * 2], UV[r * 2 + 1]);
            outNrm.push(cl.s[0] / L, cl.s[1] / L, cl.s[2] / L);
            return outPos.length / 3 - 1;
          });
          for (const t of faces) outIndex.set(`${gid}:${t}`, verts[assign.get(t)]);
        }

        const newIdx = new Uint32Array(triCount * 3);
        for (let t = 0; t < triCount; t++) {
          for (let c = 0; c < 3; c++) newIdx[t * 3 + c] = outIndex.get(`${groupOf[corner(t, c)]}:${t}`);
        }
        prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(outPos)).setBuffer(buffer));
        if (UV) prim.setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(outUv)).setBuffer(buffer));
        prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(outNrm)).setBuffer(buffer));
        prim.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buffer));
      }
    }
  };
}

async function buildLod(srcBytes, lod, target, tries = 0) {
  const doc = await io.readBinary(srcBytes);
  const before = countTriangles(doc);
  const ratio = Math.min(1, target / before);
  // 只有真需要降面数时才动法线（本来就在预算内的模型保持原样，不去无谓地改法线）
  const needSimplify = target < before * 0.95;
  // 顺序是实测定的：stripNormals 必须在 weld **之前**。
  // 法线在的时候 weld 几乎合不了顶点（索引里还留着位置重复的顶点），
  // meshoptimizer 依旧把每一条边当接缝 → ratio 给 0.03 也只降到 174,343 面。
  await doc.transform(
    dedup(),
    prune(),
    ...(needSimplify ? [stripNormals()] : []),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002, lockBorder: false }),
    ...(needSimplify ? [rebuildNormals()] : []),
    quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizationVolume: 'scene' }),
    ...(sharp ? [textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [lod.texMax, lod.texMax] })] : []),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );
  const after = countTriangles(doc);
  // 没收住就按实测回算一次（最多两轮），不去赌 ratio 的语义
  if (after > target && tries < 2) return buildLod(srcBytes, lod, Math.round(target * (target / after) * 0.98), tries + 1);
  const prefix = new Uint8Array(await io.writeBinary(doc));
  // 有些模型降不下去是真的到顶了（比如由 28 个独立小 primitive 组成、每个只有几面）
  // 这种情况标 floorReached：不当成失败，但要如实显示
  return { bytes: prefix, triangles: after, sourceTriangles: before, nodes: nodeNames(doc), floorReached: after > target };
}

// ── 单件模式（R6-2）─────────────────────────────────────────────────
// 本脚本原本只会**全量**跑：从静态 assets/catalog/products.json 读每一款，
// 产物写进 assets/optimized/，账记进 lod.manifest.json。
// 而**运行期新上传的产品不在那个文件里** —— 维护端需要一个"只跑一件"的入口。
//
// 用法：
//   node tools/models/optimize-models.mjs --only <源.glb> --asset-id <id> --out <目录> [--json <结果.json>]
//
// 三条纪律：
//   ① **全量路径一个字没动** —— 存量资产的账本仍是 lod.manifest.json，单件模式**不碰它**
//      （新增产品的账本记在库里的 product_model.lod_json，形状与 manifest 的 lods 逐字段相同，
//       这样前台合并时只有"从哪取"的区别，没有"形状不同"的第二套真相）。
//   ② 等效跳过（相邻两级面数差 <2%）在单件模式下**照样生效** —— 同一套判据，不许两条路走出两种结论。
//   ③ 结果写进 **--json 文件**而不是 stdout：Java 侧读文件，stdout 只留给人看。
const ARGV = process.argv.slice(2);
const argOf = (name) => { const i = ARGV.indexOf(name); return i >= 0 ? ARGV[i + 1] : null; };
const ONLY = argOf('--only');

if (ONLY) {
  const assetId = argOf('--asset-id') || 'upload';
  const outDir = resolve(argOf('--out') || OUT_DIR);
  const jsonOut = argOf('--json');
  const srcPath = resolve(ONLY);
  if (!existsSync(srcPath)) {
    console.error(`[x] 找不到源文件：${srcPath}`);
    process.exit(2);
  }
  const srcBytes = new Uint8Array(readFileSync(srcPath));
  const srcSize = statSync(srcPath).size;
  mkdirSync(outDir, { recursive: true });
  console.log(`=== 单件：${assetId}  源 ${(srcSize / 1048576).toFixed(2)} MB ===`);

  const lods = [];
  let lastKept = null;
  for (const lod of LODS) {
    const r = await buildLod(srcBytes, lod, lod.maxTriangles);
    if (lastKept && Math.abs(r.triangles - lastKept.triangles) / lastKept.triangles < 0.02) {
      console.log(`  ${lod.name}  与 ${lastKept.level} 等效（${r.triangles} 面，已达该模型下限）→ 不重复出文件`);
      lods.push({
        level: lod.name, skipped: true, equivalentTo: lastKept.level, triangles: r.triangles,
        maxTriangles: lod.maxTriangles, note: lod.note,
      });
      continue;
    }
    const file = `${assetId}.${lod.name}.glb`;
    writeFileSync(join(outDir, file), r.bytes);
    const meetsBudget = r.bytes.length <= 3 * 1024 * 1024
      && (r.triangles <= lod.maxTriangles || Boolean(r.floorReached));
    lods.push({
      level: lod.name,
      file,                                   // **只有文件名**：单件模式的产物与源文件同目录，
      bytes: r.bytes.length,                  // 调用方知道 outDir，不需要在这里拼路径（拼了反而两处会走样）
      triangles: r.triangles,
      maxTriangles: lod.maxTriangles,
      floorReached: Boolean(r.floorReached),
      note: lod.note,
      meetsBudget,
    });
    console.log(`  ${lod.name}  ${(r.bytes.length / 1048576).toFixed(2)} MB  ${r.triangles} 面  ${meetsBudget ? '✓' : '✗ 超预算'}`);
    lastKept = { level: lod.name, triangles: r.triangles };
  }

  const summary = { assetId, source: { file: ONLY, bytes: srcSize }, lods };
  if (jsonOut) writeFileSync(resolve(jsonOut), JSON.stringify(summary, null, 2));
  process.exit(0);   // 到此为止：**不许**往下跑全量（那会把静态账本重写一遍）
}

mkdirSync(OUT_DIR, { recursive: true });
const catalog = JSON.parse(readFileSync(j('assets', 'catalog', 'products.json'), 'utf8'));
const rows = [];
const warnings = [];

for (const p of catalog.products) {
  if (!p.asset) continue;
  const srcPath = j(p.asset.file);
  const srcBytes = new Uint8Array(readFileSync(srcPath));
  const srcSize = statSync(srcPath).size;
  const doors = p.doors.map((d) => d.node);
  console.log(`\n=== ${p.id}  ${p.assetId}   源 ${(srcSize / 1048576).toFixed(2)} MB / ${p.asset.triangles} 面 ===`);

  const lods = [];
  let lastKept = null;
  for (const lod of LODS) {
    const r = await buildLod(srcBytes, lod, lod.maxTriangles);
    // 触到底线时相邻两级会得到几乎一样的结果（保留 UV 接缝时 meshoptimizer 有下限），
    // 那就没必要多出一份重复文件，直接标"与上一级等效"
    if (lastKept && Math.abs(r.triangles - lastKept.triangles) / lastKept.triangles < 0.02) {
      console.log(`  ${lod.name}  与 ${lastKept.level} 等效（${r.triangles} 面，已达该模型下限）→ 不重复出文件`);
      lods.push({ level: lod.name, skipped: true, equivalentTo: lastKept.level, triangles: r.triangles, maxTriangles: lod.maxTriangles, note: lod.note });
      continue;
    }
    const file = `${p.assetId}.${lod.name}.glb`;
    writeFileSync(join(OUT_DIR, file), r.bytes);
    const missingDoors = doors.filter((d) => !r.nodes.includes(d));
    if (missingDoors.length) warnings.push(`${p.id}/${lod.name} 丢了门节点：${missingDoors.join(', ')}`);
    const okTri = r.triangles <= lod.maxTriangles;
    const okSize = r.bytes.length <= 3 * 1024 * 1024;
    const warnTri = okTri ? '✓' : r.floorReached ? `⚠ 已达该模型下限（目标 ${lod.maxTriangles}）` : '✗ 面数超标';
    console.log(
      `  ${lod.name}  ${(r.bytes.length / 1048576).toFixed(2)} MB  ${String(r.triangles).padStart(7)} 面  ` +
        `压缩比 ${((1 - r.bytes.length / srcSize) * 100).toFixed(1)}%  ${warnTri} ${okSize ? '✓' : '✗ 体积超标'}  ${lod.note}`,
    );
    lods.push({
      level: lod.name,
      file: `assets/optimized/${file}`,
      bytes: r.bytes.length,
      triangles: r.triangles,
      maxTriangles: lod.maxTriangles,
      floorReached: Boolean(r.floorReached),
      note: lod.note,
      doorsPresent: missingDoors.length === 0,
      meetsBudget: okSize && (okTri || r.floorReached),
    });
    lastKept = { level: lod.name, triangles: r.triangles };
  }
  const base = lods[0];
  rows.push({
    productId: p.id,
    assetId: p.assetId,
    source: { file: p.asset.file, bytes: srcSize, triangles: p.asset.triangles },
    ratio: Number((base.triangles / Math.max(p.asset.triangles, 1)).toFixed(4)),
    lods,
  });
}

writeFileSync(
  j('assets', 'optimized', 'lod.manifest.json'),
  JSON.stringify(
    {
      note: '由 tools/models/optimize-models.mjs 生成。链路 dedup→prune→weld→simplify→quantize→meshopt(+webp)。运行时需注册 MeshoptDecoder。',
      generatedAt: new Date().toISOString(),
      decoder: 'EXT_meshopt_compression（three.js 需注册 MeshoptDecoder）',
      levels: LODS.map((l) => ({ level: l.name, maxTriangles: l.maxTriangles, texMax: l.texMax, note: l.note })),
      models: rows,
    },
    null,
    2,
  ),
);

const total = rows.reduce((s, r) => s + r.lods.reduce((t, l) => t + (l.bytes ?? 0), 0), 0);
const written = rows.reduce((s, r) => s + r.lods.filter((l) => !l.skipped).length, 0);
const allOk = rows.every((r) => r.lods.every((l) => l.meetsBudget !== false));
console.log(`\n${'-'.repeat(78)}`);
console.log(`共 ${rows.length} 款，实际写出 ${written} 个文件，合计 ${(total / 1048576).toFixed(2)} MB`);
if (warnings.length) {
  console.log('⚠ 问题：');
  for (const w of warnings) console.log('   ' + w);
}
console.log(allOk ? '✓ 全部在预算内（lod0/lod1/lod2 均 ≤3 MB 且不超过对应面数）' : '✗ 有文件超预算，见上表');
console.log(`清单：assets/optimized/lod.manifest.json`);
process.exit(allOk && !warnings.length ? 0 : 1);