<script setup>
/**
 * ProductWizard —— 三步新增产品（R6-2 Step 3）
 *
 * 设计原文 `docs/32` §2.2。三条规矩在实现时最容易悄悄丢掉，所以写在最前面：
 *   ① **自动化是默认值，不是最终值** —— 每一个自动拾取值旁边都有「改」的入口
 *   ② **不给依据的自动值 = 让人选择不信** —— 每项都摊出 evidence 与置信度
 *   ③ **机器不敢猜就直说** —— 不用一个 0 置信度的值冒充答案（`picks.front.picked === null`）
 *
 * 计算全在 `wizard.js`（纯函数、有单测）；这里只负责把结论画出来、把人的修改收进来。
 * 分析全部在**浏览器里**做（`analyze.js`），后端不碰几何 —— 与前台同一个 loader。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { go } from '../router.js';
import { analyzeGlb } from './analyze.js';
import HotspotBoard from './HotspotBoard.vue';
import ProductContentFields from './ProductContentFields.vue';
import {
  STEPS, STEP_LABEL, validateBasic, modelNoTaken,
  pickRows, checkSummary, canSubmit, buildPayload,
  MODE, orderOf, canOpenHotspotBoard, variantPayload, manualPayload, nextVariantName, confirmRows,
  doorOptionsOf, contentOf, dimsOf, declaredFromMeasured, declaredMissing, declaredSourceOf,
} from './wizard.js';

/**
 * 三个入口共用这一个组件（B5/B6）：
 *   create  — 新增产品（R6-2 那条路，三步）
 *   variant — 给已有产品**加一份模型**（决策④：换模型 = 新增 variant，不覆盖）
 *   manual  — **人工代录**（决策⑨：供应商未按规范交）：没有模型文件，所以没有上传/分析那一步
 * 差别只在“走哪几步”与“提交哪个 payload”，两者都是 wizard.js 里的纯函数。
 */
const props = defineProps({
  mode: { type: String, default: MODE.CREATE },
  productId: { type: [Number, String], default: null },
  productLabel: { type: String, default: '' },
});

const mode = computed(() => props.mode || MODE.CREATE);
const isManual = computed(() => mode.value === MODE.MANUAL);
const isVariant = computed(() => mode.value === MODE.VARIANT);
/** 步骤集按模式算：不可达的步骤自然不渲染（模板里的 step 永远不等于那一步） */
const order = computed(() => orderOf(mode.value));

// ⚠️ 起手那一步要按**模式**的第一个步骤来，不能写死 BASIC：
//    加变体那条路里根本没有 BASIC（`orderOf('variant') = [model, confirm]`），
//    写死 BASIC 会让它以“上一步/下一步都不通”的样子停在产品表单上 ——
//    一个永远不会被走到的步骤，看起来就像是“按钮坏了”。
//    ← 真机探针抓到：加变体页停在 BASIC，页上找不到“加到哪款”与变体名输入框。
const step = ref(order.value[0]);
const form = ref({
  name: '', modelNo: '', description: '',
  series: '', sizeNote: '', sourceUrl: '',
  // 人工代录要的三样：来源（落库留痕）/ 声明尺寸 / 门型（产品事实，不从几何推）
  origin: '', w: null, d: null, h: null, declaredSource: 'manual', doorPart: '', doorVerified: false,
  // 产品内容：卖点/参数不在看板编辑，统一在第 1 步维护（ProductContentFields 直接改这两个数组）
  sellingPoints: [], params: [],
});
/** 变体名：默认给一个没被占用的建议（最终由服务端的唯一键裁决，重名回 409 并列出已有的） */
const variantName = ref('');

/**
 * 确认步要显示的那几行（纯函数在 `wizard.js` 里）。
 * 这里只做一件事：把当前表单、分析结果、人工改动**递**给它，并说明「谁优先」（`shownOf`）。
 */
const confRows = computed(() => confirmRows({
  mode: mode.value,
  form: form.value,
  analysis: analysis.value,
  edits: edits.value,
  sourcePath: up.value ? up.value.path : '',
  productId: props.productId,
  productLabel: props.productLabel,
  variantName: variantName.value,
  doorLabel: DOOR_LABEL[shownOf('doorPart',
    analysis.value && analysis.value.picks ? analysis.value.picks.door.doorPart : null)] || '（未判断）',
  shown: shownOf,
}));
/** 来源词表：**由服务端下发**（界面不抄一张对照表） */
const origins = ref([]);
/** 现有产品：只用来做**型号撞号**的前置检查（不想等后端 400 才知道） */
const products = ref([]);
const listTrouble = ref('');

const file = ref(null);        // 人选的那个文件
const up = ref(null);          // 上传结果：{ path, sha, bytes, existedBefore }
const analysis = ref(null);    // analyzeGlb 的结果
const edits = ref({});         // 人工改过的值（key -> 值）
const busy = ref('');          // '' | 'uploading' | 'analyzing' | 'submitting'
const trouble = ref('');
const done = ref(null);        // 提交成功后的后端回执
/** 产品信息保存状态：dbId 已拿到但 /content 失败时不能假装成功 */
const contentSaved = ref(false);
const thumbPreview = ref('');  // 缩略图预览（分析器 dataUrl 或手选图片）
const thumbTrouble = ref('');
const thumbBusy = ref(false);
/** 第 2 步勾选/确认的门节点；写入 model.hingeNodesJson，不选也可入库 */
const selectedDoors = ref([]);

