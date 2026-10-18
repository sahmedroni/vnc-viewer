import RFB from "/vendor/novnc/core/rfb.js";

const token =
  document.querySelector('meta[name="proxy-token"]')?.content ?? "";
const form = document.getElementById("connect-form");
const hostInput = document.getElementById("host");
const portInput = document.getElementById("port");
const labelInput = document.getElementById("label");
const passwordInput = document.getElementById("password");
const saveConnBtn = document.getElementById("save-conn");
const formError = document.getElementById("form-error");
const connectView = document.getElementById("connect-view");
const viewerView = document.getElementById("viewer-view");
const screen = document.getElementById("screen");
const statusEl = document.getElementById("status");
const targetLabel = document.getElementById("target-label");
const disconnectBtn = document.getElementById("disconnect");
const fullscreenBtn = document.getElementById("fullscreen");
const pasteBtn = document.getElementById("paste");
const cadBtn = document.getElementById("cad");
const passwordModal = document.getElementById("password-modal");
const passwordForm = document.getElementById("password-form");
const promptPassword = document.getElementById("prompt-password");
const passwordError = document.getElementById("password-error");
const passwordCancel = document.getElementById("password-cancel");
const toastEl = document.getElementById("toast");
const savedSection = document.getElementById("saved-section");
const savedList = document.getElementById("saved-list");
const savedSearch = document.getElementById("saved-search");
const savedNoMatch = document.getElementById("saved-nomatch");
const savedCount = document.getElementById("saved-count");
const historyCount = document.getElementById("history-count");
const historySection = document.getElementById("history-section");
const historyList = document.getElementById("history-list");
const sidebarEmpty = document.getElementById("sidebar-empty");

const SAVED_KEY = "vnc.saved"; // legacy browser-stored list; migrated on load
const HISTORY_KEY = "vnc.history";
const HISTORY_MAX = 10;

let rfb = null;
let rfbClosed = false; // true once this session's socket has gone away
let savedConnections = []; // server-side list, from connections/connections.json

// ---------- history (this browser only) ----------

function readJson(key) {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value) ? value.filter((e) => e && e.host && e.port) : [];
  } catch {
    return [];
  }
}

function writeJson(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {}
}

function entryIndex(list, host, port) {
  return list.findIndex((e) => e.host === host && Number(e.port) === port);
}

function recordHistory(host, port) {
  const list = readJson(HISTORY_KEY);
  const i = entryIndex(list, host, port);
  if (i >= 0) list.splice(i, 1);
  list.unshift({ host, port, at: Date.now() });
  writeJson(HISTORY_KEY, list.slice(0, HISTORY_MAX));
  renderLists();
}

// ---------- saved connections (server, via /api/connections) ----------

