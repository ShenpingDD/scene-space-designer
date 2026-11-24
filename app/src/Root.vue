<script setup>
/**
 * Root —— 唯一的根：公共提示条 + `<router-view>`
 *
 * ## 为什么这一层现在这么薄
 * 「今天显示哪个界面」从手写路由的 `parseRoute` 换成了 vue-router 的路由表（`routes.js`），
 * 订阅地址栏的地方因此只剩 vue-router 自己那一处。这一层留下来的只有挂在**所有界面之上**的东西。
 *
 * ## 参数自动跟新的提示条为什么不挂在公开页上
 * 只读分享页是给客户/交付队看的：我们自己的参数改了没改对他们不是信息，是噪声（而且他们还改不了）。
 * 登录页同理 —— 还没进门的人不需要知道后台参数动过。
 */
import { useRoute } from 'vue-router';
import ParamsNotice from './components/ParamsNotice.vue';

const route = useRoute();
</script>

<template>
  <ParamsNotice v-if="!route.meta.public" />
  <router-view />
</template>
