#!/usr/bin/env node
/**
 * 规则 6 落地：把散在三处的目录信息合并成**唯一一份** catalog。
 *
 * 1. 型号声明   extracted/scripts/01_main-module.js 里的 `products` 数组
 *               （作者写的 origin / sizeNote / desc / facts / features 全部保留 —— 这是溯源信息）
 * 2. 配方铰链   assets/catalog/recipes.json 的 `models[].pivots`
 * 3. 模型资产   assets/catalog/assets.manifest.json（文件 / 字节 / md5 / 面数 / 生成器）
 *
 * 另外把官方模型那条"后加的演示铰链"从主脚本里**解析出来**，不手抄：
 *   hinges=[{ node: clone.getObjectByName("outer_door"), axis:"y", openAngle:1.85 }]
 *
 * 输出 assets/catalog/products.json —— 界面（Vite 直接 import JSON）、
 * 校验脚本、后续 Java 侧建表都读这一份。多来源对齐的东西只有一份，就不会再打架。
 *
 *   node tools/models/build-catalog.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'assets', 'catalog', 'products.json');
const j = (...p) => join(root, ...p);

/** 取 `const NAME=[…]` 或 `const NAME = {…}` 字面量（花括号/方括号计数，跳过字符串） */
function literal(src, name) {
  const at = src.search(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*`));
  if (at < 0) throw new Error(`找不到声明 ${name}`);
  let i = src.slice(at).search(/[[{]/) + at;
  const open = src[i];
  const close = open === '[' ? ']' : '}';
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
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) break;
    }
  }
  return JSON.parse(src.slice(start, i + 1));
}

const mainSrc = readFileSync(j('extracted', 'scripts', '01_main-module.js'), 'utf8');
const products = literal(mainSrc, 'products');
const recipes = JSON.parse(readFileSync(j('assets', 'catalog', 'recipes.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(j('assets', 'catalog', 'assets.manifest.json'), 'utf8'));

/** 官方模型那条演示铰链：从源码里解析，源码改了这里就跟着变（不手抄） */
function officialHinge(src, nodeName) {
  const m = src.match(new RegExp(`getObjectByName\\("${nodeName}"\\)\\s*,\\s*axis\\s*:\\s*"([xyz])"\\s*,\\s*openAngle\\s*:\\s*(-?[\\d.]+)`));
  if (!m) return null;
  return { node: nodeName, axis: m[1], openAngleRad: Number(m[2]) };
}

const byId = new Map(manifest.files.map((f) => [f.id, f]));
const mm = (m) => Math.round(m * 1000 * 1000) / 1000; // 米 → 毫米，留 3 位（源数据就是毫米级测量值）

/**
 * 资产解析：两种写法都可能对上。
 *   demo-ct-scanner/demo-freezer-dual → products.model 与文件 id 相同
 *   demo-freezer-upright/demo-freezer-chest → products.model 是中文系列名（如 "DEMO-FZ-25U"），只有 recipeId 与文件 id 一致
 * 按 model → recipeId → 前缀 依次尝试，并把最终对上的"资产 id"单独记下来：
 * 后端 product_model 表要用资产 id 做关联键，不能用展示用的系列名。
 */
function resolveAsset(p) {
  const direct = byId.get(p.model) ?? byId.get(p.recipeId);
  if (direct) return direct;
  const key = String(p.recipeId ?? p.model).split(/[^A-Za-z0-9]+/).filter(Boolean).slice(0, 2).join('-').toLowerCase();
  return manifest.files.find((f) => f.id.toLowerCase().startsWith(key)) ?? null;
}

const out = products.map((p) => {
  const asset = resolveAsset(p);
  const recipe = p.recipeId ? recipes.models.find((m) => m.id === p.recipeId) ?? null : null;

  // 门的定义：优先用配方 pivots；官方模型用源码里那条演示铰链
  let doors = [];
  let doorSource = null;
  if (recipe?.pivots?.length) {
    doors = recipe.pivots.map((pv) => ({ node: pv.name, axis: pv.axis, openAngleRad: pv.openAngle, pivot: pv.position }));
    doorSource = `配方 pivots（assets/catalog/recipes.json · ${recipe.id}）`;
  } else if (asset) {
    const official = asset.nodes.map((n) => officialHinge(mainSrc, n)).filter(Boolean);
    const guess = official.length ? official : asset.nodes.filter((n) => /door|lid/i.test(n)).map((n) => officialHinge(mainSrc, n)).filter(Boolean);
    doors = guess;
    doorSource = guess.length ? '主脚本内写死的演示铰链（作者注明"开合轴为后加的演示设置"）' : null;
  }

  return {
    id: p.id,
    name: p.name,
    modelCode: p.model,
    // 尺寸：毫米（界面/后端统一按毫米存，米只在 3D 缩放时用）
    w: mm(p.w),
    d: mm(p.d),
    h: mm(p.h),
    color: p.color,
    origin: p.origin ?? null,
    sizeNote: p.sizeNote ?? null,
    desc: p.desc ?? null,
    facts: p.facts ?? [],
    features: p.features ?? [],
    sourceUrl: p.url ?? null,
    recipeId: p.recipeId ?? null,
    assetId: asset?.id ?? null,
    asset: asset
      ? { file: asset.file, bytes: asset.bytes, md5: asset.md5, triangles: asset.triangles ?? null, meshes: asset.meshes ?? null, textures: asset.images ?? 0, generator: asset.generator ?? null, nodes: asset.nodes ?? [] }
      : null,
    doors,
    doorSource,
    doorVerified: false,
    recipe: recipe ? { parts: recipe.parts.length, materials: Object.keys(recipes.materials).length } : null,
  };
});

const missing = out.filter((p) => !p.asset);
const noDoors = out.filter((p) => p.asset && !p.doors.length);

writeFileSync(
  OUT,
  JSON.stringify(
    {
      note: '由 tools/models/build-catalog.mjs 生成。型号声明来自原型 products 数组（含作者溯源说明）；改这里等于改事实，请同时更新 docs/07。',
      generatedAt: new Date().toISOString(),
      units: 'mm',
      sources: { products: 'extracted/scripts/01_main-module.js', recipes: 'assets/catalog/recipes.json', models: 'assets/catalog/assets.manifest.json' },
      products: out,
    },
    null,
    2,
  ),
);

console.log(`\n✓ 目录已生成 ${OUT}\n`);
console.log('型号            编码                  面积mm(w×d×h)              模型         面数    门节点');
for (const p of out) {
  console.log(
    `${p.id.padEnd(7)} ${String(p.modelCode).padEnd(21)} ${`${p.w}×${p.d}×${p.h}`.padEnd(26)} ${(p.asset ? String(p.asset.triangles) : '—').padStart(7)} ${String(p.asset?.bytes ?? '—').padStart(9)}  ${p.doors.map((d) => `${d.node}(${d.axis} ${((d.openAngleRad * 180) / Math.PI).toFixed(0)}°)`).join(' ') || '—'}`,
  );
}
if (missing.length) console.log(`\n⚠ 没有模型资产的型号：${missing.map((p) => p.id).join(', ')}`);
if (noDoors.length) console.log(`\n⚠ 有资产但没识别出门节点的型号：${noDoors.map((p) => p.id).join(', ')}`);
console.log('\n注意：w/d/h 是"声明包络"（2D 占地用），与模型实测包围盒是否一致由 verify-models.py 逐条核对。');