/**
 * thumbs.js —— 型号卡片上的**缩略图**（离屏渲染，不引新依赖）
 *
 * 做法：一个共享的离屏 WebGL 渲染器，把 LOD0 模型按 3/4 视角渲成 96×96（×2 倍像素密度）的
 * 透明 PNG。**复用 3D 那边同一套加载与校准**（`gltf.js` 的 loadAsset / bindDoors / fitClone），
 * 所以缩略图和 3D 里看到的是同一个东西 —— 不会出现"卡片上是个瘦箱子、点进去是个胖箱子"。
 *
 * 三级来源（从便宜到贵）：
 *   ① 服务端给了真图（`product_model.thumb_file`）→ 直接用，不渲染
 *   ② sessionStorage 里有这个模型的缓存 → 直接用（**键里带模型 md5**，模型一换自动失效）
 *   ③ 现渲染
 *
 * 为什么缓冲键要带 `STYLE`：改了相机或灯光就得让老缓存失效，否则"改了没生效"会很难查
 * （这正是"读的是旧的那份"这类问题的常见来源）。
 *
 * 渲染是**排队一次一个**的：4 款型号同时抢 GPU 只会让首屏更慢，而且缩略图不在关键路径上。
 * 失败一律返回 null —— 卡片退回色块占位，绝不显示破图。
 */
import * as THREE from 'three';
import { bindDoors, entryOf, fitClone, loadAsset, loadCatalogs, pickLevel } from './gltf.js';

const SIDE = 96;      // 逻辑尺寸（px）
const DPR = 2;        // 像素密度：96×96 的卡片在 2 倍屏上要 192×192 才不糊
const STYLE = 'v1';   // 渲染口径版本：改相机/灯光/背景就改它（缓存键会跟着变）

const mem = new Map();     // key → dataURL（页面内）
const jobs = new Map();    // key → Promise（同一张图不重复渲）
let queue = Promise.resolve();
let renderer = null;
let scene = null;
let camera = null;
let unavailable = false;

/** 懒建离屏渲染器。WebGL 不可用就**一次性**认输（不再每张图都试一遍）。 */
function ensure() {
  if (renderer || unavailable) return renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,   // toDataURL 要它：不然渲完缓冲区可能已被清掉
    });
    renderer.setPixelRatio(DPR);
    renderer.setSize(SIDE, SIDE, false);
    renderer.setClearAlpha(0);       // 透明底：卡片是白底，抠不出白边
    scene = new THREE.Scene();
    // 灯光与 3D 鸟瞰**同一套**（生活经验：模型在不同视图里明暗不一样，看着就像两个东西）
    scene.add(new THREE.HemisphereLight(0xffffff, 0x8fa3b0, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(4, 8, 6);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-6, 5, -4);
    scene.add(fill);
    camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    return renderer;
  } catch (e) {
    unavailable = true;
    console.warn('[thumbs] 这个环境给不了离屏 WebGL，卡片退回色块：' + e.message);
    return null;
  }
}

const keyOf = (p) => `${STYLE}:${p.id}:${p.modelMd5 ?? 'x'}`;

function readSession(key) {
  try { return sessionStorage.getItem('spatial.thumb.' + key) || null; } catch { return null; }
}

function writeSession(key, url) {
  try { sessionStorage.setItem('spatial.thumb.' + key, url); } catch { /* 配额满/隐私模式：不算错误 */ }
}

/**
 * 取一张缩略图（dataURL 或服务端 URL）。四款型号各自调用一次即可；
 * 同一个 key 只会真的渲一次，失败返回 null（**不缓存失败**，下次还有机会）。
 */
export async function thumbFor(product) {
  if (!product || !product.id) return null;
  if (product.thumbUrl) return product.thumbUrl;        // ① 服务端有真图
  const key = keyOf(product);
  if (mem.has(key)) return mem.get(key);
  if (jobs.has(key)) return jobs.get(key);
  const hit = readSession(key);                          // ② 上次渲染过
  if (hit) { mem.set(key, hit); return hit; }
  const job = (queue = queue.then(() => renderOne(product, key), () => renderOne(product, key)));
  jobs.set(key, job);
  try {
    return await job;
  } finally {
    jobs.delete(key);
  }
}

async function renderOne(product, key) {
  const r = ensure();                                    // ③ 现渲染
  if (!r) return null;
  let clone = null;
  try {
    await loadCatalogs();
    if (!entryOf(product.id)) return null;               // 目录里没有这个型号的模型资产
    const want = pickLevel(product.id, { count: 1, force: 'lod0' }) ?? pickLevel(product.id, { count: 1 });
    if (!want) return null;
    const { root, entry } = await loadAsset(product.id, want);
    clone = root.clone(true);
    // 顺序与 3D 完全一致：**先量铰链、再校准**（反了的话 fit 模型会全部误报铰链不对）
    bindDoors(clone, entry);
    fitClone(clone, entry);
    const box = new THREE.Box3().setFromObject(clone);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) / 2 || 0.5;
    const dist = (radius / Math.tan((camera.fov * Math.PI) / 360)) * 1.5;
    // 3/4 视角（略高、略偏右）：和鸟瞰同一个口味，也最能看出"这是台什么箱子"
    camera.position.copy(center).addScaledVector(new THREE.Vector3(0.75, 0.5, 1).normalize(), dist);
    camera.lookAt(center);
    scene.add(clone);
    r.render(scene, camera);
    scene.remove(clone);
    const url = r.domElement.toDataURL('image/png');
    if (!url || url.length < 200) return null;
    mem.set(key, url);
    writeSession(key, url);
    return url;
  } catch (e) {
    console.warn('[thumbs] ' + product.id + ' 渲染失败：' + e.message);
    return null;
  } finally {
    if (clone) {
      // 渲完就扔：缩略图和 3D 场景不共享节点（共享了就会互相改位置）
      clone.traverse((o) => { if (o.geometry) o.geometry = null; });
      scene?.remove(clone);
    }
  }
}
