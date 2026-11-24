#!/usr/bin/env bash
# gate.sh —— 场景空间设计器 · 一键验收闸门
#
# 为什么要有它
#   验收从来不是一条命令：内核单测 / 前端单测 / 后端测试 / 引号铁律 / 前端构建
#   散在 README 与 docs/ 里。人一多、会话一换，"这次到底跑全了没有"就只能靠回忆 ——
#   而回忆不是判据。本脚本把这些写死成一份可执行的东西。
#
# 步骤
#   core    内核单测（spatial-core，纯 node --test，零依赖）
#   app     前端单测（app/test，node --test）
#   java    后端测试（Java 21 + 真 MySQL：Flyway 迁移要真的跑一遍）
#   quotes  引号铁律（源码字符串里不许出现半角双引号）
#   build   前端生产构建（vite build）
#
# 退出码
#   0  全部 PASS（SKIP 不算失败，但会单独列出来，不混进 PASS）
#   1  有 FAIL
#   2  环境不满足（缺 node / java21 / mvn / MySQL）—— 不是"通过"
#
# 用法
#   bash tools/verify/gate.sh                 # 全部步骤
#   bash tools/verify/gate.sh --only core,app # 只跑指定步骤
#   bash tools/verify/gate.sh --keep-going    # 失败也继续跑完，最后汇总
#   bash tools/verify/gate.sh --list          # 只列步骤，不跑
#
# 约定
#   · 每步输出写 logs/gate/<id>.log；失败时只回放最后 40 行，完整日志留在文件里。
#   · 退出码 2 的步骤记为 SKIP —— SKIP 是"没量到"，不是"没问题"，汇总里单独一列。
#   · 打印一律 ASCII，不依赖终端配色。

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "[gate] cannot cd to repo root"; exit 2; }

LOG_DIR="$ROOT/logs/gate"
mkdir -p "$LOG_DIR"

MODE="all"
ONLY=""
KEEP_GOING=0

usage() {
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --only)
      shift
      if [ $# -eq 0 ]; then echo "[gate] --only needs a comma-separated list"; exit 2; fi
      ONLY="$1"
      ;;
    --keep-going) KEEP_GOING=1 ;;
    --list) MODE="list" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[gate] unknown argument: $1"; usage; exit 2 ;;
  esac
  shift
done

# ── 工具链探测（本机 brew 不在非交互 shell 的 PATH 里，显式补）────────────────
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

pick_python() {
  if [ -n "${SPATIAL_PYTHON:-}" ]; then printf '%s' "$SPATIAL_PYTHON"; return; fi
  for c in python3.12 python3.11 python3; do
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return; fi
  done
  printf ''
}
PYTHON="$(pick_python)"

NODE_BIN="$(command -v node 2>/dev/null || true)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"

# Java：项目要 21。macOS 上优先 Homebrew 的 openjdk@21；其它平台用现成的 JAVA_HOME。
if [ "$(uname -s)" = "Darwin" ] && [ -x "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java" ]; then
  export JAVA_HOME="/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
fi
JAVA_BIN=""
if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
  JAVA_BIN="$JAVA_HOME/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
fi
export MAVEN_OPTS="${MAVEN_OPTS:--Duser.language=en -Duser.country=US}"

MVN_BIN=""
if [ -x "/opt/homebrew/bin/mvn" ]; then
  MVN_BIN="/opt/homebrew/bin/mvn"
elif command -v mvn >/dev/null 2>&1; then
  MVN_BIN="$(command -v mvn)"
fi

MYSQL_BIN=""
for c in "${SPATIAL_MYSQL:-}" "$(command -v mysql 2>/dev/null || true)" "/opt/homebrew/opt/mysql@8.0/bin/mysql"; do
  if [ -n "$c" ] && [ -x "$c" ]; then MYSQL_BIN="$c"; break; fi
done

node_major() {
  [ -n "$NODE_BIN" ] || { printf '0'; return; }
  "$NODE_BIN" -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}
java_major() {
  [ -n "$JAVA_BIN" ] || { printf '0'; return; }
  "$JAVA_BIN" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/'
}

db_up() {
  [ -n "$PYTHON" ] || return 1
  "$PYTHON" - <<'PY' >/dev/null 2>&1
import socket, sys
s = socket.socket()
s.settimeout(1.0)
try:
    s.connect(("127.0.0.1", 3306))
except Exception:
    sys.exit(1)
PY
}

# ── 步骤 ───────────────────────────────────────────────────────────────────
step_core()   { "$NPM_BIN" --prefix "$ROOT/spatial-core" test; }
step_app()    { "$NPM_BIN" --prefix "$ROOT/app" test; }
step_java()   { ( cd "$ROOT/server" && "$MVN_BIN" -B test ); }
step_quotes() { "$PYTHON" "$ROOT/tools/verify/check-quotes.py"; }
step_build()  { "$NPM_BIN" --prefix "$ROOT/app" run build; }


# id|title|tier
STEPS_ALL="core|内核单测（JS）|all
app|前端单测|all
java|后端测试（Java 21 + 真库）|all
quotes|引号铁律 check-quotes|all
build|前端构建|all"

if [ "$MODE" = "list" ]; then
  echo "id        tier   title"
  printf '%s\n' "$STEPS_ALL" | while IFS='|' read -r id title tier; do
    printf '%-9s %-6s %s\n' "$id" "$tier" "$title"
  done
  exit 0
fi

