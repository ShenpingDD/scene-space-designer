<script setup>
/**
 * UsersPanel —— 维护端 · 用户（`/admin/users`）
 *
 * ## 这一页动的是"谁能进系统"
 * 建号、改角色、重置口令这三件事都是**把权限交出去**：所以读列表的门是 `canMaintain`，
 * 而这四个写动作的门是 `manageUsers`（只有 admin）。判定在服务端，这里只决定按钮灰不灰并说明原因。
 *
 * ## 三条界面规矩
 * ① **不知道就说不知道**：`hasPassword` / `schemeCount` 接口没给时显示「—」，不冒充"未设置 / 0 份"；
 * ② **每个动作都把后果说出来**：停用会让已登录的会话在下次请求失效、他建的方案全部保留；
 *    删除只在这个人没有任何记录时才允许，否则服务端回 409 并给出计数；
 * ③ **自保提前说**：自己那一行的停用与删除按钮灰掉并写明为什么，不等人点了才报错。
 *
 * ## 数据只有一处来源
 * `GET /api/admin/users`（`api.adminUsers`）。界面不自己拼用户信息，也不缓存一份"本地用户表"。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { denyText } from './roles.js';
import { timeText } from './schemes.js';
import {
  enabledText, isSelf, passwordWhy, passwordText, roleOptions, schemeCountOf,
  selfWhy, userFailText, usernameWhy, userRowOf,
} from './users.js';

const props = defineProps({
  /** `/api/admin/me` 发下来的能力表 */
  caps: { type: Object, default: () => ({}) },
  /** 角色码，只说人话用 */
  role: { type: String, default: '' },
  /** 我自己的账号 id（自保提示要用） */
  myUserId: { type: [Number, String], default: '' },
});

const canManage = computed(() => !!props.caps.manageUsers);

const phase = ref('loading');
const rows = ref([]);
const trouble = ref('');
const notice = ref(null);
const busy = ref('');
/** 展开的二次确认：`{kind:'disable'|'delete'|'password', id}` */
const confirming = ref(null);
/** 每行的待提交改动：`<id> → { displayName, roleCode, password }`。取数时一次建好，不在渲染里改它 */
const draft = ref({});

/** 角色下拉的选项（常量，渲染时不再重新构造数组） */
const roles = roleOptions();

const EMPTY_DRAFT = { displayName: '', roleCode: '', password: '' };

async function load() {
  phase.value = 'loading';
  trouble.value = '';
  try {
    const list = await api.adminUsers();
    const out = (Array.isArray(list) ? list : []).map(userRowOf);
    const d = {};
    for (const u of out) d[u.id] = { displayName: u.displayName, roleCode: u.roleCode, password: '' };
    rows.value = out;
    draft.value = d;
    phase.value = 'ok';
  } catch (e) {
    phase.value = 'fail';
    trouble.value = userFailText(e && e.reason, e && e.message);
  }
}

const line = (u) => draft.value[u.id] || EMPTY_DRAFT;

function changed(u) {
  const d = line(u);
  return String(d.displayName).trim() !== u.displayName || String(d.roleCode) !== u.roleCode;
}

async function act(kind, id, send, okText) {
  busy.value = kind + ':' + id;
  notice.value = null;
  try {
    await send();
    notice.value = { kind: 'ok', text: okText };
    confirming.value = null;
    await load();
  } catch (e) {
    notice.value = { kind: 'bad', text: userFailText(e && e.reason, e && e.message) };
  } finally {
    busy.value = '';
  }
}

const isBusy = (kind, id) => busy.value === kind + ':' + id;
/** 建号那一下用的是不带冒号的标记（没有 id 可标），另外判 */
const creating = computed(() => busy.value === 'create');

/* ---------- 建号 ---------- */

const createOpen = ref(false);
const create = ref({ username: '', displayName: '', roleCode: '' });
const createWhy = ref('');

function openCreate() {
  createOpen.value = true;
  createWhy.value = '';
  notice.value = null;
}

