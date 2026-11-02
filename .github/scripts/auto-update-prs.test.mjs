// Tests for the auto-update picker — run with `node --test .github/scripts/`
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkState, isClean, isReady, pickNext, rebaseFailure, run } from './auto-update-prs.mjs';

const pr = (overrides = {}) => ({
  number: 1,
  isDraft: false,
  reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BEHIND',
  autoMergeRequest: { enabledAt: '2026-11-02T10:00:00Z' },
  reviewThreads: { nodes: [{ isResolved: true }] },
  ...overrides,
});

const rollup = (...nodes) => ({ commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } });
const checkRun = (name, status, conclusion = null, startedAt = '2026-11-02T10:00:00Z') => ({ __typename: 'CheckRun', name, status, conclusion, startedAt });

describe('isReady', () => {
  it('accepts an approved, mergeable, non-draft PR with auto-merge on', () => {
    assert.equal(isReady(pr()), true);
  });

  it('rejects drafts, unapproved PRs, PRs without auto-merge and conflicting PRs', () => {
    assert.equal(isReady(pr({ isDraft: true })), false);
    assert.equal(isReady(pr({ reviewDecision: 'REVIEW_REQUIRED' })), false);
    assert.equal(isReady(pr({ reviewDecision: 'CHANGES_REQUESTED' })), false);
    assert.equal(isReady(pr({ autoMergeRequest: null })), false);
    assert.equal(isReady(pr({ mergeable: 'CONFLICTING' })), false);
    assert.equal(isReady(pr({ mergeStateStatus: 'DIRTY' })), false);
  });

  it('rejects a PR with unresolved review threads, which the ruleset will not merge', () => {
    assert.equal(isReady(pr({ reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] } })), false);
  });

  it('accepts a PR whose mergeability GitHub has not computed yet', () => {
    assert.equal(isReady(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })), true);
  });
});

describe('checkState', () => {
  it('reads the required check run only', () => {
    const node = rollup(checkRun('Jenkins', 'COMPLETED', 'SUCCESS'), checkRun('e2e', 'COMPLETED', 'FAILURE'));
    assert.equal(checkState(node, 'Jenkins'), 'SUCCESS');
  });

  it('maps an unfinished check run to pending and a failed one to failure', () => {
    assert.equal(checkState(rollup(checkRun('Jenkins', 'IN_PROGRESS')), 'Jenkins'), 'PENDING');
    assert.equal(checkState(rollup(checkRun('Jenkins', 'QUEUED')), 'Jenkins'), 'PENDING');
    for (const conclusion of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
      assert.equal(checkState(rollup(checkRun('Jenkins', 'COMPLETED', conclusion)), 'Jenkins'), 'FAILURE', conclusion);
    }
    assert.equal(checkState(rollup(checkRun('Jenkins', 'COMPLETED', 'NEUTRAL')), 'Jenkins'), 'SUCCESS');
  });

  it('also reads a commit status with that context', () => {
    assert.equal(checkState(rollup({ __typename: 'StatusContext', context: 'Jenkins', state: 'SUCCESS' }), 'Jenkins'), 'SUCCESS');
    assert.equal(checkState(rollup({ __typename: 'StatusContext', context: 'Jenkins', state: 'ERROR' }), 'Jenkins'), 'FAILURE');
  });

  it('reads the newest run when a check was rerun on the same head', () => {
    const node = rollup(checkRun('Jenkins', 'COMPLETED', 'SUCCESS', '2026-11-02T11:00:00Z'), checkRun('Jenkins', 'COMPLETED', 'FAILURE', '2026-11-02T10:00:00Z'));
    assert.equal(checkState(node, 'Jenkins'), 'SUCCESS');
  });

  it('combines several required checks: any red is red, else any pending is pending', () => {
    const both = (a, b) => rollup(checkRun('Jenkins', ...a), checkRun('e2e', ...b));
    assert.equal(checkState(both(['COMPLETED', 'SUCCESS'], ['COMPLETED', 'SUCCESS']), ['Jenkins', 'e2e']), 'SUCCESS');
    assert.equal(checkState(both(['COMPLETED', 'SUCCESS'], ['IN_PROGRESS']), ['Jenkins', 'e2e']), 'PENDING');
    assert.equal(checkState(both(['IN_PROGRESS'], ['COMPLETED', 'FAILURE']), ['Jenkins', 'e2e']), 'FAILURE');
    assert.equal(checkState(rollup(checkRun('Jenkins', 'COMPLETED', 'SUCCESS')), ['Jenkins', 'e2e']), 'PENDING');
  });

  it('calls a check stale once it has been pending longer than the limit', () => {
    const options = { now: Date.parse('2026-11-02T13:00:00Z'), staleMinutes: 120 };
    assert.equal(checkState(rollup(checkRun('Jenkins', 'IN_PROGRESS', null, '2026-11-02T10:30:00Z')), 'Jenkins', options), 'STALE');
    assert.equal(checkState(rollup(checkRun('Jenkins', 'IN_PROGRESS', null, '2026-11-02T11:30:00Z')), 'Jenkins', options), 'PENDING');
  });

  it('dates a check that never started from the head commit', () => {
    const options = { now: Date.parse('2026-11-02T13:00:00Z'), staleMinutes: 120 };
    const head = (committedDate) => ({ commits: { nodes: [{ commit: { committedDate, statusCheckRollup: null } }] } });
    assert.equal(checkState(head('2026-11-02T10:00:00Z'), 'Jenkins', options), 'STALE');
    assert.equal(checkState(head('2026-11-02T12:00:00Z'), 'Jenkins', options), 'PENDING');
  });

  it('treats a missing required check as pending', () => {
    assert.equal(checkState(rollup(), 'Jenkins'), 'PENDING');
    assert.equal(checkState({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }, 'Jenkins'), 'PENDING');
  });
});

