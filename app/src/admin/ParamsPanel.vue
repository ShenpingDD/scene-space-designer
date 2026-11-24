<script setup>
/**
 * ParamsPanel —— 维护端「参数配置」页（R6-4 B4b）
 *
 * ## 这一页只做两件事
 * ① **把规则摆出来**：12 组 64 项，每项名字、当前值、单位、允许范围、出厂值、说明，
 *    以及**为什么某一项改不了**（那一项不许只给个灰框）。
 * ② **发布**（不是"边改边生效"）：改完点了发布才落库；发布的是**只有改过的那几项**。
 *
 * ## 三条纪律（都是这个项目里出过代价的）
 * - **只发改过的项**：整份提交等于"我没动过的项也由我确认了一遍"，会把别人刚改的值盖回去。
 * - **不让改的项要说出原因**，而且**后端也会拒**（界面禁用不算保证）。
 * - **发布失败时把后端那句话原样显示**：「参数不合法」四个字没用，
 *   `door.openOkDeg（绿灯阈值）超出范围：200 不在 0~180° 之间` 才让人知道改哪儿。
 *
 * ## 发布要写一句"为什么改"
 * 参数发布只有 1-2 个人做，但改动会影响所有前台判定。审计要能回答
 * 「上周四门开度从 90 改成 85 是谁、为什么」—— 所以按钮上直接写明"要写一句为什么"，
 * 没写就不让点（这是个刻意的摩擦，只有这一处）。
 *
 * ## 这一页不自己算任何业务判断
 * 分栏、只出改动项、自检、回执、错误话术全在 `admin/params.js`（纯函数，有单测）；
 * "现在按哪一版在算"整句在 `paramsText.js`（唯一出处）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';
import { denyText } from './roles.js';
import { state as live } from '../liveParams.js';
import { liveLine, originLine } from '../paramsText.js';
import {
  formRows, groupRows, rangeText, isDirty, dirtyRows,
  draftPatch, draftProblems, publishDoneText, problemLines,
} from './params.js';

const loading = ref(true);
const trouble = ref('');
const schema = ref(null);
const values = ref({});
const origin = ref('');
const changed = ref(0);
const rev = ref(null);
const canPublish = ref(false);

/**
 * 角色码（来自外壳的 `/api/admin/me`）。
 *
 * 只说人话用：按钮被挡住时要讲清「你是什么角色 / 这件事要谁才能做」——
 * "你没有权限"那句话对用户没有信息量，而这个门是来挡误操作的（认证还没接，见 AdminGate）。
 */
const props = defineProps({
  role: { type: String, default: '' },
});
const roleCode = ref('');
const note = ref('');
const busy = ref(false);
const result = ref(null);

/** 草稿：`path → 输入框里的字符串`。**没进这个表 = 那一项没动过** */
let drafts = reactive({});

const rows = computed(() => (schema.value ? formRows(schema.value, values.value) : []));
const groups = computed(() => (schema.value ? groupRows(schema.value, rows.value) : []));
const dirty = computed(() => dirtyRows(rows.value, drafts));
const problems = computed(() => draftProblems(rows.value, drafts));
/**
 * 能不能发布：有改动 + 有权限 + 不忙。
 *
 * ⚠️ **备注曾经是必填**（"发布必须写一句为什么改"），2026-09-29 用户拍板**取消这个摩擦**（A19）：
 * 它挡的是"改的时候多想一秒"，但真正会为此停手的人，本来就会写；
 * 而被打断的人只会随手敲两个字，反而弄脏审计。
 * 所以**备注改成选填**，但审计里仍然留着它 —— 写的人还是会把话写在这里（见 设计决策记录）。
 */
/**
 * 能不能发布（R6-4 B4e）：**先看角色**（后端的能力表），再看有没有改动、在不在忙。
 *
 * ⚠️ 三个条件缺一不可，而且都要能说清是哪一条不满足 —— 灰色按钮上 hover 出的那句
 *    `publishWhy` 就是回答这件事的（不许让用户对着一个不动的按钮猜）。
 */
