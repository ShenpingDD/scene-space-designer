#!/usr/bin/env bash
# check-secrets.sh —— 提交历史里的密钥扫描（gitleaks）
#
# 为什么单列一个脚本：`gate.sh` 的其余步骤都是"跑代码"，这一步跑的是**历史**。
# 公开仓的历史一旦推出去就抹不掉，密钥泄漏只能靠改密钥止损 —— 所以它必须在推送前就跑到。
#
# 用法：
#   bash tools/verify/check-secrets.sh              # 扫全部提交
#   bash tools/verify/check-secrets.sh --staged     # 只扫暂存区（pre-commit 用）
#
# 退出码：0 = 干净；1 = 命中（真的有问题）；2 = 环境不满足（没有 gitleaks 且下不下来）
# 注意：2 是"没验"，不是"通过"。按项目规矩 SKIP ≠ PASS。
set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VERSION="${GITLEAKS_VERSION:-8.28.0}"
ARGS="--all"

if [ "${1:-}" = "--staged" ]; then
  ARGS=""
fi

# 1) 本机有就用本机的（版本不限，行为差异可接受）
if command -v gitleaks >/dev/null 2>&1; then
  GL="$(command -v gitleaks)"
else
  # 2) 没有就下同版本官方二进制到 /tmp（不写仓库、不改 PATH）
  OS="$(uname -s)"; ARCH="$(uname -m)"
  case "$OS-$ARCH" in
    Linux-x86_64) PKG="gitleaks_${VERSION}_linux_x64.tar.gz" ;;
    Linux-aarch64|Linux-arm64) PKG="gitleaks_${VERSION}_linux_arm64.tar.gz" ;;
    Darwin-arm64) PKG="gitleaks_${VERSION}_darwin_arm64.tar.gz" ;;
    Darwin-x86_64) PKG="gitleaks_${VERSION}_darwin_x64.tar.gz" ;;
    *) echo "[secrets] 不认识的平台：$OS-$ARCH" >&2; exit 2 ;;
  esac
  TMP="${TMPDIR:-/tmp}/gitleaks-${VERSION}"
  mkdir -p "$TMP"
  if [ ! -x "$TMP/gitleaks" ]; then
    URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${PKG}"
    if ! curl -fsSL --max-time 45 "${URL}" | tar -xz -C "$TMP" gitleaks 2>/dev/null; then
      echo "[secrets] 取不到 gitleaks（${URL}）" >&2
      echo "[secrets] 退到等价正则全量扫（**这不算通过**，最终以 gitleaks 为准）：" >&2
      # 只报"看起来是凭证赋值"的行；已知良性（测试夹具/占位符）在这里排除。
      git -C "$ROOT" grep -nIE '(api[_-]?key|secret|passwd|password|token|private[_-]key)[[:space:]]*[:=][[:space:]]*["'"'"'][^"'"'"']{8,}' \
        | grep -viE 'no-password|DB_PASSWORD|\$\{|pw-123456|MTIzNDU2Nzg5MGFiY2RlZg|placeholder|example|dummy' \
        | head -20
      echo "[secrets] 环境不满足（没装 gitleaks 且下不下来）—— SKIP ≠ PASS" >&2
      exit 2
    fi
  fi
  GL="$TMP/gitleaks"
fi

echo "[secrets] $("$GL" version 2>/dev/null || echo gitleaks) · 扫描范围：${ARGS:-暂存区}"
if [ -z "$ARGS" ]; then
  "$GL" protect --staged --redact --no-banner --exit-code 1
else
  "$GL" detect --source "$ROOT" --log-opts="$ARGS" --redact --no-banner --exit-code 1
fi
rc=$?
case "$rc" in
  0) echo "[secrets] 干净" ;;
  1) echo "[secrets] 命中疑似密钥 —— 先改密钥，再清历史（filter-repo），不要只删文件" >&2 ;;
  *) echo "[secrets] gitleaks 异常退出：$rc" >&2 ;;
esac
exit "$rc"
