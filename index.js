#!/usr/bin/env node

require('dotenv').config();

const axios = require('axios').default;
const chokidar = require('chokidar');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

const BUILTIN_IGNORE_PATTERNS = [
  'node_modules/',
  'dist/',
  'build/',
  'logs/',
  'tmp/',
  'backup/',
  'cache/',
  '.cache/',
  'coverage/',
  'data/',
  '.env',
  '.env.*',
  '*.log',
  '*.tmp',
  '*.sqlite',
  '*.db',
  '*.tar',
  '*.zip',
  '*.tgz',
  '*.gz',
  '__pycache__/',
  '.DS_Store'
];

const DEFAULT_IGNORE_CONFIG_PATH = process.env.IGNORE_CONFIG_PATH
  ? path.resolve(process.env.IGNORE_CONFIG_PATH)
  : path.join(__dirname, 'ignoreconfig.json');
let cachedIgnorePatterns = null;
let ignoreDirectorySegments = new Set(['.git']);

const PRIMARY_PROJECT_ROOT = resolveProjectsRoot();
const ADDITIONAL_PROJECT_ROOTS = resolveAdditionalProjectRoots(PRIMARY_PROJECT_ROOT);

const CONFIG = {
  baseUrl: getBaseUrl(),
  token: process.env.GITEA_TOKEN,
  owner: process.env.GITEA_OWNER || 'autosync',
  projectsRoot: PRIMARY_PROJECT_ROOT,
  additionalProjectRoots: ADDITIONAL_PROJECT_ROOTS,
  syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES || '0'),
  debounceMs: Number(process.env.SYNC_DEBOUNCE_MS || '5000')
};

CONFIG.projectRoots = Array.from(new Set([CONFIG.projectsRoot, ...CONFIG.additionalProjectRoots]));

const API = axios.create({
  baseURL: `${CONFIG.baseUrl}/api/v1`,
  headers: {
    Authorization: `token ${CONFIG.token}`,
    'Content-Type': 'application/json'
  },
  timeout: 15000
});

const REMOTE_NAME = 'gitea';
const ASKPASS_SCRIPT_PATH = path.join(os.tmpdir(), `gitea-askpass-${Date.now()}.sh`);
const pendingProjects = new Set();
let flushTimer = null;
let queueProcessing = false;
let quickSyncChain = Promise.resolve();
let fullSyncPromise = null;

function getBaseUrl() {
  const fallback = 'https://gitea.example.com';
  const value = process.env.GITEA_BASE_URL || fallback;
  return value.replace(/\/+$/, '');
}

function resolveProjectsRoot() {
  const fallback = path.resolve(process.cwd(), 'projects');
  const value = process.env.PROJECTS_ROOT || fallback;
  return path.resolve(value);
}

function resolveAdditionalProjectRoots(primaryRoot) {
  const roots = new Set();
  const envValue = process.env.PROJECTS_ADDITIONAL_ROOTS || '';
  if (envValue.trim().length > 0) {
    envValue
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .forEach((entry) => {
        roots.add(path.resolve(entry));
      });
  } else {
    const archiveCandidate = path.resolve(primaryRoot, '..', 'projects_archive');
    if (archiveCandidate !== primaryRoot && fsSync.existsSync(archiveCandidate)) {
      roots.add(archiveCandidate);
    }
  }
  return Array.from(roots).filter((root) => root !== primaryRoot);
}

