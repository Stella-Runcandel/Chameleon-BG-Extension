/**
 * ChameleonBG v2.0.9 — Content Script Coordinator (`content.js`)
 *
 * Hardening improvements in v2.0.1:
 * 1. Safe DOM Construction: Eliminates all `innerHTML` usage across the in-page studio dock,
 *    rendering page-derived labels and dimensions strictly via `createElement` and `textContent`.
 * 2. Bounded Chunked Port Media Client: Streams media from `background.js` over `chrome.runtime.connect`
 *    (`"chameleon-media-port"`) in 256 KB slices with sequential `TRANSFER_ACK`, FNV-1a checksum
 *    verification, AbortSignal cancellation, timeout handling, and request coalescing.
 * 3. Origin-Scoped, Conflict-Safe Configuration Sync: Uses canonical origin (`protocol://hostname:port`)
 *    and passes `expectedRevision` + `baseComponents` when saving to detect concurrent tab edits.
 */

/* global ChameleonStorageService, ChameleonSelectionEngine, ChameleonRendererEngine, chrome */
(() => {
  "use strict";

  if (window.__CHAMELEON_BG_V2_LOADED__) return;
  window.__CHAMELEON_BG_V2_LOADED__ = true;

  const PAGE_IDENTITY = ChameleonStorageService.deriveSiteIdentity(window.location);
  const SITE_KEY = PAGE_IDENTITY.originKey;
  const HOSTNAME = PAGE_IDENTITY.hostname;
  const LEGACY_PAGE_DB_NAME = "ChameleonBG_MediaDB";
  let runtimeAuthorized = false;
  let spaListenersBound = false;
  let pageObserverConnected = false;
  let authorizationGeneration = 0;
  let initializationPromise = null;
  let initializationGeneration = -1;

  let savedSiteConfig = {
    siteKey: SITE_KEY,
    hostname: HOSTNAME,
    matchScope: "origin",
    enabled: true,
    revision: 0,
    components: {}
  };
  let draftSiteConfig = null;
  const MAX_DOCK_HISTORY_STEPS = 20;
  const undoStack = [];
  const redoStack = [];
  let dockAutoSaveTimer = null;
  let lastConflictWarning = null;

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

  // Bounded session cache of reconstructed Blobs (avoids redundant port transfers on same page)
  const sessionBlobCache = new Map(); // mediaId -> { record, blob }
  const MAX_SESSION_BLOB_CACHE = 10;
  const inFlightMediaFetches = new Map(); // mediaId -> Promise

  // Shared media port & active transfer table
  let mediaPort = null;
  const pendingPortTransfers = new Map(); // transferId -> { rx, resolve, reject, timeoutId, cleanupSignal }

  // In-page Studio UI state
  let studioHost = null;
  let studioShadow = null;
  let isStudioOpen = false;
  let studioSelectedCompId = "root_page";
  let highlightTimeoutId = null;
  let highlightOverlayEl = null;
  let audioGesturePromptHost = null;

  // =========================================================================
  // 1. MESSAGING & BOUNDED PORT MEDIA TRANSFER CLIENT
  // =========================================================================
  function sendExtensionMessage(payload) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        return resolve({ ok: false, error: "Extension messaging unavailable." });
      }
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: "Empty response from background service." });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function ensureMediaPort() {
    if (mediaPort) return mediaPort;
    if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.connect !== "function") {
      return null;
    }

    try {
      mediaPort = chrome.runtime.connect({ name: "chameleon-media-port" });
    } catch (_) {
      mediaPort = null;
      return null;
    }

    mediaPort.onMessage.addListener((msg) => {
      if (!msg || !msg.transferId) return;
      const entry = pendingPortTransfers.get(msg.transferId);
      if (!entry) return;

      armTransferTimeout(msg.transferId, entry);

      try {
        if (msg.type === "TRANSFER_PRESET") {
          cleanupPendingTransfer(msg.transferId);
          entry.resolve({ found: true, record: msg.record, blob: null });
        } else if (msg.type === "TRANSFER_INIT") {
          entry.rx = ChameleonStorageService.createBoundedBlobReceiverSession(msg, {
            maxMediaSizeBytes: globalSettings.maxMediaSizeBytes
          });
        } else if (msg.type === "TRANSFER_CHUNK") {
          if (!entry.rx) {
            throw new Error("Received TRANSFER_CHUNK before TRANSFER_INIT.");
          }
          const ack = entry.rx.acceptChunkPacket(msg);
          mediaPort.postMessage({
            type: "TRANSFER_ACK",
            transferId: msg.transferId,
            chunkIndex: ack.acknowledgedChunkIndex
          });
        } else if (msg.type === "TRANSFER_COMPLETE") {
          if (!entry.rx) {
            throw new Error("Received TRANSFER_COMPLETE without receiver session.");
          }
          const result = entry.rx.finalize(msg.checksum);
          cleanupPendingTransfer(msg.transferId);
          entry.resolve({
            found: true,
            record: result.record,
            blob: result.blob,
            totalBytes: result.totalBytes,
            checksum: result.checksum
          });
        } else if (msg.type === "TRANSFER_CANCELLED") {
          cleanupPendingTransfer(msg.transferId);
          entry.reject(new Error("Media transfer cancelled."));
        } else if (msg.type === "TRANSFER_ERROR") {
          cleanupPendingTransfer(msg.transferId);
          if (msg.code === "NOT_FOUND") {
            entry.resolve({ found: false, error: msg.error });
          } else {
            entry.reject(new Error(msg.error || "Media transfer error."));
          }
        }
      } catch (err) {
        try {
          mediaPort.postMessage({ type: "TRANSFER_CANCEL", transferId: msg.transferId });
        } catch (_) {}
        cleanupPendingTransfer(msg.transferId);
        entry.reject(err);
      }
    });

    mediaPort.onDisconnect.addListener(() => {
      mediaPort = null;
      for (const [txId, entry] of Array.from(pendingPortTransfers.entries())) {
        cleanupPendingTransfer(txId);
        entry.reject(new Error("Extension media port disconnected."));
      }
    });

    return mediaPort;
  }

  function armTransferTimeout(transferId, entry) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    entry.timeoutId = setTimeout(() => {
      try {
        if (mediaPort) mediaPort.postMessage({ type: "TRANSFER_CANCEL", transferId });
      } catch (_) {}
      cleanupPendingTransfer(transferId);
      entry.reject(new Error(`Media transfer ${transferId} timed out.`));
    }, ChameleonStorageService.DEFAULT_TRANSFER_TIMEOUT_MS);
  }

  function cleanupPendingTransfer(transferId) {
    const entry = pendingPortTransfers.get(transferId);
    if (!entry) return;
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    if (entry.rx && !entry.rx.isDisposed()) {
      entry.rx.dispose();
    }
    if (entry.cleanupSignal) {
      entry.cleanupSignal();
    }
    pendingPortTransfers.delete(transferId);
  }

  async function fetchMediaFromExtension(mediaId, abortSignal = null) {
    if (!mediaId) return { found: false };
    if (abortSignal && abortSignal.aborted) {
      throw new Error("Media request aborted before start.");
    }

    if (sessionBlobCache.has(mediaId)) {
      return { found: true, ...sessionBlobCache.get(mediaId) };
    }

    // Coalesce concurrent requests for the same mediaId unless individual cancellation is required
    if (!abortSignal && inFlightMediaFetches.has(mediaId)) {
      return inFlightMediaFetches.get(mediaId);
    }

    const port = ensureMediaPort();
    if (!port) {
      return { found: false, error: "Media transfer port unavailable." };
    }

    const transferId = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

    const transferPromise = new Promise((resolve, reject) => {
      const entry = {
        rx: null,
        resolve,
        reject,
        timeoutId: null,
        cleanupSignal: null
      };

      if (abortSignal) {
        const onAbort = () => {
          try {
            if (mediaPort) mediaPort.postMessage({ type: "TRANSFER_CANCEL", transferId });
          } catch (_) {}
          cleanupPendingTransfer(transferId);
          reject(new Error("Media transfer cancelled by caller."));
        };
        abortSignal.addEventListener("abort", onAbort, { once: true });
        entry.cleanupSignal = () => abortSignal.removeEventListener("abort", onAbort);
      }

      pendingPortTransfers.set(transferId, entry);
      armTransferTimeout(transferId, entry);

      try {
        port.postMessage({
          type: "TRANSFER_REQUEST",
          transferId,
          mediaId,
          chunkSizeBytes: ChameleonStorageService.DEFAULT_CHUNK_SIZE_BYTES
        });
      } catch (err) {
        cleanupPendingTransfer(transferId);
        reject(err);
      }
    }).then((result) => {
      if (result && result.found && (result.record || result.blob)) {
        if (sessionBlobCache.size >= MAX_SESSION_BLOB_CACHE) {
          const oldestKey = sessionBlobCache.keys().next().value;
          sessionBlobCache.delete(oldestKey);
        }
        sessionBlobCache.set(mediaId, { record: result.record, blob: result.blob });
      }
      return result;
    }).finally(() => {
      inFlightMediaFetches.delete(mediaId);
    });

    if (!abortSignal) {
      inFlightMediaFetches.set(mediaId, transferPromise);
    }
    return transferPromise;
  }

  /**
   * Idempotent, per-origin migration of v1.x page-origin IndexedDB media.
   * The completion marker lives in extension storage, not in the host page. A failed
   * transfer remains retryable; already-imported media IDs are acknowledged by the
   * service worker, so rerunning a partial migration does not replace existing media.
   */
  async function markLegacyPageMigration(status, details = {}) {
    return sendExtensionMessage({
      type: "CHAMELEON_LEGACY_MEDIA_MIGRATION_MARK",
      status,
      completed: details.completed === true,
      migratedCount: details.migratedCount || 0,
      failedCount: details.failedCount || 0,
      failedIds: details.failedIds || [],
      lastError: details.lastError || null
    });
  }

  async function migrateLegacyPageIndexedDBIfPresent() {
    if (typeof indexedDB === "undefined") return;

    try {
      const statusResponse = await sendExtensionMessage({ type: "CHAMELEON_LEGACY_MEDIA_MIGRATION_STATUS" });
      if (statusResponse && statusResponse.ok && statusResponse.completed) return;

      if (typeof indexedDB.databases === "function") {
        let dbs;
        try {
          dbs = await indexedDB.databases();
        } catch (err) {
          await markLegacyPageMigration("retryable-failure", { lastError: `Could not enumerate legacy databases: ${err.message}` });
          return;
        }

        const hasLegacy = dbs.some((d) => d && d.name === LEGACY_PAGE_DB_NAME);
        if (!hasLegacy) {
          await markLegacyPageMigration("no-legacy-db", { completed: true });
          return;
        }
      }

      const db = await new Promise((resolve, reject) => {
        // Do not specify a version: opening at version 1 can cause a VersionError if a
        // legacy database was created with a higher schema version.
        const req = indexedDB.open(LEGACY_PAGE_DB_NAME);
        let newlyCreated = false;
        req.onupgradeneeded = () => { newlyCreated = true; };
        req.onsuccess = () => {
          const openedDb = req.result;
          if (newlyCreated) {
            openedDb.close();
            try { indexedDB.deleteDatabase(LEGACY_PAGE_DB_NAME); } catch (_) {}
            resolve(null);
          } else {
            resolve(openedDb);
          }
        };
        req.onerror = () => reject(req.error || new Error("Could not open the legacy media database."));
        req.onblocked = () => reject(new Error("Legacy media database is blocked by another open connection."));
      });

      if (!db) {
        await markLegacyPageMigration("no-legacy-db", { completed: true });
        return;
      }

      if (!db.objectStoreNames.contains("mediaBlobs")) {
        db.close();
        await markLegacyPageMigration("no-legacy-store", { completed: true });
        return;
      }

      let legacyRecords;
      try {
        legacyRecords = await new Promise((resolve, reject) => {
          const tx = db.transaction("mediaBlobs", "readonly");
          const req = tx.objectStore("mediaBlobs").getAll();
          let records = [];
          req.onsuccess = () => { records = req.result || []; };
          req.onerror = () => reject(req.error || new Error("Could not read legacy media records."));
          tx.oncomplete = () => resolve(records);
          tx.onerror = () => reject(tx.error || new Error("Legacy media read transaction failed."));
          tx.onabort = () => reject(tx.error || new Error("Legacy media read transaction aborted."));
        });
      } finally {
        db.close();
      }

      if (!legacyRecords.length) {
        await markLegacyPageMigration("no-legacy-records", { completed: true });
        return;
      }

      let migratedCount = 0;
      const failedIds = [];
      for (const rec of legacyRecords) {
        if (!rec || !rec.blob || !rec.id) {
          failedIds.push(String(rec?.id || "<invalid-record>"));
          continue;
        }
        const uploaded = await uploadBlobViaChunkedPort(rec);
        if (uploaded) migratedCount++;
        else failedIds.push(String(rec.id));
      }

      const completed = failedIds.length === 0;
      if (completed) {
        try {
          indexedDB.deleteDatabase(LEGACY_PAGE_DB_NAME);
        } catch (_) {}
      }
      await markLegacyPageMigration(completed ? "complete" : "retryable-failure", {
        completed,
        migratedCount,
        failedCount: failedIds.length,
        failedIds: failedIds.slice(0, 100),
        lastError: completed ? null : "Some legacy records could not be migrated; the migration will be retried on a later visit."
      });
    } catch (err) {
      try {
        await markLegacyPageMigration("retryable-failure", { lastError: err && err.message ? err.message : String(err) });
      } catch (_) {}
    }
  }

  function uploadBlobViaChunkedPort(rec) {
    return new Promise((resolve) => {
      const port = ensureMediaPort();
      if (!port) return resolve(false);

      let senderSession;
      try {
        senderSession = ChameleonStorageService.createBoundedBlobSenderSession(rec, {
          chunkSizeBytes: ChameleonStorageService.DEFAULT_CHUNK_SIZE_BYTES
        });
      } catch (_) {
        return resolve(false);
      }

      const transferId = senderSession.transferId;
      let lastChecksum = 0x811c9dc5;
      let timeoutId = null;
      let settled = false;

      const cleanup = (cancelTransfer = false) => {
        if (timeoutId) clearTimeout(timeoutId);
        port.onMessage.removeListener(onMsg);
        if (port.onDisconnect && port.onDisconnect.removeListener) {
          port.onDisconnect.removeListener(onDisconnect);
        }
        if (cancelTransfer) {
          try { port.postMessage({ type: "UPLOAD_CANCEL", transferId }); } catch (_) {}
        }
      };
      const finish = (success) => {
        if (settled) return;
        settled = true;
        if (!success && senderSession && typeof senderSession.cancel === "function") {
          try { senderSession.cancel(); } catch (_) {}
        }
        cleanup(!success);
        resolve(Boolean(success));
      };
      const armTimeout = () => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => finish(false), ChameleonStorageService.DEFAULT_TRANSFER_TIMEOUT_MS);
      };
      const onDisconnect = () => finish(false);
      const onMsg = async (msg) => {
        if (!msg || msg.transferId !== transferId || settled) return;
        armTimeout();
        try {
          if (msg.type === "UPLOAD_READY" || (msg.type === "UPLOAD_ACK" && !msg.isComplete)) {
            const pkt = await senderSession.readNextChunkPacket();
            if (pkt) {
              lastChecksum = pkt.checksumSoFar;
              port.postMessage({ type: "UPLOAD_CHUNK", ...pkt });
            } else {
              finish(false);
            }
          } else if (msg.type === "UPLOAD_ACK" && msg.isComplete) {
            port.postMessage({ type: "UPLOAD_FINALIZE", transferId, checksum: lastChecksum });
          } else if (msg.type === "UPLOAD_COMPLETE") {
            finish(true);
          } else if (msg.type === "UPLOAD_ERROR") {
            finish(false);
          }
        } catch (_) {
          finish(false);
        }
      };

      port.onMessage.addListener(onMsg);
      if (port.onDisconnect && port.onDisconnect.addListener) {
        port.onDisconnect.addListener(onDisconnect);
      }
      armTimeout();
      try {
        port.postMessage({
          type: "UPLOAD_INIT",
          transferId,
          metadata: { id: rec.id, name: rec.name || "Migrated Media" },
          mimeType: senderSession.mimeType,
          totalBytes: senderSession.totalBytes,
          totalChunks: senderSession.totalChunks
        });
      } catch (_) {
        finish(false);
      }
    });
  }

  // =========================================================================
  // 2. RENDERER & SELECTION ENGINE INSTANCES
  // =========================================================================
  const renderer = ChameleonRendererEngine.createBackgroundRenderer({
    document,
    window,
    fetchMediaRecord: fetchMediaFromExtension,
    onStatusChange: (diagnostics) => {
      sendExtensionMessage({
        type: "CHAMELEON_UPDATE_BADGE",
        count: diagnostics.activeLayerCount
      });
    }
  });

  const selectionController = ChameleonSelectionEngine.createVisualSelectionController({
    onSelectConfirmed: ({ locator, suitability }) => {
      const activeCfg = getActiveWorkingSiteConfig();
      if (!activeCfg.components) activeCfg.components = {};

      pushUndoSnapshot();
      const compId = locator.id;
      if (!activeCfg.components[compId]) {
        activeCfg.components[compId] = createDefaultComponentCustomization(locator, suitability);
      } else {
        activeCfg.components[compId].locator = locator;
        activeCfg.components[compId].friendlyName = locator.label;
      }

      studioSelectedCompId = compId;
      draftSiteConfig = deepClone(activeCfg);

      sendExtensionMessage({
        type: "CHAMELEON_COMPONENT_PICKED_EVENT",
        siteKey: SITE_KEY,
        hostname: HOSTNAME,
        compId,
        locator,
        suitability
      });
      if (isStudioOpen) {
        refreshInPageStudioDock();
      }
    },
    onCancel: () => {
      if (isStudioOpen) {
        refreshInPageStudioDock();
      }
    }
  });

  function createDefaultComponentCustomization(locator, suitability) {
    return {
      id: locator.id,
      friendlyName: locator.label || "Page Area",
      enabled: true,
      locator,
      renderModeOverride: suitability?.recommendedMode === "mode-c" ? "mode-c" : null,
      playlist: [],
      activeMediaId: null,
      rotationIntervalSec: 0,
      shuffle: false,
      fitMode: "cover",
      opacity: 85,
      brightness: 100,
      contrast: 100,
      saturation: 100,
      blur: 0,
      tintColor: "#0f172a",
      tintOpacity: 20,
      softenOpaqueWrappers: true
    };
  }

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function getActiveWorkingSiteConfig() {
    return draftSiteConfig ? draftSiteConfig : savedSiteConfig;
  }

  function hasUnsavedChanges() {
    if (!draftSiteConfig) return false;
    return JSON.stringify(draftSiteConfig.components) !== JSON.stringify(savedSiteConfig.components) ||
           draftSiteConfig.enabled !== savedSiteConfig.enabled ||
           draftSiteConfig.matchScope !== savedSiteConfig.matchScope;
  }

  function pushUndoSnapshot() {
    const snapshot = deepClone(getActiveWorkingSiteConfig());
    undoStack.push(snapshot);
    if (undoStack.length > MAX_DOCK_HISTORY_STEPS) undoStack.shift();
    redoStack.length = 0;
  }

  function scheduleDockAutoSave() {
    if (dockAutoSaveTimer) clearTimeout(dockAutoSaveTimer);
    dockAutoSaveTimer = setTimeout(async () => {
      dockAutoSaveTimer = null;
      if (!hasUnsavedChanges()) return;
      const toSave = draftSiteConfig ? deepClone(draftSiteConfig) : deepClone(savedSiteConfig);
      const res = await sendExtensionMessage({
        type: "CHAMELEON_SAVE_SITE_CONFIG",
        siteKey: SITE_KEY,
        hostname: HOSTNAME,
        siteConfig: toSave,
        expectedRevision: savedSiteConfig.revision,
        baseComponents: savedSiteConfig.components,
        forceOverwrite: true
      });
      if (res && res.siteConfig) {
        savedSiteConfig = deepClone(res.siteConfig);
      } else {
        savedSiteConfig = toSave;
      }
      draftSiteConfig = null;
      lastConflictWarning = null;
      updateDockDraftStateBanner();
    }, 350);
  }

  async function applyWorkingConfigToPage() {
    const activeCfg = getActiveWorkingSiteConfig();
    return renderer.applySiteCustomizations(activeCfg, globalSettings, ChameleonSelectionEngine);
  }

  // =========================================================================
  // 3. NON-DESTRUCTIVE TEMPORARY COMPONENT HIGHLIGHT
  // =========================================================================
  function flashComponentOutline(compId) {
    const activeCfg = getActiveWorkingSiteConfig();
    let targetEl = null;

    if (compId === "root_page" || compId === "body") {
      targetEl = document.body;
    } else {
      const savedComp = activeCfg.components?.[compId];
      if (savedComp?.locator) {
        const res = ChameleonSelectionEngine.resolveComponentLocator(savedComp.locator, document, window);
        targetEl = res.element;
      }
      if (!targetEl) {
        const disc = ChameleonSelectionEngine.discoverPageComponents(document, window, activeCfg.components);
        const found = disc.components.find((c) => c.id === compId);
        targetEl = found?.element || null;
      }
    }

    if (!targetEl) return;

    if (!highlightOverlayEl) {
      highlightOverlayEl = document.createElement("div");
      highlightOverlayEl.setAttribute("data-chameleon-owned", "true");
      highlightOverlayEl.style.cssText =
        "position:fixed;pointer-events:none;z-index:2147483644;border:2px dashed #38bdf8;background:rgba(14,165,233,0.12);border-radius:6px;transition:all 0.15s ease;";
      document.documentElement.appendChild(highlightOverlayEl);
    }

    const r = targetEl.getBoundingClientRect();
    highlightOverlayEl.style.display = "block";
    highlightOverlayEl.style.left = `${Math.round(r.left)}px`;
    highlightOverlayEl.style.top = `${Math.round(r.top)}px`;
    highlightOverlayEl.style.width = `${Math.round(r.width)}px`;
    highlightOverlayEl.style.height = `${Math.round(r.height)}px`;

    if (highlightTimeoutId) clearTimeout(highlightTimeoutId);
    highlightTimeoutId = setTimeout(() => {
      if (highlightOverlayEl) {
        highlightOverlayEl.remove();
        highlightOverlayEl = null;
      }
    }, 1100);
  }

  // =========================================================================
  // 4. SAFE IN-PAGE STUDIO DOCK (ZERO innerHTML USAGE)
  // =========================================================================
  const DOCK_STYLESHEET_TEXT = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; }
    .dock {
      width: 380px;
      max-height: calc(100vh - 32px);
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid #334155;
      border-radius: 10px;
      box-shadow: 0 20px 40px rgba(2, 6, 23, 0.72);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .dock-header {
      padding: 12px 14px;
      background: #1e293b;
      border-bottom: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .dock-title { font-size: 13px; font-weight: 600; color: #f8fafc; margin: 0; }
    .dock-sub { font-size: 11px; color: #94a3b8; margin: 2px 0 0 0; }
    .header-actions { display: flex; align-items: center; gap: 6px; }
    .btn {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #475569;
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 11.5px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn:hover { background: #334155; }
    .btn:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
    .btn-primary { background: #0284c7; border-color: #38bdf8; color: #fff; }
    .btn-primary:hover { background: #0369a1; }
    .btn-danger { color: #fca5a5; border-color: rgba(248, 113, 113, 0.4); }
    .dock-body {
      padding: 12px 14px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .status-banner {
      padding: 7px 10px;
      border-radius: 6px;
      font-size: 11.5px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: rgba(245, 158, 11, 0.14);
      border: 1px solid rgba(245, 158, 11, 0.4);
      color: #fde68a;
    }
    .status-banner.saved {
      background: rgba(16, 185, 129, 0.12);
      border-color: rgba(16, 185, 129, 0.35);
      color: #a7f3d0;
    }
    .section {
      border: 1px solid #1e293b;
      background: #131c31;
      border-radius: 8px;
      padding: 10px;
    }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
    }
    .section-label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #94a3b8;
    }
    .area-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 135px;
      overflow-y: auto;
    }
    .area-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid transparent;
      background: #0f172a;
      color: #e2e8f0;
      font-size: 12px;
      cursor: pointer;
      text-align: left;
    }
    .area-item:hover { border-color: #475569; }
    .area-item.selected { border-color: #38bdf8; background: rgba(14, 165, 233, 0.15); }
    .control-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      font-size: 11.5px;
    }
    .control-row label { color: #cbd5e1; }
    .control-row input[type="range"] { width: 130px; accent-color: #38bdf8; }
    .val { width: 38px; text-align: right; font-size: 11px; color: #38bdf8; font-variant-numeric: tabular-nums; }
    .dock-footer {
      padding: 10px 14px;
      background: #1e293b;
      border-top: 1px solid #334155;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
    }
  `;

  function closeInPageStudioDock() {
    selectionController.stop();
    if (highlightOverlayEl) {
      highlightOverlayEl.remove();
      highlightOverlayEl = null;
    }
    if (studioHost) {
      studioHost.remove();
      studioHost = null;
      studioShadow = null;
    }
    isStudioOpen = false;
  }

  function createSliderRow(id, valId, labelText, min, max, initialValue, unit) {
    const row = document.createElement("div");
    row.className = "control-row";
    const label = document.createElement("label");
    label.setAttribute("for", id);
    label.textContent = labelText;

    const input = document.createElement("input");
    input.type = "range";
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.value = String(initialValue);

    const valSpan = document.createElement("span");
    valSpan.className = "val";
    valSpan.id = valId;
    valSpan.textContent = `${initialValue}${unit}`;

    row.append(label, input, valSpan);
    return row;
  }

  function mountInPageStudioDock() {
    if (studioHost) {
      refreshInPageStudioDock();
      return;
    }

    studioHost = document.createElement("div");
    studioHost.id = "chameleon-bg-studio-host";
    studioHost.setAttribute("data-chameleon-owned", "true");
    studioHost.style.cssText = "all: initial; position: fixed; top: 16px; right: 16px; z-index: 2147483646;";
    studioShadow = studioHost.attachShadow({ mode: "open" });

    const styleEl = document.createElement("style");
    styleEl.textContent = DOCK_STYLESHEET_TEXT;
    studioShadow.appendChild(styleEl);

    const dock = document.createElement("div");
    dock.className = "dock";
    dock.setAttribute("role", "region");
    dock.setAttribute("aria-label", "ChameleonBG Live Page Inspector");

    // Header
    const header = document.createElement("div");
    header.className = "dock-header";
    const titleWrap = document.createElement("div");
    const titleP = document.createElement("p");
    titleP.className = "dock-title";
    titleP.textContent = "ChameleonBG Inspector";
    const subP = document.createElement("p");
    subP.className = "dock-sub";
    subP.textContent = SITE_KEY;
    titleWrap.append(titleP, subP);

    const headerActions = document.createElement("div");
    headerActions.className = "header-actions";
    const btnOpenFullStudio = document.createElement("button");
    btnOpenFullStudio.type = "button";
    btnOpenFullStudio.className = "btn";
    btnOpenFullStudio.id = "btnOpenFullStudio";
    btnOpenFullStudio.textContent = "Full Studio";
    const btnCloseDock = document.createElement("button");
    btnCloseDock.type = "button";
    btnCloseDock.className = "btn";
    btnCloseDock.id = "btnCloseDock";
    btnCloseDock.textContent = "Close";
    headerActions.append(btnOpenFullStudio, btnCloseDock);
    header.append(titleWrap, headerActions);

    // Body
    const body = document.createElement("div");
    body.className = "dock-body";

    const draftStateBanner = document.createElement("div");
    draftStateBanner.className = "status-banner saved";
    draftStateBanner.id = "draftStateBanner";
    const draftStateText = document.createElement("span");
    draftStateText.id = "draftStateText";
    draftStateText.textContent = "Auto-saved";
    const historyWrap = document.createElement("div");
    historyWrap.style.cssText = "display:inline-flex;gap:4px;";
    const btnUndo = document.createElement("button");
    btnUndo.type = "button";
    btnUndo.className = "btn";
    btnUndo.id = "btnUndo";
    btnUndo.style.cssText = "padding:2px 7px;font-size:10.5px;";
    btnUndo.textContent = "← Back";
    const btnRedo = document.createElement("button");
    btnRedo.type = "button";
    btnRedo.className = "btn";
    btnRedo.id = "btnRedo";
    btnRedo.style.cssText = "padding:2px 7px;font-size:10.5px;";
    btnRedo.textContent = "Forward →";
    historyWrap.append(btnUndo, btnRedo);
    draftStateBanner.append(draftStateText, historyWrap);

    const areaSection = document.createElement("div");
    areaSection.className = "section";
    const areaHead = document.createElement("div");
    areaHead.className = "section-head";
    const areaLabel = document.createElement("span");
    areaLabel.className = "section-label";
    areaLabel.textContent = "Page Areas";
    const btnPickAreaOnPage = document.createElement("button");
    btnPickAreaOnPage.type = "button";
    btnPickAreaOnPage.className = "btn btn-primary";
    btnPickAreaOnPage.id = "btnPickAreaOnPage";
    btnPickAreaOnPage.textContent = "Select Area on Page";
    areaHead.append(areaLabel, btnPickAreaOnPage);
    const dockAreaList = document.createElement("div");
    dockAreaList.className = "area-list";
    dockAreaList.id = "dockAreaList";
    areaSection.append(areaHead, dockAreaList);

    const ctrlSection = document.createElement("div");
    ctrlSection.className = "section";
    const ctrlHead = document.createElement("div");
    ctrlHead.className = "section-head";
    const ctrlLabel = document.createElement("span");
    ctrlLabel.className = "section-label";
    ctrlLabel.textContent = "Appearance Controls";
    const btnResetArea = document.createElement("button");
    btnResetArea.type = "button";
    btnResetArea.className = "btn btn-danger";
    btnResetArea.id = "btnResetArea";
    btnResetArea.style.cssText = "padding:2px 7px;font-size:10.5px;";
    btnResetArea.textContent = "Reset Area";
    ctrlHead.append(ctrlLabel, btnResetArea);

    ctrlSection.append(
      ctrlHead,
      createSliderRow("dockOpacity", "dockOpacityVal", "Opacity", 5, 100, 85, "%"),
      createSliderRow("dockBrightness", "dockBrightnessVal", "Brightness", 25, 180, 100, "%"),
      createSliderRow("dockContrast", "dockContrastVal", "Contrast", 25, 180, 100, "%"),
      createSliderRow("dockBlur", "dockBlurVal", "Blur", 0, 24, 0, "px"),
      createSliderRow("dockDimmer", "dockDimmerVal", "Readability Dimmer", 0, 85, 20, "%")
    );

    body.append(draftStateBanner, areaSection, ctrlSection);

    // Footer
    const footer = document.createElement("div");
    footer.className = "dock-footer";
    const btnDiscardDraft = document.createElement("button");
    btnDiscardDraft.type = "button";
    btnDiscardDraft.className = "btn";
    btnDiscardDraft.id = "btnDiscardDraft";
    btnDiscardDraft.textContent = "Discard Preview";
    const btnSaveDraft = document.createElement("button");
    btnSaveDraft.type = "button";
    btnSaveDraft.className = "btn btn-primary";
    btnSaveDraft.id = "btnSaveDraft";
    btnSaveDraft.textContent = "Save Customization";
    footer.append(btnDiscardDraft, btnSaveDraft);

    dock.append(header, body, footer);
    studioShadow.appendChild(dock);
    document.documentElement.appendChild(studioHost);
    isStudioOpen = true;

    const $ = (id) => studioShadow.getElementById(id);
    btnCloseDock.addEventListener("click", closeInPageStudioDock);
    btnOpenFullStudio.addEventListener("click", () => {
      sendExtensionMessage({
        type: "CHAMELEON_OPEN_FULL_STUDIO",
        siteKey: SITE_KEY,
        hostname: HOSTNAME
      });
    });

    btnPickAreaOnPage.addEventListener("click", () => {
      selectionController.start();
    });

    btnUndo.addEventListener("click", async () => {
      if (undoStack.length === 0) return;
      redoStack.push(deepClone(getActiveWorkingSiteConfig()));
      if (redoStack.length > MAX_DOCK_HISTORY_STEPS) redoStack.shift();
      draftSiteConfig = undoStack.pop();
      await applyWorkingConfigToPage();
      scheduleDockAutoSave();
      refreshInPageStudioDock();
    });

    btnRedo.addEventListener("click", async () => {
      if (redoStack.length === 0) return;
      undoStack.push(deepClone(getActiveWorkingSiteConfig()));
      if (undoStack.length > MAX_DOCK_HISTORY_STEPS) undoStack.shift();
      draftSiteConfig = redoStack.pop();
      await applyWorkingConfigToPage();
      scheduleDockAutoSave();
      refreshInPageStudioDock();
    });

    btnResetArea.addEventListener("click", async () => {
      pushUndoSnapshot();
      const cfg = deepClone(getActiveWorkingSiteConfig());
      if (cfg.components && cfg.components[studioSelectedCompId]) {
        delete cfg.components[studioSelectedCompId];
      }
      draftSiteConfig = cfg;
      await applyWorkingConfigToPage();
      scheduleDockAutoSave();
      refreshInPageStudioDock();
    });

    btnDiscardDraft.addEventListener("click", async () => {
      draftSiteConfig = null;
      undoStack.length = 0;
      redoStack.length = 0;
      lastConflictWarning = null;
      await applyWorkingConfigToPage();
      refreshInPageStudioDock();
    });

    btnSaveDraft.addEventListener("click", async () => {
      const toSave = draftSiteConfig ? deepClone(draftSiteConfig) : deepClone(savedSiteConfig);
      const res = await sendExtensionMessage({
        type: "CHAMELEON_SAVE_SITE_CONFIG",
        siteKey: SITE_KEY,
        hostname: HOSTNAME,
        siteConfig: toSave,
        expectedRevision: savedSiteConfig.revision,
        baseComponents: savedSiteConfig.components
      });

      if (res && res.conflict) {
        lastConflictWarning = res.error || "Conflict detected with another tab.";
        refreshInPageStudioDock();
        return;
      }

      if (res && res.siteConfig) {
        savedSiteConfig = deepClone(res.siteConfig);
      } else {
        savedSiteConfig = toSave;
      }
      draftSiteConfig = null;
      lastConflictWarning = null;
      await applyWorkingConfigToPage();
      refreshInPageStudioDock();
    });

    const sliderBindings = [
      ["dockOpacity", "dockOpacityVal", "opacity", "%"],
      ["dockBrightness", "dockBrightnessVal", "brightness", "%"],
      ["dockContrast", "dockContrastVal", "contrast", "%"],
      ["dockBlur", "dockBlurVal", "blur", "px"],
      ["dockDimmer", "dockDimmerVal", "tintOpacity", "%"]
    ];

    let dockSliderRaf = null;
    for (const [sliderId, valId, prop, unit] of sliderBindings) {
      $(sliderId).addEventListener("change", () => pushUndoSnapshot());
      $(sliderId).addEventListener("input", (e) => {
        const val = Number(e.target.value);
        $(valId).textContent = `${val}${unit}`;
        const cfg = deepClone(getActiveWorkingSiteConfig());
        if (!cfg.components) cfg.components = {};
        if (!cfg.components[studioSelectedCompId]) {
          const disc = ChameleonSelectionEngine.discoverPageComponents(document, window, cfg.components);
          const found = disc.components.find((c) => c.id === studioSelectedCompId) || disc.components[0];
          cfg.components[studioSelectedCompId] = createDefaultComponentCustomization(
            found.locator,
            found.suitability
          );
        }
        cfg.components[studioSelectedCompId][prop] = val;
        draftSiteConfig = cfg;
        updateDockDraftStateBanner();
        scheduleDockAutoSave();
        if (!dockSliderRaf) {
          dockSliderRaf = requestAnimationFrame(async () => {
            dockSliderRaf = null;
            await applyWorkingConfigToPage();
          });
        }
      });
    }

    refreshInPageStudioDock();
  }

  function updateDockDraftStateBanner() {
    if (!studioShadow) return;
    const banner = studioShadow.getElementById("draftStateBanner");
    const text = studioShadow.getElementById("draftStateText");
    const btnUndo = studioShadow.getElementById("btnUndo");
    const btnRedo = studioShadow.getElementById("btnRedo");
    if (btnUndo) btnUndo.disabled = undoStack.length === 0;
    if (btnRedo) btnRedo.disabled = redoStack.length === 0;
    if (lastConflictWarning) {
      banner.classList.remove("saved");
      text.textContent = lastConflictWarning;
      return;
    }
    const unsaved = hasUnsavedChanges();
    banner.classList.toggle("saved", !unsaved);
    text.textContent = unsaved ? "Auto-saving…" : "Auto-saved";
  }

  function refreshInPageStudioDock() {
    if (!studioShadow || !isStudioOpen) return;
    const $ = (id) => studioShadow.getElementById(id);
    const activeCfg = getActiveWorkingSiteConfig();
    const discovery = ChameleonSelectionEngine.discoverPageComponents(document, window, activeCfg.components);
    const areaList = $("dockAreaList");
    areaList.replaceChildren();

    for (const item of discovery.components) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "area-item" + (item.id === studioSelectedCompId ? " selected" : "");
      const compCfg = activeCfg.components?.[item.id];
      const count = compCfg?.playlist?.length || (compCfg?.activeMediaId ? 1 : 0);

      const labelSpan = document.createElement("span");
      labelSpan.textContent = item.label;

      const metaSpan = document.createElement("span");
      metaSpan.style.cssText = "font-size:10.5px;color:#94a3b8;";
      metaSpan.textContent = count > 0 ? `${count} media` : item.dimensionsText;

      btn.append(labelSpan, metaSpan);
      btn.addEventListener("click", () => {
        studioSelectedCompId = item.id;
        flashComponentOutline(item.id);
        refreshInPageStudioDock();
      });
      areaList.appendChild(btn);
    }

    const compCfg = activeCfg.components?.[studioSelectedCompId] || {
      opacity: 85,
      brightness: 100,
      contrast: 100,
      blur: 0,
      tintOpacity: 20
    };

    $("dockOpacity").value = compCfg.opacity ?? 85;
    $("dockOpacityVal").textContent = `${compCfg.opacity ?? 85}%`;
    $("dockBrightness").value = compCfg.brightness ?? 100;
    $("dockBrightnessVal").textContent = `${compCfg.brightness ?? 100}%`;
    $("dockContrast").value = compCfg.contrast ?? 100;
    $("dockContrastVal").textContent = `${compCfg.contrast ?? 100}%`;
    $("dockBlur").value = compCfg.blur ?? 0;
    $("dockBlurVal").textContent = `${compCfg.blur ?? 0}px`;
    $("dockDimmer").value = compCfg.tintOpacity ?? 20;
    $("dockDimmerVal").textContent = `${compCfg.tintOpacity ?? 20}%`;

    updateDockDraftStateBanner();
  }

  // =========================================================================
  // 5. MESSAGE HANDLERS FOR POPUP & FULL 3-PANEL VISUAL STUDIO
  // =========================================================================
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || typeof message.type !== "string") return false;

      handleContentMessage(message)
        .then((res) => sendResponse({ ok: true, ...res }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));

      return true;
    });
  }

  function removeAudioGesturePrompt() {
    if (audioGesturePromptHost) {
      try { audioGesturePromptHost.remove(); } catch (_) {}
    }
    audioGesturePromptHost = null;
  }

  function showAudioGesturePrompt(compId) {
    // Intentionally a clean no-op: ChameleonBG does not inject playback buttons into third-party websites.
    return { shown: false, error: "In-page prompt disabled to preserve third-party website DOM integrity." };
  }

  async function handleContentMessage(message) {
    if (!runtimeAuthorized && !["CHAMELEON_RELOAD_SETTINGS", "CHAMELEON_SITE_ACCESS_DISABLED", "CHAMELEON_SITE_PERMISSION_REVOKED"].includes(message.type)) {
      // A new injection can receive a user action before its first async startup has finished.
      await initializeFromExtensionStorage();
      if (!runtimeAuthorized) return { ok: false, error: "ChameleonBG is not enabled for this site." };
    }

    switch (message.type) {
      case "CHAMELEON_SITE_ACCESS_DISABLED": {
        if (message.origin && message.origin !== window.location.origin) return { ignored: true };
        await deactivatePageRuntime();
        return { deactivated: true };
      }

      case "CHAMELEON_SITE_PERMISSION_REVOKED": {
        const removed = Array.isArray(message.removedOrigins) ? message.removedOrigins : [];
        if (!removed.includes(window.location.origin)) return { ignored: true };
        await deactivatePageRuntime();
        return { deactivated: true, permissionRevoked: true };
      }

      case "CHAMELEON_TOGGLE_STUDIO": {
        if (isStudioOpen && !message.forceOpen) {
          closeInPageStudioDock();
        } else {
          mountInPageStudioDock();
        }
        return { isOpen: isStudioOpen };
      }

      case "CHAMELEON_START_LIVE_PICKER": {
        const pickerActive = selectionController.start() === true;
        return pickerActive
          ? { pickerActive: true }
          : { pickerActive: false, error: "The page selector could not be started." };
      }

      case "CHAMELEON_CANCEL_LIVE_PICKER": {
        selectionController.stop();
        return { pickerActive: false };
      }

      case "CHAMELEON_GET_SITE_STATUS": {
        const activeCfg = getActiveWorkingSiteConfig();
        const discovery = ChameleonSelectionEngine.discoverPageComponents(document, window, activeCfg.components);
        const diagnostics = renderer.getDiagnostics();
        return {
          siteKey: SITE_KEY,
          hostname: HOSTNAME,
          pageTitle: document.title || HOSTNAME,
          savedSiteConfig,
          workingSiteConfig: activeCfg,
          hasUnsavedChanges: hasUnsavedChanges(),
          undoDepth: undoStack.length,
          globalSettings,
          components: discovery.components.map(({ element, ...rest }) => rest),
          frameNotices: discovery.frameNotices,
          diagnostics
        };
      }

      case "CHAMELEON_HIGHLIGHT_COMPONENT": {
        flashComponentOutline(message.compId);
        return { highlighted: message.compId };
      }

      case "CHAMELEON_YIELD_AUDIO_FOCUS": {
        if (renderer && renderer.videoPlaybackManager) {
          renderer.videoPlaybackManager.yieldAudioFocus(message.compId);
        }
        return { ok: true, yielded: true };
      }

      case "CHAMELEON_SHOW_AUDIO_GESTURE_PROMPT": {
        return showAudioGesturePrompt(message.compId);
      }

      case "CHAMELEON_PREVIEW_DRAFT_CONFIG": {
        if (message.recordUndo) {
          pushUndoSnapshot();
        }
        draftSiteConfig = deepClone(message.siteConfig);
        const diagnostics = await applyWorkingConfigToPage();
        if (isStudioOpen) refreshInPageStudioDock();
        return {
          hasUnsavedChanges: hasUnsavedChanges(),
          undoDepth: undoStack.length,
          diagnostics
        };
      }

      case "CHAMELEON_UNDO_DRAFT": {
        if (undoStack.length > 0) {
          draftSiteConfig = undoStack.pop();
          await applyWorkingConfigToPage();
          if (isStudioOpen) refreshInPageStudioDock();
        }
        return {
          workingSiteConfig: getActiveWorkingSiteConfig(),
          hasUnsavedChanges: hasUnsavedChanges(),
          undoDepth: undoStack.length
        };
      }

      case "CHAMELEON_COMMIT_SITE_CONFIG": {
        const toSave = message.siteConfig ? deepClone(message.siteConfig) : (draftSiteConfig ? deepClone(draftSiteConfig) : deepClone(savedSiteConfig));
        const saveRes = await sendExtensionMessage({
          type: "CHAMELEON_SAVE_SITE_CONFIG",
          siteKey: SITE_KEY,
          hostname: HOSTNAME,
          siteConfig: toSave,
          expectedRevision: message.expectedRevision !== undefined ? message.expectedRevision : savedSiteConfig.revision,
          baseComponents: savedSiteConfig.components,
          forceOverwrite: Boolean(message.forceOverwrite)
        });

        if (saveRes && saveRes.conflict) {
          return {
            ok: false,
            conflict: true,
            currentConfig: saveRes.currentConfig,
            error: saveRes.error
          };
        }

        if (saveRes && saveRes.siteConfig) {
          savedSiteConfig = deepClone(saveRes.siteConfig);
        } else {
          savedSiteConfig = toSave;
        }
        draftSiteConfig = null;
        const diagnostics = await applyWorkingConfigToPage();
        if (isStudioOpen) refreshInPageStudioDock();
        return {
          conflict: false,
          savedSiteConfig,
          hasUnsavedChanges: false,
          diagnostics
        };
      }

      case "CHAMELEON_DISCARD_DRAFT_CONFIG": {
        draftSiteConfig = null;
        undoStack.length = 0;
        const diagnostics = await applyWorkingConfigToPage();
        if (isStudioOpen) refreshInPageStudioDock();
        return {
          savedSiteConfig,
          workingSiteConfig: savedSiteConfig,
          hasUnsavedChanges: false,
          diagnostics
        };
      }

      case "CHAMELEON_APPLY_QUICK_PRESET": {
        const compId = message.compId || message.selectorKey || "root_page";
        const presetId = message.presetId;
        pushUndoSnapshot();
        const nextCfg = deepClone(getActiveWorkingSiteConfig());
        if (!nextCfg.components) nextCfg.components = {};
        if (!nextCfg.components[compId]) {
          const locator = ChameleonSelectionEngine.createComponentLocator(document.body, window);
          nextCfg.components[compId] = createDefaultComponentCustomization(
            locator,
            ChameleonSelectionEngine.assessElementSuitability(document.body, window)
          );
        }
        const comp = nextCfg.components[compId];
        if (!Array.isArray(comp.playlist)) comp.playlist = [];
        if (!comp.playlist.includes(presetId)) comp.playlist.push(presetId);
        comp.activeMediaId = presetId;
        comp.enabled = true;

        const saveRes = await sendExtensionMessage({
          type: "CHAMELEON_SAVE_SITE_CONFIG",
          siteKey: SITE_KEY,
          hostname: HOSTNAME,
          siteConfig: nextCfg,
          expectedRevision: savedSiteConfig.revision,
          baseComponents: savedSiteConfig.components
        });

        if (saveRes && saveRes.siteConfig) {
          savedSiteConfig = deepClone(saveRes.siteConfig);
        } else {
          savedSiteConfig = nextCfg;
        }
        draftSiteConfig = null;
        const diagnostics = await applyWorkingConfigToPage();
        return { diagnostics };
      }

      case "CHAMELEON_MEDIA_DELETED": {
        const deletedId = message.mediaId;
        sessionBlobCache.delete(deletedId);
        const pruneInMem = (cfg) => {
          if (!cfg || !cfg.components) return;
          for (const comp of Object.values(cfg.components)) {
            if (!comp || typeof comp !== "object") continue;
            if (Array.isArray(comp.playlist)) {
              comp.playlist = comp.playlist.filter((id) => id !== deletedId);
            }
            if (comp.activeMediaId === deletedId) {
              comp.activeMediaId = (Array.isArray(comp.playlist) && comp.playlist.length > 0) ? comp.playlist[0] : null;
            }
          }
        };
        pruneInMem(savedSiteConfig);
        pruneInMem(draftSiteConfig);
        await applyWorkingConfigToPage();
        return { cleanedMediaId: deletedId };
      }

      case "CHAMELEON_ALARM_TICK": {
        if (document.hidden) {
          await renderer.tickUnifiedPlaylistScheduler(true);
        }
        return { ticked: true };
      }

      case "CHAMELEON_RELOAD_SETTINGS": {
        if (message.siteConfig) {
          savedSiteConfig = deepClone(message.siteConfig);
          draftSiteConfig = null;
        }
        await initializeFromExtensionStorage();
        return { reloaded: true };
      }

      default:
        return { ok: false, error: `Unsupported content message type: ${message.type}` };
    }
  }

  // =========================================================================
  // 6. DYNAMIC WEBSITE / SPA OBSERVATION & INITIALIZATION
  // =========================================================================
  let mutationTimer = null;

  function scheduleDetachedTargetCheck() {
    if (!runtimeAuthorized || mutationTimer) return;
    const activeCfg = getActiveWorkingSiteConfig();
    if (!activeCfg.components || Object.keys(activeCfg.components).length === 0) return;

    mutationTimer = setTimeout(() => {
      mutationTimer = null;
      const activeLayers = renderer.getActiveLayers();
      let needsReapply = false;

      for (const [, layer] of activeLayers.entries()) {
        const ownerDoc = layer.ownerDoc || document;
        if (!ownerDoc.body || !ownerDoc.body.contains(layer.targetEl) || (layer.wrapEl && !layer.targetEl.contains(layer.wrapEl))) {
          needsReapply = true;
          break;
        }
      }

      if (!needsReapply) {
        const configuredIds = Object.keys(activeCfg.components);
        if (configuredIds.length > activeLayers.size) {
          needsReapply = true;
        }
      }

      if (needsReapply) {
        applyWorkingConfigToPage();
      }
    }, 280);
  }

  const domObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target && !ChameleonSelectionEngine.isExtensionOwnedElement(m.target)) {
        if (m.addedNodes.length > 0 || m.removedNodes.length > 0) {
          scheduleDetachedTargetCheck();
          break;
        }
      }
    }
  });

  function setupSpaNavigationListeners() {
    if (runtimeAuthorized && !pageObserverConnected) {
      if (document.body) {
        try {
          domObserver.observe(document.body, { childList: true, subtree: true });
          pageObserverConnected = true;
        } catch (_) {}
      } else {
        document.addEventListener("DOMContentLoaded", () => {
          if (runtimeAuthorized && document.body && !pageObserverConnected) {
            try {
              domObserver.observe(document.body, { childList: true, subtree: true });
              pageObserverConnected = true;
            } catch (_) {}
          }
        }, { once: true });
      }
    }
    if (spaListenersBound) return;
    spaListenersBound = true;
    window.addEventListener("popstate", () => {
      if (runtimeAuthorized) scheduleDetachedTargetCheck();
    });
    window.addEventListener("hashchange", () => {
      if (runtimeAuthorized) scheduleDetachedTargetCheck();
    });
    window.addEventListener("pagehide", () => {
      if (pageObserverConnected) {
        domObserver.disconnect();
        pageObserverConnected = false;
      }
      if (mediaPort) {
        try { mediaPort.disconnect(); } catch (_) {}
        mediaPort = null;
      }
    });
    window.addEventListener("pageshow", () => {
      if (!runtimeAuthorized) initializeFromExtensionStorage();
      else setupSpaNavigationListeners();
    });
  }

  async function deactivatePageRuntime() {
    authorizationGeneration += 1;
    runtimeAuthorized = false;
    draftSiteConfig = null;
    undoStack.length = 0;
    savedSiteConfig = { ...savedSiteConfig, enabled: false };
    if (mutationTimer) {
      clearTimeout(mutationTimer);
      mutationTimer = null;
    }
    if (pageObserverConnected) {
      domObserver.disconnect();
      pageObserverConnected = false;
    }
    selectionController.stop();
    removeAudioGesturePrompt();
    if (studioHost) closeInPageStudioDock();
    try { renderer.destroyAll(); } catch (_) {
      try { await renderer.applySiteCustomizations({ ...savedSiteConfig, enabled: false }, globalSettings, ChameleonSelectionEngine); } catch (_) {}
    }
    sessionBlobCache.clear();
    if (mediaPort) {
      try { mediaPort.disconnect(); } catch (_) {}
      mediaPort = null;
    }
    for (const [transferId, entry] of Array.from(pendingPortTransfers.entries())) {
      cleanupPendingTransfer(transferId);
      try { entry.reject(new Error("Site access was disabled during media transfer.")); } catch (_) {}
    }
  }

  function initializeFromExtensionStorage() {
    const generation = authorizationGeneration;
    if (initializationPromise && initializationGeneration === generation) return initializationPromise;
    initializationGeneration = generation;
    const task = (async () => {
      const access = await sendExtensionMessage({ type: "CHAMELEON_GET_PAGE_ACCESS_STATE" });
      if (generation !== authorizationGeneration) return { allowed: false, stale: true };
      if (!access || !access.ok || access.allowed !== true) {
        await deactivatePageRuntime();
        return { allowed: false, reason: access?.reason || access?.error || "Site access is not enabled." };
      }

      runtimeAuthorized = true;
      setupSpaNavigationListeners();
      await migrateLegacyPageIndexedDBIfPresent();
      if (generation !== authorizationGeneration || !runtimeAuthorized) return { allowed: false, stale: true };
      const overview = await sendExtensionMessage({
        type: "CHAMELEON_GET_OVERVIEW",
        siteKey: SITE_KEY,
        hostname: HOSTNAME
      });
      if (generation !== authorizationGeneration || !runtimeAuthorized) return { allowed: false, stale: true };
      if (overview && overview.ok) {
        if (overview.globalSettings) globalSettings = overview.globalSettings;
        const exactConfig = overview.hostnameConfig || overview.exactSiteConfig || null;
        if (exactConfig) savedSiteConfig = exactConfig;
        else savedSiteConfig = {
          siteKey: SITE_KEY,
          hostname: HOSTNAME,
          matchScope: "origin",
          enabled: true,
          revision: 0,
          components: {}
        };
      }
      if (generation !== authorizationGeneration || !runtimeAuthorized) return { allowed: false, stale: true };
      await applyWorkingConfigToPage();
      return { allowed: true };
    })();
    initializationPromise = task.finally(() => {
      if (initializationPromise === wrappedTask) {
        initializationPromise = null;
        initializationGeneration = -1;
      }
    });
    const wrappedTask = initializationPromise;
    return wrappedTask;
  }

  initializeFromExtensionStorage();
})();