const canPublishNow = computed(() => canPublish.value && dirty.value.length > 0 && !busy.value);

/** 发布按钮当前为什么不能用（能用的那一条要在界面上直接说，所以这里返回空串） */
const publishWhy = computed(() => {
  if (!canPublish.value) return denyText('publishParams', props.role);
  if (!dirty.value.length) return '还没有任何改动 —— 先在下面把要改的那一项改掉';
  if (busy.value) return '正在发布，稍等一下';
  return '';
});

function draftOf(r) {
  // 同上：**读值**（get 陷阱会被追踪），不要用 hasOwnProperty 查键 ——
  // 那样输入框自己就不会跟着草稿重画（回滚/放弃改动之后会留在旧字上）。
  const v = drafts[r.path];
  return v === undefined ? r.now : v;
}

function onInput(r, ev) {
  drafts[r.path] = ev.target.value;
}

function toDefault(r) {
  drafts[r.path] = String(r.def);
}

function revert() {
  drafts = reactive({});
  result.value = null;
}

/**
 * 取规格 + 当前值 + 我能不能改。
 *
 * ⚠️ **转圈必须有人关，而且成功失败两条路都要关** —— 第一版这里写反了：
 * （`if (kind !== 'manual') loading.value = false;`）于是首次加载（kind = 'manual'）
 * 永远停在「正在读参数…」，而 `catalog.js` 的注释里恰好写着这条坑。
 * 探针第一条断言（要看到 8 栏）当场把它抓了出来。
 */
async function load(kind) {
  if (kind === 'manual') loading.value = true;
  trouble.value = '';
  try {
    const [p, w] = await Promise.all([api.params(), api.paramsWhoami()]);
    schema.value = p.schema;
    values.value = p.values || {};
    origin.value = p.origin || '';
    changed.value = typeof p.changed === 'number' ? p.changed : 0;
    rev.value = p.rev;
    canPublish.value = !!(w && w.canPublish);
    roleCode.value = (w && w.roleCode) || '';
  } catch (e) {
    trouble.value = (e && (e.reason || e.message)) || '未知原因';
  } finally {
    loading.value = false;          // ← 两条路都关（成功、失败、以及"抛了个别的错"）
  }
}

async function publish() {
  busy.value = true;
  result.value = null;
  const { patch, changed: paths } = draftPatch(rows.value, drafts);
  try {
    const res = await api.publishParams(patch, note.value.trim());
    result.value = { ok: true, text: publishDoneText(res), changed: paths };
    note.value = '';
    drafts = reactive({});
    await load();
  } catch (e) {
    const data = (e && e.data) || { message: (e && e.message) || '发布失败' };
    result.value = { ok: false, lines: problemLines(data) };
  } finally {
    busy.value = false;
  }
}

onMounted(() => load('manual'));
</script>