async function submitCreate() {
  const why = usernameWhy(create.value.username);
  if (why) {
    createWhy.value = why;
    return;
  }
  if (!create.value.roleCode) {
    createWhy.value = '要选一个角色 —— 角色决定他能做什么。';
    return;
  }
  createWhy.value = '';
  busy.value = 'create';
  notice.value = null;
  try {
    const r = await api.adminCreateUser({
      username: String(create.value.username).trim(),
      displayName: String(create.value.displayName).trim(),
      roleCode: create.value.roleCode,
    });
    const who = (r && r.user && r.user.username) || String(create.value.username).trim();
    notice.value = {
      kind: 'ok',
      text: '账号 ' + who + ' 建好了。它现在还没有口令 —— 在这一行点「重置口令」把口令设好再交给他。',
    };
    createOpen.value = false;
    create.value = { username: '', displayName: '', roleCode: '' };
    await load();
  } catch (e) {
    notice.value = { kind: 'bad', text: userFailText(e && e.reason, e && e.message) };
  } finally {
    busy.value = '';
  }
}

/* ---------- 改显示名与角色 ---------- */

function saveRow(u) {
  const d = line(u);
  const body = {};
  if (String(d.displayName).trim() !== u.displayName) body.displayName = String(d.displayName).trim();
  if (String(d.roleCode) !== u.roleCode) body.roleCode = String(d.roleCode);
  if (!Object.keys(body).length) return;
  act('patch', u.id, () => api.adminPatchUser(u.id, body),
    '已保存 ' + u.username + ' 的改动：' + Object.keys(body).map((k) => (k === 'roleCode' ? '角色' : '显示名')).join(' 与 ')
    + '（下一次请求起就按新角色判定）。');
}

/* ---------- 重置口令 ---------- */

const passwordWhyOf = (u) => passwordWhy(line(u).password);

function askPassword(u) {
  notice.value = null;
  const why = passwordWhyOf(u);
  if (why) {
    notice.value = { kind: 'bad', text: why };
    return;
  }
  confirming.value = { kind: 'password', id: u.id };
}

async function doPassword(u) {
  const secret = line(u).password;
  await act('password', u.id, () => api.adminResetPassword(u.id, secret),
    '已重置 ' + u.username + ' 的口令（这件事记进了参数审计）。把新口令当面告诉他，'
    + '旧口令立刻不能用了。');
  if (draft.value[u.id]) draft.value[u.id].password = '';
}

/* ---------- 停用 / 启用 ---------- */

function askDisable(u) {
  notice.value = null;
  confirming.value = { kind: 'disable', id: u.id };
}

async function doPatchEnabled(u, enabled) {
  await act('enabled', u.id, () => api.adminPatchUser(u.id, { enabled }),
    enabled
      ? '已启用 ' + u.username + ' —— 他现在可以登录了（前提是口令已经设过）。'
      : '已停用 ' + u.username + '：他不能登录，已经登录的会话在下一次请求时失效；'
        + '他建的方案全部保留，卡片上会标出所属账号已停用。');
}

/* ---------- 删除 ---------- */

function askDelete(u) {
  notice.value = null;
  confirming.value = { kind: 'delete', id: u.id };
}

async function doDelete(u) {
  await act('delete', u.id, () => api.adminDeleteUser(u.id),
    '已删除账号 ' + u.username + '（这个号名下没有任何方案与记录）。');
}

const cancelConfirm = () => { confirming.value = null; };

onMounted(load);
</script>

