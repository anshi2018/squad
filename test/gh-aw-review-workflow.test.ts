import { afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractSafeOutputsConfigJson } from './helpers/gh-aw-lock.js';
import { parse } from 'yaml';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REVIEWER = read('workflows/squad-review.md');
const ROUTER = read('workflows/squad.md');
const GUIDE = read('docs/src/content/docs/guide/gh-aw.md');
const README = read('README.md');
const AGENT_GUIDE = read('.github/agents.md');
const DEMO = read('docs/demo-agentic-sdlc-walkthrough.md');
const SHARED_BOOTSTRAP = read('workflows/shared/squad.md');
const REVIEWER_FRONTMATTER = frontmatter(REVIEWER);
const ROUTER_FRONTMATTER = frontmatter(ROUTER);
const compileWorkspaces: string[] = [];

function read(relativePath: string): string {
  return readFileSync(resolve(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function frontmatter(markdown: string): string {
  return markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
}

function yamlBlock(yaml: string, key: string): string {
  const lines = yaml.split('\n');
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const keyPattern = new RegExp(`^(\\s*)${escapedKey}:\\s*(.*)$`);
  const start = lines.findIndex(line => keyPattern.test(line));
  if (start === -1) return '';

  const indent = lines[start].match(keyPattern)![1].length;
  const block = [lines[start]];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    block.push(line);
  }
  return block.join('\n');
}

function listInBlock(block: string, key: string): string[] {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inline = block.match(new RegExp(`^\\s*${escapedKey}:\\s*\\[(.*)\\]\\s*$`, 'm'));
  if (inline) {
    return inline[1]
      .split(',')
      .map(item => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }

  const lines = block.split('\n');
  const keyPattern = new RegExp(`^(\\s*)${escapedKey}:\\s*$`);
  const start = lines.findIndex(line => keyPattern.test(line));
  if (start === -1) return [];

  const indent = lines[start].match(keyPattern)![1].length;
  const items: string[] = [];
  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() !== '' && line.search(/\S/) <= indent) break;
    const item = line.match(/^\s+-\s+(.+)$/)?.[1];
    if (item) items.push(item.trim().replace(/^['"]|['"]$/g, ''));
  }
  return items;
}

function provenanceRows(workflow: string): string[] {
  const section = workflow.match(/## Provenance decision tree\n([\s\S]*?)(?=\n## )/)?.[1] ?? '';
  return [...section.matchAll(/^\|\s*([1-4])\s*\|\s*([^|]+)\|\s*([^|]+)\|$/gm)]
    .map(match => `${match[1]}:${match[2].trim()}:${match[3].trim()}`);
}

function assertReviewerContract(workflow: string): void {
  const yaml = frontmatter(workflow);
  const tools = yamlBlock(yaml, 'tools');
  const outputs = yamlBlock(yaml, 'safe-outputs');
  const submitReview = yamlBlock(outputs, 'submit-pull-request-review');
  const concurrency = yamlBlock(yaml, 'concurrency');
  const trigger = yamlBlock(yaml, 'on');
  const rows = provenanceRows(workflow);

  expect(tools).not.toMatch(/^\s+edit:/m);
  expect(outputs).not.toMatch(/^\s+(create-issue|create-pull-request|update-pull-request):/m);
  expect(outputs).not.toMatch(/^\s+dispatch-workflow:/m);
  expect(listInBlock(submitReview, 'allowed-events')).toEqual(['COMMENT', 'REQUEST_CHANGES']);
  expect(submitReview).not.toContain('APPROVE');
  expect(concurrency).toContain('cancel-in-progress: true');
  expect(trigger).not.toMatch(/^\s+forks:/m);
  expect(yaml).toContain('github.event.pull_request.head.repo.full_name == github.repository');
  expect(workflow).toContain('Squad-Review-Head: {40-character lowercase head SHA}');
  expect(rows).toEqual([
    '1:One validated durable worker marker:Squad-authored',
    '2:`squad/implement-*` head branch with no marker-like text:Squad-authored fallback',
    '3:Login `copilot-swe-agent[bot]` or `copilot/*` head branch with no marker-like text:Copilot-authored',
    '4:None of the above:Unattributed',
  ]);
  expect(workflow).toMatch(/invalid provenance\. Fail closed with\s+`noop`; do not fall back/);
  expect(workflow).toContain('Every same-repository PR (including');
  expect(workflow).toContain('inlined-imports: true');
  expect(workflow).toContain('await guard.enforceReviewOutputs');
  expect(workflow).toContain('await guard.assertClearingReview');
  expect(workflow).toContain('Human approval remains mandatory.');
}

interface CompiledContract {
  lock: string;
  safeOutputs: Record<string, Record<string, unknown>>;
}

function compileReviewer(workflow = REVIEWER): CompiledContract {
  const workspace = mkdtempSync(resolve(ROOT, '.squad-review-contract-'));
  compileWorkspaces.push(workspace);
  const workflowDir = resolve(workspace, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  cpSync(resolve(ROOT, 'workflows'), workflowDir, { recursive: true });
  writeFileSync(resolve(workflowDir, 'squad-review.md'), workflow);
  execFileSync('git', ['init', '--quiet'], { cwd: workspace });
  execFileSync(
    'gh',
    ['aw', 'compile', 'squad-review', '--strict', '--no-check-update'],
    { cwd: workspace, encoding: 'utf8', stdio: 'pipe', timeout: 60000 },
  );

  const lock = readFileSync(resolve(workflowDir, 'squad-review.lock.yml'), 'utf8').replace(/\r\n/g, '\n');
  const jsonText = extractSafeOutputsConfigJson(lock);
  expect(jsonText, 'compiled reviewer must write a parseable safe-output config').toBeDefined();

  return {
    lock,
    safeOutputs: JSON.parse(jsonText!) as Record<string, Record<string, unknown>>,
  };
}

afterAll(() => {
  for (const workspace of compileWorkspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function assertCompiledGate(lock: string): void {
  const workflow = parse(lock);
  const { jobs } = workflow;
  expect(workflow['run-name']).toBe('Squad review — PR #${{ github.event.inputs.issue_number || github.event.pull_request.number }}');
  const review = jobs.review;
  expect(review.name).toBe("${{ github.event_name == 'pull_request' && 'Squad Review / review' || 'Squad Review / manual' }}");
  expect(review.if).toBe('always()');
  expect(review.needs).toEqual(expect.arrayContaining(['agent', 'safe_outputs']));
  const execution = review.steps.find((step: { name: string }) => step.name === 'Require successful PR review execution');
  expect(execution.run).toContain('test "$AGENT_RESULT" = success');
  expect(execution.run).toContain('test "$OUTPUT_RESULT" = success');
  expect(review.steps.at(-1).with.script).toContain('await guard.assertClearingReview');
  expect(review.steps.at(-1).env.SQUAD_REVIEW_HEAD).toBe('${{ github.event.pull_request.head.sha }}');
  const steps = jobs.safe_outputs.steps;
  const guard = steps.findIndex((step: { name: string }) => step.name === 'Bind review output to committed agent identities and current head');
  const process = steps.findIndex((step: { name: string }) => step.name === 'Process Safe Outputs');
  expect(guard).toBeGreaterThan(-1);
  expect(process).toBeGreaterThan(guard);
  expect(steps[guard].with.script).toContain('await guard.enforceReviewOutputs');
  expect(steps[guard].if).toBeUndefined();
  expect(steps[guard]['continue-on-error']).toBeUndefined();
  const baseCheckout = steps.find((step: { name: string }) =>
    step.name === 'Checkout base commit for review guard');
  const workflowCheckout = steps.find((step: { name: string }) =>
    step.name === 'Checkout workflow commit for first-install review guard');
  expect(baseCheckout.with.ref).toBe('${{ github.event.pull_request.base.sha || github.workflow_sha }}');
  expect(workflowCheckout.with.ref).toBe('${{ github.workflow_sha }}');
  expect(steps[guard].with.script).toContain('if (existsSync(baseGuard))');
  expect(steps[guard].with.script).toContain('else if (!existsSync(baseManifest))');
  expect(steps[guard].with.script).toContain('firstInstall = true');
  expect(steps[guard].with.script).toContain("createHash('sha256')");
  expect(steps[guard].with.script).toContain('workflowGuardSha256');
  expect(steps[guard].with.script).toContain(
    'workflowSource: process.env.GH_AW_WORKFLOW_SOURCE',
  );
  expect(steps[guard].with.script).toContain('missing from an established base installation');
  const finalGate = review.steps.find((step: { name: string }) =>
    step.name === 'Enforce independent current-head verdict');
  expect(finalGate.with.script).toContain('if (existsSync(baseGuard))');
  expect(finalGate.with.script).toContain('else if (!existsSync(baseManifest))');
  expect(finalGate.with.script).toContain('firstInstall = true');
  expect(finalGate.with.script).toContain("createHash('sha256')");
  expect(finalGate.with.script).toContain('workflowGuardSha256');
  expect(finalGate.with.script).toContain('missing from an established base installation');
  for (const step of review.steps) expect(step['continue-on-error']).toBeUndefined();
  expect(review['continue-on-error']).toBeUndefined();
}

function compiledGuardScripts(lock: string): Array<{ name: string; script: string }> {
  const workflow = parse(lock);
  const safeOutputsStep = workflow.jobs.safe_outputs.steps.find((candidate: { name: string }) =>
    candidate.name === 'Bind review output to committed agent identities and current head');
  const finalGateStep = workflow.jobs.review.steps.find((candidate: { name: string }) =>
    candidate.name === 'Enforce independent current-head verdict');
  expect(safeOutputsStep, 'compiled safe_outputs guard step is missing').toBeDefined();
  expect(finalGateStep, 'compiled final verdict guard step is missing').toBeDefined();
  return [
    { name: 'safe outputs', script: safeOutputsStep.with.script },
    { name: 'final verdict', script: finalGateStep.with.script },
  ];
}

async function executeCompiledGuardLoader(
  script: string,
  {
    baseGuard,
    baseManifest = false,
    workflowGuard,
    head = 'a'.repeat(40),
  }: { baseGuard?: string; baseManifest?: boolean; workflowGuard: string; head?: string },
): Promise<string> {
  const workspace = mkdtempSync(resolve(ROOT, '.squad-review-loader-'));
  compileWorkspaces.push(workspace);
  const output = resolve(workspace, 'loaded.txt');
  const guardPath = '.github/workflows/shared/squad-review-guard.mjs';
  if (baseGuard !== undefined) {
    const path = resolve(workspace, '.squad-review-base', guardPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, baseGuard);
  }
  if (baseManifest) {
    const path = resolve(
      workspace,
      '.squad-review-base',
      '.github/aw/squad-workflows.manifest.json',
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}\n');
  }
  const workflowPath = resolve(workspace, '.squad-review-workflow', guardPath);
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(workflowPath, workflowGuard);

  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  const previousOutput = process.env.SQUAD_TEST_GUARD_OUTPUT;
  const previousHead = process.env.SQUAD_REVIEW_HEAD;
  process.env.GITHUB_WORKSPACE = workspace;
  process.env.SQUAD_TEST_GUARD_OUTPUT = output;
  process.env.SQUAD_REVIEW_HEAD = head;
  try {
    const runner = resolve(workspace, 'runner.mjs');
    writeFileSync(runner, `
      import { createRequire } from 'node:module';
      const require = createRequire(import.meta.url);
      const github = { request: async () => ({ data: {} }) };
      ${script.replaceAll('${{ github.workflow_sha }}', head)}
    `);
    await import(`${pathToFileURL(runner).href}?run=${Date.now()}`);
    return readFileSync(output, 'utf8');
  } finally {
    if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previousWorkspace;
    if (previousOutput === undefined) delete process.env.SQUAD_TEST_GUARD_OUTPUT;
    else process.env.SQUAD_TEST_GUARD_OUTPUT = previousOutput;
    if (previousHead === undefined) delete process.env.SQUAD_REVIEW_HEAD;
    else process.env.SQUAD_REVIEW_HEAD = previousHead;
  }
}

function executeCompiledSafeOutputContract(
  script: string,
  scenario: 'clean-install' | 'clean-arbitrary' | 'established-missing' | 'configured',
): { status: number | null; diagnostics: string; output?: string } {
  const workspace = mkdtempSync(resolve(ROOT, '.squad-review-live-contract-'));
  compileWorkspaces.push(workspace);
  const workflowShared = resolve(
    workspace,
    '.squad-review-workflow',
    '.github/workflows/shared',
  );
  mkdirSync(dirname(workflowShared), { recursive: true });
  cpSync(resolve(ROOT, 'workflows/shared'), workflowShared, { recursive: true });
  const guardPath = resolve(workflowShared, 'squad-review-guard.mjs');
  const guardSha256 = createHash('sha256').update(readFileSync(guardPath)).digest('hex');
  if (scenario === 'established-missing' || scenario === 'configured') {
    const baseShared = resolve(workspace, '.squad-review-base', '.github/workflows/shared');
    mkdirSync(dirname(baseShared), { recursive: true });
    cpSync(resolve(ROOT, 'workflows/shared'), baseShared, { recursive: true });
    const manifestPath = resolve(
      workspace,
      '.squad-review-base',
      '.github/aw/squad-workflows.manifest.json',
    );
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, '{}\n');
  }

  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const workflowNames = [
    'squad', 'squad-implement-worker', 'squad-review', 'squad-deps-worker',
    'squad-retro', 'squad-improvement-worker', 'squad-bootstrap', 'squad-command-router',
  ];
  const manifest = {
    schema_version: 1,
    package: 'bradygaster/squad/workflows',
    revision_policy: { kind: 'immutable-git-commit' },
    workflows: workflowNames.map(name => ({
      name,
      destination: `.github/workflows/${name}.md`,
      lock: `.github/workflows/${name}.lock.yml`,
      source_sha256: 'c'.repeat(64),
    })),
    shared_runtime: [{
      path: 'shared/squad-review-guard.mjs',
      destination: '.github/workflows/shared/squad-review-guard.mjs',
      ownership: 'manifest',
      sha256: guardSha256,
    }],
  };
  const required = [
    '.github/aw/squad-workflows.manifest.json',
    '.github/workflows/shared/squad-review-guard.mjs',
    ...workflowNames.flatMap(name => [
      `.github/workflows/${name}.md`,
      `.github/workflows/${name}.lock.yml`,
    ]),
  ];
  const provenance = {
    schemaVersion: 1,
    package: 'bradygaster/squad/workflows',
    source: `bradygaster/squad/workflows@${'c'.repeat(40)}`,
    resolvedCommit: 'c'.repeat(40),
    files: required.map(destination => ({
      destination,
      sha256: destination === '.github/workflows/shared/squad-review-guard.mjs'
        ? guardSha256
        : 'd'.repeat(64),
    })),
  };
  provenance.files.find(entry =>
    entry.destination === '.github/aw/squad-workflows.manifest.json')!.sha256 =
      createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  const outputPath = resolve(workspace, 'agent-output.json');
  writeFileSync(outputPath, JSON.stringify({ items: [{
    type: 'submit_pull_request_review',
    event: 'COMMENT',
    body: 'No blocking installation findings.',
  }] }));
  const runner = resolve(workspace, 'runner.mjs');
  const compiledScript = script.replaceAll('${{ github.workflow_sha }}', head);
  writeFileSync(runner, `
    import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const head = ${JSON.stringify(head)};
    const base = ${JSON.stringify(base)};
    const scenario = ${JSON.stringify(scenario)};
    const encode = value => ({
      type: 'file',
      encoding: 'base64',
      size: 1000,
      content: Buffer.from(JSON.stringify(value)).toString('base64'),
    });
    const attribution = {
      schema: 'squad-review-author/v1',
      repository: 'squad/example',
      issue: 9,
      author_agent: 'implementer',
      reviewer_agent: 'reviewer',
    };
    const registry = {
      schema: 'squad-agent-provenance/v1',
      schema_version: 1,
      agents: {
        implementer: { persistent_name: 'implementer', status: 'active' },
        reviewer: { persistent_name: 'reviewer', status: 'active' },
      },
    };
    const github = {
      request: async (request, fields) => {
        const route = request.replace(/^GET \\//, '');
        if (route.endsWith('/pulls/42')) return { data: {
          number: 42,
          state: 'open',
          merged: false,
          body: '',
          head: { sha: head, ref: 'install-squad', repo: { full_name: 'squad/example' } },
          base: { sha: base, ref: 'dev', repo: { full_name: 'squad/example' } },
        } };
        if (route.endsWith('/contents/.squad-review.json')) {
          if (scenario === 'configured') return { data: encode(attribution) };
          throw Object.assign(new Error('Not Found'), { status: 404 });
        }
        if (route.endsWith('/contents/.squad/casting/registry.json')) {
          return { data: encode(registry) };
        }
        if (route.endsWith('/contents/.github/aw/squad-workflows.manifest.json')) {
          return { data: encode(${JSON.stringify(manifest)}) };
        }
        if (route.endsWith('/contents/.github/aw/packages')) {
          if (scenario === 'clean-arbitrary') return { data: [] };
          return { data: [{
            type: 'file',
            name: 'bradygaster-squad-workflows-3632054824e8.json',
          }] };
        }
        if (route.includes('/contents/.github/aw/packages/')) {
          return { data: encode(${JSON.stringify(provenance)}) };
        }
        if (route.endsWith('/reviews')) return { data: [] };
        throw new Error('Unexpected API route: ' + route + ' ' + JSON.stringify(fields));
      },
    };
    ${compiledScript}
  `);
  const result = spawnSync(process.execPath, [runner], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_WORKSPACE: workspace,
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_REPOSITORY: 'squad/example',
      GITHUB_RUN_ID: '17',
      GITHUB_RUN_ATTEMPT: '1',
      GH_AW_AGENT_OUTPUT: outputPath,
      SQUAD_REVIEW_PR: '42',
      SQUAD_REVIEW_HEAD: head,
      GH_AW_WORKFLOW_SOURCE: `bradygaster/squad/workflows/package/squad-review.md@${'c'.repeat(40)}`,
    },
  });
  return {
    status: result.status,
    diagnostics: `${result.stdout}\n${result.stderr}`,
    output: result.status === 0 ? readFileSync(outputPath, 'utf8') : undefined,
  };
}

describe('gh-aw enforcing Squad reviewer', () => {
  it('routes /squad review to the isolated workflow and supports automatic PR events', () => {
    const routerDispatch = yamlBlock(ROUTER_FRONTMATTER, 'dispatch-workflow');
    const reviewTrigger = yamlBlock(REVIEWER_FRONTMATTER, 'on');
    const relay = ROUTER.match(/## skill: `squad-review-relay`([\s\S]*?)(?=\n## skill:)/)?.[1] ?? '';
    const relayPayload = JSON.parse(relay.match(/```json\n([\s\S]*?)\n```/)?.[1] ?? '{}') as {
      workflow_name?: string;
      inputs?: Record<string, string>;
      issue_number?: string;
    };

    expect(listInBlock(routerDispatch, 'workflows')).toContain('squad-review');
    expect(ROUTER).toContain('| `/squad review` | Review Relay |');
    expect(REVIEWER).not.toContain('slash_command:');
    expect(reviewTrigger).toMatch(/workflow_dispatch:\n\s+inputs:/);
    expect(reviewTrigger).toMatch(/pull_request:\n\s+types: \[opened, reopened, ready_for_review, synchronize\]/);
    expect(relayPayload).toEqual({
      workflow_name: 'squad-review',
      inputs: {
        issue_number: '{pull-request-number}',
        expected_head_sha: '{current-head-sha}',
        request_origin: 'manual',
      },
    });
    expect(relayPayload.issue_number).toBeUndefined();
    expect(relay).not.toContain('"pr_number"');
    expect(relay).toContain('Never call the generic');
  });

  it('limits slash commands to issue and pull request conversation surfaces', () => {
    const slashCommand = yamlBlock(ROUTER_FRONTMATTER, 'slash_command');
    const guideSection = GUIDE.match(/## Slash commands[\s\S]*?(?=\n## Casting a team)/)?.[0] ?? '';

    expect(listInBlock(slashCommand, 'events')).toEqual([
      'issues',
      'issue_comment',
      'pull_request_comment',
    ]);
    expect(slashCommand).not.toContain('pull_request_review_comment');
    expect(ROUTER).toContain('PR conversation comment');
    expect(ROUTER).not.toMatch(/PR review comment|pull request review comment/i);
    expect(guideSection).toContain('PR conversation comment');
    expect(guideSection).toContain('Inline code-review threads do not trigger Squad commands.');
    expect(guideSection).not.toMatch(/PR review comment|pull request review comment/i);
  });

  it('declares the complete native package for the pinned compiler job', () => {
    const manifest = read('workflows/aw.yml');
    expect(manifest).toContain('min-version: v0.89.21');
    expect(manifest.match(/destination: \.github\/workflows\/squad(?:-[\w-]+)?\.md/g)).toHaveLength(8);
    expect(manifest.match(/source: package\/squad(?:-[\w-]+)?\.md/g)).toHaveLength(8);
    expect(manifest).toContain('  - skills/gh-aw-enlistment');
    expect(read('.github/workflows/squad-ci.yml')).toContain(
      'gh extension install --force --pin v0.89.21 github/gh-aw',
    );
  });

  it('detects a missing workflow_dispatch job discriminator during strict compilation', () => {
    const workspace = mkdtempSync(resolve(ROOT, '.squad-review-discriminator-mutation-'));
    compileWorkspaces.push(workspace);
    const workflowDir = resolve(workspace, '.github', 'workflows');
    mkdirSync(workflowDir, { recursive: true });
    cpSync(resolve(ROOT, 'workflows'), workflowDir, { recursive: true });

    const workerPath = resolve(workflowDir, 'squad-deps-worker.md');
    const worker = readFileSync(workerPath, 'utf8').replace(/\r\n/g, '\n');
    expect(worker).toContain('  job-discriminator: ${{ github.run_id }}\n');
    writeFileSync(workerPath, worker.replace('  job-discriminator: ${{ github.run_id }}\n', ''));
    execFileSync('git', ['init', '--quiet'], { cwd: workspace });

    const result = spawnSync(
      'gh',
      ['aw', 'compile', 'squad-deps-worker', '--strict', '--no-check-update', '--no-emit'],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe', timeout: 60000 },
    );
    const diagnostics = `${result.stdout}\n${result.stderr}`;
    expect(result.error, 'failed to launch gh aw for discriminator mutation').toBeUndefined();
    expect(result.status, `mutated workflow must remain compilable:\n${diagnostics}`).toBe(0);
    expect(diagnostics).toContain(
      'workflow_dispatch workflow has no concurrency.job-discriminator',
    );
  }, 20000);

  it('keeps all consumer install surfaces on the isolated native package', () => {
    for (const surface of [GUIDE, README, AGENT_GUIDE, SHARED_BOOTSTRAP]) {
      expect(surface).toContain('bradygaster/squad/workflows@${SQUAD_SHA}');
      expect(surface).not.toMatch(/gh aw add \\\n\s+bradygaster\/squad\/workflows\/squad\.md/);
    }
    expect(DEMO).toContain("gh-aw guide's install command");
    expect(DEMO).not.toContain('gh aw add bradygaster/squad/workflows/squad.md@latest');
  });

  it('documents enforcement, explicit override, and the independent human approval requirement', () => {
    expect(GUIDE).toContain('| Review | `/squad review` |');
    expect(GUIDE).not.toContain('/squad review fix');
    expect(GUIDE).not.toContain('Review lifecycle and current gaps');
    expect(GUIDE).not.toContain('There is no separate `/squad review` command');
    expect(GUIDE).toContain('`ready_for_review` and `synchronize`');
    expect(GUIDE).toContain('`Squad-Review-Head: <SHA>`');
    expect(GUIDE).toContain('`COMMENT`');
    expect(GUIDE).toContain('`REQUEST_CHANGES`');
    expect(GUIDE).toContain('no file-editing, issue-creation,');
    expect(GUIDE).toContain('Human approval remains mandatory.');
    expect(GUIDE).toContain('Squad Review / review');
    expect(GUIDE).toContain('Squad-Review-Override:');
    expect(GUIDE.replace(/\s+/g, ' ')).toContain('only after advisory soak');
    expect(GUIDE).toContain('This follow-up is only needed when the safe-update warning appears.');
    expect(README).toContain('`gh aw add` compiles the workflows automatically.');
    expect(README).toContain('run `gh aw compile --approve`');
  });

  it('enforces attribution priority and refuses malformed or unattributed automatic provenance', () => {
    expect(REVIEWER).toContain(
      '^<!-- squad:implement issue=([1-9][0-9]*) run=([1-9][0-9]*) -->$',
    );
    expect(REVIEWER).toContain('require exactly one marker-like occurrence');
    expect(REVIEWER).toContain('^squad/implement-{captured-issue}-');
    assertReviewerContract(REVIEWER);
  });

  it('keeps reviewer authority read-only with bounded non-approval verdicts', () => {
    const safeOutputs = yamlBlock(REVIEWER_FRONTMATTER, 'safe-outputs');
    const outputNames = [...safeOutputs.matchAll(/^  ([\w-]+):\s*$/gm)].map(match => match[1]);

    expect(outputNames).toEqual([
      'steps',
      'add-comment',
      'create-pull-request-review-comment',
      'submit-pull-request-review',
    ]);
    expect(REVIEWER).toContain('Never use `APPROVE`');
    assertReviewerContract(REVIEWER);
  });

  it('deduplicates by head SHA, cancels stale runs, and retains fork protection', () => {
    const concurrency = yamlBlock(REVIEWER_FRONTMATTER, 'concurrency');

    expect(concurrency).toContain(
      'group: "squad-review-${{ github.event.inputs.issue_number || github.event.pull_request.number || github.run_id }}"',
    );
    expect(concurrency).toContain('cancel-in-progress: true');
    expect(REVIEWER_FRONTMATTER).not.toMatch(/^\s+forks:/m);
    expect(REVIEWER).toContain('If an existing bot review contains a `Squad-Review-Verdict:` record');
    expect(REVIEWER).toContain('Never re-review an unchanged head');
    expect(REVIEWER).toContain('Re-fetch the pull request immediately before emitting');
  });

  it('covers acceptance, routing, protected files, tests, and changesets', () => {
    for (const requirement of [
      'acceptance criteria',
      '.squad/routing.md',
      'charter named by any `squad:{member}` issue label',
      'protected-file and implementation allowlist policy',
      'changed behavior has focused tests',
      'packages/*/src/',
      '.changeset/*.md',
    ]) {
      expect(REVIEWER).toContain(requirement);
    }
  });

  it('strict-compiles to read-only agent permissions and an always-running final gate', () => {
    const { lock, safeOutputs } = compileReviewer();
    assertCompiledGate(lock);
    const agentJob = lock.match(/^  agent:\n([\s\S]*?)(?=^  [\w-]+:\n)/m)?.[1] ?? '';
    const permissionBlock = yamlBlock(agentJob, 'permissions');

    expect(permissionBlock).toContain('contents: read');
    expect(permissionBlock).toContain('issues: read');
    expect(permissionBlock).toContain('pull-requests: read');
    expect(permissionBlock).toContain('copilot-requests: write');
    expect(permissionBlock).not.toMatch(/^\s+(contents|issues|pull-requests): write$/m);
    expect(safeOutputs.add_comment).toMatchObject({ max: 1 });
    expect(safeOutputs.create_pull_request_review_comment).toMatchObject({ max: 10 });
    expect(safeOutputs.submit_pull_request_review).toMatchObject({
      max: 1,
      allowed_events: ['COMMENT', 'REQUEST_CHANGES'],
      commit_id: '${{ github.event.pull_request.head.sha || github.event.inputs.expected_head_sha }}',
    });
    expect(safeOutputs).not.toHaveProperty('dispatch_workflow');
    expect(safeOutputs).not.toHaveProperty('create_issue');
    expect(safeOutputs).not.toHaveProperty('create_pull_request');
    expect(lock).toContain('GH_AW_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
  }, 30000);

  it('executes the compiled first-install fallback without weakening established base control', async () => {
    const { lock } = compileReviewer();
    const stub = (source: string) => `
      import { writeFileSync } from 'node:fs';
      export async function enforceReviewOutputs(env, get, options) {
        writeFileSync(process.env.SQUAD_TEST_GUARD_OUTPUT,
          JSON.stringify({ source: ${JSON.stringify(source)}, operation: 'safe outputs',
            head: env.SQUAD_REVIEW_HEAD, options }));
      }
      export async function assertClearingReview(env, get, options) {
        writeFileSync(process.env.SQUAD_TEST_GUARD_OUTPUT,
          JSON.stringify({ source: ${JSON.stringify(source)}, operation: 'final verdict',
            head: env.SQUAD_REVIEW_HEAD, options }));
      }
    `;

    for (const { name, script } of compiledGuardScripts(lock)) {
      const head = name === 'safe outputs'
        ? 'edd6fbf0f84334ff086ed2bc8bbfed5503fdd56f'
        : '9a898b5182ca432b62bef26dbf1f9022dd1d256b';
      const workflowGuard = stub('workflow');
      const workflowGuardSha256 = createHash('sha256').update(workflowGuard).digest('hex');
      await expect(executeCompiledGuardLoader(script, {
        workflowGuard,
        head,
      })).resolves.toBe(JSON.stringify({
        source: 'workflow',
        operation: name,
        head,
        options: { firstInstall: true, workflowSha: head, workflowGuardSha256 },
      }));

      await expect(executeCompiledGuardLoader(script, {
        baseGuard: stub('base'),
        baseManifest: true,
        workflowGuard,
        head,
      })).resolves.toBe(JSON.stringify({
        source: 'base',
        operation: name,
        head,
        options: { firstInstall: false, workflowSha: head },
      }));

      await expect(executeCompiledGuardLoader(script, {
        baseManifest: true,
        workflowGuard,
        head,
      })).rejects.toThrow(
        'Squad Review guard is missing from an established base installation. Refusing workflow-source fallback.',
      );

      await expect(executeCompiledGuardLoader(script, {
        baseGuard: 'this is not valid JavaScript',
        baseManifest: true,
        workflowGuard,
        head,
      })).rejects.toThrow();
    }
  }, 30000);

  it('executes the live compiled identity contract for install and established reviews', () => {
    const { lock } = compileReviewer();
    const safeOutputScript = compiledGuardScripts(lock)
      .find(candidate => candidate.name === 'safe outputs')!.script;

    const cleanInstall = executeCompiledSafeOutputContract(safeOutputScript, 'clean-install');
    expect(cleanInstall.status, cleanInstall.diagnostics).toBe(0);
    const cleanOutput = JSON.parse(cleanInstall.output!);
    expect(cleanOutput.items[0].body).toContain(
      '"author_agent":"@squad/bootstrap-installation"',
    );
    expect(cleanOutput.items[0].body).toContain(
      '"reviewer_agent":"@squad/bootstrap-review-workflow"',
    );

    const configured = executeCompiledSafeOutputContract(safeOutputScript, 'configured');
    expect(configured.status, configured.diagnostics).toBe(0);
    const configuredOutput = JSON.parse(configured.output!);
    expect(configuredOutput.items[0].body).toContain('"author_agent":"implementer"');
    expect(configuredOutput.items[0].body).toContain('"reviewer_agent":"reviewer"');

    const establishedMissing = executeCompiledSafeOutputContract(
      safeOutputScript,
      'established-missing',
    );
    expect(establishedMissing.status).not.toBe(0);
    expect(establishedMissing.diagnostics).toContain('Not Found');

    const arbitraryClean = executeCompiledSafeOutputContract(safeOutputScript, 'clean-arbitrary');
    expect(arbitraryClean.status).not.toBe(0);
    expect(arbitraryClean.diagnostics).toContain(
      'missing or duplicate first-install package provenance',
    );
  }, 30000);

  it('kills mutations of every important authority and provenance gate', () => {
    const mutations = [
      REVIEWER.replace('tools:\n  bash:', 'tools:\n  edit:\n  bash:'),
      REVIEWER.replace(
        'safe-outputs:\n',
        'safe-outputs:\n  dispatch-workflow:\n    workflows: [squad-retro]\n    max: 1\n',
      ),
      REVIEWER.replace('allowed-events: [COMMENT, REQUEST_CHANGES]', 'allowed-events: [COMMENT, APPROVE]'),
      REVIEWER.replace('cancel-in-progress: true', 'cancel-in-progress: false'),
      REVIEWER.replace(
        'github.event.pull_request.head.repo.full_name == github.repository',
        'github.event.pull_request.head.repo.full_name != github.repository',
      ),
      REVIEWER.replace(
        '| 1 | One validated durable worker marker | Squad-authored |',
        '| 1 | `squad/implement-*` head branch with no marker-like text | Squad-authored fallback |',
      ),
      REVIEWER.replace('invalid provenance. Fail closed with', 'invalid provenance. Continue with'),
      REVIEWER.replace('Every same-repository PR (including', 'Some PRs (including'),
      REVIEWER.replace('inlined-imports: true', 'inlined-imports: false'),
      REVIEWER.replaceAll('Squad-Review-Head: {40-character lowercase head SHA}', 'Reviewed head SHA'),
    ];

    for (const mutation of mutations) {
      expect(() => assertReviewerContract(mutation)).toThrow();
    }
  });

  it('kills real source mutations after compilation, not just prompt-text mutations', () => {
    assertCompiledGate(compileReviewer().lock);
    const mutations = [
      REVIEWER.replace('await guard.enforceReviewOutputs', 'void guard.enforceReviewOutputs'),
      REVIEWER.replace('await guard.assertClearingReview', 'void guard.assertClearingReview'),
      REVIEWER.replace("&& 'Squad Review / review'", "&& 'Other check'"),
      REVIEWER.replace('    if: always()\n', '    if: success()\n'),
      REVIEWER.replace('    needs: [agent, safe_outputs]', '    needs: [agent]'),
    ];
    for (const mutation of mutations) {
      expect(mutation).not.toBe(REVIEWER);
      const { lock } = compileReviewer(mutation);
      expect(() => assertCompiledGate(lock)).toThrow();
    }
  }, 60000);
});
