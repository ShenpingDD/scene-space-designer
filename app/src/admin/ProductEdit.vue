<script setup>
/**
 * ProductEdit —— 产品模型库里的单款编辑页（验收-2）
 *
 * 这一页专门补“列表里改不了、但产品事实必须能维护”的字段：
 * 名称/简介/系列/来源/尺寸备注/颜色、声明尺寸、门型与已确认、缩略图、卖点/参数。
 *
 * 三条边界：
 *  · 型号是自然键，只读；改型号不在这一页做（会牵动目录 id、方案与供应商对账）。
 *  · 声明尺寸与实测 bbox 是两件事：声明值只给人工输入，不拿实测值倒填。
 *  · 产品信息先走 `adminUpdateProduct`；内容有变化才 save → publish，
 *    发布失败保留编辑态并说清“内容已保存、没发布”，不假装成功。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { go } from '../router.js';
import { getProduct } from '../catalog.js';
import { doorPartLabel } from '../kernel.js';
import { thumbFor } from '../thumbs.js';
import { anisotropyOf, envelopeOkFor } from './analyze.js';
import { statusLabel } from './view.js';
import ProductContentFields from './ProductContentFields.vue';

const props = defineProps({
  productId: { type: [Number, String], required: true },
  caps: { type: Object, default: null },
  role: { type: String, default: '' },
});

const phase = ref('loading');       // loading | ok | fail
const trouble = ref('');
const card = ref(null);
const content = ref({ sellingPoints: [], params: [] });
const contentRev = ref(0);
const contentOriginal = ref('[]');
const contentTrouble = ref('');
const quality = ref(null);          // GET /quality：只读，人工代录没模型行时为 null
const qualityTrouble = ref('');
const saving = ref('');             // '' | product | content | publish
const saveError = ref('');
const saveMessage = ref('');
const needsPublish = ref(false);
const thumbBusy = ref('');
const thumbError = ref('');
const thumbPath = ref('');
const thumbBroken = ref(false);

const form = ref({
  name: '', description: '', series: '', sourceUrl: '', sizeNote: '', color: '',
  doorPart: '', doorVerified: false,
});
const declared = ref({ w: '', d: '', h: '' });
// 尺寸口径：1:1 = 逐轴对账；fit = 只查量纲。声明尺寸变了必须重算结论，不能沿用旧 NULL。
const sizeMode = ref('fit');

const canMaintain = computed(() => (props.caps ? !!props.caps.maintain : null));
const noMaintainText = computed(() => (canMaintain.value === false
  ? '当前角色没有维护产品的权限；按钮只是提前说明，真正的门在服务端。'
  : ''));

const DOORS = [
  { key: 'single', label: '柜门' },
  { key: 'double', label: '双门' },
  { key: 'top', label: '上盖' },
  { key: 'drawer', label: '抽屉' },
  { key: 'none', label: '无门' },
];
const doorLabel = (k) => (k ? doorPartLabel(k) || k : '未判断');
const statusText = computed(() => {
  const s = card.value && card.value.status;
  return statusLabel(s) || (s ? String(s) : '（未知）');
});

const model = computed(() => (card.value && card.value.model) || {});
const variants = computed(() => (card.value && Array.isArray(card.value.variants) ? card.value.variants : []));
/** 人工代录没有 model 行；缩略图列在 product_model 上，不能假装能保存。 */
const hasModel = computed(() => !!(card.value && card.value.model && card.value.model.variant));

/** 实测 bbox（mm）→ 与 analyze.js 同一套入参；缺轴就是 null，不拿 0 冒充。 */
const measuredMm = computed(() => ({
  w: Number(model.value.bboxW) > 0 ? Number(model.value.bboxW) : null,
  d: Number(model.value.bboxD) > 0 ? Number(model.value.bboxD) : null,
  h: Number(model.value.bboxH) > 0 ? Number(model.value.bboxH) : null,
}));
const declaredMm = computed(() => ({
  w: numOrNull(declared.value.w),
  d: numOrNull(declared.value.d),
  h: numOrNull(declared.value.h),
}));
// 编辑页必须当场重算：只改声明尺寸却沿用旧 envelope_ok，会让角标看起来永远修不好。
const sizeVerdict = computed(() => ({
  envelopeOk: envelopeOkFor(sizeMode.value, measuredMm.value, declaredMm.value),
  anisotropyOk: anisotropyOf(measuredMm.value, declaredMm.value).ok,
}));

