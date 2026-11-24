#!/usr/bin/env node
/**
 * 把单文件里内嵌的模型资产搬成真实文件（docs/07 的落地第一步）。
 *
 * 输入（都是被 git 跟踪、随时可重建的）：
 *   extracted/modules/08_model-data.js    -> export const modelBase64 = "<GLB base64>"
 *   extracted/modules/10_haier-catalog.js -> export const recipes / reconstructedFiles
 *
 * 输出：
 *   assets/models/<型号>.glb              原始模型二进制（不入库：一条命令即可重建）
 *   assets/catalog/recipes.json           配方（材质 + 部件尺寸）
 *   assets/catalog/assets.manifest.json   清单：来源 / 字节数 / md5 / glTF 概要
 *
 * 产物路径故意用"型号"命名，与 docs/07 的交付约定一致：
 * 建模同事交回来的文件放同一个目录，验证脚本可以直接吃。
 *
 *   node tools/models/extract-models.mjs            # 抽取
 *   node tools/models/extract-models.mjs --check    # 只校验已抽出的文件，不重写
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MODEL_DATA = join(root, 'extracted', 'modules', '08_model-data.js');
const CATALOG = join(root, 'extracted', 'modules', '10_haier-catalog.js');
const OUT_MODELS = join(root, 'assets', 'models');
const OUT_CATALOG = join(root, 'assets', 'catalog');
const checkOnly = process.argv.includes('--check');

/** 取 `export const NAME = "…";` 的单串导出 */
function base64Export(src, name) {
  const at = src.indexOf(`export const ${name} = "`);
  if (at < 0) throw new Error(`找不到导出 ${name}`);
  const from = at + `export const ${name} = "`.length;
  const to = src.indexOf('";', from);
  if (to < 0) throw new Error(`导出 ${name} 没有正常结束（可能被截断）`);
  return src.slice(from, to);
}

/** 取 `export const NAME = {…};` 的对象导出（花括号计数，跳过字符串内的括号） */
function objectExport(src, name) {
  const at = src.indexOf(`export const ${name} = `);
  if (at < 0) throw new Error(`找不到导出 ${name}`);
  let i = src.indexOf('{', at);
  const start = i;
  let depth = 0;
  let inStr = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return JSON.parse(src.slice(start, i + 1));
}

/** 读 GLB 的 12 字节头 + JSON 块，用于清单与截断检查 */
function glbInfo(buf) {
  const magic = buf.toString('ascii', 0, 4);
  const version = buf.readUInt32LE(4);
  const declared = buf.readUInt32LE(8);
  const info = { magic, version, declaredBytes: declared, bytes: buf.length, truncated: declared !== buf.length };
  try {
    const jsonLen = buf.readUInt32LE(12);
    const jsonType = buf.readUInt32LE(16);
    if (jsonType === 0x4e4f534a) {
      const js = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
      info.generator = js.asset?.generator ?? null;
      info.nodes = (js.nodes ?? []).map((n) => n.name).filter(Boolean);
      info.meshes = (js.meshes ?? []).length;
      info.materials = (js.materials ?? []).length;
      info.images = (js.images ?? []).length;
      // 按实例计：同一个 mesh 被 30 个节点引用（比如通风格栅）就要重复计，画的时候是真画 30 遍，
      // 所以"渲染成本"要看实例数，不能只看 mesh 定义数（与 verify-models.py 同口径）
      let tris = 0;
      const visit = (i) => {
        const n = js.nodes[i];
        if (n.mesh != null) {
          for (const p of js.meshes[n.mesh].primitives ?? []) {
            tris += (p.indices != null ? js.accessors[p.indices].count : js.accessors[p.attributes.POSITION].count) / 3;
          }
        }
        for (const c of n.children ?? []) visit(c);
      };
      for (const r of (js.scenes?.[js.scene ?? 0] ?? { nodes: [] }).nodes ?? []) visit(r);
      info.triangles = Math.round(tris);
      info.triangleNote = '按实例计（渲染成本口径）';
    }
  } catch (e) {
    info.parseError = String(e.message);
  }
  return info;
}

const md5 = (buf) => createHash('md5').update(buf).digest('hex');

