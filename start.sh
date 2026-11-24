#!/usr/bin/env bash
# 一键把本机整套环境拉起来：MySQL → 后端(8080) → 前端(5180 或 4180)
#
#   bash start.sh            默认连真库 · 前端跑开发服务器（:5180）
#   bash start.sh --no-db    后端走内存档，数据重启就没
#   bash start.sh --prod     前端跑**生产构建**（:4180）—— 机器吃紧时用这个
#   bash start.sh --status   只看现状，不动任何东西
#   bash start-prod.sh       从开发服务器切到生产构建（停 5180 → 构建 → 起 4180）
#   bash stop.sh             三个一起停
#
# `--no-db` 与 `--prod` 可以一起给（两个开关各记一个变量，不能共用）。
#
# ⚠️ **`--no-db`（无库档）的能力边界**（2026-10-12 实测后写明）：
#     那一档下需要 JDBC 仓储的接口**故意不存在**（返回 404）—— `/api/catalog`（**型号目录**）、
#     `/api/admin/**`（维护端）、`/api/catalog/reload` 这类；在的只有 `/api/health`、`/api/health/kernel`、
#     `/api/params`、`/api/schemes`。所以设计端**能打开但装不进型号**。
#     用途是「机器上没有 MySQL 时验证服务能起 + 内核自检还绿」，不是日常开发环境；
#     而且 `spatial.store=memory` 下数据**重启就没**。
#     （以前这里写的「无库也能起」是错的：维护端控制器无条件依赖 JDBC 仓储，
#      结果整个应用起不来 —— 已改成让那些接口真的不存在。）
#
# 这个脚本只做三件事：**探测 → 起 → 求证**。
# 「求证」不是"进程还在"，而是三个端口真的应答、内核用例表真的全绿、
# 后端日志里真的写着"MySQL" —— 否则"看起来起来了"和"真的起来了"长得太像（设计决策记录判据 5 怕安静）。
set -u

ROOT="$(cd "$(dirname "$0")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

# 工具链：Windows 那台是便携目录（都不在 PATH 里）；macOS 上走 Homebrew，靠环境变量覆盖。
# 原则：**同一支脚本按平台分支**，不另建 start-mac.sh —— 两份脚本早晚走岔（交接文档第 7 节）。
UNAME="$(uname -s)"
if [ "$UNAME" = Darwin ]; then
  JDK="${JDK_HOME:-$(/usr/libexec/java_home -v 21 2>/dev/null || true)}"
  MVN="${MAVEN_BIN:-mvn}"
  MVN_SETTINGS="${MAVEN_SETTINGS:-}"          # macOS 上标准 Maven 配置就够，默认不拼 -s
  # Homebrew 的 mysql@8.0 是 keg-only（不在 PATH）。用 brew 的前缀，Intel / Apple Silicon 都对。
  BREW_PREFIX="$(/opt/homebrew/bin/brew --prefix 2>/dev/null || brew --prefix 2>/dev/null || echo /opt/homebrew)"
  BREW_BIN="$BREW_PREFIX/bin/brew"
  MYSQL_HOME="${MYSQL_HOME:-$BREW_PREFIX/opt/mysql@8.0}"
  MYSQL_DATA="${MYSQL_DATA:-$BREW_PREFIX/var/mysql}"
else
  # Windows：不写死任何真机路径 —— 没设就退回 PATH（找不到时下面的自检会响）
  JDK="${JDK_HOME:-}"
  MVN="${MAVEN_BIN:-mvn}"
  MVN_SETTINGS="${MAVEN_SETTINGS:-}"
  MYSQL_HOME="${MYSQL_HOME:-}"
  MYSQL_DATA="${MYSQL_DATA:-}"
fi
MYSQL_BIN="$MYSQL_HOME/bin"
MYSQLADMIN="$MYSQL_BIN/mysqladmin"; MYSQL_CLI="$MYSQL_BIN/mysql"
if [ "$UNAME" != Darwin ]; then MYSQLADMIN="$MYSQLADMIN.exe"; MYSQL_CLI="$MYSQL_CLI.exe"; fi
# 客户端不在默认位置时退回 PATH（plain `brew install mysql` 与 mysql@8.0 的 bin 不一样）。
[ -x "$MYSQLADMIN" ] || MYSQLADMIN="$(command -v mysqladmin || echo "$MYSQLADMIN")"
[ -x "$MYSQL_CLI" ] || MYSQL_CLI="$(command -v mysql || echo "$MYSQL_CLI")"
if [ -z "${JDK:-}" ]; then
  echo "找不到 JDK 21：brew install openjdk@21，并确认 /usr/libexec/java_home -v 21 有输出" >&2
  exit 1
