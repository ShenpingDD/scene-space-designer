import { ref } from 'vue';

/**
 * walkMode.js —— 第一人称漫游这一个**共享状态**（很小，但必须只有一份）
 *
 * ## 它为什么存在（FIX-15 那张老账）
 *
 * 原型里的毛病是：漫游时工具栏只是 `pointer-events:none`，**键盘照样能操作** ——
 * 撤销、旋转、导入都会**在漫游者眼皮底下改掉他正在看的场景**。
 * 2026-09-30 逐条重核 `docs/04` 时发现：**新界面把这条老账原样复现了** ——
 * `App.vue` 的撤销/重做/导出快捷键挂在 `window` 上，不看你在不在漫游（当时还没有这个状态）。
 *
 * ⇒ 状态得有人拿着。`View3D` 写（它才知道自己在不在第一人称），`App` 读（快捷键要让路）。
 *
 * ## 为什么是模块级 `ref` 而不是 props
 *
 * `View3D` 是**懒加载**的（three.js 600 KB，不开三维就不下载）—— 用 props 的话，
 * `App` 就得在"还没下载 three.js"的时候也知道漫游状态，那只能再复制一份状态到上层。
 * 两份状态比一个模块级 ref 危险得多（谁更新谁、什么时候更新，没人说得清）。
 */
export const walking = ref(false);

/** 由 `View3D` 在进入/退出第一人称时调用 */
export function setWalking(v) {
  walking.value = !!v;
}

/**
 * 漫游中该不该接这个全局快捷键？
 *
 * 规矩：**漫游里一个全局快捷键都不接**（撤销/重做/导出全是"改场景"的动作）。
 * 退出漫游走 `Esc`（由 3D 自己处理）和漫游条上的按钮，不需要快捷键。
 *
 * 抽成纯函数是为了能断言 —— 组件里的 `if` 测不到，这条规矩就会在下次重构里悄悄丢。
 */
export function shortcutAllowed(walkingNow, _evt) {
  return !walkingNow;
}