const basic = computed(() => validateBasic(form.value));
const dup = computed(() => modelNoTaken(products.value, form.value.modelNo));
const rows = computed(() => pickRows(analysis.value));
const checks = computed(() => checkSummary(analysis.value && analysis.value.checks));
const gate = computed(() => canSubmit(analysis.value));
/** 分析器找到的门节点；默认全选，允许人工取消 */
const doorChoices = computed(() => doorOptionsOf(analysis.value));
const allDoorsSelected = computed(() => doorChoices.value.length > 0
  && selectedDoors.value.length === doorChoices.value.length);
const stepIndex = computed(() => order.value.indexOf(step.value));
const measured = computed(() => measuredDims());
const declaredText = computed(() => {
  const f = form.value;
  const one = (v) => (Number(v) > 0 ? Number(v) + ' mm' : '未填');
  return one(f.w) + ' × ' + one(f.d) + ' × ' + one(f.h);
});
/** 声明三轴缺项：这是**提交前的硬闸门**，不是提示；实测 bbox 不会自动补进来。 */
const missingDeclared = computed(() => declaredMissing(form.value));
const declaredComplete = computed(() => missingDeclared.value.length === 0);
const sizeNoteMissing = computed(() => !String(form.value.sizeNote || '').trim());
const declaredSourceText = computed(() => (declaredSourceOf(form.value) === 'measured'
  ? '来源：用实测尺寸作声明（已人工确认）' : '来源：人工填写'));

/** 手改任一轴 → 来源回到“人工填写”；按钮填三轴才标 measured。 */
function onDeclaredInput() {
  form.value.declaredSource = 'manual';
}
/** 第 1 步能不能走：必填齐 + 型号不撞 */
const basicOk = computed(() => basic.value.ok && !dup.value);

const LEVEL_LABEL = { bad: '拦下', warn: '提醒', ok: '通过' };
/** door_part 的界面标签。**只有一份口径**，与内核的标签表同字（doors.js / Doors.java） */
const DOOR_LABEL = { single: '柜门', double: '双门', top: '上盖', drawer: '抽屉', none: '无门' };

onMounted(loadProducts);

/** 取一次现有产品做撞号对照。**取不到要说话**，不能沉默地当作"没有撞号" */
async function loadProducts() {
  listTrouble.value = '';
  try {
    const r = await api.adminProducts();
    products.value = (r && r.products) || [];
    origins.value = (r && r.origins) || [];   // 词表由服务端下发
    if (!form.value.origin) {
      // 默认值只是**界面上的起点**（两个入口不同），落库以提交的内容为准
      form.value.origin = isManual.value ? '人工代录' : '用户原始模型';
    }
    if (isVariant.value && !variantName.value) {
      const p = products.value.find((x) => String(x.id) === String(props.productId));
      variantName.value = nextVariantName(p ? (p.variants || []).map((v) => v.variant) : []);
    }
  } catch (e) {
    listTrouble.value = '取不到现有产品列表（撞号检查暂时做不了）：' + (e && e.message ? e.message : '未知原因');
  }
}

function goto(s) {
  if (order.value.indexOf(s) > stepIndex.value) return;   // 只许往回走，往前走要过校验
  step.value = s;
}
function next() {
  if (step.value === STEPS.BASIC && !basicOk.value) return;
  if (step.value === STEPS.MODEL && !gate.value.ok) return;
  const i = stepIndex.value;
  if (i < order.value.length - 1) step.value = order.value[i + 1];
}
function back() {
  const i = stepIndex.value;
  // 必须按**当前模式**的步骤集回退：variant 的 order 是 [model, confirm]，
  // 用全局 ORDER（basic/model/confirm）会把变体页退到一个根本不存在的 basic。
  if (i > 0) step.value = order.value[i - 1];
}

/** 当前模式下的第几步 + 名称（variant 的 model 是第 1 步，不是全局第 2 步） */
function stepLabel(s) {
  const n = order.value.indexOf(s) + 1;
  if (s === STEPS.CONFIRM) return '第 ' + n + ' 步 · ' + (isManual.value ? '确认代录' : '确认入库');
  return '第 ' + n + ' 步 · ' + (STEP_LABEL[s] || s);
}

/** 门节点全选/全不选；[] 是合法选择（后端写 []，不伪造门） */
function toggleAllDoors(on) {
  selectedDoors.value = on ? doorChoices.value.map((d) => d.node) : [];
}
/** 看板底栏“上一步”回第 2 步；此时产品已入库，CTA 会变成“回到标注看板”，不会二次入库 */
function backFromBoard() {
  step.value = STEPS.MODEL;
}

/** 人工改一个自动值。**改了要留痕**：界面会把「自动拾取」改成「已改为」，不假装还是自动的 */
function edit(key, v) {
  edits.value = { ...edits.value, [key]: v };
}
function resetEdit(key) {
  const next = { ...edits.value };
  delete next[key];
  edits.value = next;
}
function isEdited(key) {
  return Object.prototype.hasOwnProperty.call(edits.value, key);
}
/** 当前显示的值：改过用人工值，没改用自动值 */
function shownOf(key, autoValue) {
  return isEdited(key) ? edits.value[key] : autoValue;
}

function fmtBytes(n) {
  const b = Number(n) || 0;
  return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
}

/**
 * 选好文件后的两步：**先上传**（拿 `sourceFilePath`），**再本地分析**（拿自动拾取值）。
 * 顺序是有意的：上传失败就没有路径，后面 LOD 无从谈起，所以先让它失败在前头。
 */
