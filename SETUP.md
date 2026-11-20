# Ope' Code Vault

This is a local-only learning library for saving code, text notes, and attached files, including images and videos.

## Run locally

Keep the app files together and start a local web server from this folder:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/` in your browser. The app stores entries and attachments in that browser on that device using IndexedDB. It does not sign in, connect to Google Drive, use Supabase, or send content to an AI service.

## Backups and storage

- Use **Settings & backup** to export or import a JSON backup. JSON backups include entry text and code, but not attached files; download important attachments separately.
- The app keeps automatic restore points on this device. These do not protect against cleared browser data or device loss.
- Browser storage is not encrypted by this app and may be cleared by the browser or device. Export backups regularly.
- The app supports up to 20 files per entry, 250 MB per file, and 500 MB per entry. Actual browser storage limits vary by device.

The GitHub Pages build is a static copy of this app. Browser storage is separate for each browser profile and site address; data on localhost does not automatically appear on the published site.
