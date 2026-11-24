<script setup>
/**
 * App —— 外壳：顶栏（方案级操作）+ 三栏（模型库 / 画布 / 画布编辑）
 *
 * 与原型最大的结构差异：**没有一行代码在"手动同步界面"**。
 * 原型用了 12 处 `$('xxx').textContent = …` 手工刷新 DOM，其中一处提前 return 就造成读数冻结（FIX-02）。
 * 现在所有读数都是 computed —— 状态变，界面必然跟着变，这个失败模式在新架构里不存在。
 */
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PlanView from './components/PlanView.vue';
import ProductRail from './components/ProductRail.vue';
import Inspector from './components/Inspector.vue';
import SchemePanel from './components/SchemePanel.vue';
import AccountBox from './components/AccountBox.vue';
import LeaveHomeDialog from './components/LeaveHomeDialog.vue';
import ProductDetail from './components/ProductDetail.vue';
import { designer as d } from './designer.js';
import { ROUTES, go } from './router.js';
import { scheme } from './kernel.js';
import { authTrouble, caps, me, user } from './session.js';
import { activateDraft, activeDraft, createDraftStore, draftTimeText, dropActiveDraft, restoreDraft } from './draft.js';
import { canLine, cannotLine, roleText } from './admin/roles.js';
import { shortcutAllowed, walking } from './walkMode.js';
import { refreshCatalog } from './catalog.js';

/* ---------------- 我是谁、我能做什么（B4f / U1）----------------
 *
 * 身份与能力表来自 `session.js`（它只问后端一次，与维护端**同一个接口、同一张表**）——
 * 界面不抄对照表，也不自己再问一遍（同一个问题问两遍，两处迟早会给出不一样的说法）。
 *
 * ⚠️ 取不到时**不许装作禁止**也不许装作能做：
 *   读不到 → `me = null` → 按钮**不禁用**，但菜单里明说“身份没读到，写操作仍由服务端判定”。
 *   装作禁止 = 后端一恢复用户还以为自己没权限（比不做更坏）。
 */
const role = computed(() => (me.value ? me.value.roleCode : ''));
const roleKnown = computed(() => !!(me.value && me.value.roleKnown));
/** 身份没读到时的原因（`session.js` 把那一趟的结果留下来） */
const meTrouble = computed(() => (me.value ? '' : authTrouble.value));

// 3D 懒加载：three.js 有 600 KB 左右，不开三维视图就不下载
const View3D = defineAsyncComponent(() => import('./components/View3D.vue'));

const fileInput = ref(null);

function pickFile() { fileInput.value?.click(); }
async function onFile(evt) {
  const file = evt.target.files?.[0];
  evt.target.value = ''; // 允许连续导入同一个文件
  await d.importFile(file);
}

function onKeydown(evt) {
  // 浮层先让路：菜单开着时 Esc 就是"算了"（全项目唯一一个没有 Esc 的浮层，补上）
  if (evt.key === 'Escape' && moreOpen.value) { evt.preventDefault(); moreOpen.value = false; return; }
  if (!shortcutAllowed(walking.value, evt)) return;   // 漫游中不接快捷键（FIX-15）
  const meta = evt.ctrlKey || evt.metaKey;
  if (!meta) return;
  const k = evt.key.toLowerCase();
  if (k === 'z' && !evt.shiftKey) { evt.preventDefault(); d.undo(); }
  else if ((k === 'z' && evt.shiftKey) || k === 'y') { evt.preventDefault(); d.redo(); }
  else if (k === 's') { evt.preventDefault(); d.download(); }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));

