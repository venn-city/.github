// Auto-update picker — rebases the next approved, auto-merge PR onto the default branch, one at a time
//
// The reusable .github/workflows/auto-update-prs.yml runs it through actions/github-script. Pure helpers are
// exported for auto-update-prs.test.mjs; `run` does the GitHub I/O.

const GREEN = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CONFLICT_MARKER = 'auto-update-prs:conflict';

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

// PENDING, SUCCESS or FAILURE for the required check on the PR head. Jenkins reports a check run;
// a commit status of the same name is read too. Not reported yet counts as pending.
export function checkState(pr, requiredCheck) {
  const contexts = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const found = contexts.filter((c) => (c.__typename === 'CheckRun' ? c.name : c.context) === requiredCheck).at(-1);
  if (!found) return 'PENDING';
  if (found.__typename === 'CheckRun') {
    if (found.status !== 'COMPLETED') return 'PENDING';
    return GREEN.has(found.conclusion) ? 'SUCCESS' : 'FAILURE';
  }
  if (found.state === 'PENDING' || found.state === 'EXPECTED') return 'PENDING';
  return found.state === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
}

// PRs to rebase now. A PR is in flight while it is up to date and its check is pending, or green
// and clean (auto-merge is about to land it). A green PR blocked by something else doesn't hold the
// line. With a free slot, take the oldest (by auto-merge time) PRs that are behind and not red.
export function pickNext(ready, maxInFlight) {
  const inFlight = ready.filter((p) => p.upToDate && (p.check === 'PENDING' || (p.check === 'SUCCESS' && p.clean))).length;
  const slots = maxInFlight - inFlight;
  if (slots <= 0) return [];
  return ready
    .filter((p) => !p.upToDate && p.check !== 'FAILURE')
    .sort((a, b) => a.enabledAt.localeCompare(b.enabledAt))
    .slice(0, slots);
}

// Why a rebase failed, for the PR comment; null when the PR just moved (the next run retries).
export function rebaseFailure(err) {
  const message = err.message ?? String(err);
  if (/expected head/i.test(message)) return null;
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
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 50) { nodes {
          __typename
          ... on CheckRun { name status conclusion }
          ... on StatusContext { context state }
        } } } } } }
      }
    }
  }
}`;

const REBASE = `mutation($id: ID!, $head: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $id, expectedHeadOid: $head, updateMethod: REBASE }) { clientMutationId }
}`;

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

export async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const base = context.payload.repository?.default_branch ?? (await github.rest.repos.get({ owner, repo })).data.default_branch;
  const requiredCheck = process.env.REQUIRED_CHECK || 'Jenkins';
  const maxInFlight = Number(process.env.MAX_IN_FLIGHT || 1);

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
      clean: pr.mergeStateStatus === 'CLEAN',
      check: checkState(pr, requiredCheck),
    });
  }
  core.info(
    `${ready.length} ready PR(s) on ${base}: ${ready.map((p) => `#${p.number} ${p.upToDate ? 'up to date' : 'behind'} ${p.check}`).join(', ') || 'none'}`,
  );

  for (let picks = pickNext(ready, maxInFlight); picks.length; picks = pickNext(ready, maxInFlight)) {
    for (const pr of picks) {
      try {
        await github.graphql(REBASE, { id: pr.id, head: pr.headRefOid });
        core.info(`Rebased #${pr.number} onto ${base}`);
        Object.assign(pr, { upToDate: true, check: 'PENDING' });
      } catch (err) {
        core.warning(`Could not rebase #${pr.number}: ${err.message}`);
        const reason = rebaseFailure(err);
        if (reason) await commentOnce({ github, owner, repo, pr, base, reason });
        ready.splice(ready.indexOf(pr), 1);
      }
    }
  }
}

// One comment per PR head, so a stuck PR isn't commented on every run.
async function commentOnce({ github, owner, repo, pr, base, reason }) {
  const marker = `<!-- ${CONFLICT_MARKER}:${pr.headRefOid} -->`;
  const comments = await github.paginate(github.rest.issues.listComments, { owner, repo, issue_number: pr.number, per_page: 100 });
  if (comments.some((c) => c.body?.includes(marker))) return;
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: pr.number,
    body: `${marker}\nThe merge line couldn't rebase this PR onto \`${base}\`, so it was skipped: ${reason}.\n\nRebase it yourself (or push a fix) to rejoin the line.`,
  });
}
