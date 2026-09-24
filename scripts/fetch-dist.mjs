#!/usr/bin/env bun
/**
 * Fetch the Moggi distribution this extension runs against.
 *
 * The compiler is a separate repository and ships as an archive — the `bin/moggi`
 * launcher, `bin/moggi.phar`, the standard library and a bundled PHP runtime — so
 * neither the end-to-end test nor CI needs a compiler checkout or a PHP of its
 * own: both download a release and drive its launcher.
 *
 * Usage:
 *   bun scripts/fetch-dist.mjs [--version 0.1.0-alpha] [--url <archive>] [--cache <dir>] [--force]
 *   MOGGI_COMPILER_VERSION overrides the version, MOGGI_DIST_URL an archive URL
 *   (used for development builds, which have no version to pin).
 *
 * The launcher path is the only thing written to stdout; progress goes to stderr,
 * so `launcher="$(bun scripts/fetch-dist.mjs)"` works.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The compiler release this extension is built and tested against. Bump it when
 * the extension needs a newer compiler; everything else follows from here.
 */
export const COMPILER_VERSION = '0.1.0-alpha';

const REPO = 'moggi-lang/moggi';
const VARIANT = 'moggi-php';
export const LAUNCHER_NAME = process.platform === 'win32' ? 'moggi.exe' : 'moggi';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
  'linux-x86_64',
  'linux-aarch64',
  'macos-x86_64',
  'macos-aarch64',
  'windows-x86_64',
  'windows-aarch64',
];

/** The compiler's target name for the machine this runs on. */
export function hostTarget() {
  const os = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
  const target = `${os}-${arch ?? process.arch}`;
  if (!TARGETS.includes(target)) {
    throw new Error(`no Moggi distribution is built for ${process.platform}/${process.arch}`);
  }
  return target;
}

export function archiveExtension(target) {
  return target.startsWith('windows-') ? 'zip' : 'tar.gz';
}

export function assetName(version, target) {
  return `${VARIANT}-${version}-${target}.${archiveExtension(target)}`;
}

export function releaseAssetUrl(version, file) {
  return `https://github.com/${REPO}/releases/download/${encodeURIComponent(version)}/${file}`;
}

function isLauncher(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return process.platform === 'win32' && fs.existsSync(file);
  }
}

/** `<dir>/bin/moggi`, or `<dir>` holding it one level down (the archive's top level). */
export function findLauncher(dir, depth = 3) {
  const direct = path.join(dir, 'bin', LAUNCHER_NAME);
  if (isLauncher(direct)) {
    return direct;
  }
  if (depth <= 0 || !fs.existsSync(dir)) {
    return undefined;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const found = findLauncher(path.join(dir, entry.name), depth - 1);
    if (found) {
      return found;
    }
  }
  return undefined;
}

async function get(url, { token = false, optional = false } = {}) {
  const headers = token && process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok) {
    if (optional) {
      return undefined;
    }
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** The release's `SHA256SUMS`, honored when it is there (development builds have none). */
function checksumOf(sums, file) {
  for (const line of sums.toString('utf8').split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match && path.basename(match[2]) === file) {
      return match[1];
    }
  }
  return undefined;
}

/**
 * A release asset is named after the variant, version and target. The release
 * carries every variant, so the name is matched exactly rather than by suffix —
 * `moggi-` and `moggi-php-` both end in `-linux-x86_64.tar.gz`.
 */
