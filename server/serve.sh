#!/usr/bin/env bash
# 常驻运行后端 —— **默认连 MySQL**
#
# 给"我想一边看前端/一边点接口"用：起来后**不退出**，停下按 Ctrl+C。
# （server/dev-run.sh 是"起 → 打两个健康检查口 → 自己关掉"，用于自检，别拿它当常驻。）
#
# 用法：bash server/serve.sh          （JDK 路径可用 JDK_HOME 覆盖，端口用 SERVER_PORT）
#
# 默认**连真库**（spatial.store=jdbc）。机器上没有 MySQL 时才用无库档：
#   SPATIAL_PROFILE=--spring.profiles.active=local-nodb bash server/serve.sh
#
# ⚠️ 无库档的**能力边界**（2026-10-12 实测逐条探过）：那一档下
#   `/api/catalog`（**型号目录**）与 `/api/admin/**`（维护端）这类**要 JDBC 仓储的接口故意不存在**（404），
#   在的只有 `/api/health`、`/api/health/kernel`、`/api/params`、`/api/schemes`。
#   所以设计端**能打开但读不到型号目录**；用途是「机器上没 MySQL 时验证服务能起 + 内核自检还绿」，
#   不是日常开发环境；而且 `spatial.store=memory` 下数据**重启就没**。
#
# 为什么默认是"连库"而不是"无库"：默认值要让人**离生产更近**。
# 而"悄悄用内存跑"与"真的在跑"太像了 —— 这类相似性都要消灭（docs/21 判据 5「怕安静」）。
set -e

# 同一支脚本按平台分支：Windows 是便携 JDK；macOS 走 java_home（brew install openjdk@21）。
UNAME="$(uname -s)"
if [ "$UNAME" = Darwin ]; then
  JDK="${JDK_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || true)}"
  if [ -z "$JDK" ]; then
    echo "找不到 JDK 21：brew install openjdk@21，并确认 /usr/libexec/java_home -v 21 有输出" >&2
    exit 1
  fi
else
  JDK="${JDK_HOME:-}"
fi
PORT="${SERVER_PORT:-8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAR="$ROOT/server/target/spatial-design-server-0.1.0-SNAPSHOT.jar"

if [ ! -f "$JAR" ]; then
  echo "还没打包。先执行："
  if [ "$UNAME" = Darwin ]; then
    echo "  cd server && mvn -B -DskipTests package        # macOS 上不要带 -s"
  else
    echo "  cd server && mvn  -B -DskipTests package"
  fi
  exit 1
fi

echo "后端监听 http://127.0.0.1:$PORT      （按 Ctrl+C 停止）"
echo "内核自检 http://127.0.0.1:$PORT/api/health/kernel"
echo "健康检查 http://127.0.0.1:$PORT/api/health"
echo

# exec：用 java 顶替当前 shell。这样 Ctrl+C 直接杀到 java，
# 不会像 dev-run.sh 第一版那样留下一个收不掉的后台进程。
#
# ── 堆上限（2026-10-12）────────────────────────────────────────────
# 为什么加：JDK 21 默认 `MaxRAMPercentage=25`，在这台 15.82 GB 的机器上等于
# **最大堆 3.96 GB**（实测 `jcmd <pid> VM.flags` → `-XX:MaxHeapSize=4248829952`），
# 元空间**改前完全没有上限**（改前读数 `18446744073709551615` = 无上限；改后是 256m，见下）。默认值本身不错，
# 但在这台机器上是错的：它和浏览器 / MySQL 争内存，而“允许用多少”与“实际会用多少”是两件事。
#
# ⚠️ **诚实说明：这不是性能优化，也不是当下卡顿的原因** —— 实测这份后端堆只用 100 MB
# （total 157 MB）。它防的是**将来**：目录变大、方案变多、批量计算堆上去之后，
# “能长到 4 GB”这件事才有代价。别把它当“卡顿已解决”。
#
# -Xms256m：初始堆给够（默认初始只按 1.5625% 算，约 254 MB），免得启动后反复扩容
# -XX:MaxMetaspaceSize=256m：元空间封顶（默认无上限；类加载器泄漏在这里最难看）
# -XX:+ExitOnOutOfMemoryError：封顶之后“堆被用尽”从“基本不会发生”变成“可能发生”，
#    而默认行为是抛错、进程**带病继续跑**（界面上没人看得出来）——
#    加上它，堆被用尽时进程直接退出，`start.sh` 的健康检查会在启动阶段报出来。
exec "$JDK/bin/java" -Dstdout.encoding=UTF-8 \
  -Xms256m -Xmx768m -XX:MaxMetaspaceSize=256m -XX:+ExitOnOutOfMemoryError \
  -jar "$JAR" \
  ${SPATIAL_PROFILE:-} \
  --server.port="$PORT"