selected() {
  if [ -z "$ONLY" ]; then return 0; fi
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

only_has() {
  [ -n "$ONLY" ] || return 1
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

WANT_TIER="all"

# ── 环境预检 ───────────────────────────────────────────────────────────────
echo "============================================================"
echo " gate.sh  mode=$MODE  root=$ROOT"
echo "============================================================"
printf '  platform : %s %s\n' "$(uname -s)" "$(uname -m)"
printf '  node     : %s\n' "${NODE_BIN:-MISSING} ($(node_major 2>/dev/null || echo 0))"
printf '  python   : %s\n' "${PYTHON:-MISSING}"
printf '  java     : %s (%s)\n' "${JAVA_BIN:-MISSING}" "$(java_major 2>/dev/null || echo 0)"
printf '  mvn      : %s\n' "${MVN_BIN:-MISSING}"
printf '  mysql-cli: %s\n' "${MYSQL_BIN:-MISSING}"
if db_up; then printf '  mysql    : 127.0.0.1:3306 up\n'; else printf '  mysql    : 127.0.0.1:3306 DOWN\n'; fi

ENV_BAD=0
if [ "$(node_major 2>/dev/null || echo 0)" -lt 20 ]; then
  echo "  [x] node >= 20 required"; ENV_BAD=1
fi
if [ -z "$PYTHON" ]; then echo "  [x] python3 not found"; ENV_BAD=1; fi
if [ -z "$MVN_BIN" ]; then echo "  [x] mvn not found"; ENV_BAD=1; fi
if [ "$(java_major 2>/dev/null || echo 0)" != "21" ]; then
  echo "  [x] Java 21 required (found $(java_major 2>/dev/null || echo 0))"; ENV_BAD=1
fi

# 跑 java 步骤就必须有库；只跑检查器时不因为库没起而拦人
NEED_DB=0
if selected java; then NEED_DB=1; fi
if [ "$NEED_DB" = "1" ] && ! db_up; then
  echo "  [x] MySQL 3306 not reachable - backend tests need the real db"
  echo "      start it with: SPATIAL_NO_PERF=1 bash start.sh   (or: bash start.sh --status)"
  ENV_BAD=1
fi

if [ "$ENV_BAD" = "1" ]; then
  echo
  echo "[gate] environment not satisfied - this is NOT a pass (exit 2)"
  exit 2
fi

# ── 执行 ───────────────────────────────────────────────────────────────────
PASSED=0; SKIPPED=0; FAILED=0
RUN_IDS=()
RUN_TITLES=()
RUN_STATUS=()
RUN_SECS=()
TOTAL_START=$(date +%s)

run_step() {
  id="$1"; title="$2"
  selected "$id" || return 0
  log="$LOG_DIR/$id.log"
  printf '==> %-38s ' "$title"
  start=$(date +%s)
  case "$id" in
    core) step_core ;;
    app) step_app ;;
    java) step_java ;;
    quotes) step_quotes ;;
    build) step_build ;;
    *) echo "internal: unknown step $id"; return 1 ;;
  esac >"$log" 2>&1
  rc=$?
  end=$(date +%s); secs=$((end - start))
  if [ "$rc" -eq 0 ]; then
    status="PASS"; PASSED=$((PASSED + 1)); printf 'PASS  (%ss)\n' "$secs"
  elif [ "$rc" -eq 2 ]; then
    status="SKIP"; SKIPPED=$((SKIPPED + 1)); printf 'SKIP  (%ss)\n' "$secs"
    tail -n 3 "$log" | sed 's/^/    /'
  else
    status="FAIL"; FAILED=$((FAILED + 1)); printf 'FAIL  (%ss)\n' "$secs"
    echo "    ---- last 40 lines of $log ----"
    tail -n 40 "$log" | sed 's/^/    /'
  fi
  RUN_IDS+=("$id")
  RUN_TITLES+=("$title")
  RUN_STATUS+=("$status")
  RUN_SECS+=("$secs")
  if [ "$status" = "FAIL" ] && [ "$KEEP_GOING" = "0" ]; then
    return 1
  fi
  return 0
}

# 注意：这里不许把 while 接在管道后面 —— 管道里的 while 跑在子 shell 里，
# PASS/FAIL 计数与累积的 RUN_* 全都带不回来（汇总会说 0/0/0）。用 here-doc。
ABORT=0
while IFS='|' read -r id title tier; do
  selected "$id" || continue
  if ! run_step "$id" "$title"; then ABORT=1; break; fi
done <<EOF
$STEPS_ALL
EOF

TOTAL_SECS=$(( $(date +%s) - TOTAL_START ))

echo
echo "============================================================"
echo " summary"
echo "============================================================"
for idx in "${!RUN_IDS[@]}"; do
  printf '  %-5s %-38s %ss\n' "${RUN_STATUS[$idx]}" "${RUN_TITLES[$idx]}" "${RUN_SECS[$idx]}"
done
printf '  PASS %s   SKIP %s   FAIL %s   total %ss\n' "$PASSED" "$SKIPPED" "$FAILED" "$TOTAL_SECS"
echo "  logs: $LOG_DIR"
echo "============================================================"

if [ "$ABORT" -ne 0 ] || [ "$FAILED" -ne 0 ]; then
  echo "[gate] RED - see failures above (exit 1)"
  exit 1
fi
if [ "$SKIPPED" -ne 0 ]; then
  echo "[gate] GREEN with $SKIPPED SKIP(s) - skipped is not passed"
else
  echo "[gate] GREEN"
fi
exit 0
