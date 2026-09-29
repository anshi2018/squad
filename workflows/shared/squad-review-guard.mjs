import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { evaluateImplementDispatchInputs } from './squad-retro-provenance.mjs';

export const CHECK_NAME = 'Squad Review / review';
export const VERDICT_PREFIX = 'Squad-Review-Verdict: ';
export const OVERRIDE_PREFIX = 'Squad-Review-Override: ';
const WORKFLOW = '.github/workflows/squad-review.lock.yml';
const SHA = /^[0-9a-f]{40}$/;
const ID = /^[a-z][a-z0-9-]*$/;
const BOT = 'github-actions[bot]';
const INSTALL_MANIFEST = '.github/aw/squad-workflows.manifest.json';
const INSTALL_PACKAGES = '.github/aw/packages';
const INSTALL_AUTHOR = '@squad/bootstrap-installation';
const INSTALL_REVIEWER = '@squad/bootstrap-review-workflow';
const INSTALL_WORKFLOWS = [
  'squad',
  'squad-implement-worker',
  'squad-review',
  'squad-deps-worker',
  'squad-retro',
  'squad-improvement-worker',
  'squad-bootstrap',
  'squad-command-router',
];

function requireThat(condition, message) {
  if (!condition) throw new Error(`Squad review refused: ${message}`);
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function timestamp(value) {
  requireThat(typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)), 'missing or malformed timestamp');
  requireThat(new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z'),
    'invalid calendar timestamp');
  return Date.parse(value);
}

function record(body, prefix) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const candidates = text.split('\n').filter(line => line.startsWith(prefix));
  requireThat(text.split(prefix.trim()).length === 2 && candidates.length === 1,
    `missing or duplicate ${prefix.trim()}`);
  const value = JSON.parse(candidates[0].slice(prefix.length));
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid record');
  return value;
}

export function validateAttribution(value, registry, repository, issue) {
  requireThat(exactKeys(value, ['schema', 'repository', 'issue', 'author_agent', 'reviewer_agent']) &&
    value.schema === 'squad-review-author/v1' && value.repository === repository &&
    Number.isSafeInteger(value.issue) && value.issue > 0 && value.issue === issue,
  'missing or malformed committed .squad-review.json');
  requireThat(registry?.schema === 'squad-agent-provenance/v1' && registry.schema_version === 1 &&
    registry.agents && typeof registry.agents === 'object', 'invalid committed agent registry');
  for (const id of [value.author_agent, value.reviewer_agent]) {
    requireThat(typeof id === 'string' && ID.test(id) &&
      Object.hasOwn(registry.agents, id) && registry.agents[id].status === 'active' &&
      registry.agents[id].persistent_name === id, 'unknown, inactive, or aliased stable agent ID');
  }
  requireThat(value.author_agent !== value.reviewer_agent, 'author and reviewer must be distinct');
  return value;
}

export function validateVerdict(value, expected, review, now = Date.now()) {
  requireThat(exactKeys(value, [
    'schema', 'repository', 'pull_request', 'head_sha', 'author_agent', 'reviewer_agent',
    'result', 'timestamp', 'run_id', 'run_attempt', 'event',
  ]) && value.schema === 'squad-review-verdict/v1', 'invalid verdict shape');
  for (const key of ['repository', 'pull_request', 'head_sha', 'author_agent', 'reviewer_agent']) {
    requireThat(value[key] === expected[key], `verdict ${key} mismatch`);
  }
  requireThat(SHA.test(value.head_sha) && value.author_agent !== value.reviewer_agent,
    'invalid SHA or self review');
  requireThat(['COMMENT', 'REQUEST_CHANGES'].includes(value.result) &&
    value.event === 'pull_request' && Number.isSafeInteger(value.run_id) && value.run_id > 0 &&
    Number.isSafeInteger(value.run_attempt) && value.run_attempt > 0, 'invalid verdict result or run');
  requireThat(review.user?.login === BOT && review.commit_id === value.head_sha &&
    review.state === 'COMMENTED',
  'review author, commit, or native result mismatch');
  const issued = timestamp(value.timestamp);
  const submitted = timestamp(review.submitted_at);
  requireThat(issued <= submitted && submitted <= now && submitted - issued <= 300_000,
    'stale or future verdict timestamp');
  return value;
}

