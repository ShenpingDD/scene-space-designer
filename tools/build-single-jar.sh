#!/usr/bin/env bash
# build-single-jar.sh —— 打一个「前端页面 + 后端接口同一个 jar」的部署包（S2-B）
#
# 做什么（三步，任何一步失败都非零退出）
#   1. 前端：npm --prefix app run build  → app/dist
#   2. 后端：mvn -Psingle-jar clean package
#      profile 在 process-resources 阶段把 app/dist 复制进 classes/static，
#      再由 spring-boot:repackage 打进 BOOT-INF/classes/static/**。
#   3. 校验产物：jar 里必须真的存在 BOOT-INF/classes/static/index.html（以及 assets/ 里的构建产物）。
#      ——「包里没有页面」这件事必须在打包这一步就响亮地失败，而不是等部署完刷新 404 才发现。
#
# 用法
#   bash tools/build-single-jar.sh
#   起包：java -jar server/target/spatial-design-server-<版本>.jar --server.port=8080
#
# 约定（与仓库其它脚本一致）
#   · 不写死本机绝对路径：JDK 先认 JAVA_HOME，再用系统自带的 java_home/brew 定位；
#   · 打印一律 ASCII，避免在非 UTF-8 控制台上乱码；
#   · 默认构建（不带 -Psingle-jar）行为不变 —— 这个脚本只是把带前端的那一档串起来。

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log() { printf '[single-jar] %s\n' "$*"; }
fail() {
  printf '[single-jar] FAIL: %s\n' "$*" >&2
  exit 1
}

# ── 1. 工具链：node / npm / JDK 21 / mvn ──────────────────────────────────────

command -v node >/dev/null 2>&1 || fail 'node not found in PATH (need Node.js for the frontend build)'
command -v npm >/dev/null 2>&1 || fail 'npm not found in PATH (need npm for the frontend build)'
log "node $(node -v), npm $(npm -v)"

# JDK：JAVA_HOME 优先；其次 macOS 自带的 java_home；最后 brew 的 openjdk@21
pick_java_home() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "${JAVA_HOME}/bin/java" ]; then
    printf '%s' "$JAVA_HOME"
    return
  fi
  if [ -x /usr/libexec/java_home ]; then
    local found
    found="$(/usr/libexec/java_home -v 21 2>/dev/null || true)"
    if [ -n "$found" ] && [ -x "$found/bin/java" ]; then
      printf '%s' "$found"
      return
    fi
  fi
  if command -v brew >/dev/null 2>&1; then
    local prefix
    prefix="$(brew --prefix 2>/dev/null || true)"
    if [ -n "$prefix" ] && [ -x "$prefix/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java" ]; then
      printf '%s' "$prefix/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home"
      return
    fi
  fi
  printf ''
}

PICKED_JAVA_HOME="$(pick_java_home)"
[ -n "$PICKED_JAVA_HOME" ] || fail 'JDK not found: set JAVA_HOME to a JDK 21 (mvn would silently use another JDK)'
export JAVA_HOME="$PICKED_JAVA_HOME"
JAVA_MAJOR="$("$JAVA_HOME/bin/java" -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/')"
[ "$JAVA_MAJOR" = '21' ] || fail "JDK 21 required, but $JAVA_HOME is JDK $JAVA_MAJOR"
log "JAVA_HOME=$JAVA_HOME (JDK $JAVA_MAJOR)"

MVN=''
if command -v mvn >/dev/null 2>&1; then
  MVN="$(command -v mvn)"
elif command -v brew >/dev/null 2>&1; then
  prefix="$(brew --prefix 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -x "$prefix/bin/mvn" ]; then
    MVN="$prefix/bin/mvn"
  fi
fi
[ -n "$MVN" ] || fail 'mvn not found in PATH'
export MAVEN_OPTS="${MAVEN_OPTS:--Duser.language=en -Duser.country=US}"
log "mvn $("$MVN" -v 2>/dev/null | head -1)"

# ── 2. 前端构建 ──────────────────────────────────────────────────────────────

log 'step 1/3: frontend build (npm --prefix app run build)'
npm --prefix app run build
[ -f app/dist/index.html ] || fail 'app/dist/index.html missing after the frontend build'

# ── 3. 后端打包（带前端产物）────────────────────────────────────────────────

log 'step 2/3: backend package (mvn -Psingle-jar clean package)'
# 仓库根没有 pom（后端工程在 server/）：用 -f 指定，别在根目录裸跑 mvn。
"$MVN" -B -f server/pom.xml -Psingle-jar clean package

# ── 4. 校验 jar：页面真的在里面吗 ────────────────────────────────────────────

log 'step 3/3: verify jar contents'
JAR="$(ls -1 "$ROOT"/server/target/spatial-design-server-*.jar 2>/dev/null | head -1)"
[ -n "$JAR" ] || fail 'jar not found under server/target (did the package step really run?)'
[ -f "$JAR" ] || fail "jar not found: $JAR"

JAR_TOOL='jar'
if [ -x "$JAVA_HOME/bin/jar" ]; then
  JAR_TOOL="$JAVA_HOME/bin/jar"
fi

ENTRIES="$("$JAR_TOOL" tf "$JAR")"
printf '%s\n' "$ENTRIES" | grep -qx 'BOOT-INF/classes/static/index.html' \
  || fail "jar has no BOOT-INF/classes/static/index.html: $JAR (the single-jar profile did not copy app/dist)"
STATIC_COUNT="$(printf '%s\n' "$ENTRIES" | grep -c '^BOOT-INF/classes/static/' || true)"
ASSET_COUNT="$(printf '%s\n' "$ENTRIES" | grep -c '^BOOT-INF/classes/static/assets/' || true)"
[ "$ASSET_COUNT" -gt 0 ] || fail "jar has no BOOT-INF/classes/static/assets/*: $JAR (frontend assets missing)"

SIZE_BYTES="$(wc -c < "$JAR" | tr -d ' ')"
SIZE_HUMAN="$(du -h "$JAR" | cut -f1 | tr -d ' ')"

log 'OK: single jar is ready'
printf '[single-jar]   jar:            %s\n' "$JAR"
printf '[single-jar]   size:           %s (%s bytes)\n' "$SIZE_HUMAN" "$SIZE_BYTES"
printf '[single-jar]   static entries: %s (assets: %s)\n' "$STATIC_COUNT" "$ASSET_COUNT"
printf '[single-jar]   run:            java -jar "%s" --server.port=8080\n' "$JAR"
