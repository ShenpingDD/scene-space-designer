import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAP_LABEL, ROLE_LABEL, ROLE_ORDER, canLine, cannotLine, deniedText, denyText, roleText,
  unknownRoleText,
} from '../src/admin/roles.js';


/* 这组钉子钉的是**说法**，不是排版 —— 最容易出的错是"把两件事说成一件"：
   R6-4 B4e 的四档（谁不能做什么）。说错的后果不是难看，
   是**用户按错的信息做决定**（以为自己是管理员）。

   ⚠️ 原来这里还有一组 B4d 的钉子（"存的那条结论 vs 现在这条"）。那整块界面
   在 2026-10-07 被用户拍板删掉了（维护端卡片上那段 rev 文案"没用了"），
   连同 `admin/verdict.js` 一起删除 —— 所以这组钉子跟着走了。
   文件也从 `admin-roles-verdict.test.js` 改名为 `admin-roles.test.js`。 */

/* ── B4e：四档怎么念 ────────────────────────────────────────────────── */

test('★ 四档的名字都有，而且**认不得的角色码不编名字**（原样显示）', () => {
  assert.equal(roleText('admin', true), '管理员（admin）');
  assert.equal(roleText('editor', true), '维护端维护者（editor）');
  assert.equal(roleText('viewer', true), '只读（viewer）');
  assert.equal(roleText('root', false), 'root', '认不得就原样给 —— 不许猜成"大概只读吧"');
  assert.equal(roleText('', false), '（空角色码）');
  assert.equal(ROLE_ORDER.length, 4);
  for (const r of ROLE_ORDER) assert.ok(ROLE_LABEL[r], r + ' 要有中文说法');
});

test('★ 认不得的角色码要说出「按什么处理」—— 不许悄悄当成只读', () => {
  const t = unknownRoleText('root');
  assert.match(t, /不在四档里/);
  assert.match(t, /什么都不能做/);
  assert.match(t, /不是按只读/, '必须说清不是按 viewer 处理 —— 只读也是一档，得先认得出你是它');
  assert.match(unknownRoleText(''), /（空）/);
});

test('★ 能力表翻成人话：能做的、不能做的都要能列全，且**两行加起来正好是全部**', () => {
  const caps = { enterAdmin: true, view: true, maintain: true, design: false, writeSchemes: true, publishParams: false, manageUsers: false };
  assert.equal(canLine(caps), '进维护端、查看、维护产品与目录、改方案');
  assert.equal(cannotLine(caps), '设计方案、发布参数、管账号');
  // 管账号只有 admin 能做（设计决策记录 §五）：能做的清单里出现它，说明这一档拿到的是 admin
  assert.equal(canLine({ manageUsers: true }), '管账号');
  assert.equal(cannotLine({ manageUsers: true }), '进维护端、查看、维护产品与目录、设计方案、改方案、发布参数');
  // 一件不能做（认不得的角色）—— 说出来，不留白
  assert.match(canLine({}), /一件都不能做/);
  assert.equal(cannotLine({}), Object.values(CAP_LABEL).join('、'));
  // 最高那一档：不能做的列表为空时要说"没有限制"，不能留空
  const all = Object.fromEntries(Object.keys(CAP_LABEL).map((k) => [k, true]));
  assert.equal(cannotLine(all), '没有限制（是最高那一档）');
});

test('按钮被挡住时的话：说清**哪一档能做**，不是干巴巴一句"没有权限"', () => {
  const t = denyText('publishParams', 'viewer');
  assert.match(t, /只读（viewer）/);
  assert.match(t, /发布参数/);
  assert.match(t, /admin/, '要说清该找谁');
  assert.doesNotMatch(t, /没有权限/, '"你没有权限"对用户没有信息量');
  assert.match(denyText('maintain', 'viewer'), /admin \/ editor/);
});

test('进不了维护端那一整段话：四档走一句、认不得走另一句（不要混）', () => {
  assert.match(deniedText('designer', true), /前台设计师/);
  assert.match(deniedText('designer', true), /前台设计器/);
  assert.match(deniedText('root', false), /不在四档里/);
  assert.doesNotMatch(deniedText('root', false), /维护端不进这一档/, '认不得的角色走另一句');
});

/* ── B4d：两条结论 ─────────────────────────────────────────────────── */
