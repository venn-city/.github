# venn-city/.github

Org-wide defaults for every venn-city repository.

## Pull request conventions

Shared guidance so PRs read the same in every repo, whether a person or Claude opened them. Nothing
in CI checks it: follow it because it makes reviews easier, and use judgement where it doesn't fit.

**Title**

```
<type>(<scope>): <description> - <ticket id>

feat(embedded-apps): manage an organization's embedded apps behind a grantable module - 13379497736
fix(admin): trust FrontDesk's authorisation on embedded-app RPCs - VENN-4198
```

- `type`: `feat` · `fix` · `chore` · `refactor` · `perf` · `docs` · `test` · `ci` · `build` · `revert`
  (`!` after the scope marks a breaking change).
- `scope`: the app, module, lib or service, lowercase kebab-case. Optional in a single-purpose repo.
- `ticket id`: a Monday item id (10–12 digits) or a Linear `VENN-<n>` is recommended. Leave it off
  when there isn't one; that is the developer's call.

**Description**, in this order. Include a section only when it is relevant.

1. `## What` — the behaviour change and why, then a `Monday:` / `Linear:` link if there is a ticket.
2. `## Changes` — grouped bullets.
3. `## Merge order` — cross-repo dependencies as `owner/repo#N`.
4. `## Not in this PR` — deliberate gaps.
5. `## Testing` — what ran and its result, and what did not run and why.
6. Repo extras — sections a repo lists in its own `.github/pr-extras.md` (Atlas coverage, app
   builds, QA sign-off…), when they apply.

## Commit messages

Advisory: write a new commit subject in the PR title's shape, `<type>(<scope>): <description>`, with
the ticket when there is one. Repos squash-merge, so this mostly keeps `git log` tidy. Nothing checks
it, and nobody needs to rebase or force-push to reword an existing commit.

## How it is applied

| Who | How |
|---|---|
| People | `pull_request_template.md` here is the default for every repo without its own. A repo that needs extras keeps its own template: this one plus its extra sections. |
| Claude | The `create-pr` and `create-commit` skills in the `venn-skills` plugin ([venn-ai-skills](https://github.com/venn-city/venn-ai-skills)), enabled per repo in `.claude/settings.json`. `create-pr` reads `.github/pr-extras.md`. |

Change the conventions here and in the skills together.

## Merge line (auto-rebase)

A repo whose ruleset requires branches to be up to date can opt in to the merge line. Once a PR is
approved and has auto-merge on, the line rebases it onto the default branch when its turn comes,
Jenkins reruns, and auto-merge lands it when green. It goes one PR at a time, so every merge is
tested against the current default branch without anyone rebasing by hand.

The logic lives here once: the reusable [`auto-update-prs.yml`](.github/workflows/auto-update-prs.yml)
and its script and tests in [`.github/scripts/`](.github/scripts/). GitHub delivers events only to
workflows in their own repo, so each repo adds this caller as `.github/workflows/auto-update-prs.yml`
(change `main` to the repo's default branch):

```yaml
name: Auto-update ready PRs

# The merge line: see https://github.com/venn-city/.github#merge-line-auto-rebase
on:
  push:
    branches: [main]
  # _target runs the default-branch workflow with a write token, never the PR's code.
  pull_request_target:
    types: [auto_merge_enabled, auto_merge_disabled, ready_for_review, closed]
  pull_request_review:
    types: [submitted]
  # Jenkins reports a check run; a finished one frees the slot or drops a red PR out of line.
  check_run:
    types: [completed]
  # Backstop for missed events, during working hours only (UTC) to save Actions minutes.
  schedule:
    - cron: '17 5-19 * * 0-4'
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  next:
    # Skipped jobs cost no minutes: ignore other check runs and non-approving reviews.
    if: >-
      (github.event_name != 'check_run' || github.event.check_run.name == 'Jenkins') &&
      (github.event_name != 'pull_request_review' || github.event.review.state == 'approved')
    # On the job, so skipped runs never take the one waiting slot from a real one.
    concurrency:
      group: auto-update-prs
      cancel-in-progress: false
    uses: venn-city/.github/.github/workflows/auto-update-prs.yml@main
    with:
      required-check: Jenkins
```

Then turn on, in the repo: the ruleset's "require branches to be up to date", "Allow auto-merge" and
"Always suggest updating pull request branches", and turn off "require extra approval for
unattributed changes" (a rebase by the line would otherwise need a new approval).

Callers pin `@main`, so a fix merged here reaches every repo at once. Test it first:
`node --test .github/scripts/` (the `Test scripts` workflow runs it on PRs here).
