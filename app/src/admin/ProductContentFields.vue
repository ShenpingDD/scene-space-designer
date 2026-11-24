<script setup>
/**
 * 产品信息里的「卖点 / 参数」字段（验收-2）。
 *
 * 为什么单独抽出来：它们属于产品信息，必须和简介/系列/来源链接一起在第 1 步维护；
 * 标注看板只负责热点。向导第 1 步与产品库编辑页共用同一份渲染，避免两处上限/文案漂移。
 * 纯展示 + 对传入 content 的数组做编辑；真正的校验与落库在 wizard.js / hotspot-edit.js。
 */
import { HOTSPOT_LIMITS } from './hotspot-edit.js';

const props = defineProps({
  content: { type: Object, required: true },
});
const content = props.content;

function addSelling() {
  if (content.sellingPoints.length < HOTSPOT_LIMITS.sellingPoints) content.sellingPoints.push('');
}
function removeSelling(i) {
  content.sellingPoints.splice(i, 1);
}
function addParam() {
  if (content.params.length < HOTSPOT_LIMITS.params) content.params.push({ key: '', value: '', unit: '', group: '' });
}
function removeParam(i) {
  content.params.splice(i, 1);
}
</script>

<template>
  <div class="pcf" data-product-content-fields>
    <div class="pcf__head">
      <b>卖点 <span class="pcf__n">{{ content.sellingPoints.length }}/{{ HOTSPOT_LIMITS.sellingPoints }}</span></b>
      <button class="adm__btn adm__btn--tiny" type="button" :disabled="content.sellingPoints.length >= HOTSPOT_LIMITS.sellingPoints"
        data-pcf-add-selling @click="addSelling">＋ 卖点</button>
    </div>
    <p class="pcf__hint">每条 ≤200 字；没有就留空，不编造。</p>
    <div v-for="(s, i) in content.sellingPoints" :key="'sp' + i" class="pcf__row">
      <input v-model="content.sellingPoints[i]" maxlength="200" :aria-label="'卖点 ' + (i + 1)"
        data-pcf-selling :placeholder="'卖点 ' + (i + 1)">
      <button class="adm__btn adm__btn--tiny" type="button" :aria-label="'删除卖点 ' + (i + 1)" @click="removeSelling(i)">×</button>
    </div>

    <div class="pcf__head pcf__head--gap">
      <b>参数 <span class="pcf__n">{{ content.params.length }}/{{ HOTSPOT_LIMITS.params }}</span></b>
      <button class="adm__btn adm__btn--tiny" type="button" :disabled="content.params.length >= HOTSPOT_LIMITS.params"
        data-pcf-add-param @click="addParam">＋ 参数</button>
    </div>
    <p class="pcf__hint">参数名必填；单位可空。最多 50 条，空行保存时会被丢掉。</p>
    <div v-for="(p, i) in content.params" :key="'p' + i" class="pcf__param">
      <input v-model="p.key" maxlength="40" placeholder="参数名" :aria-label="'参数 ' + (i + 1) + ' 名称'" data-pcf-param-key>
      <input v-model="p.value" maxlength="200" placeholder="值" :aria-label="'参数 ' + (i + 1) + ' 值'" data-pcf-param-value>
      <input v-model="p.unit" maxlength="16" placeholder="单位" :aria-label="'参数 ' + (i + 1) + ' 单位'" data-pcf-param-unit>
      <input v-model="p.group" maxlength="40" placeholder="分组" :aria-label="'参数 ' + (i + 1) + ' 分组'" data-pcf-param-group>
      <button class="adm__btn adm__btn--tiny" type="button" :aria-label="'删除参数 ' + (i + 1)" @click="removeParam(i)">×</button>
    </div>
  </div>
</template>

<style scoped>
.pcf { margin-top: 10px; }
.pcf__head { display: flex; align-items: center; gap: 8px; }
.pcf__head--gap { margin-top: 14px; }
.pcf__n { color: var(--ink-3); font-weight: 400; font-size: 11px; }
.pcf__hint { margin: 3px 0 6px; color: var(--ink-3); font-size: 11px; }
.pcf__row, .pcf__param { display: flex; gap: 6px; margin-bottom: 6px; }
.pcf__row input { flex: 1; min-width: 0; }
.pcf__param input { flex: 1; min-width: 0; }
.pcf__param input:nth-child(2) { flex: 2; }
</style>