async function api(method, body, query = "") {
  const res = await fetch(`/api/connections${query}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Proxy-Token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadSaved() {
  try {
    savedConnections = await api("GET");
  } catch {
    savedConnections = [];
  }
  await migrateLegacySaved();
  renderLists();
}

async function saveConnection(host, port, label) {
  savedConnections = await api("POST", { host, port, label });
  renderLists();
}

async function removeSaved(host, port) {
  savedConnections = await api(
    "DELETE",
    undefined,
    `?host=${encodeURIComponent(host)}&port=${port}`,
  );
  renderLists();
}

async function editSaved(host, port, next) {
  savedConnections = await api(
    "PUT",
    next,
    `?host=${encodeURIComponent(host)}&port=${port}`,
  );
  renderLists();
}

function isSaved(host, port) {
  return entryIndex(savedConnections, host, port) >= 0;
}

// Move anything left in the old browser list into the JSON file, once.
async function migrateLegacySaved() {
  const legacy = readJson(SAVED_KEY);
  if (legacy.length === 0) return;
  for (const e of legacy) {
    if (isSaved(e.host, Number(e.port))) continue;
    try {
      savedConnections = await api("POST", {
        host: e.host,
        port: Number(e.port),
        label: e.label ?? "",
      });
    } catch {
      return; // keep the legacy list so the migration can retry next load
    }
  }
  writeJson(SAVED_KEY, []);
}

// ---------- lists ----------

const formatTarget = (e) => `${e.host}:${e.port}`;

// Inline icons for row actions. Stroke-only, so they inherit button colour.
const ICONS = {
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M6.5 7l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12"/><path d="M10 11v6M14 11v6"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12v16l-6-4.2L6 20z"/></svg>',
  bookmarked: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M6 4h12v16l-6-4.2L6 20z"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>',
};

function iconButton(icon, label, className = "icon") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.innerHTML = ICONS[icon];
  btn.title = label;
  btn.setAttribute("aria-label", label);
  return btn;
}

function renderRow(entry, kind) {
  const li = document.createElement("li");

  // A recent entry that matches a saved connection borrows its name, so the
  // list reads the same in both sections.
  const host = entry.host;
  const port = Number(entry.port);
  const savedMatch =
    kind === "history"
      ? savedConnections.find((e) => e.host === host && Number(e.port) === port)
      : null;
  const label = savedMatch?.label || entry.label || "";

  const row = document.createElement("button");
  row.type = "button";
  row.className = "row";
  row.title = `Connect to ${formatTarget(entry)}`;

  const name = document.createElement("span");
  name.className = "row-name";
  name.textContent = label || formatTarget(entry);

  const addr = document.createElement("span");
  addr.className = "row-addr";
  addr.textContent = label ? formatTarget(entry) : "";

  row.append(name, addr);
  row.addEventListener("click", () => {
    // No password is stored, so reuse whatever is typed in the field.
    connect(entry.host, Number(entry.port), passwordInput.value);
  });

  if (kind === "saved") {
    const edit = iconButton("edit", "Edit this saved connection");
    const remove = iconButton("trash", "Remove from saved connections");

    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await removeSaved(entry.host, Number(entry.port));
      } catch (err) {
        remove.disabled = false;
        showError(`Could not remove: ${err.message}`);
      }
    });

    edit.addEventListener("click", () => swapToEditor(li, entry, row, remove, edit));

    li.append(row, edit, remove);
    return li;
  }

  if (isSaved(entry.host, Number(entry.port))) {
    const saved = iconButton("bookmarked", "Already saved", "icon is-saved");
    saved.disabled = true;
    li.append(row, saved);
  } else {
    const save = iconButton("bookmark", "Save this connection");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        await saveConnection(entry.host, Number(entry.port), labelInput.value.trim());
      } catch (err) {
        save.disabled = false;
        showError(`Could not save: ${err.message}`);
      }
    });
    li.append(row, save);
  }

  // Recent entries also get a small dismiss button.
  if (kind === "history") {
    const dismiss = iconButton("close", `Remove ${formatTarget(entry)} from recent`, "icon dismiss");
    dismiss.addEventListener("click", () => removeHistory(entry.host, Number(entry.port)));
    li.append(dismiss);
  }

  return li;
}

// Replace a saved row with inputs for name/host/port, plus Save and Cancel.
function swapToEditor(li, entry, row, removeBtn, editBtn) {
  const originalPort = Number(entry.port);

  const form = document.createElement("form");
  form.className = "row-editor";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "edit-name";
  nameInput.placeholder = "Name";
  nameInput.value = entry.label ?? "";

  const hostInputEl = document.createElement("input");
  hostInputEl.type = "text";
  hostInputEl.className = "edit-host";
  hostInputEl.placeholder = "Host / IP";
  hostInputEl.value = entry.host;
  hostInputEl.spellcheck = false;
  hostInputEl.autocapitalize = "off";

  const portInputEl = document.createElement("input");
  portInputEl.type = "number";
  portInputEl.className = "edit-port";
  portInputEl.min = "1";
  portInputEl.max = "65535";
  portInputEl.value = String(originalPort);

  const save = iconButton("check", "Save changes");
  save.type = "submit";

  const cancel = iconButton("close", "Cancel editing");

  const error = document.createElement("p");
  error.className = "error";
  error.hidden = true;

  form.append(nameInput, hostInputEl, portInputEl, save, cancel, error);
  li.replaceChildren(form);
  nameInput.focus();
  nameInput.select();

  const restore = () => li.replaceChildren(row, editBtn, removeBtn);
  cancel.addEventListener("click", restore);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const host = hostInputEl.value.trim();
    const port = Number(portInputEl.value);

    if (!host) {
      error.textContent = "Enter a host or IP address.";
      error.hidden = false;
      return;
    }
    if (!/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)$/.test(host)) {
      error.textContent = "Enter just the address, without a scheme or path.";
      error.hidden = false;
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error.textContent = "Port must be between 1 and 65535.";
      error.hidden = false;
      return;
    }

    save.disabled = true;
    cancel.disabled = true;
    try {
      await editSaved(entry.host, originalPort, {
        host,
        port,
        label: nameInput.value.trim(),
      });
      // editSaved re-renders, so this row is already gone.
    } catch (err) {
      save.disabled = false;
      cancel.disabled = false;
      error.textContent = err.message;
      error.hidden = false;
    }
  });
}

function removeHistory(host, port) {
  const list = readJson(HISTORY_KEY).filter(
    (e) => !(e.host === host && Number(e.port) === port),
  );
  writeJson(HISTORY_KEY, list);
  renderLists();
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const haystack = `${entry.label ?? ""} ${entry.host} ${entry.host}:${entry.port}`.toLowerCase();
  // Every term must appear somewhere, so "scan 100" narrows by name and IP.
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

function renderLists() {
  const saved = savedConnections;
  const query = savedSearch.value.trim();
  const shown = saved.filter((e) => matchesQuery(e, query));

  savedSection.hidden = saved.length === 0;
  savedList.replaceChildren(...shown.map((e) => renderRow(e, "saved")));
  savedNoMatch.hidden = shown.length > 0 || saved.length === 0;
  savedNoMatch.textContent = query ? "No matching connections." : "";
  // Show how many match while searching, otherwise the total.
  savedCount.textContent = query ? `${shown.length}/${saved.length}` : String(saved.length);

  const history = readJson(HISTORY_KEY);
  historySection.hidden = history.length === 0;
  historyList.replaceChildren(...history.map((e) => renderRow(e, "history")));
  historyCount.textContent = String(history.length);

  sidebarEmpty.hidden = saved.length > 0 || history.length > 0;
}

function prefill() {
  const [latest] = readJson(HISTORY_KEY);
  if (!latest) return;
  hostInput.value = latest.host;
  portInput.value = latest.port;
}

// ---------- form ----------
function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status status-${kind}`;
}

function showError(message) {
  formError.textContent = message;
  formError.hidden = false;
  formError.scrollIntoView({ block: "nearest" });
}

function showForm() {
  connectView.hidden = false;
  viewerView.hidden = true;
  disconnectBtn.hidden = true;
  fullscreenBtn.hidden = true;
  pasteBtn.hidden = true;
  cadBtn.hidden = true;
  hostInput.focus();
}

function readForm() {
  const host = hostInput.value.trim();
  const port = Number(portInput.value);

  if (!host) {
    showError("Enter a host or IP address.");
    return null;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    showError("Port must be a number between 1 and 65535.");
    return null;
  }
  // Brackets are allowed so an IPv6 literal can be entered as [::1].
  if (!/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+)$/.test(host)) {
    showError("Enter just the address (letters, digits, dots, dashes), without a scheme or path.");
    return null;
  }
  return { host, port, password: passwordInput.value, label: labelInput.value.trim() };
}