fi

API="${APP_API:-http://127.0.0.1:8080}"
WEB_DEV="${APP_WEB:-http://127.0.0.1:5180}"          # 开发服务器（vite dev）
WEB_PROD="${APP_WEB_PROD:-http://127.0.0.1:4180}"    # 生产构建（vite preview）
JAR="$ROOT/server/target/spatial-design-server-0.1.0-SNAPSHOT.jar"

MODE=db
MODE_PROD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --no-db)  MODE=nodb ;;
    --status) MODE=status ;;
    --prod)   MODE_PROD=1 ;;
    "")       ;;
    *) echo "未知参数：$1（可用：--no-db / --prod / --status）"; exit 2 ;;
  esac
  shift
done

# 前端形态：默认开发服务器（改代码即时生效）；--prod 用生产构建（内存与句柄省一档）
if [ "$MODE_PROD" = 1 ]; then WEB="$WEB_PROD"; else WEB="$WEB_DEV"; fi

ok()   { printf '  [ok]  %s\n' "$*"; }
todo() { printf '  [..]  %s\n' "$*"; }
warn() { printf '  [!!]  %s\n' "$*"; }

http_ok()  { curl -sf --max-time 3 "$1" >/dev/null 2>&1; }
mysql_up() { "$MYSQLADMIN" -u root --protocol=tcp -h 127.0.0.1 ping >/dev/null 2>&1; }

# 跑的到底哪一档存储（`jdbc` / `memory`）。**变量名写错不会报错，只能读事实**：
# start.sh 传 XX_PROFILE / serve.sh 读 SPATIAL_PROFILE 那类事，两边都一声不出。
store_line() {
  local j
  j="$(curl -sf --max-time 5 "$API/api/health" 2>/dev/null || true)"
  [ -z "$j" ] && { echo "档位读不到"; return; }
  printf '%s' "$j" | sed -n 's/.*"store":"\([a-z]*\)".*/存储 \1/p'
}

# 内核在想什么（服务端是唯一裁判 —— 这里把它的结论直接读出来）
kernel_line() {
  local j passed total
  j="$(curl -sf --max-time 5 "$API/api/health/kernel" 2>/dev/null || true)"
  [ -z "$j" ] && { echo "读不到"; return; }
  passed="$(printf '%s' "$j" | grep -o '"passed":[0-9]*' | cut -d: -f2)"
  total="$(printf '%s' "$j" | grep -o '"total":[0-9]*'  | cut -d: -f2)"
  echo "用例表 ${passed}/${total}"
}

# ------------------------------------------------------------------ 只看现状
if [ "$MODE" = status ]; then
  echo
  echo "场景空间设计器 · 本机环境现状"
  echo "------------------------------------------------------------"
  if mysql_up; then ok "MySQL     运行中（127.0.0.1:3306）"; else warn "MySQL     没跑"; fi
  if http_ok "$API/api/health"; then
    ok "后端      运行中（$API ｜ $(kernel_line) ｜ $(store_line)）"
  else warn "后端      没跑"; fi
  if http_ok "$WEB_DEV/";  then ok "前端      开发服务器（${WEB_DEV}）"; else warn "前端      开发服务器没跑（${WEB_DEV}）"; fi
  if http_ok "$WEB_PROD/"; then ok "前端      生产构建（${WEB_PROD}）";  else warn "前端      生产构建没跑（${WEB_PROD}）"; fi
  echo "------------------------------------------------------------"
  exit 0
fi

echo
echo "场景空间设计器 · 本地一键启动"
echo "------------------------------------------------------------"

