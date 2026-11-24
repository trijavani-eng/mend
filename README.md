# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/trijavani-eng/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/trijavani-eng/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

A command-line tool that applies AI-written edits to a tree of text files, in
four formats: unified diffs (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON.

Built for the make.fun bounty "Build mend, one patch tool for every AI edit
format" (https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

## Usage

- `PATCH` is the patch file; when absent or `-`, the patch is read from stdin.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`,
  `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write.
- `--strict` matches lines exactly.

See `SPEC.md` in the make.fun kit for the full specification. `main.ts` is the
CLI (Node 22, standard library only); `runner.ts` is the kit's trial runner,
kept as it is.

## Practice score

100 of 100 practice checks pass (score 1000), plus 59 extra adversarial checks
covering SPEC sentences the practice set does not show.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
