#!/usr/bin/env bash
set -e

VERSION="${1:-$(TZ=Asia/Taipei date +"%y%m.%-d.%-H%M")}"
IMAGE="cojad/openclaw"
# Promote-tag pattern: build to a private staging tag, run the guards against it,
# and only promote to ${VERSION} + latest AFTER every guard passes. A churning or
# broken image therefore never exists under a deployable tag — the cron's deploy
# step finds no ${IMAGE}:${VERSION} and refuses to ship it. (2026-08-09 incident:
# the guard only gated `latest`, but the cron deployed the explicit ${VERSION}
# tag, which was created before the guards -> a churning image reached prod.)
STAGING="${IMAGE}:staging-$$-$(TZ=Asia/Taipei date +%H%M%S)"
GUARD_IMAGE="${STAGING}"

# Optional: seed the boot smoke test with a COPY of real prod state+config so
# state/config-dependent failures (schema mismatch, removed config keys, memory
# core init) are caught in the build, not on the live container. Set to a config
# root that contains .openclaw/ (e.g. /x/srv/bot/eagle/config). Channels are NOT
# started during this check, so it never hijacks the live Telegram poller.
SMOKE_STATE_SRC="${OPENCLAW_SMOKE_STATE_SRC:-}"

# ---------------------------------------------------------------------------
# Why the guards exist:
#  - codex@beta version-bound churn (2026-08-08): `codex` is a version-bound
#    official runtime plugin; when core runs ahead of the newest published
#    @openclaw/codex, every boot re-refreshes it, the migration fingerprint never
#    settles, and the gateway crash-loops with "migration inputs changed during
#    startup convergence" -> Exited(1), no channel starts, yet docker reports
#    healthy for a while (silent breakage).
#  - state/config drift (2026-08-09): a new upstream removed a config key
#    (memory.backend), changed table schemas, and hit a memory-core module
#    assertion — none reproducible against a clean config, only against real state.
#  Guard 1: fast static heuristic. Guard 2a: clean-config two-boot convergence.
#  Guard 2b (opt-in): doctor --fix against a copy of real state.
# ---------------------------------------------------------------------------

# Single cleanup owner: drop the staging image + smoke volume on any exit path so
# a failed build leaves nothing deployable and no dangling resources.
SMOKE_VOL=""
cleanup() {
  [ -n "${SMOKE_VOL}" ] && docker volume rm "${SMOKE_VOL}" >/dev/null 2>&1 || true
  docker image inspect "${STAGING}" >/dev/null 2>&1 && docker rmi "${STAGING}" >/dev/null 2>&1 || true
  rm -f "${SMOKE_LOG:-}" 2>/dev/null || true
}
trap cleanup EXIT

echo "==> Building upstream OpenClaw image..."
docker build \
  -t openclaw:upstream \
  -f Dockerfile .

echo ""
echo "==> Building custom image (staging): ${STAGING}"
docker build \
  --build-arg UPSTREAM_IMAGE=openclaw:upstream \
  --build-arg OPENCLAW_VERSION="${VERSION}" \
  -t "${STAGING}" \
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
  # Heuristic only (guard 2 is authoritative): core ahead of codex is the exact
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
# Guard 2a — boot smoke test (clean config, 2 boots): catches convergence churn.
# A first-ever boot legitimately installs the configured runtime plugin (codex)
# and reports "restart needed" — NOT churn. Only the SECOND boot is authoritative.
# ---------------------------------------------------------------------------
echo ""
echo "==> [guard 2/2] boot smoke test (startup convergence, 2 boots)..."
SMOKE_LOG="$(mktemp)"
SMOKE_VOL="openclaw-smoke-$$"
docker volume create "${SMOKE_VOL}" >/dev/null
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

BOOT2_LOG="$(sed -n '/===SMOKE_BOOT_2===/,$p' "${SMOKE_LOG}")"
if printf '%s' "${BOOT2_LOG}" | grep -qiE 'migration inputs changed during startup convergence|refusing to report the gateway ready|Refreshed stale configured plugin'; then
  echo "X [guard 2a] convergence churn on second boot -> image would crash-loop. Not shipping:"
  printf '%s' "${BOOT2_LOG}" | grep -iE 'Refreshed stale configured plugin|migration inputs changed|refusing to report' | sort -u | head -5
  exit 1