# ------------------------------------------------------------------ 1) MySQL
if [ "$MODE" = db ]; then
  if mysql_up; then
    ok "MySQL 已在运行"
  elif [ "$UNAME" = Darwin ]; then
    # macOS：库交给 brew services（有 launchd 托管，重启还在）。不在这里 nohup mysqld ——
    # 手起的 mysqld 没人托管，而且 macOS 的 mysqld 没有 --console 这个参数。
    todo "MySQL 没起，用 brew services 拉起……"
    if [ -x "$BREW_BIN" ]; then "$BREW_BIN" services start mysql@8.0 >/dev/null 2>&1 || true; fi
    for _ in {1..60}; do mysql_up && break; sleep 1; done
    if mysql_up; then ok "MySQL 起来了（brew services · mysql@8.0）"
    else warn "MySQL 起不来：先 brew services list 看 mysql@8.0 状态；首次安装要初始化数据目录，见 server/README §5"; exit 1; fi
  else
    todo "MySQL 没起，正在拉起……"
    nohup "$MYSQL_BIN/mysqld.exe" --basedir="$MYSQL_HOME" --datadir="$MYSQL_DATA" --console \
      > "$LOGS/mysql.log" 2>&1 &
    for _ in {1..60}; do mysql_up && break; sleep 1; done
    if mysql_up; then ok "MySQL 起来了（日志 logs/mysql.log）"
    else warn "MySQL 起不来 —— 看 logs/mysql.log；数据目录没初始化过看 server/README §5"; exit 1; fi
  fi

  # 库本身（不是表）也要先存在。CREATE DATABASE IF NOT EXISTS，重复跑无害。
  if "$MYSQL_CLI" -u root --protocol=tcp -h 127.0.0.1 \
       < "$ROOT/server/db/00-create-database.sql" >/dev/null 2>&1; then
    ok "库 spatial_design 就位（表由后端启动时的 Flyway 迁移）"
  else
    warn "建库脚本没跑通：server/db/00-create-database.sql"; exit 1
  fi
else
  todo "跳过 MySQL（--no-db：数据只活在内存里，重启就没）"
fi

# ------------------------------------------------------------------ 2) 后端
STARTED_BACKEND=0
if http_ok "$API/api/health"; then
  ok "后端已在运行（${API}）"
else
  if [ ! -f "$JAR" ]; then
    todo "还没打包，先打包后端（约半分钟，只第一次）……"
    # macOS：`-s` 只在 MVN_SETTINGS 非空时才拼（Windows 便携配置用）。
    # 不用数组拼参数：macOS 自带的 bash 3.2 在 `set -u` 下展开空数组会报 unbound variable。
    BUILD_OK=0
    if [ -n "$MVN_SETTINGS" ]; then
      ( cd "$ROOT/server" && JAVA_HOME="$JDK" "$MVN" -s "$MVN_SETTINGS" -B -DskipTests package ) \
        > "$LOGS/build.log" 2>&1 && BUILD_OK=1
    else
      ( cd "$ROOT/server" && JAVA_HOME="$JDK" "$MVN" -B -DskipTests package ) \
        > "$LOGS/build.log" 2>&1 && BUILD_OK=1
    fi
    if [ "$BUILD_OK" = 1 ]; then
      ok "打包完成"
    else
      warn "打包失败 —— 看 logs/build.log"; exit 1
    fi
  fi

  todo "拉起后端……"
  if [ "$MODE" = db ]; then PROFILE=""; else PROFILE="--spring.profiles.active=local-nodb"; fi
  # ⚠️ 环境变量名必须与 serve.sh 里读的**完全一致**。
  #    这里原来传 `XY_PROFILE`，而 serve.sh 读的是 `SPATIAL_PROFILE` ——
  #    于是 `--no-db` 拼出来的 `--spring.profiles.active=local-nodb` **从来没到过后端**，
  #    两边也都不报错（A6 改名遗留，2026-10-12 修）。
  ( cd "$ROOT" && SPATIAL_PROFILE="$PROFILE" nohup bash server/serve.sh > "$LOGS/backend.log" 2>&1 & )
  STARTED_BACKEND=1

  for _ in {1..120}; do http_ok "$API/api/health" && break; sleep 1; done
  if ! http_ok "$API/api/health"; then
    warn "后端起不来或超时 —— 看 logs/backend.log"; exit 1
  fi
  ok "后端起来了"
fi

# 求证 1：内核用例表真的全绿（"进程还在"不算数）
# ⚠️ 以前这里写死 `用例表 22/22` —— 用例表后来长到 31 条，于是**健康的机器也会被报红**
# （2026-10-08 实测：31/31 全绿却收到「不是全绿」）。报警器乱叫的后果是没人再看它。
# 所以改成「计数自己比」：passed == total 且 total > 0 才算全绿，不再写死数字。
KL="$(kernel_line)"
if [ "$KL" = "读不到" ]; then
  warn "读不到 $API/api/health/kernel"