/* ---------------- 未保存的草稿（只在这台浏览器里）----------------
 *
 * 口径（docs/80 §七）：
 *   · 草稿**只属于 `/design/new` 这一档**。打开 `/design/<id>` 不读草稿 ——
 *     本机旧内容盖掉库里已经保存好的那一版，用户完全看不出来；
 *   · 内容 `{ savedAt, state, format }`，state 与 format 取自 `scheme.exportScheme`
 *     （与服务端收到的是**同一份**内容，没有第二条序列化路径）；
 *   · 写入时机照 `designer.js` 那条净空计算的做法：`watch` + 安静延时。
 *     写本机比算净空贵，延时长一点（800 ms），另在离开页面时补一次；
 *   · 清掉时机两处：保存成功（在 `SchemePanel` 里清）、用户点「放弃草稿」。
 *     **退出登录不清** —— 键里带账号 id，天然隔离，而且"上次那个账号改到一半的东西"还在；
 *   · 写入失败（隐私模式、配额满）**不静默跳过**：界面上写一句"本机缓存写不进去"，当场让人知道。
 */
const route = useRoute();
const isNew = computed(() => route.name === ROUTES.DESIGN_NEW);

/** 顶栏那句「未保存（只在本浏览器）」：用户要能随时知道「现在的东西刷新之后还在不在」 */
const draftOn = ref(false);
const draftNote = ref('');
const draftTrouble = ref('');
let draftTimer = 0;

/**
 * `prepareDraft()` 正在换布局。
 *
 * 不挡住的话，换个账号进 `/design/new` 会在 800 毫秒后把默认那一间房当成「未保存的改动」
 * 写进新账号名下 —— 下一次进来还会弹出「已恢复上次未保存的改动」，而用户根本没动过任何东西。
 */
let preparing = false;

/** 拿账号 id 建草稿读写口；没有账号 id 就回 null（**不写到一个没名字的键上**） */
function draftStore() {
  const uid = user.value && user.value.id;
  return uid ? createDraftStore(window.localStorage, uid) : null;
}

/** 立刻写一次（定时器到点、离开页面、切走这一档时都走这里） */
function flushDraft() {
  const store = activeDraft();
  if (!store || !isNew.value) return;
  const packed = JSON.parse(scheme.exportScheme(d.layout.value));
  try {
    store.write(packed.state, packed.format);
    draftTrouble.value = '';
    draftOn.value = true;
  } catch (e) {
    draftTrouble.value = e && e.message ? e.message : '未知原因';
  }
}

/**
 * 挂到这一档时准备草稿：先接上读写口，再（只在 `/design/new`）恢复上一次没保存的改动。
 * 恢复走 `restoreDraft` → `applyServerState`（内核校验不过就**当场丢掉**那份草稿）；
 * 当前账号没有可用草稿时，`restoreDraft` 会调「回到默认那一间房」那一支 ——
 * 退出登录与换账号登录都是同一篇文档里的客户端跳转，工作区不会自己变成一份新方案。
 */
function prepareDraft() {
  const store = draftStore();
  if (!store) return;
  activateDraft(store);
  if (!isNew.value) {
    draftOn.value = false;
    draftNote.value = '';
    return;
  }
  // 这一趟换布局是代码干的（恢复草稿或回默认），不该被当成用户改动去写草稿
  preparing = true;
  let r;
  try {
    r = restoreDraft(
      store,
      (state, format) => d.applyServerState(state, format),
      () => d.resetNewDesign(),
    );
  } finally {
    preparing = false;
  }
  if (r.restored) {
    draftOn.value = true;
    draftNote.value = '已恢复上次未保存的改动（' + draftTimeText(r.draft.savedAt) + '）';
  } else if (r.reason === 'rejected') {
    draftOn.value = false;
    draftNote.value = '本机那份草稿没能通过内核校验，已经丢掉（留着他每次打开都会失败一次）。';
  } else {
    draftOn.value = false;
    draftNote.value = '';
  }
}

function giveUpDraft() {
  dropActiveDraft();
  draftOn.value = false;
  draftNote.value = '已放弃本机草稿 —— 编辑区的内容没有变，只是不再往这台机器上存。';
}

/**
 * `flush: 'sync'` 是为了让 `preparing` 在同一段同步代码里就挡住「程序换布局」那几次触发。
 * 点「放弃草稿」不算改动，所以不触发这个 watch。
 */