async function onFile(f) {
  if (!f) return;
  const name = String(f.name || '');
  if (!/\.glb$/i.test(name)) {
    trouble.value = '只收 .glb（收到的是 ' + (name || '无名文件') + '）';
    return;
  }
  file.value = f;
  up.value = null;
  analysis.value = null;
  done.value = null;
  contentSaved.value = false;
  thumbTrouble.value = '';
  thumbPreview.value = '';
  // 换文件后上一份缩略图不再代表当前模型；重新分析时自动重传。
  const noThumb = { ...edits.value };
  delete noThumb.thumbFile;
  edits.value = noThumb;
  trouble.value = '';

  busy.value = 'uploading';
  try {
    up.value = await api.adminUploadGlb(f);
  } catch (e) {
    busy.value = '';
    trouble.value = '上传失败：' + (e && e.message ? e.message : '未知原因');
    return;
  }

  busy.value = 'analyzing';
  try {
    const buf = await f.arrayBuffer();
    // 第 1 步填的声明尺寸是判 1:1 / fit 的唯一依据；没填就明确不传（分析器会报"没有声明"）。
    const declared = dimsOf(form.value, null);
    const hasDeclared = declared.w != null || declared.d != null || declared.h != null;
    analysis.value = await analyzeGlb(buf, { fileName: name, declared: hasDeclared ? declared : null });
    // 第 1 步没选门型时，用分析器拾到的值回填（只填显示值；「已确认」仍由人勾）。
    if (!form.value.doorPart && analysis.value && analysis.value.picks && analysis.value.picks.door) {
      form.value.doorPart = analysis.value.picks.door.doorPart || '';
    }
    // 默认全选分析器找到的门节点；人可以在下面的表里取消（[] 也是合法选择）。
    selectedDoors.value = doorChoices.value.map((d) => d.node);
    await uploadAnalysisThumb();
  } catch (e) {
    trouble.value = '分析失败：' + (e && e.message ? e.message : '未知原因');
  } finally {
    busy.value = '';
  }
}

/* ── 缩略图：分析器渲出的 PNG 自动上传；手选图片覆盖 ─────────────── */

function dataUrlToFile(dataUrl, name) {
  const raw = String(dataUrl || '');
  const comma = raw.indexOf(',');
  if (comma < 0) throw new Error('缩略图不是 data URL');
  const meta = raw.slice(0, comma);
  const mime = (meta.match(/^data:([^;]+)/) || [])[1] || 'image/png';
  const bin = atob(raw.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'thumb.png', { type: mime });
}

/** 分析完成后的默认动作：把 analysis.picks.thumb.dataUrl 落成服务端缩略图。失败只提醒，不拦入库。 */
async function uploadAnalysisThumb() {
  const dataUrl = analysis.value && analysis.value.picks && analysis.value.picks.thumb
    && analysis.value.picks.thumb.dataUrl;
  thumbTrouble.value = '';
  if (!dataUrl) {
    thumbTrouble.value = '分析器没有渲出缩略图；可手选一张图片补上。';
    return;
  }
  thumbPreview.value = dataUrl;
  thumbBusy.value = true;
  try {
    const r = await api.adminUploadThumb(dataUrlToFile(dataUrl, 'thumb.png'));
    if (r && r.path) edit('thumbFile', r.path);
    else thumbTrouble.value = '缩略图上传没有返回路径；可重试或手选一张图片。';
  } catch (e) {
    thumbTrouble.value = '缩略图自动上传失败：' + (e && e.message ? e.message : '未知原因') + '；可手选一张图片覆盖。';
  } finally {
    thumbBusy.value = false;
  }
}

/** 手选图片覆盖自动缩略图：先本地预览，再上传并写进 edits.thumbFile。 */
async function onThumbFile(f) {
  if (!f) return;
  if (!/^image\//.test(String(f.type || ''))) {
    thumbTrouble.value = '缩略图必须是图片文件（收到 ' + (f.name || '无名文件') + '）';
    return;
  }
  thumbTrouble.value = '';
  const reader = new FileReader();
  reader.onload = () => { thumbPreview.value = String(reader.result || ''); };
  reader.readAsDataURL(f);
  thumbBusy.value = true;
  try {
    const r = await api.adminUploadThumb(f);
    if (r && r.path) edit('thumbFile', r.path);
    else thumbTrouble.value = '缩略图上传没有返回路径，请重试。';
  } catch (e) {
    thumbTrouble.value = '缩略图上传失败：' + (e && e.message ? e.message : '未知原因');
  } finally {
    thumbBusy.value = false;
  }
}

/** 实测尺寸（分析器 mm）——用于「用实测尺寸作为声明」与对照展示。 */
function measuredDims() {
  const a = analysis.value;
  if (!a) return null;
  const mm = a.mm || {};
  const p = (a.picks && a.picks.size) || {};
  const w = Number(mm.w) || Number(p.w);
  const d = Number(mm.d) || Number(p.d);
  const h = Number(mm.h) || Number(p.h);
  if (!(w > 0 && d > 0 && h > 0)) return null;
  return { w, d, h };
}

/** 人工确认动作：把实测值写进声明尺寸，并把尺寸口径定为 1:1（不静默替用户决定）。 */
function useMeasuredAsDeclared() {
  const m = measuredDims();
  if (!m) {
    trouble.value = '还没有实测尺寸可用；先完成模型分析。';
    return;
  }
  Object.assign(form.value, declaredFromMeasured(form.value, m));
  edit('envelopeMode', '1:1');
}

/**
 * 产品入库**之后**再保存卖点/参数。
 * 失败不能吞：产品已经拿到 dbId，此时唯一诚实的说法是「已入库、内容没保存」，
 * 并且保留 done，让用户重试内容而不是再建一条重复产品。
 */
async function saveContentForNew() {
  const dbId = done.value && done.value.dbId;
  if (dbId == null || dbId === '') return false;
  try {
    await api.adminSaveProductContent(dbId, { ...contentOf(form.value), expectedRev: 0 });
    contentSaved.value = true;
    return true;
  } catch (e) {
    contentSaved.value = false;
    const msg = e && e.message ? e.message : '未知原因';
    trouble.value = '产品已入库但产品信息保存失败，可重试（产品 #' + dbId + '）：' + msg;
    return false;
  }
}

