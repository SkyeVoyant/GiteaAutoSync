#!/usr/bin/env node

require('dotenv').config();

const axios = require('axios').default;
const chokidar = require('chokidar');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const util = require('util');

const execFileAsync = util.promisify(execFile);

// Configuration
const CONFIG = {
  baseUrl: (process.env.GITEA_BASE_URL || 'https://gitea.example.com').replace(/\/+$/, ''),
  token: process.env.GITEA_TOKEN,
  owner: process.env.GITEA_OWNER || 'autosync',
  projectsRoot: path.resolve(process.env.PROJECTS_ROOT || path.join(process.cwd(), 'projects')),
  debounceMs: Number(process.env.SYNC_DEBOUNCE_MS || '3000')
};

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

// Track pending syncs per project
const pendingSyncs = new Map(); // projectPath -> timeout

async function main() {
  if (!CONFIG.token) {
    console.error('ERROR: Missing GITEA_TOKEN environment variable');
    process.exit(1);
  }

  console.log('=== Gitea AutoSync ===');
  console.log(`Projects root: ${CONFIG.projectsRoot}`);
  console.log(`Gitea: ${CONFIG.baseUrl}`);
  console.log(`Owner: ${CONFIG.owner}`);
  console.log(`Debounce: ${CONFIG.debounceMs}ms`);
  
  await createAskPassScript();
  await fs.mkdir(CONFIG.projectsRoot, { recursive: true });

  // Full sync on startup
  console.log('\n--- Initial Full Sync ---');
  await fullSync();

  // Start watching
  const watchMode = process.argv.includes('--watch');
  if (watchMode) {
    console.log('\n--- Starting File Watcher ---');
    startWatcher();
  } else {
    console.log('\n--- Single sync complete (use --watch to monitor changes) ---');
    process.exit(0);
  }
}

async function createAskPassScript() {
  const script = `#!/bin/sh
case "$1" in
  *Username*) echo "${CONFIG.owner}" ;;
  *) echo "${CONFIG.token}" ;;
esac
`;
  await fs.writeFile(ASKPASS_SCRIPT_PATH, script, { mode: 0o700 });
}

async function fullSync() {
  const projects = await discoverProjects();
  console.log(`Found ${projects.length} project(s)`);
  
  for (const projectPath of projects) {
    const name = path.basename(projectPath);
    try {
      await syncProject(projectPath);
    } catch (error) {
      console.error(`[${name}] ERROR: ${error.message}`);
    }
  }
  console.log('Full sync complete');
}

async function discoverProjects() {
  try {
    const entries = await fs.readdir(CONFIG.projectsRoot, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => path.join(CONFIG.projectsRoot, entry.name));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function startWatcher() {
  const watcher = chokidar.watch(CONFIG.projectsRoot, {
    persistent: true,
    ignoreInitial: true,
    ignored: [
      /(^|[\/\\])\../, // dot files/folders
      /node_modules/,
      /dist/,
      /build/,
      /logs/,
      /tmp/,
      /cache/,
      /coverage/,
      /\.log$/,
      /\.tmp$/
    ],
    depth: 99,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });

  watcher.on('all', (event, filePath) => {
    handleFileChange(filePath);
  });

  watcher.on('ready', () => {
    console.log('File watcher ready - monitoring for changes');
  });

  watcher.on('error', error => {
    console.error(`Watcher error: ${error.message}`);
  });

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    await watcher.close();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await watcher.close();
    process.exit(0);
  });
}

function handleFileChange(filePath) {
  const projectPath = getProjectPath(filePath);
  if (!projectPath) return;

  const name = path.basename(projectPath);
  
  // Clear existing timeout for this project
  if (pendingSyncs.has(projectPath)) {
    clearTimeout(pendingSyncs.get(projectPath));
  }

  // Schedule sync with debounce
  const timeout = setTimeout(async () => {
    pendingSyncs.delete(projectPath);
    console.log(`\n[${name}] Change detected, syncing...`);
    try {
      await syncProject(projectPath);
    } catch (error) {
      console.error(`[${name}] ERROR: ${error.message}`);
    }
  }, CONFIG.debounceMs);

  pendingSyncs.set(projectPath, timeout);
}

function getProjectPath(filePath) {
  const absolute = path.resolve(filePath);
  const relative = path.relative(CONFIG.projectsRoot, absolute);
  
  if (!relative || relative.startsWith('..')) return null;
  
  const segments = relative.split(path.sep);
  if (segments.length === 0 || segments[0].startsWith('.')) return null;
  
  return path.join(CONFIG.projectsRoot, segments[0]);
}

