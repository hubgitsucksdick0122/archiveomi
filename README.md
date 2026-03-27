# ArchiveOMI

Catbox-style file hosting backed by Google Cloud Storage, with a rotating anime waifu.

## Quick start

```bash
# 1. Clone
git clone https://github.com/hubgitsucksdick0122/archiveomi.git
cd archiveomi

# 2. Install dependencies
npm install

# 3. Add your GCP service account key (never commit this file)
#    Copy your service account JSON and save it as:
cp service-account.json.example service-account.json   # then fill in your credentials
#    OR set the environment variable:
#    export GCS_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'

# 4. Set your GCS bucket name
cp .env.example .env
#    Edit .env and set GCS_BUCKET_NAME=<your-bucket>

# 5. Start the server
npm start
# → http://localhost:3000
```

## Environment variables (see `.env.example`)

| Variable | Default | Description |
|---|---|---|
| `GCS_BUCKET_NAME` | `archiveomi-files` | GCS bucket to store uploads in |
| `GCS_KEY_FILE` | `./service-account.json` | Path to service account JSON key file |
| `GCS_SERVICE_ACCOUNT_JSON` | — | Full service account JSON as a single-line string (overrides `GCS_KEY_FILE`) |
| `PORT` | `3000` | HTTP port |

## Service account setup

1. Go to [GCP Console → IAM → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Create a service account with the **Storage Object Admin** role on your bucket
3. Download the JSON key and save it as `service-account.json` in the project root
4. `service-account.json` is gitignored and will never be committed

## Features

- **Upload** — drag & drop or click to browse; files saved to GCS
- **Gallery** — image thumbnails, emoji icons for other file types
- **Preview** — modal preview for images, video, audio, PDF, and text files
- **Download / Copy link / Delete** per file
- **Rotating anime waifu** — real image from [waifu.pics](https://waifu.pics); click to refresh
