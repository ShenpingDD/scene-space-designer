/**
 * view.js —— 产品列表的**纯计算**（R6-1 Step3）
 *
 * 为什么单独抽出来：维护端列表最有价值的东西是**分诊数字**（几条必须修、几条该修）。
 * 数字算错比界面难看严重得多 —— 管理员会据此决定"今天做什么"。所以它必须是纯函数、
 * 必须能被单测钉住，而不是散在组件的 computed 里"看起来对"。
 *
 * ⚠️ 单位陷阱（写在这里免得后面又混）：**产品**和**角标**是两种单位。
 *   一条产品可以有 2 个角标 —— "2" 到底是 2 条产品还是 2 个角标，读的人一定会猜错。
 *   所以这里统一只产出**产品条数**（管理员动手的单位是"一条产品"），角标只用来筛。
 */

/** 严重度（与后端 AdminBadges 的三个常量逐字对应） */
export const LEVEL = { BAD: 'bad', WARN: 'warn', OFF: 'off' };

/** 筛选档位 */
export const FILTERS = {
  ALL: 'all',
  BAD: 'bad',
  WARN: 'warn',
  OFF: 'off',
};

function has(level, p) {
  return Array.isArray(p && p.badges) && p.badges.some((b) => b && b.level === level);
}

/**
 * 汇总。**全部以"产品条数"为单位**（见文件头注释的单位陷阱）。
 *
 * 容错：空数组、null、残缺对象都要能算 —— 维护端最不该出现的失败是"没数据时白屏或 NaN"。
 */
export function summarize(products) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  return {
    total: list.length,
    bad: list.filter((p) => has(LEVEL.BAD, p)).length,
    warn: list.filter((p) => has(LEVEL.WARN, p)).length,
    off: list.filter((p) => has(LEVEL.OFF, p)).length,
    noModel: list.filter((p) => Array.isArray(p.badges) && p.badges.some((b) => b.text === '无模型')).length,
  };
}

/**
 * 按档位筛出要显示的产品。
 *
 * 注意：**筛选不许静默**。界面必须同时显示"显示 N / 共 M 条"，
 * 否则用户会以为"产品就这么几个"（这正是 判据 5「怕安静」要防的事）。
 */
export function visible(products, filter) {
  const list = Array.isArray(products) ? products.filter(Boolean) : [];
  const f = filter || FILTERS.ALL;
  if (f === FILTERS.ALL) return list;
  return list.filter((p) => has(f, p));
}

/** 产品状态。库里由**人**写的只有这两个值（`draft` 是 LOD 没跑完的内部状态，不是"停用"）。 */
export const STATUS = { ACTIVE: 'active', DISABLED: 'disabled' };

/** 卡片上的状态文字。认不出的值 → 空串（**缺数据不补**：不猜它是启用还是停用）。 */
export function statusLabel(status) {
  const s = status == null ? '' : String(status);
  if (s === STATUS.DISABLED) return '已停用';
  if (s === STATUS.ACTIVE) return '已启用';
  if (s === 'draft') return '未就绪（LOD 没跑完）';
  return '';
}

/** 下一步该切成什么：停用 ↔ 启用。 */
export function nextStatus(status) {
  return String(status) === STATUS.DISABLED ? STATUS.ACTIVE : STATUS.DISABLED;
}

/** 动作按钮的字（动作必须说出它会做什么，不能只写"切换"）。 */
export function statusActionLabel(status) {
  return String(status) === STATUS.DISABLED ? '启用' : '停用';
}

/**
 * 二次确认的正文 —— **两个方向的后果都要说**：
 *   ① 前台目录会在 1 秒内看不到它 / 又能看到它（目录查询是 WHERE status='active'）；
 *   ② 已存的方案与分享链接**不受影响**（它们存的是几何快照，不查目录）。
 * 只说①，用户会以为"停用 = 我把别人的链接搞坏了"；只说②，用户会以为"停用 = 什么都没变"。
 *
 * 另外：`draft` 的产品格外要提醒 —— 它现在**本来就看不到**，直接启用会让一份
 * 没有产物文件的模型出现在前台（这不是"恢复正常"，是"把一个没验完的东西放出去"）。
 */
export function statusConfirmLines(p) {
  const status = p && p.status;
  const name = (p && p.name) || '这一款';
  const to = nextStatus(status);
  const lines = [];
  if (to === STATUS.DISABLED) {
    lines.push('前台型号卡与目录会在 1 秒内看不到「' + name + '」。');
    lines.push('已存的方案与分享链接【照常打开】—— 它们存的是几何快照，不查目录。');
    lines.push('它的内容（尺寸 / 门型 / 变体 / 说明）一条都不改，随时可以再启用。');
  } else {
    lines.push('「' + name + '」会在 1 秒内重新出现在前台目录里。');
    lines.push('已存的方案与分享链接不受影响。');
  }
  if (String(status) === 'draft') {
    lines.push('⚠️ 它现在是「未就绪」（LOD 还没跑完）—— 前台本来就看不到它。'
      + '直接改成启用，会让一份【没有产物文件】的模型出现在前台；确认 LOD 真跑完了再继续。');
  }
  return lines;
}

/** 数据来源档位的说法（memory 档要说清楚"读不到"，不能说成"没有产品"） */
export function storeLabel(store) {
  return store === 'jdbc' ? '数据库' : '无数据库档';
}
