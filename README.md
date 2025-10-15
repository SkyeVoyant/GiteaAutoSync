# Gitea Autosync

Continuously mirror a directory of projects into any self-hosted Gitea instance.  
Each subdirectory is treated as a Git repository; the tool initialises Git if needed, ensures the repository exists on Gitea, commits the working tree, and pushes the result.

## Setup

1. **Generate a personal access token** (scopes: `write:user`, `write:repository`) for the Gitea account that will own the mirrored repositories.
2. **Copy the environment template** and fill in the token and base URL:
   ```bash
   cd /path/to/projects/giteaautosync
   cp .env.example .env
   ```
   Recommended values:
   ```dotenv
   GITEA_BASE_URL=https://gitea.example.com
   GITEA_OWNER=<username>
   GITEA_TOKEN=<your token>
   PROJECTS_ROOT=/path/to/projects
   SYNC_INTERVAL_MINUTES=0
   SYNC_DEBOUNCE_MS=5000
   ```
4. **Install dependencies once**:
   ```bash
   npm install
   ```

## Usage

- **Run a single sync pass:**
  ```bash
  npm start
  ```
- **Run continuously:** set `SYNC_INTERVAL_MINUTES` in `.env` to the desired interval (e.g. `15`), then start watch mode:
  ```bash
  npm run start:watch
  ```

The script will:
- Skip hidden folders and create `<owner>/<folder-name>` repos on the target Gitea server.
- Auto-create `.gitignore` files (ignoring `node_modules`, `backup`, builds, logs, etc.).
- Strip nested `.git` directories so everything is pushed as flat content.
- Auto-stage, commit (`Auto backup <timestamp>`), and push each project. Existing history on Gitea is force-updated when the local tree is rebuilt.

## Tips

- Secrets belong in `.env` (which is git-ignored). Rotate tokens regularly if the repository is public.
- `npm start` performs a one-off backup; run it from cron/systemd if you prefer scheduled snapshots.
- `npm run start:watch` watches the filesystem and only syncs the project that changed. Adjust `SYNC_DEBOUNCE_MS` if you need faster or slower reactions. Small edits are pushed immediately, followed by a background full-project reconciliation.
- Extend `.gitignore` if your projects emit additional cache/build folders that you do not want mirrored.
- Customize `ignoreconfig.json` (or set `IGNORE_CONFIG_PATH`) to control which patterns are added to new repositories’ `.gitignore` files.
- Set `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` if you want mirrored commits to carry your own identity (use an address verified with your Git host to show your avatar).

### Optional: Kubernetes deployment

The sample manifest under `k3s/giteaautosync` expects an SSH deploy key secret so the pod can clone this repository. Create the secret manually (do **not** commit the key) before applying the manifests:

```bash
ssh-keyscan github.com > github_known_hosts
kubectl create secret generic default-github-ssh \
  --namespace default \
  --from-file=id_rsa=/path/to/github_deploy_key \
  --from-file=known_hosts=github_known_hosts
```

Use a deploy key or dedicated machine account with read access to the repository you are cloning.

### Optional: Docker deployment

Build and run with Docker Compose:

```bash
docker compose up -d
```

By default the compose file expects a `projects/` directory alongside the source tree. You can override environment values at runtime:

```bash
GITEA_BASE_URL=https://gitea.example.com \
GITEA_OWNER=my-user \
GITEA_TOKEN=$(cat token.txt) \
docker compose up -d --build
```

The container launches `npm run start:watch`, so it reacts to file changes immediately.
