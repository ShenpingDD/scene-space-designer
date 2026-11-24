#!/usr/bin/env bash
# 给某个账号设置一次性口令（U1）
#
# 用法：
#   bash tools/server/set-password.sh admin                             # 交互：口令不回显
#   printf '%s\n' '口令' | bash tools/server/set-password.sh admin       # 非交互（脚本里用）
#
# 口令只从**标准输入**进来：不进 shell 历史、不进进程命令行、不打印。
# 这条命令同时把该账号的 `enabled` 置为 1（口令设好了才能登录），
# 并在写完库之后回库 `SELECT` 一次，打印命中行数、`enabled` 与「口令是否已设」（AGENTS §4：不看日志）。
# 口令请用半角字符：登录名与初始口令都是半角，全角字符在登录框里会变成认不出的账号。
#
# 退出码：0 = 改到 1 行；1 = 没有这个用户名（一行都没改到）；2 = 用法或口令不合格。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UNAME="$(uname -s)"
if [ "$UNAME" = Darwin ]; then
  JDK="${JDK_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || true)}"
  if [ -z "$JDK" ]; then echo "找不到 JDK 21：brew install openjdk@21" >&2; exit 2; fi
else
  JDK="${JDK_HOME:-}"   # 不写死真机路径：设 JDK_HOME，或把 java 21 放进 PATH
fi
JAR="${SPATIAL_JAR:-$ROOT/server/target/spatial-design-server-0.1.0-SNAPSHOT.jar}"

username="${1:-}"
if [ -z "$username" ]; then
  echo "用法：bash tools/server/set-password.sh <登录名>" >&2
  exit 2
fi
if [ ! -f "$JAR" ]; then
  echo "找不到后端 jar：$JAR" >&2
  if [ "$UNAME" = Darwin ]; then
    echo "先打包（macOS：重打包不会被运行中的 JVM 锁住，但改了后端代码必须重启后端才生效）。" >&2
  else
    echo "先打包（AGENTS §7：打包前先 bash stop.sh，否则 jar 被运行中的 JVM 锁住）。" >&2
  fi
  exit 2
fi

# 必须确认这个 jar 真的带 `--set-password`：target 里可能留着上一轮的包，那种旧包不认这个参数，
# 会当成一次普通启动去占 8080 —— 口令一行都没改，人却以为设好了。
#
# 判据**不能只看 mtime**：Maven 的可复现构建把 jar 内条目与 jar 自身的 mtime 都定成 1980-02-01，
# 于是「jar 比源码旧」永远成立，重打包一百次也还是报旧（2026-11-24 公开版实测踩到）。
# 所以先按**内容**判断：类文件的常量池里有没有 `--set-password` 这个字符串。
FEATURE_SRC="$ROOT/server/src/main/java/com/scene/spatial/auth/PasswordTool.java"
jar_has_set_password() {
  command -v unzip >/dev/null 2>&1 || return 2          # 2 = 判断不了，交给 mtime 兜底
  unzip -p "$JAR" 'BOOT-INF/classes/com/scene/spatial/auth/PasswordTool.class' 2>/dev/null \
    | LC_ALL=C grep -aq -- '--set-password'
}
JAR_OK=0
if [ -f "$FEATURE_SRC" ]; then
  jar_has_set_password; JAR_PROBE=$?
  if [ "$JAR_PROBE" = 0 ]; then
    JAR_OK=1                                            # 包里确实有这个功能
  elif [ "$JAR_PROBE" = 2 ] && [ ! "$JAR" -ot "$FEATURE_SRC" ]; then
    JAR_OK=1                                            # 没 unzip：退回 mtime，且包不比源码旧
  fi
fi
if [ -f "$FEATURE_SRC" ] && [ "$JAR_OK" != 1 ]; then
  echo "这个 jar 里没有 --set-password（或比 $FEATURE_SRC 还旧）：先 mvn package，再跑这条命令。" >&2
  exit 2
fi

password_min=8

if [ -t 0 ]; then
  # 交互：由 bash 读口令（`-s` = 不回显），再把那一行喂给 java 的标准输入
  if ! read -r -s -p "给 $username 设置新口令（不回显，至少 $password_min 位）：" pw; then
    echo
    echo "没有读到口令（输入被打断了），什么都没改。" >&2
    exit 2
  fi
  echo
  if [ "${#pw}" -lt "$password_min" ]; then
    echo "口令太短：至少要 $password_min 位（收到 ${#pw} 位）。" >&2
    exit 2
  fi
  printf '%s\n' "$pw" | "$JDK/bin/java" -jar "$JAR" --set-password "$username"
else
  # 非交互：标准输入原样转给 java（不经过这个脚本的变量，口令也不会出现在命令行里）
  "$JDK/bin/java" -jar "$JAR" --set-password "$username"
fi