async function submit() {
  // 声明尺寸/尺寸备注是落库硬要求：先在当前页指出缺哪几个字段，再阻止提交。
  // 不在这里退回实测值 —— 实测只是校准，不能冒充声明。
  trouble.value = '';
  if (!isVariant.value && !declaredComplete.value) {
    trouble.value = '声明尺寸未填完整：还缺 ' + missingDeclared.value.map((x) => x.label).join('、')
      + '（单位 mm）。实测 bbox 只能校准，不能自动成为声明；请手填或点“用实测尺寸作为声明”。';
    step.value = STEPS.BASIC;
    return;
  }
  if (!isVariant.value && sizeNoteMissing.value) {
    trouble.value = '尺寸备注必填：请说明这些声明尺寸的来源（如官网规格书 / 卷尺实测 / 图册估读）。';
    step.value = STEPS.BASIC;
    return;
  }
  busy.value = 'submitting';
  try {
    if (isManual.value) {
      // 人工代录：有产品、**没有 model**（服务端按代录那一套更严的判据校验）。
      // 若产品已创建、只是内容保存失败，重按不能再次创建（会撞型号/重复入库）。
      if (!done.value) {
        done.value = await api.adminCreateProduct(manualPayload(form.value));
        contentSaved.value = false;
      }
      if (done.value && done.value.dbId != null && !contentSaved.value) {
        await saveContentForNew();
      }
      return;
    }
    if (!up.value || !analysis.value) return;
    const payload = buildPayload(form.value, analysis.value, {
      ...edits.value,
      sourceFilePath: up.value.path,
      doorNodes: selectedDoors.value,
    });
    done.value = isVariant.value
      // 加变体：接口只收 model，**产品行一个字段都不改**；也不保存内容（内容属于已有产品）。
      ? await api.adminAddVariant(props.productId, variantPayload(payload.model, variantName.value))
      : await api.adminCreateProduct(payload);
  } catch (e) {
    // 原话说出来：重名（409）/ 产品不存在（404）/ 缺字段（400）都是**服务端判的**，
    // 界面不许替它翻译成“失败了” —— 那些话正是用户接下来要照做的事。
    const head = e && e.reason === 'conflict' ? '名字撞了：'
      : (e && e.reason === 'forbidden' ? '这个角色不能做：' : '入库失败：');
    trouble.value = head + (e && e.message ? e.message : '未知原因');
  } finally {
    busy.value = '';
  }
}

/**
 * 新增产品的主 CTA：**确认入库并进入标注**（不是先入库再让人去点一个可选入口）。
 * 成功回执后的第 3 步直接挂 HotspotBoard；variant / manual 不会走这里。
 */
async function submitAndAnnotate() {
  // 已经在库、只是内容没保存时，重按只重试内容保存，绝不重复创建产品。
  if (!canOpenHotspotBoard(mode.value, done.value)) {
    await submit();
  }
  if (!canOpenHotspotBoard(mode.value, done.value)) return;
  // 产品入库与内容保存是两件事：内容失败必须停在第 2 步，不能假装已经可以标注。
  if (!contentSaved.value) {
    const ok = await saveContentForNew();
    if (!ok) {
      step.value = STEPS.MODEL;
      return;
    }
  }
  step.value = STEPS.HOTSPOTS;
}

/** 提交成功后回到列表（列表会重新取，新草稿就在里面） */
function finish() {
  // 跳转只走 `go()`（routes.js 装配时接上 vue-router）：自己改地址栏会出现"地址变了界面没换"
  go('/admin');
}
</script>

