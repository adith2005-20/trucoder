#!/usr/bin/env bash
# Auto-deploy for GitHub push webhooks (trucoder, dockerized 2026-08).
# Runs ON THE HOST, triggered by the systemd path unit (trucoder-deploy.path)
# watching .deploy-trigger — which the app's /_deploy endpoint writes after
# an HMAC-verified push to main. Idempotent: fetches, fast-forwards,
# rebuilds ONLY what changed, swaps containers with compose.
#
# The deploy process lives outside the container being replaced, so the old
# "deploy killed by its own restart" cgroup saga is gone. No sudo needed:
# the deploy user must be in the docker group.
set -u
REPO_DIR="${DEPLOY_DIR:-/opt/trucoder}"
LOG="$REPO_DIR/deploy.log"
SHA_FILE="$REPO_DIR/.deployed-sha"
cd "$REPO_DIR" || exit 1

log() { echo "[$(date -Is)] $*" >> "$LOG"; }

# Serialize deploys: if one is running, skip quietly (next push re-triggers).
exec 9>"$REPO_DIR/.deploy.lock"
flock -n 9 || { log "deploy skipped: another deploy is running"; exit 0; }

log "deploy start (md5 $(md5sum "$0" | cut -d' ' -f1) pid $$)"
git fetch origin >/dev/null 2>&1
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
if [ "$LOCAL" = "$REMOTE" ] && [ "$(cat "$SHA_FILE" 2>/dev/null)" = "$LOCAL" ]; then
  log "deploy no-op: already at ${REMOTE:0:7} (sha marker matches)"
  exit 0
fi

git pull --ff-only origin main >/dev/null 2>&1 || { log "deploy FAILED: git pull"; exit 1; }
NEW=$(git rev-parse HEAD)
PREV=$(cat "$SHA_FILE" 2>/dev/null || echo "$LOCAL")
CHANGED=$(git diff --name-only "$PREV".."$NEW")

SERVER=0; WEB=0; SANDBOX=0; SANDBOX_NODE=0
echo "$CHANGED" | grep -q '^server/' && SERVER=1
echo "$CHANGED" | grep -q '^web/' && WEB=1
echo "$CHANGED" | grep -q '^sandbox-image/' && SANDBOX=1
echo "$CHANGED" | grep -q '^sandbox-image-node/' && SANDBOX_NODE=1

log "changes: server=$SERVER web=$WEB sandbox=$SANDBOX sandbox-node=$SANDBOX_NODE (${NEW:0:7})"
ANY=$((SERVER+WEB+SANDBOX+SANDBOX_NODE))

if [ "$SANDBOX" = 1 ]; then
  docker compose build sandbox >> "$LOG" 2>&1 \
    || { log "deploy FAILED: sandbox image build"; exit 1; }
fi
if [ "$SANDBOX_NODE" = 1 ]; then
  docker compose build sandbox-node >> "$LOG" 2>&1 \
    || { log "deploy FAILED: sandbox-node image build"; exit 1; }
fi
if [ "$SERVER" = 1 ] || [ "$WEB" = 1 ]; then
  docker compose build --build-arg BUILD_COMMIT="$NEW" app >> "$LOG" 2>&1 \
    || { log "deploy FAILED: app image build"; exit 1; }
fi

if [ "$ANY" -gt 0 ]; then
  log "deploy: ANY=$ANY entering swap phase"
  docker compose up -d >> "$LOG" 2>&1
  UPEXIT=$?
  log "deploy: compose up exit=$UPEXIT"
  if [ "$UPEXIT" != 0 ]; then log "deploy FAILED: compose up"; exit 1; fi
  # Wait for the sandbox daemons — verify.js below needs them.
  for port in 9000 9001; do
    for i in $(seq 1 30); do
      curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
      [ "$i" = 30 ] && log "deploy WARNING: sandbox daemon :$port not healthy after 30s"
      sleep 1
    done
  done
  # Prove the SWAP actually happened: the running app container must bake
  # THIS commit. compose up -d can silently no-op (observed 2026-08-12:
  # image retagged, container kept the old image, .deployed-sha advanced
  # anyway). Verify the bundle label; fail loud if it doesn't match.
  CID=$(docker compose ps -q app 2>/dev/null | head -1)
  if [ -n "$CID" ]; then
    BAKED=$(docker exec "$CID" sh -c "grep -oh 'build \",\"[0-9a-f]*' web/dist/assets/index-*.js | head -1" 2>/dev/null | grep -o '[0-9a-f]\{40\}')
    if [ "$BAKED" != "$NEW" ]; then
      log "deploy FAILED: container bakes ${BAKED:-none}, expected $NEW — swap did not take"
      [ -x "$HOME/.hermes/scripts/hark-notify.sh" ] \
        && "$HOME/.hermes/scripts/hark-notify.sh" -t "trucoder" "deploy SWAP FAILED at ${NEW:0:7} (still running ${BAKED:-unknown})" >/dev/null 2>&1 || true
      exit 1
    fi
    log "swap verified: container bakes ${NEW:0:7}"
  else
    log "deploy WARNING: no app container id — swap check skipped"
  fi
fi

# Verify against the deployed image (throwaway container on the internal
# network — same code path as the live app).
docker compose run --rm app node server/scripts/verify.js >> "$LOG" 2>&1
VR=$?
echo "$NEW" > "$SHA_FILE"

if [ "$VR" = 0 ]; then
  log "deploy OK ${NEW:0:7} (server=$SERVER web=$WEB sandbox=$SANDBOX sandbox-node=$SANDBOX_NODE) verify=pass"
  [ -x "$HOME/.hermes/scripts/hark-notify.sh" ] \
    && "$HOME/.hermes/scripts/hark-notify.sh" -t "trucoder" "deployed ${NEW:0:7} — verify pass" >/dev/null 2>&1 || true
else
  log "deploy DONE ${NEW:0:7} BUT verify FAILED — inspect immediately"
  [ -x "$HOME/.hermes/scripts/hark-notify.sh" ] \
    && "$HOME/.hermes/scripts/hark-notify.sh" -t "trucoder" "deploy VERIFY FAILED at ${NEW:0:7}" >/dev/null 2>&1 || true
fi
exit 0
