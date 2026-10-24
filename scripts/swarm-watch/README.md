# swarm-watch

Starts a Claude swarm (`/swarm-issue <n>`) when an allowed user comments `/swarm` on an open issue in
FruitBoi/bifrost. It runs on the dev server as a systemd user timer that polls GitHub every 30 seconds.

## Triggering

Comment on the issue with a first line of `/swarm` (or `/swarm-issue`). The watcher reacts 👀 when it
picks the comment up, then runs the swarm, which comments and closes the issue as usual. If the run
errors, the watcher reacts 😕 and comments the path of the log on the dev server.

Only logins listed in [`.github/swarm-allowed-users`](../../.github/swarm-allowed-users) can trigger it.
The watcher reads that file from `feat/thread-bridging` on GitHub, so changes take effect once pushed.
Comments from anyone else, on pull requests, or on closed issues are ignored.

## How it runs

- Swarms run one at a time in a separate clone (`~/bifrost-swarm`), reset to `origin/feat/thread-bridging`
  before each run, so they never touch the main checkout.
- `.claude/` is gitignored, so the clone symlinks `.claude/skills` from the main checkout, and the
  clone's Claude project memory is symlinked to the main checkout's.
- Dependencies are installed in the clone with podman when `pnpm-lock.yaml` changes.
- Claude runs headless on Opus (`--model opus`) with `--permission-mode auto` and `BIFROST_SWARM_UNATTENDED=1`.
- State and logs live in `~/.local/state/bifrost-swarm/`. The first run only records the current
  time, so older comments never trigger a swarm.

Settings can be overridden in `~/.config/bifrost-swarm.env` (`SWARM_REPO`, `SWARM_BRANCH`,
`SWARM_WORKDIR`, `SWARM_MAIN_CHECKOUT`, `SWARM_MODEL`, `SWARM_PERMISSION_MODE`, ...; see the top of `swarm-watch.sh`).

## Install

```sh
mkdir -p ~/.config/systemd/user
ln -sf ~/Documents/dev/bifrost/scripts/swarm-watch/bifrost-swarm.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now bifrost-swarm.timer
loginctl enable-linger "$USER"   # keep the timer running while logged out
```

Watch it with `journalctl --user -u bifrost-swarm -f`.
