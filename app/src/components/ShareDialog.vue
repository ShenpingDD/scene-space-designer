<script setup>
/**
 * ShareDialog —— 「分享方案」**自己的一个弹窗**（只放分享这件事）
 *
 * ## 为什么从"面板里的一块"改成"一个窗"（2026-10-08 用户拍板）
 *
 * 原来点「更多 → 分享方案」实际做的是**打开方案库面板**、再把里面那一块滚到眼前
 * （当时的理由是"同一件事只有一处实现"）。用户看到的是：分享的内容和方案库的内容混在一屏里。
 * 现在按用户的话做成独立弹窗 —— **实现还是只有一处**（这一块从 `ShareBox.vue` 搬了过来，
 * 旧的删掉了，不是"再写一个"）。背后不再顺带打开方案库。
 *
 * ## 开关（用户第二个要求：要开关样式，不要两个按钮）
 *
 * 一个 `role="switch"` 的开关就是**唯一的操作口**：
 *   · 关 → 开：生成一条链接（有效期用当前选的那档）；
 *   · 开 → 关：**撤销**（点第一次变成"确认关闭"，再点才真的关 —— 撤销不可逆）。
 *
 * ⭐ 关掉再打开 = **换一条新口令**（2026-10-08 拍板的规则，`docs/55` §12.2）：
 * 把发出去过的口令"复活"，等于把访问权还给所有拿过它的人，不做这件事。
 *
 * ## 界面上的字，只说三件（用户要求：去掉多余的辅助文字）
 *
 *   ① 这条链接**免登录**这件事本身——用户明确要求**不再写在界面上**（删干净）；
 *   ② 开关现在是什么状态（开关自己说：已打开 / 已关闭）；
 *   ③ 链接 + 二维码 + 复制。
 * 另外留一句「客户看到的永远是**当前**内容」（这是发链接的人**该知道**的事，
 * 而且它以前是写在客户那一页上的 —— 客户不必每次看一遍）。
 *
 * ## 判断全部由服务端说
 *
 * 能不能用 / 过期没 / 撤销没 / 有哪三档有效期 —— 读服务端（`sharesOf` 的
 * `current` / `dayChoices` / `stateText`）。界面不重算、也不自己写一份档位表；
 * 唯一的例外是「还有几天」（服务端算出来的那一刻就旧了）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api.js';
import { denyText } from '../admin/roles.js';
import { absoluteLink, leftText, netHint, switchName, switchText, SEE_CURRENT_TEXT } from '../share.js';
import { qrSvg } from '../qr.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  schemeId: { type: Number, default: null },
  caps: { type: Object, default: null },
  role: { type: String, default: '' },
});
const emit = defineEmits(['close', 'open-library']);

const canWrite = computed(() => (props.caps ? !!props.caps.writeSchemes : null));
const deny = computed(() => (canWrite.value === false ? denyText('writeSchemes', props.role) : ''));

const box = ref(null);
const cur = ref(null);        // 服务端的 current：最新那条（不论死活）
const choices = ref([]);      // 服务端给的三档（7 / 30 / 不过期）
const days = ref(30);
const loaded = ref(false);
const busy = ref(false);
const err = ref('');
const msg = ref(null);        // {ok, text}
const copied = ref('');
const manual = ref('');       // 剪贴板不可用时的兜底：把链接摆出来让人自己选
const replaced = ref('');     // 生成时"旧链接已失效"那句原话（服务端给）
/**
 * 「确认关闭」那一步（用户拍板：关掉要确认一次）。
 * 不做成第二个弹窗（弹窗套弹窗更烦），就地把开关变成"待确认"，再点一次才真关；
 * 走开/改主意都有一条明确的回头路（点「算了」或等它自己过期）。
 */
const confirmOff = ref(false);
let confirmTimer = 0;

const active = computed(() => !!(cur.value && cur.value.ok));
const link = computed(() => (active.value ? absoluteLink(origin(), cur.value.token) : ''));
// 二维码只在有活链接时算（没链接就没得扫）
const qr = computed(() => (link.value ? qrSvg(link.value, { px: 5 }) : null));

function origin() {
  return typeof location === 'undefined' ? '' : location.origin;
}

/**
 * 回环 / 内网地址的提醒（`docs/55` §3.4）—— 保留：它说的是"这条链接别人打不开"，
 * 是**功能**警告（不是安全说教）。规则在 `share.js` 的纯函数里（能单测、能变异验证）。
 */
function netNote() {
  return netHint(origin(), active.value).text;
}

