#!/usr/bin/env bash
set -e

VERSION="${1:-$(TZ=Asia/Taipei date +"%y%m.%-d.%-H%M")}"
IMAGE="cojad/openclaw"
GUARD_IMAGE="${IMAGE}:${VERSION}"

# ---------------------------------------------------------------------------
# Why the guards below exist (codex@beta version-bound churn, 2026-08-08):
#   `codex` is a version-bound official runtime plugin — doctor keeps it on the
#   same release cohort as core. When core is ahead of the newest published
#   @openclaw/codex (and codex is NOT bundled into dist), every boot re-refreshes
#   the plugin, the startup migration fingerprint never settles, and the gateway
#   crash-loops with "migration inputs changed during startup convergence" →
#   Exited(1), and no channel (Telegram etc.) ever starts. The container still
#   reports docker "healthy" for a while, so the breakage is silent.
#   Guard 1 is a fast heuristic; Guard 2 boots the image and is the real gate.
# ---------------------------------------------------------------------------

echo "==> Building upstream OpenClaw image..."
docker build \
  -t openclaw:upstream \
  -f Dockerfile .

echo ""
echo "==> Building custom image: ${IMAGE}:${VERSION}"
docker build \
  --build-arg UPSTREAM_IMAGE=openclaw:upstream \
  --build-arg OPENCLAW_VERSION="${VERSION}" \
  -t "${GUARD_IMAGE}" \
  -f Dockerfile.cojad .

# ---------------------------------------------------------------------------
# Guard 1/2 — static preflight: version-bound plugin availability (fast)
# ---------------------------------------------------------------------------
echo ""
echo "==> [guard 1/2] version-bound plugin preflight..."
if docker run --rm --entrypoint sh "${GUARD_IMAGE}" -c 'test -d /app/dist/extensions/codex' 2>/dev/null; then
  echo "    codex is bundled into dist -> no npm version binding, cannot churn. OK"
elif ! command -v npm >/dev/null 2>&1; then
  echo "    npm not on build host; skipping static check (guard 2 still gates)."
else
  CODEX_BETA="$(npm view '@openclaw/codex@beta' version 2>/dev/null || echo '')"
  if [ -z "${CODEX_BETA}" ]; then
    echo "X [guard 1/2] cannot resolve @openclaw/codex@beta from npm (registry/tag issue)."
    echo "   Image needs codex from npm but none is resolvable -> it will churn on boot."
    exit 1
  fi
  # Heuristic only: version-bound match semantics are fuzzy, so a train mismatch
  # is a WARNING (guard 2 is authoritative), but core ahead of codex is the exact
  # shape that caused the 2026.8.1-beta churn.
  core_mm="$(printf '%s' "${VERSION}" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')"
  codex_mm="$(printf '%s' "${CODEX_BETA}" | sed -E 's/^([0-9]+\.[0-9]+).*/\1/')"
  echo "    core=${VERSION} (train ${core_mm}) | @openclaw/codex@beta=${CODEX_BETA} (train ${codex_mm})"
  if [ "${core_mm}" != "${codex_mm}" ]; then
    echo "!! [guard 1/2] core train (${core_mm}) != codex train (${codex_mm})."
    echo "   version-bound codex may never match core -> churn risk. Bundle codex or"
    echo "   align the core version. The boot smoke test below is the definitive check."
  fi
fi

# ---------------------------------------------------------------------------
# Guard 2/2 — boot smoke test: refuse images that crash-loop on startup (real gate)
# Two boots on a persistent home: a first-ever boot legitimately installs the
# configured runtime plugin (codex) and reports "restart needed" — that is NOT
# churn. Only the SECOND boot is authoritative: a healthy image converges to
# "http server listening"; a version-bound-churn image re-refreshes forever.
# ---------------------------------------------------------------------------
echo ""
echo "==> [guard 2/2] boot smoke test (startup convergence, 2 boots)..."
SMOKE_LOG="$(mktemp)"
SMOKE_VOL="openclaw-smoke-$$"
docker volume create "${SMOKE_VOL}" >/dev/null
smoke_cleanup() { docker volume rm "${SMOKE_VOL}" >/dev/null 2>&1 || true; rm -f "${SMOKE_LOG}"; }
trap smoke_cleanup EXIT
# Minimal config: configures the codex runtime (so doctor exercises the exact
# install path production hits) and binds loopback so the gateway can reach ready
# without an auth token.
SMOKE_CFG='{"gateway":{"mode":"local","bind":"loopback"},"agents":{"defaults":{"model":{"primary":"openai/gpt-5.5"},"models":{"openai/gpt-5.5":{"agentRuntime":{"id":"codex"}}}}},"plugins":{"entries":{"codex":{"enabled":true}}}}'

echo "    boot 1/2 (install configured plugins)..."
timeout 150 docker run --rm -v "${SMOKE_VOL}:/home/node" -e SMOKE_CFG="${SMOKE_CFG}" \
  --entrypoint sh "${GUARD_IMAGE}" -c \
  'mkdir -p "$HOME/.openclaw" && printf "%s" "$SMOKE_CFG" > "$HOME/.openclaw/openclaw.json" && exec node dist/index.js gateway --allow-unconfigured' \
  > "${SMOKE_LOG}" 2>&1 || true

echo "===SMOKE_BOOT_2===" >> "${SMOKE_LOG}"
echo "    boot 2/2 (must converge to ready)..."
timeout 150 docker run --rm -v "${SMOKE_VOL}:/home/node" \
  --entrypoint sh "${GUARD_IMAGE}" -c \
  'exec node dist/index.js gateway --allow-unconfigured' \
  >> "${SMOKE_LOG}" 2>&1 || true

# Only the second boot's outcome is authoritative.
BOOT2_LOG="$(sed -n '/===SMOKE_BOOT_2===/,$p' "${SMOKE_LOG}")"
if printf '%s' "${BOOT2_LOG}" | grep -qiE 'migration inputs changed during startup convergence|refusing to report the gateway ready|Refreshed stale configured plugin'; then
  echo "X [guard 2/2] convergence churn on second boot -> image would crash-loop. Not shipping:"
  printf '%s' "${BOOT2_LOG}" | grep -iE 'Refreshed stale configured plugin|migration inputs changed|refusing to report' | sort -u | head -5
  exit 1
fi
if ! printf '%s' "${BOOT2_LOG}" | grep -qiE 'http server listening'; then
  echo "X [guard 2/2] gateway never reported ready on second boot. Not shipping:"
  printf '%s' "${BOOT2_LOG}" | tail -15
  exit 1
fi
echo "    second boot reached ready, no convergence churn. OK"
smoke_cleanup
trap - EXIT

# Guards passed -> safe to publish latest.
docker tag "${GUARD_IMAGE}" "${IMAGE}:latest"

echo ""
echo "Built successfully:"
echo "   - ${IMAGE}:${VERSION}"
echo "   - ${IMAGE}:latest"
echo ""
echo "Environment variables set in image:"
echo "   OPENCLAW_BUNDLED_VERSION=${VERSION}"
