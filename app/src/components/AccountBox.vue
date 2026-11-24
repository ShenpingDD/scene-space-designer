<script setup>
/**
 * AccountBox —— 顶栏上的账号块（设计端顶栏、首页、我的方案、维护端共用）
 *
 * ## 为什么要显示"我是谁"
 * U1 起方案按登录账号归属、权限按角色判定。用户看不到自己在用哪个账号，
 * 就分不清"这份方案是哪来的""为什么这个按钮点不动"。
 *
 * ## 一块整按钮，菜单里只有「退出登录」
 * 头像、显示名、角色、箭头合成一个按钮（`docs/83` §七第 1、2 条）：整块点击弹出，
 * 点页面别处或按 Esc 收起。退出是这一页唯一的账号动作，菜单里不放第二项。
 *
 * ## 退出登录失败要说出来
 * 服务端没回应时本机照样退出（否则用户被困在一个他不确定属于谁的会话里），
 * 但界面上要写清「服务端会话可能还在」—— 装作一切都好是不诚实的。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { go } from '../router.js';
import { ROLE_LABEL } from '../admin/roles.js';
import { me, signOut, user } from '../session.js';

const busy = ref(false);
const trouble = ref('');
const open = ref(false);
const box = ref(null);

const name = computed(() => {
  const u = user.value || {};
  return String(u.displayName || u.username || '').trim() || '（未命名账号）';
});
/** 头像里的那一个字：没有头像图时用显示名的第一个字 */
const initial = computed(() => {
  const u = user.value || {};
  const s = String(u.displayName || u.username || '').trim();
  return s ? s.charAt(0) : '?';
});
const roleCode = computed(() => String((user.value && user.value.roleCode) || (me.value && me.value.roleCode) || '').trim());
const roleLabel = computed(() => ROLE_LABEL[roleCode.value] || roleCode.value);

const who = computed(() => {
  const parts = ['登录账号：' + name.value];
  const account = String((user.value && user.value.username) || '').trim();
  if (account && account !== name.value) parts.push('登录名 ' + account);
  if (roleCode.value) parts.push('角色码 ' + roleCode.value);
  return parts.join(' ｜ ');
});

function toggle() {
  open.value = !open.value;
}

function close() {
  open.value = false;
}

function onPointer(e) {
  if (box.value && !box.value.contains(e.target)) close();
}

function onKey(e) {
  if (e.key === 'Escape') close();
}

onMounted(() => {
  document.addEventListener('pointerdown', onPointer);
  document.addEventListener('keydown', onKey);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onPointer);
  document.removeEventListener('keydown', onKey);
});

async function leave() {
  if (busy.value) return;
  busy.value = true;
  const why = await signOut();
  busy.value = false;
  close();
  if (why) {
    trouble.value = why;
    return;
  }
  go('/login');
}
</script>

<template>
  <span ref="box" class="acct">
    <button
      class="acct__chip"
      type="button"
      :title="who"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="acct__avatar" aria-hidden="true">{{ initial }}</span>
      <span class="acct__who">
        <span class="acct__name">{{ name }}</span>
        <span v-if="roleCode" class="acct__role">{{ roleLabel }}</span>
      </span>
      <span class="acct__caret" aria-hidden="true">⌄</span>
    </button>

    <span v-if="open" class="acct__menu" role="menu">
      <button class="acct__item" type="button" role="menuitem" :disabled="busy" @click="leave">
        {{ busy ? '退出中…' : '退出登录' }}
      </button>
    </span>
  </span>

  <span v-if="trouble" class="acct__trouble" role="status">
    退出登录时后端没回应（{{ trouble }}）—— 本机已经退出，服务端那个会话可能还在。
  </span>
</template>