const switchLabel = computed(() => switchText({ active: active.value, confirming: confirmOff.value }));
const switchAria = computed(() => switchName({ active: active.value, confirming: confirmOff.value }));

async function refresh() {
  if (!props.schemeId) return;
  err.value = '';
  try {
    const r = await api.sharesOf(props.schemeId);
    cur.value = r.current || null;
    choices.value = r.dayChoices || [];
    // 默认档位由服务端给（`defaultDays`）；它若不在三档里就退回第一档
    const want = Number(r.defaultDays);
    days.value = choices.value.some((c) => c.days === want)
      ? want
      : (choices.value.length ? choices.value[0].days : 30);
    loaded.value = true;
  } catch (e) {
    // "读不到"与"没有链接"是两件事 —— 不许说成"还没发过任何链接"
    err.value = e?.data?.message || e?.message || '读不到分享状态';
    cur.value = null;
    choices.value = [];
  }
}

function cancelConfirm() {
  confirmOff.value = false;
  if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = 0; }
}

/** 开关：关→开 生成；开→关 先要一次确认 */
function onSwitch() {
  if (busy.value || canWrite.value === false) return;
  if (!active.value) { cancelConfirm(); openShare(); return; }
  if (!confirmOff.value) {
    confirmOff.value = true;
    if (confirmTimer) clearTimeout(confirmTimer);
    // 10 秒不动 = 改主意了（不把"待确认"一直挂在屏幕上）
    confirmTimer = setTimeout(cancelConfirm, 10000);
    return;
  }
  cancelConfirm();
  closeShare();
}

/** 打开分享 = 生成一条新链接（**会先撤掉旧的**，见类注释） */
async function openShare() {
  busy.value = true;
  msg.value = null;
  replaced.value = '';
  try {
    const r = await api.createShare(props.schemeId, days.value);
    replaced.value = r.replacedText || '';
    msg.value = { ok: true, text: '分享已打开 —— 把链接或二维码给要看的人。' };
    await refresh();
  } catch (e) {
    msg.value = { ok: false, text: e?.data?.message || e?.message || '打开分享失败' };
  } finally {
    busy.value = false;
  }
}

/** 关闭分享 = 撤掉当前这条（客户刷新就打不开了） */
async function closeShare() {
  if (!cur.value) return;
  busy.value = true;
  msg.value = null;
  try {
    const r = await api.revokeShare(props.schemeId, cur.value.id, '');
    // 服务端会告诉我们"这次真的撤了"还是"本来就是撤销状态"—— 两种都如实转述
    msg.value = {
      ok: true,
      text: r.changed === false
        ? '这条链接本来就是关闭状态，不需要再关。'
        : '分享已关闭：客户那边刷新就打不开了。',
    };
    await refresh();
  } catch (e) {
    msg.value = { ok: false, text: e?.data?.message || e?.message || '关闭分享失败' };
  } finally {
    busy.value = false;
  }
}

async function copy(text, key) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = key;
    manual.value = '';
    setTimeout(() => { if (copied.value === key) copied.value = ''; }, 2500);
  } catch (e) {
    // 剪贴板在 http 上、或用户没授权时会失败 —— **不能说"已复制"**，把链接摆出来让人手动复制
    copied.value = '';
    manual.value = text;
    msg.value = { ok: false, text: '这个环境不让自动复制 —— 链接已经写在下框里，手动复制一下。' };
  }
}

function fmtAt(iso) {
  return String(iso || '').slice(0, 16).replace('T', ' ');
}

function close() {
  if (busy.value) return;          // 正在生成/撤销：别让"关窗"把现场藏起来
  cancelConfirm();
  emit('close');
}

/** Esc 关窗（弹窗该有的事；掩码点击也关 —— 关掉不会丢任何东西，链接状态在服务端） */
function onKey(e) {
  if (e.key === 'Escape') { close(); }
}

watch(() => props.open, async (v) => {
  if (v) {
    document.addEventListener('keydown', onKey);
    await nextTick();
    box.value?.focus?.();
    await refresh();
  } else {
    document.removeEventListener('keydown', onKey);
    cancelConfirm();
  }
}, { immediate: true });

