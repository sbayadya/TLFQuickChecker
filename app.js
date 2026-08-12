/* TLF Quick Checker — clinical TLF validation, fully client-side.
   PDF #1 (required): structure + big-N format check.
   PDF #2 (optional): shell/template match.
   adsl.sas7bdat (optional): local count reconciliation vs big-Ns.
   Settings + history persist in localStorage. */

(() => {
  "use strict";

  const LS_SETTINGS = "tlfqc.settings.v2";
  const LS_HISTORY = "tlfqc.history.v2";
  const MAX_PDF_BYTES = 18 * 1024 * 1024;
  const MAX_DS_BYTES = 200 * 1024 * 1024;

  const DEFAULT_SYSTEM_PROMPT =
`You are a precise QC reviewer for clinical-trial TLFs (Tables, Listings, Figures),
following standard industry / PHUSE-style display conventions. You verify that outputs
have proper headers, titles and footnotes, that treatment-column "big N" values are
resolved integers (not placeholders like N=xx), and that a final output matches its
shell/template. Be exact and never fabricate values not present in the document.`;

  const DEFAULT_SETTINGS = {
    provider: "gemini",
    apiKey: "",
    model: "gemini-3.5-flash",
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    temperature: 0.2,
    maxTokens: 8192,
  };

  const KNOWN_MODELS = ["gemini-3.5-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"];
  // Models Google has retired for new API keys — auto-upgraded to the current default.
  const RETIRED_MODELS = [
    "gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite",
    "gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-flash", "gemini-1.5-pro",
  ];

  // ---------- State ----------
  let settings = loadSettings();
  let history = loadHistory();
  let activeId = null;
  let busy = false;

  // Pending inputs for the next check
  const inputs = {
    pdf1: null,     // { name, size, base64 }
    pdf2: null,     // { name, size, base64 }
    dataset: null,  // { name, size, columns:[], nrows }
  };
  let dsConfig = { trtVar: "", popFlag: "", popValue: "Y" };

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const el = {};
  [
    "sidebar", "historyList", "historySearch", "conversation", "emptyState",
    "viewTitle", "modelChip", "instructions", "sendBtn", "sendLabel", "composerNote",
    "newChatBtn", "openSettingsBtn", "emptySettingsBtn", "toggleSidebarBtn",
    "datasetControls", "trtVar", "popFlag", "popValue",
    "settingsModal", "settingsHint", "closeSettingsBtn", "cancelSettingsBtn", "saveSettingsBtn",
    "clearHistoryBtn", "setProvider", "setApiKey", "toggleKeyBtn", "setModel",
    "setModelCustom", "setSystemPrompt", "setTemp", "tempVal", "setMaxTokens",
  ].forEach((k) => (el[k] = $(k)));

  // ---------- Storage ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      const s = raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
      if (RETIRED_MODELS.includes(s.model)) s.model = DEFAULT_SETTINGS.model; // auto-upgrade retired models
      return s;
    } catch { return { ...DEFAULT_SETTINGS }; }
  }
  function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
  function loadHistory() {
    try { const raw = localStorage.getItem(LS_HISTORY); return raw ? JSON.parse(raw) : []; }
    catch { return []; }
  }
  function saveHistory() {
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(history)); }
    catch {
      while (history.length > 1) {
        history.pop();
        try { localStorage.setItem(LS_HISTORY, JSON.stringify(history)); return; } catch {}
      }
    }
  }

  // ---------- Utils ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fmtBytes(n) {
    if (n < 1024) return n + " B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    return (n / 1024 / 1024).toFixed(1) + " MB";
  }
  function fmtTime(ts) {
    return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => { const s = String(r.result); resolve(s.slice(s.indexOf(",") + 1)); };
      r.onerror = () => reject(new Error("Could not read file"));
      r.readAsDataURL(file);
    });
  }
  function note(msg, isErr = false) {
    el.composerNote.textContent = msg || "";
    el.composerNote.classList.toggle("err", !!isErr && !!msg);
  }
  function isValidBigN(value) { return /^\d+$/.test(String(value == null ? "" : value).trim()); }

  // ---------- Label matching (auto-match big-Ns to dataset groups) ----------
  function normLabel(s) {
    return String(s == null ? "" : s)
      .toLowerCase()
      .replace(/\(?\s*n\s*=\s*[^)]*\)?/g, " ")   // strip "(N=..)"
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  function tokens(s) { return normLabel(s).split(" ").filter(Boolean); }
  function similarity(a, b) {
    const A = new Set(tokens(a)), B = new Set(tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach((t) => { if (B.has(t)) inter++; });
    return inter / new Set([...A, ...B]).size; // Jaccard
  }

  // Reconcile dataset group counts against PDF big-Ns (label-based, greedy).
  function reconcile(bigNs, groups) {
    const validNs = (bigNs || []).map((b) => ({
      label: b.columnLabel || b.rawText || "",
      n: isValidBigN(b.value) ? parseInt(String(b.value).trim(), 10) : null,
      raw: b.rawText,
    }));
    const rows = [];
    const usedPdf = new Set();
    (groups || []).forEach((g) => {
      let best = -1, bestScore = 0;
      validNs.forEach((p, i) => {
        if (usedPdf.has(i)) return;
        const s = similarity(g.label || String(g.code), p.label);
        if (s > bestScore) { bestScore = s; best = i; }
      });
      let matched = null;
      if (best >= 0 && bestScore >= 0.34) { matched = validNs[best]; usedPdf.add(best); }
      let status;
      if (!matched) status = "nomatch";
      else if (matched.n == null) status = "placeholder";
      else status = matched.n === g.count ? "ok" : "mismatch";
      rows.push({
        dsLabel: g.label || `(code ${g.code})`,
        dsCount: g.count,
        pdfLabel: matched ? matched.label : null,
        pdfN: matched ? matched.raw : null,
        matchScore: bestScore,
        status,
      });
    });
    // PDF columns with no dataset counterpart
    validNs.forEach((p, i) => {
      if (!usedPdf.has(i)) rows.push({
        dsLabel: null, dsCount: null, pdfLabel: p.label, pdfN: p.raw, status: "extra",
      });
    });
    const overall = rows.every((r) => r.status === "ok") && rows.length > 0 ? "ok"
      : rows.some((r) => r.status === "mismatch") ? "mismatch" : "warn";
    return { rows, overall };
  }

  // ---------- File slots ----------
  async function setFile(slot, file) {
    if (!file) return;
    if (slot === "dataset") {
      if (!/\.(sas7bdat|xpt|csv)$/i.test(file.name)) { note("Slot 3 expects a .sas7bdat, .xpt or .csv file.", true); return; }
      if (file.size > MAX_DS_BYTES) { note(`Dataset too large (${fmtBytes(file.size)}).`, true); return; }
      note("Reading dataset locally (loading Python runtime if needed)…");
      try {
        const meta = await window.SAS.parseMeta(file, (m) => note(m || "Reading dataset locally…"));
        inputs.dataset = { name: file.name, size: file.size, columns: meta.columns, nrows: meta.nrows };
        setupDatasetControls();
        note(`Loaded ${file.name} — ${meta.nrows} rows, ${meta.columns.length} columns.`);
      } catch (e) {
        inputs.dataset = null;
        note(e.message || "Failed to read dataset.", true);
      }
      renderSlots();
      updateSendState();
      return;
    }
    // PDF slots
    const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    if (!isPdf) { note("Please choose a PDF file.", true); return; }
    if (file.size > MAX_PDF_BYTES) { note(`PDF too large (${fmtBytes(file.size)}); limit ~18 MB.`, true); return; }
    note("Reading PDF…");
    try {
      const base64 = await fileToBase64(file);
      inputs[slot] = { name: file.name, size: file.size, base64 };
      note("");
    } catch (e) { note(e.message || "Failed to read PDF.", true); }
    renderSlots();
    updateSendState();
  }

  function clearFile(slot) {
    inputs[slot] = null;
    if (slot === "dataset") { el.datasetControls.classList.add("hidden"); }
    renderSlots();
    updateSendState();
  }

  function renderSlots() {
    [["pdf1", "1"], ["pdf2", "2"], ["dataset", "3"]].forEach(([slot]) => {
      const node = document.querySelector(`.slot[data-slot="${slot}"]`);
      if (!node) return;
      const f = inputs[slot];
      const chip = node.querySelector(".slot-chip");
      const pick = node.querySelector(".slot-pick");
      if (f) {
        chip.classList.remove("hidden");
        pick.classList.add("hidden");
        chip.querySelector(".slot-name").textContent = f.name;
        const sub = slot === "dataset" ? `${f.nrows} rows · ${f.columns.length} cols` : fmtBytes(f.size);
        chip.querySelector(".slot-sub").textContent = sub;
      } else {
        chip.classList.add("hidden");
        pick.classList.remove("hidden");
      }
    });
  }

  function setupDatasetControls() {
    if (!inputs.dataset) return;
    const cols = inputs.dataset.columns;
    // Treatment var options: prefer TRT01PN / TRT01AN, then any numeric-treatment guesses.
    const trtPrefer = ["TRT01PN", "TRT01AN", "TRTPN", "TRTAN"].filter((c) => cols.includes(c));
    const trtOthers = cols.filter((c) => /TRT.*N$/.test(c) && !trtPrefer.includes(c));
    const trtOpts = [...trtPrefer, ...trtOthers];
    el.trtVar.innerHTML = (trtOpts.length ? trtOpts : cols)
      .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    dsConfig.trtVar = trtOpts[0] || cols[0] || "";
    el.trtVar.value = dsConfig.trtVar;

    // Population flag options: columns ending in FL, plus a "none" option.
    const flags = cols.filter((c) => /FL$/.test(c));
    const flagPrefer = ["SAFFL", "ITTFL", "FASFL", "RANDFL", "EFFFL", "PPROTFL", "COMPLFL"]
      .filter((c) => flags.includes(c));
    const flagOpts = [...flagPrefer, ...flags.filter((c) => !flagPrefer.includes(c))];
    el.popFlag.innerHTML = `<option value="">(no population filter)</option>` +
      flagOpts.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
    dsConfig.popFlag = flagPrefer[0] || "";
    el.popFlag.value = dsConfig.popFlag;
    el.popValue.value = dsConfig.popValue || "Y";

    el.datasetControls.classList.remove("hidden");
  }

  function updateSendState() {
    el.sendBtn.disabled = busy || !inputs.pdf1;
  }

  // ---------- Evaluate ----------
  async function evaluate() {
    if (busy) return;
    if (!settings.apiKey) {
      note("No API key set — opening Settings so you can add one.", true);
      openSettings("nokey");
      return;
    }
    if (!inputs.pdf1) { note("PDF #1 (the TLF output) is required.", true); return; }

    dsConfig.trtVar = el.trtVar.value;
    dsConfig.popFlag = el.popFlag.value;
    dsConfig.popValue = el.popValue.value.trim() || "Y";

    const entry = {
      id: uid(),
      ts: Date.now(),
      files: {
        pdf1: { name: inputs.pdf1.name, size: inputs.pdf1.size },
        pdf2: inputs.pdf2 ? { name: inputs.pdf2.name, size: inputs.pdf2.size } : null,
        dataset: inputs.dataset ? { name: inputs.dataset.name, size: inputs.dataset.size } : null,
      },
      dsConfig: inputs.dataset ? { ...dsConfig } : null,
      instructions: el.instructions.value.trim(),
      model: settings.model,
      status: "pending",
      error: "",
      ai: null, counts: null, reconciliation: null,
    };
    history.unshift(entry);
    activeId = entry.id;

    // Snapshot inputs, then reset composer for the next check.
    const snap = { pdf1: inputs.pdf1, pdf2: inputs.pdf2, hasDataset: !!inputs.dataset, dsConfig: { ...dsConfig } };
    const instructions = entry.instructions;

    setBusy(true);
    renderHistory();
    renderConversation();

    try {
      // 1) Count dataset locally first (never sent to AI).
      if (snap.hasDataset) {
        entry.counts = await window.SAS.computeCounts(snap.dsConfig);
      }
      // 2) Ask Gemini about the PDF(s).
      const ai = await window.Gemini.evaluate({
        settings, pdf1: snap.pdf1, pdf2: snap.pdf2, instructions,
      });
      // Validate big-N format locally (deterministic).
      (ai.bigNs || []).forEach((b) => { b.valid = isValidBigN(b.value); });
      entry.ai = ai;
      // 3) Reconcile.
      if (entry.counts && entry.counts.groups) {
        entry.reconciliation = reconcile(ai.bigNs, entry.counts.groups);
      }
      entry.status = "done";
    } catch (e) {
      entry.error = e.message || String(e);
      entry.status = "error";
    } finally {
      setBusy(false);
      saveHistory();
      renderHistory();
      renderConversation();
    }
  }

  function setBusy(b) {
    busy = b;
    el.sendLabel.textContent = b ? "Validating…" : "Validate";
    updateSendState();
  }

  // ---------- Report rendering ----------
  function badge(kind, text) {
    const map = { ok: "ok", warn: "warn", fail: "fail", info: "info" };
    return `<span class="badge ${map[kind] || "info"}">${escapeHtml(text)}</span>`;
  }
  function checkRow(label, pass, detail) {
    const b = pass === true ? badge("ok", "PASS") : pass === false ? badge("fail", "FAIL") : badge("info", "—");
    return `<div class="check-row">${b}<div><strong>${escapeHtml(label)}</strong>${
      detail ? `<div class="check-detail">${detail}</div>` : ""}</div></div>`;
  }
  function list(items) {
    if (!items || !items.length) return `<em class="muted">none found</em>`;
    return `<ul class="tight">${items.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
  }

  function renderReport(entry) {
    const ai = entry.ai || {};
    const st = ai.structure || {};
    let html = "";

    // Summary
    if (ai.summary) html += `<div class="report-summary">${escapeHtml(ai.summary)}</div>`;

    // Section 1: structure (PDF #1)
    html += `<div class="report-section"><h3>1 · Structure — ${escapeHtml(ai.outputType || "TLF")} (PDF #1)</h3>`;
    html += checkRow("Header present", !!st.hasHeader,
      st.headerText ? escapeHtml(st.headerText) : "");
    html += checkRow("Title(s) present", !!st.hasTitles, list(st.titles));
    html += checkRow("Footnote(s) present", !!st.hasFootnotes, list(st.footnotes));
    if (st.notes) html += `<div class="check-detail muted">${escapeHtml(st.notes)}</div>`;
    html += `</div>`;

    // Section 2: big-N format
    const bigNs = ai.bigNs || [];
    const bad = bigNs.filter((b) => !b.valid);
    html += `<div class="report-section"><h3>2 · Big-N format ${
      bigNs.length ? (bad.length ? badge("fail", `${bad.length} invalid`) : badge("ok", "all valid")) : badge("warn", "none found")
    }</h3>`;
    html += `<div class="check-detail muted">Rule: each treatment column must show <code>N=&lt;integer&gt;</code> (e.g. <code>N=54</code>). Placeholders like <code>N=xx</code> fail.</div>`;
    if (bigNs.length) {
      html += `<table class="rt"><thead><tr><th>Column</th><th>Printed</th><th>Verdict</th></tr></thead><tbody>`;
      bigNs.forEach((b) => {
        html += `<tr><td>${escapeHtml(b.columnLabel)}</td><td><code>${escapeHtml(b.rawText || ("N=" + b.value))}</code></td><td>${
          b.valid ? badge("ok", "integer") : badge("fail", "placeholder / invalid")}</td></tr>`;
      });
      html += `</tbody></table>`;
    }
    html += `</div>`;

    // Section 3: template match (PDF #2)
    const tm = ai.templateMatch || {};
    if (entry.files.pdf2) {
      html += `<div class="report-section"><h3>3 · Template match (PDF #2 = shell)</h3>`;
      if (tm.evaluated) {
        html += checkRow("Header matches shell", !!tm.headerMatch);
        html += checkRow("Titles match shell", !!tm.titleMatch);
        html += checkRow("Footnotes match shell", !!tm.footnoteMatch);
        if (tm.differences && tm.differences.length)
          html += `<div class="check-detail"><strong>Differences:</strong>${list(tm.differences)}</div>`;
      } else {
        html += `<div class="check-detail muted">Not evaluated by the model.</div>`;
      }
      html += `</div>`;
    }

    // Section 4: count reconciliation (dataset)
    if (entry.counts) {
      const c = entry.counts;
      const rec = entry.reconciliation || { rows: [], overall: "warn" };
      const ov = rec.overall === "ok" ? badge("ok", "counts match") :
                 rec.overall === "mismatch" ? badge("fail", "mismatch") : badge("warn", "review");
      html += `<div class="report-section"><h3>4 · Count reconciliation (dataset) ${ov}</h3>`;
      const cfg = entry.dsConfig || {};
      html += `<div class="check-detail muted">Counted <b>${escapeHtml(c.countBasis || "subjects")}</b> by <code>${escapeHtml(cfg.trtVar)}</code>${
        cfg.popFlag ? `, filtered to <code>${escapeHtml(cfg.popFlag)}=${escapeHtml(cfg.popValue)}</code>` : " (no population filter)"
      }. Total = <b>${c.total}</b>. Big-Ns are auto-matched to columns by label.</div>`;
      if (c.warnings && c.warnings.length)
        html += `<div class="check-detail err-text">${c.warnings.map(escapeHtml).join("<br>")}</div>`;
      html += `<table class="rt"><thead><tr><th>Dataset group</th><th>Dataset count</th><th>Matched PDF column</th><th>PDF N</th><th>Status</th></tr></thead><tbody>`;
      rec.rows.forEach((r) => {
        const stat = r.status === "ok" ? badge("ok", "match")
          : r.status === "mismatch" ? badge("fail", "mismatch")
          : r.status === "placeholder" ? badge("warn", "placeholder")
          : r.status === "extra" ? badge("warn", "no dataset group")
          : badge("warn", "no PDF match");
        html += `<tr>
          <td>${r.dsLabel == null ? "<em class='muted'>—</em>" : escapeHtml(r.dsLabel)}</td>
          <td>${r.dsCount == null ? "—" : `<b>${r.dsCount}</b>`}</td>
          <td>${r.pdfLabel == null ? "<em class='muted'>—</em>" : escapeHtml(r.pdfLabel)}</td>
          <td>${r.pdfN == null ? "—" : `<code>${escapeHtml(r.pdfN)}</code>`}</td>
          <td>${stat}</td></tr>`;
      });
      html += `</tbody></table></div>`;
    }

    html += `<div class="ai-actions">
      <button class="mini-btn" data-act="copy">Copy JSON</button>
      <button class="mini-btn" data-act="delete">Delete</button>
    </div>`;
    return html;
  }

  // ---------- Views ----------
  function renderHistory() {
    const q = el.historySearch.value.trim().toLowerCase();
    const items = history.filter((h) =>
      !q || h.files.pdf1.name.toLowerCase().includes(q) ||
      (h.instructions || "").toLowerCase().includes(q));
    if (!items.length) {
      el.historyList.innerHTML =
        `<div class="history-empty">${history.length ? "No matches." : "No checks yet.<br>Add a PDF to start."}</div>`;
      return;
    }
    el.historyList.innerHTML = items.map((h) => {
      const icon = h.status === "error" ? "⚠️" : h.status === "pending" ? "⏳" : "📄";
      const extras = [h.files.pdf2 ? "+shell" : "", h.files.dataset ? "+data" : ""].filter(Boolean).join(" ");
      return `<div class="history-item ${h.id === activeId ? "active" : ""}" data-id="${h.id}">
        <div class="hi-title">${icon} ${escapeHtml(h.files.pdf1.name)}</div>
        <div class="hi-sub">${escapeHtml(fmtTime(h.ts))}${extras ? " · " + escapeHtml(extras) : ""}</div>
      </div>`;
    }).join("");
    el.historyList.querySelectorAll(".history-item").forEach((n) =>
      n.addEventListener("click", () => {
        activeId = n.dataset.id; renderHistory(); renderConversation();
        el.sidebar.classList.remove("open");
      }));
  }

  function renderConversation() {
    const entry = history.find((h) => h.id === activeId);
    el.conversation.querySelectorAll(".turn").forEach((n) => n.remove());
    if (!entry) {
      el.emptyState.classList.remove("hidden");
      el.viewTitle.textContent = "New validation";
      return;
    }
    el.emptyState.classList.add("hidden");
    el.viewTitle.textContent = entry.files.pdf1.name;

    const fileTags = [
      `<span class="bu-file">📄 #1 ${escapeHtml(entry.files.pdf1.name)}</span>`,
      entry.files.pdf2 ? `<span class="bu-file">📐 #2 shell: ${escapeHtml(entry.files.pdf2.name)}</span>` : "",
      entry.files.dataset ? `<span class="bu-file">🗃️ #3 ${escapeHtml(entry.files.dataset.name)}</span>` : "",
    ].filter(Boolean).join(" ");
    const instr = entry.instructions
      ? `<div class="bu-instr">${escapeHtml(entry.instructions)}</div>` : "";

    let aiInner;
    if (entry.status === "pending") aiInner = `<div class="thinking"><i></i><i></i><i></i></div>
      <div class="muted" style="margin-top:6px">Counting dataset locally & querying the model…</div>`;
    else if (entry.status === "error") aiInner = `<div class="error-box"><strong>Error:</strong> ${escapeHtml(entry.error)}</div>`;
    else aiInner = renderReport(entry);

    const turn = document.createElement("div");
    turn.className = "turn";
    turn.innerHTML = `
      <div class="bubble-user"><div class="bu-files">${fileTags}</div>${instr}</div>
      <div class="bubble-ai">
        <div class="ai-head"><span class="ai-dot"></span> ${escapeHtml(entry.model)} · ${escapeHtml(fmtTime(entry.ts))}</div>
        ${aiInner}
      </div>`;
    el.conversation.appendChild(turn);
    turn.querySelectorAll("[data-act]").forEach((b) =>
      b.addEventListener("click", () => handleAction(b.dataset.act, entry)));
    el.conversation.scrollTop = 0;
  }

  function handleAction(act, entry) {
    if (act === "copy") {
      const payload = JSON.stringify({ ai: entry.ai, counts: entry.counts, reconciliation: entry.reconciliation }, null, 2);
      navigator.clipboard?.writeText(payload).then(() => note("Copied JSON."), () => note("Copy failed.", true));
    } else if (act === "delete") {
      history = history.filter((h) => h.id !== entry.id);
      if (activeId === entry.id) activeId = null;
      saveHistory(); renderHistory(); renderConversation();
    }
  }

  // ---------- Settings ----------
  function openSettings(reason) {
    const nokey = reason === "nokey";
    el.settingsHint.classList.toggle("hidden", !nokey);
    el.setProvider.value = settings.provider;
    el.setApiKey.value = settings.apiKey;
    if (KNOWN_MODELS.includes(settings.model)) {
      el.setModel.value = settings.model; el.setModelCustom.classList.add("hidden");
    } else {
      el.setModel.value = "__custom__"; el.setModelCustom.classList.remove("hidden");
      el.setModelCustom.value = settings.model;
    }
    el.setSystemPrompt.value = settings.systemPrompt;
    el.setTemp.value = settings.temperature;
    el.tempVal.textContent = Number(settings.temperature).toFixed(2);
    el.setMaxTokens.value = settings.maxTokens;
    el.settingsModal.classList.remove("hidden");
    if (nokey) {
      el.setApiKey.classList.add("needs-attention");
      setTimeout(() => el.setApiKey.focus(), 50);
    } else {
      el.setApiKey.classList.remove("needs-attention");
    }
  }
  function closeSettings() { el.settingsModal.classList.add("hidden"); }
  function saveSettingsFromForm() {
    settings.provider = el.setProvider.value;
    settings.apiKey = el.setApiKey.value.trim();
    settings.model = el.setModel.value === "__custom__"
      ? (el.setModelCustom.value.trim() || DEFAULT_SETTINGS.model) : el.setModel.value;
    settings.systemPrompt = el.setSystemPrompt.value.trim() || DEFAULT_SYSTEM_PROMPT;
    settings.temperature = Number(el.setTemp.value);
    settings.maxTokens = Math.max(512, Number(el.setMaxTokens.value) || 8192);
    saveSettings(); closeSettings(); reflectSettings();
    el.settingsHint.classList.add("hidden");
    el.setApiKey.classList.remove("needs-attention");
    if (settings.apiKey && inputs.pdf1) note("Settings saved — press Validate to run the check.");
    else if (settings.apiKey) note("Settings saved. Add PDF #1, then press Validate.");
    else note("Settings saved.");
  }
  function reflectSettings() {
    el.modelChip.textContent = settings.apiKey ? settings.model : "set API key →";
  }

  function autoGrow() {
    const ta = el.instructions;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 160) + "px";
  }

  // ---------- Events ----------
  function bindSlot(slot) {
    const node = document.querySelector(`.slot[data-slot="${slot}"]`);
    const input = node.querySelector("input[type=file]");
    node.querySelector(".slot-pick").addEventListener("click", () => input.click());
    input.addEventListener("change", (e) => setFile(slot, e.target.files[0]));
    node.querySelector(".slot-x").addEventListener("click", (e) => { e.stopPropagation(); clearFile(slot); });
    ["dragenter", "dragover"].forEach((ev) =>
      node.addEventListener(ev, (e) => { e.preventDefault(); node.classList.add("dragover"); }));
    ["dragleave", "drop"].forEach((ev) =>
      node.addEventListener(ev, (e) => { e.preventDefault(); node.classList.remove("dragover"); }));
    node.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) setFile(slot, f); });
  }

  function bind() {
    ["pdf1", "pdf2", "dataset"].forEach(bindSlot);
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());

    el.trtVar.addEventListener("change", () => (dsConfig.trtVar = el.trtVar.value));
    el.popFlag.addEventListener("change", () => (dsConfig.popFlag = el.popFlag.value));
    el.popValue.addEventListener("input", () => (dsConfig.popValue = el.popValue.value));

    el.sendBtn.addEventListener("click", evaluate);
    el.instructions.addEventListener("input", autoGrow);
    el.instructions.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); evaluate(); }
    });

    el.newChatBtn.addEventListener("click", () => {
      activeId = null; renderHistory(); renderConversation(); el.sidebar.classList.remove("open");
    });
    el.historySearch.addEventListener("input", renderHistory);
    el.toggleSidebarBtn.addEventListener("click", () => el.sidebar.classList.toggle("open"));

    el.openSettingsBtn.addEventListener("click", openSettings);
    el.emptySettingsBtn.addEventListener("click", openSettings);
    el.closeSettingsBtn.addEventListener("click", closeSettings);
    el.cancelSettingsBtn.addEventListener("click", closeSettings);
    el.saveSettingsBtn.addEventListener("click", saveSettingsFromForm);
    el.settingsModal.addEventListener("click", (e) => { if (e.target === el.settingsModal) closeSettings(); });
    el.toggleKeyBtn.addEventListener("click", () => {
      const show = el.setApiKey.type === "password";
      el.setApiKey.type = show ? "text" : "password";
      el.toggleKeyBtn.textContent = show ? "Hide" : "Show";
    });
    el.setModel.addEventListener("change", () =>
      el.setModelCustom.classList.toggle("hidden", el.setModel.value !== "__custom__"));
    el.setTemp.addEventListener("input", () => (el.tempVal.textContent = Number(el.setTemp.value).toFixed(2)));
    el.clearHistoryBtn.addEventListener("click", () => {
      if (!history.length) return;
      if (confirm("Delete all history? This cannot be undone.")) {
        history = []; activeId = null; saveHistory(); renderHistory(); renderConversation();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !el.settingsModal.classList.contains("hidden")) closeSettings();
    });
  }

  function init() {
    bind();
    reflectSettings();
    renderSlots();
    renderHistory();
    renderConversation();
    updateSendState();
    autoGrow();
    if (!settings.apiKey) note("Tip: add your Gemini API key in Settings to get started.");
  }

  init();
})();
