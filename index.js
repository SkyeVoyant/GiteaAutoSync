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

const PRIMARY_PROJECT_ROOT = resolveProjectsRoot();
const ADDITIONAL_PROJECT_ROOTS = resolveAdditionalProjectRoots(PRIMARY_PROJECT_ROOT);

const CONFIG = {
  baseUrl: getBaseUrl(),
  token: process.env.GITEA_TOKEN,
  owner: process.env.GITEA_OWNER || 'autosync',
  projectsRoot: PRIMARY_PROJECT_ROOT,
  additionalProjectRoots: ADDITIONAL_PROJECT_ROOTS,
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
let gitignoreFilters = new Map(); // Map of projectPath -> ignore filter

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
  await ensureProjectRootsExist();

  const args = process.argv.slice(2);
  const watchMode = args.includes('--watch');

  console.log('Running initial sync of all projects...');
  await runFullSync();
  console.log('Initial sync complete.');

  if (watchMode) {
    const watcher = await startWatcher();
    console.log('Watching for filesystem changes...');

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
  } else {
    console.log('Single sync completed. Exiting.');
  }
}

function validateConfig() {
  if (!CONFIG.token) {
    console.error('Missing GITEA_TOKEN. Please set it in your .env file.');
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
    for (const rootDir of CONFIG.projectRoots) {
      const projectDirs = await discoverProjectDirectories(rootDir);
      for (const projectPath of projectDirs) {
        await syncProject(projectPath).catch((error) => {
          console.error(`[${path.basename(projectPath)}] ERROR: ${error.message}`);
        });
      }
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
          // No .gitignore file, skip this project
        }
      }
    } catch (error) {
      console.warn(`Could not load gitignore files from ${rootDir}: ${error.message}`);
    }
  }
  
  console.log(`Loaded .gitignore from ${gitignoreFilters.size} project(s)`);
}

function shouldIgnoreFile(filePath) {
  const normalized = path.normalize(filePath);
  
  // Always ignore .git directories and their contents
  const pathParts = normalized.split(path.sep);
  if (pathParts.includes('.git')) {
    return true;
    }
  
  // Ignore node_modules
  if (pathParts.includes('node_modules')) {
        return true;
    }
    
    // Check against project-specific .gitignore files
    for (const [projectPath, ig] of gitignoreFilters.entries()) {
      const absolutePath = path.resolve(filePath);
      const absoluteProjectPath = path.resolve(projectPath);
      
      if (absolutePath.startsWith(absoluteProjectPath + path.sep) || absolutePath === absoluteProjectPath) {
        const relativePath = path.relative(absoluteProjectPath, absolutePath);
        if (relativePath && !relativePath.startsWith('..')) {
          if (ig.ignores(relativePath)) {
            return true;
          }
        }
      }
    }
    
    return false;
}