watch(d.layout, () => {
  if (preparing) return;
  if (!isNew.value) return;
  draftOn.value = true;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { draftTimer = 0; flushDraft(); }, 800);
}, { flush: 'sync' });

/* ---------------- 产品 3D 详情（docs/104 §四） ----------------
 *
 * 弹层挂在这一层而不是 ProductRail 里面，两个原因：
 *   ① 它是模态，要 Teleport 到 body 才能盖住顶栏/两侧栏；放在 card 里会被 overflow 裁掉；
 *   ② 关掉之后焦点要还给**那张缩略图** —— 只有同时知道"谁打开的"和"什么时候关的"的一层能做对。
 * 详情里只读：不改 layout、不改选中、不调 d.add（"点开看看"与"放进布局"必须分开）。
 */
const detailProduct = ref(null);
/** 打开详情的那张缩略图（关掉之后焦点还给它是可访问性的硬要求，见 docs/104 §4.1） */
const detailTrigger = ref(null);

function openDetail(p, trigger) {
  moreOpen.value = false;
  detailTrigger.value = trigger ?? document.activeElement;
  detailProduct.value = p;
}

function closeDetail() {
  detailProduct.value = null;
  detailTrigger.value = null;
}

/**
 * 回到设计页时重读目录（task-75）：
 * 维护端上架 → 切回这里 → 新产品应当**几秒内**出现，而不是要求用户按 F5。
 * 节流在 `catalog.refreshCatalog` 里（≥5s，按尝试算）—— 这里只负责"什么时候该问一次"。
 */
watch(() => route.name, (name) => {
  if (name === ROUTES.DESIGN_NEW || name === ROUTES.DESIGN) refreshCatalog({ reason: 'route' });
}, { immediate: true });

watch(() => [route.name, route.params.id], () => {
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = 0; }
  // 从「新方案」走到某一份已保存的方案 = 保存成功了（SchemePanel 已经清过草稿）
  prepareDraft();
});

function onBeforeUnload() { flushDraft(); }

onMounted(() => {
  prepareDraft();
  loadRails();
  window.addEventListener('beforeunload', onBeforeUnload);
});
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload);
  if (draftTimer) clearTimeout(draftTimer);
});

/* ---------------- 顶栏的「更多」 ---------------- */

/** 「更多」菜单开关。点菜单外的遮罩或选中任一项都会关掉（选完不关，用户会以为没点到） */
const moreOpen = ref(false);

/** 方案库组件：顶栏要能替它打开面板（`defineExpose` 出去的） */
const panelRef = ref(null);

function run(fn) {
  moreOpen.value = false;
  fn();
}

/* ---------------- 左右栏独立收起（第二轮 验收 · A）----------------
 *
 * 收起的只是**这一栏的宽度**，栏里的内容原样留在 DOM 里：
 *   · 右栏的折叠记忆（`spatial.designer.rail`）、左栏的页签/滚动位置都不会因为收一下就丢；
 *   · 展开回来是"原来那一栏"，不是重新挂载的一份。
 *
 * 状态只记"开没开"（默认都展开），写 `spatial.designer.rails`。读不到 / 读不懂就按展开算 ——
 * 侧栏莫名其妙消失，比多显示一块更让人以为界面坏了。
 */
const RAILS_KEY = 'spatial.designer.rails';
const leftClosed = ref(false);
const rightClosed = ref(false);

