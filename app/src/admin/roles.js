/**
 * roles.js —— 四档角色在**界面上怎么说**（R6-4 B4e）
 *
 * 为什么单独一个文件（照 `schemes.js` / `wizard.js` / `view.js` 的既有做法）：
 * 「谁不能做什么、为什么」全是**判断**，散在组件的模板里只能"看起来对"。
 * 而这一页最要紧的一句话是**反过来的**：**你进来了，但你不能做这几件事**
 * —— 把入口藏起来（点了没反应、按钮不见了）比明说更坏：用户会以为功能坏了，或者以为自己是管理员。
 *
 * ## 两条纪律
 *
 * 1. **判断权在后端**：`caps` 是 `/api/admin/me` 发下来的整张能力表，这里**只负责把它翻译成人话**。
 *    前端不抄一张"哪个角色能干什么"的对照表 —— 抄了就会在改档位那天改漏一边。
 * 2. **认不得的角色码要说出来**：`roleKnown=false` 时显示「不在四档里，按什么都做不了处理」，
 *    **不许**按 viewer 显示（那会让人以为"至少能看"），也不许假装没这回事。
 */

/** 四档的中文说法。代码是 ASCII，说法在这里（本项目铁律） */
export const ROLE_LABEL = {
  admin: '管理员',
  editor: '维护端维护者',
  designer: '前台设计师',
  viewer: '只读',
};

/** 能力码 → 人话（键必须与 `AdminGate.caps()` 一字不差） */
export const CAP_LABEL = {
  enterAdmin: '进维护端',
  view: '查看',
  maintain: '维护产品与目录',
  design: '设计方案',
  writeSchemes: '改方案',
  publishParams: '发布参数',
  manageUsers: '管账号',
};

/** 声明的顺序（与后端 `AdminGate.ROLES` 同序）：四档从高到低 */
export const ROLE_ORDER = ['admin', 'editor', 'designer', 'viewer'];

/** 「管理员（admin）」；认不得的角色码原样显示，**不编一个名字** */
export function roleText(role, known) {
  const code = (role == null ? '' : String(role)).trim();
  if (!code) return '（空角色码）';
  const label = ROLE_LABEL[code];
  return known && label ? label + '（' + code + '）' : code;
}

/** 认不得的角色码要说的那句原话（**说清是按什么处理的**） */
export function unknownRoleText(role) {
  const code = (role == null ? '' : String(role)).trim();
  return '角色码「' + (code || '（空）') + '」不在四档里（admin / editor / designer / viewer）'
    + ' —— 系统按「什么都不能做」处理（不是按只读：只读也是一档，得先认得出你是它）';
}

/** 能做的那些事，列成一句：「查看、维护产品与目录、改方案」；一件都不能 → 一句实话 */
export function canLine(caps) {
  const can = Object.keys(CAP_LABEL).filter((k) => caps && caps[k]);
  if (!can.length) return '一件都不能做（认不得的角色，或没有用户行）';
  return can.map((k) => CAP_LABEL[k]).join('、');
}

/** 不能做的那些事。**列表为空要说"没有"**，不留白（留白会被读成"没查"） */
export function cannotLine(caps) {
  const no = Object.keys(CAP_LABEL).filter((k) => !(caps && caps[k]));
  if (!no.length) return '没有限制（是最高那一档）';
  return no.map((k) => CAP_LABEL[k]).join('、');
}

/**
 * 某个动作被挡住时的原话（按钮的 title / 灰色提示都用它）。
 *
 * ⚠️ 措辞刻意回避「你没有权限」：那句话对用户毫无信息量。要说清**哪一档能做**，
 *    因为这个门挡的是误操作，而且 U1 起判定按登录账号的角色走（服务端说了算）。
 */
export function denyText(cap, role) {
  // 「哪一档能做」必须写全 —— 只说"更高一档的角色"等于没说（用户不知道去找谁）
  const who = {
    publishParams: 'admin',
    maintain: 'admin / editor',
    writeSchemes: 'admin / editor / designer',
    design: 'admin / editor / designer',
    manageUsers: 'admin',
  }[cap] || '更高一档的角色';
  return '你的角色（' + roleText(role, true) + '）不能' + (CAP_LABEL[cap] || cap)
    + '：这件事要 ' + who + ' 才能做';
}

/** 进不了维护端时那一整段话（与 AdminApp 的 denied 界面共用，避免两处措辞不一致） */
export function deniedText(role, known) {
  if (!known) return unknownRoleText(role);
  return '你的角色是' + roleText(role, true) + ' —— 维护端不进这一档（'
    + '能进的是 admin / editor / viewer；designer 的工作面是前台设计器）';
}