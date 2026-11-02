// Auto-update picker — rebases the next approved, auto-merge PR onto the default branch, one at a time
//
// The reusable .github/workflows/auto-update-prs.yml runs it through actions/github-script. Pure helpers are
// exported for auto-update-prs.test.mjs; `run` does the GitHub I/O.

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
// Merge states auto-merge goes on to land (UNKNOWN is the moment right after a push).
const LANDS = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS', 'UNKNOWN']);
// GitHub refusals that mean "this PR is already moving": hold its slot, don't comment.
const MOVING = /expected head|already up.to.date|in progress|being updated/i;
const MARKER = 'auto-update-prs';

// Open, not draft, approved, auto-merge on, not known to conflict, and no unresolved review threads
// (the ruleset blocks merging on those, so rebasing such a PR only spends a Jenkins run).
export function isReady(pr) {
  return (
    !pr.isDraft &&
    pr.reviewDecision === 'APPROVED' &&
    Boolean(pr.autoMergeRequest) &&
    pr.mergeable !== 'CONFLICTING' &&
    pr.mergeStateStatus !== 'DIRTY' &&
    !(pr.reviewThreads?.nodes ?? []).some((t) => !t.isResolved)
  );
}

// Whether auto-merge will land a PR in this merge state once its checks are green.
export function isClean(mergeStateStatus) {
  return LANDS.has(mergeStateStatus);
}

// One required check on the head: { state: PENDING | SUCCESS | FAILURE, since }. Jenkins reports
// check runs (the newest run wins after a rerun); a commit status of the same name is read too.
function oneCheck(contexts, name) {
  const runs = contexts.filter((c) => (c.__typename === 'CheckRun' ? c.name : c.context) === name);
  const found = runs.sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')).at(-1);
  if (!found) return { state: 'PENDING' };
  if (found.__typename === 'CheckRun') {
    if (found.status !== 'COMPLETED') return { state: 'PENDING', since: found.startedAt };
    return { state: GREEN.has(found.conclusion) ? 'SUCCESS' : 'FAILURE' };
  }
  if (found.state === 'PENDING' || found.state === 'EXPECTED') return { state: 'PENDING' };
  return { state: found.state === 'SUCCESS' ? 'SUCCESS' : 'FAILURE' };
}

// PENDING, SUCCESS, FAILURE or STALE for the required check(s) on the PR head. Any red is FAILURE,
// else any not finished is PENDING; not reported yet counts as pending. A pending check older than
// `staleMinutes` (from its start, or the head commit when it never started) is STALE, so a build
// that hung or never ran can't hold the line forever.
export function checkState(pr, requiredChecks, { now = Date.now(), staleMinutes = Infinity } = {}) {
  const commit = pr.commits?.nodes?.[0]?.commit;
  const contexts = commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checks = [requiredChecks].flat().map((name) => oneCheck(contexts, name));
  if (checks.some((c) => c.state === 'FAILURE')) return 'FAILURE';
  const pending = checks.filter((c) => c.state === 'PENDING');
  if (!pending.length) return 'SUCCESS';
  const since = Math.max(...pending.map((c) => Date.parse(c.since ?? commit?.committedDate ?? '')).filter(Number.isFinite));
  return Number.isFinite(since) && now - since > staleMinutes * 60_000 ? 'STALE' : 'PENDING';
}

// PRs to rebase now. A PR is in flight while it is up to date and its check is pending, or green
// and in a state auto-merge lands. A green PR blocked by something else, or a stale one, doesn't hold
// the line. With a free slot, take the oldest (by auto-merge time) PRs that are behind and not red.
export function pickNext(ready, maxInFlight) {
  const inFlight = ready.filter((p) => p.upToDate && (p.check === 'PENDING' || (p.check === 'SUCCESS' && p.clean))).length;
  const slots = maxInFlight - inFlight;
  if (slots <= 0) return [];
  return ready
    .filter((p) => !p.upToDate && p.check !== 'FAILURE')
    .sort((a, b) => a.enabledAt.localeCompare(b.enabledAt))
    .slice(0, slots);
}

// Why a rebase failed, for the PR comment; null when the PR is already moving (it holds its slot).
export function rebaseFailure(err) {
  const message = err.message ?? String(err);
  if (MOVING.test(message)) return null;
  if (/workflow/i.test(message)) {
    return `it changes files under \`.github/workflows\`, which the line's token isn't allowed to push (${message})`;
  }
  return `the rebase hit a conflict or GitHub refused it (${message})`;
}

const QUERY = `query($owner: String!, $repo: String!, $base: String!, $after: String) {
  repository(owner: $owner, name: $repo) {
    ref(qualifiedName: $base) { target { oid } }
    pullRequests(states: OPEN, baseRefName: $base, first: 50, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id number isDraft reviewDecision mergeable mergeStateStatus headRefOid
        autoMergeRequest { enabledAt }
        reviewThreads(first: 100) { nodes { isResolved } }
        commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 50) { nodes {
          __typename
          ... on CheckRun { name status conclusion startedAt }
          ... on StatusContext { context state }
        } } } } } }
      }
    }
  }
}`;