/** 数字 → 可读 mm；null 就明说没有，不拿 0 冒充 */
function mm(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? String(Math.round(n * 10) / 10) : '—';
}
function m3(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? (n / 1000).toFixed(2) + ' m' : '—';
}

/** 库里的路径（assets/... 或 /api/...）→ 浏览器可取的 URL */
function pathUrl(path) {
  const s = path == null ? '' : String(path).trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/.test(s)) return s;
  return s.startsWith('/') ? s : '/' + s;
}

const thumbPreview = computed(() => (thumbPath.value ? pathUrl(thumbPath.value) : ''));
const busy = computed(() => !!saving.value);

function normalizedContent(c) {
  const src = c || {};
  const sellingPoints = (Array.isArray(src.sellingPoints) ? src.sellingPoints : [])
    .map((s) => String(s == null ? '' : s).trim())
    .filter(Boolean);
  const params = (Array.isArray(src.params) ? src.params : [])
    .map((p) => ({
      key: String((p && p.key) || '').trim(),
      value: String((p && p.value) || '').trim(),
      unit: String((p && p.unit) || '').trim(),
      group: String((p && p.group) || '').trim(),
    }))
    .filter((p) => p.key);
  return { sellingPoints, params };
}
function contentSnapshot(c) {
  return JSON.stringify(normalizedContent(c));
}

/** 卡片里可能没有回传声明尺寸；能从 declared / recipeJson 读到就用，读不到留空 */
function declaredOf(p, key) {
  if (!p) return '';
  let d = p.declared || p.declaredMm || (p.recipe && p.recipe.declared);
  if (!d && typeof p.recipeJson === 'string' && p.recipeJson) {
    try {
      d = JSON.parse(p.recipeJson);
    } catch { d = null; }
  }
  let v = d && d[key];
  // 声明尺寸没有单独回传时，从目录的声明包络补（目录单位是 m，表单要 mm）。
  // 这是“读声明值”，不是拿实测 bbox 倒填 —— 两者不能混。
  if (v == null && p.recipeId) {
    const cat = getProduct(p.recipeId);
    if (cat && Number.isFinite(Number(cat[key])) && Number(cat[key]) > 0) {
      v = Math.round(Number(cat[key]) * 1000 * 10) / 10;
    }
  }
  return v == null ? '' : v;
}

function fillForm(p) {
  form.value = {
    name: p.name || '',
    description: p.description || '',
    series: p.series || '',
    sourceUrl: p.sourceUrl || '',
    sizeNote: p.sizeNote || '',
    color: p.color || '',
    doorPart: p.doorPart || '',
    doorVerified: p.doorVerified === true || Number(p.doorVerified) === 1,
  };
  declared.value = {
    w: declaredOf(p, 'w'),
    d: declaredOf(p, 'd'),
    h: declaredOf(p, 'h'),
  };
  sizeMode.value = (p.model && p.model.envelopeMode) || 'fit';
  thumbPath.value = (p.model && p.model.thumbFile) || '';
  thumbBroken.value = false;
}

function applyContent(r) {
  const draft = (r && (r.draft || r)) || {};
  content.value = {
    sellingPoints: Array.isArray(draft.sellingPoints) ? draft.sellingPoints.slice() : [],
    params: Array.isArray(draft.params)
      ? draft.params.map((p) => ({ key: '', value: '', unit: '', group: '', ...(p || {}) }))
      : [],
  };
  contentRev.value = Number(r && (r.rev ?? r.contentRev)) || 0;
  contentOriginal.value = contentSnapshot(content.value);
  // 声明尺寸在 content.model.declared 里回读；卡片本身不带 recipe_json，别让编辑页强制重填。
  const dm = r && r.model && r.model.declared;
  if (dm && ['w', 'd', 'h'].some((k) => Number(dm[k]) > 0)) {
    declared.value = {
      w: Number(dm.w) > 0 ? dm.w : '',
      d: Number(dm.d) > 0 ? dm.d : '',
      h: Number(dm.h) > 0 ? dm.h : '',
    };
  }
}

