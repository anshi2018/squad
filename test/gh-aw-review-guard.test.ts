import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertClearingReview, CHECK_NAME, enforceReviewOutputs, OVERRIDE_PREFIX,
  reviewTarget, validateAttribution, validateVerdict, VERDICT_PREFIX,
} from '../workflows/shared/squad-review-guard.mjs';
import {
  createFirstInstallFixture,
  githubFile,
  type InstallFixture,
} from './helpers/gh-aw-install-fixture.js';

const REPOSITORY = 'squad/example';
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const START = '2026-09-28T12:00:00Z';
const ISSUED = '2026-09-28T12:01:00Z';
const SUBMITTED = '2026-09-28T12:01:01Z';
const FINISHED = '2026-09-28T12:02:00Z';
const MERGED = '2026-09-28T12:03:00Z';
const NOW = Date.parse('2026-09-28T12:04:00Z');
const FIRST_INSTALL = createFirstInstallFixture(HEAD);
const GUARD_PATH = '.github/workflows/shared/squad-review-guard.mjs';
const GUARD_SHA256 = FIRST_INSTALL.provenance.files.find(
  entry => entry.destination === GUARD_PATH,
)!.sha256;
const workspaces: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function fixture(relay = false) {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  const env = {
    GITHUB_EVENT_NAME: 'pull_request', GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '1',
    SQUAD_REVIEW_PR: '42', SQUAD_REVIEW_HEAD: HEAD, SQUAD_REVIEW_DEFAULT_BRANCH: 'dev',
  };
  const attribution = {
    schema: 'squad-review-author/v1', repository: REPOSITORY, issue: 9,
    author_agent: 'implementer', reviewer_agent: 'reviewer',
  };
  const registry = {
    schema: 'squad-agent-provenance/v1', schema_version: 1,
    agents: {
      implementer: { persistent_name: 'implementer', status: 'active' },
      reviewer: { persistent_name: 'reviewer', status: 'active' },
    },
  };
  const pr = {
    number: 42, state: relay ? 'closed' : 'open', merged: relay, merged_at: MERGED,
    body: '<!-- squad:implement issue=9 run=7 -->',
    head: { sha: HEAD, ref: 'squad/implement-9-fix', repo: { full_name: REPOSITORY, name: 'example' } },
    base: { sha: BASE, ref: 'dev', repo: { full_name: REPOSITORY, name: 'example' } },
  };
  const verdict = {
    schema: 'squad-review-verdict/v1', repository: REPOSITORY, pull_request: 42,
    head_sha: HEAD, author_agent: 'implementer', reviewer_agent: 'reviewer',
    result: 'COMMENT', timestamp: ISSUED, run_id: 17, run_attempt: 1, event: 'pull_request',
  };
  const review = {
    id: 123, user: { login: 'github-actions[bot]' }, commit_id: HEAD,
    state: 'COMMENTED', submitted_at: SUBMITTED,
    body: '',
  };
  const run = {
    event: 'pull_request', path: '.github/workflows/squad-review.lock.yml',
    display_title: 'Squad review \u2014 PR #42',
    repository: { full_name: REPOSITORY }, head_sha: HEAD, run_attempt: 1,
    pull_requests: [{ number: 42, head: { sha: HEAD }, base: { repo: { name: 'example' } } }],
    run_started_at: START, updated_at: FINISHED, status: 'completed', conclusion: 'success',
  };
  const jobs = [{ name: CHECK_NAME, conclusion: 'success', completed_at: FINISHED }];
  const override = {
    schema: 'squad-review-override/v1', repository: REPOSITORY, pull_request: 42,
    head_sha: HEAD, review_id: 123, reason: 'Accepted false positive; linked human decision.',
  };
  const comment = {
    user: { login: 'human', type: 'User' }, created_at: FINISHED, updated_at: FINISHED,
    body: '',
  };
  const state = {
    reviews: [review], comments: [] as typeof comment[], permission: 'admin',
    missingManifest: false, calls: [] as string[], prReads: 0, changeAfterFirstRead: false,
  };
  const encode = (value: unknown) => {
    const content = Buffer.from(JSON.stringify(value));
    return {
      type: 'file', encoding: 'base64', size: content.length,
      content: content.toString('base64'),
    };
  };
  const get = async (route: string, fields?: Record<string, unknown>) => {
    state.calls.push(route);
    if (route.endsWith('/pulls/42')) {
      state.prReads++;
      if (state.changeAfterFirstRead && state.prReads > 1) pr.head.sha = BASE;
      return structuredClone(pr);
    }
    if (route.endsWith('/contents/.squad-review.json')) {
      expect(fields?.ref).toBe(HEAD);
      if (state.missingManifest) throw new Error('404 missing committed attribution');
      return encode(attribution);
    }
    if (route.endsWith('/contents/.squad/casting/registry.json')) {
      expect(fields?.ref).toBe(BASE);
      return encode(registry);
    }
    if (route.endsWith('/reviews')) return state.reviews;
    if (route.endsWith('/actions/runs/17')) return run;
    if (route.endsWith('/attempts/1')) return { ...run, run_attempt: 1, run_started_at: START };
    if (/\/attempts\/[12]\/jobs$/.test(route)) return { jobs };
    if (route.endsWith('/comments')) return state.comments;
    if (route.endsWith('/permission')) return { permission: state.permission };
    throw new Error(`Unexpected API route: ${route}`);
  };
  const sync = () => {
    review.body = `${VERDICT_PREFIX}${JSON.stringify(verdict)}`;
    comment.body = `${OVERRIDE_PREFIX}${JSON.stringify(override)}`;
  };
  sync();
  return {
    env, attribution, registry, pr, verdict, review, run, jobs, override, comment,
    state, encode, get, sync,
  };
}

