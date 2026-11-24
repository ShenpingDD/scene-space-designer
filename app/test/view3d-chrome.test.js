/**
 * view3d-chrome.test.js —— 3D 顶栏瘦身 + 底部状态条（验收 1，2026-10-22）
 *
 * 只锁**结构与文案**（不跑像素截图）：
 *   · 统计从顶栏移出、进入底部 `.v3d__views`；
 *   · 底栏 40px，提示单行省略 + 完整 title，统计完整 title；
 *   · 鸟瞰/第一人称（含 stuck 警告）文案在底栏同一块里；
 *   · `.seg` 不参与 flex 收缩、顶栏单行不换行；note 上移到底栏之上。
 * 真机 1280×800 的宽度/offsetTop 读数由 cdp 探针另跑，这里只保证改回去会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const vue = readFileSync(new URL('../src/components/View3D.vue', import.meta.url), 'utf8');

// 注意：模板里还有嵌套的 <template v-if>，必须取**最后一个** </template>（外层）
const template = vue.slice(vue.indexOf('<template>'), vue.lastIndexOf('</template>'));
const style = vue.slice(vue.indexOf('<style scoped>'), vue.lastIndexOf('</style>'));
const script = vue.slice(0, vue.indexOf('<template>'));
const barStart = template.indexOf('<div class="v3d__bar">');
const bar = template.slice(barStart, template.indexOf('\n    </div>', barStart));
const viewsStart = template.indexOf('<div class="v3d__views"');
// 外层 .v3d__views 的闭合在 4 空格缩进；内层 hint 是 6 空格，不会误截
const views = template.slice(viewsStart, template.indexOf('\n    </div>', viewsStart));
const cssRule = (sel) => {
  const i = style.indexOf(`${sel} {`);
  assert.ok(i >= 0, `${sel} 必须有样式规则`);
  return style.slice(i, style.indexOf('}', i));
};

test('顶栏只放操作控件，统计已移出 top bar', () => {
  assert.ok(template.includes('class="v3d__bar"'), '保留 .v3d__bar 类名（旧探针依赖）');
  assert.match(bar, /class="seg"/);
  assert.match(bar, /class="v3d__lod"/);
  assert.match(bar, /重新取景/);
  assert.match(bar, /class="v3d__route"/);
  assert.match(bar, /站到 A 点/);
  assert.ok(!bar.includes('v3d__meter'), '顶栏不许再有统计 .v3d__meter');
  assert.ok(!bar.includes('次绘制'), '顶栏不许再出现统计文案');
  assert.ok(!bar.includes('台 · 模型'), '顶栏不许再出现「N 台 · 模型」');
});

test('底部状态条：40px，左侧 hint + 右侧 meter，均可被探针定位', () => {
  assert.ok(template.includes('class="v3d__views"'), '必须有 .v3d__views');
  assert.ok(views.includes('class="v3d__hint"'), '.v3d__views 里必须有 .v3d__hint');
  assert.ok(views.includes('class="v3d__meter mono"'), '.v3d__views 里必须有 .v3d__meter');
  assert.ok(views.includes(':title="hintTitle"'), 'hint 必须有完整 title');
  assert.ok(views.includes(':title="meterText"'), 'meter 必须有完整 title');
  assert.equal((template.match(/class="v3d__hint"/g) || []).length, 1, '只允许一个 .v3d__hint，不再单独绝对定位');
  const rule = cssRule('.v3d__views');
  assert.match(rule, /height: 40px/);
  assert.match(rule, /bottom: 0/);
});

test('提示文案：鸟瞰完整口径；第一人称沿用 WASD/Shift/Esc/视角/眼高，stuck 并入同一条', () => {
  assert.ok(template.includes('<b>鸟瞰</b> · 左键拖动<b>旋转</b> · <b>右键拖动平移</b> · 滚轮缩放 · <b>双击设备</b>聚焦'));
  for (const bit of ['W A S D / ↑←↓→', 'Shift', 'Esc', '视角', '眼高']) {
    assert.ok(template.includes(bit), `第一人称提示必须保留 ${bit}`);
  }
  assert.match(script, /hintTitle = computed/);
  assert.ok(script.includes('⚠️ 你正站在设备或墙体里面：碰撞已临时关闭，走开一点就会恢复'), 'stuck 警告必须在同一 hint 内');
  assert.ok(script.includes('鸟瞰 · 左键拖动旋转 · 右键拖动平移 · 滚轮缩放 · 双击设备聚焦'), 'hint title 必须是完整鸟瞰文案');
  assert.match(script, /W A S D \/ ↑←↓→ 走动 · Shift 快走 · Esc 解锁鼠标（没锁定时再按一次 = 回鸟瞰）· 视角/);
});

test('统计文案完整，且只来自底部 meter', () => {
  assert.match(script, /meterText = computed/);
  for (const bit of ['台 · 模型', '本帧', '次绘制', '贴图']) {
    assert.ok(script.includes(bit), `统计文案必须保留 ${bit}`);
  }
  assert.ok(!script.match(/<span class="v3d__meter[^>]*>\s*\{\{/), '统计不许回到顶栏模板');
});

test('顶栏不挤压：不换行 + seg flex:none；底栏 hint 单行省略、meter 不缩', () => {
  const barRule = cssRule('.v3d__bar');
  assert.match(barRule, /flex-wrap: nowrap/);
  assert.match(barRule, /white-space: nowrap/);
  assert.match(barRule, /overflow-x: auto/);
  assert.match(cssRule('.seg'), /flex: none/, '.seg 必须 flex:none（曾被压到 2px）');
  // 同高才同 offsetTop：否则 label/button 高度差会让「同一行」只剩肉眼成立
  assert.match(cssRule('.v3d__bar > *'), /height: 28px/);
  const hintRule = cssRule('.v3d__hint');
  assert.match(hintRule, /white-space: nowrap/);
  assert.match(hintRule, /text-overflow: ellipsis/);
  assert.match(hintRule, /overflow: hidden/);
  assert.match(cssRule('.v3d__meter'), /flex: none/);
});

test('漫游状态回灌：walk 期间 200ms 轮询 probe，回鸟瞰/unmount 清 timer 且不叠加', () => {
  assert.match(script, /WALK_REFRESH_MS = 200/);
  assert.match(script, /walkTimer = setInterval\(refresh, WALK_REFRESH_MS\)/);
  assert.match(script, /clearInterval\(walkTimer\)/, '必须 clearInterval');
  // start 先 stop —— 反复进出 walk 不会叠加多个 timer
  const start = script.slice(script.indexOf('function startWalkTimer'), script.indexOf('function startWalkTimer') + 200);
  assert.match(start, /stopWalkTimer\(\)/);
  // 回鸟瞰由 view watcher 清；unmount 也清（精确到多行，别被别处的 start 碰巧满足）
  assert.match(script, /watch\(view, \(v\) => \{[\s\S]*?if \(v === 'walk'\) startWalkTimer\(\);[\s\S]*?else stopWalkTimer\(\);[\s\S]*?\}, \{ immediate: true \}\);/);
  assert.match(script, /onUnmounted\(\(\) => \{\s*alive = false;\s*stopWalkTimer\(\);/);
  // 轮询只 refresh，不重建场景/不碰布局
  const timer = script.slice(script.indexOf('function startWalkTimer'), script.indexOf('function startWalkTimer') + 200);
  assert.ok(!/setLayout/.test(timer), 'timer 不许重建场景');
  // stuck 文案/class 仍由同一 hint 呈现
  assert.match(template, /v3d__hint--stuck/);
  assert.match(script, /⚠️ 你正站在设备或墙体里面/);
});

test('note 浮层上移到底栏之上；walkbar 仍可见', () => {
  assert.match(cssRule('.v3d__note'), /bottom: 54px/);
  assert.ok(template.includes('class="v3d__walkbar"'));
  assert.match(cssRule('.v3d__walkbar'), /position: absolute/);
});