<template>
  <div class="wz">
    <!-- 步骤条：只许往回走（往前走要过校验），所以用 disabled 而不是藏起来 -->
    <nav class="wz__steps">
      <button
        v-for="(s, i) in order"
        :key="s"
        class="wz__step"
        :class="{ 'is-on': step === s, 'is-done': i < stepIndex }"
        :aria-current="step === s ? 'step' : undefined"
        :disabled="i > stepIndex"
        @click="goto(s)"
      >{{ stepLabel(s) }}</button>
    </nav>

    <!-- ── 第 3 步 · 可视化标注（入库成功后才出现；不是可选第 4 步）──── -->
    <section v-if="step === STEPS.HOTSPOTS && done" class="wz__panel wz__panel--board">
      <p class="wz__board-kicker">第 3 步 · 可视化标注 <span>保存即一次自动发布 · 0 热点也能保存</span></p>
      <HotspotBoard
        :product-id="done.dbId"
        :product-name="form.name"
        :source-path="up ? up.path : ''"
        :analysis="analysis"
        embedded
        @back="backFromBoard"
        @exit="finish"
      />
    </section>

    <!-- ── 第 1 步 · 维护基础信息 ───────────────────────────── -->
    <section v-if="step === STEPS.BASIC" class="wz__panel">
      <h2>{{ isVariant ? '确认加变体' : (isManual ? '确认代录' : '维护基础信息') }}</h2>
      <p class="wz__muted">
        名称、型号、简介、尺寸备注与声明三轴必填。型号是<b>自然键</b> —— 目录种子、方案数据、供应商对账三处都靠它认人，
        所以入库后就不该再改。产品信息（含卖点/参数）都在这一步维护，标注看板只管热点。
      </p>
      <div class="wz__grid">
        <label class="wz__f">
          <span>产品名称 <i class="wz__req">必填</i></span>
          <input v-model="form.name" placeholder="如：深冷柜 DEMO-FZ-040">
        </label>
        <label class="wz__f">
          <span>产品型号 <i class="wz__req">必填</i></span>
          <input v-model="form.modelNo" placeholder="如：DEMO-FZ-040" @blur="loadProducts">
        </label>
        <label class="wz__f wz__f--wide">
          <span>产品简介 <i class="wz__req">必填</i></span>
          <textarea v-model="form.description" rows="3" placeholder="一句话说清它是什么、给谁用"></textarea>
        </label>
        <label class="wz__f"><span>系列</span><input v-model="form.series"></label>
        <label class="wz__f"><span>来源链接</span><input v-model="form.sourceUrl" placeholder="选填，便于溯源"></label>
        <label class="wz__f wz__f--wide">
          <span>尺寸备注 <i class="wz__req">必填</i></span>
          <input v-model="form.sizeNote" data-wz-size-note placeholder="如：官网规格书 / 卷尺实测 / 图册估读 ±20 mm">
          <em v-if="sizeNoteMissing" class="wz__field-error" data-wz-size-note-missing>
            必填：声明尺寸的来源必须说清（这是落库字段，不是备注装饰）。
          </em>
        </label>

        <!-- 声明尺寸：必填；实测 bbox 只做校准，不能自动成为声明。 -->
        <label class="wz__f" style="grid-column: 1 / -1" data-wz-declared-card>
          <span>声明尺寸（mm，占地权威）<i class="wz__req">必填</i></span>
          <span>
            宽 <input v-model="form.w" type="number" min="1" step="any" style="width:6em" data-wz-declared-w @input="onDeclaredInput">
            深 <input v-model="form.d" type="number" min="1" step="any" style="width:6em" data-wz-declared-d @input="onDeclaredInput">
            高 <input v-model="form.h" type="number" min="1" step="any" style="width:6em" data-wz-declared-h @input="onDeclaredInput">
          </span>
          <em class="wz__muted">
            声明尺寸是占地权威，必须人工填写或明确点“用实测尺寸作为声明”；实测 bbox 不会自动填进来。
          </em>
          <em class="wz__muted" data-wz-declared-source>{{ declaredSourceText }}</em>
          <div v-if="!declaredComplete" class="wz__issues wz__issues--bad" data-wz-declared-missing>
            还缺声明尺寸：{{ missingDeclared.map((x) => x.label).join('、') }}。不能拿实测 bbox 自动代替。
          </div>
        </label>
        <label class="wz__f">
          <span>门型</span>
          <select v-model="form.doorPart" data-wz-door-part>
            <option value="">（未判断）</option>
            <option value="single">柜门</option>
            <option value="double">双门</option>
            <option value="top">上盖</option>
            <option value="drawer">抽屉</option>
            <option value="none">无门</option>
          </select>
          <em class="wz__muted">门型是<b>产品事实</b>；没确认就不算开门净空体检（规则7）</em>
        </label>
        <label class="wz__f">
          <span>门型已确认</span>
          <span><input v-model="form.doorVerified" type="checkbox" data-wz-door-verified> 我核过了</span>
          <em class="wz__muted">写进库里的 door_verified 列</em>
        </label>

        <!-- 人工代录专属（B6）：来源必须落库留痕 -->
        <label v-if="isManual" class="wz__f">
          <span>来源</span>
          <select v-model="form.origin">
            <option v-for="o in origins" :key="o" :value="o">{{ o }}</option>
          </select>
          <em class="wz__muted">
            只有「用户原始模型」是供应商按规范交的；选「人工代录」时<b>没有模型文件</b>，
            列表上会出现「无模型」角标 —— 那是事实，不是毛病。
          </em>
        </label>
      </div>

      <!-- 卖点/参数属于产品信息：第 1 步维护，看板不再出现这块。 -->
      <ProductContentFields :content="form" data-wz-content />

      <!-- 一次报出全部缺失，不是只报第一个 -->
      <div v-if="!basic.ok" class="wz__issues wz__issues--bad">
        <b>还缺 {{ basic.missing.length }} 项必填</b>
        <ul><li v-for="m in basic.missing" :key="m.key">{{ m.label }} —— 落库位置：{{ m.why }}</li></ul>
      </div>
      <div v-if="dup" class="wz__issues wz__issues--bad">
        <b>型号已被占用</b>
        <div>{{ form.modelNo }} 已经在产品列表里了。型号是自然键不能重复 —— 换一个，或去列表里改那一条。</div>
      </div>
      <div v-if="listTrouble" class="wz__issues wz__issues--warn">{{ listTrouble }}</div>
    </section>

    <!-- ── 第 2 步 · 模型结构识取（含确认摘要）────────────────── -->
    <section v-else-if="step === STEPS.MODEL" class="wz__panel">
      <h2>模型结构识取</h2>
      <p class="wz__muted">
        拖入 .glb。分析<b>全部在浏览器里</b>做（与前台同一个 loader，后端不碰几何）——
        下面每一项都是<b>默认值而不是最终值</b>，都能改。
      </p>
      <p class="wz__muted">
        <b>只传 1 个源 GLB</b>：LOD0 / LOD1 / LOD2 由后端异步生成，不需要上传三个文件。
      </p>

      <div
        class="wz__drop"
        :class="{ 'is-busy': !!busy }"
        @dragover.prevent
        @drop.prevent="onFile($event.dataTransfer.files && $event.dataTransfer.files[0])"
      >
        <input type="file" accept=".glb" @change="onFile($event.target.files && $event.target.files[0])">
        <div v-if="!file" class="wz__drop-hint">把 .glb 拖到这里，或点此选择文件</div>
        <div v-else class="wz__drop-file">
          <b>{{ file.name }}</b>
          <span class="wz__muted">{{ fmtBytes(file.size) }}</span>
          <span v-if="busy === 'uploading'" class="wz__tag wz__tag--run">上传中…</span>
          <span v-else-if="busy === 'analyzing'" class="wz__tag wz__tag--run">分析中…</span>
          <span v-else-if="up" class="wz__tag wz__tag--ok">已上传</span>
        </div>
      </div>

      <p v-if="up" class="wz__muted wz__mono">
        落盘 {{ up.path }} ｜ {{ up.existedBefore ? '命中已有的一份（内容寻址，没写第二遍）' : '新写了一份' }} ｜ sha256 {{ (up.sha || '').slice(0, 12) }}…
      </p>

      <!-- 验收-3：模型结构 / 门节点确认。这里只确认“哪几个门节点要写进 hinge_nodes”，
           真正的锚点/热点引导在 task-79 的看板里，不在这里做。 -->
      <div v-if="analysis" class="wz__checks">
        <!-- 缩略图：分析完成自动上传；手选图片可覆盖。 -->
        <div class="wz__thumb" data-wz-thumb>
          <div class="wz__thumb-img">
            <img v-if="thumbPreview" :src="thumbPreview" alt="产品缩略图预览">
            <span v-else class="wz__muted">没有缩略图预览</span>
          </div>
          <div class="wz__thumb-meta">
            <b>产品缩略图</b>
            <p class="wz__muted">
              <span v-if="thumbBusy">上传中…</span>
              <span v-else-if="edits.thumbFile" class="wz__tag wz__tag--ok">已上传</span>
              <span v-else>未上传</span>
            </p>
            <label class="wz__muted">
              手选图片覆盖
              <input type="file" accept="image/*" :disabled="thumbBusy"
                data-wz-thumb-input @change="onThumbFile($event.target.files && $event.target.files[0])">
            </label>
            <p v-if="edits.thumbFile" class="wz__muted wz__mono">{{ edits.thumbFile }}</p>
            <p v-if="thumbTrouble" class="wz__issues wz__issues--warn" data-wz-thumb-trouble>{{ thumbTrouble }}</p>
          </div>
        </div>

        <!-- 尺寸对照：实测 vs 当前声明。按钮是人工确认动作，不静默覆盖声明。 -->
        <div class="wz__dims" data-wz-dims>
          <div>
            <b>实测 bbox（mm，仅校准）</b>
            <p class="wz__mono" data-wz-measured>
              {{ measured ? (measured.w + ' × ' + measured.d + ' × ' + measured.h) : '未测出' }}
            </p>
            <em class="wz__muted">只用于校准/对账，不是声明。</em>
          </div>
          <div>
            <b>声明尺寸（mm，占地权威）</b>
            <p class="wz__mono" data-wz-declared>{{ declaredText }}</p>
            <em class="wz__muted" data-wz-declared-source-model>{{ declaredSourceText }}</em>
          </div>
          <button class="adm__btn adm__btn--tiny" type="button" :disabled="!measured"
            data-wz-use-measured @click="useMeasuredAsDeclared">用实测尺寸作为声明</button>
          <span class="wz__muted">点按钮＝人工确认把三轴实测值一次性写成声明，并把尺寸口径定为 1:1。</span>
          <div v-if="!isVariant && !declaredComplete" class="wz__issues wz__issues--bad" data-wz-declared-missing-model>
            声明尺寸未填完整：还缺 {{ missingDeclared.map((x) => x.label).join('、') }}。
          </div>
        </div>

        <label class="wz__check" data-wz-door-confirm :class="{ 'is-disabled': !form.doorPart }">
          <input v-model="form.doorVerified" type="checkbox" :disabled="!form.doorPart"
            data-wz-step2-door-verified>
          门型已确认：{{ DOOR_LABEL[form.doorPart] || '（未判断）' }}
          <span v-if="!form.doorPart" class="wz__muted">没有门型时不能勾“已确认”，否则会写出一条没有依据的结论。</span>
        </label>

        <h3>模型结构摘要
          <span class="wz__muted">
            {{ analysis.mm ? analysis.mm.w + ' × ' + analysis.mm.d + ' × ' + analysis.mm.h + ' mm' : '尺寸未测' }}
            · {{ analysis.triangles || 0 }} 三角面
            · {{ analysis.textures || 0 }} 贴图
            · 门节点 {{ doorChoices.length }} 个
          </span>
        </h3>
        <p class="wz__muted">
          分析器找到 {{ analysis.doors && analysis.doors.found ? analysis.doors.found.length : 0 }} 个约定/常见门节点。
          勾选要交给后端做开合动画的节点；<b>可以不选</b>，不选就写入空数组（产品仍可入库）。
          这里只确认门节点，不改模型几何。
        </p>
        <table v-if="doorChoices.length" class="wz__picks">
          <thead>
            <tr>
              <th><label><input type="checkbox" :checked="allDoorsSelected" @change="toggleAllDoors($event.target.checked)"> 选</label></th>
              <th>节点</th><th>轴</th><th>开角</th><th>来源 / 方位</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in doorChoices" :key="d.node">
              <td><input v-model="selectedDoors" type="checkbox" :value="d.node" :aria-label="'确认门节点 ' + d.node"></td>
              <td class="wz__mono">{{ d.node }}</td>
              <td>{{ d.axis }}</td>
              <td>
                {{ d.openAngleDeg }}°
                <span v-if="!d.angleFromModel" class="wz__muted">（默认；模型未标 extras）</span>
              </td>
              <td>
                {{ d.part || '门' }} · {{ d.specCompliant ? '约定名' : '常见变体名' }}
                <span v-if="d.side" class="wz__muted"> · {{ d.side }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="wz__muted">没有识别到约定门节点；可以不选，直接确认入库。</p>
        <p v-if="analysis.doors && analysis.doors.loose && analysis.doors.loose.length" class="wz__muted">
          名字里带 door/lid/drawer 但未归入约定门型的节点：{{ analysis.doors.loose.join(' / ') }}。
          这些只作事实汇报，不自动写入门节点。
        </p>
        <p v-if="analysis.doors && analysis.doors.missing && analysis.doors.missing.length" class="wz__muted">
          分析器未找到的约定名：{{ analysis.doors.missing.join(' / ') }} —— 不拦入库，门型可在上面人工改。
        </p>
      </div>

      <!-- 确认表：每个自动值都必须能被问出「为什么」 -->
      <table v-if="analysis" class="wz__picks">
        <thead>
          <tr><th>项</th><th>值（可改）</th><th>来源</th><th>置信度</th><th>依据</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.key">
            <th>{{ r.label }}</th>
            <td>
              <template v-if="r.key === 'size'">
                <input class="wz__num" type="number" :value="shownOf('bboxW', analysis.picks.size.w)" @input="edit('bboxW', Number($event.target.value))">
                <input class="wz__num" type="number" :value="shownOf('bboxD', analysis.picks.size.d)" @input="edit('bboxD', Number($event.target.value))">
                <input class="wz__num" type="number" :value="shownOf('bboxH', analysis.picks.size.h)" @input="edit('bboxH', Number($event.target.value))">
                <span class="wz__muted">毫米，顺序＝宽/深/高</span>
              </template>
              <template v-else-if="r.key === 'door'">
                <span>{{ DOOR_LABEL[form.doorPart] || DOOR_LABEL[analysis.picks.door.doorPart] || '（未判断）' }}</span>
                <span class="wz__muted">第 1 步选的产品事实；这里只做确认，不改写</span>
              </template>
              <template v-else-if="r.key === 'envelope'">
                <select :value="shownOf('envelopeMode', analysis.picks.envelope.mode)" @change="edit('envelopeMode', $event.target.value || null)">
                  <option value="">（未判）</option>
                  <option value="1:1">1:1（按真实尺寸建模）</option>
                  <option value="fit">fit（按外观重建，尺寸不等）</option>
                </select>
              </template>
              <template v-else-if="r.key === 'thumb' || r.key === 'topView'">
                <img v-if="analysis.picks[r.key].dataUrl" class="wz__img" :src="analysis.picks[r.key].dataUrl" :alt="r.label">
                <span v-else class="wz__muted">没渲出来</span>
              </template>
              <template v-else>
                <span class="wz__mono">{{ analysis.picks.front.picked || '—' }}</span>
                <span class="wz__muted">（门朝向房间的哪一侧）</span>
              </template>
            </td>
            <td>
              <span v-if="isEdited(r.key)" class="wz__tag wz__tag--human">已改为人工值</span>
              <span v-else-if="r.auto" class="wz__tag wz__tag--auto">自动拾取</span>
              <span v-else class="wz__tag wz__tag--none">未自动</span>
              <button v-if="isEdited(r.key)" class="wz__mini" @click="resetEdit(r.key)">还原</button>
            </td>
            <td class="wz__conf">{{ Math.round(r.confidence01 * 100) }}%</td>
            <td class="wz__ev">
              {{ r.evidence }}
              <div v-if="r.note" class="wz__note">{{ r.note }}</div>
            </td>
          </tr>
        </tbody>
      </table>

      <!-- 体检：bad 拦人，warn 只提醒 -->
      <div v-if="checks.total" class="wz__checks">
        <h3>入库体检 <span class="wz__muted">{{ checks.bad.length }} 拦下 · {{ checks.warn.length }} 提醒 · {{ checks.ok.length }} 通过</span></h3>
        <ul>
          <li v-for="c in [...checks.bad, ...checks.warn, ...checks.ok]" :key="c.key" :class="'is-' + c.level">
            <span class="wz__lv">{{ LEVEL_LABEL[c.level] }}</span>
            <b>{{ c.text }}</b>
            <div class="wz__ev">{{ c.why }}</div>
          </li>
        </ul>
      </div>

      <div v-if="!gate.ok" class="wz__issues wz__issues--bad">
        <b>有 {{ gate.blockers.length }} 项体检没通过，先别入库</b>
        <ul><li v-for="(b, i) in gate.blockers" :key="i">{{ b }}</li></ul>
      </div>

      <!-- 验收-3：确认摘要不再单独占第 3 步，内嵌在模型页底部。
           主 CTA 在底栏：确认入库并进入标注（submit 成功直接切 step 3）。 -->
      <div v-if="analysis && !isVariant" class="wz__checks">
        <h3>确认摘要 <span class="wz__muted">入库前最后核对；确认后直接进入可视化标注</span></h3>
        <table class="wz__sum">
          <tbody>
            <tr v-for="(r, i) in confRows" :key="'cd' + i">
              <th>{{ r.label }}</th>
              <td :class="{ 'wz__mono': r.mono, 'wz__muted': r.muted }">{{ r.value }}</td>
            </tr>
            <tr>
              <th>门节点（hinge_nodes）</th>
              <td class="wz__mono">
                {{ selectedDoors.length ? selectedDoors.join(' / ') : '不选（写空数组）' }}
              </td>
            </tr>
          </tbody>
        </table>
        <p class="wz__muted">
          门节点只写选中的 <code>node / axis / openAngleDeg</code>；不选或识别不到都允许入库，
          之后可在标注看板或详情里继续核对。入库先写 draft，LOD 由后端异步生成。
        </p>
      </div>
    </section>

    <!-- ── variant / manual 的确认步（create 没有这个独立步骤）────────── -->
    <section v-else-if="step === STEPS.CONFIRM" class="wz__panel">
      <h2>{{ isManual ? '确认代录' : '确认入库' }}</h2>

      <div v-if="!done && analysis">
        <!-- 确认步的内容由**纯函数** `confirmRows` 给出（见 wizard.js 的注释）：
             这一步真机探针到不了（加变体要先把模型分析完），所以它必须能被单测钉住 ——
             模板只负责把行画出来（`input` 行画输入框，其余画值）。 -->
        <table class="wz__sum">
          <tbody>
            <tr v-for="(r, i) in confRows" :key="'cr' + i">
              <th>{{ r.label }}<i v-if="r.required" class="wz__req">必填</i></th>
              <td :class="{ 'wz__mono': r.mono, 'wz__muted': r.muted }">
                <template v-if="r.input">
                  <input v-model="variantName" class="wz__mono" style="width:12em" maxlength="32">
                  <em class="wz__muted">{{ r.note }}</em>
                </template>
                <template v-else>{{ r.value }}</template>
              </td>
            </tr>
          </tbody>
        </table>
        <p class="wz__muted">
          入库先写成 <b>draft</b>：模型文件落盘后，由后端<b>异步跑 LOD</b>，跑成才转 active。
          在此之前它对使用者不可见 —— 所以列表里短暂看到一个草稿是正常的。
        </p>
      </div>

      <!-- 人工代录的确认页（B6）：没有分析结果可列，就把**要写进去的那几样**列出来。
           代录最容易被后人误读的是「为什么它没有模型」—— 所以把来源与尺寸备注并排放在显眼处。 -->
      <div v-else-if="!done && isManual">
        <table class="wz__sum">
          <tbody>
            <tr v-for="(r, i) in confRows" :key="'cm' + i">
              <th>{{ r.label }}</th>
              <td :class="{ 'wz__mono': r.mono, 'wz__muted': r.muted }">{{ r.value }}</td>
            </tr>
          </tbody>
        </table>
        <p class="wz__muted">
          代录会先写成 <b>draft</b>，但**不会**有异步 LOD 作业（没有模型文件可跑）——
          所以它不会自己转 active；模型补进来之前，列表上会一直标「无模型」。
        </p>
      </div>

      <!-- 结果：status 与 LOD 去向必须说出来，不能只说「成功」 -->
      <div v-else class="wz__done">
        <h3>{{ isVariant ? '已加上这个变体' : '已入库' }}</h3>
        <ul>
          <li>目录 id：<span class="wz__mono">{{ done.catalogId }}</span></li>
          <li>dbId：<span class="wz__mono">{{ done.dbId }}</span>（{{ done.dbIdUnit }}）</li>
          <li>状态：<b>{{ done.status }}</b> {{ done.status === 'draft' ? '（等异步 LOD 跑完才转 active）' : '' }}</li>
          <li>写入说明条目：{{ done.notesWritten }} 条</li>
          <!-- 人工代录没有异步 LOD 作业（没有模型文件），就**不许**把那句“已在后台排队”画出来 -->
          <li v-if="isManual"><b>没有异步 LOD</b>：这是人工代录（没有模型文件），它不会自己转 active</li>
          <li v-else-if="isVariant">
            变成：<span class="wz__mono">{{ done.variant || variantName }}</span>
            —— 产品行一个字段都没改，<b>已摆好的方案几何不受影响</b>
          </li>
          <li v-if="!isManual">异步 LOD：{{ done.lodEnabled === false ? '未启用（配置关闭了）' : '已在后台排队，跑完回写 lod_json' }}</li>
        </ul>
        <div class="wz__done-acts">
          <button class="adm__btn" type="button" @click="finish">回产品列表</button>
        </div>
      </div>
    </section>

    <p v-if="trouble" class="wz__issues wz__issues--bad">{{ trouble }}</p>

    <footer v-if="step !== STEPS.HOTSPOTS" class="wz__foot">
      <button class="adm__btn" :disabled="stepIndex === 0" @click="back">← 上一步</button>
      <span class="adm__spacer" />
      <button v-if="step === STEPS.BASIC" class="adm__btn adm__btn--ghost" @click="finish">取消</button>
      <button v-if="step === STEPS.BASIC" class="adm__btn" :disabled="!basicOk" @click="next">
        下一步：{{ isManual ? '确认代录内容' : '模型结构识取' }}
      </button>
      <button v-else-if="step === STEPS.MODEL && isManual === false && isVariant === false"
        class="adm__btn" data-cta-hotspots
        :disabled="!gate.ok || !!busy" @click="submitAndAnnotate">
        {{ busy === 'submitting'
          ? '入库中…'
          : (done && !contentSaved ? '重试保存产品信息'
            : (done ? '回到标注看板' : '确认入库并进入标注')) }}
      </button>
      <button v-else-if="step === STEPS.MODEL" class="adm__btn" :disabled="!gate.ok" @click="next">
        下一步：{{ isVariant ? '确认入库' : '确认代录内容' }}
      </button>
      <button v-else-if="step === STEPS.CONFIRM && !done" class="adm__btn" :disabled="!!busy" @click="submit">
        {{ busy === 'submitting' ? '提交中…' : (isVariant ? '加这个变体' : '确认代录入库') }}
      </button>
      <button v-else-if="step === STEPS.CONFIRM && done && isManual && !contentSaved"
        class="adm__btn" :disabled="!!busy" @click="submit">
        {{ busy === 'submitting' ? '保存中…' : '重试保存产品信息' }}
      </button>
      <button v-else-if="step === STEPS.CONFIRM && done && isManual" class="adm__btn" @click="finish">
        完成，回产品列表
      </button>
    </footer>
  </div>
</template>