// ---------- password prompt ----------

// Resolves with the entered password, or null if the user cancelled.
function askPassword() {
  return new Promise((resolve) => {
    promptPassword.value = "";
    passwordError.hidden = true;
    passwordModal.hidden = false;
    promptPassword.focus();

    const finish = (value) => {
      passwordForm.removeEventListener("submit", onSubmit);
      passwordCancel.removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
      passwordModal.hidden = true;
      promptPassword.value = "";
      resolve(value);
    };

    const onSubmit = (e) => {
      e.preventDefault();
      const value = promptPassword.value;
      if (!value) {
        passwordError.textContent = "Enter the VNC password.";
        passwordError.hidden = false;
        return;
      }
      finish(value);
    };

    const onCancel = () => finish(null);

    // Escape cancels, matching the old dialog's behaviour.
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    };

    passwordForm.addEventListener("submit", onSubmit);
    passwordCancel.addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);
  });
}

// ---------- clipboard ----------

let toastTimer = 0;

function toast(message) {
  toastEl.textContent = message;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 2200);
}

// Copy text from the remote session into the local clipboard.
async function copyToLocal(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Clipboard API is unavailable (insecure context) or permission denied.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  document.body.append(area);
  area.select();
  try {
    if (!document.execCommand("copy")) throw new Error("copy rejected");
  } finally {
    area.remove();
  }
}

// Send the local clipboard to the remote session.
async function pasteToRemote() {
  if (!rfb || rfbClosed) return;
  try {
    const text = await navigator.clipboard.readText();
    if (!text) {
      toast("Local clipboard is empty");
      return;
    }
    rfb.clipboardPasteFrom(text);
    toast(`Pasted ${text.length} characters`);
  } catch {
    toast("Cannot read the clipboard — use Ctrl+V inside the session");
  }
}

function teardown() {
  if (rfb) {
    // noVNC warns if disconnect() runs on an object that already dropped its
    // socket (e.g. the delayed cleanup after a server-side close).
    try {
      if (!rfbClosed) rfb.disconnect();
    } catch {}
    rfb = null;
  }
  rfbClosed = false;
  screen.replaceChildren();
}

