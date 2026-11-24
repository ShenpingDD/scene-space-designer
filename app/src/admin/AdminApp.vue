<script setup>
/**
 * AdminApp —— 维护端的外壳（R6-1）
 *
 * ## 这一层只负责三件事：选界面、挡人、说实话
 * 产品列表、方案库、用户、参数、审计、系统状态都是**各自独立**的面板，外壳只做导航与准入门。
 *
 * ## 角色门现在是服务端判定的边界
 * U1 起每个维护端接口都从登录态取身份并按角色判定，界面这一层只是**提前把结果说出来**：
 *   ① 权限不够的人**看到一句为什么**（该找谁、哪一档能做），而不是一个空列表；
 *   ② 有权限的人看到一句实话：权限来自登录账号的角色；本系统在内网以明文 HTTP 运行，
 *      口令与分享链接不要转发到内网以外。
 *
 * ## 后端不通、角色不对、后端回 403 —— 三种都要**说出话**
 * 白屏或空列表会让人以为是"没有数据"，那是最坏的一种错（判据 5「怕安静」）。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { go } from '../router.js';
import AccountBox from '../components/AccountBox.vue';
import ProductCards from './ProductCards.vue';
import SchemeCards from './SchemeCards.vue';
import UsersPanel from './UsersPanel.vue';
import { canLine, cannotLine, deniedText, roleText, unknownRoleText } from './roles.js';
import ParamsPanel from './ParamsPanel.vue';
import AuditPanel from './AuditPanel.vue';
import SystemPanel from './SystemPanel.vue';
import ProductWizard from './ProductWizard.vue';
import ProductEdit from './ProductEdit.vue';
import HotspotBoard from './HotspotBoard.vue';
import './admin.css';

/** 地址里的分段：`/admin/products/new` → `['admin','products','new']`。认哪一段是界面的事 */
const route = useRoute();
const segments = computed(() => String(route.path || '').split('/').filter((s) => s !== ''));

/** checking 正在核对 / ok 放行 / denied 角色不够 / offline 后端不通 */
const state = ref('checking');
const me = ref(null);
const trouble = ref('');

const tab = computed(() => {
  const s = segments.value;
  if (s[1] === 'system') return 'system';
  // 参数配置：`/admin/params`（R6-4 B4b）
  if (s[1] === 'params') return 'params';
  // 参数审计：`/admin/audit`（R6-4 B4c）
  if (s[1] === 'audit') return 'audit';
  // 场景方案库：`/admin/schemes`（R6-3 3d）
  if (s[1] === 'schemes') return 'schemes';
  // 用户：`/admin/users`（U1）
  if (s[1] === 'users') return 'users';
  // 新增产品向导：`/admin/products/new`
  if (s[1] === 'products' && s[2] === 'new' && s[3] === 'manual') return 'wizardManual';
  if (s[1] === 'products' && s[2] === 'new') return 'wizard';
  // 加变体：`/admin/products/{id}/variant` —— 给**这一款**再加一份模型（B5）
  if (s[1] === 'products' && s[2] && s[3] === 'variant') return 'wizardVariant';
  // 已有产品的标注看板：`/admin/products/{id}/hotspots`
  if (s[1] === 'products' && s[2] && s[3] === 'hotspots') return 'hotspots';
  // 产品信息编辑：`/admin/products/{id}/edit`（声明尺寸/门型/缩略图/内容补录）
  if (s[1] === 'products' && s[2] && s[3] === 'edit') return 'productEdit';
  return 'products';
});

/** 重取整页数据用：bump 一下让 ProductCards 重新挂载（比暴露它的 fetch 更干净） */
const reloadKey = ref(0);
/** 产品子页（向导/变体/标注看板）都归在「产品模型」这个页签下高亮 */
const activeTab = computed(() => (['wizard', 'wizardManual', 'wizardVariant', 'hotspots', 'productEdit'].includes(tab.value) ? 'products' : tab.value));

const TABS = [
  { key: 'products', label: '产品模型库', path: '/admin' },
  // 顺序照 docs/32：产品模型管理是重中之重，场景方案库紧随其后
  { key: 'schemes', label: '场景方案库', path: '/admin/schemes' },
  // 参数配置放在方案库之后、系统状态之前（顺序照 docs/32 §4：它是「规则」那一层）
  { key: 'params', label: '参数配置', path: '/admin/params' },
  { key: 'audit', label: '参数审计', path: '/admin/audit' },
  { key: 'system', label: '系统状态', path: '/admin/system' },
  // 用户管理只对 admin 开放（`manageUsers`），摆在最后一个
  { key: 'users', label: '用户', path: '/admin/users' },
];

