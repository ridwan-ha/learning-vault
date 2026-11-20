"use strict";

(() => {
  const DATABASE_NAME = "ope-code-vault-data";
  const DATABASE_VERSION = 4;
  const LEGACY_STORE = "records";
  const CURRENT_KEY = "lesson-library";
  const SNAPSHOT_PREFIX = "snapshot:";
  const MAX_SNAPSHOTS = 30;
  let databasePromise;
  let storageMode = "indexeddb";

  function openDatabase() {
    if (!("indexedDB" in window)) {
      storageMode = "localstorage";
      return Promise.resolve(null);
    }
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(LEGACY_STORE)) {
            database.createObjectStore(LEGACY_STORE, { keyPath: "key" });
          }
          if (!database.objectStoreNames.contains("entries")) {
            database.createObjectStore("entries", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("code")) {
            database.createObjectStore("code", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("attachments")) {
            const attachments = database.createObjectStore("attachments", { keyPath: "id" });
            attachments.createIndex("entryId", "entryId", { unique: false });
          }
          if (!database.objectStoreNames.contains("meta")) {
            database.createObjectStore("meta", { keyPath: "key" });
          }
          if (!database.objectStoreNames.contains("snapshots")) {
            const snapshots = database.createObjectStore("snapshots", { keyPath: "id" });
            snapshots.createIndex("savedAt", "savedAt", { unique: false });
          }
          if (!database.objectStoreNames.contains("snapshotFiles")) {
            const snapshotFiles = database.createObjectStore("snapshotFiles", { keyPath: "id" });
            snapshotFiles.createIndex("snapshotId", "snapshotId", { unique: false });
          }
          if (!database.objectStoreNames.contains("attachmentBlobs")) {
            database.createObjectStore("attachmentBlobs", { keyPath: "id" });
          }
        };
        request.onsuccess = () => {
          const database = request.result;
          database.onversionchange = () => database.close();
          resolve(database);
        };
        request.onerror = () => reject(request.error || new Error("Could not open browser lesson storage."));
        request.onblocked = () => reject(new Error("Lesson storage is blocked by another open app tab. Close other tabs and retry."));
      }).catch((error) => {
        databasePromise = null;
        throw error;
      });
    }
    return databasePromise;
  }

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Browser storage request failed."));
    });
  }

  function randomId() {
    return window.crypto && typeof window.crypto.randomUUID === "function"
      ? window.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function withoutCode(lesson) {
    const { code, ...metadata } = lesson;
    return metadata;
  }

  async function load() {
    const database = await openDatabase();
    if (!database) {
      try {
        const text = localStorage.getItem("java-vault-library-v1");
        return text ? JSON.parse(text) : null;
      } catch (error) {
        throw new Error(`Local browser storage could not be read: ${error.message}`);
      }
    }

    const transaction = database.transaction([LEGACY_STORE, "entries", "meta"], "readonly");
    const entriesRequest = transaction.objectStore("entries").getAll();
    const deletedRequest = transaction.objectStore("meta").get("deletedIds");
    const oldRequest = transaction.objectStore(LEGACY_STORE).get(CURRENT_KEY);
    const [entries, deleted, old] = await Promise.all([
      requestResult(entriesRequest),
      requestResult(deletedRequest),
      requestResult(oldRequest)
    ]);

    if (entries.length) {
      return {
        schemaVersion: 1,
        lessons: entries,
        deletedIds: deleted ? deleted.value : {}
      };
    }
    if (old && old.value) {
      const library = old.value;
      if (!library || library.schemaVersion !== 1 || !Array.isArray(library.lessons)) return library;
      await new Promise((resolve, reject) => {
        const migration = database.transaction(["entries", "code", "meta"], "readwrite");
        const entryStore = migration.objectStore("entries");
        const codeStore = migration.objectStore("code");
        library.lessons.forEach((lesson) => {
          if (lesson && typeof lesson.id === "string") {
            entryStore.put(withoutCode(lesson));
            if (typeof lesson.code === "string") codeStore.put({ id: lesson.id, text: lesson.code });
          }
        });
        migration.objectStore("meta").put({ key: "deletedIds", value: library.deletedIds || {} });
        migration.oncomplete = resolve;
        migration.onerror = () => reject(migration.error || new Error("Existing lessons could not be migrated."));
        migration.onabort = () => reject(migration.error || new Error("Existing lesson migration was cancelled."));
      });
      return {
        ...library,
        lessons: library.lessons.map(withoutCode)
      };
    }

    return null;
  }

  async function snapshots() {
    const database = await openDatabase();
    if (!database) return [];
    const transaction = database.transaction(["snapshots", LEGACY_STORE], "readonly");
    const currentRequest = transaction.objectStore("snapshots").getAll();
    const legacyKeysRequest = transaction.objectStore(LEGACY_STORE).getAllKeys();
    const [records, legacyKeys] = await Promise.all([requestResult(currentRequest), requestResult(legacyKeysRequest)]);
    const legacySnapshots = legacyKeys
      .filter((key) => typeof key === "string" && key.startsWith(SNAPSHOT_PREFIX))
      .map((key) => {
        const timestamp = Number(key.slice(SNAPSHOT_PREFIX.length).split("-")[0]);
        return {
          id: `legacy:${key}`,
          entryId: "",
          entryTitle: "Older full-library restore point",
          savedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : ""
        };
      });
    return [...records
      .sort((left, right) => right.savedAt.localeCompare(left.savedAt))
      .map(({ id, entryId, entryTitle, savedAt }) => ({ id, entryId, entryTitle, savedAt })),
    ...legacySnapshots].sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  async function restoreSnapshot(snapshotId) {
    const database = await openDatabase();
    if (!database) throw new Error("Automatic restore points are unavailable in this browser.");
    if (snapshotId.startsWith("legacy:")) {
      const readTransaction = database.transaction(LEGACY_STORE, "readonly");
      const legacy = await requestResult(readTransaction.objectStore(LEGACY_STORE).get(snapshotId.slice("legacy:".length)));
      if (!legacy || !legacy.value) throw new Error("That older restore point could not be found.");
      return { type: "library", library: legacy.value };
    }
    const readTransaction = database.transaction("snapshots", "readonly");
    const snapshot = await requestResult(readTransaction.objectStore("snapshots").get(snapshotId));
    if (snapshot && snapshot.value && snapshot.value.schemaVersion === 2 && snapshot.value.entry) {
      const filesTransaction = database.transaction("snapshotFiles", "readonly");
      const archivedRecords = await requestResult(filesTransaction.objectStore("snapshotFiles").index("snapshotId").getAll(snapshotId));
      return {
        type: "entry",
        entry: snapshot.value.entry,
        attachments: archivedRecords.map(({ file }) => file)
      };
    }
    throw new Error("That restore point could not be found or has an unsupported format.");
  }

  async function getCode(id) {
    const database = await openDatabase();
    if (!database) {
      const text = localStorage.getItem("java-vault-library-v1");
      if (!text) return "";
      const library = JSON.parse(text);
      const lesson = Array.isArray(library.lessons) ? library.lessons.find((item) => item.id === id) : null;
      return lesson && typeof lesson.code === "string" ? lesson.code : "";
    }
    const transaction = database.transaction("code", "readonly");
    const record = await requestResult(transaction.objectStore("code").get(id));
    return record ? record.text : "";
  }

  async function getCodes(ids) {
    const database = await openDatabase();
    if (!database) {
      const text = localStorage.getItem("java-vault-library-v1");
      if (!text) return new Map();
      const library = JSON.parse(text);
      if (!Array.isArray(library.lessons)) throw new Error("The saved library has an invalid format.");
      const requestedIds = new Set(ids);
      return new Map(library.lessons
        .filter((lesson) => requestedIds.has(lesson.id) && typeof lesson.code === "string")
        .map((lesson) => [lesson.id, lesson.code]));
    }
    const transaction = database.transaction("code", "readonly");
    const store = transaction.objectStore("code");
    const values = await Promise.all(ids.map((id) => requestResult(store.get(id))));
    return new Map(values.filter(Boolean).map((record) => [record.id, record.text]));
  }

  async function listAttachments(entryId) {
    const database = await openDatabase();
    if (!database) return [];
    const transaction = database.transaction("attachments", "readonly");
    const records = await requestResult(transaction.objectStore("attachments").index("entryId").getAll(entryId));
    return records;
  }

  async function getAttachment(id) {
    const database = await openDatabase();
    if (!database) throw new Error("File attachments are unavailable in this browser.");
    const transaction = database.transaction("attachmentBlobs", "readonly");
    const record = await requestResult(transaction.objectStore("attachmentBlobs").get(id));
    if (!record) throw new Error("That file could not be found in local storage.");
    return record.blob;
  }

  async function save(value, previousLessons = [], addedFiles = [], removedAttachmentIds = []) {
    const database = await openDatabase();
    if (!database) {
      if (addedFiles.length || removedAttachmentIds.length) {
        throw new Error("This browser does not support local file attachments. No files were saved.");
      }
      try {
        localStorage.setItem("java-vault-library-v1", JSON.stringify(value));
        return;
      } catch (error) {
        throw new Error(`Browser storage could not save your lessons: ${error.message}`);
      }
    }

    const previousById = new Map(previousLessons.map((lesson) => [lesson.id, lesson]));
    const nextById = new Map(value.lessons.map((lesson) => [lesson.id, lesson]));
    const changed = value.lessons.filter((lesson) => previousById.get(lesson.id) !== lesson);
    const removed = previousLessons.filter((lesson) => !nextById.has(lesson.id));
    const entryIds = new Set([
      ...changed.map((lesson) => lesson.id),
      ...addedFiles.map((item) => item.entryId)
    ]);

    await new Promise((resolve, reject) => {
      const storeNames = ["entries", "code", "attachments", "attachmentBlobs", "meta", "snapshots", "snapshotFiles"];
      const transaction = database.transaction(storeNames, "readwrite");
      const entries = transaction.objectStore("entries");
      const codes = transaction.objectStore("code");
      const attachments = transaction.objectStore("attachments");
      const attachmentBlobs = transaction.objectStore("attachmentBlobs");
      const meta = transaction.objectStore("meta");
      const snapshotStore = transaction.objectStore("snapshots");
      const snapshotFiles = transaction.objectStore("snapshotFiles");
      const work = [];

      entryIds.forEach((id) => {
        const oldLesson = previousById.get(id);
        if (oldLesson) {
          const archivedIds = removedAttachmentIds.filter((attachmentId) => (oldLesson.attachmentIds || []).includes(attachmentId));
          work.push(Promise.all([
            requestResult(codes.get(id)),
            Promise.all(archivedIds.map(async (attachmentId) => {
              const [metadata, storedBlob] = await Promise.all([
                requestResult(attachments.get(attachmentId)),
                requestResult(attachmentBlobs.get(attachmentId))
              ]);
              return metadata && storedBlob ? { ...metadata, blob: storedBlob.blob } : null;
            }))
          ]).then(([oldCode, archivedFiles]) => {
            const snapshotId = randomId();
            snapshotStore.put({
              id: snapshotId,
              value: {
                schemaVersion: 2,
                entry: { ...oldLesson, code: oldCode ? oldCode.text : "" },
                attachments: archivedFiles.filter(Boolean).map(({ blob, ...metadata }) => metadata)
              },
              entryId: id,
              entryTitle: oldLesson.title || "Untitled entry",
              savedAt: new Date().toISOString()
            });
            archivedFiles.filter(Boolean).forEach((file) => {
              snapshotFiles.put({ id: file.id, snapshotId, file });
            });
          }));
        }
      });

      changed.forEach((lesson) => {
        entries.put(withoutCode(lesson));
        if (Object.prototype.hasOwnProperty.call(lesson, "code")) {
          codes.put({ id: lesson.id, text: lesson.code || "" });
        } else if (lesson.entryType !== "code") codes.delete(lesson.id);
      });
      removed.forEach((lesson) => {
        entries.delete(lesson.id);
        const attachmentIds = lesson.attachmentIds || [];
        work.push(Promise.all([
          Promise.all(attachmentIds.map(async (id) => {
            const [metadata, storedBlob] = await Promise.all([
              requestResult(attachments.get(id)),
              requestResult(attachmentBlobs.get(id))
            ]);
            return metadata && storedBlob ? { ...metadata, blob: storedBlob.blob } : null;
          })),
          requestResult(codes.get(lesson.id))
        ]).then(([archivedFiles, oldCode]) => {
          const snapshotId = randomId();
          snapshotStore.put({
            id: snapshotId,
            value: {
              schemaVersion: 2,
              entry: { ...lesson, code: oldCode ? oldCode.text : "" },
              attachments: archivedFiles.filter(Boolean).map(({ blob, ...metadata }) => metadata)
            },
            entryId: lesson.id,
            entryTitle: lesson.title || "Untitled entry",
            savedAt: new Date().toISOString()
          });
          archivedFiles.filter(Boolean).forEach((file) => {
            snapshotFiles.put({ id: file.id, snapshotId, file });
          });
          attachmentIds.forEach((id) => attachments.delete(id));
          attachmentIds.forEach((id) => attachmentBlobs.delete(id));
          codes.delete(lesson.id);
        }));
      });
      addedFiles.forEach(({ id, entryId, file }) => {
        const attachmentId = id || randomId();
        attachments.put({
          id: attachmentId,
          entryId,
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          createdAt: new Date().toISOString()
        });
        attachmentBlobs.put({ id: attachmentId, blob: file });
      });
      removedAttachmentIds.forEach((id) => {
        attachments.delete(id);
        attachmentBlobs.delete(id);
      });
      meta.put({ key: "deletedIds", value: value.deletedIds || {} });
      Promise.all(work).then(() => {
        const snapshotCount = snapshotStore.count();
        snapshotCount.onsuccess = () => {
          let excess = Math.max(0, snapshotCount.result - MAX_SNAPSHOTS);
          if (!excess) return;
          const cursorRequest = snapshotStore.index("savedAt").openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor || !excess) return;
            const snapshotId = cursor.value.id;
            const fileKeys = snapshotFiles.index("snapshotId").getAllKeys(snapshotId);
            fileKeys.onsuccess = () => fileKeys.result.forEach((key) => snapshotFiles.delete(key));
            cursor.delete();
            excess -= 1;
            cursor.continue();
          };
        };
      }).catch(() => transaction.abort());
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error("Saving lesson data failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Saving lesson data was cancelled."));
    });
  }

  async function estimate() {
    if (!navigator.storage || typeof navigator.storage.estimate !== "function") return null;
    const result = await navigator.storage.estimate();
    return {
      usage: Number.isFinite(result.usage) ? result.usage : 0,
      quota: Number.isFinite(result.quota) ? result.quota : 0
    };
  }

  async function requestPersistentStorage() {
    if (!navigator.storage || typeof navigator.storage.persist !== "function") return false;
    return navigator.storage.persist();
  }

  async function isPersistent() {
    if (!navigator.storage || typeof navigator.storage.persisted !== "function") return null;
    return navigator.storage.persisted();
  }

  window.VaultStorage = Object.freeze({
    load,
    save,
    snapshots,
    restoreSnapshot,
    getCode,
    getCodes,
    listAttachments,
    getAttachment,
    requestPersistentStorage,
    isPersistent,
    estimate,
    get mode() {
      return storageMode;
    }
  });
})();
