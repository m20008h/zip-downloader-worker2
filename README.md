# ZIP Downloader Worker

Cloudflare Worker that fetches files from HTTP URLs, zips them, and uploads to Backblaze B2.

## Features

- Fetches multiple files in parallel
- Creates ZIP archives (no compression, fastest)
- Uploads to Backblaze B2
- Built-in HTML UI in Hebrew
- No external dependencies
- CORS support

## Requirements

- Cloudflare Workers account
- Backblaze B2 account with API credentials

## Setup

### 1. Create a Cloudflare Worker

1. Go to https://dash.cloudflare.com
2. Click "Workers & Pages"
3. Create a new Worker
4. Paste the code from `worker.js`

### 2. Configure Backblaze B2 Secrets

Add the following secrets to your Worker:

- `B2_KEY_ID` - Your Backblaze B2 Key ID
- `B2_APP_KEY` - Your Backblaze B2 Application Key
- `B2_BUCKET_ID` - Your Backblaze B2 Bucket ID
- `B2_BUCKET_NAME` - Your Backblaze B2 Bucket Name

### 3. Deploy

Click "Deploy" in the Cloudflare Dashboard.

## Usage

### API Endpoints

- `POST /api/download` - Download files, zip them, and upload to B2
- `GET /api/health` - Health check endpoint
- `GET /` - HTML UI for manual usage

### POST /api/download

Request body:
```json
{
  "files": [
    {
      "url": "https://example.com/file1.pdf",
      "name": "file1.pdf"
    },
    {
      "url": "https://example.com/file2.jpg",
      "name": "file2.jpg"
    }
  ],
  "zipName": "my-files.zip"
}
```

Response:
```json
{
  "success": true,
  "zipName": "my-files.zip",
  "fileId": "file-id-here",
  "sizeBytes": 1234567,
  "fileCount": 2
}
```

### Limits

- Maximum 50 files per request
- Time limits apply (Cloudflare Workers CPU limits)
- Suitable for small to medium files

## Development

### Local Testing

Use `wrangler dev` for local development (requires Node.js and wrangler).

### API

The worker exports a default object with a `fetch` method that handles incoming requests.

## License

MIT
