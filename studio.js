/**
 * ChameleonBG v2.0.9 — Full 3-Panel Visual Studio Controller (`studio.js`)
 *
 * Hardening improvements in v2.0.1:
 * 1. Zero Unsafe HTML Construction: Replaces all `.innerHTML` usage with safe DOM APIs
 *    (`createElement`, `textContent`, `replaceChildren()`) so hostile page labels or filenames
 *    cannot inject markup or execute scripts.
 * 2. Origin-Scoped & Conflict-Safe Saving: Uses `targetSiteKey` (`https://example.com:8443`),
 *    supports `matchScope` (`"origin" | "hostname" | "subdomain"`), checks `expectedRevision`,
 *    and exposes conflict resolution actions (`Overwrite Remote` / `Load Latest Saved`) when
 *    concurrent edits occur in another tab.
 * 3. Surfaces style restoration conflicts, unsupported frame notices, and configurable media size limits.
 */

/* global ChameleonStorageService, chrome */
(() => {
  "use strict";

  const params = new URLSearchParams(window.location.search);
  let targetTabId = params.get("tabId") ? Number(params.get("tabId")) : null;
  let studioTabId = null;
  let targetSiteKey = params.get("siteKey") || params.get("host") || "https://example-site.local";
  if (!/^https?:\/\/|^file:\/\//i.test(targetSiteKey)) {
    targetSiteKey = `https://${targetSiteKey}`;
  }
  let targetHostname = ChameleonStorageService.deriveSiteIdentity(targetSiteKey).hostname;
  let currentView = params.get("view") || "editor";
  const startPickerOnLaunch = params.get("startPicker") === "1";
  if (startPickerOnLaunch) {
    params.delete("startPicker");
    const remainingQuery = params.toString();
    history.replaceState(null, "", `${window.location.pathname}${remainingQuery ? `?${remainingQuery}` : ""}${window.location.hash}`);
  }

  let savedSiteConfig = {
    siteKey: targetSiteKey,
    hostname: targetHostname,
    matchScope: "origin",
    enabled: true,
    revision: 0,
    components: {}
  };
  let workingSiteConfig = JSON.parse(JSON.stringify(savedSiteConfig));
  const MAX_HISTORY_STEPS = 20;
  const undoStack = [];
  const redoStack = [];
  let studioAutoSaveEnabled = true;
  let autoSaveTimer = null;
  let pendingConflictRemoteConfig = null;
  let pendingThemeDefaultMedia = null;
  let pendingThemeDefaultStyles = null;

  let detectedComponents = [];
  let frameNotices = [];
  let selectedCompId = "root_page";
  let mediaItems = [];
  let storageStats = { itemCount: 0, formattedTotal: "0 B" };
  let globalSettings = {
    extensionEnabled: true,
    ecoMode: true,
    autoConvertWebP: false,
    preserveOriginalOnConvert: true,
    maxConcurrentVideos: 2,
    maxImageDimension: 2560,
    maxMediaSizeBytes: 50 * 1024 * 1024,
    pauseAllBackgroundVideos: false
  };

  let allMediaItems = [];
  let pickerSelectedMediaIds = new Set();
  let pickerAssignmentMode = "playlist";
  let latestMediaUsageReferences = {};
  let latestDiagnostics = { activeLayers: [], restorationConflicts: [] };
  let pendingImportPayload = null;

  const studioObjectUrls = new Set();
  let activeMediaRenderUrls = new Set();
  let mediaRenderRevision = 0;
  let settingsSectionObserver = null;

  function releaseStudioUrlSet(urlSet) {
    for (const url of urlSet) {
      try { URL.revokeObjectURL(url); } catch (_) {}
      studioObjectUrls.delete(url);
    }
    urlSet.clear();
  }

  function revokeAllStudioUrls() {
    for (const url of studioObjectUrls) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
    studioObjectUrls.clear();
  }

  window.addEventListener("unload", revokeAllStudioUrls);

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function hasUnsavedPreviewChanges() {
    return JSON.stringify(workingSiteConfig.components) !== JSON.stringify(savedSiteConfig.components) ||
           workingSiteConfig.enabled !== savedSiteConfig.enabled ||
           workingSiteConfig.matchScope !== savedSiteConfig.matchScope;
  }

  function pushUndoState() {
    undoStack.push(deepClone(workingSiteConfig));
    if (undoStack.length > MAX_HISTORY_STEPS) undoStack.shift();
    redoStack.length = 0;
    updateTopbarDraftControls();
  }

  function scheduleAutoSave() {
    if (!studioAutoSaveEnabled) return;
    if (autoSaveTimer) clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(async () => {
      autoSaveTimer = null;
      if (!studioAutoSaveEnabled || !hasUnsavedPreviewChanges()) return;
      await saveWorkingConfig(true, { silentAutoSave: true });
    }, 320);
  }

  function sendRuntimeMessage(payload) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        return resolve({ ok: false, error: "Runtime messaging unavailable." });
      }
      chrome.runtime.sendMessage(payload, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false });
        }
      });
    });
  }

  function sendTabMessage(tabId, payload) {
    return new Promise((resolve) => {
      if (!tabId || typeof chrome === "undefined" || !chrome.tabs || !chrome.tabs.sendMessage) {
        return resolve({ ok: false, error: "Target tab unavailable." });
      }
      chrome.tabs.sendMessage(tabId, payload, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(res || { ok: false });
        }
      });
    });
  }

  function showAlert(message, isWarning = false, showConflictActions = false) {
    const banner = document.getElementById("globalAlertBanner");
    const text = document.getElementById("globalAlertText");
    const btnOverwrite = document.getElementById("btnForceOverwriteConflict");
    const btnReload = document.getElementById("btnReloadConflictState");
    if (!banner || !text) return;
    text.textContent = message;
    banner.style.borderColor = isWarning ? "#f59e0b" : "#38bdf8";
    if (btnOverwrite) btnOverwrite.hidden = !showConflictActions;
    if (btnReload) btnReload.hidden = !showConflictActions;
    banner.hidden = false;
  }

  function getDefaultSchematicComponents() {
    return [
      {
        id: "root_page",
        label: "Entire Website",
        category: "Whole Page",
        dimensionsText: "1440 × 900 px",
        suitability: { suitable: true, recommendedMode: "mode-a", badgeText: "Suitable • Whole-Page Backdrop", reason: "Full-viewport backdrop layer." },
        locator: { id: "root_page", isWholePage: true, label: "Entire Website", fallbackSelector: "body" },
        rect: { x: 2, y: 2, w: 96, h: 96 },
        matchStatus: "matched"
      },
      {
        id: "comp_top_header_4_4",
        label: "Top Navigation",
        category: "Landmark",
        dimensionsText: "1380 × 72 px",
        suitability: { suitable: true, recommendedMode: "mode-b", badgeText: "Suitable • Independent Layer (Mode B)", reason: "Supports an isolated background layer behind its content." },
        locator: { id: "comp_top_header_4_4", isWholePage: false, label: "Top Navigation", tagName: "header", fallbackSelector: "header" },
        rect: { x: 5, y: 5, w: 90, h: 12 },
        matchStatus: "matched"
      },
      {
        id: "comp_sidebar_5_20",
        label: "Left Sidebar",
        category: "Landmark",
        dimensionsText: "280 × 640 px",
        suitability: { suitable: true, recommendedMode: "mode-b", badgeText: "Suitable • Independent Layer (Mode B)", reason: "Supports an isolated background layer behind its content." },
        locator: { id: "comp_sidebar_5_20", isWholePage: false, label: "Left Sidebar", tagName: "aside", fallbackSelector: "aside" },
        rect: { x: 5, y: 20, w: 24, h: 58 },
        matchStatus: "matched"
      },
      {
        id: "comp_main_content_31_20",
        label: "Main Content",
        category: "Landmark",
        dimensionsText: "1060 × 640 px",
        suitability: { suitable: true, recommendedMode: "mode-b", badgeText: "Suitable • Independent Layer (Mode B)", reason: "Supports an isolated background layer behind its content." },
        locator: { id: "comp_main_content_31_20", isWholePage: false, label: "Main Content", tagName: "main", fallbackSelector: "main" },
        rect: { x: 31, y: 20, w: 64, h: 58 },
        matchStatus: "matched"
      },
      {
        id: "comp_footer_5_81",
        label: "Footer",
        category: "Landmark",
        dimensionsText: "1380 × 84 px",
        suitability: { suitable: true, recommendedMode: "mode-b", badgeText: "Suitable • Independent Layer (Mode B)", reason: "Supports an isolated background layer behind its content." },
        locator: { id: "comp_footer_5_81", isWholePage: false, label: "Footer", tagName: "footer", fallbackSelector: "footer" },
        rect: { x: 5, y: 81, w: 90, h: 13 },
        matchStatus: "matched"
      }
    ];
  }

  // =========================================================================
  // 1. INITIALIZATION & TARGET TAB SYNCHRONIZATION
  // =========================================================================
  async function initializeStudio() {
    try {
      if (chrome.tabs && chrome.tabs.getCurrent) {
        const currentTab = await new Promise((resolve) => chrome.tabs.getCurrent((tab) => resolve(tab || null)));
        studioTabId = currentTab && Number.isInteger(currentTab.id) ? currentTab.id : null;
      }
    } catch (_) { studioTabId = null; }
    switchStudioView(currentView);

    const overview = await sendRuntimeMessage({
      type: "CHAMELEON_GET_OVERVIEW",
      siteKey: targetSiteKey,
      hostname: targetHostname
    });

    if (overview && overview.ok) {
      globalSettings = { ...globalSettings, ...(overview.globalSettings || {}) };
      if (overview.siteKey) targetSiteKey = overview.siteKey;
      if (overview.hostnameConfig) {
        savedSiteConfig = deepClone(overview.hostnameConfig);
        workingSiteConfig = deepClone(overview.hostnameConfig);
      }
      if (overview.storageStats) storageStats = overview.storageStats;
      if (overview.mediaItems) {
        mediaItems = overview.mediaItems;
        allMediaItems = [...overview.mediaItems];
      }
    } else if (typeof ChameleonStorageService !== "undefined") {
      mediaItems = await ChameleonStorageService.listMediaMetadata({ includePresets: true });
      allMediaItems = [...mediaItems];
      storageStats = await ChameleonStorageService.getStorageUsageStats();
    }
    if (allMediaItems.length === 0 && typeof ChameleonStorageService !== "undefined") {
      try { allMediaItems = await ChameleonStorageService.listMediaMetadata({ includePresets: true }); } catch (_) {}
    }

    await syncWithTargetTab();
    syncSettingsControls();
    renderAllPanels();
    if (startPickerOnLaunch) {
      // Let the initial view render before switching to the target tab for selection.
      window.setTimeout(() => {
        startLivePickerFromStudio({ focusTarget: false }).catch((err) => showAlert(`Could not start the live selector: ${err?.message || err}`, true));
      }, 100);
    }
    refreshSiteSwitcher().catch(() => {});
  }

  async function syncWithTargetTab() {
    const subtitle = document.getElementById("targetSiteSubtitle");
    const mapNotice = document.getElementById("mapStateNotice");

    if (!targetTabId) {
      detectedComponents = getDefaultSchematicComponents();
      subtitle.textContent = `Target website: ${targetSiteKey} (Schematic Preview Mode)`;
      mapNotice.hidden = true;
      return;
    }

    const cap = await sendRuntimeMessage({
      type: "CHAMELEON_CHECK_TAB_CAPABILITY",
      tabId: targetTabId
    });

    if (!cap.ok || !cap.supported) {
      detectedComponents = getDefaultSchematicComponents();
      subtitle.textContent = `Unsupported page (${cap.url || "Protected tab"})`;
      mapNotice.textContent = cap.reason || "This browser page cannot be modified by extensions.";
      mapNotice.hidden = false;
      return;
    }

    targetSiteKey = cap.siteKey || targetSiteKey;
    targetHostname = cap.hostname || targetHostname;
    subtitle.textContent = `Target website: ${targetSiteKey}`;

    const tabStatus = await sendTabMessage(targetTabId, {
      type: "CHAMELEON_GET_SITE_STATUS"
    });

    if (tabStatus && tabStatus.ok) {
      if (tabStatus.diagnostics) {
        latestDiagnostics = tabStatus.diagnostics;
      }
      savedSiteConfig = deepClone(tabStatus.savedSiteConfig || savedSiteConfig);
      workingSiteConfig = deepClone(tabStatus.workingSiteConfig || savedSiteConfig);
      detectedComponents = tabStatus.components && tabStatus.components.length > 0
        ? tabStatus.components
        : getDefaultSchematicComponents();
      frameNotices = tabStatus.frameNotices || [];

      const notices = [];
      const unresolved = detectedComponents.filter((c) => c.matchStatus === "ambiguous" || c.matchStatus === "missing" || c.matchStatus === "unsupported-frame");
      if (unresolved.length > 0) {
        notices.push(...unresolved.map((u) => `${u.label}: ${u.matchReason || u.matchStatus}`));
      }
      if (frameNotices.length > 0) {
        notices.push(`${frameNotices.length} embedded frame(s) cannot be customized due to cross-origin or sandbox restrictions.`);
      }
      if (tabStatus.diagnostics?.restorationConflicts?.length > 0) {
        notices.push(`${tabStatus.diagnostics.restorationConflicts.length} host-page style mutation(s) preserved during reset.`);
      }

      if (notices.length > 0) {
        mapNotice.textContent = notices.join(" • ");
        mapNotice.hidden = false;
      } else {
        mapNotice.hidden = true;
      }
    } else {
      detectedComponents = getDefaultSchematicComponents();
      mapNotice.textContent = "Reload the target webpage tab to connect live component inspection.";
      mapNotice.hidden = false;
    }
  }

  // =========================================================================
  // 2. SAFE DOM RENDERING OF LEFT, CENTER, AND RIGHT PANELS (ZERO innerHTML)
  // =========================================================================
  function renderAllPanels() {
    updateTopbarDraftControls();
    renderLeftAreasPanel();
    renderCenterLayoutMap();
    renderRightInspectorPanel();
    renderMediaLibraryGrids();
  }

  function updateTopbarDraftControls() {
    const unsaved = hasUnsavedPreviewChanges();
    const pill = document.getElementById("draftStatusPill");
    const label = document.getElementById("draftStatusLabel");
    const btnUndo = document.getElementById("btnStudioUndo");
    const btnRedo = document.getElementById("btnStudioRedo");
    const btnDiscard = document.getElementById("btnStudioDiscard");
    const btnSave = document.getElementById("btnStudioSave");
    const chkAutoSave = document.getElementById("chkStudioAutoSave");

    if (chkAutoSave) chkAutoSave.checked = studioAutoSaveEnabled;
    pill.classList.toggle("saved", !unsaved);
    if (unsaved) {
      label.textContent = studioAutoSaveEnabled ? "Auto-saving…" : "Unsaved Preview";
    } else {
      label.textContent = studioAutoSaveEnabled ? "Auto-saved" : "All Changes Saved";
    }
    if (btnUndo) {
      btnUndo.disabled = undoStack.length === 0;
      btnUndo.textContent = undoStack.length > 0 ? `← Back (${undoStack.length})` : "← Back";
    }
    if (btnRedo) {
      btnRedo.disabled = redoStack.length === 0;
      btnRedo.textContent = redoStack.length > 0 ? `Forward (${redoStack.length}) →` : "Forward →";
    }
    if (btnDiscard) {
      btnDiscard.disabled = !unsaved;
      btnDiscard.hidden = studioAutoSaveEnabled && !unsaved;
    }
    if (btnSave) {
      btnSave.disabled = !unsaved;
      btnSave.hidden = studioAutoSaveEnabled && !unsaved;
    }
  }

  function renderLeftAreasPanel() {
    const listEl = document.getElementById("pageAreasList");
    const query = (document.getElementById("areaSearchInput").value || "").trim().toLowerCase();
    listEl.replaceChildren();

    const filtered = detectedComponents.filter((comp) => {
      if (!query) return true;
      return (
        (comp.label || "").toLowerCase().includes(query) ||
        (comp.category || "").toLowerCase().includes(query)
      );
    });

    const groups = new Map();
    for (const comp of filtered) {
      const cat = comp.category || "Content Region";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(comp);
    }

    for (const [category, items] of groups.entries()) {
      const header = document.createElement("div");
      header.className = "area-group-title";
      header.textContent = category;
      listEl.appendChild(header);

      for (const comp of items) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "area-row" + (comp.id === selectedCompId ? " selected" : "");
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", comp.id === selectedCompId ? "true" : "false");

        const cfg = workingSiteConfig.components?.[comp.id];
        const count = cfg?.playlist?.length || (cfg?.activeMediaId ? 1 : 0);

        let badgeClass = "status-pill";
        let badgeText = count > 0 ? `${count} media` : "Default";
        if (comp.matchStatus === "ambiguous" || comp.matchStatus === "missing" || comp.matchStatus === "unsupported-frame") {
          badgeClass += " warn";
          badgeText = comp.matchStatus;
        } else if (count > 0) {
          badgeClass += " active";
        }

        const infoDiv = document.createElement("div");
        infoDiv.className = "area-info";
        const nameSpan = document.createElement("span");
        nameSpan.className = "area-name";
        nameSpan.textContent = comp.label;
        const metaSpan = document.createElement("span");
        metaSpan.className = "area-meta";
        metaSpan.textContent = comp.dimensionsText || "";
        infoDiv.append(nameSpan, metaSpan);

        const badgeSpan = document.createElement("span");
        badgeSpan.className = badgeClass;
        badgeSpan.textContent = badgeText;

        row.append(infoDiv, badgeSpan);
        row.addEventListener("click", () => selectComponentArea(comp.id));
        bindDropZoneEvents(row, comp);
        listEl.appendChild(row);
      }
    }
  }

  function getComponentMapContext(comp) {
    const ctx = comp?.locator?.context || {};
    return `${ctx.frameSelector || "top"}|${ctx.shadowHostPath || ""}`;
  }

  function getComponentMapRect(comp) {
    const geom = comp?.locator?.geometry;
    if (geom && [geom.nx, geom.ny, geom.nw, geom.nh].every(Number.isFinite)) {
      return { x: geom.nx, y: geom.ny, w: geom.nw, h: geom.nh };
    }
    const r = comp?.rect;
    if (r && [r.x, r.y, r.w, r.h].every(Number.isFinite)) {
      return { x: r.x / 100, y: r.y / 100, w: r.w / 100, h: r.h / 100 };
    }
    return { x: 0, y: 0, w: 1, h: 1 };
  }

  function inferLayoutMapTree(components) {
    const usable = Array.isArray(components) ? components : [];
    const rootComp = usable.find((comp) => comp.id === "root_page") || usable[0];
    if (!rootComp) return null;

    const nodes = new Map(usable.map((comp) => [comp.id, { comp, children: [], parentId: null }]));
    const rootNode = nodes.get(rootComp.id);
    const candidates = usable.filter((comp) => comp.id !== rootComp.id);

    for (const child of candidates) {
      const childNode = nodes.get(child.id);
      const locator = child.locator || {};
      const signature = Array.isArray(locator.parentSignature) ? locator.parentSignature : [];
      let best = null;

      for (const parent of candidates) {
        if (parent.id === child.id || getComponentMapContext(parent) !== getComponentMapContext(child)) continue;
        const parentLocator = parent.locator || {};
        const parentTag = String(parentLocator.tagName || "").toLowerCase();
        if (!parentTag) continue;

        for (let index = 0; index < signature.length; index++) {
          const sig = signature[index] || {};
          if (String(sig.tag || "").toLowerCase() !== parentTag) continue;
          // A conflicting stable ID is strong evidence that this is a sibling, not the ancestor.
          if (sig.stableId && parentLocator.stableId && sig.stableId !== parentLocator.stableId) continue;

          let score = 13 - index * 2;
          if (sig.stableId && parentLocator.stableId === sig.stableId) score += 24;
          if (sig.role && parentLocator.role === sig.role) score += 7;
          const sigClasses = Array.isArray(sig.stableClasses) ? sig.stableClasses : [];
          const parentClasses = Array.isArray(parentLocator.stableClasses) ? parentLocator.stableClasses : [];
          if (sigClasses.some((cls) => parentClasses.includes(cls))) score += 3;
          if (Number.isInteger(sig.sameTagIndex) && Number.isInteger(parentLocator.sameTagIndex) && sig.sameTagIndex === parentLocator.sameTagIndex) score += 2;

          const pr = getComponentMapRect(parent);
          const cr = getComponentMapRect(child);
          const parentArea = Math.max(0, pr.w * pr.h);
          const childArea = Math.max(0, cr.w * cr.h);
          const childCenterX = cr.x + cr.w / 2;
          const childCenterY = cr.y + cr.h / 2;
          const containsCenter = childCenterX >= pr.x - 0.025 && childCenterX <= pr.x + pr.w + 0.025 &&
            childCenterY >= pr.y - 0.025 && childCenterY <= pr.y + pr.h + 0.025;
          if (parentArea > childArea * 1.08 && containsCenter) score += 5;
          else if (parentArea <= childArea * 1.02) score -= 5;

          if (!best || score > best.score) best = { parent, score, signatureIndex: index };
          // The locator stores nearest ancestors first; do not score more distant matches once
          // this candidate has a sufficiently strong match to its nearest signature.
          break;
        }
      }

      if (best && best.score >= 9 && best.parent.id !== child.id) {
        childNode.parentId = best.parent.id;
      }
    }

    // Break any accidental cycle before attaching nodes.
    for (const node of nodes.values()) {
      const seen = new Set([node.comp.id]);
      let parentId = node.parentId;
      while (parentId) {
        if (seen.has(parentId)) {
          node.parentId = null;
          break;
        }
        seen.add(parentId);
        parentId = nodes.get(parentId)?.parentId || null;
      }
    }

    for (const node of nodes.values()) {
      if (node.comp.id === rootComp.id) continue;
      const parent = node.parentId ? nodes.get(node.parentId) : rootNode;
      (parent || rootNode).children.push(node);
    }

    const compareMapOrder = (a, b) => {
      const ar = getComponentMapRect(a.comp);
      const br = getComponentMapRect(b.comp);
      return (ar.y - br.y) || (ar.x - br.x) || String(a.comp.label).localeCompare(String(b.comp.label));
    };
    for (const node of nodes.values()) node.children.sort(compareMapOrder);
    return rootNode;
  }

  function renderCenterLayoutMap() {
    const stage = document.getElementById("layoutMapCanvas");
    if (!stage) return;
    stage.replaceChildren();

    const tree = inferLayoutMapTree(detectedComponents);
    const selectedComp = detectedComponents.find((comp) => comp.id === selectedCompId) || detectedComponents[0] || null;
    const selectedName = document.getElementById("mapSelectedAreaName");
    const assignedSummary = document.getElementById("mapAssignedMediaSummary");
    if (selectedName) selectedName.textContent = selectedComp?.label || "No area selected";
    if (assignedSummary) {
      const cfg = selectedComp ? workingSiteConfig.components?.[selectedComp.id] : null;
      const playlist = Array.isArray(cfg?.playlist) ? cfg.playlist : (cfg?.activeMediaId ? [cfg.activeMediaId] : []);
      const activeMedia = playlist.length ? allMediaItems.find((item) => item.id === (cfg?.activeMediaId || playlist[0])) : null;
      assignedSummary.textContent = playlist.length
        ? `${playlist.length} background${playlist.length === 1 ? "" : "s"}${activeMedia ? ` · Active: ${activeMedia.name}` : ""}`
        : "No background assigned";
    }

    if (!tree) {
      const empty = document.createElement("p");
      empty.className = "map-empty-note";
      empty.textContent = "No page areas detected yet. Rescan the page or select an area directly on the website.";
      stage.appendChild(empty);
      return;
    }

    const treeRoot = document.createElement("div");
    treeRoot.className = "map-tree";
    treeRoot.setAttribute("role", "tree");
    treeRoot.setAttribute("aria-label", "Structured page component map");

    const createNode = (node, depth) => {
      try {
        const comp = node.comp;
        const wrapper = document.createElement("div");
        wrapper.className = "map-tree-node";

        const row = document.createElement("div");
        const isSelected = comp.id === selectedCompId;
        row.className = `map-tree-row${isSelected ? " selected" : ""}${comp.id === "root_page" ? " map-tree-row-root" : ""}`;
        row.tabIndex = 0;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(depth + 1));
        row.setAttribute("aria-selected", String(isSelected));
        row.setAttribute("aria-label", `${comp.label}, ${comp.dimensionsText || "dimensions unknown"}`);
        row.title = `${comp.label}${comp.dimensionsText ? ` · ${comp.dimensionsText}` : ""}`;

        const main = document.createElement("div");
        main.className = "map-tree-row-main";
        const typeBadge = document.createElement("span");
        typeBadge.className = "map-node-type";
        const category = String(comp.category || "Region");
        typeBadge.textContent = comp.id === "root_page" ? "PAGE" : category === "Landmark" ? "LANDMARK" : category.toUpperCase().includes("FRAME") ? "FRAME" : category.toUpperCase().includes("SHADOW") ? "SHADOW" : "REGION";

        const copy = document.createElement("span");
        copy.className = "map-tree-copy";
        const title = document.createElement("span");
        title.className = "map-tree-title";
        title.textContent = comp.label || "Page area";
        const meta = document.createElement("span");
        meta.className = "map-tree-meta";
        meta.textContent = [category, comp.dimensionsText].filter(Boolean).join(" · ");
        copy.append(title, meta);
        main.append(typeBadge, copy);

        const side = document.createElement("span");
        side.className = "map-tree-row-side";
        const cfg = workingSiteConfig.components?.[comp.id];
        const count = cfg?.playlist?.length || (cfg?.activeMediaId ? 1 : 0);
        if (count > 0) {
          const mediaPill = document.createElement("span");
          mediaPill.className = "map-media-count";
          mediaPill.textContent = `${count} media`;
          side.appendChild(mediaPill);
        }
        const activeMediaId = cfg?.activeMediaId || cfg?.playlist?.[0] || null;
        const activeMediaMeta = activeMediaId
          ? (allMediaItems.find((item) => item.id === activeMediaId) || mediaItems.find((item) => item.id === activeMediaId))
          : null;
        const isVideo = activeMediaMeta?.mediaType === "video" || (typeof activeMediaMeta?.mimeType === "string" && activeMediaMeta.mimeType.startsWith("video/"));
        if (isVideo) {
          const pauseAction = document.createElement("button");
          pauseAction.type = "button"; pauseAction.className = "btn-map-video-action";
          const componentPaused = cfg?.videoPaused === true;
          const globalPaused = globalSettings.pauseAllBackgroundVideos === true;
          pauseAction.textContent = componentPaused ? "Resume" : (globalPaused ? "Paused globally" : "Pause");
          pauseAction.disabled = globalPaused;
          pauseAction.title = globalPaused
            ? "Global video pause is active. Use Resume videos in the top bar to resume all background videos."
            : (componentPaused ? "Resume this component's background video" : "Pause this component's background video");
          pauseAction.setAttribute("aria-label", `${pauseAction.title}: ${comp.label}`);
          pauseAction.setAttribute("aria-pressed", String(componentPaused));
          pauseAction.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); toggleComponentVideoAction(comp, "pause").catch((err) => showAlert(`Could not change video playback: ${err?.message || err}`, true)); });
          const muteAction = document.createElement("button");
          muteAction.type = "button"; muteAction.className = "btn-map-video-action";
          const isMuted = cfg?.videoMuted !== false;
          muteAction.textContent = isMuted ? "Unmute" : "Mute";
          muteAction.title = isMuted ? "Turn sound on for this background video" : "Mute this background video";
          muteAction.setAttribute("aria-label", `${muteAction.title}: ${comp.label}`);
          muteAction.setAttribute("aria-pressed", String(!isMuted));
          muteAction.addEventListener("click", (event) => {
            event.preventDefault(); event.stopPropagation();
            toggleComponentVideoAction(comp, "mute").catch((err) => showAlert(`Could not change video audio: ${err?.message || err}`, true));
          });

          const statusBadge = document.createElement("span");
          statusBadge.className = "map-node-video-status";
          const activeLayerDiag = (typeof latestDiagnostics !== "undefined" && Array.isArray(latestDiagnostics?.activeLayers))
            ? latestDiagnostics.activeLayers.find((l) => l.compId === comp.id)
            : null;
          const audibleOwnerCompId = latestDiagnostics?.audibleOwnerCompId || null;

          let vStatus = "playing-muted";
          let vStatusText = "Muted";
          if (globalPaused) {
            vStatus = "paused-globally";
            vStatusText = "Paused globally";
          } else if (componentPaused) {
            vStatus = "paused-by-user";
            vStatusText = isMuted ? "Paused" : "Paused (sound on)";
          } else if (activeLayerDiag?.audioPlaybackBlocked || activeLayerDiag?.statusLabel === "audio-blocked") {
            vStatus = "audio-blocked";
            vStatusText = "Audio blocked";
          } else if (isMuted) {
            vStatus = "playing-muted";
            vStatusText = "Muted";
          } else if (audibleOwnerCompId && audibleOwnerCompId !== comp.id) {
            vStatus = "playing-muted";
            vStatusText = "Muted (other active)";
            statusBadge.title = "Only one background video plays audio at a time so tracks do not overlap.";
          } else {
            vStatus = "playing-audio";
            vStatusText = activeLayerDiag?.isPlaying ? "Sound on" : "Sound on";
          }
          statusBadge.classList.add(vStatus);
          statusBadge.textContent = vStatusText;

          side.append(pauseAction, muteAction, statusBadge);
        }
        if (["ambiguous", "missing", "unsupported-frame"].includes(comp.matchStatus)) {
          const warning = document.createElement("span");
          warning.className = "map-node-status warning";
          warning.textContent = comp.matchStatus;
          side.appendChild(warning);
        }
        row.append(main, side);
        row.addEventListener("click", () => selectComponentArea(comp.id));
        row.addEventListener("keydown", (event) => {
          if (event.target.closest("button")) return;
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectComponentArea(comp.id); }
        });
        bindDropZoneEvents(row, comp);
        wrapper.appendChild(row);

        if (node.children.length) {
          const children = document.createElement("div");
          children.className = "map-tree-children";
          children.setAttribute("role", "group");
          node.children.forEach((child) => children.appendChild(createNode(child, depth + 1)));
          wrapper.appendChild(children);
        }
        return wrapper;
      } catch (nodeErr) {
        console.warn("Failed to render tree node for component:", node?.comp?.id, nodeErr);
        const fallback = document.createElement("div");
        fallback.className = "map-tree-node";
        return fallback;
      }
    };

    treeRoot.appendChild(createNode(tree, 0));
    stage.appendChild(treeRoot);
  }

  async function toggleComponentVideoAction(comp, action) {
    if (!comp) return;
    const cfg = ensureComponentInWorkingConfig(comp);
    const playlist = Array.isArray(cfg.playlist) ? cfg.playlist : (cfg.activeMediaId ? [cfg.activeMediaId] : []);
    const activeId = cfg.activeMediaId || playlist[0];
    const activeMeta = allMediaItems.find((item) => item.id === activeId);
    if (activeMeta?.mediaType !== "video") return;
    pushUndoState();
    let unmuting = false;
    if (action === "pause") cfg.videoPaused = cfg.videoPaused !== true;
    else if (action === "mute") {
      const currentlyMuted = cfg.videoMuted !== false;
      cfg.videoMuted = !currentlyMuted;
      unmuting = currentlyMuted && cfg.videoMuted === false;
      if (unmuting) {
        cfg.videoAudioRequestedAt = Date.now();
        // Mute other components in the working config so only the newly unmuted video claims audio focus
        if (workingSiteConfig && workingSiteConfig.components) {
          for (const [otherId, otherCfg] of Object.entries(workingSiteConfig.components)) {
            if (otherId !== comp.id && otherCfg && typeof otherCfg === "object") {
              otherCfg.videoMuted = true;
            }
          }
        }
      }
    }
    const response = await pushLivePreviewToTab(false);
    if (response?.diagnostics) {
      latestDiagnostics = response.diagnostics;
    }
    renderAllPanels(); updateTopbarDraftControls();
    if (unmuting) {
      const blocked = Array.isArray(response?.diagnostics?.activeLayers) && response.diagnostics.activeLayers.some((layer) => layer.compId === comp.id && layer.audioPlaybackBlocked);
      if (blocked) {
        showAlert("Browser autoplay policy prevented audio playback. Click inside the webpage or review Firefox autoplay permissions for this site to allow sound.", true);
      }
    }
  }

  function renderRightInspectorPanel() {
    const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
    if (!comp) return;

    document.getElementById("inspectorAreaName").textContent = comp.label;
    const suit = comp.suitability || { suitable: true, badgeText: "Suitable", reason: "" };
    document.getElementById("inspectorSuitabilityBadge").textContent = suit.badgeText || "Suitable";
    document.getElementById("inspectorSuitabilityReason").textContent = comp.matchReason || suit.reason || "";

    const cfg = workingSiteConfig.components?.[comp.id] || getDefaultComponentConfig(comp);
    const playlist = Array.isArray(cfg.playlist) ? cfg.playlist : (cfg.activeMediaId ? [cfg.activeMediaId] : []);

    document.getElementById("playlistCountTag").textContent = `${playlist.length} item${playlist.length === 1 ? "" : "s"}`;

    const playlistContainer = document.getElementById("assignedPlaylistContainer");
    playlistContainer.replaceChildren();

    if (playlist.length === 0) {
      const emptyP = document.createElement("p");
      emptyP.style.cssText = "font-size:11.5px;color:#94a3b8;";
      emptyP.textContent = `Drag or click a media item from the library to assign it to ${comp.label}.`;
      playlistContainer.appendChild(emptyP);
    } else {
      playlist.forEach((mediaId, idx) => {
        const meta = allMediaItems.find((m) => m.id === mediaId);
        const row = document.createElement("div");
        row.className = "playlist-row";

        const labelSpan = document.createElement("span");
        labelSpan.textContent = `${idx + 1}. ${meta ? meta.name : `Missing (${mediaId.slice(0, 10)})`}`;

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "btn btn-sm";
        removeBtn.setAttribute("aria-label", "Remove from playlist");
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", () => {
          pushUndoState();
          const targetCfg = ensureComponentInWorkingConfig(comp);
          targetCfg.playlist.splice(idx, 1);
          targetCfg.activeMediaId = targetCfg.playlist[0] || null;
          if (targetCfg.playlist.length === 0) {
            delete workingSiteConfig.components[comp.id];
          }
          pushLivePreviewToTab(false);
          renderAllPanels();
        });

        row.append(labelSpan, removeBtn);
        playlistContainer.appendChild(row);
      });
    }

    const rotationSelect = document.getElementById("selectRotationInterval");
    const rotationSeconds = Number(cfg.rotationIntervalSec ?? 0);
    const builtInIntervals = new Set([0, 15, 60, 300, 1800, -1]);
    const isCustomInterval = cfg.rotationMode === "custom" || !builtInIntervals.has(rotationSeconds);
    if (rotationSelect) rotationSelect.value = isCustomInterval ? "custom" : String(rotationSeconds);
    const customControls = document.getElementById("customRotationControls");
    if (customControls) customControls.hidden = !isCustomInterval;
    const nonNegativeSeconds = Math.max(0, rotationSeconds);
    const hoursInput = document.getElementById("rotationHours");
    const minutesInput = document.getElementById("rotationMinutes");
    const secondsInput = document.getElementById("rotationSeconds");
    if (hoursInput) hoursInput.value = String(Math.floor(nonNegativeSeconds / 3600));
    if (minutesInput) minutesInput.value = String(Math.floor((nonNegativeSeconds % 3600) / 60));
    if (secondsInput) secondsInput.value = String(nonNegativeSeconds % 60);
    document.getElementById("chkShufflePlaylist").checked = Boolean(cfg.shuffle);

    const hasAssignedVideo = playlist.some((mediaId) => allMediaItems.find((item) => item.id === mediaId)?.mediaType === "video");
    const activeMetaForVideo = allMediaItems.find((item) => item.id === (cfg.activeMediaId || playlist[0]));
    const isActiveVideo = activeMetaForVideo?.mediaType === "video";
    const videoControls = document.getElementById("videoPlaybackGroup");
    if (videoControls) videoControls.hidden = !hasAssignedVideo;
    const videoVolume = Math.max(0, Math.min(100, Number(cfg.videoVolume ?? 35)));
    const volumeSlider = document.getElementById("sliderVideoVolume");
    if (volumeSlider) volumeSlider.value = String(videoVolume);
    const videoVolumeText = document.getElementById("valVideoVolume");
    if (videoVolumeText) videoVolumeText.textContent = `${videoVolume}%`;
    const loopStartInput = document.getElementById("inputVideoLoopStartSec");
    const loopEndInput = document.getElementById("inputVideoLoopEndSec");
    const loopTrimHelp = document.getElementById("videoLoopTrimHelp");
    const configuredStart = Math.max(0, Number(cfg.videoLoopStartSec || 0));
    const configuredEnd = Math.max(0, Number(cfg.videoLoopEndSec || 0));
    if (loopStartInput) loopStartInput.value = String(configuredStart);
    if (loopEndInput) loopEndInput.value = configuredEnd > 0 ? String(configuredEnd) : "0";
    if (loopTrimHelp) {
      const detectedVisualDur = Number(activeMetaForVideo?.videoTrackDuration || 0);
      const detectedAudioDur = Number(activeMetaForVideo?.audioTrackDuration || activeMetaForVideo?.duration || 0);
      if (configuredEnd > 0) {
        loopTrimHelp.textContent = `Custom loop active: loops from ${configuredStart}s to ${configuredEnd}s.`;
      } else if (detectedVisualDur > 0 && detectedAudioDur > detectedVisualDur + 0.15) {
        loopTrimHelp.textContent = `Auto-detected ${Math.round(detectedVisualDur * 10) / 10}s visual clip (${Math.round(detectedAudioDur * 10) / 10}s audio) — loops automatically at ${Math.round(detectedVisualDur * 10) / 10}s.`;
      } else {
        loopTrimHelp.textContent = "Auto-detect cuts trailing audio overhangs and frozen end frames automatically. Set Loop End Cutoff (e.g. 12s) to force an exact loop point.";
      }
    }
    const waitToggle = document.getElementById("chkWaitForVideoEnd");
    if (waitToggle) { waitToggle.checked = cfg.rotationWaitForVideoEnd === true; waitToggle.disabled = !hasAssignedVideo || playlist.length < 2 || rotationSeconds <= 0; }
    const waitHelp = document.getElementById("waitForVideoEndHelp");
    if (waitHelp) waitHelp.textContent = isActiveVideo
      ? "The interval is the minimum time before a switch. If this clip is still playing when the interval expires, the next item waits until it ends."
      : "Applies when the active playlist item is a video. Images continue to rotate on the selected interval.";
    const audioHelp = document.getElementById("videoAudioHelp");
    if (audioHelp) audioHelp.textContent = "Pause/Play and Mute/Unmute are available beside the active video in the layout map. Videos start muted. Audio preference is saved per exact origin in this build; browser autoplay rules still apply.";

    document.getElementById("sliderOpacity").value = cfg.opacity ?? 85;
    document.getElementById("valOpacity").textContent = `${cfg.opacity ?? 85}%`;
    document.getElementById("sliderBrightness").value = cfg.brightness ?? 100;
    document.getElementById("valBrightness").textContent = `${cfg.brightness ?? 100}%`;
    document.getElementById("sliderContrast").value = cfg.contrast ?? 100;
    document.getElementById("valContrast").textContent = `${cfg.contrast ?? 100}%`;
    document.getElementById("sliderSaturation").value = cfg.saturation ?? 100;
    document.getElementById("valSaturation").textContent = `${cfg.saturation ?? 100}%`;
    document.getElementById("sliderBlur").value = cfg.blur ?? 0;
    document.getElementById("valBlur").textContent = `${cfg.blur ?? 0} px`;
    document.getElementById("sliderDimmer").value = cfg.tintOpacity ?? 20;
    document.getElementById("valDimmer").textContent = `${cfg.tintOpacity ?? 20}%`;
    const backdropSlider = document.getElementById("sliderBackdropBlur");
    const backdropVal = document.getElementById("valBackdropBlur");
    if (backdropSlider) backdropSlider.value = String(cfg.backdropBlurPx ?? 0);
    if (backdropVal) backdropVal.textContent = `${cfg.backdropBlurPx ?? 0} px`;
    const textContrastSelect = document.getElementById("selectTextContrastMode");
    if (textContrastSelect) textContrastSelect.value = cfg.textContrastMode || "none";

    document.getElementById("selectSiteMatchScope").value = workingSiteConfig.matchScope || "origin";
    document.getElementById("inputTintColor").value = cfg.tintColor || "#0f172a";
    document.getElementById("selectRenderMode").value = cfg.renderModeOverride || "";
    document.getElementById("chkSoftenWrappers").checked = cfg.softenOpaqueWrappers !== false;

    const currentFit = cfg.fitMode || "cover";
    document.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.fit === currentFit);
    });
  }

  async function renderMediaLibraryGrids() {
    const renderRevision = ++mediaRenderRevision;
    const drawerGrid = document.getElementById("studioMediaGrid");
    const fullGrid = document.getElementById("libraryFullGrid");
    const libraryViewActive = currentView === "library";
    const pickerDialog = document.getElementById("editorMediaPickerDialog");
    const editorPickerOpen = currentView === "editor" && Boolean(pickerDialog && pickerDialog.open);
    const editorViewActive = currentView === "editor";

    if (!libraryViewActive && !editorPickerOpen) {
      releaseStudioUrlSet(activeMediaRenderUrls);
      if (drawerGrid) drawerGrid.replaceChildren();
      if (fullGrid) fullGrid.replaceChildren();
      if (typeof ChameleonStorageService !== "undefined") {
        try { storageStats = await ChameleonStorageService.getStorageUsageStats(); } catch (_) {}
      }
      const uploadCount = mediaItems.filter((item) => item.mediaType !== "preset").length;
      const presetCount = mediaItems.filter((item) => item.mediaType === "preset").length;
      const summary = `Showing ${uploadCount} upload${uploadCount === 1 ? "" : "s"} · ${presetCount} built-in preset${presetCount === 1 ? "" : "s"} · ${storageStats.formattedTotal || "0 B"} stored`;
      const drawerStat = document.getElementById("drawerStorageText");
      const libraryStat = document.getElementById("libraryStorageText");
      if (drawerStat) drawerStat.textContent = summary;
      if (libraryStat) libraryStat.textContent = summary;
      const settingsCount = document.getElementById("settingsStorageCount");
      const settingsBytes = document.getElementById("settingsStorageBytes");
      if (settingsCount) settingsCount.textContent = `${storageStats.itemCount || 0} item${storageStats.itemCount === 1 ? "" : "s"}`;
      if (settingsBytes) settingsBytes.textContent = storageStats.formattedTotal || "0 B";
      return;
    }

    const queryEl = document.getElementById(libraryViewActive ? "librarySearchInput" : "mediaSearchInput");
    const typeEl = document.getElementById(libraryViewActive ? "libraryMediaTypeFilter" : "mediaTypeFilter");
    const sortEl = document.getElementById(libraryViewActive ? "libraryMediaSortSelect" : "mediaSortSelect");
    const query = (queryEl?.value || "").trim();
    const mediaType = typeEl?.value || "all";
    const sortBy = sortEl?.value || "newest";

    if (typeof ChameleonStorageService !== "undefined") {
      try {
        mediaItems = await ChameleonStorageService.listMediaMetadata({ includePresets: true, query, mediaType, sortBy });
        storageStats = await ChameleonStorageService.getStorageUsageStats();
      } catch (err) {
        if (renderRevision === mediaRenderRevision) showAlert(`Could not load media library: ${err?.message || err}`, true);
        return;
      }
    }
    if (renderRevision !== mediaRenderRevision) return;

    const uploadCount = mediaItems.filter((item) => item.mediaType !== "preset").length;
    const presetCount = mediaItems.filter((item) => item.mediaType === "preset").length;
    const summary = `Showing ${uploadCount} upload${uploadCount === 1 ? "" : "s"} · ${presetCount} built-in preset${presetCount === 1 ? "" : "s"} · ${storageStats.formattedTotal || "0 B"} stored`;
    const drawerStat = document.getElementById("drawerStorageText");
    const libraryStat = document.getElementById("libraryStorageText");
    if (drawerStat) drawerStat.textContent = summary;
    if (libraryStat) libraryStat.textContent = summary;
    const settingsCount = document.getElementById("settingsStorageCount");
    const settingsBytes = document.getElementById("settingsStorageBytes");
    if (settingsCount) settingsCount.textContent = `${storageStats.itemCount || 0} item${storageStats.itemCount === 1 ? "" : "s"}`;
    if (settingsBytes) settingsBytes.textContent = storageStats.formattedTotal || "0 B";

    const currentCompCfg = workingSiteConfig.components?.[selectedCompId];
    const activePlaylist = currentCompCfg?.playlist || (currentCompCfg?.activeMediaId ? [currentCompCfg.activeMediaId] : []);
    const nextUrls = new Set();
    const fragment = document.createDocumentFragment();

    try {
      for (const item of mediaItems) {
        const pickerSelected = editorPickerOpen ? pickerSelectedMediaIds.has(item.id) : activePlaylist.includes(item.id);
        const card = await createMediaCardElement(item, pickerSelected, nextUrls, editorPickerOpen);
        if (renderRevision !== mediaRenderRevision) {
          releaseStudioUrlSet(nextUrls);
          return;
        }
        fragment.appendChild(card);
      }
    } catch (err) {
      releaseStudioUrlSet(nextUrls);
      if (renderRevision === mediaRenderRevision) showAlert(`Could not render media previews: ${err?.message || err}`, true);
      return;
    }

    if (renderRevision !== mediaRenderRevision) {
      releaseStudioUrlSet(nextUrls);
      return;
    }
    // Commit atomically: only after the newest render is ready do we revoke old
    // thumbnail URLs and replace the active grid. Stale async renders own and clean
    // up only their own URLs, never URLs created by the winning render.
    releaseStudioUrlSet(activeMediaRenderUrls);
    activeMediaRenderUrls = nextUrls;
    if (drawerGrid) drawerGrid.replaceChildren();
    if (fullGrid) fullGrid.replaceChildren();
    const visibleGrid = libraryViewActive ? fullGrid : (editorPickerOpen ? drawerGrid : null);
    if (visibleGrid) visibleGrid.appendChild(fragment);
    if (editorPickerOpen) syncPickerSelectionUI();
  }

  async function createMediaCardElement(item, isAssigned, renderUrlOwner = studioObjectUrls, pickerMode = false) {
    const card = document.createElement("div");
    card.className = "media-item-card" + (isAssigned ? (pickerMode ? " picker-selected" : " assigned") : "") + (pickerMode ? " picker-selectable" : "");
    card.dataset.mediaId = item.id;
    card.draggable = !pickerMode;
    card.setAttribute("role", pickerMode ? "option" : "listitem");
    if (pickerMode) {
      card.setAttribute("aria-selected", String(Boolean(isAssigned)));
      card.tabIndex = 0;
    }

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "media-thumb-wrap";

    if (item.mediaType === "preset" && item.gradient) {
      const thumbDiv = document.createElement("div");
      thumbDiv.className = "media-thumb-el";
      thumbDiv.style.background = item.gradient;
      thumbWrap.appendChild(thumbDiv);
    } else if (typeof ChameleonStorageService !== "undefined") {
      const fullRec = await ChameleonStorageService.getMediaRecordWithBlob(item.id);
      if (fullRec && fullRec.blob) {
        const u = URL.createObjectURL(fullRec.blob);
        studioObjectUrls.add(u);
        renderUrlOwner.add(u);
        if (item.mediaType === "video") {
          const vidEl = document.createElement("video");
          vidEl.className = "media-thumb-el";
          vidEl.src = u;
          vidEl.muted = true;
          vidEl.preload = "metadata";
          thumbWrap.appendChild(vidEl);
        } else {
          const imgEl = document.createElement("img");
          imgEl.className = "media-thumb-el";
          imgEl.src = u;
          imgEl.alt = item.name;
          thumbWrap.appendChild(imgEl);
        }
      }
    }

    const typeLabel = item.mediaType === "preset"
      ? "PRESET"
      : (item.mimeType || "").split("/")[1]?.toUpperCase() || "MEDIA";

    const typeBadge = document.createElement("span");
    typeBadge.className = "media-type-badge";
    typeBadge.textContent = typeLabel;
    thumbWrap.appendChild(typeBadge);

    const bodyDiv = document.createElement("div");
    bodyDiv.className = "media-card-body";

    const titleDiv = document.createElement("div");
    titleDiv.className = "media-card-title";
    titleDiv.title = item.name;
    titleDiv.textContent = item.name;

    const dimsPart = item.width && item.height ? `${item.width}×${item.height}` : "";
    const durPart = item.duration ? ` • ${item.duration}s` : "";
    const sizePart = item.size ? ` • ${ChameleonStorageService.formatBytes(item.size)}` : "";

    const subDiv = document.createElement("div");
    subDiv.className = "media-card-sub";
    subDiv.textContent = (dimsPart + durPart + sizePart).replace(/^ • /, "") || "Built-in";

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "media-card-actions";

    const assignBtn = document.createElement("button");
    assignBtn.type = "button";
    if (pickerMode) {
      assignBtn.className = "btn btn-sm btn-picker-select";
      assignBtn.textContent = isAssigned ? "Selected ✓" : "Select";
      assignBtn.setAttribute("aria-pressed", String(Boolean(isAssigned)));
      assignBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        togglePickerMediaSelection(item.id);
      });
      card.addEventListener("click", (event) => {
        if (event.target.closest("button[data-media-delete]")) return;
        togglePickerMediaSelection(item.id);
      });
    } else {
      assignBtn.className = "btn btn-sm btn-assign";
      assignBtn.textContent = currentView === "library" ? "Use in editor" : (isAssigned ? "Added" : "Apply");
      assignBtn.addEventListener("click", () => {
        const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
        if (currentView === "library") switchStudioView("editor");
        assignMediaToComponentInStudio(comp, item.id);
        const pickerDialog = document.getElementById("editorMediaPickerDialog");
        if (pickerDialog && pickerDialog.open) closeEditorMediaPicker();
      });
    }
    actionsDiv.appendChild(assignBtn);

    if (item.mediaType !== "preset") {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn btn-danger-outline btn-sm btn-delete";
      delBtn.setAttribute("aria-label", `Delete ${item.name}`);
      delBtn.dataset.mediaDelete = "true";
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await sendRuntimeMessage({ type: "CHAMELEON_MEDIA_DELETE", mediaId: item.id });
        if (typeof ChameleonStorageService !== "undefined") {
          await ChameleonStorageService.deleteMediaRecord(item.id);
          try { allMediaItems = await ChameleonStorageService.listMediaMetadata({ includePresets: true }); } catch (_) {}
        }
        const pruneFromConfig = (cfgObj) => {
          if (!cfgObj || !cfgObj.components) return;
          for (const comp of Object.values(cfgObj.components)) {
            if (!comp || typeof comp !== "object") continue;
            if (Array.isArray(comp.playlist)) {
              comp.playlist = comp.playlist.filter((id) => id !== item.id);
            }
            if (comp.activeMediaId === item.id) {
              comp.activeMediaId = (Array.isArray(comp.playlist) && comp.playlist.length > 0) ? comp.playlist[0] : null;
            }
          }
        };
        pruneFromConfig(workingSiteConfig);
        pruneFromConfig(savedSiteConfig);
        pickerSelectedMediaIds.delete(item.id);
        await renderMediaLibraryGrids();
        renderRightInspectorPanel();
        renderCenterLayoutMap();
      });
      actionsDiv.appendChild(delBtn);
    }

    bodyDiv.append(titleDiv, subDiv, actionsDiv);
    card.append(thumbWrap, bodyDiv);

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/chameleon-media-id", item.id);
      e.dataTransfer.effectAllowed = "copy";
    });

    return card;
  }

  // =========================================================================
  // 3. INTERACTION HANDLERS
  // =========================================================================
  function getDefaultComponentConfig(comp) {
    return {
      id: comp.id,
      friendlyName: comp.label || "Page Area",
      enabled: true,
      locator: comp.locator || { id: comp.id, isWholePage: comp.id === "root_page", label: comp.label, fallbackSelector: "body" },
      renderModeOverride: null,
      playlist: [],
      activeMediaId: null,
      rotationIntervalSec: 0,
      videoPaused: false,
      videoMuted: true,
      videoVolume: 35,
      videoLoopStartSec: 0,
      videoLoopEndSec: 0,
      videoAudioRequestedAt: 0,
      shuffle: false,
      fitMode: "cover",
      opacity: 85,
      brightness: 100,
      contrast: 100,
      saturation: 100,
      blur: 0,
      backdropBlurPx: 0,
      textContrastMode: "none",
      tintColor: "#0f172a",
      tintOpacity: 20,
      softenOpaqueWrappers: true
    };
  }

  function ensureComponentInWorkingConfig(comp) {
    if (!workingSiteConfig.components) workingSiteConfig.components = {};
    if (!workingSiteConfig.components[comp.id]) {
      workingSiteConfig.components[comp.id] = getDefaultComponentConfig(comp);
    }
    return workingSiteConfig.components[comp.id];
  }

  function selectComponentArea(compId) {
    selectedCompId = compId;
    if (targetTabId) {
      sendTabMessage(targetTabId, { type: "CHAMELEON_HIGHLIGHT_COMPONENT", compId });
    }
    renderAllPanels();
  }

  function assignMediaToComponentInStudio(comp, mediaId) {
    if (!comp) return;
    if (comp.suitability && comp.suitability.suitable === false) {
      showAlert(`Cannot apply background to "${comp.label}": ${comp.suitability.reason}`, true);
      return;
    }
    pushUndoState();
    selectedCompId = comp.id;
    const cfg = ensureComponentInWorkingConfig(comp);
    if (!Array.isArray(cfg.playlist)) cfg.playlist = [];
    if (!cfg.playlist.includes(mediaId)) {
      cfg.playlist.push(mediaId);
    }
    cfg.activeMediaId = mediaId;
    cfg.enabled = true;
    pushLivePreviewToTab(false);
    renderAllPanels();
  }

  function bindDropZoneEvents(el, comp) {
    el.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.add("drag-over");
    });
    el.addEventListener("dragleave", () => {
      el.classList.remove("drag-over");
    });
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove("drag-over");

      const mediaId = e.dataTransfer.getData("text/chameleon-media-id");
      if (mediaId) {
        assignMediaToComponentInStudio(comp, mediaId);
        return;
      }

      const files = Array.from(e.dataTransfer.files || []);
      if (files.length > 0) {
        await handleFilesImport(files, comp);
      }
    });
  }

  async function handleFilesImport(files, targetComp = null) {
    const convertToWebP = document.getElementById("chkConvertToWebP").checked;
    const preserveOriginal = document.getElementById("chkPreserveOriginal").checked;
    const reportBar = document.getElementById("conversionReportBar");

    for (const file of files) {
      try {
        const res = await ChameleonStorageService.importMediaItem(file, {
          convertToWebP,
          preserveOriginal,
          maxDimension: Number(globalSettings.maxImageDimension) || 2560,
          maxMediaSizeBytes: Number(globalSettings.maxMediaSizeBytes) || 50 * 1024 * 1024,
          quality: 0.86
        });

        if (res.conversionReport && res.conversionReport.reason) {
          reportBar.textContent = res.conversionReport.reason;
          reportBar.hidden = false;
        }

        const pickerIsOpen = Boolean(document.getElementById("editorMediaPickerDialog")?.open);
        const importingIntoPicker = !targetComp && currentView === "editor" && pickerIsOpen;
        const isEditorImport = Boolean(targetComp) || (currentView === "editor" && !importingIntoPicker);
        const compToUse = targetComp || detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
        if (importingIntoPicker && res.primaryRecord) {
          if (pickerAssignmentMode === "single") pickerSelectedMediaIds.clear();
          pickerSelectedMediaIds.add(res.primaryRecord.id);
          syncPickerSelectionUI();
        } else if (isEditorImport && compToUse && res.primaryRecord) {
          assignMediaToComponentInStudio(compToUse, res.primaryRecord.id);
        }
      } catch (err) {
        showAlert(`Import failed for "${file.name}": ${err.message}`, true);
      }
    }

    try { allMediaItems = await ChameleonStorageService.listMediaMetadata({ includePresets: true }); } catch (_) {}
    renderAllPanels();
    if (document.getElementById("editorMediaPickerDialog")?.open) await renderMediaLibraryGrids();
  }

  async function pushLivePreviewToTab(recordUndo = false) {
    updateTopbarDraftControls();
    scheduleAutoSave();
    if (!targetTabId) return;
    const res = await sendTabMessage(targetTabId, {
      type: "CHAMELEON_PREVIEW_DRAFT_CONFIG",
      siteConfig: workingSiteConfig,
      recordUndo
    });
    if (res?.diagnostics) {
      latestDiagnostics = res.diagnostics;
    }
    return res;
  }

  async function saveWorkingConfig(forceOverwrite = false, options = {}) {
    const saveRes = await sendRuntimeMessage({
      type: "CHAMELEON_SAVE_SITE_CONFIG",
      siteKey: targetSiteKey,
      hostname: targetHostname,
      siteConfig: workingSiteConfig,
      expectedRevision: savedSiteConfig.revision,
      baseComponents: savedSiteConfig.components,
      forceOverwrite,
      targetTabId
    });

    if (saveRes && saveRes.conflict) {
      pendingConflictRemoteConfig = saveRes.currentConfig || null;
      showAlert(saveRes.error || "Another tab saved newer customizations for this site.", true, true);
      return;
    }

    if (saveRes && saveRes.siteConfig) {
      savedSiteConfig = deepClone(saveRes.siteConfig);
      if (!options.silentAutoSave) {
        workingSiteConfig = deepClone(saveRes.siteConfig);
      } else {
        workingSiteConfig.revision = saveRes.siteConfig.revision;
      }
    } else {
      savedSiteConfig = deepClone(workingSiteConfig);
    }

    pendingConflictRemoteConfig = null;
    document.getElementById("globalAlertBanner").hidden = true;

    if (options.silentAutoSave) {
      updateTopbarDraftControls();
    } else {
      renderAllPanels();
    }
  }

  function setActiveSettingsNav(sectionId) {
    document.querySelectorAll("[data-settings-target]").forEach((link) => {
      const active = link.dataset.settingsTarget === sectionId;
      link.classList.toggle("active", active);
      if (active) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  }

  function setupSettingsNavigation() {
    const scrollRoot = document.getElementById("viewSettings");
    const links = Array.from(document.querySelectorAll("[data-settings-target]"));
    const sections = links.map((link) => document.getElementById(link.dataset.settingsTarget)).filter(Boolean);
    if (!scrollRoot || !links.length || !sections.length) return;

    links.forEach((link) => {
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const section = document.getElementById(link.dataset.settingsTarget);
        if (!section) return;
        section.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
          block: "start"
        });
        setActiveSettingsNav(section.id);
      });
    });

    if (typeof IntersectionObserver === "function") {
      settingsSectionObserver?.disconnect();
      settingsSectionObserver = new IntersectionObserver((entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveSettingsNav(visible[0].target.id);
      }, { root: scrollRoot, rootMargin: "-8% 0px -72% 0px", threshold: [0, 0.1, 0.25] });
      sections.forEach((section) => settingsSectionObserver.observe(section));
    } else {
      let scheduled = false;
      scrollRoot.addEventListener("scroll", () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
          scheduled = false;
          const rootTop = scrollRoot.getBoundingClientRect().top;
          let current = sections[0];
          for (const section of sections) {
            if (section.getBoundingClientRect().top - rootTop <= 120) current = section;
          }
          setActiveSettingsNav(current.id);
        });
      }, { passive: true });
    }

    const helpButton = document.getElementById("btnOpenSiteAccessHelp");
    const helpText = document.getElementById("siteAccessHelpText");
    if (helpButton && helpText) {
      helpButton.addEventListener("click", () => {
        helpText.hidden = !helpText.hidden;
        helpButton.textContent = helpText.hidden ? "How site access works" : "Hide site access explanation";
      });
    }
  }

  function openEditorMediaPicker() {
    const dialog = document.getElementById("editorMediaPickerDialog");
    if (!dialog) return;
    const cfg = workingSiteConfig.components?.[selectedCompId] || {};
    const existingPlaylist = Array.isArray(cfg.playlist) && cfg.playlist.length
      ? cfg.playlist
      : (cfg.activeMediaId ? [cfg.activeMediaId] : []);
    pickerSelectedMediaIds = new Set(existingPlaylist);
    // Default to multi-select so users can build a playlist with one click per item.
    pickerAssignmentMode = "playlist";
    const modeSelect = document.getElementById("pickerAssignmentMode");
    if (modeSelect) modeSelect.value = pickerAssignmentMode;
    syncPickerSelectionUI();
    try {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } catch (_) {
      dialog.setAttribute("open", "");
    }
    const grid = document.getElementById("studioMediaGrid");
    if (grid) grid.dataset.assignmentMode = pickerAssignmentMode;
    renderMediaLibraryGrids();
    window.setTimeout(() => document.getElementById("mediaSearchInput")?.focus(), 0);
  }

  function syncPickerSelectionUI() {
    const grid = document.getElementById("studioMediaGrid");
    const count = pickerSelectedMediaIds.size;
    if (grid) {
      grid.dataset.assignmentMode = pickerAssignmentMode;
      grid.querySelectorAll(".media-item-card[data-media-id]").forEach((card) => {
        const selected = pickerSelectedMediaIds.has(card.dataset.mediaId);
        card.classList.toggle("picker-selected", selected);
        card.setAttribute("aria-selected", String(selected));
        const button = card.querySelector(".btn-picker-select");
        if (button) {
          button.textContent = selected ? "Selected ✓" : "Select";
          button.setAttribute("aria-pressed", String(selected));
        }
      });
    }
    const countEl = document.getElementById("pickerSelectionCount");
    const helpEl = document.getElementById("pickerSelectionHelp");
    const confirmBtn = document.getElementById("btnConfirmEditorMediaPicker");
    if (countEl) countEl.textContent = `${count} selected`;
    if (helpEl) helpEl.textContent = pickerAssignmentMode === "playlist"
      ? (count > 1 ? "These will become the component's playlist." : "Select multiple items to create a playlist.")
      : "Choose one background. Selecting another replaces the current selection.";
    if (confirmBtn) confirmBtn.disabled = count === 0 || (pickerAssignmentMode === "single" && count !== 1);
  }

  function togglePickerMediaSelection(mediaId) {
    if (!mediaId) return;
    if (pickerSelectedMediaIds.has(mediaId)) {
      pickerSelectedMediaIds.delete(mediaId);
    } else {
      if (pickerAssignmentMode === "single") pickerSelectedMediaIds.clear();
      pickerSelectedMediaIds.add(mediaId);
    }
    syncPickerSelectionUI();
  }

  function changePickerAssignmentMode(mode) {
    pickerAssignmentMode = mode === "playlist" ? "playlist" : "single";
    if (pickerAssignmentMode === "single" && pickerSelectedMediaIds.size > 1) {
      const keepLastSelected = Array.from(pickerSelectedMediaIds).at(-1);
      pickerSelectedMediaIds = new Set(keepLastSelected ? [keepLastSelected] : []);
    }
    syncPickerSelectionUI();
  }

  async function commitEditorMediaPickerSelection() {
    const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
    if (!comp) {
      showAlert("Select a page area before assigning background media.", true);
      return;
    }
    if (comp.suitability?.suitable === false) {
      showAlert(`Cannot apply a background to "${comp.label}": ${comp.suitability.reason}`, true);
      return;
    }
    const availableIds = new Set(allMediaItems.map((item) => item.id));
    const chosenIds = Array.from(pickerSelectedMediaIds).filter((id) => availableIds.has(id));
    if (!chosenIds.length || (pickerAssignmentMode === "single" && chosenIds.length !== 1)) return;

    pushUndoState();
    selectedCompId = comp.id;
    const cfg = ensureComponentInWorkingConfig(comp);
    const chosenUnique = [...new Set(chosenIds)];
    cfg.playlist = chosenUnique;
    cfg.activeMediaId = chosenUnique.includes(cfg.activeMediaId) ? cfg.activeMediaId : chosenUnique[0];
    cfg.enabled = true;
    if (pickerAssignmentMode === "single") {
      cfg.rotationIntervalSec = 0;
      cfg.shuffle = false;
    } else if (chosenUnique.length > 1 && Number(cfg.rotationIntervalSec || 0) === 0) {
      cfg.rotationIntervalSec = 15;
    }
    await pushLivePreviewToTab(false);
    renderAllPanels();
    closeEditorMediaPicker();
  }

  function closeEditorMediaPicker() {
    const dialog = document.getElementById("editorMediaPickerDialog");
    pickerSelectedMediaIds.clear();
    if (!dialog) return;
    try {
      if (typeof dialog.close === "function" && dialog.open) {
        dialog.close(); // The close event performs preview-URL cleanup exactly once.
        return;
      }
      dialog.removeAttribute("open");
    } catch (_) { dialog.removeAttribute("open"); }
    renderMediaLibraryGrids();
  }

  function switchStudioView(viewName) {
    const supportedViews = new Set(["editor", "library", "websites", "settings"]);
    const nextView = supportedViews.has(viewName) ? viewName : "editor";
    const previousView = currentView;
    currentView = nextView;
    if (currentView === "settings" && previousView !== "settings") {
      const settingsView = document.getElementById("viewSettings");
      if (settingsView) settingsView.scrollTop = 0;
      setActiveSettingsNav("settings-general");
    }
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      const active = btn.dataset.view === currentView;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    document.getElementById("viewEditor").hidden = currentView !== "editor";
    document.getElementById("viewLibrary").hidden = currentView !== "library";
    const websitesView = document.getElementById("viewWebsites");
    if (websitesView) websitesView.hidden = currentView !== "websites";
    document.getElementById("viewSettings").hidden = currentView !== "settings";
    // Draft actions only belong to the editor. Keeping them visible on Settings or
    // Media Library made those screens look like a continuation of the editor.
    document.querySelectorAll("[data-editor-only=\"true\"]").forEach((el) => {
      el.hidden = currentView !== "editor";
    });
    document.title = currentView === "library"
      ? "ChameleonBG — Media Library"
      : currentView === "websites"
        ? "ChameleonBG — Websites"
        : currentView === "settings"
          ? "ChameleonBG — Settings"
          : "ChameleonBG — Visual Editor";
    if (currentView === "settings") requestAnimationFrame(() => setActiveSettingsNav("settings-general"));
    if (currentView === "websites" && previousView !== "websites") {
      renderWebsitesView().catch((err) => showAlert(`Could not load websites: ${err?.message || err}`, true));
    }
  }

  // =========================================================================
  // WEBSITES VIEW + MULTI-SITE RETARGETING (v2.1.0)
  // =========================================================================
  function formatSiteUpdated(ts) {
    if (!ts) return "Never saved";
    try { return `Saved ${new Date(ts).toLocaleString()}`; } catch (_) { return "Saved"; }
  }

  async function renderWebsitesView() {
    const list = document.getElementById("websitesList");
    const empty = document.getElementById("websitesEmptyNotice");
    const count = document.getElementById("websitesCountText");
    const themesList = document.getElementById("domainThemesList");
    const themesEmpty = document.getElementById("domainThemesEmptyNotice");
    if (!list) return;

    let sites = [];
    let themes = [];
    try {
      const [sitesRes, themesRes] = await Promise.all([
        sendRuntimeMessage({ type: "CHAMELEON_LIST_SITES" }),
        sendRuntimeMessage({ type: "CHAMELEON_THEME_LIST" })
      ]);
      if (sitesRes && sitesRes.ok && Array.isArray(sitesRes.sites)) sites = sitesRes.sites;
      if (themesRes && themesRes.ok && Array.isArray(themesRes.themes)) themes = themesRes.themes;
    } catch (_) {}

    if (themesList && themesEmpty) {
      themesList.replaceChildren();
      themesEmpty.hidden = themes.length > 0;
      for (const theme of themes) {
        themesList.appendChild(buildDomainThemeCard(theme));
      }
    }

    list.replaceChildren();
    count.textContent = `${sites.length} website${sites.length === 1 ? "" : "s"}`;
    empty.hidden = sites.length > 0;
    for (const site of sites) list.appendChild(buildWebsiteRow(site, themes));
  }

  function buildDomainThemeCard(theme) {
    const card = document.createElement("div");
    card.className = "theme-card";
    card.dataset.themeId = theme.id;

    const header = document.createElement("div");
    header.className = "theme-card-header";
    const title = document.createElement("h4");
    title.className = "theme-card-title";
    title.textContent = theme.displayName || theme.domain || "Custom Theme";
    const domainPill = document.createElement("span");
    domainPill.className = "theme-card-domain";
    domainPill.textContent = theme.domain || "Domain";
    header.append(title, domainPill);

    const body = document.createElement("div");
    body.className = "theme-card-body";

    const styleInfo = document.createElement("div");
    styleInfo.textContent = `Opacity: ${theme.defaultStyles?.opacity ?? 85}% • Blur: ${theme.defaultStyles?.blur ?? 0}px`;

    const audioInfo = document.createElement("div");
    audioInfo.textContent = `Audio: ${theme.audioDefaults?.videoMuted !== false ? "Muted default" : "Sound requested"} • Vol: ${theme.audioDefaults?.videoVolume ?? 35}%`;

    const inheritInfo = document.createElement("div");
    const siteCount = Array.isArray(theme.assignedSites) ? theme.assignedSites.length : 0;
    inheritInfo.textContent = `${siteCount} site${siteCount === 1 ? "" : "s"} assigned • ${theme.autoInheritSubdomains ? "Auto-inherits subdomains" : "Exact sites only"}`;

    body.append(styleInfo, audioInfo, inheritInfo);

    const actions = document.createElement("div");
    actions.className = "theme-card-actions";

    const applyToCurrentBtn = document.createElement("button");
    applyToCurrentBtn.type = "button";
    applyToCurrentBtn.className = "btn btn-sm btn-primary";
    applyToCurrentBtn.textContent = "Apply to Current Site";
    applyToCurrentBtn.title = `Apply this theme's background media and styles to ${targetSiteKey}`;
    applyToCurrentBtn.addEventListener("click", async () => {
      applyToCurrentBtn.disabled = true;
      try {
        await applyThemeToCurrentSite(theme);
      } finally {
        applyToCurrentBtn.disabled = false;
      }
    });

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn btn-sm";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openThemeModal(theme));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-sm btn-delete-site";
    deleteBtn.textContent = "Delete";
    deleteBtn.addEventListener("click", async () => {
      if (window.confirm(`Delete domain theme "${theme.displayName || theme.domain}"? Assigned websites will keep their saved settings.`)) {
        deleteBtn.disabled = true;
        const res = await sendRuntimeMessage({ type: "CHAMELEON_THEME_DELETE", themeId: theme.id, unassignSites: true });
        if (!res?.ok) showAlert(res?.error || "Could not delete theme.", true);
        await renderWebsitesView();
      }
    });

    actions.append(applyToCurrentBtn, editBtn, deleteBtn);
    card.append(header, body, actions);
    return card;
  }

  async function applyThemeToCurrentSite(theme) {
    if (!theme) return;
    pushUndoState();
    await sendRuntimeMessage({
      type: "CHAMELEON_THEME_ASSIGN_SITE",
      siteKey: targetSiteKey,
      themeId: theme.id
    });
    workingSiteConfig.themeId = theme.id;
    const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0] || { id: "root_page", label: "Entire Website" };
    const cfg = ensureComponentInWorkingConfig(comp);
    if (theme.defaultMedia) {
      if (Array.isArray(theme.defaultMedia.playlist) && theme.defaultMedia.playlist.length > 0) {
        cfg.playlist = [...theme.defaultMedia.playlist];
      } else if (theme.defaultMedia.mediaId) {
        cfg.playlist = [theme.defaultMedia.mediaId];
      }
      if (theme.defaultMedia.mediaId) {
        cfg.activeMediaId = theme.defaultMedia.mediaId;
      } else if (cfg.playlist.length > 0) {
        cfg.activeMediaId = cfg.playlist[0];
      }
      if (typeof theme.defaultMedia.rotationIntervalSec === "number") {
        cfg.rotationIntervalSec = theme.defaultMedia.rotationIntervalSec;
      }
    }
    if (theme.defaultStyles) {
      if (theme.defaultStyles.opacity !== undefined) cfg.opacity = theme.defaultStyles.opacity;
      if (theme.defaultStyles.blur !== undefined) cfg.blur = theme.defaultStyles.blur;
      if (theme.defaultStyles.brightness !== undefined) cfg.brightness = theme.defaultStyles.brightness;
      if (theme.defaultStyles.contrast !== undefined) cfg.contrast = theme.defaultStyles.contrast;
      if (theme.defaultStyles.saturation !== undefined) cfg.saturation = theme.defaultStyles.saturation;
      if (theme.defaultStyles.tintOpacity !== undefined) cfg.tintOpacity = theme.defaultStyles.tintOpacity;
      if (theme.defaultStyles.tintColor !== undefined) cfg.tintColor = theme.defaultStyles.tintColor;
      if (theme.defaultStyles.backdropBlurPx !== undefined) cfg.backdropBlurPx = theme.defaultStyles.backdropBlurPx;
      if (theme.defaultStyles.textContrastMode !== undefined) cfg.textContrastMode = theme.defaultStyles.textContrastMode;
    }
    if (theme.audioDefaults) {
      if (theme.audioDefaults.videoMuted !== undefined) cfg.videoMuted = theme.audioDefaults.videoMuted;
      if (theme.audioDefaults.videoVolume !== undefined) cfg.videoVolume = theme.audioDefaults.videoVolume;
    }
    cfg.enabled = true;
    await pushLivePreviewToTab(false);
    await saveWorkingConfig(true);
    switchStudioView("editor");
    renderAllPanels();
    showAlert(`Applied theme "${theme.displayName || theme.domain}" to ${targetSiteKey}.`);
  }

  function openSaveCurrentSiteAsThemeModal() {
    const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
    const cfg = (comp && workingSiteConfig.components?.[comp.id]) ||
                workingSiteConfig.components?.root_page ||
                Object.values(workingSiteConfig.components || {})[0] ||
                (comp ? getDefaultComponentConfig(comp) : {});
    const regDomain = typeof ChameleonStorageService?.deriveRegistrableDomain === "function"
      ? ChameleonStorageService.deriveRegistrableDomain(targetSiteKey)
      : targetHostname;
    const playlist = Array.isArray(cfg.playlist) && cfg.playlist.length > 0
      ? [...cfg.playlist]
      : (cfg.activeMediaId ? [cfg.activeMediaId] : []);
    pendingThemeDefaultMedia = {
      mediaId: cfg.activeMediaId || playlist[0] || null,
      playlist,
      rotationIntervalSec: Number(cfg.rotationIntervalSec || 0)
    };
    pendingThemeDefaultStyles = {
      opacity: Number(cfg.opacity ?? 85),
      blur: Number(cfg.blur ?? 0),
      brightness: Number(cfg.brightness ?? 100),
      contrast: Number(cfg.contrast ?? 100),
      saturation: Number(cfg.saturation ?? 100),
      tintOpacity: Number(cfg.tintOpacity ?? 20),
      tintColor: cfg.tintColor || "#0f172a",
      backdropBlurPx: Number(cfg.backdropBlurPx ?? 0),
      textContrastMode: cfg.textContrastMode || "none"
    };
    openThemeModal({
      id: "",
      displayName: `${regDomain} Custom Theme`,
      domain: regDomain,
      autoInheritSubdomains: true,
      defaultStyles: pendingThemeDefaultStyles,
      defaultMedia: pendingThemeDefaultMedia,
      audioDefaults: {
        videoMuted: cfg.videoMuted !== false,
        videoVolume: Number(cfg.videoVolume ?? 35)
      }
    });
    const heading = document.getElementById("themeModalHeading");
    if (heading) heading.textContent = "Save Current Website Setup as Reusable Theme";
  }

  function openThemeModal(theme = null) {
    const overlay = document.getElementById("themeModalOverlay");
    const heading = document.getElementById("themeModalHeading");
    const idInput = document.getElementById("themeInputId");
    const nameInput = document.getElementById("themeInputName");
    const domainInput = document.getElementById("themeInputDomain");
    const autoInherit = document.getElementById("themeCheckAutoInherit");
    const sliderOpacity = document.getElementById("themeSliderOpacity");
    const sliderBlur = document.getElementById("themeSliderBlur");
    const checkMuted = document.getElementById("themeCheckMuted");
    const sliderVolume = document.getElementById("themeSliderVolume");
    const opacityVal = document.getElementById("themeOpacityValue");
    const blurVal = document.getElementById("themeBlurValue");
    const volumeVal = document.getElementById("themeVolumeValue");

    if (!overlay) return;

    if (theme) {
      if (heading) heading.textContent = theme.id ? "Edit Domain Theme" : "Save Current Website Setup as Reusable Theme";
      if (idInput) idInput.value = theme.id || "";
      if (nameInput) nameInput.value = theme.displayName || "";
      if (domainInput) domainInput.value = theme.domain || "";
      if (autoInherit) autoInherit.checked = theme.autoInheritSubdomains !== false;
      if (sliderOpacity) sliderOpacity.value = theme.defaultStyles?.opacity ?? 85;
      if (sliderBlur) sliderBlur.value = theme.defaultStyles?.blur ?? 0;
      if (checkMuted) checkMuted.checked = theme.audioDefaults?.videoMuted !== false;
      if (sliderVolume) sliderVolume.value = theme.audioDefaults?.videoVolume ?? 35;
      pendingThemeDefaultMedia = theme.defaultMedia ? deepClone(theme.defaultMedia) : null;
      pendingThemeDefaultStyles = theme.defaultStyles ? deepClone(theme.defaultStyles) : null;
    } else {
      if (heading) heading.textContent = "Create Domain Theme";
      if (idInput) idInput.value = "";
      if (nameInput) nameInput.value = "";
      if (domainInput) domainInput.value = "";
      if (autoInherit) autoInherit.checked = true;
      if (sliderOpacity) sliderOpacity.value = 85;
      if (sliderBlur) sliderBlur.value = 0;
      if (checkMuted) checkMuted.checked = true;
      if (sliderVolume) sliderVolume.value = 35;
      pendingThemeDefaultMedia = null;
      pendingThemeDefaultStyles = null;
    }

    if (opacityVal && sliderOpacity) opacityVal.textContent = `${sliderOpacity.value}%`;
    if (blurVal && sliderBlur) blurVal.textContent = `${sliderBlur.value}px`;
    if (volumeVal && sliderVolume) volumeVal.textContent = `${sliderVolume.value}%`;

    overlay.hidden = false;
  }

  function closeThemeModal() {
    const overlay = document.getElementById("themeModalOverlay");
    if (overlay) overlay.hidden = true;
  }

  async function handleThemeModalSubmit(e) {
    e.preventDefault();
    const id = document.getElementById("themeInputId")?.value || undefined;
    const displayName = document.getElementById("themeInputName")?.value.trim() || "";
    const domain = document.getElementById("themeInputDomain")?.value.trim() || "";
    const autoInheritSubdomains = document.getElementById("themeCheckAutoInherit")?.checked !== false;
    const opacity = Number(document.getElementById("themeSliderOpacity")?.value ?? 85);
    const blur = Number(document.getElementById("themeSliderBlur")?.value ?? 0);
    const videoMuted = document.getElementById("themeCheckMuted")?.checked !== false;
    const videoVolume = Number(document.getElementById("themeSliderVolume")?.value ?? 35);

    const themePayload = {
      id,
      displayName,
      domain,
      autoInheritSubdomains,
      defaultStyles: {
        ...(pendingThemeDefaultStyles || {}),
        opacity,
        blur
      },
      defaultMedia: pendingThemeDefaultMedia || undefined,
      audioDefaults: { videoMuted, videoVolume }
    };

    const res = await sendRuntimeMessage({ type: "CHAMELEON_THEME_SAVE", theme: themePayload });
    if (!res?.ok) {
      showAlert(res?.error || "Could not save domain theme.", true);
      return;
    }
    closeThemeModal();
    showAlert(`Saved reusable theme "${displayName || domain}". You can apply it to any website from the Websites tab.`);
    await renderWebsitesView();
  }

  function buildWebsiteRow(site, allThemes = []) {
    const li = document.createElement("li");
    li.className = "website-row";
    li.dataset.origin = site.origin;

    const main = document.createElement("div");
    main.className = "website-row-main";
    const host = document.createElement("div");
    host.className = "website-row-host";
    host.textContent = site.hostname;
    host.title = site.origin;
    const meta = document.createElement("div");
    meta.className = "website-row-meta";
    meta.textContent = `${site.origin} • ${site.customizedCount} of ${site.componentCount} area${site.componentCount === 1 ? "" : "s"} with backgrounds • ${formatSiteUpdated(site.updatedAt)}`;
    main.append(host, meta);

    const badges = document.createElement("div");
    badges.className = "website-row-actions";
    const stateBadge = document.createElement("span");
    stateBadge.className = `website-badge ${site.enabled ? "on" : "off"}`;
    stateBadge.textContent = site.enabled ? "Enabled" : "Off";
    badges.appendChild(stateBadge);
    if (site.openTabIds.length) {
      const openBadge = document.createElement("span");
      openBadge.className = "website-badge open";
      openBadge.textContent = "Open in browser";
      badges.appendChild(openBadge);
    }

    if (site.themeId) {
      const assignedTheme = allThemes.find((t) => t.id === site.themeId);
      const themeBadge = document.createElement("span");
      themeBadge.className = "website-theme-badge";
      themeBadge.textContent = `Theme: ${assignedTheme ? assignedTheme.displayName : site.themeId}`;
      badges.appendChild(themeBadge);
    }

    if (allThemes.length > 0) {
      const themeSelect = document.createElement("select");
      themeSelect.className = "site-switcher";
      themeSelect.setAttribute("aria-label", "Assign theme");
      const noOpt = document.createElement("option");
      noOpt.value = "";
      noOpt.textContent = "No Theme";
      themeSelect.appendChild(noOpt);
      for (const t of allThemes) {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = `${t.displayName} (${t.domain})`;
        if (site.themeId === t.id) opt.selected = true;
        themeSelect.appendChild(opt);
      }
      themeSelect.addEventListener("change", async () => {
        themeSelect.disabled = true;
        await sendRuntimeMessage({
          type: "CHAMELEON_THEME_ASSIGN_SITE",
          siteKey: site.origin,
          themeId: themeSelect.value || null
        });
        await renderWebsitesView();
      });
      badges.appendChild(themeSelect);
    }

    const actions = document.createElement("div");
    actions.className = "website-row-actions";
    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "btn btn-sm";
    openBtn.textContent = "Open";
    openBtn.addEventListener("click", () => openWebsiteFromList(site, openBtn));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "btn btn-sm btn-delete-site";
    deleteBtn.textContent = "Delete";
    deleteBtn.title = "Delete this website's saved settings. Media is kept.";
    deleteBtn.addEventListener("click", () => {
      // Inline confirmation instead of a blocking dialog.
      const confirmText = document.createElement("span");
      confirmText.className = "website-confirm-text";
      confirmText.textContent = "Delete settings?";
      const yes = document.createElement("button");
      yes.type = "button";
      yes.className = "btn btn-sm btn-delete-site";
      yes.textContent = "Yes, delete";
      const no = document.createElement("button");
      no.type = "button";
      no.className = "btn btn-sm";
      no.textContent = "Cancel";
      no.addEventListener("click", () => actions.replaceChildren(openBtn, deleteBtn));
      yes.addEventListener("click", async () => {
        yes.disabled = true;
        const result = await sendRuntimeMessage({ type: "CHAMELEON_DELETE_SITE_CONFIG", origin: site.origin });
        if (!result?.ok) {
          yes.disabled = false;
          showAlert(result?.error || "Could not delete this website's settings.", true);
          return;
        }
        if (normalizeOrigin(targetSiteKey) === site.origin) {
          savedSiteConfig = { siteKey: site.origin, hostname: site.hostname, matchScope: "origin", enabled: true, revision: 0, components: {} };
          workingSiteConfig = deepClone(savedSiteConfig);
          undoStack.length = 0;
          selectedCompId = "root_page";
        }
        await renderWebsitesView();
      });
      actions.replaceChildren(confirmText, yes, no);
    });
    actions.append(openBtn, deleteBtn);

    li.append(main, badges, actions);
    return li;
  }

  function normalizeOrigin(value) {
    try { return new URL(String(value)).origin.toLowerCase(); } catch (_) { return String(value || "").toLowerCase(); }
  }

  async function confirmLeaveCurrentSite() {
    if (!hasUnsavedPreviewChanges()) return true;
    if (document.hidden) return true;
    return window.confirm("You have unsaved changes for this website. Switch anyway and discard them?");
  }

  async function openWebsiteFromList(site, button) {
    if (button) button.disabled = true;
    try {
      let tabId = site.openTabIds[0];
      if (!tabId) {
        let parsedSiteUrl = null;
        try {
          parsedSiteUrl = new URL(String(site.origin || ""));
        } catch (_) {}
        if (!parsedSiteUrl || (parsedSiteUrl.protocol !== "http:" && parsedSiteUrl.protocol !== "https:")) {
          showAlert("Refusing to open unsafe or unsupported website URL.", true);
          return;
        }
        const created = await new Promise((resolve) => chrome.tabs.create({ url: parsedSiteUrl.origin, active: false }, (tab) => resolve(tab || null)));
        if (!created || !Number.isInteger(created.id)) { showAlert("Could not open that website.", true); return; }
        tabId = created.id;
        await waitForTabComplete(tabId);
      }
      await retargetStudio({ tabId, siteKey: site.origin, view: "editor", startPicker: false });
    } finally {
      if (button) button.disabled = false;
    }
  }

  function waitForTabComplete(tabId, timeoutMs = 20000) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { chrome.tabs.onUpdated.removeListener(listener); } catch (_) {}
        resolve();
      };
      const listener = (id, info) => { if (id === tabId && info.status === "complete") finish(); };
      const timer = setTimeout(finish, timeoutMs);
      chrome.tabs.onUpdated.addListener(listener);
      chrome.tabs.get(tabId, (tab) => { if (tab && tab.status === "complete") finish(); });
    });
  }

  // Re-point this single Studio at another website tab without opening a new Studio.
  async function retargetStudio({ tabId, siteKey, view, startPicker }) {
    const nextKey = siteKey ? normalizeOrigin(siteKey) : targetSiteKey;
    const changingSite = nextKey !== normalizeOrigin(targetSiteKey) || (Number.isInteger(tabId) && tabId !== targetTabId);
    if (changingSite && !(await confirmLeaveCurrentSite())) return false;
    if (changingSite) {
      targetTabId = Number.isInteger(tabId) ? tabId : targetTabId;
      targetSiteKey = nextKey;
      targetHostname = ChameleonStorageService.deriveSiteIdentity(targetSiteKey).hostname;
      undoStack.length = 0;
      selectedCompId = "root_page";
      const overview = await sendRuntimeMessage({ type: "CHAMELEON_GET_OVERVIEW", siteKey: targetSiteKey, hostname: targetHostname });
      if (overview && overview.ok) {
        const foundConfig = overview.exactSiteConfig || overview.hostnameConfig;
        if (foundConfig) {
          savedSiteConfig = deepClone(foundConfig);
          workingSiteConfig = deepClone(foundConfig);
        } else {
          savedSiteConfig = { siteKey: targetSiteKey, hostname: targetHostname, matchScope: "origin", enabled: true, revision: 0, components: {} };
          workingSiteConfig = deepClone(savedSiteConfig);
        }
      }
      await syncWithTargetTab();
      pendingConflictRemoteConfig = null;
      try {
        const u = new URL(window.location.href);
        if (targetTabId) u.searchParams.set("tabId", String(targetTabId));
        else u.searchParams.delete("tabId");
        if (targetSiteKey) u.searchParams.set("siteKey", targetSiteKey);
        u.searchParams.set("view", view || "editor");
        u.searchParams.delete("startPicker");
        window.history.replaceState(null, "", u.href);
      } catch (_) {}
    }
    switchStudioView(view || "editor");
    renderAllPanels();
    refreshSiteSwitcher().catch(() => {});
    if (startPicker) {
      // The Studio is usually in the background here; keep the website in front.
      await startLivePickerFromStudio({ focusTarget: false });
    }
    return true;
  }

  async function refreshSiteSwitcher() {
    const select = document.getElementById("siteSwitcher");
    if (!select) return;
    const res = await sendRuntimeMessage({ type: "CHAMELEON_LIST_OPEN_SITES" });
    const sites = res && res.ok && Array.isArray(res.sites) ? res.sites.filter((s) => s.allowed) : [];
    select.replaceChildren();
    if (sites.length < 2) { select.hidden = true; return; }
    for (const site of sites) {
      const opt = document.createElement("option");
      opt.value = String(site.tabId);
      opt.dataset.origin = site.origin;
      opt.textContent = `${site.hostname}${site.title ? ` — ${site.title.slice(0, 40)}` : ""}`;
      if (site.tabId === targetTabId) opt.selected = true;
      select.appendChild(opt);
    }
    select.hidden = false;
  }

  function syncSettingsControls() {
    const globalEnabled = document.getElementById("setGlobalEnabled");
    if (globalEnabled) globalEnabled.checked = globalSettings.extensionEnabled !== false;
    document.getElementById("chkConvertToWebP").checked = Boolean(globalSettings.autoConvertWebP);
    document.getElementById("chkPreserveOriginal").checked = globalSettings.preserveOriginalOnConvert !== false;
    document.getElementById("setEcoMode").checked = globalSettings.ecoMode !== false;
    document.getElementById("setMaxVideos").value = String(globalSettings.maxConcurrentVideos || 2);
    document.getElementById("setMaxDimension").value = String(globalSettings.maxImageDimension || 2560);
    const maxMB = Math.round((Number(globalSettings.maxMediaSizeBytes) || 50 * 1024 * 1024) / (1024 * 1024));
    const maxMbSelect = document.getElementById("setMaxMediaSizeMB");
    if (maxMbSelect) maxMbSelect.value = String([15, 50, 100, 200].includes(maxMB) ? maxMB : 50);
    syncGlobalVideoPauseButton();
  }

  function syncGlobalVideoPauseButton() {
    const button = document.getElementById("btnPauseBackgroundVideos");
    if (!button) return;
    const paused = globalSettings.pauseAllBackgroundVideos === true;
    button.textContent = paused ? "Resume videos" : "Pause videos";
    button.setAttribute("aria-pressed", String(paused));
    button.title = paused ? "Resume ChameleonBG background videos in authorized tabs" : "Pause all ChameleonBG background videos in open authorized tabs";
  }

  async function startLivePickerFromStudio(options = {}) {
    const focusTarget = options.focusTarget !== false;
    const button = document.getElementById("btnTriggerLivePicker");
    const originalLabel = button ? button.textContent : "Select on Live Website";
    if (!targetTabId) {
      showAlert("No website tab is connected. Open ChameleonBG from the website's toolbar popup and launch the editor again.", true);
      return false;
    }
    if (button) {
      button.disabled = true;
      button.textContent = "Starting selector…";
    }
    try {
      const capability = await sendRuntimeMessage({
        type: "CHAMELEON_CHECK_TAB_CAPABILITY",
        tabId: targetTabId
      });
      if (!capability?.ok || !capability.supported) {
        showAlert(capability?.reason || capability?.error || "This page cannot be selected by ChameleonBG.", true);
        return false;
      }
      if (!capability.runtimeEnabled || !capability.pageAgentReady) {
        showAlert(capability.injectionError || "ChameleonBG is not active on this site. Re-enable site access in the toolbar popup, then try again.", true);
        return false;
      }
      const pickerResult = await sendTabMessage(targetTabId, { type: "CHAMELEON_START_LIVE_PICKER" });
      if (!pickerResult?.ok || pickerResult.pickerActive !== true) {
        showAlert(pickerResult?.error || "The page did not confirm that the selector started. Reload the website and try again.", true);
        return false;
      }
      if (focusTarget && chrome.tabs && chrome.tabs.update) {
        await chrome.tabs.update(targetTabId, { active: true });
      }
      return true;
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalLabel;
      }
    }
  }

  function bindDataLifecycleEvents() {
    document.getElementById("btnExportSettingsOnly")?.addEventListener("click", async () => {
      try {
        const res = await sendRuntimeMessage({ type: "CHAMELEON_EXPORT_BACKUP", includeBlobs: false });
        if (!res?.ok || !res.backup) throw new Error(res?.error || "Export failed.");
        const jsonText = JSON.stringify(res.backup, null, 2);
        const blob = new Blob([jsonText], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chameleonbg-settings-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showAlert("Settings backup exported successfully.");
      } catch (err) {
        showAlert(`Could not export settings: ${err?.message || err}`, true);
      }
    });

    document.getElementById("btnExportFullBackup")?.addEventListener("click", async () => {
      try {
        showAlert("Preparing full backup with media... this may take a moment.");
        const res = await sendRuntimeMessage({ type: "CHAMELEON_EXPORT_BACKUP", includeBlobs: true });
        if (!res?.ok || !res.backup) throw new Error(res?.error || "Export failed.");
        const jsonText = JSON.stringify(res.backup, null, 2);
        const blob = new Blob([jsonText], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `chameleonbg-full-backup-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showAlert("Full backup with media exported successfully.");
      } catch (err) {
        showAlert(`Could not export full backup: ${err?.message || err}`, true);
      }
    });

    const fileInput = document.getElementById("fileInputBackup");
    const preflightBox = document.getElementById("importPreflightBox");
    const summaryText = document.getElementById("importPreflightSummary");

    fileInput?.addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        const validation = ChameleonStorageService.validateBackupPayload(parsed);
        if (!validation.valid) {
          showAlert(validation.error, true);
          fileInput.value = "";
          return;
        }
        pendingImportPayload = parsed;
        summaryText.textContent = `Backup (${validation.type}, schema v${validation.version}): contains ${validation.siteConfigCount} website configs, ${validation.domainThemeCount} domain themes, and ${validation.mediaBlobCount} media items.`;
        preflightBox.hidden = false;
      } catch (err) {
        showAlert(`Invalid backup file: ${err?.message || err}`, true);
        fileInput.value = "";
      }
    });

    document.getElementById("btnCancelImport")?.addEventListener("click", () => {
      pendingImportPayload = null;
      if (fileInput) fileInput.value = "";
      if (preflightBox) preflightBox.hidden = true;
    });

    document.getElementById("btnConfirmImport")?.addEventListener("click", async () => {
      if (!pendingImportPayload) return;
      const mode = document.getElementById("importModeReplace")?.checked ? "replace" : "merge";
      try {
        const res = await sendRuntimeMessage({
          type: "CHAMELEON_IMPORT_BACKUP",
          backup: pendingImportPayload,
          mode
        });
        if (!res?.ok) throw new Error(res?.error || "Import failed.");
        showAlert(`Backup successfully imported (${res.sitesImported} sites, ${res.themesImported} themes, ${res.blobsImported} media items).`);
        pendingImportPayload = null;
        if (fileInput) fileInput.value = "";
        if (preflightBox) preflightBox.hidden = true;
        await renderWebsitesView();
        await renderMediaLibraryGrids();
      } catch (err) {
        showAlert(`Import failed: ${err?.message || err}`, true);
      }
    });

    document.getElementById("btnClearAllData")?.addEventListener("click", async () => {
      const confirm1 = window.confirm("Are you sure you want to permanently clear ALL ChameleonBG data, including website customizations, domain themes, and media?");
      if (!confirm1) return;
      const confirm2 = window.confirm("This CANNOT be undone. All your saved ChameleonBG settings and media will be erased. Proceed?");
      if (!confirm2) return;

      try {
        const res = await sendRuntimeMessage({ type: "CHAMELEON_CLEAR_ALL_DATA", confirmed: true });
        if (!res?.ok) throw new Error(res?.error || "Clear failed.");
        showAlert("All ChameleonBG data has been cleared.");
        savedSiteConfig = { siteKey: targetSiteKey, hostname: targetHostname, matchScope: "origin", enabled: true, revision: 0, components: {} };
        workingSiteConfig = deepClone(savedSiteConfig);
        undoStack.length = 0;
        await renderWebsitesView();
        await renderMediaLibraryGrids();
        renderAllPanels();
      } catch (err) {
        showAlert(`Could not clear data: ${err?.message || err}`, true);
      }
    });

    document.getElementById("btnNewDomainTheme")?.addEventListener("click", () => openThemeModal());
    document.getElementById("btnCloseThemeModal")?.addEventListener("click", closeThemeModal);
    document.getElementById("btnCancelThemeModal")?.addEventListener("click", closeThemeModal);
    document.getElementById("themeModalForm")?.addEventListener("submit", handleThemeModalSubmit);

    document.getElementById("themeSliderOpacity")?.addEventListener("input", (e) => {
      const el = document.getElementById("themeOpacityValue");
      if (el) el.textContent = `${e.target.value}%`;
    });
    document.getElementById("themeSliderBlur")?.addEventListener("input", (e) => {
      const el = document.getElementById("themeBlurValue");
      if (el) el.textContent = `${e.target.value}px`;
    });
    document.getElementById("themeSliderVolume")?.addEventListener("input", (e) => {
      const el = document.getElementById("themeVolumeValue");
      if (el) el.textContent = `${e.target.value}%`;
    });
  }

  function bindAllEvents() {
    bindDataLifecycleEvents();
    document.querySelectorAll(".nav-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        switchStudioView(btn.dataset.view);
        renderMediaLibraryGrids();
      });
    });

    setupSettingsNavigation();
    document.getElementById("btnOpenEditorMediaPicker")?.addEventListener("click", openEditorMediaPicker);
    document.getElementById("btnOpenFullMediaLibrary")?.addEventListener("click", () => switchStudioView("library"));
    document.getElementById("btnCloseEditorMediaPicker")?.addEventListener("click", closeEditorMediaPicker);
    document.getElementById("btnCancelEditorMediaPicker")?.addEventListener("click", closeEditorMediaPicker);
    document.getElementById("btnConfirmEditorMediaPicker")?.addEventListener("click", () => commitEditorMediaPickerSelection().catch((err) => showAlert(`Could not assign the selected media: ${err?.message || err}`, true)));
    document.getElementById("pickerAssignmentMode")?.addEventListener("change", (event) => changePickerAssignmentMode(event.target.value));
    const pickerDialog = document.getElementById("editorMediaPickerDialog");
    if (pickerDialog) {
      pickerDialog.addEventListener("close", () => {
        pickerSelectedMediaIds.clear();
        renderMediaLibraryGrids();
      });
      pickerDialog.addEventListener("click", (event) => {
        if (event.target === pickerDialog) closeEditorMediaPicker();
      });
      pickerDialog.addEventListener("keydown", (event) => {
        if ((event.key === "Enter" || event.key === " ") && event.target.closest(".media-item-card")) {
          event.preventDefault();
          const card = event.target.closest(".media-item-card");
          if (card?.dataset.mediaId) togglePickerMediaSelection(card.dataset.mediaId);
        }
      });
      pickerDialog.addEventListener("cancel", () => {
        pickerSelectedMediaIds.clear();
        renderMediaLibraryGrids();
      });
    }

    document.getElementById("btnDismissAlert").addEventListener("click", () => {
      document.getElementById("globalAlertBanner").hidden = true;
    });

    document.getElementById("btnForceOverwriteConflict").addEventListener("click", async () => {
      await saveWorkingConfig(true);
    });

    document.getElementById("btnReloadConflictState").addEventListener("click", () => {
      if (pendingConflictRemoteConfig) {
        savedSiteConfig = deepClone(pendingConflictRemoteConfig);
        workingSiteConfig = deepClone(pendingConflictRemoteConfig);
        pendingConflictRemoteConfig = null;
      }
      document.getElementById("globalAlertBanner").hidden = true;
      renderAllPanels();
    });

    const debounce = (fn, delayMs = 200) => {
      let timer = null;
      return (...args) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          fn(...args);
        }, delayMs);
      };
    };

    const debouncedAreaSearch = debounce(renderLeftAreasPanel, 180);
    const debouncedMediaSearch = debounce(renderMediaLibraryGrids, 200);

    document.getElementById("areaSearchInput").addEventListener("input", debouncedAreaSearch);
    ["mediaSearchInput", "mediaTypeFilter", "mediaSortSelect", "librarySearchInput", "libraryMediaTypeFilter", "libraryMediaSortSelect"]
      .forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (el.tagName === "INPUT") {
          el.addEventListener("input", debouncedMediaSearch);
        } else {
          el.addEventListener("change", renderMediaLibraryGrids);
        }
      });

    document.getElementById("btnRefreshDomScan").addEventListener("click", async () => {
      await syncWithTargetTab();
      renderAllPanels();
    });

    document.getElementById("btnTriggerLivePicker").addEventListener("click", async () => {
      try {
        await startLivePickerFromStudio();
      } catch (err) {
        if (studioTabId && chrome.tabs?.update) {
          try { await chrome.tabs.update(studioTabId, { active: true }); } catch (_) {}
        }
        showAlert(`Could not start the live selector: ${err?.message || err}`, true);
      }
    });

    const handleMediaInputChange = async (e) => {
      const files = Array.from(e.target.files || []);
      if (files.length) await handleFilesImport(files);
      e.target.value = "";
    };
    ["studioFileInput", "libraryFileInput"].forEach((id) => {
      const fileInput = document.getElementById(id);
      if (fileInput) fileInput.addEventListener("change", handleMediaInputChange);
    });

    document.getElementById("btnStudioUndo").addEventListener("click", async () => {
      if (undoStack.length === 0) return;
      redoStack.push(deepClone(workingSiteConfig));
      if (redoStack.length > MAX_HISTORY_STEPS) redoStack.shift();
      workingSiteConfig = undoStack.pop();
      await pushLivePreviewToTab(false);
      renderAllPanels();
    });

    document.getElementById("btnStudioRedo")?.addEventListener("click", async () => {
      if (redoStack.length === 0) return;
      undoStack.push(deepClone(workingSiteConfig));
      if (undoStack.length > MAX_HISTORY_STEPS) undoStack.shift();
      workingSiteConfig = redoStack.pop();
      await pushLivePreviewToTab(false);
      renderAllPanels();
    });

    document.getElementById("chkStudioAutoSave")?.addEventListener("change", async (event) => {
      studioAutoSaveEnabled = Boolean(event.target.checked);
      updateTopbarDraftControls();
      if (studioAutoSaveEnabled && hasUnsavedPreviewChanges()) {
        await saveWorkingConfig(true, { silentAutoSave: true });
      }
    });

    document.getElementById("btnSaveSiteAsTheme")?.addEventListener("click", () => {
      openSaveCurrentSiteAsThemeModal();
    });

    document.getElementById("btnStudioDiscard").addEventListener("click", async () => {
      workingSiteConfig = deepClone(savedSiteConfig);
      undoStack.length = 0;
      redoStack.length = 0;
      if (targetTabId) {
        const res = await sendTabMessage(targetTabId, { type: "CHAMELEON_DISCARD_DRAFT_CONFIG" });
        if (res?.diagnostics) {
          latestDiagnostics = res.diagnostics;
        }
      }
      renderAllPanels();
    });

    document.getElementById("btnStudioSave").addEventListener("click", async () => {
      await saveWorkingConfig(false);
    });

    document.getElementById("siteSwitcher")?.addEventListener("change", async (event) => {
      const select = event.target;
      const option = select.selectedOptions && select.selectedOptions[0];
      if (!option) return;
      const ok = await retargetStudio({ tabId: Number(select.value), siteKey: option.dataset.origin, view: "editor", startPicker: false });
      if (ok === false) refreshSiteSwitcher().catch(() => {}); // user cancelled: restore selection
    });

    document.getElementById("btnPauseBackgroundVideos")?.addEventListener("click", async () => {
      const nextPaused = globalSettings.pauseAllBackgroundVideos !== true;
      globalSettings.pauseAllBackgroundVideos = nextPaused;
      syncGlobalVideoPauseButton();
      const result = await sendRuntimeMessage({ type: "CHAMELEON_SAVE_GLOBAL_SETTINGS", globalSettings });
      if (!result?.ok && !result?.globalSettings) {
        globalSettings.pauseAllBackgroundVideos = !nextPaused;
        syncGlobalVideoPauseButton();
        showAlert(result?.error || "Could not update video playback. Try again.", true);
        return;
      }
      globalSettings = { ...globalSettings, ...(result.globalSettings || {}) };
      syncGlobalVideoPauseButton();
      renderCenterLayoutMap(); // Keep per-component actions consistent with global pause state.
    });

    let studioSliderRaf = null;
    const scheduleSliderPreviewSync = () => {
      if (studioSliderRaf) return;
      studioSliderRaf = requestAnimationFrame(() => {
        studioSliderRaf = null;
        pushLivePreviewToTab(false);
        renderCenterLayoutMap();
        updateTopbarDraftControls();
      });
    };

    const videoVolumeSlider = document.getElementById("sliderVideoVolume");
    videoVolumeSlider?.addEventListener("pointerdown", () => pushUndoState());
    videoVolumeSlider?.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) pushUndoState();
    });
    videoVolumeSlider?.addEventListener("input", (event) => {
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      if (!comp) return;
      const value = Math.max(0, Math.min(100, Number(event.target.value) || 0));
      document.getElementById("valVideoVolume").textContent = `${value}%`;
      ensureComponentInWorkingConfig(comp).videoVolume = value;
      scheduleSliderPreviewSync();
    });

    document.getElementById("btnResetSelectedArea").addEventListener("click", async () => {
      pushUndoState();
      if (workingSiteConfig.components && workingSiteConfig.components[selectedCompId]) {
        delete workingSiteConfig.components[selectedCompId];
      }
      await pushLivePreviewToTab(false);
      renderAllPanels();
    });

    document.getElementById("btnResetEntireSite").addEventListener("click", async () => {
      pushUndoState();
      workingSiteConfig = {
        ...workingSiteConfig,
        enabled: true,
        components: {}
      };
      await pushLivePreviewToTab(false);
      renderAllPanels();
    });

    const sliderDefs = [
      ["sliderOpacity", "valOpacity", "opacity", "%"],
      ["sliderBrightness", "valBrightness", "brightness", "%"],
      ["sliderContrast", "valContrast", "contrast", "%"],
      ["sliderSaturation", "valSaturation", "saturation", "%"],
      ["sliderBlur", "valBlur", "blur", " px"],
      ["sliderDimmer", "valDimmer", "tintOpacity", "%"],
      ["sliderBackdropBlur", "valBackdropBlur", "backdropBlurPx", " px"]
    ];

    for (const [id, valId, prop, unit] of sliderDefs) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.addEventListener("mousedown", () => pushUndoState());
      el.addEventListener("keydown", (e) => {
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          pushUndoState();
        }
      });
      el.addEventListener("input", (e) => {
        const val = Number(e.target.value);
        document.getElementById(valId).textContent = `${val}${unit}`;
        const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
        const cfg = ensureComponentInWorkingConfig(comp);
        cfg[prop] = val;
        scheduleSliderPreviewSync();
      });
    }

    const updateVideoLoopTrim = async () => {
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      if (!comp) return;
      pushUndoState();
      const startVal = Math.max(0, Number(document.getElementById("inputVideoLoopStartSec")?.value) || 0);
      const endVal = Math.max(0, Number(document.getElementById("inputVideoLoopEndSec")?.value) || 0);
      const cfg = ensureComponentInWorkingConfig(comp);
      cfg.videoLoopStartSec = Math.round(startVal * 10) / 10;
      cfg.videoLoopEndSec = endVal > startVal + 0.2 ? Math.round(endVal * 10) / 10 : 0;
      await pushLivePreviewToTab(false);
      renderRightInspectorPanel();
      updateTopbarDraftControls();
    };
    ["inputVideoLoopStartSec", "inputVideoLoopEndSec"].forEach((id) => {
      document.getElementById(id)?.addEventListener("change", updateVideoLoopTrim);
    });

    document.getElementById("selectTextContrastMode")?.addEventListener("change", (e) => {
      pushUndoState();
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      const cfg = ensureComponentInWorkingConfig(comp);
      cfg.textContrastMode = e.target.value || "none";
      pushLivePreviewToTab(false);
      updateTopbarDraftControls();
    });

    document.querySelectorAll(".seg-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        pushUndoState();
        const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
        const cfg = ensureComponentInWorkingConfig(comp);
        cfg.fitMode = btn.dataset.fit;
        pushLivePreviewToTab(false);
        renderRightInspectorPanel();
      });
    });

    document.getElementById("selectRotationInterval").addEventListener("change", (e) => {
      pushUndoState();
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      const cfg = ensureComponentInWorkingConfig(comp);
      if (e.target.value === "custom") {
        const current = Number(cfg.rotationIntervalSec || 0);
        const initial = current > 0 ? current : 300;
        document.getElementById("rotationHours").value = String(Math.floor(initial / 3600));
        document.getElementById("rotationMinutes").value = String(Math.floor((initial % 3600) / 60));
        document.getElementById("rotationSeconds").value = String(initial % 60);
        document.getElementById("customRotationControls").hidden = false;
        cfg.rotationIntervalSec = initial;
        cfg.rotationMode = "custom";
      } else {
        cfg.rotationIntervalSec = Number(e.target.value);
        cfg.rotationMode = "preset";
        document.getElementById("customRotationControls").hidden = true;
      }
      pushLivePreviewToTab(false); renderCenterLayoutMap(); renderRightInspectorPanel(); updateTopbarDraftControls();
    });

    const updateCustomRotationInterval = async () => {
      if (document.getElementById("selectRotationInterval").value !== "custom") return;
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      if (!comp) return;
      pushUndoState();
      const hours = Math.max(0, Math.min(999, Number(document.getElementById("rotationHours").value) || 0));
      const minutes = Math.max(0, Math.min(59, Number(document.getElementById("rotationMinutes").value) || 0));
      const seconds = Math.max(0, Math.min(59, Number(document.getElementById("rotationSeconds").value) || 0));
      document.getElementById("rotationHours").value = String(hours);
      document.getElementById("rotationMinutes").value = String(minutes);
      document.getElementById("rotationSeconds").value = String(seconds);
      const cfg = ensureComponentInWorkingConfig(comp);
      cfg.rotationIntervalSec = hours * 3600 + minutes * 60 + seconds;
      cfg.rotationMode = "custom";
      await pushLivePreviewToTab(false); renderCenterLayoutMap(); updateTopbarDraftControls();
    };
    ["rotationHours", "rotationMinutes", "rotationSeconds"].forEach((id) => document.getElementById(id)?.addEventListener("change", updateCustomRotationInterval));

    document.getElementById("chkWaitForVideoEnd")?.addEventListener("change", async (event) => {
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      if (!comp) return;
      pushUndoState();
      ensureComponentInWorkingConfig(comp).rotationWaitForVideoEnd = event.target.checked;
      await pushLivePreviewToTab(false); renderCenterLayoutMap(); renderRightInspectorPanel(); updateTopbarDraftControls();
    });

    document.getElementById("chkShufflePlaylist").addEventListener("change", (e) => {
      pushUndoState();
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      const cfg = ensureComponentInWorkingConfig(comp);
      cfg.shuffle = e.target.checked;
      pushLivePreviewToTab(false);
      updateTopbarDraftControls();
    });

    document.getElementById("selectSiteMatchScope").addEventListener("change", (e) => {
      pushUndoState();
      workingSiteConfig.matchScope = e.target.value || "origin";
      updateTopbarDraftControls();
    });

    document.getElementById("inputTintColor").addEventListener("input", (e) => {
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      const cfg = ensureComponentInWorkingConfig(comp);
      cfg.tintColor = e.target.value;
      pushLivePreviewToTab(false);
    });

    document.getElementById("selectRenderMode").addEventListener("change", (e) => {
      pushUndoState();
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      const cfg = ensureComponentInWorkingConfig(comp);
      cfg.renderModeOverride = e.target.value || null;
      pushLivePreviewToTab(false);
    });

    document.getElementById("chkSoftenWrappers").addEventListener("change", (e) => {
      pushUndoState();
      const comp = detectedComponents.find((c) => c.id === selectedCompId) || detectedComponents[0];
      const cfg = ensureComponentInWorkingConfig(comp);
      cfg.softenOpaqueWrappers = e.target.checked;
      pushLivePreviewToTab(false);
    });

    const saveSettingsChange = async () => {
      const globalEnabled = document.getElementById("setGlobalEnabled");
      if (globalEnabled) globalSettings.extensionEnabled = globalEnabled.checked;
      globalSettings.autoConvertWebP = document.getElementById("chkConvertToWebP").checked;
      globalSettings.preserveOriginalOnConvert = document.getElementById("chkPreserveOriginal").checked;
      globalSettings.ecoMode = document.getElementById("setEcoMode").checked;
      globalSettings.maxConcurrentVideos = Number(document.getElementById("setMaxVideos").value) || 2;
      globalSettings.maxImageDimension = Number(document.getElementById("setMaxDimension").value) || 2560;
      const maxMB = Number(document.getElementById("setMaxMediaSizeMB")?.value) || 50;
      globalSettings.maxMediaSizeBytes = maxMB * 1024 * 1024;
      await sendRuntimeMessage({
        type: "CHAMELEON_SAVE_GLOBAL_SETTINGS",
        globalSettings
      });
    };

    ["setGlobalEnabled", "chkConvertToWebP", "chkPreserveOriginal", "setEcoMode", "setMaxVideos", "setMaxDimension", "setMaxMediaSizeMB"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", saveSettingsChange);
    });

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (undoStack.length > 0) {
          e.preventDefault();
          document.getElementById("btnStudioUndo").click();
        }
      } else if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "z")
      ) {
        if (redoStack.length > 0) {
          e.preventDefault();
          document.getElementById("btnStudioRedo")?.click();
        }
      }
    });

    if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        // Only accept the relay from an extension-owned context. A direct page
        // content-script message is not authoritative for changing studio state.
        if (sender?.tab || sender?.id !== chrome.runtime.id) return;
        if (msg && msg.type === "CHAMELEON_STUDIO_RETARGET") {
          retargetStudio({
            tabId: Number.isInteger(msg.tabId) ? msg.tabId : null,
            siteKey: msg.siteKey || "",
            view: msg.view || "editor",
            startPicker: msg.startPicker === true
          }).then((ok) => sendResponse({ ok: ok !== false }))
            .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
          return true;
        }
        if (!msg || msg.type !== "CHAMELEON_COMPONENT_PICKED_BROADCAST") return;
        if (Number.isInteger(msg.targetTabId) && targetTabId && msg.targetTabId !== targetTabId) return;
        if (msg.siteKey && targetSiteKey && msg.siteKey !== targetSiteKey) return;
        const pickedCompId = typeof msg.compId === "string" ? msg.compId : "";
        switchStudioView("editor");
        (async () => {
          await syncWithTargetTab();
          const resolved = detectedComponents.find((component) => component.id === pickedCompId);
          if (!resolved) {
            showAlert("The area was selected, but it could not be matched to the refreshed page map. Rescan the page and select it again.", true);
            renderAllPanels();
            return;
          }
          selectedCompId = resolved.id;
          renderAllPanels();
          // Make the selected component and its controls immediately visible after
          // confirmation. If this browser does not expose tabs.getCurrent, the page
          // selection still succeeds and the user can return to the existing studio tab.
          if (!studioTabId && chrome.tabs?.getCurrent) {
            try {
              const cur = await new Promise((res) => chrome.tabs.getCurrent(res));
              if (cur && Number.isInteger(cur.id)) studioTabId = cur.id;
            } catch (_) {}
          }
          if (studioTabId && chrome.tabs?.update) {
            try { await chrome.tabs.update(studioTabId, { active: true }); } catch (_) {}
          }
        })().catch((err) => showAlert(`Area selected, but the editor could not refresh: ${err?.message || err}`, true));
      });
    }

    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if (changes.globalSettings && changes.globalSettings.newValue) {
          globalSettings = { ...globalSettings, ...changes.globalSettings.newValue };
          syncGlobalVideoPauseButton();
          renderCenterLayoutMap();
        }
        const siteCfgChanged = Object.keys(changes).some((k) => k.startsWith("siteCfg::") || k.startsWith("siteAccess::") || k.startsWith("theme::"));
        if (siteCfgChanged && currentView === "websites") {
          renderWebsitesView().catch(() => {});
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindAllEvents();
    initializeStudio();
  });
})();
