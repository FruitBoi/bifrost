# Bifröst – instructions for Claude

## Claude requests (GitHub issues)

Issues opened with the **Claude request** template (`.github/ISSUE_TEMPLATE/claude-request.md`),
or carrying the `claude` label, are tasks for Claude.

When you finish one of these requests:

1. Commit the work in a single commit and push it.
2. Comment on the issue with a summary of what changed.
3. The comment **must** open with the line **"Claude wins again"** and contain a gross amount of
   emojis (think dozens, not a tasteful handful). This is required by
   [issue #6](https://github.com/FruitBoi/bifrost/issues/6).
4. Close the issue.

Users listed in `.github/swarm-allowed-users` can start this from GitHub by commenting `/swarm` on the
issue; the dev server's watcher (`scripts/swarm-watch`) then runs `/swarm-issue <n>` unattended.

Example comment:

```
🏆🎉🤖✨ Claude wins again 🏆🎉🤖✨

🚀 What changed:
- 🧵 ...
- 🐛 ...

🥳🎊🙌💪🔥🌈🦄🎯🫡🏁🎈🍾🥂🎁⭐️🌟💫🎆🎇🪅
```
