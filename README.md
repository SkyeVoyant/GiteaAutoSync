# Gitea Autosync (Open Source)

**Simple, automatic backup system for your projects to Gitea.**

Monitors your project folders and automatically commits + pushes changes to Gitea as they happen. No complex configuration, just point it at your projects folder and go.

## What it does

1. **Detects changes** in your projects folder
2. **Commits to git** with a timestamp
3. **Syncs to Gitea** automatically
4. **Full sync on startup** to catch everything

That's it. Simple, reliable backups.

## Features
- Auto-discovers all projects in your projects folder
- Creates Gitea repos automatically if they don't exist
- Watches for file changes and syncs within seconds
- Simple debouncing to batch rapid changes
- Local repo is always authoritative (force pushes if needed)
- Lightweight and fast

## Prerequisites
- Node.js 18+ and Git
- Gitea personal access token (`write:user`, `write:repository`)
- Read access to the directories you want mirrored (e.g. `/projects`, `/projects_archive`)

## Quick start

1) **Install and configure**
```bash
cd giteaautosync
npm install
cp .env.example .env
# Edit .env with your Gitea URL, token, and projects path
```

2) **Run**
```bash
# One-time sync
npm start

# Watch mode (monitors for changes)
npm run start:watch
```

## Configuration

Create a `.env` file with these required settings:

```bash
GITEA_BASE_URL=https://gitea.example.com
GITEA_TOKEN=your_access_token_here
GITEA_OWNER=your_username
PROJECTS_ROOT=/path/to/your/projects
```

Optional settings:
- `SYNC_DEBOUNCE_MS` - Wait time before syncing changes (default: 3000ms)
- `GIT_AUTHOR_NAME` - Commit author name (default: "Gitea Autosync")
- `GIT_AUTHOR_EMAIL` - Commit author email (default: "autosync@example.com")

## How it works

- Each folder in `PROJECTS_ROOT` becomes a separate Git repository
- Changes are detected automatically when watching
- Multiple rapid changes are batched together (debounced)
- Each project syncs independently
- Force pushes when needed (local is always authoritative)

## Docker Compose

```bash
docker compose up -d --build
```

Update the `.env` file or `docker-compose.yml` environment section with your settings.

## Troubleshooting

**No changes being committed?**
- Check that files aren't in the ignored patterns (node_modules, dist, etc.)
- Verify the watcher is running with `--watch` flag
- Check console for "Change detected" messages

**Push failures?**
- Verify `GITEA_TOKEN` has correct permissions
- Check `GITEA_BASE_URL` is correct (no trailing slash)
- Ensure `GITEA_OWNER` matches your username/org

**Too many commits?**
- Increase `SYNC_DEBOUNCE_MS` to batch changes over a longer period

## License
GPL-2.0-only — see `LICENSE`.
