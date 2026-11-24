#!/usr/bin/env bash
# 把前端从**开发服务器**换成**生产构建**：先构建 → 停 5180 → 起 4180
#
#   bash start-prod.sh
#   bash start-prod.sh --no-db      （参数原样递给 start.sh，见下）
#
# 什么时候用：机器吃紧的时候。量过的差别（同一台机器，服务起着、人没动）：
#   开发服务器 = 1 个 node 进程，约 320 MB 工作集 / 约 2266 个句柄，CPU 1% 量级；
#   生产构建   = 一个 1 MB 的 js + 一个 51 KB 的 css，没有文件监视、没有 HMR 客户端。
#   ⚠️ **诚实说明**：CPU 上省得不多（1% 量级），主要省的是内存与句柄，
#      以及"改源码触发重编译"这类偶发尖峰。别指望它把卡顿治好。
#
# 为什么**先构建再停开发服务器**（与最初写法不同）：
#   构建可能失败（语法错、依赖缺）。先停再建的话，构建一失败你就**两个前端都没有了**。
#   现在的顺序：建不出来 → 一个字都不动，你手上那个还能用。
#
# MySQL 与后端不在这个脚本的范围里（它们与前端形态无关）：最后交给 `start.sh --prod`，
# 已经起着的 MySQL 与后端探测到就不动。
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

WEB_DEV="${APP_WEB:-http://127.0.0.1:5180}"
WEB_PROD="${APP_WEB_PROD:-http://127.0.0.1:4180}"

printf '\n'
printf '场景空间设计器 · 前端切到生产构建\n'
printf -- '------------------------------------------------------------\n'

# 已经就在跑生产构建？那就不用折腾了（幂等：合成动作不会因为点两次出问题）
if curl -sf --max-time 3 "$WEB_PROD/" >/dev/null 2>&1; then
  printf '  [ok]  前端已经在跑生产构建（%s）\n' "$WEB_PROD"
else
  printf '  [..]  构建生产包（约十几秒）……\n'
  if ( cd "$ROOT/app" && npm run build ) > "$LOGS/build-front.log" 2>&1; then
    printf '  [ok]  生产包构建完成（日志 logs/build-front.log）\n'
  else
    printf '  [!!]  生产包构建失败 —— 看 logs/build-front.log\n'
    printf '        一个字都没动：你手上的开发服务器还在 %s\n' "$WEB_DEV"
    exit 1
  fi

  UNAME="$(uname -s)"
  if [ "$UNAME" = Darwin ]; then
    pid="$(lsof -nP -iTCP:5180 -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}')"
  else
    pid="$(netstat -ano | grep -E "TCP.*:5180 +.*LISTENING" | awk '{print $NF}' | head -1)"
  fi
  if [ -n "$pid" ]; then
    if [ "$UNAME" = Darwin ]; then
      kill "$pid" 2>/dev/null || true
      for _ in {1..2}; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
      if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; sleep 1; fi
      if kill -0 "$pid" 2>/dev/null; then stopped=0; else stopped=1; fi
    else
      taskkill //F //PID "$pid" >/dev/null 2>&1 && stopped=1 || stopped=0
    fi
    if [ "$stopped" = 1 ]; then
      printf '  [ok]  已停开发服务器（:5180 ｜ PID %s）\n' "$pid"
    else
      printf '  [!!]  停不掉开发服务器（:5180 ｜ PID %s）—— 不加 --prod 起两个会抢端口\n' "$pid"
      exit 1
    fi
  else
    printf '  [--]  开发服务器本来就没在跑\n'
  fi
fi

# 参数原样接过来（--no-db / --status 等），由 start.sh 统一解释。
# `SPATIAL_FRONT_PREBUILT=1`：告诉 start.sh「生产包上面已经构建好了，别再构建一遍」——
# 原来一次切换会构建两遍前端，两份日志写同一个 `logs/build-front.log` 互相覆盖（第 3 轮审查 C-5）。
SPATIAL_FRONT_PREBUILT=1 exec bash "$ROOT/start.sh" --prod "$@"