function firstInstallProof(): InstallFixture {
  return {
    manifest: structuredClone(FIRST_INSTALL.manifest),
    provenance: structuredClone(FIRST_INSTALL.provenance),
    consumerFiles: new Map([...FIRST_INSTALL.consumerFiles].map(
      ([path, content]) => [path, Buffer.from(content)],
    )),
    canonicalFiles: new Map([...FIRST_INSTALL.canonicalFiles].map(
      ([path, content]) => [path, Buffer.from(content)],
    )),
  };
}

async function firstInstallGet(
  fixture: ReturnType<typeof fixture>,
  proof: InstallFixture,
  route: string,
  fields?: Record<string, unknown>,
) {
  if (route.endsWith('/contents/.squad-review.json')) {
    throw Object.assign(new Error('Not Found'), { status: 404 });
  }
  if (route.endsWith('/contents/.github/aw/packages')) {
    expect(fields?.ref).toBe(HEAD);
    return [{
      type: 'file',
      name: 'bradygaster-squad-workflows-3632054824e8.json',
    }];
  }
  if (route.endsWith(
    '/contents/.github/aw/packages/bradygaster-squad-workflows-3632054824e8.json',
  )) return fixture.encode(proof.provenance);
  const marker = '/contents/';
  const path = route.slice(route.indexOf(marker) + marker.length);
  const files = route.startsWith('repos/bradygaster/squad/')
    ? proof.canonicalFiles
    : proof.consumerFiles;
  const content = files.get(path);
  if (content) return githubFile(content);
  return fixture.get(route, fields);
}

