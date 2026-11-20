"use strict";

(() => {
  const STORAGE_KEY = "java-vault-library-v1";
  const BACKUP_EXPORTED_KEY = "java-vault-last-backup-export-v1";
  const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
  const MAX_LESSONS = 5000;
  const MAX_FIELD_LENGTH = 200000;
  const STATUS_LABELS = { new: "New", review: "Review later", confident: "Confident" };
  const MAX_ATTACHMENT_FILE_BYTES = 250 * 1024 * 1024;
  const MAX_ENTRY_ATTACHMENT_BYTES = 500 * 1024 * 1024;
  const MAX_ENTRY_ATTACHMENTS = 20;

  const byId = (id) => document.getElementById(id);
  const state = {
    lessons: [],
    deletedIds: {},
    view: "overview",
    search: "",
    status: "all",
    sort: "newest",
    topic: "",
    selectedLessonId: null,
    storageBlocked: false,
    recoveryKey: null,
    recoveryMode: false,
    recoveryLegacy: false,
    storageMode: "indexeddb",
    reminderCheckRunning: false,
    attachmentUrls: [],
    toastTimer: null
  };

  const elements = {
    lessonGrid: byId("lesson-grid"),
    emptyState: byId("empty-state"),
    settingsView: byId("settings-view"),
    toolbar: byId("library-toolbar"),
    stats: byId("stats-grid"),
    topicFilterRow: byId("topic-filter-row"),
    editorDialog: byId("lesson-dialog"),
    detailDialog: byId("detail-dialog"),
    lessonForm: byId("lesson-form"),
    search: byId("search-input"),
    status: byId("status-filter"),
    sort: byId("sort-filter"),
    importFile: byId("import-file"),
    toast: byId("toast")
  };

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    return `lesson-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  function safeText(value, maxLength = MAX_FIELD_LENGTH) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
  }

  function validLesson(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 100
      && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 120
      && (value.entryType === undefined || ["code", "note", "file"].includes(value.entryType))
      && (value.language === undefined || (typeof value.language === "string" && value.language.length <= 40))
      && (value.content === undefined || (typeof value.content === "string" && value.content.length <= MAX_FIELD_LENGTH))
      && (value.attachmentIds === undefined || (Array.isArray(value.attachmentIds) && value.attachmentIds.length <= MAX_ENTRY_ATTACHMENTS))
      && (value.code === undefined || (typeof value.code === "string" && value.code.length <= MAX_FIELD_LENGTH))
      && Array.isArray(value.topics) && value.topics.length <= 30
      && value.topics.every((topic) => typeof topic === "string" && topic.trim().length > 0 && topic.length <= 40)
      && typeof value.notes === "string" && value.notes.length <= 5000
      && typeof value.learned === "string" && value.learned.length <= 5000
      && ["new", "review", "confident"].includes(value.status)
      && typeof value.createdAt === "string" && !Number.isNaN(Date.parse(value.createdAt))
      && typeof value.updatedAt === "string" && !Number.isNaN(Date.parse(value.updatedAt))
      && (value.practiceQuestion === undefined || (typeof value.practiceQuestion === "string" && value.practiceQuestion.length <= 1000))
      && (value.reviewLevel === undefined || (Number.isInteger(value.reviewLevel) && value.reviewLevel >= 0 && value.reviewLevel <= 6))
      && (value.nextReviewAt === undefined || value.nextReviewAt === null
        || (typeof value.nextReviewAt === "string" && !Number.isNaN(Date.parse(value.nextReviewAt))))
      && (value.reminderAt === undefined || value.reminderAt === null
        || (typeof value.reminderAt === "string" && !Number.isNaN(Date.parse(value.reminderAt))))
      && (value.reminderNotifiedAt === undefined || value.reminderNotifiedAt === null
        || (typeof value.reminderNotifiedAt === "string" && !Number.isNaN(Date.parse(value.reminderNotifiedAt))));
  }

  function normalizeLesson(raw) {
    if (!validLesson(raw)) throw new Error("The backup contains a lesson with an invalid format.");
    const topics = raw.topics
      .filter((topic) => typeof topic === "string")
      .map((topic) => topic.trim().slice(0, 40))
      .filter(Boolean)
      .slice(0, 30);
    const lesson = {
      id: raw.id,
      title: raw.title.trim().slice(0, 120),
      entryType: ["code", "note", "file"].includes(raw.entryType)
        ? raw.entryType
        : (typeof raw.code === "string" && raw.code.trim() ? "code" : "note"),
      language: safeText(raw.language || (raw.entryType === "code" || (!raw.entryType && raw.code) ? "Java" : ""), 40),
      topics,
      notes: safeText(raw.notes, 5000),
      learned: safeText(raw.learned, 5000),
      content: safeText(raw.content),
      attachmentIds: Array.isArray(raw.attachmentIds)
        ? [...new Set(raw.attachmentIds.filter((id) => typeof id === "string" && id.length <= 100))].slice(0, MAX_ENTRY_ATTACHMENTS)
        : [],
      status: raw.status,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      practiceQuestion: safeText(raw.practiceQuestion, 1000),
      reviewLevel: Number.isInteger(raw.reviewLevel) ? Math.min(6, Math.max(0, raw.reviewLevel)) : 0,
      nextReviewAt: typeof raw.nextReviewAt === "string" && !Number.isNaN(Date.parse(raw.nextReviewAt))
        ? raw.nextReviewAt
        : new Date(Date.parse(raw.createdAt) + 86400000).toISOString(),
      reminderAt: raw.reminderAt || null,
      reminderNotifiedAt: raw.reminderNotifiedAt || null
    };
    if (typeof raw.code === "string") lesson.code = safeText(raw.code);
    return lesson;
  }

  function parseLibrary(stored) {
    let parsed;
    try {
      parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.lessons)) {
        throw new Error("The saved library has an unsupported format.");
      }
      if (parsed.lessons.length > MAX_LESSONS) throw new Error("Your saved library contains more lessons than this version supports.");
      const deletedIds = {};
      if (parsed.deletedIds !== undefined) {
        if (!parsed.deletedIds || typeof parsed.deletedIds !== "object" || Array.isArray(parsed.deletedIds)) {
          throw new Error("The saved deletion history has an invalid format.");
        }
        const entries = Object.entries(parsed.deletedIds);
        if (entries.length > MAX_LESSONS) throw new Error("The saved deletion history exceeds this version's limit.");
        entries.forEach(([id, deletedAt]) => {
          if (!id || id.length > 100 || typeof deletedAt !== "string" || Number.isNaN(Date.parse(deletedAt))) {
            throw new Error("The saved deletion history contains an invalid entry.");
          }
          deletedIds[id] = deletedAt;
        });
      }
      return { schemaVersion: 1, lessons: parsed.lessons.map(normalizeLesson), deletedIds };
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("The saved library could not be read because its data is invalid.");
      throw error;
    }
  }

  async function loadLessons() {
    let stored;
    try {
      stored = await window.VaultStorage.load();
    } catch (error) {
      state.storageMode = "unavailable";
      throw new Error(`Protected browser storage could not be opened: ${error.message}`);
    }

    if (stored) {
      try {
        const library = parseLibrary(stored);
        state.deletedIds = library.deletedIds;
        return library.lessons;
      } catch (error) {
        const snapshots = await window.VaultStorage.snapshots();
        let validSnapshot = null;
        let recoveredLibrary = null;
        for (const snapshot of snapshots) {
          if (!snapshot.id.startsWith("legacy:")) continue;
          try {
            const restored = await window.VaultStorage.restoreSnapshot(snapshot.id);
            if (restored.type !== "library") continue;
            recoveredLibrary = parseLibrary(restored.library);
            validSnapshot = snapshot;
            break;
          } catch {
            continue;
          }
        }
        if (validSnapshot) {
          state.recoveryKey = validSnapshot.id;
          state.recoveryMode = true;
          state.storageBlocked = true;
          showToast("The latest library data is unreadable. A previous automatic restore point is available in Settings.", true);
          state.deletedIds = recoveredLibrary.deletedIds;
          return recoveredLibrary.lessons;
        }
        const legacy = localStorage.getItem(STORAGE_KEY);
        let legacyError = "";
        if (legacy) {
          try {
            const library = parseLibrary(legacy);
            state.recoveryMode = true;
            state.recoveryLegacy = true;
            state.storageBlocked = true;
            showToast("The current library and automatic restore points are unreadable. An older browser copy is available in Settings.", true);
            state.deletedIds = library.deletedIds;
            return library.lessons;
          } catch (fallbackError) {
            legacyError = ` The older browser copy is also invalid: ${fallbackError.message}`;
          }
        }
        throw new Error(`${error.message} No valid automatic restore point was found.${legacyError}`);
      }
    }

    const legacy = localStorage.getItem(STORAGE_KEY);
    if (!legacy) return [];
    const migrated = parseLibrary(legacy);
    state.deletedIds = migrated.deletedIds;
    if (window.VaultStorage.mode === "indexeddb") {
      await window.VaultStorage.save(migrated);
      return migrated.lessons.map(({ code, ...lesson }) => lesson);
    }
    return migrated.lessons;
  }

  async function persistLessons(lessons, allowRecovery = false, deletedIds = state.deletedIds, addedFiles = []) {
    if (state.storageBlocked && !allowRecovery) {
      showToast("Saving is paused to protect unreadable library data. Restore a previous save or import a valid backup.", true);
      return false;
    }
    if (lessons.length > MAX_LESSONS) {
      showToast(`This library has reached the ${MAX_LESSONS.toLocaleString()} lesson limit.`, true);
      return false;
    }
    try {
      const currentById = new Map(state.lessons.map((lesson) => [lesson.id, lesson]));
      const removedAttachmentIds = [];
      lessons.forEach((lesson) => {
        const previous = currentById.get(lesson.id);
        const currentAttachmentIds = new Set(lesson.attachmentIds || []);
        (previous && previous.attachmentIds || []).forEach((id) => {
          if (!currentAttachmentIds.has(id)) removedAttachmentIds.push(id);
        });
      });
      await window.VaultStorage.save(
        { schemaVersion: 1, lessons, deletedIds },
        state.lessons,
        addedFiles,
        removedAttachmentIds
      );
      state.lessons = lessons.map((lesson) => {
        if (window.VaultStorage.mode === "localstorage") return lesson;
        if (!Object.prototype.hasOwnProperty.call(lesson, "code")) return lesson;
        const { code, ...metadata } = lesson;
        return metadata;
      });
      state.deletedIds = deletedIds;
      state.storageBlocked = false;
      state.recoveryMode = false;
      state.recoveryLegacy = false;
      state.recoveryKey = null;
      state.storageMode = window.VaultStorage.mode;
      render();
      refreshStorageStatus();
      refreshRestorePoints();
      return true;
    } catch (error) {
      showToast(`Could not safely save your library: ${error.message || "browser storage is unavailable"}. Your current in-memory lesson list was not changed.`, true);
      return false;
    }
  }

  function showToast(message, isError = false) {
    clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle("error", isError);
    elements.toast.classList.add("visible");
    state.toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3600);
  }

  function formatDate(dateString) {
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
  }

  function createElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function getTopics() {
    return [...new Set(state.lessons.flatMap((lesson) => lesson.topics))].sort((a, b) => a.localeCompare(b));
  }

  function lessonMatches(lesson) {
    if (state.view === "review" && lesson.status !== "review") return false;
    if (state.view === "review" && lesson.entryType !== "code") return false;
    if (state.view === "study" && lesson.entryType !== "code") return false;
    if (state.view === "study" && Date.parse(lesson.nextReviewAt) > Date.now()) return false;
    if (state.status !== "all" && lesson.status !== state.status) return false;
    if (state.topic && !lesson.topics.includes(state.topic)) return false;
    if (!state.search) return true;
    const searchable = [lesson.title, lesson.language, lesson.topics.join(" "), lesson.notes, lesson.learned, lesson.content, lesson.practiceQuestion].join(" ").toLocaleLowerCase();
    return searchable.includes(state.search.toLocaleLowerCase());
  }

  function getVisibleLessons() {
    const lessons = state.lessons.filter(lessonMatches);
    if (state.view === "study") lessons.sort((a, b) => Date.parse(a.nextReviewAt) - Date.parse(b.nextReviewAt));
    else if (state.sort === "oldest") lessons.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    else if (state.sort === "title") lessons.sort((a, b) => a.title.localeCompare(b.title));
    else lessons.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return state.view === "overview" ? lessons.slice(0, 6) : lessons;
  }

  function renderStats() {
    byId("stat-lessons").textContent = String(state.lessons.length);
    byId("stat-topics").textContent = String(getTopics().length);
    const reviewCount = state.lessons.filter((lesson) => lesson.entryType === "code" && lesson.status === "review").length;
    const dueCount = state.lessons.filter((lesson) => lesson.entryType === "code" && Date.parse(lesson.nextReviewAt) <= Date.now()).length;
    byId("stat-review").textContent = String(reviewCount);
    byId("lesson-nav-count").textContent = String(state.lessons.length);
    byId("review-nav-count").textContent = String(reviewCount);
    byId("due-nav-count").textContent = String(dueCount);
  }

  function renderTopics() {
    const topics = getTopics();
    const row = elements.topicFilterRow;
    row.hidden = topics.length === 0 || state.view === "settings";
    const list = byId("topic-filter-list");
    list.replaceChildren();
    topics.forEach((topic) => {
      const button = createElement("button", `topic-filter-button${state.topic === topic ? " active" : ""}`, topic);
      button.type = "button";
      button.setAttribute("aria-pressed", String(state.topic === topic));
      button.addEventListener("click", () => {
        state.topic = state.topic === topic ? "" : topic;
        render();
      });
      list.append(button);
    });
  }

  function renderCard(lesson) {
    const card = createElement("article", "lesson-card");
    const topline = createElement("div", "card-topline");
    const entryLabel = lesson.entryType === "note" ? "Text note" : lesson.entryType === "file" ? "Files & media" : lesson.language || "Code";
    topline.append(createElement("span", "card-topic", lesson.topics[0] || entryLabel));
    const status = createElement("span", `status-pill ${lesson.status}`, STATUS_LABELS[lesson.status]);
    topline.append(status);

    const title = createElement("h3", "", lesson.title);
    const previewText = lesson.content || lesson.learned || lesson.notes || (lesson.entryType === "file" ? "Files saved on this device." : "Entry saved — add notes whenever you’re ready.");
    const preview = createElement("p", "card-preview", previewText);
    const tags = createElement("div", "card-tags");
    lesson.topics.slice(0, 4).forEach((topic) => tags.append(createElement("span", "tag-chip", topic)));
    if (lesson.topics.length > 4) tags.append(createElement("span", "tag-chip", `+${lesson.topics.length - 4}`));

    const footer = createElement("div", "card-footer");
    const codeLabel = createElement("span", "card-code-label");
    codeLabel.append(createElement("span", "", lesson.entryType === "file" ? "▧" : lesson.entryType === "note" ? "¶" : "</>"),
      document.createTextNode(lesson.entryType === "file" ? `${lesson.attachmentIds.length} file${lesson.attachmentIds.length === 1 ? "" : "s"}` : lesson.entryType === "note" ? "Text saved" : `${lesson.language || "Code"} saved`));
    footer.append(codeLabel, createElement("time", "", formatDate(lesson.updatedAt)));
    if (lesson.reminderAt) {
      const reminderLabel = createElement("span", "card-reminder", `◷ ${formatDateTime(lesson.reminderAt)}`);
      footer.insertBefore(reminderLabel, footer.lastChild);
    }
    const openButton = createElement("button", "card-open");
    openButton.type = "button";
    openButton.setAttribute("aria-label", `Open lesson: ${lesson.title}`);
    openButton.addEventListener("click", () => openLesson(lesson.id));
    card.append(topline, title, preview, tags, footer, openButton);
    return card;
  }

  function render() {
    renderStats();
    renderTopics();
    const isSettings = state.view === "settings";
    elements.settingsView.hidden = !isSettings;
    elements.toolbar.hidden = isSettings;
    elements.stats.hidden = isSettings || state.view !== "overview";
    elements.lessonGrid.hidden = isSettings;
    elements.emptyState.hidden = isSettings;
    byId("breadcrumb-current").textContent = viewName();
    byId("page-title").textContent = isSettings ? "Your library, your settings." : state.view === "review" ? "A little review goes a long way." : state.view === "study" ? "Bring your lessons back to mind." : state.view === "lessons" ? "Every entry, in one place." : "Welcome to your learning library.";
    byId("page-eyebrow").textContent = isSettings ? "YOUR DATA, YOUR CHOICES" : state.view === "review" || state.view === "study" ? "BUILD ON WHAT YOU KNOW" : state.view === "lessons" ? "YOUR PERSONAL LEARNING LIBRARY" : "YOUR PROGRESS, IN ONE PLACE";
    byId("page-subtitle").textContent = isSettings ? "Manage your on-device library and backups." : state.view === "review" ? "Revisit the ideas you marked for another look." : state.view === "study" ? "Try recalling the idea first, then reveal your notes and choose when to review again." : state.view === "lessons" ? "Code, writing, documents, and media in one searchable place." : "A calm place for your code, notes, documents, and study materials.";
    byId("list-title").textContent = state.view === "review" ? "Ready when you are" : state.view === "study" ? "Due for a quick review" : state.view === "overview" ? "Recent entries" : "Your entries";
    byId("status-filter").value = state.status;
    byId("sort-filter").value = state.sort;
    document.querySelectorAll(".nav-item[data-view]").forEach((button) => {
      const active = button.dataset.view === state.view
        || (state.view === "overview" && button.dataset.view === "overview");
      button.classList.toggle("active", active);
      button.setAttribute("aria-current", active ? "page" : "false");
    });

    if (isSettings) return;
    const visible = getVisibleLessons();
    elements.lessonGrid.replaceChildren(...visible.map(renderCard));
    const total = visible.length;
    byId("result-count").textContent = `${total} ${total === 1 ? "entry" : "entries"}`;
    const empty = visible.length === 0;
    elements.lessonGrid.hidden = empty;
    elements.emptyState.hidden = !empty;
    byId("empty-eyebrow").textContent = state.view === "study" && !state.search && !state.topic ? "ALL CAUGHT UP" : state.search || state.topic || state.status !== "all" || state.view === "review" ? "NO MATCHES YET" : "YOUR FIRST ENTRY";
    byId("empty-title").textContent = state.view === "study" && !state.search && !state.topic ? "No lessons are due right now." : state.search || state.topic || state.status !== "all" || state.view === "review" ? "Nothing to see here just yet." : "Make room for what’s next.";
    byId("empty-message").textContent = state.view === "study" && !state.search && !state.topic
      ? "Your next reviews will appear here based on the schedule you choose after each practice."
      : state.search || state.topic || state.status !== "all" || state.view === "review"
        ? "Try another search or filter, or save a lesson to start building your library."
      : "Create your first entry: save code, write a note, or attach a useful file.";
    byId("empty-state").querySelector("[data-create]").hidden = Boolean(state.view === "study" || state.search || state.topic || state.status !== "all" || state.view === "review");
  }

  function viewName() {
    return ({ overview: "Overview", lessons: "All entries", study: "Study due", review: "Review later", settings: "Settings & backup" })[state.view] || "Overview";
  }

  function navigate(view) {
    state.view = view;
    state.topic = "";
    if (view === "overview" || view === "study") state.status = "all";
    if (view === "review") state.status = "all";
    if (view === "lessons") state.status = "all";
    render();
    if (view === "settings") {
      refreshStorageStatus();
      refreshRestorePoints();
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function openEditor(lesson = null) {
    elements.lessonForm.reset();
    const entryType = lesson ? lesson.entryType : "code";
    byId("lesson-id").value = lesson ? lesson.id : "";
    byId("lesson-title").value = lesson ? lesson.title : "";
    byId("entry-type").value = entryType;
    byId("entry-language").value = lesson && [...byId("entry-language").options].some((option) => option.value === lesson.language)
      ? lesson.language
      : lesson && lesson.entryType === "code" && lesson.language ? "Other" : "Java";
    byId("entry-language-custom").value = lesson && lesson.entryType === "code" && ![...byId("entry-language").options].some((option) => option.value === lesson.language)
      ? lesson.language
      : "";
    byId("lesson-topics").value = lesson ? lesson.topics.join(", ") : "";
    byId("lesson-notes").value = lesson ? lesson.notes : "";
    byId("lesson-learned").value = lesson ? lesson.learned : "";
    byId("lesson-practice-question").value = lesson ? lesson.practiceQuestion : "";
    byId("entry-content").value = lesson ? lesson.content : "";
    byId("lesson-code").value = "";
    byId("lesson-status").value = lesson ? lesson.status : "new";
    byId("lesson-reminder").value = lesson ? toLocalDateTimeInput(lesson.reminderAt) : "";
    byId("entry-files").value = "";
    byId("existing-attachments").textContent = lesson && lesson.attachmentIds.length
      ? `${lesson.attachmentIds.length} saved file${lesson.attachmentIds.length === 1 ? "" : "s"} will be kept.`
      : "";
    byId("editor-title").textContent = lesson ? "Edit your entry" : "Create an entry";
    updateEditorType();
    elements.editorDialog.showModal();
    if (lesson && lesson.entryType === "code") {
      window.VaultStorage.getCode(lesson.id).then((code) => {
        byId("lesson-code").value = code;
      }).catch((error) => showToast(`Could not load code for editing: ${error.message}`, true));
    }
    setTimeout(() => byId("lesson-title").focus(), 0);
  }

  function updateEditorType() {
    const type = byId("entry-type").value;
    byId("language-field").hidden = type !== "code";
    byId("code-field").hidden = type !== "code";
    byId("lesson-code").required = type === "code";
    byId("content-field").hidden = type !== "note";
    byId("entry-content").required = type === "note";
    byId("attachment-field").hidden = false;
    byId("learned-field").hidden = type !== "code";
    byId("status-field").hidden = type !== "code";
    byId("lesson-practice-question").closest("label").hidden = type !== "code";
    byId("lesson-reminder").closest("label").hidden = type === "file";
    byId("editor-hint").textContent = type === "code"
      ? "Save code from any programming language, add notes and practice questions, and revisit it later."
      : type === "note"
        ? "Write plain text notes and organize them with titles, topics, and comments."
        : "Save documents, images, and videos on this device with a title and optional topics.";
    byId("attachment-hint").textContent = `Files stay in this browser on this device. Up to ${MAX_ENTRY_ATTACHMENTS} files, ${formatBytes(MAX_ATTACHMENT_FILE_BYTES)} each, and ${formatBytes(MAX_ENTRY_ATTACHMENT_BYTES)} per entry.`;
    byId("entry-language-custom").hidden = byId("entry-language").value !== "Other";
  }

  async function openLesson(id) {
    const metadata = state.lessons.find((item) => item.id === id);
    if (!metadata) {
      showToast("That entry is no longer in your library.", true);
      return;
    }
    let lesson = metadata;
    try {
      if (metadata.entryType === "code") lesson = { ...metadata, code: await window.VaultStorage.getCode(id) };
      const localAttachments = await window.VaultStorage.listAttachments(id);
      lesson = { ...lesson, attachments: localAttachments };
    } catch (error) {
      showToast(`Could not load this entry: ${error.message}`, true);
      return;
    }
    releaseAttachmentUrls();
    state.selectedLessonId = id;
    renderDetail(lesson);
    if (!elements.detailDialog.open) elements.detailDialog.showModal();
  }

  function releaseAttachmentUrls() {
    state.attachmentUrls.forEach((url) => URL.revokeObjectURL(url));
    state.attachmentUrls = [];
  }

  function addDetailSection(parent, heading, content, className = "") {
    const section = createElement("section", `detail-section${className ? ` ${className}` : ""}`);
    section.append(createElement("h3", "", heading));
    if (content instanceof Node) section.append(content);
    else section.append(createElement("p", "", content || "Nothing added yet."));
    parent.append(section);
    return section;
  }

  function appendHighlightedCode(codeElement, source, language = "Plain text") {
    const keywordsByLanguage = {
      java: "abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield",
      javascript: "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield",
      typescript: "abstract any as asserts async await bigint boolean break case catch class const continue debugger declare default delete do else enum export extends finally for from function if implements import in infer instanceof interface is keyof let module namespace never new number object of package private protected public readonly require return static string super switch symbol this throw throws transient try type typeof undefined unique unknown var void while with yield",
      python: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield",
      c: "auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while",
      cpp: "alignas alignof auto bool break case catch char class const constexpr continue decltype default delete do double else enum explicit extern false float for friend goto if inline int long namespace new noexcept nullptr operator private protected public register return short signed sizeof static struct switch template this throw true try typedef typename union unsigned using virtual void volatile while",
      csharp: "abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while",
      go: "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
      rust: "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
      sql: "add all alter and as asc between by case check column create database default delete desc distinct drop else end exists foreign from full group having in index inner insert into is join key left like limit not null on or order outer primary references right select set table then to union unique update values when where"
    };
    const rawLanguageKey = language.toLocaleLowerCase();
    const languageKey = {
      "c++": "cpp",
      "c#": "csharp",
      js: "javascript",
      ts: "typescript"
    }[rawLanguageKey] || rawLanguageKey;
    const keywords = new Set(keywordsByLanguage[languageKey] ? keywordsByLanguage[languageKey].split(" ") : []);
    const tokenPattern = /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|#[^\r\n]*|"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?[fFdDlL]?\b/g;
    const literals = new Set(["true", "false", "null"]);
    let cursor = 0;
    let match;
    while ((match = tokenPattern.exec(source)) !== null) {
      if (match.index > cursor) codeElement.append(document.createTextNode(source.slice(cursor, match.index)));
      const token = match[0];
      let tokenClass = "code-number";
      if (token.startsWith("//") || token.startsWith("/*") || (token.startsWith("#") && ["python", "shell"].includes(languageKey))) tokenClass = "code-comment";
      else if (token.startsWith('"') || token.startsWith("'")) tokenClass = "code-string";
      else if (token.startsWith("`")) tokenClass = "code-string";
      else if (keywords.has(token)) tokenClass = "code-keyword";
      else if (literals.has(token) || ["true", "false", "null", "none", "nil"].includes(token)) tokenClass = "code-literal";
      else if (/^\d/.test(token)) tokenClass = "code-number";
      else if (keywordsByLanguage[languageKey] && ["this", "self"].includes(token)) tokenClass = "code-literal";
      else tokenClass = "";
      if (tokenClass) codeElement.append(createElement("span", tokenClass, token));
      else codeElement.append(document.createTextNode(token));
      cursor = match.index + token.length;
    }
    if (cursor < source.length) codeElement.append(document.createTextNode(source.slice(cursor)));
  }

  function createCodePanel(source, label, language = "Plain text") {
    const panel = createElement("div", "code-panel");
    const header = createElement("div", "code-panel-header");
    header.append(createElement("span", "", label));
    const copyButton = createElement("button", "secondary-button code-copy-button", "Copy code");
    copyButton.type = "button";
    copyButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(source);
        showToast(`${label} copied.`);
      } catch (error) {
        showToast(`Could not copy code: ${error.message || "clipboard access is unavailable"}`, true);
      }
    });
    header.append(copyButton);
    const pre = createElement("pre", "detail-code");
    const code = document.createElement("code");
    appendHighlightedCode(code, source, language);
    pre.append(code);
    panel.append(header, pre);
    return panel;
  }

  function schedulePractice(lessonId, rating) {
    const lesson = state.lessons.find((item) => item.id === lessonId);
    if (!lesson) return;
    const intervals = [1, 1, 3, 7, 14, 30, 60];
    const reviewLevel = rating === "again"
      ? Math.max(0, lesson.reviewLevel - 1)
      : Math.min(6, lesson.reviewLevel + (rating === "easy" ? 2 : 1));
    const delay = rating === "again" ? 10 * 60 * 1000 : intervals[reviewLevel] * 86400000;
    const updated = { ...lesson, reviewLevel, nextReviewAt: new Date(Date.now() + delay).toISOString(), updatedAt: new Date().toISOString() };
    const next = state.lessons.map((item) => item.id === lessonId ? updated : item);
    persistLessons(next).then((saved) => {
      if (!saved) return;
      if (elements.detailDialog.open && state.selectedLessonId === lessonId) renderDetail(updated);
      showToast(`Next review ${rating === "again" ? "in 10 minutes" : `in ${intervals[reviewLevel]} day${intervals[reviewLevel] === 1 ? "" : "s"}`}.`);
    });
  }

  function renderAttachmentList(parent, lesson) {
    const section = createElement("section", "detail-section attachment-section");
    section.append(createElement("h3", "", "Attached files"));
    const attachments = lesson.attachments || [];
    if (!attachments.length) {
      section.append(createElement("p", "", "No files attached yet."));
      parent.append(section);
      return;
    }

    attachments.forEach((attachment) => {
      const item = createElement("article", "attachment-item");
      const summary = createElement("div", "attachment-summary");
      summary.append(createElement("strong", "", attachment.name));
      summary.append(createElement("span", "field-hint", `${attachment.type || "File"} · ${formatBytes(attachment.size)}`));
      const actions = createElement("div", "attachment-actions");
      const openButton = createElement("button", "secondary-button", attachment.type.startsWith("image/") || attachment.type.startsWith("video/") || attachment.type === "application/pdf" ? "Preview" : "Download");
      openButton.type = "button";
      openButton.addEventListener("click", async () => {
        openButton.disabled = true;
        try {
          const blob = await window.VaultStorage.getAttachment(attachment.id);
          const url = URL.createObjectURL(blob);
          state.attachmentUrls.push(url);
          if (attachment.type.startsWith("image/")) {
            const image = document.createElement("img");
            image.src = url;
            image.alt = attachment.name;
            image.className = "attachment-preview";
            item.append(image);
          } else if (attachment.type.startsWith("video/")) {
            const video = document.createElement("video");
            video.src = url;
            video.controls = true;
            video.preload = "metadata";
            video.className = "attachment-preview";
            item.append(video);
          } else if (attachment.type === "application/pdf") {
            const frame = document.createElement("iframe");
            frame.src = url;
            frame.title = `Preview of ${attachment.name}`;
            frame.className = "attachment-pdf-preview";
            item.append(frame);
          }
          const download = createElement("a", "attachment-download", `Download ${attachment.name}`);
          download.href = url;
          download.download = attachment.name;
          actions.replaceChildren(download);
          openButton.hidden = true;
        } catch (error) {
          showToast(`Could not open ${attachment.name}: ${error.message}`, true);
          openButton.disabled = false;
        }
      });
      const removeButton = createElement("button", "text-button danger-text", "Remove");
      removeButton.type = "button";
      removeButton.addEventListener("click", () => removeAttachment(lesson.id, attachment.id, attachment.name));
      actions.append(openButton, removeButton);
      item.append(summary, actions);
      section.append(item);
    });
    parent.append(section);
  }

  async function removeAttachment(entryId, attachmentId, name) {
    if (!window.confirm(`Remove "${name}" from this entry?`)) return;
    const current = state.lessons.find((lesson) => lesson.id === entryId);
    if (!current) return;
    const updated = {
      ...current,
      attachmentIds: current.attachmentIds.filter((id) => id !== attachmentId),
      updatedAt: new Date().toISOString()
    };
    const next = state.lessons.map((lesson) => lesson.id === entryId ? updated : lesson);
    if (!await persistLessons(next)) return;
    await openLesson(entryId);
    showToast("File removed from this entry. You can restore it from an entry restore point.");
  }

  function renderDetail(lesson) {
    byId("detail-title").textContent = lesson.title;
    const body = byId("detail-body");
    body.replaceChildren();
    const meta = createElement("div", "detail-meta");
    meta.append(createElement("span", `status-pill ${lesson.status}`, STATUS_LABELS[lesson.status]));
    meta.append(createElement("span", "", lesson.entryType === "note" ? "Text note" : lesson.entryType === "file" ? "Files & media" : lesson.language || "Code"));
    meta.append(createElement("span", "", `Saved ${formatDate(lesson.createdAt)}`));
    if (lesson.updatedAt !== lesson.createdAt) meta.append(createElement("span", "", `· Updated ${formatDate(lesson.updatedAt)}`));
    body.append(meta);
    if (lesson.reminderAt) {
      const reminderDescription = lesson.reminderNotifiedAt
        ? `Reminder set for ${formatDateTime(lesson.reminderAt)} · notified ${formatDateTime(lesson.reminderNotifiedAt)}`
        : new Date(lesson.reminderAt).getTime() <= Date.now()
          ? `Reminder overdue since ${formatDateTime(lesson.reminderAt)}`
          : `Reminder set for ${formatDateTime(lesson.reminderAt)}`;
      addDetailSection(body, "Reminder", reminderDescription);
    }

    const topics = createElement("div", "detail-topics");
    if (lesson.topics.length) lesson.topics.forEach((topic) => topics.append(createElement("span", "tag-chip", topic)));
    else topics.append(createElement("span", "field-hint", "No topics added"));
    addDetailSection(body, "Topics", topics);
    if (lesson.notes) addDetailSection(body, "Your comments & notes", lesson.notes);
    if (lesson.entryType === "note") addDetailSection(body, "Text note", lesson.content);
    if (lesson.entryType === "code" && lesson.learned) addDetailSection(body, "What you learned", lesson.learned);
    const practice = createElement("div", "practice-card");
    practice.append(createElement("p", "practice-question", lesson.practiceQuestion || "Before reading your notes, explain this lesson in your own words."));
    const revealButton = createElement("button", "secondary-button", "Reveal my notes");
    revealButton.type = "button";
    const answer = createElement("div", "practice-answer");
    answer.hidden = true;
    answer.append(createElement("p", "", lesson.learned || "You have not added a learning summary yet."));
    if (lesson.notes) answer.append(createElement("p", "practice-notes", lesson.notes));
    const ratingActions = createElement("div", "practice-ratings");
    [
      ["again", "I need another look"],
      ["good", "Got it"],
      ["easy", "Easy"]
    ].forEach(([rating, label]) => {
      const button = createElement("button", "secondary-button", label);
      button.type = "button";
      button.addEventListener("click", () => schedulePractice(lesson.id, rating));
      ratingActions.append(button);
    });
    ratingActions.hidden = true;
    revealButton.addEventListener("click", () => {
      answer.hidden = false;
      ratingActions.hidden = false;
      revealButton.hidden = true;
    });
    practice.append(revealButton, answer, ratingActions);
    if (lesson.nextReviewAt) {
      practice.append(createElement("p", "field-hint", `Next review: ${formatDateTime(lesson.nextReviewAt)}`));
    }
    if (lesson.entryType === "code") addDetailSection(body, "Practice & spaced review", practice);
    if (lesson.entryType === "code" && lesson.code) addDetailSection(body, `${lesson.language || "Code"} source`, createCodePanel(lesson.code, `Original ${lesson.language || "code"}`, lesson.language));
    if (lesson.attachmentIds.length || lesson.entryType === "file") renderAttachmentList(body, lesson);
  }

  function parseTopics(value) {
    return [...new Set(value.split(",").map((topic) => topic.trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
  }

  function toLocalDateTimeInput(isoDate) {
    if (!isoDate) return "";
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return "";
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
  }

  function formatDateTime(isoDate) {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return "Date unavailable";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
  }

  async function handleSaveLesson(event) {
    event.preventDefault();
    const id = byId("lesson-id").value;
    const existing = state.lessons.find((lesson) => lesson.id === id);
    const now = new Date().toISOString();
    const reminderInput = byId("lesson-reminder").value;
    const parsedReminder = reminderInput ? new Date(reminderInput) : null;
    if (parsedReminder && Number.isNaN(parsedReminder.getTime())) {
      showToast("Choose a valid date and time for the reminder.", true);
      return;
    }
    const reminderAt = parsedReminder ? parsedReminder.toISOString() : null;
    const reminderChanged = Boolean(reminderAt && (!existing || existing.reminderAt !== reminderAt));
    const title = byId("lesson-title").value.trim();
    const code = byId("lesson-code").value;
    const type = byId("entry-type").value;
    const content = byId("entry-content").value;
    const selectedFiles = [...byId("entry-files").files];
    if (!title) {
      showToast("Add a title before saving.", true);
      return;
    }
    if (type === "code" && !code.trim()) {
      showToast("Paste your code before saving this entry.", true);
      return;
    }
    if (type === "note" && !content.trim()) {
      showToast("Add some text before saving this note.", true);
      return;
    }
    if (type === "file" && !selectedFiles.length && !(existing && existing.attachmentIds.length)) {
      showToast("Choose at least one file for this entry.", true);
      return;
    }
    if (selectedFiles.length > MAX_ENTRY_ATTACHMENTS) {
      showToast(`Choose no more than ${MAX_ENTRY_ATTACHMENTS} files per entry.`, true);
      return;
    }
    const existingAttachments = existing ? await window.VaultStorage.listAttachments(existing.id) : [];
    const selectedAttachmentIds = new Set(existing ? existing.attachmentIds : []);
    const filesToAdd = [];
    let totalAttachmentBytes = existingAttachments
      .filter((attachment) => selectedAttachmentIds.has(attachment.id))
      .reduce((total, attachment) => total + attachment.size, 0);
    for (const file of selectedFiles) {
      if (file.size > MAX_ATTACHMENT_FILE_BYTES) {
        showToast(`${file.name} is larger than the ${formatBytes(MAX_ATTACHMENT_FILE_BYTES)} per-file limit.`, true);
        return;
      }
      totalAttachmentBytes += file.size;
      if (totalAttachmentBytes > MAX_ENTRY_ATTACHMENT_BYTES) {
        showToast(`Attachments for an entry cannot exceed ${formatBytes(MAX_ENTRY_ATTACHMENT_BYTES)}.`, true);
        return;
      }
      const id = makeId();
      selectedAttachmentIds.add(id);
      filesToAdd.push({ id, entryId: existing ? existing.id : makeId(), file });
    }
    if (selectedAttachmentIds.size > MAX_ENTRY_ATTACHMENTS) {
      showToast(`This entry cannot have more than ${MAX_ENTRY_ATTACHMENTS} files.`, true);
      return;
    }
    let reminderNotice = "";
    if (reminderChanged && typeof Notification !== "undefined" && Notification.permission === "default") {
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") reminderNotice = " Notifications are off; the app will show overdue reminders the next time it is open.";
      } catch (error) {
        reminderNotice = ` Browser notification permission could not be requested: ${error.message}`;
      }
    } else if (reminderChanged && (typeof Notification === "undefined" || Notification.permission !== "granted")) {
      reminderNotice = " Notifications are unavailable or blocked; the app will show overdue reminders the next time it is open.";
    }
    const lesson = {
      id: existing ? existing.id : makeId(),
      title,
      topics: parseTopics(byId("lesson-topics").value),
      notes: byId("lesson-notes").value.trim(),
      learned: type === "code" ? byId("lesson-learned").value.trim() : "",
      practiceQuestion: byId("lesson-practice-question").value.trim(),
      entryType: type,
      language: type === "code"
        ? (byId("entry-language").value === "Other" ? byId("entry-language-custom").value.trim() || "Other" : byId("entry-language").value)
        : "",
      content: type === "note" ? content : "",
      attachmentIds: [...selectedAttachmentIds],
      status: byId("lesson-status").value,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      reviewLevel: existing ? existing.reviewLevel : 0,
      nextReviewAt: existing ? existing.nextReviewAt : new Date(Date.now() + 86400000).toISOString(),
      reminderAt,
      reminderNotifiedAt: existing && existing.reminderAt === reminderAt ? existing.reminderNotifiedAt : null,
    };
    if (type === "code") lesson.code = code;
    if (existing) filesToAdd.forEach((item) => { item.entryId = existing.id; });
    else if (filesToAdd.length) {
      const firstEntryId = lesson.id;
      filesToAdd.forEach((item) => { item.entryId = firstEntryId; });
      selectedAttachmentIds.clear();
      filesToAdd.forEach((item) => selectedAttachmentIds.add(item.id));
      lesson.attachmentIds = [...selectedAttachmentIds];
    }
    const next = existing
      ? state.lessons.map((item) => item.id === existing.id ? lesson : item)
      : [lesson, ...state.lessons];
    if (!await persistLessons(next, false, state.deletedIds, filesToAdd)) return;
    elements.editorDialog.close();
    showToast(`${existing ? "Entry updated." : "Entry saved on this device."}${reminderNotice}`);
    if (reminderChanged && reminderAt && Date.parse(reminderAt) > Date.now() && !reminderNotice) {
      try {
        await scheduleBackgroundReminder(lesson);
      } catch (error) {
        showToast(`Reminder saved, but background scheduling failed: ${error.message}. It will be checked when the app is open.`, true);
      }
    }
    checkDueReminders();
  }

  async function scheduleBackgroundReminder(lesson) {
    if (typeof window.TimestampTrigger !== "function" || !("serviceWorker" in navigator)) {
      throw new Error("this browser does not support scheduled notifications");
    }
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification("Ope' Code Vault reminder", {
      body: `Time to revisit “${lesson.title}”`,
      icon: "./java-vault-icon.svg",
      tag: `java-vault-reminder-${lesson.id}`,
      showTrigger: new window.TimestampTrigger(Date.parse(lesson.reminderAt)),
      data: { lessonId: lesson.id }
    });
  }

  async function checkDueReminders() {
    if (state.reminderCheckRunning) return;
    const now = Date.now();
    const due = state.lessons.filter((lesson) => lesson.reminderAt
      && !lesson.reminderNotifiedAt
      && Date.parse(lesson.reminderAt) <= now);
    if (!due.length) return;

    state.reminderCheckRunning = true;
    let browserNotificationShown = false;
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      try {
        const registration = await navigator.serviceWorker.ready;
        await Promise.all(due.map((lesson) => registration.showNotification("Ope' Code Vault reminder", {
          body: `Time to revisit “${lesson.title}”`,
          icon: "./java-vault-icon.svg",
          tag: `java-vault-reminder-${lesson.id}`,
          data: { lessonId: lesson.id }
        })));
        browserNotificationShown = true;
      } catch (error) {
        showToast(`Browser notification failed: ${error.message}. The reminder is still shown in the app.`, true);
      }
    }
    const titles = due.map((lesson) => `“${lesson.title}”`).join(", ");
    showToast(`Reminder: revisit ${titles}.${browserNotificationShown ? "" : " Open the lesson to review it."}`);
    const notifiedAt = new Date().toISOString();
    const updatedIds = new Set(due.map((lesson) => lesson.id));
    const updatedLessons = state.lessons.map((lesson) => updatedIds.has(lesson.id)
      ? { ...lesson, reminderNotifiedAt: notifiedAt }
      : lesson);
    try {
      await persistLessons(updatedLessons);
    } finally {
      state.reminderCheckRunning = false;
    }
  }

  async function removeLesson() {
    const lesson = state.lessons.find((item) => item.id === state.selectedLessonId);
    if (!lesson) return;
    if (!window.confirm(`Delete “${lesson.title}”? This cannot be undone unless you have a backup.`)) return;
    const deletedIds = { ...state.deletedIds, [lesson.id]: new Date().toISOString() };
    if (!await persistLessons(state.lessons.filter((item) => item.id !== lesson.id), false, deletedIds)) return;
    elements.detailDialog.close();
    showToast("Lesson deleted.");
  }

  async function exportBackup() {
    const codeById = await window.VaultStorage.getCodes(
      state.lessons.filter((lesson) => lesson.entryType === "code").map((lesson) => lesson.id)
    );
    const backup = {
      app: "Ope' Code Vault",
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      attachmentsExcluded: true,
      lessons: state.lessons.map((lesson) => ({
        ...lesson,
        attachmentIds: [],
        ...(lesson.entryType === "code" ? { code: codeById.get(lesson.id) || "" } : {})
      })),
      deletedIds: state.deletedIds
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ope-code-vault-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    try {
      localStorage.setItem(BACKUP_EXPORTED_KEY, new Date().toISOString());
      showToast("Lesson backup downloaded. Attachments are stored separately; download them from each entry if you need copies.");
      refreshStorageStatus();
    } catch (error) {
      showToast(`Backup downloaded, but its export date could not be recorded: ${error.message}`, true);
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 bytes";
    const units = ["bytes", "KB", "MB", "GB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  async function refreshStorageStatus() {
    const target = byId("storage-status");
    if (!target) return;
    try {
      const snapshots = await window.VaultStorage.snapshots();
      const estimate = await window.VaultStorage.estimate();
      const mode = window.VaultStorage.mode === "indexeddb"
        ? "IndexedDB on this device (not encrypted)"
        : window.VaultStorage.mode === "localstorage" ? "Basic browser storage (automatic restore points unavailable)" : "Storage unavailable";
      const usage = estimate && estimate.quota ? ` · ${formatBytes(estimate.usage)} of about ${formatBytes(estimate.quota)} used` : "";
      const recovery = state.recoveryMode ? " A previous restore point is loaded read-only until you explicitly restore it or import a backup." : "";
      const lastExport = localStorage.getItem(BACKUP_EXPORTED_KEY);
      const exportStatus = lastExport ? ` · Last backup export: ${formatDateTime(lastExport)}` : " · No backup export recorded yet";
      target.textContent = `${mode} · ${snapshots.length} automatic restore point${snapshots.length === 1 ? "" : "s"}${usage}${exportStatus}.${recovery} Export a backup for protection from device loss or browser data clearing.`;
    } catch (error) {
      target.textContent = `Storage status could not be checked: ${error.message}`;
      showToast(`Could not check automatic restore points: ${error.message}`, true);
    }
  }

  async function refreshRestorePoints() {
    const select = byId("snapshot-select");
    const button = byId("restore-snapshot-button");
    byId("restore-legacy-button").hidden = !state.recoveryLegacy;
    if (!select || !button) return;
    try {
      const snapshots = await window.VaultStorage.snapshots();
      select.replaceChildren();
      if (!snapshots.length) {
        select.append(new Option("No automatic restore points yet", ""));
      } else {
        select.append(new Option("Choose an entry version", ""));
        snapshots.forEach((snapshot) => {
          select.append(new Option(`${snapshot.entryTitle} · ${formatDateTime(snapshot.savedAt)}`, snapshot.id));
        });
      }
      if (state.recoveryKey) select.value = state.recoveryKey;
      button.disabled = !select.value;
    } catch (error) {
      select.replaceChildren(new Option("Restore points unavailable", ""));
      button.disabled = true;
      showToast(`Could not load automatic restore points: ${error.message}`, true);
    }
  }

  async function restoreSnapshot() {
    const key = byId("snapshot-select").value;
    if (!key) return;
    try {
      const snapshots = await window.VaultStorage.snapshots();
      const snapshot = snapshots.find((item) => item.id === key);
      if (!snapshot) throw new Error("That restore point is no longer available.");
      const restored = await window.VaultStorage.restoreSnapshot(key);
      if (restored.type === "library") {
        const library = parseLibrary(restored.library);
        if (!window.confirm(`Restore the full library (${library.lessons.length} entr${library.lessons.length === 1 ? "y" : "ies"}) from ${formatDateTime(snapshot.savedAt)}? The current saved data will be kept.`)) return;
        if (!await persistLessons(library.lessons, true, library.deletedIds)) return;
        showToast("The older full-library restore point has been restored.");
        return;
      }
      const previous = state.lessons.find((item) => item.id === restored.entry.id);
      if (!window.confirm(`Restore the previous version of "${snapshot.entryTitle}" from ${formatDateTime(snapshot.savedAt)}? The current version will be saved as a restore point.`)) return;
      const nextEntry = normalizeLesson(restored.entry);
      const next = previous
        ? state.lessons.map((item) => item.id === nextEntry.id ? nextEntry : item)
        : [nextEntry, ...state.lessons];
      const restoredFiles = restored.attachments
        .filter((file) => nextEntry.attachmentIds.includes(file.id))
        .map((file) => ({ id: file.id, entryId: nextEntry.id, file: file.blob }));
      const deletedIds = { ...state.deletedIds };
      delete deletedIds[nextEntry.id];
      if (!await persistLessons(next, true, deletedIds, restoredFiles)) return;
      state.storageBlocked = false;
      state.recoveryMode = false;
      state.recoveryKey = null;
      showToast(`Restored "${snapshot.entryTitle}" to its previous version.`);
      refreshStorageStatus();
    } catch (error) {
      showToast(`Could not restore that point: ${error.message}`, true);
    }
  }

  async function restoreLegacyCopy() {
    try {
      const text = localStorage.getItem(STORAGE_KEY);
      if (!text) throw new Error("The older browser copy is no longer available.");
      const library = parseLibrary(text);
      if (!window.confirm(`Restore ${library.lessons.length} lesson(s) from the older browser copy? The current saved data will be kept as a restore point.`)) return;
      if (!await persistLessons(library.lessons, true, library.deletedIds)) return;
      showToast("The older browser copy has been restored.");
    } catch (error) {
      showToast(`Could not restore the older browser copy: ${error.message}`, true);
    }
  }

  async function requestPersistentStorage() {
    try {
      const granted = await window.VaultStorage.requestPersistentStorage();
      showToast(granted
        ? "The browser agreed not to automatically evict this app's data. Keep exporting backups; this does not protect against clearing browser data or device loss."
        : "The browser did not grant persistent storage. Automatic restore points remain on this device; export backups regularly.", !granted);
      refreshStorageStatus();
    } catch (error) {
      showToast(`Could not request storage protection: ${error.message}`, true);
    }
  }

  async function importBackup(file) {
    if (!file) return;
    if (file.size > MAX_BACKUP_BYTES) {
      showToast("This backup is larger than the 5 MB import limit.", true);
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.lessons)) {
        throw new Error("This file is not a supported Java Vault backup.");
      }
      if (parsed.lessons.length > MAX_LESSONS) throw new Error("This backup contains too many lessons.");
      const importedLibrary = parseLibrary(parsed);
      const imported = importedLibrary.lessons;
      if (!window.confirm(`Import ${imported.length} lesson(s)? They will be merged into this library; matching IDs will be replaced.`)) return;
      const merged = new Map(state.lessons.map((lesson) => [lesson.id, lesson]));
      imported.forEach((lesson) => merged.set(lesson.id, lesson));
      const deletedIds = { ...state.deletedIds, ...importedLibrary.deletedIds };
      imported.forEach((lesson) => {
        if (deletedIds[lesson.id] && Date.parse(lesson.updatedAt) > Date.parse(deletedIds[lesson.id])) {
          delete deletedIds[lesson.id];
        }
      });
      if (!await persistLessons([...merged.values()].filter((lesson) => !deletedIds[lesson.id]), true, deletedIds)) return;
      showToast(`${imported.length} lesson(s) imported.`);
    } catch (error) {
      showToast(`Import failed: ${error.message || "the backup could not be read"}`, true);
    } finally {
      elements.importFile.value = "";
    }
  }

  function clearLegacyIntegrationState() {
    const cleanupKey = "java-vault-local-only-cleanup-v1";
    try {
      if (localStorage.getItem(cleanupKey) === "done") return;
      ["sb-qlfktmiqjjssrfhjfoyp-auth-token", "java-vault-ai-settings-v1", "ope-vault-drive-files-v1"]
        .forEach((key) => localStorage.removeItem(key));
      sessionStorage.removeItem("java-vault-drive-oauth-pending-v1");
      localStorage.setItem(cleanupKey, "done");
    } catch (error) {
      showToast(`Could not clear previous sign-in settings: ${error.message}`, true);
    }
  }

  function bindEvents() {
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
    document.querySelectorAll("[data-create]").forEach((button) => button.addEventListener("click", () => openEditor()));
    byId("new-lesson-button").addEventListener("click", () => openEditor());
    byId("backup-button").addEventListener("click", () => navigate("settings"));
    elements.lessonForm.addEventListener("submit", async (event) => {
      try {
        await handleSaveLesson(event);
      } catch (error) {
        showToast(`Could not save this entry: ${error.message}`, true);
      }
    });
    byId("entry-type").addEventListener("change", updateEditorType);
    byId("entry-language").addEventListener("change", updateEditorType);
    document.querySelectorAll("[data-close-editor]").forEach((button) => button.addEventListener("click", () => elements.editorDialog.close()));
    document.querySelectorAll("[data-close-detail]").forEach((button) => button.addEventListener("click", () => elements.detailDialog.close()));
    elements.detailDialog.addEventListener("close", releaseAttachmentUrls);
    byId("edit-lesson-button").addEventListener("click", () => {
      const lesson = state.lessons.find((item) => item.id === state.selectedLessonId);
      if (!lesson) return;
      elements.detailDialog.close();
      openEditor(lesson);
    });
    byId("delete-lesson-button").addEventListener("click", removeLesson);
    byId("export-button").addEventListener("click", async () => {
      try {
        await exportBackup();
      } catch (error) {
        showToast(`Could not export a backup: ${error.message}`, true);
      }
    });
    byId("import-button").addEventListener("click", () => elements.importFile.click());
    elements.importFile.addEventListener("change", () => importBackup(elements.importFile.files[0]));
    byId("restore-snapshot-button").addEventListener("click", restoreSnapshot);
    byId("restore-legacy-button").addEventListener("click", restoreLegacyCopy);
    byId("snapshot-select").addEventListener("change", () => {
      byId("restore-snapshot-button").disabled = !byId("snapshot-select").value;
    });
    byId("protect-storage-button").addEventListener("click", requestPersistentStorage);
    elements.search.addEventListener("input", () => {
      state.search = elements.search.value.trim();
      render();
    });
    elements.status.addEventListener("change", () => {
      state.status = elements.status.value;
      render();
    });
    elements.sort.addEventListener("change", () => {
      state.sort = elements.sort.value;
      render();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        elements.search.focus();
      }
      if (!event.ctrlKey && !event.metaKey && event.key.toLowerCase() === "n"
        && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
        && !elements.editorDialog.open && !elements.detailDialog.open) {
        openEditor();
      }
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) checkDueReminders();
    });
    window.addEventListener("focus", checkDueReminders);
    elements.editorDialog.addEventListener("click", (event) => {
      if (event.target === elements.editorDialog) elements.editorDialog.close();
    });
    elements.detailDialog.addEventListener("click", (event) => {
      if (event.target === elements.detailDialog) elements.detailDialog.close();
    });
  }

  async function initialize() {
    clearLegacyIntegrationState();
    try {
      state.lessons = await loadLessons();
      state.storageMode = window.VaultStorage.mode;
    } catch (error) {
      state.storageBlocked = true;
      showToast(error.message, true);
      state.lessons = [];
    }
    bindEvents();
    render();
    registerOfflineApp();
    checkDueReminders();
    refreshStorageStatus();
    refreshRestorePoints();
    window.setInterval(checkDueReminders, 30000);
    window.setInterval(() => {
      const previousDueCount = byId("due-nav-count").textContent;
      renderStats();
      if (state.view === "study" && previousDueCount !== byId("due-nav-count").textContent) render();
    }, 60000);
    const lessonToOpen = new URLSearchParams(location.search).get("lesson");
    if (lessonToOpen) openLesson(lessonToOpen);
  }

  function registerOfflineApp() {
    if (!("serviceWorker" in navigator) || !["http:", "https:"].includes(location.protocol)) return;
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "open-lesson" && typeof event.data.lessonId === "string") {
        openLesson(event.data.lessonId);
      }
    });
    navigator.serviceWorker.register("./service-worker.js")
      .catch((error) => showToast(`Offline app setup could not finish: ${error.message}`, true));
  }

  initialize();
})();