function loadRails() {
  try {
    const raw = window.localStorage.getItem(RAILS_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    // 只认**显式的 false**（那次是收起的）；其余一律展开
    leftClosed.value = !!v && v.left === false;
    rightClosed.value = !!v && v.right === false;
  } catch (e) {
    leftClosed.value = false;
    rightClosed.value = false;
  }
}

function saveRails() {
  try {
    window.localStorage.setItem(RAILS_KEY, JSON.stringify({
      left: !leftClosed.value,
      right: !rightClosed.value,
    }));
  } catch (e) {
    // 本机记忆写不进去（隐私模式 / 配额满）：这一趟照样收展，只是刷新后回到默认展开。
    // 不弹 toast —— 它不是"用户正在做的事失败了"，打断的代价比记住这件事更大。
  }
}

function toggleRail(side) {
  if (side === 'left') leftClosed.value = !leftClosed.value;
  else rightClosed.value = !rightClosed.value;
  saveRails();
}

/* ---------------- 顶栏方案名（第二轮 验收 · V9）----------------
 *
 * 名字属于**方案库那一层**（存哪儿、rev、dirty 都在 SchemePanel），顶栏只负责"显示 + 点开改"。
 * 顶栏不自己判断"改没改成"：改名结果由 `panelRef.rename()` 回，失败就没改过本地名字，
 * 所以"恢复原名"不是回滚，而是本来就没动。
 */
const nameEditing = ref(false);
const nameDraft = ref('');
const nameSaving = ref(false);
const nameInput = ref(null);

/** 顶栏显示的名字：没有名字的新方案说「未命名方案」（不是假名字，也不留空） */
const docName = computed(() => {
  const n = panelRef.value && panelRef.value.name;
  if (n && String(n).trim()) return String(n);
  return isNew.value ? '未命名方案' : '未保存的方案';
});

/** V 徽标：只有落过库才有版本；新方案不显示（V0 会让人以为存在第 0 版） */
const docRev = computed(() => {
  const p = panelRef.value;
  return p && p.currentId ? (Number(p.rev) || 0) : 0;
});

function startRename() {
  if (walking.value) return;
  nameEditing.value = true;
  nameDraft.value = (panelRef.value && panelRef.value.name) || '';
  nextTick(() => {
    const el = nameInput.value;
    if (el) { el.focus(); el.select(); }
  });
}

/** Esc：只丢掉这一趟输入，名字仍是原来那个（没有请求发出去） */
function cancelName() {
  nameEditing.value = false;
  nameDraft.value = '';
}

/**
 * 提交改名（Enter / 失焦都走这里）。
 * 空名、超 128 字**当场拦下、不发请求**：服务端也会拒，但没必要先打一发注定被拒的请求，
 * 而且那样用户要等一个来回才被告知"名字不合法"。
 */
async function commitName() {
  if (!nameEditing.value || nameSaving.value) return;
  const p = panelRef.value;
  if (!p) { cancelName(); return; }
  const clean = nameDraft.value.trim();
  if (!clean) {
    d.toast('方案名不能为空');
    nameInput.value?.focus();
    return;
  }
  if (clean.length > 128) {
    d.toast('方案名不能超过 128 字');
    nameInput.value?.focus();
    return;
  }
  if (clean === String(p.name || '')) { cancelName(); return; }
  nameSaving.value = true;
  try {
    const r = await p.rename(clean);
    if (r && r.ok) {
      nameEditing.value = false;
      nameDraft.value = '';
      d.toast('方案名已更新：' + (r.name || clean));
    } else {
      // 失败：退出编辑态（显示回原名）并说明原因
      cancelName();
      d.toast('重命名没成功：' + ((r && r.message) || '未知原因'));
    }
  } finally {
    nameSaving.value = false;
  }
}

/* ---------------- 回首页：只有真的会丢东西才拦（第二轮 验收 · C）----------------
 *
 * 判断只看两件事：
 *   · 已保存方案 → `dirty`（与库里那一版比，见 SchemePanel）；
 *   · 新方案 → 草稿条有没有亮（画布真的改过）或名字动过；**刚打开、什么都没动就不弹**。
 * 保存失败 / 409 一律**留在当前页**并在模态里说原因 —— 不拿一次失败的保存当"已保存"。
 */
const leaveOpen = ref(false);
const leaveBusy = ref(false);
const leaveErr = ref('');

function leavingWouldLose() {
  const p = panelRef.value;
  if (!p) return false;
  if (p.dirty) return true;
  if (p.currentId) return false;
  const typedName = !!(p.name && String(p.name).trim());
  return draftOn.value || typedName || !!draftTrouble.value;
}

function goHome() {
  if (leavingWouldLose()) {
    leaveErr.value = '';
    leaveOpen.value = true;
    return;
  }
  go('/index');
}

async function leaveSave() {
  const p = panelRef.value;
  if (!p || leaveBusy.value) return;
  leaveBusy.value = true;
  leaveErr.value = '';
  try {
    const r = await p.saveForLeave();
    if (r && r.ok) {
      leaveOpen.value = false;
      go('/index');
    } else {
      leaveErr.value = (r && r.message) || '保存没成功 —— 先别离开';
    }
  } finally {
    leaveBusy.value = false;
  }
}

function leaveDiscard() {
  const p = panelRef.value;
  // 新方案：本机草稿也要清掉 —— 否则下次进 `/design/new` 又"恢复"出刚说不要的那份改动
  if (p && !p.currentId) {
    dropActiveDraft();
    draftOn.value = false;
    draftNote.value = '';
    draftTrouble.value = '';
  }
  leaveOpen.value = false;
  go('/index');
}

function leaveCancel() {
  leaveErr.value = '';
  leaveOpen.value = false;
}
</script>

<template>
  <div class="shell">
    <!-- ⚠️ 漫游中整个顶栏 `inert`：Tab 不该进得来，按钮也不该点得动 ——
         漫游者视线里的场景不该被工具栏改掉（FIX-15）。退出漫游走漫游条上的按钮 / Esc。 -->
    <header class="header" :inert="walking">
      <div class="hd-left">
        <!-- 房子 = 回首页：真 button（Tab 到得了、读屏说是按钮），hover 有一句自定义提示 -->
        <button type="button" class="brand__mark brand__mark--btn" aria-label="返回首页" title="返回首页" @click="goHome()">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M4 9.5 12 4l8 5.5V20H4z" />
            <path d="M9 20v-6h6v6" />
          </svg>
          <span class="brand__tip" aria-hidden="true">返回首页</span>
        </button>
        <div class="doc">
          <!-- 方案名：点一下原地改名（Enter/失焦提交、Esc 取消）。
               标题/aria-label 都说清这是"重命名"，不让人以为它只是普通文字。 -->
          <div class="doc__namebox">
            <button
              v-if="!nameEditing"
              type="button"
              class="doc__name"
              :title="'重命名方案：' + docName"
              aria-label="重命名方案"
              @click="startRename()"
            >
              <span class="doc__nametext">{{ docName }}</span>
              <svg class="doc__pencil" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                   stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                <path d="M4 20h4L19 9l-4-4L4 16z" />
                <path d="M14.5 5.5 18.5 9.5" />
              </svg>
            </button>
            <input
              v-else
              ref="nameInput"
              v-model="nameDraft"
              class="doc__nameinput"
              type="text"
              maxlength="128"
              aria-label="方案名"
              @keydown.enter.prevent="commitName()"
              @keydown.esc.prevent="cancelName()"
              @blur="commitName()"
            >
            <span v-if="docRev" class="doc__rev" :title="'第 ' + docRev + ' 版'">V{{ docRev }}</span>
          </div>
          <span class="doc__status" :class="'doc__status--' + (panelRef?.badgeClass || 'is-none')">
            <span class="doc__dot" aria-hidden="true" />{{ panelRef?.badge || '未保存' }}
          </span>
          <span v-if="isNew" class="doc__hint" title="地址是 /design/new，第一次保存会新建一份方案">新方案</span>
        </div>

        <!-- 草稿那两句：恢复提示与"写不进去"。只在 `isNew` 这一档出现（其它档不读也不写草稿） -->
        <span v-if="isNew && (draftNote || draftOn || draftTrouble)" class="draft">
          <span v-if="draftTrouble" class="draft__bad" title="内容还在编辑区里，但没存进本机">
            本机缓存写不进去：{{ draftTrouble }}
          </span>
          <template v-else>
            <span v-if="draftNote" class="draft__note">{{ draftNote }}</span>
            <span v-else class="draft__on" title="改动会存在这台浏览器里，刷新之后还能拿回来">未保存（只在本浏览器）</span>
            <button class="btn btn--mini" title="不再往这台机器上存这一次的改动（编辑区的内容不动）" @click="giveUpDraft">
              放弃草稿
            </button>
          </template>
        </span>
      </div>

      <div class="seg" role="group" aria-label="视图模式">
        <button data-view="2d" :aria-pressed="d.mode.value === '2d'" @click="d.mode.value = '2d'">平面设计</button>
        <button data-view="3d" :aria-pressed="d.mode.value === '3d'" @click="d.mode.value = '3d'">三维预览</button>
      </div>

      <div class="hd-right">
        <SchemePanel ref="panelRef" :caps="caps" :role="role" />

        <!-- 撤销 / 重做：**内联 SVG 弯箭头**（18×18，24 网格、1.8 圆头）。
             以前用的是字体字符（U+21B6 / U+21B7）—— 字形随系统字体变，粗细和圆头都不受控，看起来歪。
             两个箭头是**严格镜像**：撤销向左回勾、重做向右回勾。
             `currentColor` 让它们跟着按钮文字色走（禁用态的灰度由 .btn:disabled 统一给）。 -->
        <button class="btn btn--icon" style="display:inline-flex;align-items:center;justify-content:center" :disabled="!d.canUndo.value" aria-label="撤销" title="撤销 (Ctrl+Z)" @click="d.undo()">
          <svg style="display:block" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
          </svg>
        </button>
        <button class="btn btn--icon" style="display:inline-flex;align-items:center;justify-content:center" :disabled="!d.canRedo.value" aria-label="重做" title="重做 (Ctrl+Shift+Z)" @click="d.redo()">
          <svg style="display:block" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="m15 14 5-5-5-5" />
            <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
          </svg>
        </button>

        <!--
          低频操作收进「更多」：顶栏只留**天天要点的**（保存 / 撤销 / 重做）。
          「重置方案」放最后并标红 —— 它会丢当前布局，位置和颜色都要提醒这一点。

          ⚠️ 菜单与遮罩必须**平级**，不能把菜单放进遮罩里面：
          遮罩是 position:fixed + inset:0（铺满整屏），一旦它成了菜单的包含块，
          菜单的 top:calc(100% + 6px) 就按**整屏高度**算 → 掉到视口外面
          （实测：852px 高的窗口里菜单落在 top=858px，正好在屏幕底下）。
          用户说「点了没反应」的真相就是这个：菜单一直存在、内容也对，就是**在屏幕外面**。
        -->
        <div class="more">
          <button class="btn" :aria-expanded="moreOpen" title="更多操作" @click="moreOpen = !moreOpen">更多 ▾</button>
          <div v-if="moreOpen" class="more__mask" @click.self="moreOpen = false"></div>
          <!-- ⚠️ 菜单必须跟着开关存在/消失：真机量过「点击无效」的真相 ——
               菜单一直是 display:flex 常驻的（只有遮罩带 v-if），点按钮只切了一个看不见的遮罩；
               更坏的是这块常驻浮层会**吞掉它下面那一块的点击**。 -->
          <div v-if="moreOpen" class="more__menu" role="menu">
              <button role="menuitem" @click="run(() => panelRef?.openLibrary())">打开方案库</button>
              <button role="menuitem" title="生成只读链接与二维码，给客户看"
                      @click="run(() => panelRef?.openShare())">分享方案</button>
              <button role="menuitem" title="导出方案 (Ctrl+S)" @click="run(() => d.download())">
                导出方案 <span class="more__key">Ctrl+S</span>
              </button>
              <button role="menuitem" @click="run(pickFile)">导入方案</button>
              <hr>
              <!-- 我是谁 / 我能做什么（B4f）：
                   不看这一行的人会以为按钮灰了是“功能坏了”。做成菜单里的一句话，
                   既不占顶栏，又能被“按钮为什么灰着”这个疑问直接找到。 -->
              <div class="more__who" role="note">
                <template v-if="caps">
                  <b>你是 {{ roleText(role, roleKnown) }}</b>
                  <span v-if="!roleKnown" class="more__bad">
                    角色码不在四档里 → 按什么都不能做处理（写操作会被服务端挡下）
                  </span>
                  <span>能做：{{ canLine(caps) }}</span>
                  <span>不能做：{{ cannotLine(caps) }}</span>
                </template>
                <span v-else-if="meTrouble" class="more__bad">
                  读不到你的身份（{{ meTrouble }}）—— 界面上不会替你禁用任何按钮，写操作仍由服务端判定
                </span>
                <span v-else>正在读你的身份…</span>
                <span class="more__muted">
                  权限来自登录账号的角色；本系统在内网以明文 HTTP 运行，口令与分享链接不要转发到内网以外。
                </span>
              </div>
              <hr>
                <button role="menuitem" title="回到首页（新建方案 / 我的方案 / 维护端都从那里进）" @click="run(() => go('/index'))">
                  首页 →
                </button>
                <button role="menuitem" title="我名下的方案（按登录账号归属）" @click="run(() => go('/project'))">
                  我的方案 →
                </button>
                <button role="menuitem" title="管理产品模型与方案库" @click="run(() => go('/admin'))">
                  维护端 →
                </button>
              <hr>
              <button role="menuitem" class="is-danger" @click="run(() => d.reset())">重置方案</button>
          </div>
        </div>

        <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFile">
        <AccountBox />
      </div>
    </header>

    <!-- 左右栏各自可收：收起的只是宽度（栏里内容原样留着），把手贴在画布左右边缘 -->
    <div class="body" :class="{ 'is-left-closed': leftClosed, 'is-right-closed': rightClosed }">
      <ProductRail
        id="rail-left"
        :inert="leftClosed"
        :aria-hidden="leftClosed ? 'true' : undefined"
        @open-detail="openDetail"
      />

      <main class="stage">
        <button
          type="button"
          class="rail-handle rail-handle--left"
          :class="{ 'is-flipped': leftClosed }"
          :aria-expanded="!leftClosed"
          aria-controls="rail-left"
          :title="leftClosed ? '展开模型库' : '收起模型库'"
          :aria-label="leftClosed ? '展开模型库' : '收起模型库'"
          @click="toggleRail('left')"
        >
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M12 4 6 10l6 6" />
          </svg>
        </button>

        <PlanView v-if="d.mode.value === '2d'" />
        <View3D v-else />

        <button
          type="button"
          class="rail-handle rail-handle--right"
          :class="{ 'is-flipped': rightClosed }"
          :aria-expanded="!rightClosed"
          aria-controls="rail-right"
          :title="rightClosed ? '展开右侧信息' : '收起右侧信息'"
          :aria-label="rightClosed ? '展开右侧信息' : '收起右侧信息'"
          @click="toggleRail('right')"
        >
          <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
            <path d="M8 4 14 10l-6 6" />
          </svg>
        </button>
      </main>

      <Inspector id="rail-right" :inert="rightClosed" :aria-hidden="rightClosed ? 'true' : undefined" />
    </div>

    <!-- 产品详情：只读浏览，独立 WebGL 实例（不复用主画布那份单例） -->
    <ProductDetail
      :open="!!detailProduct"
      :product="detailProduct"
      :return-focus="detailTrigger"
      @close="closeDetail"
    />

    <!-- 回首页时「有未保存改动」才弹（判断在脚本里，默认什么都不弹） -->
    <LeaveHomeDialog
      :open="leaveOpen"
      :name="panelRef?.name || ''"
      :is-new="!panelRef?.currentId"
      :busy="leaveBusy"
      :error="leaveErr"
      @save="leaveSave"
      @discard="leaveDiscard"
      @cancel="leaveCancel"
    />

    <!-- 键盘驱动的动作（Q/E 旋转、Delete 删除）**看得见结果**：读屏靠这一句知道刚才发生了什么 ——
         “能用键盘改”后面还得跟得上“能知道改成了什么”，不然等于没改。 -->
    <div class="toast" :class="{ 'is-show': !!d.message.value }" role="status" aria-live="polite">{{ d.message.value }}</div>
  </div>
</template>