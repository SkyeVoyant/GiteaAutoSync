# Catflix

Catflix is a self-hosted HLS streaming platform for your personal movie and TV library.  
It scans your media folders, enriches titles with TMDb metadata, and automatically re-encodes sources into HLS playlists so you can stream privately from any browser while a dedicated FFmpeg worker handles transcoding in the background.

<img src="https://github.com/user-attachments/assets/126ebe11-2990-4ba0-bc9d-82d54e8f70fb" width="100%">
<div style="display:flex; justify-content:center; gap:4px;">
  <img src="https://github.com/user-attachments/assets/f79250ac-0411-41cc-a4af-9064ef7e0016" width="49.75%">
  <img src="https://github.com/user-attachments/assets/94410c9c-087d-4c28-a4b5-9be2a57fb011" width="49.75%">
</div>

## Stack Overview
- **catflix_backend/** – Express API, media library scanner, metadata sync, download/remux endpoints, and HLS manifest publishing
- **catflix_encoding/** – FFmpeg worker that converts detected files into HLS playlists and notifies the backend when manifests are ready
- **catflix_frontend/** – React single-page app distributed as a static build for browsing and playback
- **docker-compose.yml** – Orchestrates the web app (`catflix-app`) and encoder (`catflix-encoder`)

## Frontend Features
- Search and filter by type (movies vs shows), genres, release year, and sort order (title or release date).
- Track favourites with one-click starring and quick access from a dedicated section.
- Automatically builds "Recently Added" and "Continue Watching"/recently watched carousels.
- Remembers playback position, volume, and resumes seamlessly in supported browsers.
- Presents TMDb-powered title pages with trailers, cast details, seasons/episodes, and download options.
- Supports native and HLS.js playback with subtitles (hook ready for future subtitle endpoint).
- Automatic rating translation: converts TV ratings (TV-MA, TV-14, etc.) to familiar movie ratings (R, PG-13, etc.) with full descriptions.

## Requirements
- Docker Engine (Linux host, WSL2, or a Linux VM)
- Docker Compose v2
- PostgreSQL 13+ (local container or existing server)
- TMDb API key (free account)
- Media library reachable from the Docker host

## Database Setup
Catflix expects a PostgreSQL database named `CatFlixDB` (defaults can be changed through `.env`).  
On startup the backend **creates every required table and index automatically** if they do not already exist, so you only need to provision the database and credentials.

### Option 1 – Dockerised Postgres
Create `postgres-compose.yml` (or add to an existing stack):

```yaml
services:
  catflix-db:
    image: postgres:16-alpine
    container_name: CatFlixDB
    restart: unless-stopped
    environment:
      POSTGRES_DB: CatFlixDB
      POSTGRES_USER: catflix
      POSTGRES_PASSWORD: catflix
    ports:
      - "5434:5432"
    volumes:
      - ./catflix-db-data:/var/lib/postgresql/data
    networks:
      - catflix-net

networks:
  catflix-net:
    external: true
```

Spin it up with:

```bash
docker network create catflix-net   # once per host
docker compose -f postgres-compose.yml up -d
```

### Option 2 – Existing PostgreSQL Server
Log in as an admin user and run:

```sql
CREATE DATABASE "CatFlixDB";
CREATE USER catflix WITH PASSWORD 'catflix';
GRANT ALL PRIVILEGES ON DATABASE "CatFlixDB" TO catflix;
```

Adjust names if you prefer different credentials; just reflect them in `.env`.  
The backend will take care of creating the tables (`movies`, `movie_files`, `shows`, `seasons`, `episodes`) the first time it connects.

## Environment Configuration
Duplicate the sample file and edit the values to match your setup:

```bash
cp .env.example .env
```

Important keys:
- `PASSWORD` – UI login password
- `TMDB_API_KEY` – TMDb token used for metadata requests
- `MEDIA_DIR` / `MEDIA_MOUNT_SOURCE` – host path to your media (Windows paths are accepted)
- `INTERNAL_API_KEY` – shared secret between backend and encoder notifications (keep the same value for both containers)
- `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` – connection info for PostgreSQL
- `HLS_*` knobs – advanced FFmpeg/transcoder settings (defaults work well for most setups)

### Getting a TMDb API Key
TMDb offers free API access for personal, non-commercial projects.

1. Create or sign in to an account at [themoviedb.org](https://www.themoviedb.org/signup).
2. Verify your email address if prompted.
3. Visit your account settings → **API** tab and request an API key (choose the “Developer” option).
4. Copy the **API Key (v3 auth)** value into `TMDB_API_KEY` in your `.env` file.

## Media Library Layout
Catflix expects a simple folder structure so it can recognise movies and episodic content and generate the correct HLS manifests:

```
MEDIA_DIR/
├── movies/
│   ├── Movie Title (Year)/
│   │   ├── Movie Title (Year).mkv
│   │   └── ...
│   └── Another Movie/
│       └── Another Movie.mp4
└── shows/
    ├── Show Title/
    │   ├── Season 01/
    │   │   ├── Show Title - S01E01.mkv
    │   │   ├── Show Title - S01E02.mkv
    │   │   └── ...
    │   └── Season 02/
    │       └── Show Title - S02E01.mkv
    └── Another Show/
        └── Season 01/
            └── Episode 01.mp4
```

- Movies and shows must live under separate top-level folders (`movies/` and `shows/`).
- Place every movie inside its own subdirectory; the encoder assumes this layout and may fail to process loose files dropped directly under `movies/`.
- Shows should be split by season; Catflix uses the season folder name and the file name to infer episode numbering.
- Any existing HLS output (`.m3u8`, `.ts`) inside these directories will be picked up automatically; otherwise the encoder will generate them on demand.

## Backup Manifest System

Catflix features a dual-manifest system that provides instant access to all media content:

### How It Works
- **Primary Manifest (HLS)**: Contains `.m3u8` playlist files for optimized adaptive bitrate streaming
- **Backup Manifest (Direct)**: Contains original video files (`.mp4`, `.mkv`, `.avi`, `.mov`, `.m4v`, `.webm`)
- **Smart Merging**: Automatically prioritizes HLS when available, falls back to direct video file playback when HLS encoding isn't complete

### Benefits
- **Instant Library Access**: All content appears immediately, even before HLS encoding finishes
- **Seamless Upgrades**: Videos automatically switch to HLS streaming once encoding completes
- **Better User Experience**: No waiting for encoding before watching content
- **Clear Visibility**: Console logs show HLS count vs backup count vs total: `[media-cache] Manifest built: HLS=45, Backup=123, Total=168`

Each video item includes a `sourceType` field (`'hls'` or `'direct'`) so the frontend can optimize playback accordingly.

### Supported Formats
HLS streaming is prioritized for optimal performance, but direct playback supports: MP4, MKV, MOV, AVI, M4V, and WEBM files.

## Age Rating Translation

The frontend automatically translates TV ratings to standardized movie ratings for clarity:

| TV Rating | Displayed As | Meaning |
|-----------|--------------|---------|
| TV-Y, TV-Y7, TV-G | **G (General Audiences)** | All ages appropriate |
| TV-PG | **PG (Parental Guidance Suggested)** | Some material may not be suitable for children |
| TV-14 | **PG-13 (Parents Strongly Cautioned)** | Some material may be inappropriate for children under 13 |
| TV-MA | **R (Restricted)** | Under 17 requires accompanying parent or adult guardian |

Movie ratings (G, PG, PG-13, R, NC-17) are displayed with their full descriptions as well. This provides consistent, easy-to-understand age ratings across all content.

## Run with Docker Compose
1. Clone the repo
   ```bash
   git clone https://github.com/SkyeVoyant/Catflix.git
   cd Catflix
   ```
2. Ensure the shared Docker network and PostgreSQL service exist (see “Database Setup” above):  
   ```bash
   docker network create catflix-net   # skip if it already exists
   ```  
   and either start the bundled Postgres container or point to an existing server.
3. Configure `.env` as described. In particular:
   - Set `MEDIA_DIR` / `MEDIA_MOUNT_SOURCE` to match your environment (e.g., `D:\Media` + `/mnt/d/Media` on Windows/WSL, `/srv/media` on native Linux).
   - Fill in the TMDb key and database credentials you created earlier.
4. Launch the stack
   ```bash
   docker compose up -d --build
   ```
5. Open `http://localhost:3004`, sign in with the password you set, and the library will begin scanning.  
   The backend logs confirm the schema check and media refresh on first boot.

## Daily Operations
- Pause encoding to save CPU: `docker compose stop catflix-encoder`
- Resume encoding: `docker compose start catflix-encoder`
- Tail logs:
  - Backend: `docker compose logs -f catflix-app`
  - Encoder: `docker compose logs -f catflix-encoder`
- Trigger a manual rescan: `docker compose restart catflix-app`
- Back up the database: snapshot the Postgres data volume or run `pg_dump` using the credentials in `.env`

## Troubleshooting
- **Cannot connect to database** – double-check the values under the database block in `.env`; the backend will log connection failures before exiting.
- **Library appears empty** – ensure `MEDIA_DIR` points to a path mounted into the containers and that the user running Docker has read access.
- **Metadata missing** – revalidate your TMDb key (`TMDB_API_KEY`) and inspect backend logs for TMDb rate-limit warnings.
- **Encoder idle** – check `catflix-encoder` logs; the worker reports when media paths are missing or jobs are already processed.

## Developing Without Docker
- Install dependencies:  
  `pnpm install` in `catflix_backend/` (also installs shared deps for `catflix_encoding/`), `pnpm install` in `catflix_frontend/`
- Start services:
  - Backend: `pnpm start` inside `catflix_backend/`
  - Encoder: `node ../catflix_encoding/index.js`
  - Frontend (dev server): `pnpm start` inside `catflix_frontend/`
- Ensure PostgreSQL and the `.env` file are available; the backend will still perform schema creation on launch.

## License
GPL-2.0-only