<template>
  <div class="pp">
    <div v-if="loading" class="pp__center">
      <h2>正在读参数…</h2>
      <p class="pp__muted">向 `GET /api/params` 要规格与当前值。</p>
    </div>

    <!-- 读不到就必须说话，且给出原因（不许显示成"没有参数"） -->
    <div v-else-if="trouble" class="pp__center">
      <h2>读不到参数</h2>
      <p class="pp__mono pp__muted">{{ trouble }}</p>
      <p class="pp__muted">参数存在后端的 `app_config` 表里，后端不通时这一页读不到任何东西。</p>
      <button class="pp__btn" @click="load('manual')">重试</button>
    </div>

    <template v-else>
      <p class="pp__meta">
        {{ originLine(origin, changed) }}
        <span class="pp__sep">｜</span>参数版本（指纹）<code>{{ rev }}</code>
      </p>
      <p class="pp__live">{{ liveLine(live, rev) }}</p>

      <div v-if="!canPublish" class="pp__gate">
        <b>当前角色 <code>{{ roleCode || '（空）' }}</code> 只能看，不能发布。</b>
        发布参数只给 <code>admin</code>（拍板：参数改动不做审批流，但发布要留痕）。
        这一道门在后端守着，界面只是把按钮关掉。
      </div>

      <div class="pp__bar">
        <span class="pp__count" :class="{ 'is-dirty': dirty.length }">
          改了 <b>{{ dirty.length }}</b> 项{{ dirty.length ? '（下面高亮的就是）' : '' }}
        </span>
        <input
          v-model="note"
          class="pp__note"
          :disabled="!canPublish"
          placeholder="为什么改（选填，会进审计）"
          title="审计要能回答「谁、什么时候、把这一项从多少改成多少」；写了原因的话它也会一起留在审计里"
        />
        <button
          class="pp__btn pp__btn--go"
          :disabled="!canPublishNow"
          :title="publishWhy || '发布这几项（改动会写进审计：谁、什么时候、把哪一项从多少改成多少）'"
          @click="publish"
        >{{ busy ? '发布中…' : '发布' }}</button>
        <button class="pp__btn pp__btn--ghost" :disabled="!dirty.length || busy" @click="revert">放弃改动</button>
        <button class="pp__btn pp__btn--ghost" :disabled="busy" @click="load('manual')">重新读参数</button>
      </div>

      <!-- 发布前自检：**不是裁判**，只为省一次白跑的往返；界面自己写明这一点 -->
      <div v-if="problems.length" class="pp__problems">
        <b>发布前自检发现 {{ problems.length }} 处问题</b>
        <span class="pp__muted">（最终以后端校验为准）</span>
        <ul>
          <li v-for="(p, i) in problems" :key="i"><code>{{ p.path }}</code> {{ p.message }}</li>
        </ul>
      </div>

      <div v-if="result" class="pp__result" :class="result.ok ? 'pp__result--ok' : 'pp__result--bad'">
        <template v-if="result.ok">
          <b>发布成功。</b><span>{{ result.text }}</span>
        </template>
        <template v-else>
          <b>发布被拒（一处都没写）。</b>
          <ul>
            <li v-for="(l, i) in result.lines" :key="i">
              <code v-if="l.path">{{ l.path }}</code> {{ l.message }}
            </li>
          </ul>
        </template>
      </div>

      <section v-for="g in groups" :key="g.id" class="pp__group">
        <h3 class="pp__gtitle">
          {{ g.label }}
          <span class="pp__ghelp">{{ g.help }}</span>
        </h3>
        <div
          v-for="r in g.rows"
          :key="r.path"
          class="pp__row"
          :class="{ 'is-locked': !r.editable, 'is-dirty': isDirty(r, drafts) }"
        >
          <label class="pp__label" :for="'p-' + r.path">
            {{ r.label }}<span v-if="r.unit" class="pp__unit">{{ r.unit }}</span>
          </label>
          <input
            :id="'p-' + r.path"
            class="pp__input"
            type="number"
            :step="r.step"
            :min="r.min"
            :max="r.max"
            :disabled="!r.editable || !canPublish"
            :value="draftOf(r)"
            @input="onInput(r, $event)"
          />
          <span class="pp__range" :title="'允许范围'">{{ rangeText(r) }}</span>
          <span class="pp__def" :title="'出厂默认值（代码里那一份）'">出厂 {{ r.def }}</span>
          <button
            v-if="r.editable && canPublish && isDirty(r, drafts)"
            class="pp__reset"
            title="把这一项填回出厂值（还是一项改动，发布后才落库）"
            @click="toDefault(r)"
          >恢复出厂值</button>
          <span class="pp__help">{{ r.help }}</span>
          <span v-if="!r.editable" class="pp__lock">{{ r.lockedNote }}</span>
        </div>
      </section>

      <p class="pp__foot">
        这里改的是服务端判定用的规则（存下来的是这一版参数）。设计器前台每 5 秒问一次版本，
        发布后**已经打开的页面会自动跟上**，并显示一条「后台改了规则参数」的提示 ——
        不会有人在自己没点任何东西的情况下发现判定标准悄悄变了。
      </p>
    </template>
  </div>
</template>