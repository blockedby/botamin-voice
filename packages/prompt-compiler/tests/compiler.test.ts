import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import {
  BOOKING_ORDER_SENTENCE,
  compilePromptBundle,
  MAX_FILE_BYTES,
  PROMPT_ORDER,
} from '../src/index.js';

const sourceRoot = resolve(process.cwd(), '..', '..');
const temporaryPaths: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

async function fixtureRoot(
  transform?: (relativePath: string, source: Buffer) => string | Buffer,
): Promise<string> {
  const root = await temporaryDirectory('botamin-prompt-source-');
  for (const relativePath of PROMPT_ORDER) {
    const target = join(root, relativePath);
    const source = await readFile(join(sourceRoot, relativePath));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, transform?.(relativePath, source) ?? source);
  }
  return root;
}

async function runtimeDirectory(): Promise<string> {
  return temporaryDirectory('botamin-prompt-runtime-');
}

after(async () => {
  await Promise.all(
    temporaryPaths.map(async (path) => {
      await chmod(path, 0o700).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
    }),
  );
});

test('compiles in fixed order with stable exact-byte hash and read-only isolated output', async () => {
  const firstRuntime = await runtimeDirectory();
  const secondRuntime = await runtimeDirectory();
  const first = await compilePromptBundle({ sourceRoot, runtimeDir: firstRuntime });
  const second = await compilePromptBundle({ sourceRoot, runtimeDir: secondRuntime });
  const bytes = await readFile(first.outputPath);

  assert.match(first.promptVersion, /^[a-f0-9]{64}$/);
  assert.equal(first.promptVersion, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(second.promptVersion, first.promptVersion);
  assert.deepEqual(await readFile(second.outputPath), bytes);
  assert.deepEqual(first.files, PROMPT_ORDER);
  assert.equal((await stat(first.outputPath)).mode & 0o777, 0o444);
  assert.deepEqual(await readdir(firstRuntime), ['AGENTS.md']);

  let previousIndex = -1;
  const output = bytes.toString('utf8');
  for (const relativePath of PROMPT_ORDER) {
    const index = output.indexOf(`<!-- BEGIN ${relativePath} -->`);
    assert.ok(index > previousIndex, `${relativePath} must follow the fixed order`);
    previousIndex = index;
  }
});

test('normalizes CRLF and a missing final newline before hashing', async () => {
  const normalizedFixture = await fixtureRoot();
  const windowsFixture = await fixtureRoot((_path, source) =>
    source.toString('utf8').trimEnd().replace(/\n/g, '\r\n'),
  );
  const normalized = await compilePromptBundle({
    sourceRoot: normalizedFixture,
    runtimeDir: await runtimeDirectory(),
  });
  const windows = await compilePromptBundle({
    sourceRoot: windowsFixture,
    runtimeDir: await runtimeDirectory(),
  });
  assert.equal(windows.promptVersion, normalized.promptVersion);
});

test('fails for a missing required source file', async () => {
  const fixture = await fixtureRoot();
  await rm(join(fixture, PROMPT_ORDER[1]));
  await assert.rejects(
    compilePromptBundle({ sourceRoot: fixture, runtimeDir: await runtimeDirectory() }),
    /missing required file: prompts\/product\.md/i,
  );
});

test('fails for changed headings or heading levels', async () => {
  const renamedHeading = await fixtureRoot((relativePath, source) =>
    relativePath === 'prompts/product.md'
      ? source.toString('utf8').replace('## Value selection', '## Unexpected heading')
      : source,
  );
  await assert.rejects(
    compilePromptBundle({ sourceRoot: renamedHeading, runtimeDir: await runtimeDirectory() }),
    /unexpected headings.*heading order/i,
  );

  const wrongLevel = await fixtureRoot((relativePath, source) =>
    relativePath === 'prompts/product.md'
      ? source.toString('utf8').replace('## Value selection', '### Value selection')
      : source,
  );
  await assert.rejects(
    compilePromptBundle({ sourceRoot: wrongLevel, runtimeDir: await runtimeDirectory() }),
    /unexpected headings.*heading levels/i,
  );
});

test('enforces per-file and compiled-bundle size limits', async () => {
  const oversizedFile = await fixtureRoot((relativePath, source) =>
    relativePath === 'prompts/system.md'
      ? `${source.toString('utf8')}\n${'x'.repeat(MAX_FILE_BYTES)}`
      : source,
  );
  await assert.rejects(
    compilePromptBundle({ sourceRoot: oversizedFile, runtimeDir: await runtimeDirectory() }),
    /exceeds .* bytes/i,
  );

  const oversizedBundle = await fixtureRoot(
    (_relativePath, source) => `${source.toString('utf8')}\n${'x'.repeat(9_000)}`,
  );
  await assert.rejects(
    compilePromptBundle({ sourceRoot: oversizedBundle, runtimeDir: await runtimeDirectory() }),
    /compiled bundle exceeds/i,
  );
});

test('rejects invalid UTF-8, secret-like assignments, and numeric currency prices', async () => {
  const invalidUtf8 = await fixtureRoot();
  await writeFile(join(invalidUtf8, 'prompts/system.md'), Buffer.from([0xff, 0xfe]));
  await assert.rejects(
    compilePromptBundle({ sourceRoot: invalidUtf8, runtimeDir: await runtimeDirectory() }),
    /valid UTF-8/i,
  );

  const secret = await fixtureRoot((relativePath, source) =>
    relativePath === 'prompts/system.md'
      ? `${source.toString('utf8')}\n${['XAI_API_', 'KEY=not-a-real-key'].join('')}`
      : source,
  );
  await assert.rejects(
    compilePromptBundle({ sourceRoot: secret, runtimeDir: await runtimeDirectory() }),
    /secret-like pattern/i,
  );

  const price = await fixtureRoot((relativePath, source) =>
    relativePath === 'prompts/product.md' ? `${source.toString('utf8')}\nPrice: $100` : source,
  );
  await assert.rejects(
    compilePromptBundle({ sourceRoot: price, runtimeDir: await runtimeDirectory() }),
    /numeric currency price/i,
  );
});

test('requires the booking-before-qualification rule in system and booking prompts', async () => {
  for (const relativePath of ['prompts/system.md', 'prompts/booking.md']) {
    const fixture = await fixtureRoot((path, source) =>
      path === relativePath ? source.toString('utf8').replace(BOOKING_ORDER_SENTENCE, '') : source,
    );
    await assert.rejects(
      compilePromptBundle({ sourceRoot: fixture, runtimeDir: await runtimeDirectory() }),
      new RegExp(`${relativePath.replace(/[./]/g, '\\$&')}.*booking-order sentence`, 'i'),
    );
  }
});

test('rejects source file and source-directory symlinks', async () => {
  const fileFixture = await fixtureRoot();
  const systemPath = join(fileFixture, 'prompts/system.md');
  await rm(systemPath);
  await symlink(join(sourceRoot, 'prompts/system.md'), systemPath);
  await assert.rejects(
    compilePromptBundle({ sourceRoot: fileFixture, runtimeDir: await runtimeDirectory() }),
    /regular file, not a symlink/i,
  );

  const directoryFixture = await fixtureRoot();
  await rm(join(directoryFixture, 'prompts'), { recursive: true });
  await symlink(join(sourceRoot, 'prompts'), join(directoryFixture, 'prompts'));
  await assert.rejects(
    compilePromptBundle({ sourceRoot: directoryFixture, runtimeDir: await runtimeDirectory() }),
    /source directory.*not a symlink/i,
  );
});

test('refuses source-contained, symlinked, or contaminated runtime directories', async () => {
  const fixture = await fixtureRoot();
  await assert.rejects(
    compilePromptBundle({ sourceRoot: fixture, runtimeDir: join(fixture, 'runtime') }),
    /outside the source repository/i,
  );

  const contaminated = await runtimeDirectory();
  await writeFile(join(contaminated, 'unexpected.txt'), 'x');
  await assert.rejects(
    compilePromptBundle({ sourceRoot: fixture, runtimeDir: contaminated }),
    /unexpected contents or symlinks/i,
  );

  const symlinkTarget = await runtimeDirectory();
  const symlinkParent = await runtimeDirectory();
  const runtimeSymlink = join(symlinkParent, 'runtime-link');
  await symlink(symlinkTarget, runtimeSymlink);
  await assert.rejects(
    compilePromptBundle({ sourceRoot: fixture, runtimeDir: runtimeSymlink }),
    /runtime directory path must not contain symlinks/i,
  );

  const linkedAgentsRuntime = await runtimeDirectory();
  await symlink(join(sourceRoot, 'prompts/system.md'), join(linkedAgentsRuntime, 'AGENTS.md'));
  await assert.rejects(
    compilePromptBundle({ sourceRoot: fixture, runtimeDir: linkedAgentsRuntime }),
    /unexpected contents or symlinks/i,
  );

  const linkedParent = await runtimeDirectory();
  const parentAlias = join(linkedParent, 'source-alias');
  await symlink(fixture, parentAlias);
  await assert.rejects(
    compilePromptBundle({ sourceRoot: fixture, runtimeDir: join(parentAlias, 'runtime') }),
    /runtime directory path must not contain symlinks/i,
  );
});

test('CLI emits metadata only and writes the same output contract', async () => {
  const runtime = await runtimeDirectory();
  const cliPath = resolve(process.cwd(), 'dist/src/cli.js');
  const result = spawnSync(
    process.execPath,
    [cliPath, '--source-root', sourceRoot, '--runtime-dir', runtime],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const metadata = JSON.parse(result.stdout) as {
    promptVersion: string;
    outputPath: string;
    outputBytes: number;
    files: string[];
  };
  assert.match(metadata.promptVersion, /^[a-f0-9]{64}$/);
  assert.equal(metadata.outputPath, join(runtime, 'AGENTS.md'));
  assert.deepEqual(metadata.files, PROMPT_ORDER);
  assert.ok(metadata.outputBytes > 0);
  assert.doesNotMatch(result.stdout, /Identity and hard boundaries/);
  assert.deepEqual(await readdir(runtime), ['AGENTS.md']);
  assert.equal((await lstat(join(runtime, 'AGENTS.md'))).isFile(), true);
});

test('every numeric published case claim has a named source context', async () => {
  const cases = await readFile(join(sourceRoot, 'knowledge/cases.md'), 'utf8');
  const numericClaimSections = cases
    .split(/^### /mu)
    .filter((section) => /\*\*Source claim:\*\*[\s\S]*?(?:\d[\d ]*%|\d[\d ]{2,})/u.test(section));

  assert.equal(numericClaimSections.length, 4);
  for (const section of numericClaimSections) {
    assert.match(section, /\*\*Named source context:\*\*[^\n]+/u);
    assert.match(section, /\*\*Required attribution:\*\*[^\n]+/u);
    assert.match(section, /опубликованн(?:ом|ый) кейс/u);
  }
});