async function load() {
  phase.value = 'loading';
  trouble.value = '';
  contentTrouble.value = '';
  try {
    const r = await api.adminProducts();
    const p = ((r && r.products) || []).find((x) => String(x.id) === String(props.productId));
    if (!p) throw new Error('产品库列表里没有 #' + props.productId + ' 这款产品');
    card.value = p;
    fillForm(p);
  } catch (e) {
    phase.value = 'fail';
    trouble.value = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
    return;
  }
  try {
    const c = await api.adminProductContent(props.productId);
    applyContent(c);
  } catch (e) {
    // 还没有内容行是正常的（新入库的产品）；其它错误也必须说出来，但别把产品信息编辑整页拦死。
    if (e && (e.reason === 'not-found' || e.status === 404)) {
      contentTrouble.value = '这一款还没有内容编辑态（首次保存会创建）。';
    } else {
      contentTrouble.value = '内容读取失败（产品信息仍可编辑）：'
        + (e && e.message ? e.message : '未知原因');
    }
    content.value = { sellingPoints: [], params: [] };
    contentOriginal.value = contentSnapshot(content.value);
    contentRev.value = 0;
  }
  // 质量闸门是只读旁证：读失败不能拦住产品编辑，但必须说出来（人工代录没有模型行，404 是正常的）。
  try {
    quality.value = await api.adminProductQuality(props.productId);
    qualityTrouble.value = '';
  } catch (e) {
    quality.value = null;
    if (!(e && (e.status === 404 || e.reason === 'not-found'))) {
      qualityTrouble.value = '质量闸门读取失败（产品仍可编辑）：'
        + (e && e.message ? e.message : '未知原因');
    }
  }
  phase.value = 'ok';
}

function pathOf(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  return String(r.path || r.thumbFile || r.file || r.url || '');
}

async function uploadThumb(file) {
  if (!file) return;
  if (!/^image\//.test(String(file.type || ''))) {
    thumbError.value = '缩略图只收图片文件（PNG/JPEG/WebP）。';
    return;
  }
  thumbBusy.value = 'uploading';
  thumbError.value = '';
  try {
    const r = await api.adminUploadThumb(file);
    const path = pathOf(r);
    if (!path) throw new Error('上传接口没有返回可用的图片路径');
    thumbPath.value = path;
    thumbBroken.value = false;
  } catch (e) {
    thumbError.value = '缩略图上传失败：' + (e && e.message ? e.message : '未知原因');
  } finally {
    thumbBusy.value = '';
  }
}

async function onThumbFile(ev) {
  const f = ev && ev.target && ev.target.files ? ev.target.files[0] : null;
  if (ev && ev.target) ev.target.value = '';
  await uploadThumb(f);
}

/** 可选：用现有离屏渲染器从目录模型生成一张，再当普通图片上传 */
async function generateThumb() {
  const p = card.value && card.value.recipeId ? getProduct(card.value.recipeId) : null;
  if (!p) {
    thumbError.value = '目录里没有这一款的模型资产，无法从模型生成缩略图；请手选图片。';
    return;
  }
  thumbBusy.value = 'generating';
  thumbError.value = '';
  try {
    const dataUrl = await thumbFor(p);
    if (!dataUrl) throw new Error('离屏渲染没有返回图片（这个环境可能禁用了 WebGL）');
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'thumb.png', { type: 'image/png' });
    await uploadThumb(file);
  } catch (e) {
    thumbError.value = '从模型生成缩略图失败：' + (e && e.message ? e.message : '未知原因');
    thumbBusy.value = '';
  }
}

function numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 发布失败的原因可能是字符串，也可能是服务端统一形状 {code,message}；两种都照原文显示 */
function publishErrorText(v) {
  if (!v) return '服务端没有给出发布失败原因';
  if (typeof v === 'string') return v;
  const code = v.code ? String(v.code) + '：' : '';
  return code + (v.message || '服务端没有给出发布失败原因');
}