async function startWatcher() {
  const watchTargets = CONFIG.projectRoots.slice();
  const uniqueTargets = Array.from(new Set(watchTargets.map((target) => path.resolve(target))));

  // Load .gitignore files from all projects
  await loadGitignoreFilters();

  console.log(`Watching ${uniqueTargets.length} root director(ies)`);

  const watcher = chokidar.watch(uniqueTargets, {
    persistent: true,
    ignoreInitial: true,
    ignored: shouldIgnoreFile,
    depth: 10,
    usePolling: false,
    alwaysStat: false,
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
  const projectPath = resolveProjectFromPath(absolutePath);
  
  if (!projectPath) {
    console.log(`[WATCH] Ignoring file outside project roots: ${filePath}`);
    return;
  }

  const relativePath = path.relative(projectPath, absolutePath);
  console.log(`[WATCH] Event: ${event}, Project: ${path.basename(projectPath)}, File: ${relativePath}`);

  // If a .gitignore file was modified, reload patterns
  if (path.basename(absolutePath) === '.gitignore') {
    console.log(`[${path.basename(projectPath)}] .gitignore changed, reloading patterns.`);
    await loadGitignoreFilters();
    // Trigger a sync to commit the .gitignore change
    scheduleProject(projectPath);
    return;
  }

  scheduleProject(projectPath);
}

function scheduleProject(projectPath) {
  const repoName = path.basename(projectPath);
  const isNew = !pendingProjects.has(projectPath);
  pendingProjects.add(projectPath);
  
  if (flushTimer) {
    clearTimeout(flushTimer);
  }
  
  flushTimer = setTimeout(async () => {
    console.log(`[DEBOUNCE] Period ended, processing ${pendingProjects.size} project(s)...`);
    flushTimer = null;
    try {
      await processQueue();
    } catch (error) {
      console.error(`[ERROR] Queue processing failed: ${error.message}`);
      console.error(error.stack);
    }
  }, CONFIG.debounceMs);
  
  console.log(`[TIMER] Set timeout for ${CONFIG.debounceMs}ms, timer ID: ${flushTimer}`);
  
  if (isNew) {
    console.log(`[${repoName}] Change detected, queued for sync (debounce: ${CONFIG.debounceMs}ms)`);
  }
}

async function processQueue() {
  console.log(`[QUEUE] processQueue called, queueProcessing=${queueProcessing}, pending=${pendingProjects.size}`);
  if (queueProcessing) {
    console.log(`[QUEUE] Already processing, skipping`);
    return;
  }
  queueProcessing = true;
  try {
    console.log(`[QUEUE] Starting to process ${pendingProjects.size} project(s)`);
    while (pendingProjects.size > 0) {
      const [projectPath] = pendingProjects;
      pendingProjects.delete(projectPath);
      await syncProject(projectPath).catch((error) => {
        console.error(`[${path.basename(projectPath)}] ERROR: ${error.message}`);
      });
    }
    console.log(`[QUEUE] Finished processing`);
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

async function syncProject(projectPath) {
  const repoName = path.basename(projectPath);
  console.log(`[${repoName}] Syncing...`);

  await ensureGiteaRepository(repoName);
  await ensureLocalGitRepo(projectPath);
  await ensureGitIdentity(projectPath);
  await ensureRemote(projectPath, repoName);

  await stageAll(projectPath);

  const changesDetected = await hasPendingChanges(projectPath);
  if (changesDetected) {
    await commitChanges(projectPath);
  }

  await pushChanges(projectPath);
  console.log(`[${repoName}] ${changesDetected ? 'Changes committed and pushed' : 'No changes'}`);
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
    console.log(`[${path.basename(projectPath)}] Initialized git repository`);
    return true;
  }
}

async function ensureGitIdentity(projectPath) {
  const authorName = process.env.GIT_AUTHOR_NAME || 'Gitea Autosync';
  const authorEmail = process.env.GIT_AUTHOR_EMAIL || 'autosync@example.com';
  await ensureGitConfig(projectPath, 'user.name', authorName);
  await ensureGitConfig(projectPath, 'user.email', authorEmail);
}

async function ensureGitConfig(projectPath, key, value) {
  try {
    const { stdout } = await runGit(projectPath, ['config', '--get', key]);
    if (stdout === value) {
      return;
    }
  } catch (error) {
    // Config doesn't exist, set it
  }
  await runGit(projectPath, ['config', key, value]);
}

async function ensureRemote(projectPath, repoName) {
  const remoteUrl = `${CONFIG.baseUrl}/${CONFIG.owner}/${encodeURIComponent(repoName)}.git`;
  try {
    const { stdout } = await runGit(projectPath, ['remote', 'get-url', REMOTE_NAME]);
    if (stdout !== remoteUrl) {
      await runGit(projectPath, ['remote', 'set-url', REMOTE_NAME, remoteUrl]);
    }
  } catch (error) {
    await runGit(projectPath, ['remote', 'add', REMOTE_NAME, remoteUrl]);
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
