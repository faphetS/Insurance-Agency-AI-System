(() => {
  "use strict";

  const STORAGE_KEY = "autoReplySettingsPassword";
  const API_BASE = "/api/settings/auto-reply";
  const TIME_ZONE = "Asia/Jerusalem";
  const REQUEST_TIMEOUT_MS = 15000;
  const TOAST_MS = 2500;

  const TOAST_SAVED = "✓ נשמר";
  const TOAST_UPDATED = "✓ ההודעה עודכנה";
  const TOAST_DELETED = "✓ נמחק";
  const TOAST_RESTORED = "✓ ההודעה המקורית שוחזרה";

  const ERROR_TEXT = {
    UNAUTHORIZED: "סיסמה שגויה",
    SETTINGS_DISABLED: "העמוד עדיין לא הוגדר",
    RATE_LIMITED: "יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.",
    UNTIL_IN_PAST: "בחרו תאריך ושעה עתידיים",
    UNTIL_TOO_FAR: "אפשר לבחור עד שנה קדימה",
    INVALID_UNTIL: "תאריך או שעה לא תקינים",
    MESSAGE_LIMIT_REACHED: "אפשר לשמור עד 50 הודעות. מחקו הודעה ישנה ונסו שוב.",
    DEFAULT_NOT_DELETABLE: "אי אפשר למחוק את ההודעה המקורית",
    NOT_FOUND: "ההודעה לא נמצאה (ייתכן שנמחקה)",
    VALIDATION_ERROR: "ההודעה ריקה או ארוכה מדי (עד 1000 תווים)",
    EMPTY_MESSAGE: "ההודעה ריקה",
    EMPTY_PASSWORD: "הזינו סיסמה",
    UNKNOWN: "משהו השתבש. נסו שוב.",
  };
  const CODE_BY_STATUS = { 401: "UNAUTHORIZED", 429: "RATE_LIMITED" };

  class AppError extends Error {
    constructor(code, status) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }

  const byId = (id) => document.getElementById(id);

  const els = {
    banner: byId("banner"),
    bannerText: byId("banner-text"),
    toast: byId("toast"),
    toastText: byId("toast-text"),
    retryError: byId("retry-error"),
    loginForm: byId("login-form"),
    loginPassword: byId("login-password"),
    loginError: byId("login-error"),
    statusBadge: byId("status-badge"),
    statusText: byId("status-text"),
    returning: byId("status-returning"),
    returningText: byId("status-returning-text"),
    composeOpen: byId("compose-open"),
    composer: byId("composer"),
    composeText: byId("compose-text"),
    composeCount: byId("compose-count"),
    composeError: byId("compose-error"),
    savedEmpty: byId("saved-empty"),
    list: byId("message-list"),
    restore: byId("restore-original"),
  };

  const views = {
    loading: byId("view-loading"),
    retry: byId("view-retry"),
    login: byId("view-login"),
    main: byId("view-main"),
  };

  const templates = {
    card: byId("tpl-card"),
    picker: byId("tpl-picker"),
  };

  const untilFormat = new Intl.DateTimeFormat("he-IL", {
    timeZone: TIME_ZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });

  const dateFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  let password = readPassword();
  let snapshot = "";
  let version = 0;
  let busy = false;
  let picker = null;
  let toastTimer = 0;

  function readPassword() {
    try {
      return localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      return "";
    }
  }

  function storePassword(value) {
    try {
      if (value) localStorage.setItem(STORAGE_KEY, value);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // storage can be blocked (private mode); the session keeps working from memory
    }
  }

  async function api(method, path, body) {
    // fetch rejects header values outside Latin-1, e.g. a password typed on a Hebrew keyboard
    if (/[^\x00-\xFF]/.test(password)) throw new AppError("UNAUTHORIZED", 401);

    const headers = { Authorization: `Bearer ${password}` };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(API_BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload && payload.status === "success") return payload;
      throw new AppError(
        (payload && payload.code) || CODE_BY_STATUS[response.status] || "UNKNOWN",
        response.status,
      );
    } catch (error) {
      throw error instanceof AppError ? error : new AppError("NETWORK", 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async function update(method, path, body) {
    const payload = await api(method, path, body);
    render(payload.state);
    return payload;
  }

  const formatUntil = (iso) => untilFormat.format(new Date(iso));

  function israelDate(date) {
    const parts = {};
    for (const { type, value } of dateFormat.formatToParts(date)) parts[type] = value;
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  function addDays(isoDate, days) {
    const [year, month, day] = isoDate.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
  }

  const errorCode = (error) => (error instanceof AppError ? error.code : "UNKNOWN");

  const messageFor = (code) =>
    typeof ERROR_TEXT[code] === "string" ? ERROR_TEXT[code] : ERROR_TEXT.UNKNOWN;

  function statusBadge({ source, until }) {
    if (source === "temporary") return { text: `זמנית עד ${formatUntil(until)}`, tone: "live" };
    if (source === "permanent") return { text: "קבועה", tone: "soft" };
    return { text: "קבועה · מקורית", tone: "soft" };
  }

  function renderStatus({ active, permanent, originalText }) {
    const badge = statusBadge(active);
    els.statusBadge.textContent = badge.text;
    els.statusBadge.className = `badge badge-${badge.tone}`;
    els.statusText.textContent = active.text;

    const isTemporary = active.source === "temporary";
    els.returning.hidden = !isTemporary;
    if (isTemporary) els.returningText.textContent = permanent ?? originalText;
  }

  const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);

  function buildCard(item, isActive) {
    const card = templates.card.content.firstElementChild.cloneNode(true);
    card.dataset.id = item.id;
    if (item.builtIn) card.dataset.builtin = "true";
    card.classList.toggle("is-active", isActive);
    slot(card, "text").textContent = item.text;
    slot(card, "builtin").hidden = !item.builtIn;
    slot(card, "active").hidden = !isActive;
    return card;
  }

  function renderMessages({ messages, active, originalHidden }) {
    const fragment = document.createDocumentFragment();
    for (const item of messages) fragment.append(buildCard(item, item.text === active.text));
    els.list.textContent = "";
    els.list.append(fragment);
    els.list.hidden = messages.length === 0;
    els.savedEmpty.hidden = messages.length > 0;
    els.restore.hidden = !originalHidden;
  }

  function render(state) {
    snapshot = JSON.stringify(state);
    version += 1;
    renderStatus(state);
    renderMessages(state);
    if (picker && !picker.element.isConnected) picker = null;
    setDisabled(busy);
    showView("main");
  }

  function showBanner(text) {
    els.bannerText.textContent = text;
    els.banner.hidden = false;
  }

  function hideBanner() {
    els.bannerText.textContent = "";
    els.banner.hidden = true;
  }

  function showInline(element, text) {
    element.textContent = text;
    element.hidden = false;
  }

  function clearInline(element) {
    element.textContent = "";
    element.hidden = true;
  }

  function toast(text) {
    els.toastText.textContent = text;
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), TOAST_MS);
  }

  function setDisabled(flag) {
    for (const button of document.querySelectorAll("button")) button.disabled = flag;
  }

  function setBusy(flag) {
    busy = flag;
    document.body.setAttribute("aria-busy", String(flag));
    setDisabled(flag);
  }

  async function handleError(error, sink) {
    if (!(error instanceof AppError)) console.error(error);
    const code = errorCode(error);
    if (code === "UNAUTHORIZED") {
      signOut(ERROR_TEXT.UNAUTHORIZED);
      return;
    }
    const text = messageFor(code);
    if (sink && code !== "NOT_FOUND") showInline(sink, text);
    else showBanner(text);
    if (code === "NOT_FOUND") await update("GET", "").catch(() => {});
  }

  async function run(task, sink) {
    if (busy) return;
    setBusy(true);
    hideBanner();
    if (sink) clearInline(sink);
    try {
      await task();
    } catch (error) {
      await handleError(error, sink);
    } finally {
      setBusy(false);
    }
  }

  function showView(name) {
    for (const [key, element] of Object.entries(views)) element.hidden = key !== name;
    if (name === "login") els.loginPassword.focus();
  }

  function signOut(message) {
    password = "";
    snapshot = "";
    storePassword("");
    closeComposer();
    hideBanner();
    els.loginPassword.value = "";
    clearInline(els.loginError);
    if (message) showInline(els.loginError, message);
    showView("login");
  }

  function onLoginSubmit(event) {
    event.preventDefault();
    const candidate = els.loginPassword.value.trim();
    run(async () => {
      if (!candidate) throw new AppError("EMPTY_PASSWORD", 0);
      password = candidate;
      try {
        await update("GET", "");
      } catch (error) {
        password = "";
        throw error;
      }
      storePassword(candidate);
      els.loginPassword.value = "";
    }, els.loginError);
  }

  async function loadInitialState() {
    showView("loading");
    try {
      await update("GET", "");
    } catch (error) {
      await handleError(error, els.retryError);
      if (password) showView("retry");
    }
  }

  async function refreshOnReturn() {
    if (document.visibilityState !== "visible" || busy || views.main.hidden) return;
    const startedAt = version;
    let fresh;
    try {
      fresh = (await api("GET", "")).state;
    } catch (error) {
      if (version === startedAt && !views.main.hidden && errorCode(error) === "UNAUTHORIZED") {
        signOut(ERROR_TEXT.UNAUTHORIZED);
      }
      return;
    }
    if (version !== startedAt || busy || views.main.hidden) return;
    if (JSON.stringify(fresh) !== snapshot) render(fresh);
  }

  function openPicker(host, submit) {
    closePicker();
    const element = templates.picker.content.firstElementChild.cloneNode(true);
    const today = israelDate(new Date());
    const dateInput = element.querySelector('input[type="date"]');
    dateInput.min = today;
    dateInput.value = addDays(today, 1);
    host.append(element);
    picker = { element, submit };
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element.scrollIntoView({ block: "nearest", behavior: reduceMotion ? "auto" : "smooth" });
  }

  function closePicker() {
    if (!picker) return;
    picker.element.remove();
    picker = null;
  }

  function confirmPicker() {
    if (!picker) return;
    const { element, submit } = picker;
    const date = element.querySelector('input[type="date"]').value;
    const time = element.querySelector('input[type="time"]').value;
    return run(() => {
      if (!date || !time) throw new AppError("INVALID_UNTIL", 0);
      return submit(`${date}T${time}`);
    }, element.querySelector(".inline-error"));
  }

  const cardOf = (button) => button.closest("[data-id]");

  function usePermanently(button) {
    const messageId = cardOf(button).dataset.id;
    return run(async () => {
      await update("POST", "/use", { messageId, mode: "permanent" });
      toast(TOAST_UPDATED);
    });
  }

  function chooseTemporary(button) {
    const card = cardOf(button);
    const messageId = card.dataset.id;
    openPicker(card, async (until) => {
      await update("POST", "/use", { messageId, mode: "temporary", until });
      toast(TOAST_UPDATED);
    });
  }

  function deleteMessage(button) {
    const card = cardOf(button);
    const question =
      card.dataset.builtin === "true"
        ? "למחוק את ההודעה המקורית? אפשר לשחזר אותה בכל רגע."
        : "למחוק את ההודעה הזו?";
    if (!window.confirm(question)) return;
    return run(async () => {
      await update("DELETE", `/messages/${encodeURIComponent(card.dataset.id)}`);
      toast(TOAST_DELETED);
    });
  }

  function restoreOriginal() {
    return run(async () => {
      await update("POST", "/original/restore");
      toast(TOAST_RESTORED);
    });
  }

  function endTemporary() {
    if (!window.confirm("לסיים את ההודעה הזמנית ולחזור להודעה הקבועה?")) return;
    return run(async () => {
      await update("DELETE", "/temporary");
      toast(TOAST_UPDATED);
    });
  }

  function updateCount() {
    els.composeCount.textContent = `${els.composeText.value.length}/${els.composeText.maxLength}`;
  }

  function openComposer() {
    els.composeOpen.hidden = true;
    els.composer.hidden = false;
    els.composeText.focus();
  }

  function closeComposer() {
    closePicker();
    clearInline(els.composeError);
    els.composeText.value = "";
    updateCount();
    els.composer.hidden = true;
    els.composeOpen.hidden = false;
  }

  function draftText() {
    const text = els.composeText.value.trim();
    if (!text) throw new AppError("EMPTY_MESSAGE", 0);
    return text;
  }

  async function saveDraft() {
    const { id } = await update("POST", "/messages", { text: draftText() });
    return id;
  }

  function saveDraftOnly() {
    return run(async () => {
      await saveDraft();
      closeComposer();
      toast(TOAST_SAVED);
    }, els.composeError);
  }

  function useDraftPermanently() {
    return run(async () => {
      const messageId = await saveDraft();
      await update("POST", "/use", { messageId, mode: "permanent" });
      closeComposer();
      toast(TOAST_UPDATED);
    }, els.composeError);
  }

  function chooseDraftTemporary() {
    clearInline(els.composeError);
    if (!els.composeText.value.trim()) {
      showInline(els.composeError, ERROR_TEXT.EMPTY_MESSAGE);
      return;
    }
    openPicker(els.composer, async (until) => {
      const messageId = await saveDraft();
      await update("POST", "/use", { messageId, mode: "temporary", until });
      closeComposer();
      toast(TOAST_UPDATED);
    });
  }

  const ACTIONS = {
    "banner-close": hideBanner,
    retry: loadInitialState,
    "sign-out": () => signOut(),
    "end-temporary": endTemporary,
    "compose-open": openComposer,
    "compose-cancel": closeComposer,
    "compose-save": saveDraftOnly,
    "compose-permanent": useDraftPermanently,
    "compose-temporary": chooseDraftTemporary,
    "use-permanent": usePermanently,
    "use-temporary": chooseTemporary,
    "delete-message": deleteMessage,
    "restore-original": restoreOriginal,
    "picker-confirm": confirmPicker,
    "picker-cancel": closePicker,
  };

  function onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    const action = ACTIONS[button.dataset.action];
    if (action) action(button);
  }

  function start() {
    document.addEventListener("click", onClick);
    document.addEventListener("visibilitychange", refreshOnReturn);
    els.loginForm.addEventListener("submit", onLoginSubmit);
    els.composeText.addEventListener("input", updateCount);

    if (password) loadInitialState();
    else showView("login");
  }

  start();
})();