<template>
  <!-- 能力不够：说清是哪一档才行，并指出该找谁（把入口藏起来比明说更坏） -->
  <div v-if="!canManage" class="adm__center">
    <div class="adm__card adm__card--warn">
      <h2>无权管理账号</h2>
      <p>{{ denyText('manageUsers', props.role) }}</p>
      <p class="adm__muted">
        账号能建号、能改角色、能重置口令 —— 这三件事都是把权限交出去，所以只有 admin 能做。
        你能看的其它页签不受影响。
      </p>
    </div>
  </div>

  <div v-else class="us">
    <div class="pl__sum">
      <span class="pl__total">共 <b>{{ rows.length }}</b> 个账号</span>
      <span class="pl__spacer" />
      <button class="adm__btn adm__btn--primary" @click="openCreate">新建账号</button>
      <button class="adm__btn" :disabled="phase === 'loading'" @click="load">
        {{ phase === 'loading' ? '取数中…' : '重取列表' }}
      </button>
    </div>

    <!-- 新建账号：只填身份，口令另走「重置口令」那一步（服务端的建号接口不收口令） -->
    <form v-if="createOpen" class="us__form" @submit.prevent="submitCreate">
      <b>新建账号</b>
      <label class="us__f">登录名
        <input v-model="create.username" type="text" autocapitalize="off" spellcheck="false" placeholder="2-64 位字母数字与 . _ -">
      </label>
      <label class="us__f">显示名
        <input v-model="create.displayName" type="text" placeholder="界面上显示的名字">
      </label>
      <label class="us__f">角色
        <select v-model="create.roleCode">
          <option value="">选择角色</option>
          <option v-for="o in roles" :key="o.code" :value="o.code">{{ o.label }}（{{ o.code }}）</option>
        </select>
      </label>
      <span class="pl__spacer" />
      <button class="adm__btn adm__btn--primary" type="submit" :disabled="creating">建号</button>
      <button class="adm__btn adm__btn--ghost" type="button" @click="createOpen = false">取消</button>
      <p v-if="createWhy" class="us__err">{{ createWhy }}</p>
      <p class="us__note">
        新建的账号<b>还没有口令</b>（服务端的建号接口不收口令）：建完在这一行点「重置口令」设好，
        再当面告诉他。角色决定他能做什么，写在这里克制一点 —— 改角色同样是交权限。
      </p>
    </form>

    <p v-if="phase === 'loading'" class="pl__msg">正在取账号列表…</p>
    <p v-else-if="phase === 'fail'" class="pl__msg pl__msg--bad">
      取不到账号列表：<span class="adm__mono">{{ trouble }}</span>
      <button class="adm__btn" @click="load">重试</button>
    </p>

    <template v-else>
      <p v-if="notice" class="sl__notice" :class="'sl__notice--' + notice.kind">
        {{ notice.text }}
        <button class="adm__btn adm__btn--ghost" @click="notice = null">知道了</button>
      </p>

      <p v-if="!rows.length" class="pl__msg">
        一个账号都没有 —— 这不该发生（至少要有一名管理员），说明库里的用户表被清过。去后端数据库看一眼。
      </p>

      <ul v-else class="us__list">
        <li v-for="u in rows" :key="u.id" class="us__row">
          <div class="us__head">
            <b>{{ u.username }}</b>
            <span class="pcard__tag" :title="'账号 id ' + u.id">#{{ u.id }}</span>
            <span class="pcard__tag" :class="{ 'us__tag--off': u.enabled === false }" title="启用状态">{{ u.enabledText }}</span>
            <span class="pcard__tag" :title="'口令是否设过（由服务端算）'">口令：{{ u.passwordText }}</span>
            <span class="pcard__tag" :title="u.schemeCount === null ? '接口没给方案数' : '这个账号名下的方案条数'">
              方案 {{ u.schemeCount === null ? '—' : u.schemeCount + ' 份' }}
            </span>
            <span v-if="isSelf(u, myUserId)" class="pcard__tag" title="就是你现在用的账号">这是你</span>
            <span class="pl__spacer" />

            <button
              class="adm__btn sl__act"
              :disabled="isSelf(u, myUserId) || isBusy('enabled', u.id)"
              :title="isSelf(u, myUserId) ? selfWhy(u) : (u.enabled === false ? '让他可以登录' : '让他不能登录（已经登录的会话下一次请求失效）')"
              @click="u.enabled === false ? doPatchEnabled(u, true) : askDisable(u)"
            >{{ u.enabled === false ? '启用' : '停用' }}</button>
            <button
              class="adm__btn sl__act sl__act--danger"
              :disabled="isSelf(u, myUserId) || isBusy('delete', u.id)"
              :title="isSelf(u, myUserId) ? selfWhy(u) : '物理删除（只在这个人没有任何方案与记录时才允许）'"
              @click="askDelete(u)"
            >删除</button>
          </div>

          <!-- 停用的二次确认：把后果说全（不能登录 ✓ 会话失效 ✓ 他建的方案保留 ✓） -->
          <div v-if="confirming && confirming.kind === 'disable' && confirming.id === u.id" class="sl__confirm">
            <span>
              停用 <b>{{ u.username }}</b>？他立刻不能登录，已经登录的会话在下一次请求时失效；
              他建的方案<b>全部保留</b>（卡片上会标出所属账号已停用），随时可以再启用。
            </span>
            <span class="pl__spacer" />
            <button class="adm__btn" :disabled="isBusy('enabled', u.id)" @click="doPatchEnabled(u, false)">
              {{ isBusy('enabled', u.id) ? '停用中…' : '确认停用' }}
            </button>
            <button class="adm__btn adm__btn--ghost" @click="cancelConfirm">取消</button>
          </div>

          <!-- 删除的二次确认：说清守卫条件（有方案就删不掉），并给出退路 -->
          <div v-if="confirming && confirming.kind === 'delete' && confirming.id === u.id" class="sl__confirm">
            <span>
              删除 <b>{{ u.username }}</b>？这是<b>物理删除</b>，库里那一行就没了。
              只有在他<b>没有任何方案、没有版本记录、没有分享记录、没有参数改动</b>时才允许；
              <template v-if="u.schemeCount && u.schemeCount > 0">
                他现在名下有 <b>{{ u.schemeCount }}</b> 份方案，服务端会拒绝这次删除 ——
                请改成「停用」，或者先把方案转给别人。
              </template>
              <template v-else>否则服务端会回一句拒绝，并把名下的计数告诉你。</template>
            </span>
            <span class="pl__spacer" />
            <button class="adm__btn sl__act--danger" :disabled="isBusy('delete', u.id)" @click="doDelete(u)">
              {{ isBusy('delete', u.id) ? '删除中…' : '确认删除' }}
            </button>
            <button class="adm__btn adm__btn--ghost" @click="cancelConfirm">取消</button>
          </div>

          <!-- 每行的可改项：显示名与角色一起提交（一次 PATCH），口令单独一步 -->
          <div class="us__edit">
            <label class="us__f">显示名
              <input v-model="line(u).displayName" type="text">
            </label>
            <label class="us__f">角色
              <select v-model="line(u).roleCode">
                <option v-for="o in roles" :key="o.code" :value="o.code">{{ o.label }}（{{ o.code }}）</option>
              </select>
            </label>
            <button class="adm__btn" :disabled="!changed(u) || isBusy('patch', u.id)" @click="saveRow(u)">
              {{ isBusy('patch', u.id) ? '保存中…' : '保存改动' }}
            </button>

            <label class="us__f">新口令
              <input v-model="line(u).password" type="password" autocomplete="new-password" placeholder="至少 8 位">
            </label>
            <button class="adm__btn" :disabled="isBusy('password', u.id)" @click="askPassword(u)">重置口令</button>

            <span class="us__meta">
              建号 {{ timeText(u.createdAt) }} ｜ 最后登录 {{ timeText(u.lastLoginAt) }}
            </span>
          </div>

          <!-- 重置口令的二次确认：口令是凭据，改完旧的就作废，要说出来 -->
          <div v-if="confirming && confirming.kind === 'password' && confirming.id === u.id" class="sl__confirm">
            <span>
              把 <b>{{ u.username }}</b> 的口令换成你刚输入的那一串？旧口令立刻不能用（已经登录的会话也会在下次请求失效）。
              这件事会记进参数审计。口令本身不会以任何形式回显或写进日志。
            </span>
            <span class="pl__spacer" />
            <button class="adm__btn" :disabled="isBusy('password', u.id)" @click="doPassword(u)">
              {{ isBusy('password', u.id) ? '重置中…' : '确认重置' }}
            </button>
            <button class="adm__btn adm__btn--ghost" @click="cancelConfirm">取消</button>
          </div>
        </li>
      </ul>

      <p class="sl__note">
        停用是常规手段，删除带守卫（名下有方案、版本、分享或参数改动就不许删，改成停用）。
        两条自保：不能停用或删除自己；不能把最后一名管理员停用、降档或删除。
        账号与口令不进仓库 —— 初始口令由管理员用一次性命令设置（见 docs/80 §五第5项）。
      </p>
    </template>
  </div>
</template>