async function syncProject(projectPath) {
  const name = path.basename(projectPath);
  
  // Ensure Gitea repo exists
  await ensureGiteaRepo(name);
  
  // Initialize git repo if needed
  await initGitRepo(projectPath);
  
  // Set git config
  await setGitConfig(projectPath);
  
  // Set remote
  await setRemote(projectPath, name);
  
  // Stage all changes
  await git(projectPath, ['add', '-A']);
  
  // Check if there are changes
  const hasChanges = await checkChanges(projectPath);
  
  if (hasChanges) {
    // Commit
    const timestamp = new Date().toISOString();
    await git(projectPath, ['commit', '-m', `Auto backup ${timestamp}`]);
    console.log(`[${name}] Committed changes`);
    
    // Push
    await push(projectPath);
    console.log(`[${name}] Pushed to Gitea`);
  } else {
    console.log(`[${name}] No changes to sync`);
  }
}

async function ensureGiteaRepo(name) {
  try {
    await API.get(`/repos/${CONFIG.owner}/${encodeURIComponent(name)}`);
  } catch (error) {
    if (error.response && error.response.status === 404) {
      await API.post('/user/repos', {
        name: name,
        private: true,
        default_branch: 'main',
        auto_init: false
      });
      console.log(`[${name}] Created Gitea repository`);
    } else {
      throw new Error(`Failed to check/create repo: ${error.message}`);
    }
  }
}

async function initGitRepo(projectPath) {
  const gitDir = path.join(projectPath, '.git');
  try {
    await fs.access(gitDir);
  } catch {
    await git(projectPath, ['init', '-b', 'main']);
    console.log(`[${path.basename(projectPath)}] Initialized git repository`);
  }
}

async function setGitConfig(projectPath) {
  const name = process.env.GIT_AUTHOR_NAME || 'Gitea Autosync';
  const email = process.env.GIT_AUTHOR_EMAIL || 'autosync@example.com';
  
  await git(projectPath, ['config', 'user.name', name]);
  await git(projectPath, ['config', 'user.email', email]);
  await git(projectPath, ['config', 'commit.gpgsign', 'false']);
}

async function setRemote(projectPath, repoName) {
  const remoteUrl = `${CONFIG.baseUrl}/${CONFIG.owner}/${encodeURIComponent(repoName)}.git`;
  
  try {
    const { stdout } = await git(projectPath, ['remote', 'get-url', REMOTE_NAME]);
    if (stdout !== remoteUrl) {
      await git(projectPath, ['remote', 'set-url', REMOTE_NAME, remoteUrl]);
    }
  } catch {
    await git(projectPath, ['remote', 'add', REMOTE_NAME, remoteUrl]);
  }
}

async function checkChanges(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['status', '--porcelain']);
    return stdout.length > 0;
  } catch {
    return false;
  }
}

async function push(projectPath) {
  const branch = await getCurrentBranch(projectPath);
  const hasUpstream = await checkUpstream(projectPath, branch);
  
  const env = {
    ...process.env,
    GIT_ASKPASS: ASKPASS_SCRIPT_PATH,
    GIT_USERNAME: CONFIG.owner,
    GIT_PASSWORD: CONFIG.token
  };
  
  const args = hasUpstream
    ? ['push', REMOTE_NAME, branch]
    : ['push', '--set-upstream', REMOTE_NAME, branch];
  
  try {
    await git(projectPath, args, { env });
  } catch (error) {
    // Handle non-fast-forward by force pushing (local is authoritative)
    if (/non-fast-forward|fetch first|rejected/.test(error.message)) {
      const forceArgs = ['push', '--force', REMOTE_NAME, branch];
      await git(projectPath, forceArgs, { env });
      console.log(`[${path.basename(projectPath)}] Force pushed (local is authoritative)`);
    } else {
      throw error;
    }
  }
}

async function getCurrentBranch(projectPath) {
  try {
    const { stdout } = await git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
    return stdout || 'main';
  } catch {
    return 'main';
  }
}

async function checkUpstream(projectPath, branch) {
  try {
    await git(projectPath, ['rev-parse', '--abbrev-ref', `${branch}@{u}`]);
    return true;
  } catch {
    return false;
  }
}

async function git(projectPath, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
      ...options
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    const stderr = (error.stderr || '').toString().trim();
    const message = stderr || error.message;
    throw new Error(message);
  }
}

main().catch(error => {
  console.error(`FATAL: ${error.message}`);
  process.exit(1);
});