async function list(get, route, field) {
  const all = [];
  for (let page = 1; page <= 50; page++) {
    const response = await get(route, { per_page: 100, page });
    const items = field ? response[field] : response;
    requireThat(Array.isArray(items), 'unreadable paginated evidence');
    all.push(...items);
    if (items.length < 100) return all;
  }
  throw new Error('Squad review refused: evidence pagination exceeded bound');
}

async function committedJsonEvidence(get, repository, path, ref, { allowMissing = false } = {}) {
  requireThat(SHA.test(ref), 'invalid committed evidence ref');
  let file;
  try {
    file = await get(`repos/${repository}/contents/${path}`, { ref });
  } catch (error) {
    if (allowMissing && error?.status === 404) return undefined;
    throw error;
  }
  requireThat(file?.type === 'file' && file.encoding === 'base64' &&
    typeof file.content === 'string' && file.size <= 65536, `unreadable committed ${path}`);
  const content = Buffer.from(file.content, 'base64');
  return {
    value: JSON.parse(content.toString('utf8')),
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

async function committedJson(get, repository, path, ref, options) {
  return (await committedJsonEvidence(get, repository, path, ref, options))?.value;
}

function validateFirstInstallManifest(value, guardSha256) {
  const workflows = Array.isArray(value?.workflows) ? value.workflows : [];
  const names = workflows.map(entry => entry?.name).sort();
  const guards = Array.isArray(value?.shared_runtime)
    ? value.shared_runtime.filter(entry => entry?.path === 'shared/squad-review-guard.mjs')
    : [];
  const guard = guards[0];
  requireThat(value?.schema_version === 1 &&
    value.package === 'bradygaster/squad/workflows' &&
    value.revision_policy?.kind === 'immutable-git-commit' &&
    names.join('\0') === [...INSTALL_WORKFLOWS].sort().join('\0') &&
    workflows.every(entry =>
      entry?.destination === `.github/workflows/${entry.name}.md` &&
      entry?.lock === `.github/workflows/${entry.name}.lock.yml` &&
      typeof entry?.source_sha256 === 'string' && /^[0-9a-f]{64}$/.test(entry.source_sha256)) &&
    guards.length === 1 &&
    guard?.destination === '.github/workflows/shared/squad-review-guard.mjs' &&
    guard?.ownership === 'manifest' && guard?.sha256 === guardSha256,
  'invalid committed first-install manifest');
  return guard;
}

async function validateFirstInstallPackage(
  get,
  repository,
  ref,
  manifest,
  manifestSha256,
  guardSha256,
  workflowSource,
) {
  const entries = await get(`repos/${repository}/contents/${INSTALL_PACKAGES}`, { ref });
  requireThat(Array.isArray(entries) && entries.length <= 64,
    'unreadable committed first-install package provenance');
  const packages = entries.filter(entry =>
    entry?.type === 'file' &&
    /^bradygaster-squad-workflows-[0-9a-f]{12}\.json$/.test(entry.name ?? ''));
  requireThat(packages.length === 1, 'missing or duplicate first-install package provenance');
  const provenance = await committedJson(
    get,
    repository,
    `${INSTALL_PACKAGES}/${packages[0].name}`,
    ref,
  );
  const revision = provenance?.resolvedCommit;
  const sourceMatch = typeof workflowSource === 'string'
    ? workflowSource.match(
      /^bradygaster\/squad\/workflows\/package\/squad-review\.md@([0-9a-f]{40})$/,
    )
    : undefined;
  requireThat(provenance?.schemaVersion === 1 &&
    provenance.package === 'bradygaster/squad/workflows' &&
    SHA.test(revision ?? '') &&
    provenance.source === `bradygaster/squad/workflows@${revision}` &&
    Array.isArray(provenance.files) &&
    (workflowSource === undefined || sourceMatch?.[1] === revision),
  'invalid committed first-install package provenance');
  const files = new Map(provenance.files.map(entry => [entry?.destination, entry]));
  requireThat(files.size === provenance.files.length,
    'duplicate committed first-install package paths');
  const required = [
    INSTALL_MANIFEST,
    '.github/workflows/shared/squad-review-guard.mjs',
    ...INSTALL_WORKFLOWS.flatMap(name => [
      `.github/workflows/${name}.md`,
      `.github/workflows/${name}.lock.yml`,
    ]),
  ];
  requireThat(required.every(path =>
    files.get(path)?.destination === path &&
    typeof files.get(path)?.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(files.get(path).sha256)),
  'incomplete committed first-install topology');
  requireThat(
    files.get('.github/workflows/shared/squad-review-guard.mjs').sha256 === guardSha256 &&
    files.get(INSTALL_MANIFEST).sha256 === manifestSha256 &&
    manifest.package === provenance.package,
  'first-install package does not bind the executing guard');
}

export async function reviewTarget(
  env,
  get,
  {
    relay = false,
    firstInstall = false,
    workflowSha,
    workflowGuardSha256,
    workflowSource,
  } = {},
) {
  const repository = env.GITHUB_REPOSITORY;
  const number = Number(env.SQUAD_REVIEW_PR);
  requireThat(typeof repository === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repository) &&
    /^[1-9]\d*$/.test(env.SQUAD_REVIEW_PR ?? '') && Number.isSafeInteger(number), 'invalid target');
  const pr = await get(`repos/${repository}/pulls/${number}`);
  requireThat(pr.number === number && pr.head?.repo?.full_name === repository &&
    pr.base?.repo?.full_name === repository && SHA.test(pr.head.sha) && SHA.test(pr.base.sha),
  'foreign repository or invalid PR');
  requireThat(SHA.test(env.SQUAD_REVIEW_HEAD ?? '') && pr.head.sha === env.SQUAD_REVIEW_HEAD,
    'PR head changed or expected SHA missing');
  requireThat(relay
    ? pr.merged === true && pr.state === 'closed' &&
      pr.base.ref === env.SQUAD_REVIEW_DEFAULT_BRANCH
    : pr.state === 'open' && pr.merged === false, 'invalid PR lifecycle');
  const body = String(pr.body ?? '').replace(/\r\n/g, '\n');
  let issue;
  if (body.includes('squad:implement')) {
    const provenance = evaluateImplementDispatchInputs({
      eventName: 'pull_request', pullRequestBody: body, pullRequestHeadRef: pr.head.ref,
    });
    requireThat(provenance.ok, 'malformed or duplicate implementation provenance');
    issue = provenance.issue_number;
  }
  const value = await committedJson(
    get,
    repository,
    '.squad-review.json',
    pr.head.sha,
    { allowMissing: firstInstall },
  );
  let attribution;
  if (value === undefined) {
    requireThat(firstInstall === true && relay === false &&
      env.GITHUB_EVENT_NAME === 'pull_request' &&
      SHA.test(workflowSha ?? '') && workflowSha === pr.head.sha &&
      typeof workflowGuardSha256 === 'string' && /^[0-9a-f]{64}$/.test(workflowGuardSha256),
    'missing committed attribution outside an immutable clean first install');
    const manifestEvidence = await committedJsonEvidence(
      get,
      repository,
      INSTALL_MANIFEST,
      pr.head.sha,
    );
    const manifest = manifestEvidence.value;
    validateFirstInstallManifest(manifest, workflowGuardSha256);
    await validateFirstInstallPackage(
      get,
      repository,
      pr.head.sha,
      manifest,
      manifestEvidence.sha256,
      workflowGuardSha256,
      workflowSource,
    );
    attribution = {
      schema: 'squad-review-author/v1',
      repository,
      issue: issue ?? number,
      author_agent: INSTALL_AUTHOR,
      reviewer_agent: INSTALL_REVIEWER,
    };
  } else {
    const registry = await committedJson(
      get,
      repository,
      '.squad/casting/registry.json',
      pr.base.sha,
    );
    attribution = validateAttribution(value, registry, repository, issue ?? value?.issue);
  }
  return {
    repository, pull_request: number, head_sha: pr.head.sha,
    author_agent: attribution.author_agent, reviewer_agent: attribution.reviewer_agent, pr,
  };
}

async function currentEvidence(target, get) {
  const reviews = await list(get, `repos/${target.repository}/pulls/${target.pull_request}/reviews`);
  // A forged/malformed current-head bot record is never rescued by a valid duplicate.
  return reviews.filter(review => review.user?.login === BOT &&
    (review.commit_id === target.head_sha ||
      String(review.body ?? '').includes(target.head_sha)) &&
    String(review.body ?? '').includes(VERDICT_PREFIX.trim()));
}

export async function enforceReviewOutputs(env, get, options = {}) {
  requireThat(['pull_request', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'invalid event');
  requireThat(options.firstInstall !== true || typeof options.workflowSource === 'string',
    'first-install output binding requires immutable workflow source provenance');
  const target = await reviewTarget(env, get, options);
  const output = JSON.parse(readFileSync(env.GH_AW_AGENT_OUTPUT, 'utf8'));
  requireThat(Array.isArray(output.items), 'missing safe-output items');
  const verdicts = output.items.filter(item => item.type === 'submit_pull_request_review');
  const existing = await currentEvidence(target, get);
  requireThat(existing.length <= 1, 'duplicate verdict evidence');
  if (existing.length === 1) {
    validateVerdict(record(existing[0].body, VERDICT_PREFIX), target, existing[0]);
    requireThat(verdicts.length === 0, 'unchanged head already has a verdict');
    return;
  }
  requireThat(verdicts.length === 1, 'exactly one review is required; noop cannot clear review');
  const item = verdicts[0];
  requireThat(['COMMENT', 'REQUEST_CHANGES'].includes(item.event) &&
    typeof item.body === 'string' && !item.body.includes('Squad-Review-Verdict') &&
    !item.body.includes('Squad-Review-Override'), 'invalid review output');
  // Manual runs remain useful review diagnostics, but never mint clearing evidence.
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    item.body += `\n\nManual Squad verdict: ${item.event} (diagnostic only).`;
    item.event = 'COMMENT';
    writeFileSync(env.GH_AW_AGENT_OUTPUT, JSON.stringify(output));
    return;
  }
  const value = {
    schema: 'squad-review-verdict/v1',
    repository: target.repository,
    pull_request: target.pull_request,
    head_sha: target.head_sha,
    author_agent: target.author_agent,
    reviewer_agent: target.reviewer_agent,
    result: item.event,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    run_id: Number(env.GITHUB_RUN_ID),
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
    event: 'pull_request',
  };
  requireThat(Number.isSafeInteger(value.run_id) && value.run_id > 0 &&
    Number.isSafeInteger(value.run_attempt) && value.run_attempt > 0, 'invalid workflow identity');
  item.body += `\n\n${VERDICT_PREFIX}${JSON.stringify(value)}`;
  // GitHub forbids requesting changes on one's own PR. The logical verdict,
  // not a native bot approval/rejection, drives the independent status check.
  item.event = 'COMMENT';
  // Native review commit binding and a final live read prevent stale agent output passing.
  await reviewTarget(env, get, options);
  writeFileSync(env.GH_AW_AGENT_OUTPUT, JSON.stringify(output));
}

export async function assertClearingReview(env, get, options = {}) {
  const { relay = false } = options;
  requireThat(env.GITHUB_EVENT_NAME === 'pull_request', 'only PR runs can clear review');
  const target = await reviewTarget(env, get, options);
  const candidates = await currentEvidence(target, get);
  requireThat(candidates.length === 1, 'missing or duplicate verdict evidence');
  const review = candidates[0];
  const cutoff = relay ? timestamp(target.pr.merged_at) : Date.now();
  const verdict = validateVerdict(record(review.body, VERDICT_PREFIX), target, review, cutoff);
  const run = await get(`repos/${target.repository}/actions/runs/${verdict.run_id}`);
  requireThat(run.event === 'pull_request' && run.path === WORKFLOW &&
    run.repository?.full_name === target.repository && run.head_sha === target.head_sha &&
    run.run_attempt >= verdict.run_attempt &&
    run.display_title === `Squad review \u2014 PR #${target.pull_request}` &&
    Array.isArray(run.pull_requests) &&
    (run.pull_requests.length === 0 || run.pull_requests.some(pr => pr.number === target.pull_request &&
      pr.head?.sha === target.head_sha && pr.base?.repo?.name === target.pr.base.repo.name)),
  'verdict is not bound to this PR workflow run');
  requireThat(relay || String(verdict.run_id) === env.GITHUB_RUN_ID ||
    (run.status === 'completed' && run.conclusion === 'success'),
  'rerun the original PR review workflow to clear its failed verdict');
  const attempt = run.run_attempt === verdict.run_attempt ? run :
    await get(`repos/${target.repository}/actions/runs/${verdict.run_id}/attempts/${verdict.run_attempt}`);
  requireThat(attempt.run_attempt === verdict.run_attempt &&
    timestamp(attempt.run_started_at) <= timestamp(verdict.timestamp) &&
    (attempt.status !== 'completed' ||
      timestamp(review.submitted_at) <= timestamp(attempt.updated_at)), 'verdict outside workflow run');
  if (relay) {
    requireThat(run.status === 'completed' && run.conclusion === 'success', 'review run did not succeed');
    const jobs = await list(get,
      `repos/${target.repository}/actions/runs/${verdict.run_id}/attempts/${run.run_attempt}/jobs`, 'jobs');
    const checks = jobs.filter(job => job.name === CHECK_NAME);
    requireThat(checks.length === 1 && checks[0].conclusion === 'success' &&
      timestamp(checks[0].completed_at) <= cutoff, 'required review check did not pass before merge');
  }
  if (verdict.result === 'REQUEST_CHANGES') {
    const comments = await list(get, `repos/${target.repository}/issues/${target.pull_request}/comments`);
    const overrides = comments.filter(comment =>
      String(comment.body ?? '').includes(OVERRIDE_PREFIX.trim()))
      .filter(comment => {
        const candidate = record(comment.body, OVERRIDE_PREFIX);
        requireThat(typeof candidate.head_sha === 'string' && SHA.test(candidate.head_sha),
          'override has an invalid head SHA');
        return candidate.head_sha === target.head_sha;
      });
    requireThat(overrides.length === 1, 'REQUEST_CHANGES needs exactly one explicit override');
    const comment = overrides[0];
    const override = record(comment.body, OVERRIDE_PREFIX);
    requireThat(exactKeys(override, ['schema', 'repository', 'pull_request', 'head_sha', 'review_id', 'reason']) &&
      override.schema === 'squad-review-override/v1' &&
      override.repository === target.repository && override.pull_request === target.pull_request &&
      override.head_sha === target.head_sha && override.review_id === review.id &&
      typeof override.reason === 'string' && override.reason.trim().length >= 10,
    'invalid SHA-scoped override');
    requireThat(comment.user?.type === 'User' && /^[\w-]+$/.test(comment.user.login) &&
      timestamp(comment.created_at) >= timestamp(review.submitted_at) &&
      timestamp(comment.updated_at) === timestamp(comment.created_at) &&
      timestamp(comment.created_at) <= cutoff, 'override must be a new, unedited human comment');
    const permission = await get(
      `repos/${target.repository}/collaborators/${comment.user.login}/permission`);
    requireThat(permission.permission === 'admin', 'override requires repository administrator');
  }
  await reviewTarget(env, get, options);
  return verdict;
}