else
  KP="$(printf '%s' "$KL" | sed -n 's/^用例表 \([0-9][0-9]*\)\/\([0-9][0-9]*\)$/\1 \2/p')"
  if [ -n "$KP" ] && [ "${KP%% *}" = "${KP##* }" ] && [ "${KP%% *}" -gt 0 ]; then
    ok "内核自检 $KL"
  else
    warn "内核自检 $KL —— 不是全绿，别当成功（看 logs/backend.log）"
  fi
fi

# 求证 2：真落库（只查"这一轮刚起的"后端，避免拿旧日志下结论）
if [ "$STARTED_BACKEND" = 1 ] && [ "$MODE" = db ]; then
  if grep -q "MySQL" "$LOGS/backend.log"; then
    ok "确认落库：日志里写着「方案存储 = MySQL」"
  else
    warn "起来了但日志里没有「方案存储 = MySQL」—— 可能跑在内存档，数据重启会丢！"
  fi
fi

# 求证 3：**档位真的生效了**（这是「变量名对不上」唯一能被发现的地方：两边都不报错，
#         界面也「看着像起了」，只有读事实才看得出跑的是哪一档）
STORE="$(curl -sf --max-time 5 "$API/api/health" 2>/dev/null | sed -n 's/.*"store":"\([a-z]*\)".*/\1/p')"
if [ -z "$STORE" ]; then
  warn "读不到 /api/health 里的 store —— 无法确认跑的是哪一档"
elif [ "$MODE" = db ] && [ "$STORE" != jdbc ]; then
  warn "跑的是 $STORE 档而不是连库档 —— 数据重启会丢！"
elif [ "$MODE" = nodb ] && [ "$STORE" != memory ]; then
  warn "--no-db 没用上（跑的还是 $STORE 档）—— 环境变量名与 serve.sh 不一致就是这个样子"
else
  ok "存储档位：$STORE"
fi

# ------------------------------------------------------------------ 3) 前端
if http_ok "$WEB/"; then
  ok "前端已在运行（${WEB}）"
else
  if [ "$MODE_PROD" = 1 ]; then
    # ⚠️ 只跳**构建**这一步，不能连整段都跳 —— 否则落到 else 分支去起开发服务器。
    if [ "${SPATIAL_FRONT_PREBUILT:-0}" = 1 ]; then
      ok "生产包已由 start-prod.sh 构建好（不重复构建：一次切换曾构建两遍、两份日志互相覆盖 —— 第 3 轮审查 C-5）"
    else
      todo "构建生产包（约十几秒）……"
      if ( cd "$ROOT/app" && npm run build ) > "$LOGS/build-front.log" 2>&1; then
        ok "生产包构建完成（logs/build-front.log）"
      else
        warn "生产包构建失败 —— 看 logs/build-front.log"; exit 1
      fi
    fi
    todo "拉起前端（生产构建 :4180）……"
    ( cd "$ROOT/app" && nohup npm run preview > "$LOGS/frontend.log" 2>&1 & )
  else
    todo "拉起前端（Vite 开发服务器 :5180）……"
    ( cd "$ROOT/app" && nohup npm run dev > "$LOGS/frontend.log" 2>&1 & )
  fi
  for _ in {1..90}; do http_ok "$WEB/" && break; sleep 1; done
  if http_ok "$WEB/"; then ok "前端起来了（${WEB}）"
  else warn "前端起不来 —— 看 logs/frontend.log"; exit 1; fi
fi

echo "------------------------------------------------------------"
echo "  打开这一个：  $WEB"
echo "  后端健康：    $API/api/health"
echo "  内核自检：    $API/api/health/kernel"
echo "  接口文档：    $API/swagger-ui/index.html"
echo "  看现状：      bash start.sh --status"
echo "  全停掉：      bash stop.sh"
echo "  日志：        logs/{mysql,backend,frontend}.log"
if [ "$MODE_PROD" = 0 ]; then
  echo "  机器吃紧时：  bash start-prod.sh   （前端换成生产构建 :4180）"
fi
echo