describe('pickNext', () => {
  const ready = (number, upToDate, check, { enabledAt = `2026-11-02T10:0${number}:00Z`, clean = false } = {}) => ({
    number,
    upToDate,
    check,
    enabledAt,
    clean,
  });

  it('waits while an up-to-date PR is being tested', () => {
    assert.deepEqual(pickNext([ready(1, true, 'PENDING'), ready(2, false, 'SUCCESS')], 1), []);
  });

  it('waits while an up-to-date green PR is clean and about to auto-merge', () => {
    assert.deepEqual(pickNext([ready(1, true, 'SUCCESS', { clean: true }), ready(2, false, 'SUCCESS')], 1), []);
  });

  it('does not let an up-to-date green PR that cannot merge hold the line', () => {
    assert.deepEqual(
      pickNext([ready(1, true, 'SUCCESS', { clean: false }), ready(2, false, 'SUCCESS')], 1).map((p) => p.number),
      [2],
    );
  });

  it('rebases the PR whose auto-merge was enabled first', () => {
    const picked = pickNext(
      [ready(2, false, 'SUCCESS', { enabledAt: '2026-11-02T11:00:00Z' }), ready(3, false, 'SUCCESS', { enabledAt: '2026-11-02T09:00:00Z' })],
      1,
    );
    assert.deepEqual(
      picked.map((p) => p.number),
      [3],
    );
  });

  it('skips PRs that are red on their current head', () => {
    const picked = pickNext([ready(1, false, 'FAILURE'), ready(3, false, 'PENDING')], 1);
    assert.deepEqual(
      picked.map((p) => p.number),
      [3],
    );
  });

  it('does not count an up-to-date red PR as in flight', () => {
    const picked = pickNext([ready(1, true, 'FAILURE'), ready(2, false, 'SUCCESS')], 1);
    assert.deepEqual(
      picked.map((p) => p.number),
      [2],
    );
  });

  it('fills the free slots up to maxInFlight', () => {
    const picked = pickNext([ready(1, true, 'PENDING'), ready(2, false, 'SUCCESS'), ready(3, false, 'SUCCESS'), ready(4, false, 'SUCCESS')], 3);
    assert.deepEqual(
      picked.map((p) => p.number),
      [2, 3],
    );
  });

  it('does not let a stale up-to-date PR hold the line, but rebases a stale one that is behind', () => {
    assert.deepEqual(
      pickNext([ready(1, true, 'STALE'), ready(2, false, 'STALE')], 1).map((p) => p.number),
      [2],
    );
  });

  it('returns nothing when no PR is ready', () => {
    assert.deepEqual(pickNext([], 1), []);
  });
});

