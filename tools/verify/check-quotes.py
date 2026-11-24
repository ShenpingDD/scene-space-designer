#!/usr/bin/env python3
"""check-quotes.py —— 抓「半角双引号跑进字符串里」这类错误。

为什么要它：这个错误**反复犯**（本项目已三次）——在 Java/JS 的字符串里写
`"占地轮廓"`，字符串提前结束，编译器报的却是 `unclosed string literal`
或 `')' or ',' expected`，报错位置离真正的原因很远。

判据（故意简单）：**一行里真正的半角双引号必须是偶数个**。
排除项：注释行、字符字面量（'x' / 转义形式）、文本块定界符。
排除项不排干净，误报就会淹掉真错 —— 而"经常误报的检查"等于没有检查。

注意：本文件刻意不出现反斜杠字面量（本仓库的构建环境会吃掉它），
需要反斜杠时用 chr(92) 拼。
"""
import io, sys, glob

BS = chr(92)
Q = chr(34)
DQ3 = Q * 3


def strip_char_literals(t):
    """把 'x' 与转义形式的字符字面量挖成 X（它们本来就自成一对了）。"""
    out, i, n = [], 0, len(t)
    while i < n:
        if t[i] == "'":
            j, ok = i + 1, False
            while j < n and j - i <= 8:
                if t[j] == BS:          # 转义：连同下一个字符一起跳过
                    j += 2
                    continue
                if t[j] == "'":
                    ok = True
                    break
                j += 1
            if ok:
                out.append("X"); i = j + 1; continue
        out.append(t[i]); i += 1
    return "".join(out)


def odd_quotes(t):
    """数一行里**未被转义**的半角双引号，判断是否为奇数个。

    为什么不能写成 `count(Q) - count(BS + Q)`（本文件 2026-09-29 之前的写法）：
    那样会把「转义反斜杠后面的那个引号」也算成被转义 —— 例如
    `sb.append(<Q><BS><BS><BS><BS><Q>)` 里，末尾那个引号前面正好是一个 BS + Q，
    于是**完全合法的代码被判成错**（实测就是 Json.java 的 `case <BS><BS>` 那行）。
    这类误报的代价最大：一个常年红的检查，最后没人看它。

    **一行里数引号，只能真扫一遍。** 穷举验证（3 字母表、长度 1~7、3279 行）：
    新旧规则的分歧**全部**出现在含 `<BS><BS>` 的行，其余一字不差 ——
    也就是说这次只是把规则改对，没有把判据放宽。
    """
    n = 0
    i = 0
    while i < len(t):
        if t[i] == BS:
            i += 2          # 转义：连同被转义的字符一起跳过
            continue
        if t[i] == Q:
            n += 1
        i += 1
    return n % 2 == 1


paths = sorted(glob.glob("server/src/**/*.java", recursive=True)
               + glob.glob("app/src/**/*.js", recursive=True)
               + glob.glob("app/src/**/*.vue", recursive=True))
bad = []
for f in paths:
    try:
        lines = io.open(f, encoding="utf-8").read().split(chr(10))
    except Exception:
        continue
    for i, line in enumerate(lines, 1):
        head = line.strip()
        if head.startswith("//") or head.startswith("*") or head.startswith("/*"):
            continue
        t = line.replace(DQ3, "")
        t = strip_char_literals(t)
        if odd_quotes(t):
            bad.append((f, i, head[:110]))

print("[info] 扫描 %d 个文件" % len(paths))
if not bad:
    print("[ok] 没有发现半角引号落单的行")
else:
    print("[x] 发现 %d 处可疑行：" % len(bad))
    for f, i, t in bad:
        print("  %s:%d  %s" % (f, i, t))
sys.exit(1 if bad else 0)
