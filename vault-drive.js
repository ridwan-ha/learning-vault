"use strict";

(() => {
  const FOLDER_MARKER = "opeVault";
  const FOLDER_VALUE = "learning-library-v1";
  const API_ROOT = "https://www.googleapis.com/drive/v3";
  const UPLOAD_ROOT = "https://www.googleapis.com/upload/drive/v3";
  const FOLDER_MIME = "application/vnd.google-apps.folder";
  const FIELDS = "id,name,mimeType,size,modifiedTime,webViewLink,appProperties,parents,trashed";
  let accessToken = "";
  let tokenExpiresAt = 0;
  let tokenPending = null;
  let tokenProvider = null;
  let folderId = "";
  let accountEmail = "";
  let linked = false;

  function setTokenProvider(provider) {
    if (typeof provider !== "function") throw new Error("A secure Google Drive token provider is required.");
    tokenProvider = provider;
    accessToken = "";
    tokenExpiresAt = 0;
    folderId = "";
    accountEmail = "";
    linked = false;
  }

  function getRemembered() {
    return linked;
  }

  function remember(value) {
    linked = Boolean(value);
  }

  async function requestToken() {
    if (!tokenProvider) throw new Error("Secure Drive sign-in is not configured. Reload the app and try again.");
    if (tokenPending) return tokenPending;
    tokenPending = Promise.resolve().then(() => tokenProvider()).then((result) => {
      if (!result || typeof result.access_token !== "string" || !result.access_token) {
        throw new Error("The secure Drive service did not return an access token.");
      }
      const expiresIn = Number(result.expires_in);
      if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        throw new Error("The secure Drive service returned an invalid token expiry.");
      }
      accessToken = result.access_token;
      tokenExpiresAt = Date.now() + expiresIn * 1000;
      accountEmail = typeof result.email === "string" ? result.email : "";
      linked = true;
      return accessToken;
    }).finally(() => {
      tokenPending = null;
    });
    return tokenPending;
  }

  async function tryRememberedSession() {
    if (!tokenProvider) return false;
    try {
      await requestToken();
      return true;
    } catch {
      accessToken = "";
      tokenExpiresAt = 0;
      linked = false;
      return false;
    }
  }

  async function requireToken() {
    if (accessToken && tokenExpiresAt > Date.now() + 60000) return accessToken;
    try {
      return await requestToken();
    } catch (error) {
      accessToken = "";
      tokenExpiresAt = 0;
      const detail = error && error.message ? ` ${error.message}` : "";
      throw new Error(`Could not renew Google Drive access.${detail}`);
    }
  }

  async function apiFetch(url, options = {}) {
    const token = await requireToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(url, { ...options, headers });
    if (response.status === 401) {
      accessToken = "";
      tokenExpiresAt = 0;
      throw new Error("Google Drive authorization expired. Reconnect Drive and try again.");
    }
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 400);
      throw new Error(`Google Drive returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response;
  }

  async function listFiles(parentId = "") {
    const allFiles = [];
    let pageToken = "";
    do {
      const query = parentId
        ? `'${parentId.replace(/'/g, "\\'")}' in parents and trashed = false`
        : `appProperties has { key='${FOLDER_MARKER}' and value='${FOLDER_VALUE}' } and mimeType='${FOLDER_MIME}' and trashed=false`;
      const params = new URLSearchParams({
        q: query,
        pageSize: "1000",
        orderBy: "name",
        fields: `nextPageToken,files(${FIELDS})`
      });
      if (pageToken) params.set("pageToken", pageToken);
      const response = await apiFetch(`${API_ROOT}/files?${params}`);
      const result = await response.json();
      allFiles.push(...(result.files || []));
      pageToken = result.nextPageToken || "";
    } while (pageToken);
    return allFiles;
  }

  async function getFolderId() {
    if (folderId) return folderId;
    const folders = await listFiles();
    if (folders.length) {
      folderId = folders[0].id;
      return folderId;
    }
    const response = await apiFetch(`${API_ROOT}/files?fields=${encodeURIComponent(FIELDS)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Ope Code Vault",
        mimeType: FOLDER_MIME,
        appProperties: { [FOLDER_MARKER]: FOLDER_VALUE }
      })
    });
    folderId = (await response.json()).id;
    if (!folderId) throw new Error("Google Drive created a folder but returned no folder ID.");
    return folderId;
  }

  async function listVaultFiles() {
    const currentFolder = await getFolderId();
    return { folderId: currentFolder, files: await listFiles(currentFolder) };
  }

  async function getJson(fileId) {
    const response = await apiFetch(`${API_ROOT}/files/${encodeURIComponent(fileId)}?alt=media`);
    return response.json();
  }

  async function getBlob(fileId) {
    const response = await apiFetch(`${API_ROOT}/files/${encodeURIComponent(fileId)}?alt=media`);
    return response.blob();
  }

  async function uploadFile({ fileId = "", parentId, name, mimeType, appProperties = {}, blob }) {
    const metadata = {
      name,
      mimeType,
      appProperties,
      ...(fileId ? {} : { parents: [parentId] })
    };
    const url = fileId
      ? `${UPLOAD_ROOT}/files/${encodeURIComponent(fileId)}?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`
      : `${UPLOAD_ROOT}/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`;
    const start = await apiFetch(url, {
      method: fileId ? "PATCH" : "POST",
      headers: {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        "X-Upload-Content-Length": String(blob.size)
      },
      body: JSON.stringify(metadata)
    });
    const uploadUrl = start.headers.get("Location");
    if (!uploadUrl) throw new Error("Google Drive did not return a resumable upload URL.");
    const uploaded = await apiFetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: blob
    });
    return uploaded.json();
  }

  async function trashFile(fileId) {
    await apiFetch(`${API_ROOT}/files/${encodeURIComponent(fileId)}?fields=id,trashed`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true })
    });
  }

  function disconnect() {
    accessToken = "";
    tokenExpiresAt = 0;
    accountEmail = "";
    folderId = "";
    linked = false;
  }

  window.VaultDrive = Object.freeze({
    setTokenProvider,
    getRemembered,
    tryRememberedSession,
    listVaultFiles,
    getJson,
    getBlob,
    uploadFile,
    trashFile,
    disconnect,
    get email() {
      return accountEmail;
    },
    get connected() {
      return Boolean(accessToken && tokenExpiresAt > Date.now());
    }
  });
})();