async function main() {
  validateConfig();
  await ensureAskPassScript();
  await getIgnorePatterns();
  await ensureProjectRootsExist();

  const args = process.argv.slice(2);
  const watchMode = args.includes('--watch');

  await runFullSync();

  const intervalMs = CONFIG.syncIntervalMinutes > 0
    ? CONFIG.syncIntervalMinutes * 60 * 1000
    : null;

  if (watchMode) {
    const watcher = startWatcher();
    if (intervalMs) {
      console.log(`Watching for changes and running a full resync every ${CONFIG.syncIntervalMinutes} minute(s).`);
      setInterval(() => {
        runFullSync().catch((error) => {
          console.error(`Scheduled run failed: ${error.message}`);
        });
      }, intervalMs);
    } else {
      console.log('Watching for filesystem changes (no scheduled full resync configured).');
    }

    const shutdown = async () => {
      try {
        await watcher.close();
      } catch (error) {
        console.error(`Error closing watcher: ${error.message}`);
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } else if (intervalMs) {
    console.log(`Running initial sync and scheduling subsequent runs every ${CONFIG.syncIntervalMinutes} minute(s).`);
    setInterval(() => {
      runFullSync().catch((error) => {
        console.error(`Scheduled run failed: ${error.message}`);
      });
    }, intervalMs);
  }
}

function validateConfig() {
  if (!CONFIG.token) {
    console.error('Missing GITEA_TOKEN. Please copy .env.example to .env and fill in the token.');
    process.exit(1);
  }
}

async function ensureProjectRootsExist() {
  for (const root of CONFIG.projectRoots) {
    try {
      await fs.mkdir(root, { recursive: true });
    } catch (error) {
      console.error(`Failed to ensure project root ${root}: ${error.message}`);
    }
  }
}

async function ensureAskPassScript() {
  const script = `#!/bin/sh
case "$1" in
  *Username*) echo "${CONFIG.owner}" ;;
  *) echo "${CONFIG.token}" ;;
esac
`;
  await fs.writeFile(ASKPASS_SCRIPT_PATH, script, { mode: 0o700 });
}

async function discoverProjectDirectories(rootDir) {
  let entries;
  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(rootDir, entry.name));
}

async function runFullSync() {
  if (fullSyncPromise) {
    return fullSyncPromise;
  }

  fullSyncPromise = (async () => {
    for (const rootDir of CONFIG.projectRoots) {
      const projectDirs = await discoverProjectDirectories(rootDir);
      for (const projectPath of projectDirs) {
        await syncProject(projectPath).catch((error) => {
          console.error(`[${path.basename(projectPath)}] ERROR: ${error.message}`);
        });
      }
    }
  })();

  try {
    await fullSyncPromise;
  } finally {
    fullSyncPromise = null;
  }
}

function startWatcher() {
  const watchTargets = CONFIG.projectRoots.slice();
  if (DEFAULT_IGNORE_CONFIG_PATH) {
    watchTargets.push(DEFAULT_IGNORE_CONFIG_PATH);
  }

  const uniqueTargets = Array.from(new Set(watchTargets.map((target) => path.resolve(target))));

  const watcher = chokidar.watch(uniqueTargets, {
    persistent: true,
    ignoreInitial: true,
    ignored: (target) => shouldIgnorePath(target)
  });

  watcher.on('all', (event, filePath) => {
    handleWatchEvent(event, filePath).catch((error) => {
      console.error(`Watcher handling error: ${error.message}`);
    });
  });

  watcher.on('error', (error) => {
    console.error(`Watcher error: ${error.message}`);
  });

  return watcher;
}

async function handleWatchEvent(event, filePath) {
  const absolutePath = path.resolve(filePath);
  if (DEFAULT_IGNORE_CONFIG_PATH && absolutePath === DEFAULT_IGNORE_CONFIG_PATH) {
    console.log('Ignore configuration changed, reloading patterns.');
    cachedIgnorePatterns = null;
    await getIgnorePatterns();
    runFullSync().catch((error) => {
      console.error(`Background full sync failed: ${error.message}`);
    });
    return;
  }

  const projectPath = resolveProjectFromPath(absolutePath);
  if (!projectPath) {
    return;
  }
  await queueQuickSync(projectPath, absolutePath, event);
  scheduleProject(projectPath);
}

function scheduleProject(projectPath) {
  const repoName = path.basename(projectPath);
  const isNew = !pendingProjects.has(projectPath);
  pendingProjects.add(projectPath);
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  flushTimer = setTimeout(() => {
    flushTimer = null;
    processQueue().catch((error) => {
      console.error(`Queue processing failed: ${error.message}`);
    });
  }, CONFIG.debounceMs);
  if (isNew) {
    console.log(`[${repoName}] Change detected, queued for sync`);
  }
}

async function processQueue() {
  if (queueProcessing) {
    return;
  }
  queueProcessing = true;
  try {
    while (pendingProjects.size > 0) {
      const [projectPath] = pendingProjects;
      pendingProjects.delete(projectPath);
      await syncProject(projectPath).catch((error) => {
        console.error(`[${path.basename(projectPath)}] ERROR: ${error.message}`);
      });
    }
  } finally {
    queueProcessing = false;
  }
}

function resolveProjectFromPath(targetPath) {
  if (!targetPath) {
    return null;
  }
  const absolute = path.resolve(targetPath);
  const root = CONFIG.projectRoots.find((rootPath) => {
    const normalizedRoot = path.resolve(rootPath);
    return absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${path.sep}`);
  });
  if (!root) {
    return null;
  }
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..')) {
    return null;
  }
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  const topLevel = segments[0];
  if (!topLevel || topLevel.startsWith('.')) {
    return null;
  }
  return path.join(root, topLevel);
}

function shouldIgnorePath(target) {
  const absolute = path.resolve(target);
  const root = CONFIG.projectRoots.find((rootPath) => {
    const normalizedRoot = path.resolve(rootPath);
    return absolute === normalizedRoot || absolute.startsWith(`${normalizedRoot}${path.sep}`);
  });
  if (!root) {
    return false;
  }
  const relative = path.relative(root, absolute);
  if (!relative) {
    return false;
  }
  const segments = relative.split(path.sep);
  return segments.some((segment) => ignoreDirectorySegments.has(segment));
}

async function hasStagedChanges(projectPath) {
  try {
    await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: projectPath });
    return false;
  } catch (error) {
    if (error.code === 1) {
      return true;
    }
    throw error;
  }
}

async function queueQuickSync(projectPath, absolutePath, event) {
  quickSyncChain = quickSyncChain.then(() => syncSinglePath(projectPath, absolutePath, event))
    .catch((error) => {
      console.error(`Quick sync error: ${error.message}`);
    });
  await quickSyncChain;
}

async function syncSinglePath(projectPath, absolutePath, event) {
  const repoName = path.basename(projectPath);
  const relativePath = path.relative(projectPath, absolutePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return;
  }

  try {
    if (event === 'unlink' || event === 'unlinkDir') {
      await runGit(projectPath, ['rm', '-rf', relativePath]);
    } else {
      await runGit(projectPath, ['add', relativePath]);
    }
  } catch (error) {
    if (!/fatal: pathspec/.test(error.message)) {
      console.warn(`[${repoName}] Failed to stage ${relativePath}: ${error.message}`);
    }
    return;
  }

  const hasChanges = await hasStagedChanges(projectPath);
  if (!hasChanges) {
    return;
  }

  const message = `Auto backup (quick) ${relativePath} ${new Date().toISOString()}`;
  try {
    await runGit(projectPath, ['commit', '-m', message]);
    await pushChanges(projectPath);
    console.log(`[${repoName}] Quick sync committed ${relativePath}`);
  } catch (error) {
    console.error(`[${repoName}] Quick sync failed: ${error.message}`);
  }
}

async function getIgnorePatterns() {
  if (cachedIgnorePatterns) {
    return cachedIgnorePatterns;
  }
  try {
    const raw = await fs.readFile(DEFAULT_IGNORE_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.patterns)) {
      throw new Error('missing "patterns" array');
    }
    cachedIgnorePatterns = normalizePatterns(parsed.patterns);
  } catch (error) {
    console.warn(`Could not read ignore config from ${DEFAULT_IGNORE_CONFIG_PATH}, using built-in patterns. (${error.message})`);
    cachedIgnorePatterns = [...BUILTIN_IGNORE_PATTERNS];
  }
  updateIgnoreDirectorySegments(cachedIgnorePatterns);
  return cachedIgnorePatterns;
}

function normalizePatterns(patterns) {
  return patterns
    .map((pattern) => String(pattern).trim())
    .filter((pattern) => pattern.length > 0);
}

function updateIgnoreDirectorySegments(patterns) {
  const segments = new Set(['.git']);
  patterns.forEach((pattern) => {
    if (pattern.endsWith('/')) {
      const segment = pattern.replace(/\/+$/, '');
      if (segment) {
        segments.add(segment);
      }
    }
  });
  ignoreDirectorySegments = segments;
}

function buildGitignoreContents(patterns) {
  return `${patterns.join('\n')}\n`;
}

async function syncProject(projectPath) {
  const repoName = path.basename(projectPath);
  console.log(`[${repoName}] Sync started`);

  await ensureGiteaRepository(repoName);
  const initialized = await ensureLocalGitRepo(projectPath);
  if (initialized) {
    await ensureDefaultGitignore(projectPath);
  }
  await removeNestedGitDirs(projectPath);
  await ensureGitIdentity(projectPath);
  await ensureRemote(projectPath, repoName);
  await ensureFullHistory(projectPath);

  await stageAll(projectPath);

  const changesDetected = await hasPendingChanges(projectPath);
  if (changesDetected) {
    await commitChanges(projectPath);
  }

  await pushChanges(projectPath);
  console.log(`[${repoName}] Sync complete${changesDetected ? ' (changes pushed)' : ' (no changes)'}`);
}

async function ensureGiteaRepository(repoName) {
  try {
    await API.get(`/repos/${CONFIG.owner}/${encodeURIComponent(repoName)}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      await API.post('/user/repos', {
        name: repoName,
        private: true,
        default_branch: 'main',
        auto_init: false
      });
      console.log(`[${repoName}] Created repository on Gitea`);
    } else {
      throw new Error(`Failed to ensure repository on Gitea: ${error.message}`);
    }
  }
}

async function ensureLocalGitRepo(projectPath) {
  const gitDir = path.join(projectPath, '.git');
  try {
    await fs.access(gitDir);
    return false;
  } catch (error) {
    await runGit(projectPath, ['init', '-b', 'main']);
    console.log(`[${path.basename(projectPath)}] Initialised local git repository`);
    return true;
  }
  return false;
}

async function ensureDefaultGitignore(projectPath) {
  const gitignorePath = path.join(projectPath, '.gitignore');
  try {
    await fs.access(gitignorePath);
  } catch (error) {
    const patterns = await getIgnorePatterns();
    const contents = buildGitignoreContents(patterns);
    await fs.writeFile(gitignorePath, contents);
    console.log(`[${path.basename(projectPath)}] Added default .gitignore`);
  }
}

async function removeNestedGitDirs(projectPath) {
  let stdout = '';
  try {
    const result = await execFileAsync('find', [projectPath, '-mindepth', '2', '-type', 'd', '-name', '.git']);
    stdout = result.stdout.trim();
  } catch (error) {
    if (error.stdout) {
      stdout = error.stdout.trim();
    }
  }

  if (!stdout) {
    return;
  }

  const repoName = path.basename(projectPath);
  const nestedPaths = stdout.split('\n').filter(Boolean);
  for (const gitDir of nestedPaths) {
    await fs.rm(gitDir, { recursive: true, force: true });
    console.log(`[${repoName}] Removed nested git directory: ${gitDir}`);
  }
}

async function ensureGitIdentity(projectPath) {
  const repoName = path.basename(projectPath);
  const authorName = process.env.GIT_AUTHOR_NAME || 'Gitea Autosync';
  const authorEmail = process.env.GIT_AUTHOR_EMAIL || 'autosync@example.com';
  await ensureGitConfig(projectPath, 'user.name', authorName);
  await ensureGitConfig(projectPath, 'user.email', authorEmail);
  await ensureGitConfig(projectPath, 'commit.gpgsign', 'false');
  await ensureGitConfig(projectPath, 'http.postBuffer', '524288000');
  await ensureGitConfig(projectPath, 'http.maxRequestBuffer', '524288000');
  console.log(`[${repoName}] Git identity ensured`);
}

async function ensureGitConfig(projectPath, key, value) {
  try {
    const { stdout } = await runGit(projectPath, ['config', '--get', key]);
    if (stdout) {
      return;
    }
  } catch (error) {
    // ignore and set value
  }
  await runGit(projectPath, ['config', key, value]);
}

async function ensureRemote(projectPath, repoName) {
  const remoteUrl = `${CONFIG.baseUrl}/${CONFIG.owner}/${encodeURIComponent(repoName)}.git`;
  try {
    const { stdout } = await runGit(projectPath, ['remote', 'get-url', REMOTE_NAME]);
    if (stdout !== remoteUrl) {
      await runGit(projectPath, ['remote', 'set-url', REMOTE_NAME, remoteUrl]);
      console.log(`[${repoName}] Updated remote URL`);
    }
  } catch (error) {
    await runGit(projectPath, ['remote', 'add', REMOTE_NAME, remoteUrl]);
    console.log(`[${repoName}] Added remote ${REMOTE_NAME}`);
  }
}

async function ensureFullHistory(projectPath) {
  const repoName = path.basename(projectPath);
  try {
    const { stdout } = await runGit(projectPath, ['rev-parse', '--is-shallow-repository']);
    if (stdout === 'true') {
      try {
        await runGit(projectPath, ['fetch', '--unshallow']);
        console.log(`[${repoName}] Converted shallow clone to full history`);
      } catch (error) {
        console.warn(`[${repoName}] Warning: failed to unshallow repository (${error.message})`);
      }
    }
  } catch (error) {
    // ignore check failures
  }
}

async function stageAll(projectPath) {
  await runGit(projectPath, ['add', '--all']);
}

async function hasPendingChanges(projectPath) {
  try {
    const { stdout } = await runGit(projectPath, ['status', '--porcelain']);
    return stdout.length > 0;
  } catch (error) {
    throw new Error(`Unable to check git status: ${error.message}`);
  }
}

async function commitChanges(projectPath) {
  const message = `Auto backup ${new Date().toISOString()}`;
  try {
    await runGit(projectPath, ['commit', '-m', message]);
  } catch (error) {
    if (/nothing to commit/.test(error.message)) {
      return;
    }
    throw new Error(`Failed to commit changes: ${error.message}`);
  }
}

async function pushChanges(projectPath) {
  const branch = await currentBranch(projectPath);
  const hasUpstream = await branchHasUpstream(projectPath, branch);
  const pushArgs = hasUpstream
    ? ['push', REMOTE_NAME, branch]
    : ['push', '--set-upstream', REMOTE_NAME, branch];

  const pushEnv = {
    ...process.env,
    GIT_ASKPASS: ASKPASS_SCRIPT_PATH,
    GIT_USERNAME: CONFIG.owner,
    GIT_PASSWORD: CONFIG.token
  };

  try {
    await runGit(projectPath, pushArgs, { env: pushEnv });
    return;
  } catch (error) {
    if (!/non-fast-forward|fetch first|failed to push/.test(error.message)) {
      throw error;
    }
  }

  const forceArgs = hasUpstream
    ? ['push', '--force', REMOTE_NAME, branch]
    : ['push', '--set-upstream', '--force', REMOTE_NAME, branch];
  await runGit(projectPath, forceArgs, { env: pushEnv });
}

async function currentBranch(projectPath) {
  try {
    const { stdout } = await runGit(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout || 'main';
  } catch (error) {
    return 'main';
  }
}

async function branchHasUpstream(projectPath, branch) {
  try {
    await runGit(projectPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branch}@{u}`]);
    return true;
  } catch (error) {
    return false;
  }
}

async function runGit(projectPath, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
      ...options
    });
    return {
      stdout: stdout.trim(),
      stderr: stderr.trim()
    };
  } catch (error) {
    const stderr = (error.stderr || '').toString().trim();
    const cmdText = `git ${args.join(' ')}`;
    const message = stderr ? `${cmdText}: ${stderr}` : `${cmdText}: ${error.message}`;
    const wrapped = new Error(message);
    wrapped.stack = error.stack;
    throw wrapped;
  }
}

main().catch((error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
