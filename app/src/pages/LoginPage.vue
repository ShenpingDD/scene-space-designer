<script setup>
/**
 * LoginPage —— 登录页（`/login`，免登录）
 *
 * ## 只做三件事
 * 收账号与密码、说出失败原因、登录成功后把用户送回**他原本要去的地方**。
 *
 * ## 版面
 * `docs/82` 的元素清单：左上角品牌区（组合标）、整幅背景图、画面中央的登录卡（宽 400）。
 * 样式在 `login.css`，两张图放在 `assets/login/`。
 *
 * ## 回跳参数是攻击面
 * `?redirect=` 的值只有站内相对路径会被采用（`guard.js` 的 `safeRedirect`）——
 * 否则一条 `/login?redirect=https://evil.com` 的链接就能在输完密码之后把人送去站外。
 * 这里不自己判断，**只调用那一个函数**：判断写两处，改漏一侧不会报错。
 *
 * ## 两句话按 query 分开说
 * `?reason=expired`：会话过期被请回来的（`api.js` 只在**登录过**的人身上带这个参数），
 * 说「会话已过期，请重新登录」；`?redirect=`：登录后会回到原来要去的页面，也要明说一句 ——
 * 否则用户不知道为什么登录完不是首页，也不知道该不该照原路走。
 */
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api.js';
import { go } from '../router.js';
import { loginFailText, safeRedirect } from '../guard.js';
import { authTrouble, signedIn } from '../session.js';
import './login.css';

const route = useRoute();

const username = ref('');
const password = ref('');
const busy = ref(false);
const fail = ref('');

/** 登录后要去的地方。参数名与校验只有 `guard.js` 那一处 */
const back = computed(() => safeRedirect(route.query.redirect));
/** 会话过期被请回来的（这两句话是端到端判据盯着的稳定文案，不要改字） */
const expired = computed(() => String(route.query.reason || '') === 'expired');
/** 带着回跳地址来的：说清登录之后不是停在首页 */
const hasBack = computed(() => String(route.query.redirect || '').trim() !== '');

async function submit() {
  if (busy.value) return;
  fail.value = '';
  if (!username.value.trim() || !password.value) {
    fail.value = '账号和密码都要填。';
    return;
  }
  busy.value = true;
  try {
    const r = await api.login(username.value.trim(), password.value);
    await signedIn(r && r.user);
    go(back.value);
  } catch (e) {
    fail.value = loginFailText(e && e.reason, e && e.message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="login">
    <!-- 左上角品牌区：整张横版组合标（图形与中英文名称都在这张图里） -->
    <div class="login__brand">
      <img src="../assets/brand/brand-mark.png" alt="场景空间设计器 · Scene Space Designer">
    </div>

    <main class="login__stage">
      <form class="login__card" :aria-busy="busy" @submit.prevent="submit">
        <h1 class="login__title">登录</h1>

        <!-- 会话过期被请回来的：先说清"为什么又要登录"，否则用户以为是自己点错了 -->
        <p v-if="expired" class="login__status" role="status">会话已过期，请重新登录</p>
        <!-- 带着回跳地址来的：说清登录之后不是停在首页 -->
        <p v-if="hasBack" class="login__status" role="status">登录后会回到你原来要去的页面</p>

        <div class="login__field">
          <label for="login-username">账号</label>
          <input
            id="login-username"
            v-model="username"
            type="text"
            name="username"
            placeholder="请输入账号"
            autocomplete="username"
            autocapitalize="off"
            spellcheck="false"
            :disabled="busy"
          >
        </div>

        <div class="login__field">
          <label for="login-password">密码</label>
          <input
            id="login-password"
            v-model="password"
            type="password"
            name="password"
            placeholder="请输入密码"
            autocomplete="current-password"
            :disabled="busy"
          >
        </div>

        <button class="login__submit" type="submit" :disabled="busy">
          {{ busy ? '登录中…' : '登录' }}
        </button>

        <!-- 失败要说清是哪一种失败：密码不对重输、账号停用找管理员、连不上后端去起服务 -->
        <p v-if="fail" class="login__alert" role="alert">{{ fail }}</p>

        <!-- 会话问不到（后端不通这类）也要说出来，不能只显示一个空的登录框 -->
        <p v-if="authTrouble" class="login__alert">还没问到当前会话：{{ authTrouble }}</p>
      </form>
    </main>
  </div>
</template>
