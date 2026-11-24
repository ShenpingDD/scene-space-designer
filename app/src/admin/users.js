/**
 * users.js —— 用户管理页的**纯计算与话术**（判据在 `app/test/admin-users.test.js`）
 *
 * 为什么单独抽出来（照 `schemes.js` / `roles.js` 的既有做法）：
 * 这一页最容易出的错是**把"不知道"显示成"没有"**（接口没给 `hasPassword` 就说"口令未设置"），
 * 以及**把失败说成一句"操作失败"**（自保、最后一名管理员、名下有方案，三件的下一步动作完全不同）。
 * 这些都能写成纯函数逐条钉住。
 */

/** 角色选项：四档的中文说法与顺序都取自 `roles.js`（不在这里抄第二份） */
import { ROLE_LABEL, ROLE_ORDER } from './roles.js';

/** 登录名的规矩（与 docs/80 §五第2项、服务端同一个正则）：2-64 位，只许字母数字与 `. _ -` */
export const USERNAME_RE = /^[A-Za-z0-9._-]{2,64}$/;

/** 口令下限（与 docs/80 §五第3项一致）：少于 8 位不提交，省一趟后端 */
export const PASSWORD_MIN = 8;

/** 三态显示：`true`/`false`/`null`（不知道）。**不知道就说不知道**，不冒充"没有" */
function tri(v) {
  if (v === true || v === 1 || v === '1' || v === 'true') return true;
  if (v === false || v === 0 || v === '0' || v === 'false') return false;
  return null;
}

export function enabledText(u) {
  const v = tri(u && u.enabled);
  if (v === null) return '—';
  return v ? '已启用' : '已停用';
}

export function passwordText(u) {
  const v = tri(u && u.hasPassword);
  if (v === null) return '—';
  return v ? '已设置' : '未设置';
}

/** 方案条数。接口没给就回 `null`（界面显示「—」）—— 「0 份」与「不知道几份」是两件事 */
export function schemeCountOf(u) {
  const v = u ? u.schemeCount : undefined;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 一行接口数据 → 列表要用的东西。只做汇总，判断都在各自的函数里 */
export function userRowOf(u) {
  const r = u || {};
  return {
    id: r.id,
    username: String(r.username == null ? '' : r.username),
    displayName: String(r.displayName == null ? '' : r.displayName).trim(),
    roleCode: String(r.roleCode == null ? '' : r.roleCode).trim(),
    enabled: tri(r.enabled),
    enabledText: enabledText(r),
    passwordText: passwordText(r),
    schemeCount: schemeCountOf(r),
  };
}

/**
 * 这一行能不能停用 / 删除（**界面上的自保提示**，真正的判定在服务端）。
 *
 * 自己的账号不能停用也不能删除：那会把人自己关在门外，而且再打开要用另一名管理员的账号。
 * 服务端会回 `self-lockout`，这里提前把按钮灰掉并说明，省一次往返。
 */
export function isSelf(u, myUserId) {
  const a = String((u && u.id) == null ? '' : u.id).trim();
  const b = String(myUserId == null ? '' : myUserId).trim();
  return !!a && a === b;
}

/** 自保说明的原话（灰按钮的 title） */
export function selfWhy(u) {
  return '这是你自己的账号（' + String((u && u.username) || '') + '）—— 不能停用或删除自己，'
    + '否则你会把自己关在门外；要停用请找另一位管理员操作';
}

/** 角色下拉的选项（顺序与后端 `AdminGate.ROLES` 同序） */
export function roleOptions() {
  return ROLE_ORDER.map((code) => ({ code, label: ROLE_LABEL[code] || code }));
}

/** 登录名能不能用；不能用时回一句为什么（能用回空串） */
export function usernameWhy(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '登录名要填。';
  if (!USERNAME_RE.test(s)) {
    return '登录名只许 2-64 位的字母、数字与 . _ -（不要用中文、空格或全角字符 —— 登录框里认不出来）。';
  }
  return '';
}

/** 口令能不能用；不能用时回一句为什么（能用回空串） */
export function passwordWhy(raw) {
  const s = String(raw == null ? '' : raw);
  if (!s) return '口令要填。';
  if (s.length < PASSWORD_MIN) return '口令至少 ' + PASSWORD_MIN + ' 位。';
  return '';
}

/**
 * 用户管理失败时那句话。**分因给话** —— 四种原因的下一步动作完全不同。
 *
 * `message` 是服务端给的原话（例如 409 `user-in-use` 里那句「这个号名下有 N 份方案：…」），
 * 有原话就用原话：它比前端能编的任何句子都准。
 */
export function userFailText(reason, message) {
  const r = String(reason == null ? '' : reason);
  const m = String(message == null ? '' : message);
  if (r === 'self-lockout') {
    return '服务端不接受对自己的这一次操作 —— 不能停用或删除自己。要停用请找另一位管理员。';
  }
  if (r === 'last-admin') {
    return '服务端不接受：这会把最后一名管理员停用、降档或删除 —— 系统里至少要留一名管理员。';
  }
  if (r === 'user-in-use') return m || '这个账号名下有方案或历史记录，不能删除；改成「停用」。';
  if (r === 'conflict') return m || '这个登录名已经有人用了 —— 换一个。';
  if (r === 'bad-role') return m || '角色码不在四档里（admin / editor / designer / viewer）。';
  if (r === 'invalid-request') return m || '填的内容不合格。';
  if (r === 'forbidden') return m || '你的角色不能管账号：这件事要 admin 才能做。';
  if (r === 'backend-down') return '连不上后端 —— 这次改动没有生效。';
  return (r ? r + '：' : '') + (m || '原因未知');
}
