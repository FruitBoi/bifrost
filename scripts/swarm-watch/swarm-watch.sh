#!/usr/bin/env bash
# Polls FruitBoi/bifrost issue comments and runs `claude -p "/swarm-issue <n>"` when a user listed in
# .github/swarm-allowed-users comments `/swarm` (or `/swarm-issue`) on an open issue.
# Meant to run from bifrost-swarm.timer; see scripts/swarm-watch/README.md.
set -euo pipefail

REPO="${SWARM_REPO:-FruitBoi/bifrost}"
BRANCH="${SWARM_BRANCH:-feat/thread-bridging}"
ALLOWLIST_PATH="${SWARM_ALLOWLIST_PATH:-.github/swarm-allowed-users}"
WORKDIR="${SWARM_WORKDIR:-$HOME/bifrost-swarm}"
MAIN_CHECKOUT="${SWARM_MAIN_CHECKOUT:-$HOME/Documents/dev/bifrost}"
STATE_DIR="${SWARM_STATE_DIR:-$HOME/.local/state/bifrost-swarm}"
PERMISSION_MODE="${SWARM_PERMISSION_MODE:-auto}"
MODEL="${SWARM_MODEL:-opus}"
RESULT_GRACE="${SWARM_RESULT_GRACE:-2m}"
NODE_IMAGE="${SWARM_NODE_IMAGE:-docker.io/library/node:20}"

export GH_PAGER=cat
mkdir -p "$STATE_DIR/logs"
exec 9>"$STATE_DIR/lock"
flock -n 9 || { echo "another swarm-watch run holds the lock"; exit 0; }

log() { echo "[swarm-watch] $*"; }

# First run: start watching from now so old comments never trigger a swarm.
if [[ ! -f "$STATE_DIR/since" ]]; then
  date -u +%Y-%m-%dT%H:%M:%SZ >"$STATE_DIR/since"
  touch "$STATE_DIR/processed"
  log "initialised; watching comments from $(cat "$STATE_DIR/since")"
  exit 0
fi

allowed_users() {
  gh api -H 'Accept: application/vnd.github.raw+json' \
    "repos/$REPO/contents/$ALLOWLIST_PATH?ref=$BRANCH" 2>/dev/null |
    sed -e 's/#.*//' -e 's/[[:space:]]//g' | grep -v '^$' | tr '[:upper:]' '[:lower:]' || true
}

react() { # comment_id content
  gh api -X POST "repos/$REPO/issues/comments/$1/reactions" -f content="$2" >/dev/null || true
}

prepare_workdir() {
  if [[ ! -d "$WORKDIR/.git" ]]; then
    git clone "git@github.com:$REPO.git" "$WORKDIR"
  fi
  git -C "$WORKDIR" fetch origin
  git -C "$WORKDIR" checkout -B "$BRANCH" "origin/$BRANCH"
  git -C "$WORKDIR" reset --hard "origin/$BRANCH"
  git -C "$WORKDIR" clean -fd

  # .claude/ is gitignored, so borrow the skills from the main checkout.
  mkdir -p "$WORKDIR/.claude"
  ln -sfn "$MAIN_CHECKOUT/.claude/skills" "$WORKDIR/.claude/skills"

  # Share the main checkout's Claude project memory with the clone.
  local slug_main slug_work
  slug_main="$(sed 's/[^A-Za-z0-9]/-/g' <<<"$MAIN_CHECKOUT")"
  slug_work="$(sed 's/[^A-Za-z0-9]/-/g' <<<"$WORKDIR")"
  if [[ -d "$HOME/.claude/projects/$slug_main/memory" && ! -e "$HOME/.claude/projects/$slug_work/memory" ]]; then
    mkdir -p "$HOME/.claude/projects/$slug_work"
    ln -s "$HOME/.claude/projects/$slug_main/memory" "$HOME/.claude/projects/$slug_work/memory"
  fi

  # The skill verifies with ./node_modules/.bin tools, so keep dependencies installed.
  local lock_sha
  lock_sha="$(sha256sum "$WORKDIR/pnpm-lock.yaml" | cut -d' ' -f1)"
  if [[ "$(cat "$WORKDIR/node_modules/.swarm-lock-sha" 2>/dev/null)" != "$lock_sha" ]]; then
    log "installing dependencies"
    podman run --rm -v "$WORKDIR:/app:z" -w /app -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$NODE_IMAGE" \
      sh -c 'corepack enable && pnpm install --frozen-lockfile --store-dir /tmp/pnpm-store'
    echo "$lock_sha" >"$WORKDIR/node_modules/.swarm-lock-sha"
  fi
}