const REBASE = `mutation($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE }) { clientMutationId }
}`;

const HEAD = `query($id: ID!) { node(id: $id) { ... on PullRequest { headRefOid } } }`;

async function openPullRequests({ github, owner, repo, base }) {
  const nodes = [];
  let baseOid;
  for (let after = null, more = true; more; ) {
    const { repository } = await github.graphql(QUERY, { owner, repo, base, after });
    baseOid = repository.ref.target.oid;
    nodes.push(...repository.pullRequests.nodes);
    ({ hasNextPage: more, endCursor: after } = repository.pullRequests.pageInfo);
  }
  return { baseOid, nodes };
}

// The rebase lands asynchronously. Wait (up to ~2 minutes) for the new head, so the next run, which
// the concurrency group holds until this one ends, sees the PR as rebased and doesn't rebase it again.
async function waitForNewHead({ github, pr, sleep, core }) {
  for (let attempt = 0; attempt < 24; attempt++) {
    const { node } = await github.graphql(HEAD, { id: pr.id });
    if (node?.headRefOid && node.headRefOid !== pr.headRefOid) return;
    await sleep(5_000);
  }
  core.warning(`#${pr.number}'s head hasn't changed yet; counting it as in flight anyway`);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run({ github, context, core, sleep = defaultSleep, now = Date.now() }) {
  const { owner, repo } = context.repo;
  const base = context.payload.repository?.default_branch ?? (await github.rest.repos.get({ owner, repo })).data.default_branch;
  const requiredChecks = (process.env.REQUIRED_CHECKS || process.env.REQUIRED_CHECK || 'Jenkins')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const maxInFlight = Number(process.env.MAX_IN_FLIGHT || 1);
  const staleMinutes = Number(process.env.STALE_MINUTES || 120);

  const { baseOid, nodes } = await openPullRequests({ github, owner, repo, base });

  const ready = [];
  for (const pr of nodes.filter(isReady)) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead: `${baseOid}...${pr.headRefOid}` });
    ready.push({
      id: pr.id,
      number: pr.number,
      headRefOid: pr.headRefOid,
      enabledAt: pr.autoMergeRequest.enabledAt,
      upToDate: data.behind_by === 0,
      clean: isClean(pr.mergeStateStatus),
      check: checkState(pr, requiredChecks, { now, staleMinutes }),
    });
  }
  core.info(
    `${ready.length} ready PR(s) on ${base}: ${ready.map((p) => `#${p.number} ${p.upToDate ? 'up to date' : 'behind'} ${p.check}`).join(', ') || 'none'}`,
  );

  for (const pr of ready.filter((p) => p.upToDate && p.check === 'STALE')) {
    core.warning(`#${pr.number}: ${requiredChecks.join(', ')} pending for over ${staleMinutes} minutes; skipping it`);
    await commentOnce({
      github,
      owner,
      repo,
      pr,
      kind: 'stale',
      body: `${requiredChecks.map((c) => `\`${c}\``).join(' / ')} hasn't finished on this PR's head for over ${staleMinutes} minutes, so the merge line skipped it to keep the others moving.\n\nRerun the build or push a commit to rejoin the line.`,
    });
  }

  for (let picks = pickNext(ready, maxInFlight); picks.length; picks = pickNext(ready, maxInFlight)) {
    for (const pr of picks) {
      try {
        await github.graphql(REBASE, { id: pr.id, head: pr.headRefOid });
        core.info(`Rebased #${pr.number} onto ${base}`);
        await waitForNewHead({ github, pr, sleep, core });
        Object.assign(pr, { upToDate: true, check: 'PENDING' });
      } catch (err) {
        core.warning(`Could not rebase #${pr.number}: ${err.message}`);
        const reason = rebaseFailure(err);
        if (!reason) {
          Object.assign(pr, { upToDate: true, check: 'PENDING' });
          continue;
        }
        await commentOnce({
          github,
          owner,
          repo,
          pr,
          kind: 'conflict',
          body: `The merge line couldn't rebase this PR onto \`${base}\`, so it was skipped: ${reason}.\n\nRebase it yourself (or push a fix) to rejoin the line.`,
        });
        ready.splice(ready.indexOf(pr), 1);
      }
    }
  }
}

// One comment of each kind per PR head, so a stuck PR isn't commented on every run.
async function commentOnce({ github, owner, repo, pr, kind, body }) {
  const marker = `<!-- ${MARKER}:${kind}:${pr.headRefOid} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
  if (comments.some((c) => c.body?.includes(marker))) return;
  await github.rest.issues.createComment({ owner, repo, issue_number: pr.number, body: `${marker}\n${body}` });
}
