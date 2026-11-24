import test from 'node:test';
import assert from 'node:assert/strict';
import { liveLine, autoLine, originLine } from '../src/paramsText.js';

/* 这里是「参数相关的三句话」的钉子。它们看着像文案，其实是**判定的一部分**：

   参数自动变了而界面不说，用户会以为"判定标准没变、是系统算错了"。
   所以这几句必须钉字面量 —— 读实现的常量抓不到"常量本身写歪了"。 */

test('装上了：说"服务端那一版"并带上 rev', () => {
  const s = liveLine({ source: 'server', rev: 49717190, ignored: [] }, 49717190);
  assert.match(s, /服务端那一版/);
  assert.match(s, /49717190/);
  assert.doesNotMatch(s, /\*\*/, '给人看的文案里不许混 markdown');
});

test('没装上：必须说"代码里的默认值"，且不许把本地指纹说成服务端那一版', () => {
  const s = liveLine({ source: 'default', error: 'ECONNREFUSED' }, 92166283);
  assert.match(s, /代码里的默认值/);
  assert.match(s, /ECONNREFUSED/);
  assert.match(s, /92166283/);
  assert.match(s, /与服务端无关/, '★ 本地算得出指纹，但它跟服务端有没有那份没关系');
});

test('库里有没被采用的值：要顺带说出来（不许静默）', () => {
  const s = liveLine({ source: 'server', rev: 1, ignored: ['a：超出', 'b：未知'] }, 1);
  assert.match(s, /2 项没被采用/);
});

test('自动跟上了：说清"几秒内自己跟上"和新的 rev（不是用户刷新出来的）', () => {
  const s = autoLine({ kind: 'updated', rev: 49717190 }, 5000);
  assert.match(s, /后台改了规则参数/);
  assert.match(s, /5 秒内自动跟上/);
  assert.match(s, /49717190/);
  assert.doesNotMatch(s, /\*\*/);
});

test('自动跟新失败：必须说"还在按上一版算"，并给出原因', () => {
  const s = autoLine({ kind: 'failed', reason: 'bad-params' }, 5000);
  assert.match(s, /没装上/);
  assert.match(s, /还在按上一版算/);
  assert.match(s, /bad-params/);
});

test('维护端顶部那句：改过几项要说出来', () => {
  assert.match(originLine('数据库（改过 2 项）', 2), /2 项不是出厂值/);
  assert.equal(originLine('数据库（全是出厂值，没改过）', 0), '数据库（全是出厂值，没改过）');
  assert.equal(originLine('', 0), '', '没有来源就别说');
});