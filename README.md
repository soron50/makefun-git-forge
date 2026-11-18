# makefun-git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/soron50/makefun-git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/soron50/makefun-git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node.js process, built from the wire up: its own SHA-1 git object store and packfile reader/writer (no git binary), git smart HTTP (protocol v2 ls-refs/fetch and v0 receive-pack with report-status), the REST v3 API (repositories, branches, contents, labels, issues, comments, pull requests with squash merges), a GraphQL API with introspection and mutations, and an MCP endpoint (server/discover, tools/list, tools/call) — all in memory, all behind the caller's bearer token.

## Run it

```sh
node main.ts
```

The entry binds an ephemeral port and registers it with `$MAKEFUN_ENV_URL`; API calls authenticate with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=bzx13rgc&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