// 换方案（比如从方案库另开一份）→ 重读这份方案的分享状态
watch(() => props.schemeId, () => { if (props.open) refresh(); });

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
  if (confirmTimer) clearTimeout(confirmTimer);
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sd__mask" @click.self="close()">
      <div ref="box" class="sd" role="dialog" aria-modal="true" aria-labelledby="sd-title" tabindex="-1">
        <div class="sd__head">
          <b id="sd-title" class="sd__title">分享方案</b>
          <span class="sd__hint">只读链接 · 客户打开就能看</span>
          <span class="sd__spacer" />
          <button class="btn btn--ghost" @click="close()">关闭</button>
        </div>

        <p v-if="canWrite === false" class="sp__gate">{{ deny }}</p>
        <p v-else-if="canWrite === null" class="sp__gate sp__gate--unknown">
          没读到你的角色（后端不通或 /admin/me 出错）—— 开关不禁用，拨下去由服务端判定
        </p>

        <!-- 还没有可分享的方案：给一条能走的路，不留死路 -->
        <div v-if="!schemeId" class="sd__need">
          <p>分享要挂在【一份已保存的方案】上 —— 先保存、或从方案库打开一份，再来分享。</p>
          <button class="btn" @click="emit('open-library')">打开方案库</button>
        </div>

        <template v-else>
          <p v-if="err" class="sd__msg is-bad">没读到分享状态（<strong>不是</strong>"还没发过链接"）：{{ err }}</p>
          <p v-else-if="msg" class="sd__msg" :class="msg.ok ? 'is-ok' : 'is-bad'">{{ msg.text }}</p>
          <p v-if="netNote()" class="sd__msg is-bad">{{ netNote() }}</p>

          <!-- 开关：唯一的操作口（用户要求：开关样式，不是两个按钮） -->
          <div class="sd__row">
            <span class="sd__lb">分享</span>
            <button
              class="sd__sw" :class="{ 'is-on': active, 'is-pending': confirmOff }"
              role="switch" :aria-checked="active" :aria-label="switchAria"
              :disabled="busy || canWrite === false" @click="onSwitch()"
            >
              <span class="sd__sw-track" aria-hidden="true"><span class="sd__sw-knob" /></span>
              <span class="sd__sw-text">{{ switchLabel }}</span>
            </button>
          </div>
          <p v-if="confirmOff" class="sd__confirm">
            再点一次开关就真的关闭 —— <strong>关闭后旧链接永久失效</strong>，再打开是【新】的口令。
            <button class="btn btn--ghost" @click="cancelConfirm()">算了</button>
          </p>

          <!-- 关着：选有效期（用户要求：三档保留） -->
          <div v-if="!active" class="sd__row">
            <span class="sd__lb">有效期</span>
            <div class="seg" role="group" aria-label="有效期">
              <button v-for="c in choices" :key="c.days" :aria-pressed="c.days === days"
                      :disabled="busy || canWrite === false" @click="days = c.days">{{ c.text }}</button>
            </div>
          </div>
          <p v-if="!active && cur" class="sd__note">
            上一条链接已经失效（{{ cur.stateText }}）。重新打开会生成<strong>新的</strong>链接 ——
            旧链接永久失效，不会再恢复。
          </p>
          <p v-else-if="!active && loaded" class="sd__note">这份方案还没有分享链接。</p>

          <!-- 开着：链接（点它就是打开）+ 复制 + 二维码。
               ⚠️ 这条分支必须挂在自己的 `v-if="active"` 上，**不许**接在上面那两个 `<p>` 的
               `v-else` 链上 —— 实机踩过：刚开始（`loaded=false`、`active=false`）时
               `v-else` 会成立，于是去读 `cur.expiresAt`，`cur` 还是 null → 整个弹窗渲染崩掉，
               而 Vue 只把它记成一条 warning（页面上什么都不出来，控制台也不亮，
               这正是"点了没反应"的来源）。 -->
          <template v-if="active">
            <div class="sd__row">
              <span class="sd__lb">有效期</span>
              <span class="sd__val">{{ leftText(cur.expiresAt) }}</span>
              <span v-if="cur.expiresAt" class="sd__at">（{{ fmtAt(cur.expiresAt) }}）</span>
            </div>

            <div class="sd__row sd__row--link">
              <a class="sd__link" :href="link" target="_blank" rel="noopener"
                 title="点开就是客户看到的那一页（新标签）">{{ link }}</a>
              <button class="btn" @click="copy(link, 'cur')">
                {{ copied === 'cur' ? '已复制 ✓' : '复制链接' }}
              </button>
            </div>
            <textarea v-if="manual" class="sd__manual" readonly rows="2" :value="manual"></textarea>

            <div class="sd__qr">
              <svg class="sd__qrbox" :viewBox="`0 0 ${qr.extent} ${qr.extent}`"
                   :width="qr.sizePx" :height="qr.sizePx" role="img"
                   :aria-label="`分享二维码，扫码打开：${link}`">
                <rect :width="qr.extent" :height="qr.extent" fill="#ffffff" />
                <path :d="qr.path" fill="#16232c" shape-rendering="crispEdges" />
              </svg>
              <b class="sd__qrlb">手机扫码打开</b>
            </div>

            <p class="sd__cur">{{ SEE_CURRENT_TEXT }}</p>
            <p v-if="replaced" class="sd__msg is-bad">{{ replaced }}</p>
          </template>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 颜色**只用 CSS 变量**（铁律）；这个窗是**独立的一层**（Teleport 到 body），
   所以它的 z-index 要压过方案库面板（面板那一套在 `SchemePanel` 里）。 */
