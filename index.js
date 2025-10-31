#!/usr/bin/env node

require('dotenv').config();

const axios = require('axios').default;
const chokidar = require('chokidar');
const ignore = require('ignore');
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
let gitignoreFilters = new Map(); // Map of projectPath -> ignore filter

const PRIMARY_PROJECT_ROOT = resolveProjectsRoot();
const ADDITIONAL_PROJECT_ROOTS = resolveAdditionalProjectRoots(PRIMARY_PROJECT_ROOT);

const CONFIG = {
  baseUrl: getBaseUrl(),
  token: process.env.GITEA_TOKEN,
  owner: process.env.GITEA_OWNER || 'autosync',
  projectsRoot: PRIMARY_PROJECT_ROOT,
  additionalProjectRoots: ADDITIONAL_PROJECT_ROOTS,
  syncIntervalMinutes: Number(process.env.SYNC_INTERVAL_MINUTES || '0'),
  debounceMs: Number(process.env.SYNC_DEBOUNCE_MS || '5000'),
  pruneAgeDays: Math.max(0, Number(process.env.PRUNE_AGE_DAYS || '0'))
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
    const watcher = await startWatcher();
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

async function loadGitignoreFilters() {
  // Load .gitignore files from all project directories
  gitignoreFilters.clear();
  
  for (const rootDir of CONFIG.projectRoots) {
    try {
      const projectDirs = await discoverProjectDirectories(rootDir);
      for (const projectPath of projectDirs) {
        const gitignorePath = path.join(projectPath, '.gitignore');
        try {
          const gitignoreContent = await fs.readFile(gitignorePath, 'utf8');
          const ig = ignore().add(gitignoreContent);
          gitignoreFilters.set(projectPath, ig);
        } catch (error) {
          // No .gitignore file or can't read it, skip
          if (error.code !== 'ENOENT') {
            console.warn(`[${path.basename(projectPath)}] Warning: Could not read .gitignore (${error.message})`);
          }
        }
      }
    } catch (error) {
      console.warn(`Could not load gitignore files from ${rootDir}: ${error.message}`);
    }
  }
  
  console.log(`Loaded .gitignore patterns from ${gitignoreFilters.size} project(s)`);
}

function buildChokidarIgnorePatterns() {
  // Build efficient glob patterns for chokidar to prevent scanning ignored directories
  const patterns = [];
  
  // Always ignore .git directories
  patterns.push(/(^|[/\\])\\.git($|[/\\])/);
  
  // Add patterns from ignore config
  const ignorePatterns = cachedIgnorePatterns || BUILTIN_IGNORE_PATTERNS;
  
  // Convert directory patterns to regex for efficient matching
  ignorePatterns.forEach((pattern) => {
    if (pattern.endsWith('/')) {
      // Directory pattern - match anywhere in the path
      const dirName = pattern.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      patterns.push(new RegExp(`(^|[/\\\\])${dirName}($|[/\\\\])`));
    } else if (pattern.includes('*')) {
      // Wildcard pattern - convert to regex
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      patterns.push(new RegExp(regexPattern));
    } else {
      // Exact match pattern
      const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      patterns.push(new RegExp(`(^|[/\\\\])${escapedPattern}$`));
    }
  });
  
  // Return a function that tests against all patterns
  return (filePath) => {
    // Normalize path separators
    const normalizedPath = filePath.replace(/\\/g, '/');
    
    // Test against all patterns first
    for (const pattern of patterns) {
      if (pattern.test(normalizedPath)) {
        return true;
      }
    }
    
    // Check against project-specific .gitignore files
    for (const [projectPath, ig] of gitignoreFilters.entries()) {
      // Check if this file is within this project
      const absolutePath = path.resolve(filePath);
      const absoluteProjectPath = path.resolve(projectPath);
      
      if (absolutePath.startsWith(absoluteProjectPath + path.sep) || absolutePath === absoluteProjectPath) {
        // Get relative path from project root
        const relativePath = path.relative(absoluteProjectPath, absolutePath);
        if (relativePath && !relativePath.startsWith('..')) {
          // Use the ignore filter to check if this path should be ignored
          if (ig.ignores(relativePath)) {
            return true;
          }
        }
      }
    }
    
    return false;
  };
}

async function startWatcher() {
  const watchTargets = CONFIG.projectRoots.slice();
  if (DEFAULT_IGNORE_CONFIG_PATH) {
    watchTargets.push(DEFAULT_IGNORE_CONFIG_PATH);
  }

  const uniqueTargets = Array.from(new Set(watchTargets.map((target) => path.resolve(target))));

  // Load .gitignore files from all projects
  await loadGitignoreFilters();

  // Build efficient glob patterns for chokidar
  const ignorePatterns = buildChokidarIgnorePatterns();

  console.log('Starting file watcher with optimized ignore patterns (including .gitignore)...');
  console.log(`Watching ${uniqueTargets.length} root director(ies)`);

  const watcher = chokidar.watch(uniqueTargets, {
    persistent: true,
    ignoreInitial: true,
    ignored: ignorePatterns,
    // Depth limiting to prevent excessive scanning
    depth: 10,
    // Use polling fallback for large directories
    usePolling: false,
    // Reduce memory usage by not tracking file stats
    alwaysStat: false,
    // Atomic writes detection
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  watcher.on('all', (event, filePath) => {
    handleWatchEvent(event, filePath).catch((error) => {
      console.error(`Watcher handling error: ${error.message}`);
    });
  });

  watcher.on('error', (error) => {
    console.error(`Watcher error: ${error.message}`);
  });

  watcher.on('ready', () => {
    console.log('File watcher initialized and ready');
  });

  return watcher;
}

async function handleWatchEvent(event, filePath) {
  const absolutePath = path.resolve(filePath);
  
  // Check if ignore configuration changed
  if (DEFAULT_IGNORE_CONFIG_PATH && absolutePath === DEFAULT_IGNORE_CONFIG_PATH) {
    console.log('Ignore configuration changed, reloading patterns.');
    cachedIgnorePatterns = null;
    await getIgnorePatterns();
    await loadGitignoreFilters();
    runFullSync().catch((error) => {
      console.error(`Background full sync failed: ${error.message}`);
    });
    return;
  }

  const projectPath = resolveProjectFromPath(absolutePath);
  if (!projectPath) {
    return;
  }

  // Check if a .gitignore file was modified
  if (path.basename(absolutePath) === '.gitignore') {
    console.log(`[${path.basename(projectPath)}] .gitignore changed, reloading patterns.`);
    await loadGitignoreFilters();
    // Don't trigger a full sync, just reload the patterns
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
    await pushChanges(projectPath, { pruneAfter: false });
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

  await pushChanges(projectPath, { pruneAfter: true });
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

async function pushChanges(projectPath, { pruneAfter = false } = {}) {
  const branch = await currentBranch(projectPath);
  const hasUpstream = await branchHasUpstream(projectPath, branch);

  const pushEnv = {
    ...process.env,
    GIT_ASKPASS: ASKPASS_SCRIPT_PATH,
    GIT_USERNAME: CONFIG.owner,
    GIT_PASSWORD: CONFIG.token
  };

  const pushArgs = hasUpstream
    ? ['push', REMOTE_NAME, branch]
    : ['push', '--set-upstream', REMOTE_NAME, branch];

  try {
    await runGit(projectPath, ['fetch', '--all'], { env: pushEnv });
    await runGit(projectPath, pushArgs, { env: pushEnv });
  } catch (error) {
    if (/non-fast-forward|fetch first|tip of your current branch is behind/.test(error.message)) {
      await runGit(projectPath, ['pull', '--rebase', REMOTE_NAME, branch], { env: pushEnv });
      await runGit(projectPath, pushArgs, { env: pushEnv });
    } else {
      throw error;
    }
  }

  if (pruneAfter) {
    await pruneRepository(projectPath);
  }
}


async function pruneRepository(projectPath) {
  const days = Number.isFinite(CONFIG.pruneAgeDays) ? CONFIG.pruneAgeDays : 0;
  if (!days || days <= 0) return;
  const repoName = path.basename(projectPath);
  const pruneArg = `${days}.days`;
  try {
    await runGit(projectPath, ['reflog', 'expire', `--expire=${pruneArg}`, '--all']);
    await runGit(projectPath, ['gc', `--prune=${pruneArg}`]);
    console.log(`[${repoName}] Pruned git history older than ${days} day(s)`);
  } catch (error) {
    console.warn(`[${repoName}] Warning: git maintenance failed (${error.message})`);
  }
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
