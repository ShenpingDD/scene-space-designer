#!/usr/bin/env bash
# 起后端并自检 —— **无数据库模式**
#
# 用途：手上没有 MySQL 时，也能验证"服务能起来 + 内核在服务里跑的还是被断言的那份规则"。
#   跳过 Flyway（没有库可迁）、数据源允许连不上（Hikari 不 fail-fast）。
# 有库之后请走正常路径：mysql < db/00-create-database.sql && mvn spring-boot:run
#
# 用法：bash server/dev-run.sh          （JDK 路径可用 JDK_HOME 覆盖）
set -e

JDK="${JDK_HOME:-${JDK_HOME:-}}"
PORT="${SERVER_PORT:-8080}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JAR="$ROOT/server/target/spatial-design-server-0.1.0-SNAPSHOT.jar"

if [ ! -f "$JAR" ]; then
  echo "还没打包。先执行："
  echo "  cd server && mvn  -B -DskipTests package"
  exit 1
fi

${SPATIAL_PROFILE:-} \
APP=$!

# 无论如何都要把子进程收掉：它是后台常驻进程，漏掉一个，调用方（含 VS Code 任务、
# 自动化脚本）就会一直等它 —— 这正是本脚本第一版踩过的坑。
cleanup() { kill -9 "$APP" 2>/dev/null || true; }
trap cleanup EXIT

# 等端口真的能应答再问，别用固定 sleep 赌
for _ in $(seq 1 45); do
  sleep 1
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1; then break; fi
done

echo "--- /api/health ---"
curl -s --max-time 5 "http://127.0.0.1:$PORT/api/health"
echo
echo "--- /api/health/kernel（内核自检：服务端跑的还是不是被断言的规则）---"
curl -s --max-time 20 "http://127.0.0.1:$PORT/api/health/kernel"
echo
