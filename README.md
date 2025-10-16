# Gitea Autosync (Open Source)

Continuously mirror local project folders into any self-hosted Gitea instance.  
Unofficial helper: not affiliated with the Gitea project.

Keeps each top-level folder in sync with a private repo, auto-initialises Git, commits on change, and pushes via the Gitea API. Designed to be lightweight: set it once, let it handle scheduled and real-time snapshots.

## Features
- Auto-discovers non-hidden directories under your project roots
- Creates or reuses repos on Gitea and seeds them with a sensible `.gitignore`
- Watches for filesystem changes and ships “quick sync” commits within seconds
- Strips nested `.git/` folders and adds a dedicated `gitea` remote per project
- Optional maintenance: scheduled full syncs and Git history pruning

## Prerequisites
- Node.js 18+ and Git
- Gitea personal access token (`write:user`, `write:repository`)
- Read access to the directories you want mirrored (e.g. `/projects`, `/projects_archive`)

## Quick start
1) Get the code and configure
```bash
git clone https://github.com/SkyeVoyant/GiteaAutoSync.git
cd GiteaAutoSync
npm install
cp .env.example .env
```
Set `GITEA_BASE_URL`, `GITEA_OWNER`, `GITEA_TOKEN`, and point `PROJECTS_ROOT` (and optional `PROJECTS_ADDITIONAL_ROOTS`) at your directories.

2) Run once or watch continuously
```bash
# One-off snapshot
npm run start

# Watch mode (add SYNC_INTERVAL_MINUTES in .env for periodic full sweeps)
npm run start:watch
```

## `.env` options
- `GITEA_BASE_URL`: your instance URL (trailing slashes trimmed)
- `GITEA_TOKEN`: personal access token used for API + Git
- `GITEA_OWNER`: user/org that will own mirrored repositories
- `PROJECTS_ROOT`: primary directory; each subfolder becomes a repo
- `PROJECTS_ADDITIONAL_ROOTS`: comma-separated extras; sibling `projects_archive` auto-added when present
- `SYNC_INTERVAL_MINUTES`: schedule full syncs (0 to disable)
- `SYNC_DEBOUNCE_MS`: delay before batching watch events (default 5000)
- `IGNORE_CONFIG_PATH`: JSON file with default `.gitignore` patterns
- `PRUNE_AGE_DAYS`: enable Git garbage collection after full syncs
- `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL`: override commit identity

## Usage notes
- Default ignore patterns live in `ignoreconfig.json`; add your own or point `IGNORE_CONFIG_PATH` elsewhere.
- Quick sync commits use descriptive timestamps; background full syncs reconcile everything.
- Hidden directories are skipped automatically. Nested Git repos are flattened so only top-level folders push.

## Docker Compose
Lightweight compose stack included:
```bash
docker compose up -d --build
```
Mount additional project paths and override any environment variable in `.env` or inline when you start the stack.

## Kubernetes (Kustomize)
`deploy/base` contains a minimal Deployment that installs Git, clones this repo, and runs watch mode. Provide:
- ConfigMap/Secret (`giteaautosync-config` / `giteaautosync-secret`) with the same variables as `.env`
- Secret `default-github-ssh` holding a deploy key plus `known_hosts`
- Volumes for your project directories (update host paths or swap for PVCs)

## Troubleshooting
- Missing token? The script exits with a helpful error. Double-check `.env`.
- Conflicts? Autosync fetches/rebases before pushing; check logs if a repo still fails.
- Slow builds? Raise `SYNC_DEBOUNCE_MS` to avoid repeated commits during large operations.

## License
GPL-2.0-only — see `LICENSE`.
