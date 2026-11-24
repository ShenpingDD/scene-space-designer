<script setup>
/**
 * SchemeCard —— 一张方案卡片（维护端方案库与「我的方案」共用这一份模板）
 *
 * ## 为什么抽出来
 * 两个页面的卡片长得必须一样（同一份方案在两处显示成两个样子，读的人会以为在看两份东西）。
 * 卡片是**纯展示**：它不认识接口、也不发请求，动作一律 emit 给外面 ——
 * 于是"写库的那几个动作"只需要在 `admin/schemeActions.js` 里实现一份。
 *
 * ## 三个硬规矩（跟着卡片走）
 * ① **缺数据不补**：封面 / 人名 / 台数 / 型号在老数据上就是空的 → 占位与「—」，不假渲不补名；
 * ② **角标要能问**：`title` 里必须有「为什么判它是这样」；
 * ③ **不可逆的动作要二次确认**，确认框里说清后果（删除进回收站、回滚会先自动留存当前那一版）。
 */
import { computed } from 'vue';
import { cardOf, historyNote } from '../admin/schemes.js';
import { denyText } from '../admin/roles.js';

const props = defineProps({
  /** 接口给的那一行原始数据（卡片要显示的东西由 `cardOf` 汇总，不在模板里算） */
  row: { type: Object, required: true },
  /** `library`（方案库）| `trash`（回收站）—— 两半的动作不同 */
  view: { type: String, default: 'library' },
  /** 能不能改方案（后端 `AdminGate.canWriteSchemes` 的结果）。灰按钮 + 说明为什么，不隐藏 */
  canWrite: { type: Boolean, default: false },
  /** 角色码，只说人话用 */
  role: { type: String, default: '' },
  /** 正在写库的动作 `<动作>:<id>`（只关相关按钮，不整页禁用） */
  busy: { type: String, default: '' },
  /** 二次确认：`{kind:'delete'|'rollback', id, ...}` */
  confirming: { type: Object, default: null },
  /** 展开的版本历史：`{id, phase, rows, currentRev, trouble}` */
  drawer: { type: Object, default: null },
  /** 要不要显示归属人（维护端要，我的方案不必 —— 那里每一份都是自己的） */
  showOwner: { type: Boolean, default: false },
});

const emit = defineEmits(['open', 'ask-delete', 'ask-rollback', 'cancel', 'delete', 'restore', 'duplicate', 'rollback', 'toggle-history']);

const c = computed(() => cardOf(props.row));

const writeWhy = computed(() => (props.canWrite ? '' : denyText('writeSchemes', props.role)));
const isBusy = (kind, id) => props.busy === kind + ':' + id;

/** 「最近谁改的」这一列的解释（`cardOf` 已经把 id 翻成人话，这里只说为什么长这样） */
const actorWhy = (card) => (card.actor === '—'
  ? '这份方案还没有「最近谁改的」记录（老数据的 updated_by 是空的 —— 空就是空，不补人名）'
  : '最近一次改动由 ' + card.actor + ' 提交（库里存的是 id，不是人名）');
</script>

