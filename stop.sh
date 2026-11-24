#!/usr/bin/env bash
# 停掉本机这套环境：前端(5180/4180) → 后端(8080) → MySQL(3306)
#
#   bash stop.sh
#
# 前端有两个形态（开发服务器 :5180 / 生产构建 :4180）—— 两个都停，
# 因为“现在是哪一个”经常是上一个命令临时切过去的，停不干净下次起来会以为是另一个。
#
# 只杀"正在监听这三个端口"的那个进程 —— **不按进程名杀**：
# 这台机器上可能还有别的 java / node 在跑（比如同事的服务），按名字杀会误伤。
set -u

# 同一支脚本按平台分支（交接文档第 7 节：不另建 stop-mac.sh）。
UNAME="$(uname -s)"
if [ "$UNAME" = Darwin ]; then
  # Homebrew 的 mysql@8.0 是 keg-only（不在 PATH）。用 brew 的前缀，Intel / Apple Silicon 都对。
  BREW_PREFIX="$(/opt/homebrew/bin/brew --prefix 2>/dev/null || brew --prefix 2>/dev/null || echo /opt/homebrew)"
  BREW_BIN="$BREW_PREFIX/bin/brew"
  MYSQL_HOME="${MYSQL_HOME:-$BREW_PREFIX/opt/mysql@8.0}"
else
  MYSQL_HOME="${MYSQL_HOME:-}"   # 不写死真机路径：没设就退回 PATH
fi
MYSQL_BIN="$MYSQL_HOME/bin"
MYSQLADMIN="$MYSQL_BIN/mysqladmin"
[ "$UNAME" = Darwin ] || MYSQLADMIN="$MYSQLADMIN.exe"
[ -x "$MYSQLADMIN" ] || MYSQLADMIN="$(command -v mysqladmin || echo "$MYSQLADMIN")"
ROOT="$(cd "$(dirname "$0")" && pwd)"

# macOS 用 lsof 直接拿「监听该端口的 PID」（第 2 行第 2 列）；netstat -ano 是 Windows 的写法。
if [ "$UNAME" = Darwin ]; then
  port_pid() { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $2}'; }
else
  port_pid() { netstat -ano | grep -E "TCP.*:$1 +.*LISTENING" | awk '{print $NF}' | head -1; }
fi

echo
echo "场景空间设计器 · 停掉本机环境"
echo "------------------------------------------------------------"

kill_port() {
  local port="$1" name="$2" pid
  pid="$(port_pid "$port")"
  if [ -z "$pid" ]; then
    printf '  [--]  %s（:%s）本来就没在跑\n' "$name" "$port"
    return
  fi
  if [ "$UNAME" = Darwin ]; then
    # 先 TERM 给进程收尾的机会，两秒后仍在再 KILL（没有 taskkill //F 那种一步到位）
    kill "$pid" 2>/dev/null || true
    for _ in {1..2}; do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; sleep 1; fi
    if kill -0 "$pid" 2>/dev/null; then
      printf '  [!!]  停不掉 %s（PID %s），可能权限不够\n' "$name" "$pid"
    else
      printf '  [ok]  已停 %s（:%s ｜ PID %s）\n' "$name" "$port" "$pid"
    fi
  elif taskkill //F //PID "$pid" >/dev/null 2>&1; then
    printf '  [ok]  已停 %s（:%s ｜ PID %s）\n' "$name" "$port" "$pid"
  else
    printf '  [!!]  停不掉 %s（PID %s），可能要管理员权限\n' "$name" "$pid"
  fi
}

kill_port 5180 "前端（开发）"
kill_port 4180 "前端（生产）"
BACKEND_PID="$(port_pid 8080)"
kill_port 8080 "后端"

# 等后端 JVM 真的退出（最多 15 秒）—— 理由分平台：
#   Windows：运行中的 JVM 锁着 jar，紧接着重打包会报 "Unable to rename ...SNAPSHOT.jar"，
#            而且 jar 已经被写成半成品（实测 371 KB），下一次启动就失败却看起来像"打包成功"。
#   macOS  ：重打包不会被占用卡住（运行中的进程持有旧 inode）。这段等待保留，理由换成
#            「别让旧进程占着 8080，让人以为已经停了」（交接文档第 7 节）。
# ⚠️ 等的是**我们刚杀掉的那个 PID**，不是「名字里带 java 的进程」（第 3 轮审查 C-6）：
#    按名字等会把同事的服务也算进来 —— 要么白等满 15 秒，要么在别的 java 还在跑时误报「没退」。
proc_alive() {
  if [ "$UNAME" = Darwin ]; then ps -p "$1" -o comm= >/dev/null 2>&1
  else tasklist //FI "PID eq $1" 2>/dev/null | grep -q "$1"; fi
}
if [ -n "$BACKEND_PID" ]; then
  for _ in {1..15}; do
    if ! proc_alive "$BACKEND_PID"; then break; fi
    sleep 1
  done
  if proc_alive "$BACKEND_PID"; then
    printf '  [!!]  后端 JVM（PID %s）还没退 —— 8080 仍被占着；macOS 查：ps -p %s -o pid,comm\n' "$BACKEND_PID" "$BACKEND_PID"
  fi
else
  printf '  [--]  后端本来就没在跑，不等 JVM 退出\n'
fi

if "$MYSQLADMIN" -u root --protocol=tcp -h 127.0.0.1 ping >/dev/null 2>&1; then
  if [ "$UNAME" = Darwin ]; then
    # macOS 只留一种停法：与 start.sh 对称，都用 brew services（交接文档第 7 节：别一半一半）。
    "$BREW_BIN" services stop mysql@8.0 >/dev/null 2>&1 || true
    for _ in {1..20}; do "$MYSQLADMIN" -u root --protocol=tcp -h 127.0.0.1 ping >/dev/null 2>&1 || break; sleep 1; done
  else
    "$MYSQLADMIN" -u root --protocol=tcp -h 127.0.0.1 shutdown >/dev/null 2>&1
    sleep 2
  fi
  if "$MYSQLADMIN" -u root --protocol=tcp -h 127.0.0.1 ping >/dev/null 2>&1; then
    printf '  [!!]  MySQL 还在跑\n'
  else
    printf '  [ok]  已停 MySQL\n'
  fi
else
  printf '  [--]  MySQL 本来就没在跑\n'
fi

echo "------------------------------------------------------------"
echo "  停 MySQL 不影响数据：方案都在库里，下次 start.sh 起来还在"
echo