describe('isClean', () => {
  it('treats states auto-merge will land as clean', () => {
    for (const state of ['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'UNKNOWN']) assert.equal(isClean(state), true, state);
    for (const state of ['BLOCKED', 'BEHIND', 'DIRTY', 'DRAFT']) assert.equal(isClean(state), false, state);
  });
});

describe('rebaseFailure', () => {
  it('stays quiet when the PR moved or is already being updated', () => {
    assert.equal(rebaseFailure(new Error('Expected head oid abc does not match head oid def')), null);
    assert.equal(rebaseFailure(new Error('There are no new commits on the base branch; already up to date')), null);
    assert.equal(rebaseFailure(new Error('An update is already in progress for this pull request')), null);
  });

  it('explains that the token cannot rebase a PR that changes workflows', () => {
    assert.match(rebaseFailure(new Error('refusing to allow a GitHub App to create or update workflow `.github/workflows/x.yml`')), /workflow/);
  });

  it('reports anything else as a conflict, with GitHub’s message', () => {
    assert.match(rebaseFailure(new Error('merge conflict between base and head')), /conflict.*merge conflict between base and head/s);
  });
});

describe('run', () => {
  const node = (number, enabledAt, overrides = {}) => ({
    ...pr({ number, autoMergeRequest: { enabledAt } }),
    id: `PR_${number}`,
    headRefOid: `head${number}`,
    ...rollup(checkRun('Jenkins', 'COMPLETED', 'SUCCESS')),
    ...overrides,
  });

  const fakeGithub = ({ pages, behind = {}, failures = {}, existingComments = [], stuckHeads = [] }) => {
    const calls = { rebased: [], comments: [], cursors: [], polled: [] };
    const github = {
      graphql: async (query, vars) => {
        if (query.includes('updatePullRequestBranch')) {
          const number = Number(vars.id.replace('PR_', ''));
          if (failures[number]) throw new Error(failures[number]);
          calls.rebased.push(number);
          return {};
        }
        if (query.includes('node(id:')) {
          const number = Number(vars.id.replace('PR_', ''));
          calls.polled.push(number);
          return { node: { headRefOid: stuckHeads.includes(number) ? `head${number}` : `rebased${number}` } };
        }
        calls.cursors.push(vars.after ?? null);
        const page = vars.after ? Number(vars.after) : 0;
        return {
          repository: {
            ref: { target: { oid: 'main' } },
            pullRequests: { nodes: pages[page], pageInfo: { hasNextPage: page + 1 < pages.length, endCursor: String(page + 1) } },
          },
        };
      },
      paginate: async () => existingComments,
      rest: {
        repos: {
          compareCommitsWithBasehead: async ({ basehead }) => {
            const number = Number(basehead.split('...head')[1]);
            return { data: { behind_by: behind[number] ?? 1 } };
          },
        },
        issues: {
          listComments: () => {},
          createComment: async ({ issue_number, body }) => calls.comments.push({ issue_number, body }),
        },
      },
    };
    return { github, calls };
  };

  const context = { repo: { owner: 'venn-city', repo: 'web-platform' }, payload: { repository: { default_branch: 'main' } } };
  const core = { info: () => {}, warning: () => {} };
  const sleep = async () => {};
  const now = Date.parse('2026-11-02T11:00:00Z');

  it('rebases only the oldest ready PR', async () => {
    const { github, calls } = fakeGithub({
      pages: [[node(2, '2026-11-02T11:00:00Z'), node(3, '2026-11-02T09:00:00Z'), node(4, '2026-11-02T08:00:00Z', { isDraft: true })]],
    });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.rebased, [3]);
    assert.deepEqual(calls.comments, []);
  });

  it('reads every page of open PRs', async () => {
    const { github, calls } = fakeGithub({ pages: [[node(2, '2026-11-02T11:00:00Z')], [node(3, '2026-11-02T09:00:00Z')]] });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.cursors, [null, '1']);
    assert.deepEqual(calls.rebased, [3]);
  });

  it('does nothing while a PR is in flight', async () => {
    const { github, calls } = fakeGithub({
      pages: [[node(2, '2026-11-02T11:00:00Z', rollup(checkRun('Jenkins', 'IN_PROGRESS'))), node(3, '2026-11-02T09:00:00Z')]],
      behind: { 2: 0 },
    });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.rebased, []);
  });

  it('comments on a PR that fails to rebase and moves on to the next one', async () => {
    const { github, calls } = fakeGithub({
      pages: [[node(2, '2026-11-02T11:00:00Z'), node(3, '2026-11-02T09:00:00Z')]],
      failures: { 3: 'merge conflict between base and head' },
    });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.rebased, [2]);
    assert.equal(calls.comments.length, 1);
    assert.equal(calls.comments[0].issue_number, 3);
    assert.match(calls.comments[0].body, /auto-update-prs:conflict:head3/);
  });

  it('holds the slot without commenting when the PR moved since it was read', async () => {
    const { github, calls } = fakeGithub({
      pages: [[node(2, '2026-11-02T11:00:00Z'), node(3, '2026-11-02T09:00:00Z')]],
      failures: { 3: 'Expected head oid head3 does not match head oid head3b' },
    });
    await run({ github, context, core, sleep, now });
    // A new push on #3 starts its own build; the next run looks again.
    assert.deepEqual(calls.rebased, []);
    assert.deepEqual(calls.comments, []);
  });

  it('does not comment twice on the same head', async () => {
    const { github, calls } = fakeGithub({
      pages: [[node(3, '2026-11-02T09:00:00Z')]],
      failures: { 3: 'merge conflict between base and head' },
      existingComments: [{ body: "<!-- auto-update-prs:conflict:head3 -->\nCouldn't rebase" }],
    });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.comments, []);
  });

  it('waits for the rebased head before finishing, so the next run sees it', async () => {
    const { github, calls } = fakeGithub({ pages: [[node(3, '2026-11-02T09:00:00Z')]] });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.rebased, [3]);
    assert.deepEqual(calls.polled, [3]);
  });

  it('gives up waiting after a while and still counts the PR as in flight', async () => {
    const { github, calls } = fakeGithub({ pages: [[node(2, '2026-11-02T11:00:00Z'), node(3, '2026-11-02T09:00:00Z')]], stuckHeads: [3] });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.rebased, [3]);
    assert.ok(calls.polled.length > 1);
  });

  it('holds the slot quietly when GitHub says the PR is already being updated', async () => {
    const { github, calls } = fakeGithub({
      pages: [[node(2, '2026-11-02T11:00:00Z'), node(3, '2026-11-02T09:00:00Z')]],
      failures: { 3: 'An update is already in progress for this pull request' },
    });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.rebased, []);
    assert.deepEqual(calls.comments, []);
  });

  it('comments once on an up-to-date PR whose check is stale, and moves the line on', async () => {
    const stale = { commits: { nodes: [{ commit: { committedDate: '2026-01-01T00:00:00Z', statusCheckRollup: null } }] } };
    const { github, calls } = fakeGithub({ pages: [[node(2, '2026-11-02T11:00:00Z'), node(3, '2026-11-02T09:00:00Z', stale)]], behind: { 3: 0 } });
    await run({ github, context, core, sleep, now });
    assert.deepEqual(calls.rebased, [2]);
    assert.equal(calls.comments.length, 1);
    assert.equal(calls.comments[0].issue_number, 3);
    assert.match(calls.comments[0].body, /auto-update-prs:stale:head3/);
  });

  it('waits on every check named in REQUIRED_CHECKS', async () => {
    process.env.REQUIRED_CHECKS = 'Jenkins,e2e';
    try {
      const { github, calls } = fakeGithub({ pages: [[node(2, '2026-11-02T11:00:00Z'), node(3, '2026-11-02T09:00:00Z')]], behind: { 3: 0 } });
      await run({ github, context, core, sleep, now });
      // #3 is up to date with Jenkins green but e2e missing (pending), so it holds the line.
      assert.deepEqual(calls.rebased, []);
    } finally {
      delete process.env.REQUIRED_CHECKS;
    }
  });
});