async function save() {
  if (busy.value) return;
  saveError.value = '';
  saveMessage.value = '';
  if (!form.value.name.trim()) {
    saveError.value = '产品名称不能为空。';
    return;
  }
  if (!numOrNull(declared.value.w) || !numOrNull(declared.value.d) || !numOrNull(declared.value.h)) {
    saveError.value = '声明尺寸需要宽/深/高三轴齐全，且都大于 0（单位 mm）；后端按这个口径校验。';
    return;
  }
  if (form.value.doorVerified && !form.value.doorPart) {
    saveError.value = '已勾选“门型已确认”，但门型还是未指定；请先选门型，或取消勾选。';
    return;
  }
  const body = {
    product: {
      name: form.value.name.trim(),
      description: form.value.description.trim(),
      series: form.value.series.trim(),
      sourceUrl: form.value.sourceUrl.trim(),
      sizeNote: form.value.sizeNote.trim(),
      color: form.value.color.trim(),
      doorPart: form.value.doorPart || null,
      doorVerified: form.value.doorVerified ? 1 : 0,
      doorSource: form.value.doorVerified ? 'admin' : undefined,
    },
    declared: {
      w: numOrNull(declared.value.w),
      d: numOrNull(declared.value.d),
      h: numOrNull(declared.value.h),
    },
    model: {
      thumbFile: thumbPath.value || '',
      envelopeMode: sizeMode.value,
      envelopeOk: sizeVerdict.value.envelopeOk,
      anisotropyOk: sizeVerdict.value.anisotropyOk,
    },
  };

  saving.value = 'product';
  try {
    await api.adminUpdateProduct(props.productId, body);
  } catch (e) {
    saveError.value = '产品信息保存失败：'
      + (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
    saving.value = '';
    return;
  }

  const payload = normalizedContent(content.value);
  const contentChanged = JSON.stringify(payload) !== contentOriginal.value;
  let contentSaved = false;

  if (contentChanged) {
    saving.value = 'content';
    try {
      const r = await api.adminSaveProductContent(props.productId, {
        ...payload,
        expectedRev: contentRev.value,
      });
      contentRev.value = Number(r && (r.rev ?? r.contentRev)) || contentRev.value;
      contentOriginal.value = JSON.stringify(payload);
      contentSaved = true;
    } catch (e) {
      saveError.value = '产品信息已保存，但内容保存失败（编辑内容还在）：'
        + (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
      saving.value = '';
      return;
    }
  }

  if (contentSaved || needsPublish.value) {
    saving.value = 'publish';
    try {
      const r = await api.adminPublishProductContent(props.productId, { expectedRev: contentRev.value });
      if (r && r.published === false) {
        needsPublish.value = true;
        saveError.value = '内容已保存，但发布没成功：'
          + publishErrorText(r.publishError);
        saving.value = '';
        return;
      }
      needsPublish.value = false;
    } catch (e) {
      needsPublish.value = true;
      saveError.value = '内容已保存，但发布失败（可再点保存重试）：'
        + (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
      saving.value = '';
      return;
    }
  }

  saving.value = '';
  saveMessage.value = contentSaved
    ? '已保存：产品信息与内容都已更新并发布。'
    : '已保存：产品信息已更新（内容没有变化，未重复发布）。';
}

onMounted(load);
</script>

<template>
  <div class="pe">
    <header class="pe__head">
      <div>
        <h1 class="pe__title">编辑产品模型</h1>
        <p class="pe__sub">
          <b>{{ card ? card.name : '产品 #' + productId }}</b>
          <span v-if="card" class="pe__mono">{{ card.modelNo }}</span>
          <span v-if="card" class="pe__tag">{{ statusText }}</span>
        </p>
      </div>
      <button class="adm__btn" type="button" data-product-edit-back @click="go('/admin')">← 回产品模型库</button>
    </header>

    <p v-if="phase === 'loading'" class="pl__msg">正在读取产品与内容…</p>
    <p v-else-if="phase === 'fail'" class="pl__msg pl__msg--bad">
      读不到这款产品：<span class="adm__mono">{{ trouble }}</span>
      <button class="adm__btn" type="button" @click="load">重试</button>
    </p>

    <form v-else class="pe__form" @submit.prevent="save">
      <p v-if="noMaintainText" class="wz__issues wz__issues--warn">{{ noMaintainText }}</p>
      <p v-if="contentTrouble" class="wz__issues wz__issues--warn">{{ contentTrouble }}</p>
      <p v-if="qualityTrouble" class="wz__issues wz__issues--warn">{{ qualityTrouble }}</p>
      <div v-if="quality && quality.gate && quality.gate.level !== 'ok'"
           class="wz__issues"
           :class="quality.gate.level === 'block' ? 'wz__issues--bad' : 'wz__issues--warn'"
           data-product-quality>
        <b>{{ quality.gate.level === 'block' ? '质量闸门：不能激活' : '质量提醒（不挡编辑/激活）' }}</b>
        <ul>
          <li v-for="issue in quality.gate.issues" :key="issue.code + issue.message">
            {{ issue.level === 'block' ? 'BLOCK' : 'WARN' }} · {{ issue.message }}
          </li>
        </ul>
      </div>

      <section class="pe__panel">
        <h2>产品信息</h2>
        <p class="wz__muted">型号是自然键，只读；改了会牵动目录 id、方案与供应商对账。</p>
        <div class="pe__grid">
          <label class="pe__f pe__f--wide">
            <span>产品名称 <i class="wz__req">必填</i></span>
            <input v-model="form.name" data-product-field="name" placeholder="产品名称">
          </label>
          <label class="pe__f">
            <span>产品型号（只读）</span>
            <input :value="card.modelNo" readonly class="pe__ro" data-product-field="modelNo">
            <em class="pe__hint">型号是自然键：目录种子、方案数据、供应商对账三处都靠它认人。</em>
          </label>
          <label class="pe__f">
            <span>系列</span>
            <input v-model="form.series" data-product-field="series" placeholder="选填">
          </label>
          <label class="pe__f pe__f--wide">
            <span>产品简介</span>
            <textarea v-model="form.description" rows="3" data-product-field="description" placeholder="一句话说清它是什么、给谁用"></textarea>
          </label>
          <label class="pe__f">
            <span>来源链接</span>
            <input v-model="form.sourceUrl" data-product-field="sourceUrl" placeholder="选填，便于溯源">
          </label>
          <label class="pe__f">
            <span>颜色</span>
            <input v-model="form.color" data-product-field="color" placeholder="如 #187fb0">
          </label>
          <label class="pe__f pe__f--wide">
            <span>尺寸备注</span>
            <input v-model="form.sizeNote" data-product-field="sizeNote" placeholder="如：官网图册估读，±20 mm">
          </label>
        </div>
      </section>

      <section class="pe__panel">
        <h2>声明尺寸 / 门型</h2>
        <p class="wz__muted">
          声明尺寸是<b>产品事实</b>，不能用实测 bbox 倒填；编辑保存要求宽/深/高三轴齐全且都大于 0（单位 mm）。
        </p>
        <div class="pe__grid">
          <label class="pe__f pe__f--wide">
            <span>声明尺寸（mm）</span>
            <span class="pe__dims">
              宽 <input v-model="declared.w" data-product-field="declaredW" type="number" min="1" step="any" placeholder="w">
              深 <input v-model="declared.d" data-product-field="declaredD" type="number" min="1" step="any" placeholder="d">
              高 <input v-model="declared.h" data-product-field="declaredH" type="number" min="1" step="any" placeholder="h">
            </span>
            <em class="pe__hint">卡片没有回传声明尺寸时这里留空；填了才会补上，不拿实测值冒充。</em>
          </label>
          <label class="pe__f">
            <span>尺寸口径</span>
            <select v-model="sizeMode" data-product-field="envelopeMode">
              <option value="1:1">1:1（逐轴对账，容差 1 mm）</option>
              <option value="fit">fit（只查量纲，缩放由前台兜底）</option>
            </select>
            <em class="pe__hint">声明尺寸一改，保存时会按这个口径重算结论；1:1 才是真正的尺寸对账。</em>
          </label>
          <label class="pe__f">
            <span>门型</span>
            <select v-model="form.doorPart" data-product-field="doorPart">
              <option value="">（未判断）</option>
              <option v-for="d in DOORS" :key="d.key" :value="d.key">{{ d.label }}（{{ d.key }}）</option>
            </select>
          </label>
          <label class="pe__f">
            <span>门型已确认</span>
            <span class="pe__check">
              <input v-model="form.doorVerified" data-product-field="doorVerified" type="checkbox">
              我核过了
            </span>
            <em class="pe__hint">未确认时规则 7 的开门净空体检结论不可信；确认后才写 door_verified。</em>
          </label>
        </div>

        <table class="wz__sum pe__facts">
          <tbody>
            <tr>
              <th>实测 bbox</th>
              <td class="pe__mono">
                {{ mm(model.bboxW) }} × {{ mm(model.bboxD) }} × {{ mm(model.bboxH) }} mm
                <span class="pe__hint">（{{ m3(model.bboxW) }} × {{ m3(model.bboxD) }} × {{ m3(model.bboxH) }}）</span>
              </td>
            </tr>
            <tr><th>当前状态</th><td>{{ statusText }}<span v-if="card.frontVisible === false" class="pe__hint"> · 前台不可见：{{ card.visibilityReason || '未通过可见性判据' }}</span></td></tr>
            <tr><th>尺寸结论（保存后）</th><td>mode {{ sizeMode }} · envelopeOk {{ sizeVerdict.envelopeOk == null ? '未判' : sizeVerdict.envelopeOk }} · anisotropyOk {{ sizeVerdict.anisotropyOk == null ? '未判' : sizeVerdict.anisotropyOk }}</td></tr>
            <tr><th>门型来源</th><td>{{ doorLabel(card.doorPart) }} · {{ card.doorSource || '未登记' }}</td></tr>
          </tbody>
        </table>
      </section>

      <section class="pe__panel">
        <h2>缩略图</h2>
        <div class="pe__thumb-row">
          <span class="pe__thumb" :style="{ '--c': form.color || '#9fb3c0' }">
            <img v-if="thumbPreview && !thumbBroken" :src="thumbPreview" :alt="form.name" @error="thumbBroken = true">
            <span v-else class="pe__thumb-ph">无缩略图</span>
          </span>
          <div class="pe__thumb-acts">
            <p v-if="!hasModel" class="pe__hint" data-product-thumb-nomodel>
              这是人工代录，没有模型行；缩略图字段在 product_model 上，补模型后才能上传。
            </p>
            <label class="adm__btn" :class="{ 'is-disabled': thumbBusy || canMaintain === false || !hasModel }">
              {{ thumbBusy === 'uploading' ? '上传中…' : '选择图片上传' }}
              <input class="pe__file" type="file" accept="image/png,image/jpeg,image/webp"
                data-product-thumb-upload :disabled="!!thumbBusy || canMaintain === false || !hasModel" @change="onThumbFile">
            </label>
            <button class="adm__btn" type="button" data-product-thumb-generate
              :disabled="!!thumbBusy || canMaintain === false || !hasModel" @click="generateThumb">
              {{ thumbBusy === 'generating' ? '生成中…' : '从模型生成' }}
            </button>
            <span class="pe__hint pe__mono">{{ thumbPath || '（当前没有缩略图路径）' }}</span>
            <span v-if="thumbError" class="pe__err">{{ thumbError }}</span>
          </div>
        </div>
      </section>

      <section class="pe__panel">
        <h2>卖点 / 参数</h2>
        <p class="wz__muted">与标注看板共用同一套字段与上限；产品信息保存后再发布内容快照。</p>
        <ProductContentFields :content="content" />
      </section>

      <section class="pe__panel">
        <h2>LOD 变体（只读）</h2>
        <p v-if="!variants.length" class="wz__muted">没有变体摘要。</p>
        <ul v-else class="pe__variants">
          <li v-for="v in variants" :key="v.variant">
            <b>{{ v.variant || 'default' }}</b>
            <span>{{ v.ready ? '就绪' : '未就绪' }}</span>
            <span class="pe__mono">{{ v.file || '无产物文件' }}</span>
            <span v-if="v.lodError" class="pe__err">{{ v.lodError }}</span>
          </li>
        </ul>
      </section>

      <p v-if="saveError" class="wz__issues wz__issues--bad" data-product-save-error>{{ saveError }}</p>
      <p v-if="saveMessage" class="wz__issues wz__issues--warn" data-product-save-ok>{{ saveMessage }}</p>

      <footer class="pe__foot">
        <button class="adm__btn adm__btn--primary" type="submit" data-product-edit-save
          :disabled="busy || canMaintain === false">
          {{ saving === 'product' ? '保存产品信息…' : (saving === 'content' ? '保存内容…' : (saving === 'publish' ? '发布中…' : '保存修改')) }}
        </button>
        <button class="adm__btn" type="button" @click="go('/admin')">回产品模型库</button>
        <span class="adm__spacer" />
        <span v-if="saveMessage" class="pe__ok">已保存</span>
      </footer>
    </form>
  </div>
</template>