fi
if ! printf '%s' "${BOOT2_LOG}" | grep -qiE 'http server listening'; then
  echo "X [guard 2a] gateway never reported ready on second boot. Not shipping:"
  printf '%s' "${BOOT2_LOG}" | tail -15
  exit 1
fi
echo "    [2a] clean-config second boot reached ready, no churn. OK"
docker volume rm "${SMOKE_VOL}" >/dev/null 2>&1 || true
SMOKE_VOL=""

# ---------------------------------------------------------------------------
# Guard 2b (opt-in) — doctor --fix against a COPY of real prod state/config.
# Catches schema mismatches, removed config keys, and migration/memory failures
# that only surface against real data. Runs doctor only (no gateway boot), so no
# channel starts and the live Telegram poller is never touched.
# ---------------------------------------------------------------------------
if [ -n "${SMOKE_STATE_SRC}" ] && [ -d "${SMOKE_STATE_SRC}/.openclaw" ]; then
  echo ""
  echo "==> [guard 2b] doctor --fix against real state copy (${SMOKE_STATE_SRC})..."
  STATE_VOL="openclaw-state-smoke-$$"
  SMOKE_VOL="${STATE_VOL}"   # hand ownership to cleanup()
  docker volume create "${STATE_VOL}" >/dev/null
  # Seed the volume with real config + state DBs, EXCLUDING the giant dirs
  # (media/npm/plugin caches/logs/queues) that are irrelevant to migration checks.
  docker run --rm -v "${STATE_VOL}:/home/node" -v "${SMOKE_STATE_SRC}:/src:ro" \
    --entrypoint sh "${GUARD_IMAGE}" -c '
      mkdir -p /home/node/.openclaw &&
      tar -C /src/.openclaw \
        --exclude=media --exclude=npm --exclude=plugin-runtime-deps \
        --exclude=plugin-skills --exclude=logs --exclude=.git \
        --exclude=session-delivery-queue --exclude=media-cache \
        -cf - . 2>/dev/null | tar -C /home/node/.openclaw -xf - &&
      chown -R node:node /home/node 2>/dev/null || true'
  STATE_LOG="$(mktemp)"
  timeout 240 docker run --rm -v "${STATE_VOL}:/home/node" \
    --entrypoint sh "${GUARD_IMAGE}" -c \
    'exec node dist/index.js doctor --fix' \
    > "${STATE_LOG}" 2>&1 || true
  if grep -qiE 'schema is incomplete or noncanonical|does not match [0-9]|Invalid config|ERR_INTERNAL_ASSERTION|did not complete cleanly' "${STATE_LOG}"; then
    echo "X [guard 2b] doctor --fix failed against real state -> image would break prod. Not shipping:"
    grep -iE 'schema is incomplete|does not match|Invalid config|ERR_INTERNAL_ASSERTION|did not complete' "${STATE_LOG}" | sort -u | head -8
    rm -f "${STATE_LOG}"
    exit 1
  fi
  echo "    [2b] doctor --fix converged against real state. OK"
  rm -f "${STATE_LOG}"
  docker volume rm "${STATE_VOL}" >/dev/null 2>&1 || true
  SMOKE_VOL=""
else
  echo ""
  echo "==> [guard 2b] skipped (set OPENCLAW_SMOKE_STATE_SRC=<config root> to check real state)."
fi

# ---------------------------------------------------------------------------
# All guards passed -> promote staging to the deployable tags.
# ---------------------------------------------------------------------------
docker tag "${STAGING}" "${IMAGE}:${VERSION}"
docker tag "${STAGING}" "${IMAGE}:latest"
docker rmi "${STAGING}" >/dev/null 2>&1 || true
trap - EXIT

echo ""
echo "Built successfully (guards passed, promoted from staging):"
echo "   - ${IMAGE}:${VERSION}"
echo "   - ${IMAGE}:latest"
echo ""
echo "Environment variables set in image:"
echo "   OPENCLAW_BUNDLED_VERSION=${VERSION}"