# Streams Claude's progress to <logfile>.jsonl and appends the final report to <logfile>.
# `claude -p` sometimes stays alive after its final result, which would block the watcher, so once the
# result is out it gets a grace period and is then killed. Success comes from the result, not the exit code.
claude_swarm() { # issue logfile
  local issue="$1" logfile="$2" stream="$2.jsonl" pid
  (cd "$WORKDIR" && BIFROST_SWARM_UNATTENDED=1 exec claude -p "/swarm-issue $issue" \
    --model "$MODEL" --permission-mode "$PERMISSION_MODE" --output-format stream-json --verbose \
    </dev/null >"$stream" 2>>"$logfile") &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if grep -q '^{"type":"result"' "$stream"; then
      timeout "$RESULT_GRACE" tail --pid="$pid" -f /dev/null || {
        log "claude still running ${RESULT_GRACE} after its result; killing it" >>"$logfile"
        kill "$pid" 2>/dev/null
      }
      break
    fi
    sleep 10
  done
  wait "$pid" || true

  grep '^{"type":"result"' "$stream" | tail -1 | jq -r '.result // empty' >>"$logfile"
  grep '^{"type":"result"' "$stream" | tail -1 | jq -e '.is_error == false' >/dev/null
}

run_swarm() { # issue comment_id login
  local issue="$1" comment_id="$2" login="$3" logfile
  logfile="$STATE_DIR/logs/issue-$issue-$(date -u +%Y%m%dT%H%M%SZ).log"
  log "swarming issue #$issue for @$login (log: $logfile)"
  react "$comment_id" eyes

  if prepare_workdir >>"$logfile" 2>&1 && claude_swarm "$issue" "$logfile"; then
    log "issue #$issue finished"
  else
    log "issue #$issue failed"
    react "$comment_id" confused
    gh issue comment "$issue" --repo "$REPO" --body \
      "The swarm run for this issue exited with an error before finishing. Log on the dev server: \`${logfile/#$HOME/\~}\`" \
      >/dev/null || true
  fi
}

poll_start="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
since="$(cat "$STATE_DIR/since")"

# Fields: comment id, author login, issue number. Only comments whose first line is /swarm or /swarm-issue.
mapfile -t triggers < <(
  gh api -X GET "repos/$REPO/issues/comments" -f since="$since" -f sort=created -f direction=asc \
    -f per_page=100 --paginate \
    --jq '.[] | select(.body | test("^\\s*/swarm(-issue)?[ \\t]*(\\r?\\n|$)"))
          | [.id, .user.login, (.issue_url | split("/") | last)] | @tsv'
)

if ((${#triggers[@]})); then
  mapfile -t allowed < <(allowed_users)
  for line in "${triggers[@]}"; do
    IFS=$'\t' read -r comment_id login issue <<<"$line"
    grep -qx "$comment_id" "$STATE_DIR/processed" && continue
    echo "$comment_id" >>"$STATE_DIR/processed"

    if ! printf '%s\n' "${allowed[@]}" | grep -qxF "${login,,}"; then
      log "ignoring /swarm on #$issue from @$login (not in $ALLOWLIST_PATH)"
      continue
    fi
    read -r state is_pr < <(gh api "repos/$REPO/issues/$issue" --jq '[.state, has("pull_request")] | @tsv')
    if [[ "$state" != open || "$is_pr" == true ]]; then
      log "ignoring /swarm on #$issue (state=$state, pull_request=$is_pr)"
      continue
    fi
    run_swarm "$issue" "$comment_id" "$login"
  done
fi

echo "$poll_start" >"$STATE_DIR/since"
