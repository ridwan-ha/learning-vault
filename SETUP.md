# Ope' Code Vault

This is a local-only learning library for saving code, text notes, and attached files, including images and videos.

## Run locally

Keep the app files together and start a local web server from this folder:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/` in your browser. The app stores entries and attachments in that browser on that device using IndexedDB. It does not sign in, connect to Google Drive, use Supabase, or send content to an AI service.

## Backups and storage

- Use **Settings & backup → Save full backup (.zip)** to save entries, code, and attached files together. On another device, open the app and choose **Load backup from this device**; on an empty library, use **Load a saved backup**.
- Older JSON backups can still be imported. They contain entry text and code, but not attachments.
- The app loads saved entries and files from the same browser and site address when reopened. Localhost, the published site, and different browsers/devices have separate storage; use a full ZIP backup to transfer data.
- The app requests persistent browser storage when supported. This helps protect against automatic eviction, but cannot prevent someone clearing site data, private browsing cleanup, device loss, or storage failure. Keep backups outside the browser.
- Browser storage is not encrypted by this app. The browser's storage limit varies by device.
- The app supports up to 20 files per entry, 250 MB per file, and 500 MB per entry. Actual browser storage limits vary by device.

The GitHub Pages build is a static copy of this app. Browser storage is separate for each browser profile and site address; data on localhost does not automatically appear on the published site.