function connect(host, port, password) {
  teardown();
  formError.hidden = true;

  // Encode the target once; it is validated again on the server.
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  const target = `${host}:${port}`;
  const url = `${wsScheme}://${location.host}/ws?target=${encodeURIComponent(target)}&token=${encodeURIComponent(token)}`;

  connectView.hidden = true;
  viewerView.hidden = false;
  screen.replaceChildren();
  rfbClosed = false;
  targetLabel.textContent = target;
  setStatus("connecting", "connecting");
  disconnectBtn.hidden = false;

  try {
    rfb = new RFB(screen, url, {
      credentials: password ? { password } : undefined,
    });
  } catch (err) {
    setStatus("error", "error");
    showError(`Could not start the viewer: ${err.message}`);
    showForm();
    return;
  }

  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.focusOnClick = true;
  rfb.clipViewport = true;
  rfb.viewportDrag = true;
  rfb.background = "#000";
  // Some servers send an empty cursor (e.g. TightVNC until Windows changes
  // it), leaving nothing on screen. Fall back to a dot so the pointer is
  // always visible; noVNC still uses the real shape when one is available.
  rfb.showDotCursor = true;

  rfb.addEventListener("connect", () => {
    setStatus("connected", "connected");
    fullscreenBtn.hidden = false;
    pasteBtn.hidden = false;
    cadBtn.hidden = false;
    screen.focus();
    // Only successful sessions make it into the history.
    recordHistory(host, port);
  });

  // Remote copied something: mirror it into this machine's clipboard.
  rfb.addEventListener("clipboard", (e) => {
    const text = e.detail?.text;
    if (!text) return;
    copyToLocal(text)
      .then(() => toast("Copied from remote to your clipboard"))
      .catch(() => toast("Remote clipboard changed — press Ctrl+C in the session"))
      // The fallback path steals focus; hand it back to the session.
      .finally(() => {
        if (!rfbClosed) screen.focus();
      });
  });

  rfb.addEventListener("disconnect", (e) => {
    rfbClosed = true; // noVNC already tore down its socket
    const clean = e.detail?.clean;
    setStatus(clean ? "disconnected" : "connection lost", clean ? "connecting" : "error");
    fullscreenBtn.hidden = true;
    // Show the outcome briefly, then offer the form again and clean up.
    const session = rfb;
    setTimeout(() => {
      if (rfb !== session) return; // user already reconnected or left
      teardown();
      showForm();
    }, 2000);
  });

  // Server wants a password we did not send: ask in-app and retry.
  rfb.addEventListener("credentialsrequired", async () => {
    const session = rfb;
    const entered = await askPassword();
    if (rfb !== session || rfbClosed) return; // left or dropped meanwhile
    if (entered === null) {
      rfb.disconnect();
      return;
    }
    // Keep it for a retry on this page, but never persist it anywhere.
    passwordInput.value = entered;
    rfb.sendCredentials({ password: entered });
  });

  rfb.addEventListener("securityfailure", (e) => {
    const reason = e.detail?.reason;
    setStatus("security failure", "error");
    // A rejected password means the stored one is wrong; clear it so the
    // next attempt prompts instead of retrying the same value.
    passwordInput.value = "";
    showError(reason ? `Server refused authentication: ${reason}` : "Authentication failed.");
  });

  rfb.addEventListener("error", (e) => {
    const detail = e.detail ?? {};
    const message = detail.message ?? detail.name ?? "unknown error";
    setStatus("error", "error");
    showError(`Connection error: ${message}`);
  });
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const values = readForm();
  if (!values) return;
  connect(values.host, values.port, values.password);
});

saveConnBtn.addEventListener("click", async () => {
  const values = readForm();
  if (!values) return;
  formError.hidden = true;
  saveConnBtn.disabled = true;
  try {
    await saveConnection(values.host, values.port, values.label);
  } catch (err) {
    showError(`Could not save: ${err.message}`);
  } finally {
    saveConnBtn.disabled = false;
  }
});

disconnectBtn.addEventListener("click", () => {
  teardown();
  showForm();
});

// Filter the saved list as the user types.
savedSearch.addEventListener("input", renderLists);

pasteBtn.addEventListener("click", pasteToRemote);

cadBtn.addEventListener("click", () => {
  if (!rfb || rfbClosed) return;
  // noVNC sends the full sequence with correct down/up ordering.
  rfb.sendCtrlAltDel();
  toast("Sent Ctrl+Alt+Del");
  screen.focus(); // return keyboard focus to the session
});

// Ctrl+V / Cmd+V while the session has focus sends the local clipboard.
// (noVNC handles the remote→local direction itself via its "clipboard" event.)
window.addEventListener("keydown", (e) => {
  if (!rfb || rfbClosed) return;
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "v") return;
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  e.preventDefault();
  void pasteToRemote();
});

fullscreenBtn.addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await viewerView.querySelector(".session-card").requestFullscreen();
  } catch {
    // Fullscreen may be blocked; the viewer keeps working maximized.
  }
});

// If the tab is closed mid-session, drop the socket promptly.
window.addEventListener("pagehide", teardown);

loadSaved();
prefill();
