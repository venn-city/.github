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