async function check() {
  state.value = 'checking';
  trouble.value = '';
  try {
    const m = await api.adminMe();
    me.value = m;
    // 有接口、但角色不对 —— 这是"进不去维护端"的正解，不算错误。
    // ⚠️ R6-4 B4e 起判的是**能力**（`caps.enterAdmin`）而不是"是不是 admin"：
    //    editor / viewer 也能进维护端（能做的事更少），designer 不进。
    //    判断本身在后端（`AdminGate`），这里只读结果 —— 前端不抄那张对照表。
    state.value = m && m.caps && m.caps.enterAdmin ? 'ok' : 'denied';
  } catch (e) {
    // 后端回 403（理论上 /me 不会，真回了我按"无权"处理，不按"坏了"处理）
    if (e && e.reason === 'forbidden') {
      state.value = 'denied';
      trouble.value = e.message || '';
      return;
    }
    state.value = 'offline';
    trouble.value = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
  }
}

onMounted(check);

/** 这张能力表要发给每一个面板（按钮的可用状态跟着它走，不各自去问一遍后端） */
const caps = computed(() => (me.value && me.value.caps) || {});
/** 加变体那一页要把"加到哪款"写出来（只有 id 用户没法认）—— 得先把产品取回来 */
const productLabel = ref('');
/** 路由里的产品 id（加变体入口要用）—— 认路由是界面的事 */
const routePid = computed(() => (segments.value[1] === 'products' ? (segments.value[2] || '') : ''));

/**
 * ⚠️ 这段的位置是硬要求，与排版无关：`watch(routePid, …)` 与 `immediate: true` 都是**当场求值**的，
 *    写在 `routePid` / `productLabel` 前面就撞 const 的暂时性死区 —— 整个维护端**白屏**，
 *    而控制台只留一句 ReferenceError。端到端探针会兜住这种白屏（按钮与文字全空即判失败）。
 */
watch(routePid, async (pid) => {
  productLabel.value = '';
  if (!pid) return;
  try {
    const r = await api.adminProducts();
    const p = ((r && r.products) || []).find((x) => String(x.id) === String(pid));
    productLabel.value = p ? (p.name + ' · ' + p.modelNo) : '（列表里没有 id=' + pid + ' 这款产品）';
  } catch (e) {
    productLabel.value = '（产品名取不到：' + (e && e.message ? e.message : '未知原因') + '）';
  }
}, { immediate: true });

/** 我能不能做这件事（cap 名与后端 `AdminGate.caps()` 一字不差） */
function can(cap) {
  return !!(me.value && me.value.caps && me.value.caps[cap]);
}

/** 刷新数据 = 重新核对身份 + 重取列表。两个都要，少一个都会让人以为「刷新了但其实没有」 */
function refreshAll() {
  reloadKey.value += 1;
  check();
}
</script>

