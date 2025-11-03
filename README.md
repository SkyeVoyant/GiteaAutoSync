# Gitea Autosync (Open Source)

Continuously mirror local project folders into any self-hosted Gitea instance.  
Unofficial helper: not affiliated with the Gitea project.

Simple automated backup: watches your project folders and automatically commits and pushes any changes to your Gitea server. Just set it and forget it.

## Features
- Auto-discovers non-hidden directories under your project roots
- Creates or reuses repos on Gitea automatically
- **Respects each project's `.gitignore` files** - only commits files that Git tracks
- Watches for filesystem changes and commits them automatically
- Simple workflow: detects change → waits 5 seconds → commits all changes → pushes
- Resource-efficient: typically uses <300MB RAM even with large project trees
- `.gitignore` file monitoring - changes are automatically reloaded without restart

## Prerequisites
- Node.js 18+ and Git
- Gitea personal access token (`write:user`, `write:repository`)
- Read access to the directories you want mirrored (e.g. `/projects`, `/projects_archive`)

**Dependencies:**
- `axios` - API communication
- `chokidar` - File watching
- `dotenv` - Environment configuration
- `ignore` - `.gitignore` parsing and pattern matching

## Quick start
1) Get the code and configure
```bash
git clone https://github.com/SkyeVoyant/GiteaAutoSync.git
cd GiteaAutoSync
pnpm install
cp .env.example .env
```
Set `GITEA_BASE_URL`, `GITEA_OWNER`, `GITEA_TOKEN`, and point `PROJECTS_ROOT` (and optional `PROJECTS_ADDITIONAL_ROOTS`) at your directories.

2) Run once or watch continuously
```bash
# One-off snapshot of all projects
pnpm run start

# Watch mode - automatically commit and push changes as they happen
pnpm run start:watch
```

## `.env` options
- `GITEA_BASE_URL`: your instance URL (trailing slashes trimmed)
- `GITEA_TOKEN`: personal access token used for API + Git
- `GITEA_OWNER`: user/org that will own mirrored repositories
- `PROJECTS_ROOT`: primary directory; each subfolder becomes a repo
- `PROJECTS_ADDITIONAL_ROOTS`: comma-separated extras; sibling `projects_archive` auto-added when present
- `SYNC_DEBOUNCE_MS`: delay before committing changes (default 5000ms = 5 seconds)
- `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`: override commit identity

## How It Works

**Initial Sync:**
On startup, autosync performs one full sync of all projects to catch any changes made while it was offline.

**Watch Mode:**
1. Detects file changes in your project directories
2. Waits 5 seconds (debounce period) to group related changes
3. Stages all changes with `git add --all`
4. Commits with timestamp: "Auto backup 2025-11-03T12:34:56.789Z"
5. Pushes to your Gitea server

**What Gets Committed:**
- Only files that Git would normally track
- Respects each project's `.gitignore` file automatically
- When a `.gitignore` is modified, patterns are reloaded instantly

**What Gets Ignored:**
- Anything in your project's `.gitignore`
- `.git` directories
- `node_modules` directories

## Usage notes
- **Each project's `.gitignore` is automatically loaded and respected** - files ignored by Git won't be watched or committed.
- Hidden directories (starting with `.`) are skipped automatically.
- `.gitignore` files are monitored - changes are automatically reloaded without restart.
- Commits use descriptive timestamps for easy identification.
- If you delete a file, autosync will commit that deletion automatically.

## Performance Optimizations
The file watcher is optimized for large project trees:
- **Per-project `.gitignore` support**: Automatically loads and respects gitignore rules
- **Efficient pattern matching**: Prevents scanning ignored directories
- **Depth limiting**: Prevents excessive recursive scanning (max depth: 10)
- **Stat-less operation**: Reduces memory by not tracking file metadata
- **Smart debouncing**: Batches rapid file changes to avoid commit storms

Typical RAM usage: 100-300MB even with large project trees.

## Docker Compose
Lightweight compose stack included:
```bash
# First, configure your .env file
cp .env.example .env
# Edit .env and set:
#   GITEA_BASE_URL, GITEA_TOKEN, GITEA_OWNER
#   PROJECTS_ROOT (path to your main projects directory)
#   PROJECTS_ADDITIONAL_ROOTS (path to additional directories, e.g., projects_archive)

# Then build and run
docker compose up -d --build
```

The compose file automatically mounts `PROJECTS_ROOT` and `PROJECTS_ADDITIONAL_ROOTS` from your `.env` as volumes. Defaults to `/root/projects` and `/root/projects_archive` if not specified.

## Troubleshooting
- **Missing token?** The script exits with a helpful error. Double-check `.env`.
- **Conflicts?** Autosync fetches/rebases before pushing; check logs if a repo still fails.
- **Too many commits?** Increase `SYNC_DEBOUNCE_MS` to wait longer between commits (default 5000ms).
- **Changes not being detected?** Make sure the files aren't in your project's `.gitignore`.

## What Autosync Does NOT Do
- Does not create or modify `.gitignore` files (respects your existing ones)
- Does not remove nested `.git` directories (assumes you manage this)
- Does not prune Git history or run garbage collection
- Does not have scheduled full syncs (only on startup and when changes occur)

## License
GPL-2.0-only — see `LICENSE`.