describe('independent Squad review guard', () => {
  it('uses reserved workflow-role attribution only for a proven clean package install', async () => {
    const f = fixture();
    f.state.reviews = [];
    const proof = firstInstallProof();
    const get = (route: string, fields?: Record<string, unknown>) =>
      firstInstallGet(f, proof, route, fields);
    const options = {
      firstInstall: true,
      workflowSha: HEAD,
      workflowGuardSha256: GUARD_SHA256,
      workflowSource: `bradygaster/squad/workflows/package/squad-review.md@${HEAD}`,
    };
    await expect(reviewTarget(f.env, get, options)).resolves.toMatchObject({
      author_agent: '@squad/bootstrap-installation',
      reviewer_agent: '@squad/bootstrap-review-workflow',
    });

    const workspace = mkdtempSync(join(tmpdir(), 'squad-review-install-'));
    workspaces.push(workspace);
    const path = join(workspace, 'output.json');
    writeFileSync(path, JSON.stringify({ items: [{
      type: 'submit_pull_request_review', event: 'COMMENT', body: 'Install topology reviewed.',
    }] }));
    await enforceReviewOutputs({ ...f.env, GH_AW_AGENT_OUTPUT: path }, get, options);
    const output = JSON.parse(readFileSync(path, 'utf8'));
    expect(output.items[0].body).toContain('"author_agent":"@squad/bootstrap-installation"');
    expect(output.items[0].body).toContain(
      '"reviewer_agent":"@squad/bootstrap-review-workflow"',
    );
  });

  it('refuses arbitrary clean-base PRs and malformed first-install proof', async () => {
    const f = fixture();
    const proof = firstInstallProof();
    const missingAttribution = (route: string, fields?: Record<string, unknown>) =>
      firstInstallGet(f, proof, route, fields);
    const options = {
      firstInstall: true,
      workflowSha: HEAD,
      workflowGuardSha256: GUARD_SHA256,
      workflowSource: `bradygaster/squad/workflows/package/squad-review.md@${HEAD}`,
    };
    await expect(reviewTarget(f.env, missingAttribution)).rejects.toThrow('Not Found');
    await expect(reviewTarget(f.env, missingAttribution, {
      ...options, workflowSha: BASE,
    })).rejects.toThrow('outside an immutable clean first install');

    proof.manifest.workflows.pop();
    proof.canonicalFiles.set(
      'workflows/squad-workflows.manifest.json',
      Buffer.from(`${JSON.stringify(proof.manifest, null, 2)}\n`),
    );
    await expect(reviewTarget(f.env, missingAttribution, options))
      .rejects.toThrow('invalid immutable package manifest');
    const reset = firstInstallProof();
    proof.manifest = reset.manifest;
    proof.canonicalFiles = reset.canonicalFiles;
    proof.provenance.source = `bradygaster/squad/workflows@${BASE}`;
    await expect(reviewTarget(f.env, missingAttribution, options))
      .rejects.toThrow('invalid committed first-install package provenance');
    proof.provenance.source = `bradygaster/squad/workflows@${HEAD}`;
    proof.provenance.files.pop();
    await expect(reviewTarget(f.env, missingAttribution, options))
      .rejects.toThrow('invalid committed first-install package provenance');
  });

  it('does not rescue malformed attribution or non-404 reads during first install', async () => {
    const f = fixture();
    const options = {
      firstInstall: true,
      workflowSha: HEAD,
      workflowGuardSha256: GUARD_SHA256,
      workflowSource: `bradygaster/squad/workflows/package/squad-review.md@${HEAD}`,
    };
    f.attribution.schema = 'wrong';
    await expect(reviewTarget(f.env, f.get, options)).rejects.toThrow('malformed committed');
    await expect(reviewTarget(f.env, async (route, fields) => {
      if (route.endsWith('/contents/.squad-review.json')) {
        throw Object.assign(new Error('Forbidden'), { status: 403 });
      }
      return f.get(route, fields);
    }, options)).rejects.toThrow('Forbidden');
  });

  it('hashes installed and immutable package bytes instead of trusting provenance claims', async () => {
    const f = fixture();
    const options = {
      firstInstall: true,
      workflowSha: HEAD,
      workflowGuardSha256: GUARD_SHA256,
      workflowSource: `bradygaster/squad/workflows/package/squad-review.md@${HEAD}`,
    };
    const sourcePath = '.github/workflows/squad.md';
    const lockPath = '.github/workflows/squad.lock.yml';
    const canonicalPath = 'workflows/package/squad.md';

    const changedSource = firstInstallProof();
    changedSource.consumerFiles.set(
      sourcePath,
      Buffer.concat([changedSource.consumerFiles.get(sourcePath)!, Buffer.from('\nattacker edit\n')]),
    );
    await expect(reviewTarget(
      f.env,
      (route, fields) => firstInstallGet(f, changedSource, route, fields),
      options,
    )).rejects.toThrow(`installed bytes do not match ownership for ${sourcePath}`);

    const changedLock = firstInstallProof();
    changedLock.consumerFiles.set(
      lockPath,
      Buffer.concat([changedLock.consumerFiles.get(lockPath)!, Buffer.from('\nattacker edit\n')]),
    );
    await expect(reviewTarget(
      f.env,
      (route, fields) => firstInstallGet(f, changedLock, route, fields),
      options,
    )).rejects.toThrow(`installed compiled lock mismatch for ${lockPath}`);

    const changedCanonical = firstInstallProof();
    changedCanonical.canonicalFiles.set(
      canonicalPath,
      Buffer.concat([changedCanonical.canonicalFiles.get(canonicalPath)!, Buffer.from('\nwrong\n')]),
    );
    await expect(reviewTarget(
      f.env,
      (route, fields) => firstInstallGet(f, changedCanonical, route, fields),
      options,
    )).rejects.toThrow(`immutable package source digest mismatch for ${canonicalPath}`);

    const sourceFailure = firstInstallProof();
    await expect(reviewTarget(f.env, async (route, fields) => {
      if (route === `repos/bradygaster/squad/contents/${canonicalPath}`) {
        throw Object.assign(new Error('source fetch forbidden'), { status: 403 });
      }
      return firstInstallGet(f, sourceFailure, route, fields);
    }, options)).rejects.toThrow('source fetch forbidden');
  });

  it('accepts a distinct, committed, current-head verdict and merged-head relay', async () => {
    for (const relay of [false, true]) {
      const f = fixture(relay);
      await expect(assertClearingReview(f.env, f.get, { relay })).resolves.toEqual(f.verdict);
      expect(f.state.prReads).toBe(2);
      if (relay) expect(f.state.calls.some(route => route.endsWith('/jobs'))).toBe(true);
    }
  });

  it.each([
    ['schema', 'other'], ['repository', 'other/repo'], ['issue', 10], ['issue', '9'],
    ['author_agent', 'missing'], ['reviewer_agent', 'missing'],
    ['author_agent', 'reviewer'], ['reviewer_agent', 'implementer'],
  ])('refuses attribution mutation %s=%s', (key, value) => {
    const f = fixture();
    Object.assign(f.attribution, { [key]: value });
    expect(() => validateAttribution(f.attribution, f.registry, REPOSITORY, 9)).toThrow();
  });

  it('refuses unknown fields, missing identities, alias identities, and inactive committed agents', () => {
    const f = fixture();
    expect(() => validateAttribution({ ...f.attribution, extra: true }, f.registry, REPOSITORY, 9)).toThrow();
    for (const key of Object.keys(f.attribution)) {
      const incomplete: Record<string, unknown> = { ...f.attribution };
      delete incomplete[key];
      expect(() => validateAttribution(incomplete, f.registry, REPOSITORY, 9)).toThrow();
    }
    f.registry.agents.reviewer.persistent_name = 'implementer';
    expect(() => validateAttribution(f.attribution, f.registry, REPOSITORY, 9)).toThrow();
    f.registry.agents.reviewer.persistent_name = 'reviewer';
    f.registry.agents.reviewer.status = 'retired';
    expect(() => validateAttribution(f.attribution, f.registry, REPOSITORY, 9)).toThrow();
  });

  it.each([
    ['schema', 'other'], ['repository', 'other/repo'], ['pull_request', 41],
    ['head_sha', BASE], ['author_agent', 'reviewer'], ['reviewer_agent', 'implementer'],
    ['result', 'APPROVE'], ['result', ''], ['timestamp', 'bad'],
    ['timestamp', '2026-09-28T12:05:00Z'], ['timestamp', '2026-09-28T11:00:00Z'],
    ['timestamp', '2026-02-30T12:01:00Z'],
    ['run_id', 0], ['run_id', '17'], ['run_attempt', 0], ['event', 'workflow_dispatch'],
  ])('refuses verdict mutation %s=%s at the real relay', async (key, value) => {
    const f = fixture(true);
    Object.assign(f.verdict, { [key]: value });
    f.sync();
    await expect(assertClearingReview(f.env, f.get, { relay: true })).rejects.toThrow();
  });

  it('requires every verdict field and forbids extensions', () => {
    const f = fixture();
    for (const key of Object.keys(f.verdict)) {
      const incomplete: Record<string, unknown> = { ...f.verdict };
      delete incomplete[key];
      expect(() => validateVerdict(incomplete, f.verdict, f.review, NOW)).toThrow();
    }
    expect(() => validateVerdict({ ...f.verdict, extra: 1 }, f.verdict, f.review, NOW)).toThrow();
  });

  it.each([
    'missing', 'duplicate', 'malformed', 'native-rejected', 'dismissed', 'foreign-bot',
    'wrong-native-sha', 'future-submission', 'missing-manifest', 'bad-marker', 'fenced-marker',
    'wrong-branch', 'duplicate-marker', 'stale-head', 'foreign-head', 'foreign-base', 'head-race',
    'not-merged', 'wrong-base', 'merge-before-review', 'merge-before-check',
    'failed-run', 'failed-check', 'missing-check', 'duplicate-check', 'wrong-check',
    'manual-run', 'wrong-workflow', 'wrong-run-repo', 'wrong-run-sha', 'wrong-run-pr',
    'wrong-run-attempt', 'wrong-run-title', 'verdict-before-run',
  ])('fails closed for %s', async mutation => {
    const f = fixture(true);
    switch (mutation) {
      case 'missing': f.state.reviews = []; break;
      case 'duplicate': f.state.reviews.push(f.review); break;
      case 'malformed': f.review.body = `${VERDICT_PREFIX}{broken`; break;
      case 'native-rejected': f.review.state = 'CHANGES_REQUESTED'; break;
      case 'dismissed': f.review.state = 'DISMISSED'; break;
      case 'foreign-bot': f.review.user.login = 'other[bot]'; break;
      case 'wrong-native-sha': f.review.commit_id = BASE; break;
      case 'future-submission': f.review.submitted_at = '2026-09-28T12:10:00Z'; break;
      case 'missing-manifest': f.state.missingManifest = true; break;
      case 'bad-marker': f.pr.body = '<!-- squad:implement issue=x run=7 -->'; break;
      case 'fenced-marker': f.pr.body = `\`\`\`\n${f.pr.body}\n\`\`\``; break;
      case 'wrong-branch': f.pr.head.ref = 'squad/implement-10-fix'; break;
      case 'duplicate-marker': f.pr.body += `\n${f.pr.body}`; break;
      case 'stale-head': f.pr.head.sha = BASE; break;
      case 'foreign-head': f.pr.head.repo.full_name = 'other/repo'; break;
      case 'foreign-base': f.pr.base.repo.full_name = 'other/repo'; break;
      case 'head-race': f.state.changeAfterFirstRead = true; break;
      case 'not-merged': f.pr.merged = false; break;
      case 'wrong-base': f.pr.base.ref = 'other'; break;
      case 'merge-before-review': f.pr.merged_at = START; break;
      case 'merge-before-check': f.pr.merged_at = SUBMITTED; break;
      case 'failed-run': f.run.conclusion = 'failure'; break;
      case 'failed-check': f.jobs[0].conclusion = 'failure'; break;
      case 'missing-check': f.jobs.splice(0); break;
      case 'duplicate-check': f.jobs.push(f.jobs[0]); break;
      case 'wrong-check': f.jobs[0].name = 'Squad Review / manual'; break;
      case 'manual-run': f.run.event = 'workflow_dispatch'; break;
      case 'wrong-workflow': f.run.path = '.github/workflows/other.yml'; break;
      case 'wrong-run-repo': f.run.repository.full_name = 'other/repo'; break;
      case 'wrong-run-sha': f.run.head_sha = BASE; break;
      case 'wrong-run-pr': f.run.pull_requests[0].number = 43; break;
      case 'wrong-run-attempt': f.run.run_attempt = 0; break;
      case 'wrong-run-title': f.run.display_title = 'Squad review \u2014 PR #43'; break;
      case 'verdict-before-run': f.run.run_started_at = FINISHED; break;
    }
    await expect(assertClearingReview(f.env, f.get, { relay: true })).rejects.toThrow();
  });

  it('does not accept a manual gate or the merge commit as the reviewed head', async () => {
    const f = fixture(true);
    await expect(assertClearingReview({ ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, f.get, { relay: true }))
      .rejects.toThrow('only PR runs');
    await expect(reviewTarget({ ...f.env, SQUAD_REVIEW_HEAD: BASE }, f.get, { relay: true }))
      .rejects.toThrow('head changed');
  });

  it('uses the fixed PR run title when GitHub omits historical PR links', async () => {
    const f = fixture(true);
    f.run.pull_requests = [];
    await expect(assertClearingReview(f.env, f.get, { relay: true })).resolves.toEqual(f.verdict);
    f.run.display_title = '';
    await expect(assertClearingReview(f.env, f.get, { relay: true })).rejects.toThrow('bound');
  });

  it('clears a rejection only through a human-admin SHA-scoped override, including reruns', async () => {
    const f = fixture(true);
    f.verdict.result = 'REQUEST_CHANGES';
    f.sync();
    await expect(assertClearingReview(f.env, f.get, { relay: true })).rejects.toThrow('override');
    f.state.comments = [f.comment];
    f.state.comments.push({ ...f.comment, body: `${OVERRIDE_PREFIX}${JSON.stringify({ ...f.override, head_sha: BASE })}` });
    f.run.run_attempt = 2;
    await expect(assertClearingReview(f.env, f.get, { relay: true })).resolves.toEqual(f.verdict);
    expect(f.state.calls.some(route => route.endsWith('/attempts/2/jobs'))).toBe(true);
  });

  it.each([
    'schema', 'repository', 'pull_request', 'head_sha', 'review_id', 'reason',
    'bot', 'permission', 'edited', 'future', 'before-review', 'duplicate', 'malformed',
  ])('rejects a bad override: %s', async mutation => {
    const f = fixture(true);
    f.verdict.result = 'REQUEST_CHANGES';
    f.state.comments = [f.comment];
    if (Object.hasOwn(f.override, mutation)) Object.assign(f.override, { [mutation]: 'wrong' });
    if (mutation === 'bot') f.comment.user.type = 'Bot';
    if (mutation === 'permission') f.state.permission = 'write';
    if (mutation === 'edited') f.comment.updated_at = MERGED;
    if (mutation === 'future') f.comment.created_at = f.comment.updated_at = '2026-09-28T12:10:00Z';
    if (mutation === 'before-review') f.comment.created_at = f.comment.updated_at = START;
    if (mutation === 'duplicate') f.state.comments.push(f.comment);
    f.sync();
    if (mutation === 'malformed') f.comment.body = `${OVERRIDE_PREFIX}{invalid`;
    await expect(assertClearingReview(f.env, f.get, { relay: true })).rejects.toThrow();
  });

  it('cannot override missing, stale, or self-authored evidence', async () => {
    for (const mutation of ['missing', 'self', 'stale']) {
      const f = fixture(true);
      f.state.comments = [f.comment];
      if (mutation === 'missing') f.state.reviews = [];
      if (mutation === 'self') f.attribution.reviewer_agent = 'implementer';
      if (mutation === 'stale') f.verdict.head_sha = BASE;
      f.sync();
      await expect(assertClearingReview(f.env, f.get, { relay: true })).rejects.toThrow();
    }
  });

  it('mints evidence only at the output boundary, rejects noop/duplicates/forgery, and re-fetches head', async () => {
    const f = fixture();
    f.state.reviews = [];
    const workspace = mkdtempSync(join(tmpdir(), 'squad-review-'));
    workspaces.push(workspace);
    const path = join(workspace, 'output.json');
    const env = { ...f.env, GH_AW_AGENT_OUTPUT: path };
    const item = { type: 'submit_pull_request_review', event: 'COMMENT', body: 'No blockers.' };
    for (const items of [
      [], [{ type: 'noop' }], [item, item],
      [{ ...item, event: 'APPROVE' }],
      [{ ...item, body: `${VERDICT_PREFIX}{}` }],
    ]) {
      writeFileSync(path, JSON.stringify({ items }));
      await expect(enforceReviewOutputs(env, f.get)).rejects.toThrow();
    }
    writeFileSync(path, JSON.stringify({ items: [item] }));
    await enforceReviewOutputs(env, f.get);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    expect(value.items[0].body).toContain(VERDICT_PREFIX);
    expect(value.items[0].body).toContain('"author_agent":"implementer"');
    expect(value.items[0].body).toContain(`"head_sha":"${HEAD}"`);
    f.state.changeAfterFirstRead = true;
    f.state.prReads = 0;
    writeFileSync(path, JSON.stringify({ items: [item] }));
    await expect(enforceReviewOutputs(env, f.get)).rejects.toThrow('head changed');
    expect(readFileSync(path, 'utf8')).not.toContain(VERDICT_PREFIX);
  });

  it('preserves logical rejection but uses native COMMENT for same-account reviews', async () => {
    const f = fixture();
    f.state.reviews = [];
    const workspace = mkdtempSync(join(tmpdir(), 'squad-review-native-'));
    workspaces.push(workspace);
    const path = join(workspace, 'output.json');
    writeFileSync(path, JSON.stringify({ items: [{
      type: 'submit_pull_request_review', event: 'REQUEST_CHANGES', body: 'Reproducible blocker.',
    }] }));
    await enforceReviewOutputs({ ...f.env, GH_AW_AGENT_OUTPUT: path }, f.get);
    const output = JSON.parse(readFileSync(path, 'utf8'));
    expect(output.items[0].event).toBe('COMMENT');
    expect(output.items[0].body).toContain('"result":"REQUEST_CHANGES"');
  });

  it('never mints clearing evidence on a manual run', async () => {
    const f = fixture();
    f.state.reviews = [];
    const workspace = mkdtempSync(join(tmpdir(), 'squad-review-manual-'));
    workspaces.push(workspace);
    const path = join(workspace, 'output.json');
    writeFileSync(path, JSON.stringify({ items: [{
      type: 'submit_pull_request_review', event: 'REQUEST_CHANGES', body: 'Diagnostic.',
    }] }));
    await enforceReviewOutputs({
      ...f.env, GITHUB_EVENT_NAME: 'workflow_dispatch', GH_AW_AGENT_OUTPUT: path,
    }, f.get);
    const output = JSON.parse(readFileSync(path, 'utf8'));
    expect(output.items[0].event).toBe('COMMENT');
    expect(output.items[0].body).not.toContain(VERDICT_PREFIX);
    expect(output.items[0].body).toContain('diagnostic only');
  });

  it('deduplicates only a validated existing verdict, never a marker-shaped claim', async () => {
    const f = fixture();
    const workspace = mkdtempSync(join(tmpdir(), 'squad-review-dedup-'));
    workspaces.push(workspace);
    const path = join(workspace, 'output.json');
    const env = { ...f.env, GH_AW_AGENT_OUTPUT: path };
    writeFileSync(path, JSON.stringify({ items: [{ type: 'noop' }] }));
    await expect(enforceReviewOutputs(env, f.get)).resolves.toBeUndefined();
    writeFileSync(path, JSON.stringify({ items: [{
      type: 'submit_pull_request_review', event: 'COMMENT', body: 'Duplicate.',
    }] }));
    await expect(enforceReviewOutputs(env, f.get)).rejects.toThrow('already has a verdict');
    f.review.body = `${VERDICT_PREFIX}{broken`;
    writeFileSync(path, JSON.stringify({ items: [{ type: 'noop' }] }));
    await expect(enforceReviewOutputs(env, f.get)).rejects.toThrow();
  });

  it('fails closed on incomplete pagination and API errors', async () => {
    const f = fixture(true);
    const get = async (route: string, fields?: Record<string, unknown>) => route.endsWith('/reviews')
      ? Array.from({ length: 100 }, () => f.review) : f.get(route, fields);
    await expect(assertClearingReview(f.env, get, { relay: true })).rejects.toThrow('pagination');
    await expect(assertClearingReview(f.env, async () => { throw new Error('403'); }, { relay: true }))
      .rejects.toThrow('403');
  });
});