<template>
  <div class="adm">
    <header class="adm__head">
      <div class="adm__brand">
        <b>维护端</b>
        <span class="adm__sub">产品模型库 · 场景方案库 · 参数配置 · 用户</span>
      </div>
      <span class="adm__spacer" />
      <span v-if="me" class="adm__store" :title="'数据来源档位：' + (me.store || '?')">
        {{ me.store === 'jdbc' ? '数据库' : '无数据库档' }}
      </span>
      <AccountBox />
      <button class="adm__btn" @click="refreshAll" title="重新核对权限">刷新数据</button>
      <button class="adm__btn adm__btn--ghost" @click="go('/index')">← 返回首页</button>
    </header>

    <!-- 核对中：说清正在做什么。维护端首屏要读身份 + 列表，慢一点是正常的 -->
    <div v-if="state === 'checking'" class="adm__center">
      <div class="adm__card">
        <h2>正在核对权限…</h2>
        <p class="adm__muted">正在问后端"我是谁、我是什么角色"。</p>
      </div>
    </div>

    <!-- 后端不通：必须说话，且给出原因（不许显示成"没有数据"） -->
    <div v-else-if="state === 'offline'" class="adm__center">
      <div class="adm__card adm__card--bad">
        <h2>连不上后端</h2>
        <p>维护端的产品与方案都在后端数据库里，后端不通时它<b>读不到任何东西</b>。</p>
        <p class="adm__mono adm__muted">{{ trouble }}</p>
        <p class="adm__muted">后端地址 http://127.0.0.1:8080 ｜ 可在项目根目录执行 `bash start.sh` 起服务。</p>
        <button class="adm__btn" @click="check">重试</button>
      </div>
    </div>

    <!-- 角色不够：明确的门，说明为什么 + 现在这套权限是怎么来的 -->
    <div v-else-if="state === 'denied'" class="adm__center">
      <div class="adm__card adm__card--warn">
        <h2>无权访问维护端</h2>
        <p>
          当前身份
          <b>{{ me ? (me.displayName || me.username || '（无用户）') : '（未知）' }}</b>
          的角色是 <code>{{ (me && me.roleCode) || '（空）' }}</code>。
        </p>
        <!-- 四档各说各的话：认不得的角色码走另一句（不许一律说成"只对 admin 开放"） -->
        <p>{{ me ? deniedText(me.roleCode, me.roleKnown) : '（读不到自己的身份）' }}</p>
        <p class="adm__muted">
          这道门<b>是服务端判定的边界</b>：每一次请求都按登录账号的角色重新判一遍，界面上的灰按钮只是提前告诉你。
          真正的边界之外还有一层：本系统在内网以明文 HTTP 运行，口令与分享链接不要转发到内网以外。
        </p>
        <p v-if="trouble" class="adm__mono adm__muted">{{ trouble }}</p>
        <button class="adm__btn" @click="go('/index')">← 返回首页</button>
      </div>
    </div>

    <!-- 放行 -->
    <template v-else>
      <div class="adm__notice">
        <b>权限来自登录账号的角色</b>
        <span>
          当前账号 <code>{{ me.username }}</code> / <code>{{ me.roleCode }}</code>；
          本系统在内网以明文 HTTP 运行，口令与分享链接不要转发到内网以外。
        </span>
      </div>

      <!-- R6-4 B4e：**进得来 ≠ 什么都能做**。把"你能做什么/不能做什么"写在脸上，
           而不是等人点了按钮才发现（把入口藏起来比明说更坏：看起来像功能坏了） -->
      <div class="adm__caps">
        <span class="adm__caps-who">你是 {{ roleText(me.roleCode, me.roleKnown) }}</span>
        <span class="adm__caps-can">能：{{ canLine(caps) }}</span>
        <span class="adm__caps-cannot">不能：{{ cannotLine(caps) }}</span>
        <span v-if="!me.roleKnown" class="adm__caps-unknown">{{ unknownRoleText(me.roleCode) }}</span>
      </div>

      <nav class="adm__tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          :aria-current="activeTab === t.key ? 'page' : undefined"
          @click="go(t.path)"
        >{{ t.label }}</button>
      </nav>

        <main class="adm__body">
          <ProductCards v-if="tab === 'products'" :key="reloadKey" :caps="me ? caps : null"
            :role="me ? me.roleCode : ''" />
          <SchemeCards v-else-if="tab === 'schemes'" :key="reloadKey" :store="me ? me.store : ''"
            :caps="caps" :role="me ? me.roleCode : ''" />
          <UsersPanel v-else-if="tab === 'users'" :key="reloadKey" :caps="caps"
            :role="me ? me.roleCode : ''" :my-user-id="me ? me.id : ''" />
          <ParamsPanel v-else-if="tab === 'params'" :key="reloadKey"
            :caps="caps" :role="me ? me.roleCode : ''" />
          <AuditPanel v-else-if="tab === 'audit'" :key="reloadKey" />
          <ProductWizard v-else-if="tab === 'wizard'" :key="reloadKey" />
          <ProductWizard v-else-if="tab === 'wizardManual'" :key="reloadKey" mode="manual" />
          <ProductWizard v-else-if="tab === 'wizardVariant'" :key="reloadKey" mode="variant"
            :product-id="routePid" :product-label="productLabel" />
          <HotspotBoard v-else-if="tab === 'hotspots'" :key="reloadKey + '-' + routePid"
            :product-id="routePid" :product-name="productLabel" @exit="go('/admin')" />
          <ProductEdit v-else-if="tab === 'productEdit'" :key="reloadKey + '-edit-' + routePid"
            :product-id="routePid" :caps="me ? caps : null" :role="me ? me.roleCode : ''" />
          <SystemPanel v-else :key="reloadKey" />
        </main>
    </template>
  </div>
</template>