async function assetUrl(version, target) {
  const file = assetName(version, target);
  const release = await get(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(version)}`, {
    token: true,
    optional: true,
  });
  if (release === undefined) {
    return releaseAssetUrl(version, file);
  }
  const assets = JSON.parse(release.toString('utf8')).assets ?? [];
  const match = assets.find((asset) => asset.name === file)
    ?? assets.find((asset) => asset.name.startsWith(`${VARIANT}-`)
      && asset.name.endsWith(`-${target}.${archiveExtension(target)}`));
  if (!match) {
    throw new Error(`release ${version} has no ${VARIANT} archive for ${target} (${file})`);
  }
  return match.browser_download_url;
}

function extract(archive, dir) {
  const attempts = archive.endsWith('.zip')
    ? [
        ['unzip', ['-o', '-q', archive, '-d', dir]],
        ['tar', ['-xf', archive, '-C', dir]],
      ]
    : [['tar', ['-xzf', archive, '-C', dir]]];
  let last;
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { stdio: 'inherit' });
    if (result.error) {
      last = result.error;
      continue;
    }
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
    }
    return;
  }
  throw new Error(`cannot unpack ${path.basename(archive)}: ${last ? last.message : 'no archiver worked'}`);
}

/** An archive cannot carry the executable bit on Windows, so it is set after unpacking. */
function makeExecutable(dir) {
  if (process.platform === 'win32') {
    return;
  }
  for (const rel of ['bin', path.join('runtime', 'php', 'bin')]) {
    const at = path.join(dir, rel);
    if (!fs.existsSync(at)) {
      continue;
    }
    for (const name of fs.readdirSync(at)) {
      try {
        fs.chmodSync(path.join(at, name), 0o755);
      } catch {
        // A directory or an already-removed entry: nothing to do.
      }
    }
  }
}

/**
 * Download and unpack a distribution, and return the absolute path of its
 * launcher. An already-unpacked copy is reused unless `force` is set.
 */
export async function fetchDistribution({
  version = COMPILER_VERSION,
  url = '',
  cacheRoot = path.join(pluginRoot, '.dist'),
  force = false,
  log = () => {},
} = {}) {
  const target = hostTarget();
  const cacheDir = url ? path.join(cacheRoot, 'url') : path.join(cacheRoot, version, target);
  // A release is immutable, so its unpacked copy is kept. A URL is not: a dev
  // build moves, so what it points at is fetched again every time.
  if (!force && url === '') {
    const cached = findLauncher(cacheDir);
    if (cached) {
      log(`using the cached distribution at ${cached}`);
      return cached;
    }
  }

  const download = url || (await assetUrl(version, target));
  const archive = path.join(cacheDir, path.basename(new URL(download).pathname) || assetName(version, target));

  log(`${url ? 'fetching' : `fetching Moggi ${version}`} (${target})`);
  log(`  ${download}`);
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  let bytes;
  try {
    bytes = await get(download);
  } catch (error) {
    throw new Error(
      url
        ? `cannot download ${download}: ${error.message}`
        : `cannot download ${download}: ${error.message} — is release ${version} published with a ${target} archive?`,
    );
  }
  fs.writeFileSync(archive, bytes);
  log(`  ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);

  if (!url) {
    const sums = await get(releaseAssetUrl(version, 'SHA256SUMS'), { optional: true });
    const expected = sums ? checksumOf(sums, path.basename(archive)) : undefined;
    if (expected) {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== expected) {
        fs.rmSync(cacheDir, { recursive: true, force: true });
        throw new Error(`${path.basename(archive)} does not match SHA256SUMS (${actual})`);
      }
      log('  checksum matches SHA256SUMS');
    }
  }

  extract(archive, cacheDir);
  fs.rmSync(archive, { force: true });
  const launcher = findLauncher(cacheDir);
  if (!launcher) {
    throw new Error(`the archive carries no ${LAUNCHER_NAME} launcher`);
  }
  makeExecutable(path.dirname(path.dirname(launcher)));
  if (!isLauncher(launcher)) {
    throw new Error(`${launcher} is not executable`);
  }
  log(`  unpacked ${launcher}`);

  return launcher;
}

function parseArgs(argv) {
  const options = { force: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--version' || arg === '--url' || arg === '--cache') {
      const value = argv[++index];
      if (value === undefined) {
        throw new Error(`${arg} needs a value`);
      }
      options[arg === '--version' ? 'version' : arg === '--url' ? 'url' : 'cacheRoot'] = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stderr.write('usage: bun scripts/fetch-dist.mjs [--version <tag>] [--url <archive>] [--cache <dir>] [--force]\n');
      process.exit(0);
    }
    throw new Error(`unknown option ${arg}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const launcher = await fetchDistribution({
      ...options,
      version: options.version ?? process.env.MOGGI_COMPILER_VERSION ?? COMPILER_VERSION,
      url: options.url ?? process.env.MOGGI_DIST_URL ?? '',
      log: (message) => process.stderr.write(message + '\n'),
    });
    process.stdout.write(launcher + '\n');
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  }
}