.sd__mask {
  position: fixed; inset: 0; z-index: 60;
  background: rgb(16 26 32 / 42%); display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.sd {
  width: min(620px, 96vw); max-height: min(86vh, 760px); overflow: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
  box-shadow: var(--shadow); padding: 14px 16px 16px;
}
.sd__head { display: flex; align-items: center; gap: 10px; }
.sd__title { font-size: 15px; }
.sd__hint { font-size: 12px; color: var(--ink-3); }
.sd__spacer { flex: 1; }
.sd__need { margin-top: 12px; font-size: 13px; color: var(--ink-2); line-height: 1.7; }
.sd__msg { margin: 8px 0 0; font-size: 12px; color: var(--ink-2); }
.sd__msg.is-ok { color: var(--ok-ink); }
.sd__msg.is-bad { color: var(--bad-ink); }
.sd__row { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.sd__row--link { align-items: flex-start; }
.sd__lb { font-size: 12px; color: var(--ink-2); min-width: 42px; }
.sd__val { font-size: 13px; color: var(--ink); }
.sd__at { font-size: 12px; color: var(--ink-3); font-family: var(--mono); }
.sd__note { margin: 6px 0 0; font-size: 12px; color: var(--ink-2); line-height: 1.6; }
.sd__confirm { margin: 8px 0 0; font-size: 12px; color: var(--bad-ink); line-height: 1.7; }

/* ── 开关（轨道 + 滑块，纯 CSS；`role="switch"` 是它的语义） ── */
.sd__sw { display: inline-flex; align-items: center; gap: 8px; border: 0; background: none;
  padding: 2px 2px 2px 0; cursor: pointer; font-size: 13px; color: var(--ink);
  min-height: 44px; }                     /* 手指 ≥44 px：这条规矩挂在"命中区"上 */
.sd__sw:disabled { cursor: not-allowed; opacity: .6; }
.sd__sw-track { position: relative; width: 46px; height: 26px; border-radius: 999px;
  background: var(--line-2); border: 1px solid var(--line); transition: background .16s ease; flex: none; }
.sd__sw-knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: var(--panel); box-shadow: 0 1px 3px rgb(0 0 0 / 26%); transition: left .16s ease; }
.sd__sw.is-on .sd__sw-track { background: var(--ok); border-color: var(--ok); }
.sd__sw.is-on .sd__sw-knob { left: 22px; }
.sd__sw.is-pending .sd__sw-track { background: var(--warn); border-color: var(--warn); }
.sd__sw-text { white-space: nowrap; }

/* ── 链接（可点：点它就是打开客户那一页）＋ 二维码 ── */
.sd__link { flex: 1; min-width: 220px; font-size: 12px; font-family: var(--mono); color: var(--brand-dark);
  word-break: break-all; line-height: 1.7; text-decoration: underline; padding: 4px 6px;
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--bg); }
.sd__link:hover { border-color: var(--brand); }
.sd__manual { width: 100%; margin-top: 6px; font-size: 12px; font-family: var(--mono); }
.sd__qr { display: flex; align-items: center; gap: 12px; margin-top: 10px;
  border: 1px solid var(--line); border-radius: var(--radius); padding: 8px 10px; background: var(--bg); }
.sd__qrbox { flex: none; border: 1px solid var(--line-2); border-radius: 6px; background: #fff; }
.sd__qrlb { font-size: 13px; color: var(--ink); }
.sd__cur { margin: 8px 0 0; font-size: 12px; color: var(--ink-3); }
.sp__gate { margin: 8px 0 0; font-size: 12px; color: var(--bad-ink); }
.sp__gate--unknown { color: var(--warn-ink); }
</style>