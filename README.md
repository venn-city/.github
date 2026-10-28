# venn-city/.github

Org-wide defaults for every venn-city repository.

## Pull request standard

Every PR, opened by a person or by Claude, in every repo, has the same shape.

**Title**

```
<type>(<scope>): <description> - <ticket id>

feat(embedded-apps): manage an organization's embedded apps behind a grantable module - 13379497736
fix(admin): trust FrontDesk's authorisation on embedded-app RPCs - VENN-4198
```

- `type`: `feat` · `fix` · `chore` · `refactor` · `perf` · `docs` · `test` · `ci` · `build` · `revert`
  (`!` after the scope marks a breaking change).
- `scope`: the app, module, lib or service, lowercase kebab-case. Optional in a single-purpose repo.
- `ticket id`: a Monday item id (10–12 digits) or a Linear `VENN-<n>`. No ticket: add the
  `no-ticket` label.

**Description**, in this order. `What`, `Changes` and `Testing` are required; the rest appear only
when they have content.

1. `## What` — the behaviour change and why, then a `Monday:` / `Linear:` ticket link.
2. `## Changes` — grouped bullets.
3. `## Merge order` — cross-repo dependencies as `owner/repo#N`.
4. `## Not in this PR` — deliberate gaps.
5. `## Testing` — what ran and its result, and what did not run and why.
6. Repo extras — sections a repo lists in its own `.github/pr-extras.md` (Atlas coverage, app
   builds, QA sign-off…).

## Commit standard

A commit subject has the PR title's shape. Repos squash-merge, so what lands on the default branch
is the PR title or, for a single-commit PR, the commit subject: either way, one format.

```
<type>(<scope>): <description> - <ticket id>

<optional body: why, not a replay of the diff; wrap at ~100 columns>

Monday: <url>
```

- Same `type` list and `scope` rules as the PR title; several scopes are comma-separated.
- The ticket suffix belongs on every commit whose work has one, which is almost always.
- Also accepted: GitHub's `Revert "<subject>"`, and `fixup!` / `squash!` / `amend!` before a
  standard subject. Merge commits are not checked.
- Never skip the repo's hooks (`--no-verify`).

## How it is applied

| Who | How |
|---|---|
| People | `pull_request_template.md` here is the default for every repo without its own. A repo that needs extras keeps its own template: this one plus its extra sections. |
| Claude | The `create-pr` and `create-commit` skills in the `venn-skills` plugin ([venn-ai-skills](https://github.com/venn-city/venn-ai-skills)), enabled per repo in `.claude/settings.json`. `create-pr` reads `.github/pr-extras.md`. |
| CI | `.github/workflows/pr-standard.yml`, a reusable workflow that checks the PR title, its sections and every commit subject. Add it to a repo from **Actions → New workflow → PR standard**, or copy `workflow-templates/pr-standard.yml`. |

Change the standard here, in the skills, and in the workflow together.