<template>
  <article class="scard" :class="{ 'is-deleted': c.deleted }">
    <!-- 封面：**有就显示真图，没有就占位，绝不假渲一张**（docs/36 §4.4）。
         URL 里带 `coverChecksum` 当缓存键：文件名固定、封面会互相覆盖，
         没有它就是"用户换了封面却一直看旧图"（见 schemes.js 的 coverUrl）。 -->
    <span class="scard__cover" :title="c.coverTitle">
      <img
        v-if="c.coverUrl"
        :src="c.coverUrl"
        :alt="'封面：' + (c.name || '未命名方案')"
        class="scard__img"
        loading="lazy"
      >
      <span v-else class="scard__ph">无封面</span>
    </span>

    <div class="scard__body">
      <div class="scard__top">
        <b>{{ c.name || '（未命名）' }}</b>
        <span class="pcard__model">#{{ c.id }} · rev {{ c.rev }}</span>
        <span class="pcard__tag" :title="'状态码 ' + (c.statusCode || '（空）')">{{ c.statusLabel }}</span>
      </div>

      <div class="pcard__meta">
        <span class="pcard__dim">{{ c.sizeText }}</span>
        <span class="pcard__tag" :title="c.itemCount === null ? '列表接口没给台数' : '设备台数'">
          {{ c.itemCount === null ? '台数 —' : c.itemCount + ' 台' }}
        </span>
        <span class="pcard__tag" :title="c.modelCount === null ? '列表接口没给型号清单，算不出型号数' : '用到的型号数'">
          {{ c.modelCount === null ? '型号 —' : c.modelCount + ' 个型号' }}
        </span>
        <span class="pcard__tag pcard__tag--by" :title="actorWhy(c)">改：{{ c.actor }}</span>
        <span v-if="showOwner" class="pcard__tag pcard__tag--by" :title="c.ownerWhy">归属：{{ c.owner }}</span>
        <span class="pcard__tag" title="最近更新时间">更新于 {{ c.updatedText }}</span>
        <span v-for="t in c.tags" :key="t" class="pcard__tag" title="标签">{{ t }}</span>
      </div>

      <!-- 角标：title 带 why —— 判据必须能被问出来，否则管理员只能选择不信 -->
      <div class="pcard__badges">
        <span class="badge" :class="'badge--' + c.audit.level" :title="c.audit.why">{{ c.audit.text }}</span>
        <span class="pl__spacer" />

        <template v-if="view === 'trash'">
          <button
            class="adm__btn sl__act"
            :disabled="isBusy('restore', c.id) || !canWrite"
            :title="writeWhy || '把这一份放回方案库（版本号不变 —— 恢复不是一次内容编辑）'"
            @click="emit('restore', c.id)"
          >{{ isBusy('restore', c.id) ? '恢复中…' : '恢复' }}</button>
        </template>

        <template v-else>
          <button class="adm__btn sl__act" title="在版本历史里选一版回滚（回滚前会自动留存当前那一版）" @click="emit('toggle-history', c)">
            {{ drawer && drawer.id === c.id ? '收起版本' : '版本历史' }}
          </button>
          <button
            class="adm__btn sl__act"
            :disabled="isBusy('duplicate', c.id) || !canWrite"
            :title="writeWhy || '照这一份当前这一版拷一份新的（状态回到草稿、不带封面与标签）'"
            @click="emit('duplicate', c.id)"
          >{{ isBusy('duplicate', c.id) ? '复制中…' : '复制一份' }}</button>
          <button
            class="adm__btn sl__act sl__act--danger"
            :disabled="isBusy('delete', c.id) || !canWrite"
            :title="writeWhy || '放进回收站（软删，可恢复）'"
            @click="emit('ask-delete', c.id)"
          >删除</button>
          <button class="adm__btn sl__open" title="在设计器里打开这一份继续编辑" @click="emit('open', c.id)">
            继续编辑 →
          </button>
        </template>
      </div>

      <!-- 删除的二次确认：说清后果（进回收站、可恢复），只问一句"确定吗"等于没说 -->
      <div v-if="confirming && confirming.kind === 'delete' && confirming.id === c.id" class="sl__confirm">
        <span>把 <b>#{{ c.id }}</b> 放进回收站？它在前台与方案库里就不再出现了，但<b>没有真删掉</b>，在「回收站」里可以恢复。</span>
        <span class="pl__spacer" />
        <button class="adm__btn sl__act--danger" :disabled="isBusy('delete', c.id)" @click="emit('delete', c.id)">
          {{ isBusy('delete', c.id) ? '删除中…' : '确认删除' }}
        </button>
        <button class="adm__btn adm__btn--ghost" @click="emit('cancel')">取消</button>
      </div>

      <!-- 回滚的二次确认：把「变成什么样」与「当前那版会先留存」都说出来（后者是拍板 A1） -->
      <div v-if="confirming && confirming.kind === 'rollback' && confirming.id === c.id" class="sl__confirm">
        <span>{{ confirming.text }}</span>
        <span class="pl__spacer" />
        <button
          class="adm__btn"
          :disabled="isBusy('rollback', c.id)"
          @click="emit('rollback', { id: confirming.id, targetRev: confirming.targetRev, expectRev: confirming.expectRev })"
        >{{ isBusy('rollback', c.id) ? '回滚中…' : '确认回滚' }}</button>
        <button class="adm__btn adm__btn--ghost" @click="emit('cancel')">取消</button>
      </div>

      <!-- 版本历史：每一版都写清"它长什么样"——回滚是个必须做的选择，不能只有编号 -->
      <div v-if="drawer && drawer.id === c.id" class="sl__revs">
        <p v-if="drawer.phase === 'loading'" class="pl__msg">正在取版本历史…</p>
        <p v-else-if="drawer.phase === 'fail'" class="pl__msg pl__msg--bad">
          取不到版本历史：<span class="adm__mono">{{ drawer.trouble }}</span>
        </p>
        <template v-else>
          <!-- 历史完整性：缺哪一版就说缺哪一版（老方案真的缺，不补） -->
          <p class="sl__revs-note">{{ historyNote(drawer.rows, drawer.currentRev) }}</p>
          <ul class="sl__revs-list">
            <li v-for="r in drawer.rows" :key="r.rev" class="sl__rev" :class="{ 'is-current': r.isCurrent }">
              <span class="sl__rev-no">第 {{ r.rev }} 版</span>
              <span class="sl__rev-dim">{{ r.sizeText }}</span>
              <span class="sl__rev-dim">{{ r.itemCount === null ? '台数 —' : r.itemCount + ' 台' }}</span>
              <span class="sl__rev-dim">{{ r.modelCount === null ? '型号 —' : r.modelCount + ' 个型号' }}</span>
              <span class="sl__rev-time">{{ r.createdText }}</span>
              <span class="sl__rev-note" :title="r.note || '（没有版本说明）'">{{ r.note || '（没有版本说明）' }}</span>
              <span class="pl__spacer" />
              <span v-if="r.isCurrent" class="pcard__tag" title="这一版就是当前版本，没有需要回滚的东西">当前版本</span>
              <button
                v-else
                class="adm__btn sl__act"
                :disabled="isBusy('rollback', c.id)"
                title="把内容换成这一版（会先自动留存当前那一版，不会丢）"
                @click="emit('ask-rollback', c, r)"
              >回滚到这一版</button>
            </li>
          </ul>
        </template>
      </div>
    </div>
  </article>
</template>
