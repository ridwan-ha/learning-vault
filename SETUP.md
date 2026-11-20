# Ope' Code Vault setup and data protection

## Run the app locally

Keep the files in the same folder. From that folder, start a local web server:

```powershell
python -m http.server 8000
```

Open `http://localhost:8000/` in Chrome. To install it, use Chrome's **Install page as app** option. The app shell works offline after it has loaded once; Google sign-in and cloud sync require an internet connection.

## Google Drive as the primary cloud copy

The app opens without a Drive sign-in dialog. Choose **Connect Drive** or open **Settings & backup** when you want to connect or reconnect. After connecting, it creates a **visible `Ope Code Vault` folder** in Google Drive and manages only the files it creates there. Entry data, source code, and attachments sync to that folder; this browser also keeps a local offline copy.

Persistent Drive access requires the Supabase backend setup below. Supabase Auth keeps the app's user session across reloads. Google refresh tokens are sent to an authenticated Edge Function, encrypted with AES-GCM, and stored in a table inaccessible to browser roles. The browser does not persist Google's provider tokens. The backend exchanges the refresh token for short-lived access tokens when the app needs them. Drive sync requires internet access.

### Configure Google and deploy the Supabase backend

Use the existing project `qlfktmiqjjssrfhjfoyp`:

1. In [Google Cloud Console](https://console.cloud.google.com/), enable the **Google Drive API** and configure the OAuth consent screen. If the app is in testing mode, add the Google account as a test user. Add the Google `drive.file` scope (`https://www.googleapis.com/auth/drive.file`); this scope limits the app to files it creates rather than unrelated Drive files.
2. Create or use a **Web application** OAuth client. Set its authorized redirect URI to `https://qlfktmiqjjssrfhjfoyp.supabase.co/auth/v1/callback`.
3. In Supabase **Authentication → Providers → Google**, enable Google and enter that OAuth client ID and client secret. In **Authentication → URL Configuration**, set the Site URL and allow the exact app URL `https://ridwan-ha.github.io/learning-vault/`. Drive authorization always completes on this published URL. If started from a local copy, the app first switches to the published app because Supabase PKCE requires the OAuth flow to start and finish on the same origin.
4. Install the Supabase CLI and run these commands from the project folder:

   ```powershell
   supabase link --project-ref qlfktmiqjjssrfhjfoyp
   supabase db push
   supabase functions deploy drive-store-token
   supabase functions deploy drive-token
   supabase functions deploy drive-disconnect
   ```

   The migration creates only `vault_drive_credentials`; it does not touch lessons or existing Drive files. RLS is enabled and browser roles have no table access.
5. Add the same Google client ID and client secret as Supabase Edge Function secrets. Generate a separate 32-byte encryption key locally; do not send or commit it:

   ```powershell
   python -c "import secrets,base64; print(base64.b64encode(secrets.token_bytes(32)).decode())"
   supabase secrets set DRIVE_CLIENT_ID="your-client-id.apps.googleusercontent.com" DRIVE_CLIENT_SECRET="your-google-client-secret" DRIVE_TOKEN_ENCRYPTION_KEY="paste-the-generated-base64-key" APP_ORIGINS="https://ridwan-ha.github.io"
   ```

   The `APP_ORIGINS` value should contain only origins you use. Keep the encryption key backed up securely; replacing or losing it makes existing stored tokens unreadable, so users would need to connect Drive again. Supabase supplies the project URL and API keys to Edge Functions; the functions use the publishable key only to validate the signed-in user and the server-only secret key for database access. Never put the secret/service-role key in the app.
6. Deploy the updated static app. Choose **Connect Drive** once and approve the requested access. After that, a page reload should renew Drive access without reopening Google authorization. If consent is revoked or the refresh token becomes invalid, choose **Connect Drive** again.

You can disconnect in the app to delete the encrypted refresh token from the backend. This does not revoke the Google grant itself; revoke it separately from your Google Account if desired. Google OAuth projects left in **Testing** may issue refresh tokens that expire after seven days for scopes beyond basic identity; publish the consent screen for durable use and complete any applicable verification requirements. Consent/testing and verification rules can change, so follow current Google Cloud and Supabase instructions if either reports an issue.

The local development address and the published GitHub Pages URL have separate browser storage. If you have lessons saved only on localhost, export a backup there and import it on the published app before syncing.

### Google says the app is not verified

That warning comes from the Google OAuth consent-screen status, not from the missing per-device client-ID field or the redirect address. During testing, add your account under the consent screen's **Test users**. For general use, publish the consent screen and complete any Google verification it requires. In Google Cloud, the authorized OAuth redirect URI is the Supabase callback (`https://qlfktmiqjjssrfhjfoyp.supabase.co/auth/v1/callback`); the final return to the app is configured separately in Supabase's URL allow list. The local app switches to the published URL before starting OAuth so Supabase's PKCE flow starts and finishes on the same origin.

Google Drive quota is controlled by your Google account. Personal Google accounts generally share up to 15 GB across Drive, Gmail, and Photos; see [Google's storage details](https://support.google.com/drive/answer/6374270?hl=en) for current limits. OAuth consent/testing and verification requirements can change; consult the current Google Cloud instructions if the consent screen reports an issue.

The app synchronizes on connect, after local changes, when you return to the app, and when you choose **Sync now**. Drive file listings are scoped to the app folder. Removed attachments are unlinked from entries but are not automatically deleted from Drive, so restore points can still recover their references; manage old files in the Drive folder if you want to free space.

## Local lessons and recovery

- Entry details, code, and attachment files are stored separately in this browser profile using IndexedDB. Code is loaded only when you open or edit an entry, and ordinary saves update changed entries rather than rewriting the whole library. Existing `java-vault-library-v1` localStorage data is migrated on first launch and left in place as a legacy copy.
- The app supports code entries for common languages plus custom language names, text notes, and entries with attachments. Syntax highlighting is lightweight and only recognizes selected languages. Attachments are limited to 20 per entry, 250 MB per file, and 500 MB per entry; actual browser storage limits vary by device.
- Up to 30 recent entry-level restore points are kept on this device. Open **Settings & backup** to restore one. Older full-library restore points from previous versions are also offered when available.
- **Protect storage on this device** asks the browser not to automatically evict the app's local data. Browser/site data can still be cleared, and this does not protect against device loss.
- Export a JSON backup regularly and keep it outside this device. The JSON includes entry text and code but not attached files; download important attachments separately from their entries. Import merges matching lesson IDs; restoring an entry point replaces that entry, while restoring an older full-library point replaces the library after confirmation.
- Browser storage is not encrypted by this app and is not a substitute for a secure device account. Anyone with access to the browser profile may be able to access the lessons.

## Optional legacy Supabase lesson sync

The separate legacy **Sync now** feature can still sync lesson rows to Supabase. It is not needed for Drive. It requires the `vault_lessons` table and its user-scoped RLS policies; do not disable RLS or expose a service-role key. The Drive migration above does not create or alter that lesson table.

Supabase sync merges by lesson ID and latest update time; deletions are represented by tombstones so they can sync between devices. It does not sync attachments and is not the Drive file browser.

## Reminders and AI

- Reminder alerts work while the app is open. Some browsers support scheduled notifications after the app closes, but support and delivery are not guaranteed. The app checks overdue reminders when opened again.
- AI review sends the selected lesson to the AI endpoint you configure, only after confirmation. Remote endpoints can receive your code and notes; review provider privacy and billing terms before use.
- This is a local-first learning tool, not a managed commercial service. A public deployment still needs an appropriate privacy notice, support and recovery process, production OAuth settings, and regular security/dependency review.