function main() {
  const t0 = Date.now();
  const modelSrc = readFileSync(MODEL_DATA, 'utf8');
  const catSrc = readFileSync(CATALOG, 'utf8');

  const jobs = [{ id: 'DEMO-CT-100', b64: base64Export(modelSrc, 'modelBase64'), origin: 'modelBase64（随单文件内嵌，官方模型）' }];
  const reconstructed = objectExport(catSrc, 'reconstructedFiles');
  for (const [id, b64] of Object.entries(reconstructed)) {
    jobs.push({ id, b64, origin: 'reconstructedFiles（按官网尺寸表重建，dimensions UNVERIFIED）' });
  }
  const recipes = objectExport(catSrc, 'recipes');

  if (!checkOnly) {
    mkdirSync(OUT_MODELS, { recursive: true });
    mkdirSync(OUT_CATALOG, { recursive: true });
  }

  const files = [];
  for (const job of jobs) {
    const buf = Buffer.from(job.b64, 'base64');
    const info = glbInfo(buf);
    const file = join(OUT_MODELS, `${job.id}.glb`);
    if (!checkOnly) writeFileSync(file, buf);
    const onDisk = existsSync(file) ? statSync(file).size : 0;
    files.push({ id: job.id, file: `assets/models/${job.id}.glb`, origin: job.origin, base64Chars: job.b64.length, ...info, md5: md5(buf), onDiskBytes: onDisk });

    const flag = info.truncated ? '⚠ 头部声明与实长不符' : info.magic === 'glTF' && info.version === 2 ? '✓' : '✗ 不是 glTF 2.0';
    console.log(`\n${flag} ${job.id}`);
    console.log(`   base64 ${job.b64.length} 字符 → 二进制 ${buf.length} 字节（${(buf.length / 1048576).toFixed(2)} MB）`);
    console.log(`   生成器   ${info.generator ?? '（JSON 块未解析）'}`);
    console.log(`   网格/材质/贴图 ${info.meshes ?? '?'} / ${info.materials ?? '?'} / ${info.images ?? '?'}   三角面 ${info.triangles ?? '?'}`);
    console.log(`   节点     ${(info.nodes ?? []).join(', ')}`);
    console.log(`   md5      ${md5(buf)}`);
  }

  if (!checkOnly) {
    writeFileSync(join(OUT_CATALOG, 'recipes.json'), JSON.stringify(recipes, null, 2));
    writeFileSync(
      join(OUT_CATALOG, 'assets.manifest.json'),
      JSON.stringify(
        {
          note: '由 tools/models/extract-models.mjs 从 extracted/ 生成；assets/models/*.glb 不入库（可随时重建）',
          generatedAt: new Date().toISOString(),
          source: { modelData: 'extracted/modules/08_model-data.js', catalog: 'extracted/modules/10_haier-catalog.js' },
          recipeIds: recipes.models.map((m) => m.id),
          files: files.map(({ onDiskBytes, ...f }) => f),
        },
        null,
        2,
      ),
    );
    const total = files.reduce((s, f) => s + f.bytes, 0);
    console.log(`\n总计 ${(total / 1048576).toFixed(2)} MB / ${files.length} 个模型 —— 清单已写入 assets/catalog/assets.manifest.json`);
    console.log(`配方 ${recipes.models.length} 款，材质 ${Object.keys(recipes.materials ?? {}).length} 种 → assets/catalog/recipes.json`);
  }

  const bad = files.filter((f) => f.truncated || f.magic !== 'glTF' || f.version !== 2);
  if (bad.length) {
    console.error(`\n✗ ${bad.length} 个文件有问题：${bad.map((b) => b.id).join(', ')}`);
    process.exit(1);
  }
  if (checkOnly && files.some((f) => f.onDiskBytes !== f.bytes)) {
    const missing = files.filter((f) => f.onDiskBytes !== f.bytes).map((f) => f.id);
    console.error(`\n✗ --check：磁盘文件与源不一致（缺文件或大小不符）：${missing.join(', ')}`);
    process.exit(3);
  }
  console.log(`\n✓ 全部通过（${Date.now() - t0} ms）`);
}

main();