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

## How it is applied

| Who | How |
|---|---|
| People | `pull_request_template.md` here is the default for every repo without its own. A repo that needs extras keeps its own template: this one plus its extra sections. |
| Claude | The `create-pr` skill in the `venn-skills` plugin ([venn-ai-skills](https://github.com/venn-city/venn-ai-skills)), enabled per repo in `.claude/settings.json`. It reads `.github/pr-extras.md`. |
| CI | `.github/workflows/pr-standard.yml`, a reusable workflow. Add it to a repo from **Actions → New workflow → PR standard**, or copy `workflow-templates/pr-standard.yml`. |

Change the standard here, in the skill, and in the workflow together.
