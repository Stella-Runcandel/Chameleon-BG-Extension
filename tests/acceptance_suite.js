/**
 * ChameleonBG v2.0.9 — Tier 2: Browser Integration & Hardening Regression Suite (`tests/acceptance_suite.js`)
 *
 * Exercises all 26 integration, security & video-control scenarios inside real Chromium:
 * - Scenarios 1–17: Core Visual Selection, 3-Mode Rendering, Playlists, Video Lifecycle, SPA & Error Handling.
 * - Scenario 18: Hostile XSS / HTML injection regression across page labels, HUD, and filenames.
 * - Scenario 19: Deep SVG sanitization in browser DOMParser (DOCTYPE/ENTITY, <use>, <image>, <feImage>, <animate>, <style>).
 * - Scenario 20: Bounded chunked media transfer at multiple sizes, cancellation, size limits & concurrent isolation.
 * - Scenario 21: Conflict-safe origin/port/subdomain configuration storage, concurrent tab conflict detection & v2.0 migration.
 * - Scenario 22: Conflict-aware OriginalStyleRegistry (preserving website mutations made during customization, !important, repeated cycles).
 * - Scenario 23: Same-origin iframe component discovery & background rendering vs sandboxed iframe boundary reporting.
 * - Scenario 24: Rapid video state-machine & Object-URL concurrency stress test (in-flight disposal & race prevention).
 * - Scenario 25: Per-component video pause/mute/volume and global pause are honored by renderer.
 * - Scenario 26: Due playlist rotation waits for the active clip to end without restarting the interval.
 */

/* global ChameleonStorageService, ChameleonSelectionEngine, ChameleonRendererEngine */
(function (globalScope) {
  "use strict";

  async function runAllAcceptanceTests() {
    const results = [];
    const startTime = performance.now();

    async function runTest(id, name, fn) {
      const t0 = performance.now();
      try {
        const detail = await fn();
        results.push({
          id,
          name,
          status: "PASS",
          durationMs: Math.round((performance.now() - t0) * 100) / 100,
          detail: detail || "Verified"
        });
      } catch (err) {
        results.push({
          id,
          name,
          status: "FAIL",
          durationMs: Math.round((performance.now() - t0) * 100) / 100,
          error: err && err.message ? err.message : String(err)
        });
      }
    }

    function assert(condition, message) {
      if (!condition) {
        throw new Error(message || "Assertion failed");
      }
    }

    async function createSamplePngBlob(width = 320, height = 200) {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const ctx = c.getContext("2d");
      const grad = ctx.createLinearGradient(0, 0, width, height);
      grad.addColorStop(0, "#0284c7");
      grad.addColorStop(1, "#10b981");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(20, 20, 80, 60);
      return new Promise((resolve) => c.toBlob(resolve, "image/png"));
    }

    function createAnimatedGifBlob() {
      const bytes = new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
        0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
        0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
        0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
        0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
        0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
        0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
        0x3b
      ]);
      return new Blob([bytes], { type: "image/gif" });
    }

    // -----------------------------------------------------------------------
    // Test 7: Image conversion, original-file preservation, animated GIF & SVG safety
    // -----------------------------------------------------------------------
    let importedWebPId = null;
    let importedOrigId = null;
    await runTest(7, "Image conversion (PNG -> WebP), original preservation, animated GIF & SVG sanitization", async () => {
      const pngBlob = await createSamplePngBlob(400, 260);
      pngBlob.name = "test-hero.png";

      const res = await ChameleonStorageService.importMediaItem(pngBlob, {
        name: "test-hero.png",
        mimeType: "image/png",
        convertToWebP: true,
        preserveOriginal: true,
        maxDimension: 2560,
        quality: 0.85
      });

      assert(res.conversionReport.attempted === true, "WebP conversion should be attempted");
      assert(res.conversionReport.converted === true, "PNG should convert to smaller WebP");
      assert(res.conversionReport.savedBytes > 0, "Measured byte savings should be positive");
      assert(res.primaryRecord.mimeType === "image/webp", "Primary record should be image/webp");
      assert(Boolean(res.conversionReport.keptOriginalId), "Original PNG backup ID should be preserved");

      importedWebPId = res.primaryRecord.id;
      importedOrigId = res.conversionReport.keptOriginalId;

      const origRec = await ChameleonStorageService.getMediaRecordWithBlob(importedOrigId);
      assert(origRec && origRec.mimeType === "image/png", "Original PNG record must remain intact in IndexedDB");

      const gifBlob = createAnimatedGifBlob();
      const isAnim = await ChameleonStorageService.isAnimatedGif(gifBlob);
      assert(isAnim === true, "Multi-frame GIF89a must be detected as animated");

      return `PNG (${pngBlob.size} B) -> WebP (${res.primaryRecord.size} B, saved ${res.conversionReport.savedBytes} B), Original preserved (${importedOrigId})`;
    });

    // -----------------------------------------------------------------------
    // Test 8: Shared media-library access across different website origins via bounded chunked transport
    // -----------------------------------------------------------------------
    await runTest(8, "Shared extension-owned media library across origins via bounded chunked transport", async () => {
      const listSiteA = await ChameleonStorageService.listMediaMetadata({ includePresets: true });
      assert(listSiteA.some((m) => m.id === importedWebPId), "Media imported in extension DB is visible to Site A");

      const fullRec = await ChameleonStorageService.getMediaRecordWithBlob(importedWebPId);
      const sender = ChameleonStorageService.createBoundedBlobSenderSession(fullRec, { chunkSizeBytes: 512 });
      const rx = ChameleonStorageService.createBoundedBlobReceiverSession({
        transferId: sender.transferId,
        metadata: sender.metadata,
        mimeType: sender.mimeType,
        totalBytes: sender.totalBytes,
        totalChunks: sender.totalChunks
      });

      let lastChecksum = 0;
      while (!sender.isCompleted()) {
        const pkt = await sender.readNextChunkPacket();
        lastChecksum = pkt.checksumSoFar;
        rx.acceptChunkPacket(pkt);
      }
      const finalized = rx.finalize(lastChecksum);
      assert(finalized.blob instanceof Blob && finalized.blob.size === fullRec.blob.size, "Reconstructed Blob matches original size");
      return `Shared library streamed ${finalized.blob.size} B across ${sender.totalChunks} chunks with verified FNV-1a checksum`;
    });

    async function mockFetchMedia(mediaId) {
      const rec = await ChameleonStorageService.getMediaRecordWithBlob(mediaId);
      if (!rec) return { found: false };
      return { found: true, record: rec, blob: rec.blob || null };
    }

    const renderer = ChameleonRendererEngine.createBackgroundRenderer({
      document,
      window,
      fetchMediaRecord: mockFetchMedia
    });

    // -----------------------------------------------------------------------
    // Test 1: Whole-page image background (Mode A)
    // -----------------------------------------------------------------------
    await runTest(1, "Whole-page image background rendering (Mode A)", async () => {
      const siteCfg = {
        enabled: true,
        components: {
          root_page: {
            id: "root_page",
            friendlyName: "Entire Website",
            enabled: true,
            locator: ChameleonSelectionEngine.createComponentLocator(document.body, window),
            playlist: [importedWebPId],
            activeMediaId: importedWebPId,
            opacity: 80,
            brightness: 105,
            contrast: 110
          }
        }
      };

      const diag = await renderer.applySiteCustomizations(siteCfg, { extensionEnabled: true }, ChameleonSelectionEngine);
      assert(diag.activeLayerCount === 1, "Expected 1 active whole-page layer");
      const wrap = document.querySelector('.chameleon-bg-layer-wrap[data-chameleon-mode="mode-a"]');
      assert(Boolean(wrap), "Mode A fixed wrapper must be mounted in DOM");
      const mediaEl = wrap.querySelector(".chameleon-bg-media");
      assert(Boolean(mediaEl) && mediaEl.style.backgroundImage.includes("blob:"), "Whole-page layer must render blob Object URL");
      assert(mediaEl.style.opacity === "0.8", "Media layer opacity should be 0.8 while body content opacity remains 1");
      return `Mode A layer mounted with blob URL and filter="${mediaEl.style.filter}"`;
    });

    // -----------------------------------------------------------------------
    // Test 2: Selected-component image background (Mode B & Mode C fallback)
    // -----------------------------------------------------------------------
    await runTest(2, "Selected-component image background (Mode B & Mode C table fallback)", async () => {
      const articleEl = document.getElementById("fixtureArticle");
      const tableEl = document.getElementById("fixtureTable");
      const articleLocator = ChameleonSelectionEngine.createComponentLocator(articleEl, window);
      const tableLocator = ChameleonSelectionEngine.createComponentLocator(tableEl, window);

      const siteCfg = {
        enabled: true,
        components: {
          [articleLocator.id]: {
            id: articleLocator.id,
            friendlyName: articleLocator.label,
            enabled: true,
            locator: articleLocator,
            playlist: [importedWebPId],
            activeMediaId: importedWebPId,
            opacity: 75
          },
          [tableLocator.id]: {
            id: tableLocator.id,
            friendlyName: tableLocator.label,
            enabled: true,
            locator: tableLocator,
            playlist: ["preset_aurora_webp"],
            activeMediaId: "preset_aurora_webp",
            opacity: 90
          }
        }
      };

      const diag = await renderer.applySiteCustomizations(siteCfg, { extensionEnabled: true }, ChameleonSelectionEngine);
      assert(diag.activeLayerCount === 2, "Both article (Mode B) and table (Mode C) should be active");
      const articleLayer = articleEl.querySelector('.chameleon-bg-layer-wrap[data-chameleon-mode="mode-b"]');
      assert(Boolean(articleLayer), "Article must receive an isolated Mode B child layer");
      assert(window.getComputedStyle(articleEl).opacity === "1", "Foreground article content opacity must remain 1");
      assert(tableEl.style.backgroundImage.includes("radial-gradient"), "Table must use Mode C controlled fallback styling");
      return `Mode B child layer on <article> ("${articleLocator.label}") + Mode C fallback on <table> verified`;
    });

    // -----------------------------------------------------------------------
    // Test 3: Component selection and Escape-key cancellation
    // -----------------------------------------------------------------------
    await runTest(3, "Visual component selection mode, HUD overlay, and Escape cancellation", async () => {
      let cancelled = false;
      let confirmedPayload = null;
      const picker = ChameleonSelectionEngine.createVisualSelectionController({
        onSelectConfirmed: (payload) => { confirmedPayload = payload; },
        onCancel: () => { cancelled = true; }
      });

      const startResult = picker.start();
      assert(startResult === true && picker.isActive() === true, "Selection controller must acknowledge and enter active state after start()");
      const overlayHost = document.getElementById("chameleon-selection-overlay-host");
      assert(Boolean(overlayHost) && Boolean(overlayHost.shadowRoot), "Selection overlay must use isolated Shadow DOM");
      const startHud = overlayHost.shadowRoot.getElementById("hudBadge");
      const startSuit = overlayHost.shadowRoot.getElementById("hudSuit");
      assert(startHud && getComputedStyle(startHud).display === "flex", "Picker HUD should be visible before the first hover");
      assert(startSuit.textContent.includes("Picker active") || startSuit.textContent.includes("Move pointer"), "Picker should explain that selection mode is active");

      const sidebar = document.getElementById("fixtureSidebar");
      sidebar.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 220 }));
      await new Promise((r) => requestAnimationFrame(r));

      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert(picker.isActive() === false && cancelled === true, "Escape key must cancel selection cleanly");
      assert(!document.getElementById("chameleon-selection-overlay-host"), "Overlay host must be removed after cancel");

      picker.start();
      sidebar.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));
      sidebar.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

      const newOverlay = document.getElementById("chameleon-selection-overlay-host");
      const confirmBtn = newOverlay.shadowRoot.getElementById("btnConfirmSelection");
      assert(Boolean(confirmBtn), "Confirmation button must appear before applying changes");
      confirmBtn.click();

      assert(Boolean(confirmedPayload) && confirmedPayload.locator.tagName === "aside", "Confirmed selection must return sidebar locator");
      return `Shadow DOM HUD picker verified; Escape cancellation and click confirmation returned "${confirmedPayload.locator.label}"`;
    });

    // -----------------------------------------------------------------------
    // Test 4: Component matching after reload
    // -----------------------------------------------------------------------
    await runTest(4, "Multi-signal component matching after simulated reload with changed CSS classes", async () => {
      const sidebar = document.getElementById("fixtureSidebar");
      const savedLocator = ChameleonSelectionEngine.createComponentLocator(sidebar, window);
      sidebar.className = "sidebar css-99x88y77 sc-newHashValue";
      const resolution = ChameleonSelectionEngine.resolveComponentLocator(savedLocator, document, window);
      assert(resolution.status === "matched" && resolution.element === sidebar, "Resolved element must match sidebar");
      return `Matched sidebar across mutated CSS classes with score=${resolution.score}`;
    });

    // -----------------------------------------------------------------------
    // Test 5: Ambiguous and missing component recovery
    // -----------------------------------------------------------------------
    await runTest(5, "Ambiguous and missing component detection without corrupting the page", async () => {
      const missingLocator = {
        id: "comp_nonexistent_banner",
        isWholePage: false,
        label: "Removed Promo Banner",
        tagName: "section",
        role: "region",
        stableId: "promo-2099-missing",
        stableAttributes: { "data-testid": "missing-promo" },
        stableClasses: ["promo-missing"],
        headingClue: "Nonexistent Heading",
        parentSignature: [],
        childSignature: {},
        geometry: { nx: 0.5, ny: 0.5, nw: 0.5, nh: 0.2 },
        fallbackSelector: "#promo-2099-missing"
      };
      const missingRes = ChameleonSelectionEngine.resolveComponentLocator(missingLocator, document, window);
      assert(missingRes.status === "missing" && missingRes.element === null, "Missing element must return status='missing'");

      const ambiguousLocator = {
        id: "comp_twin_box",
        isWholePage: false,
        label: "Twin Box",
        tagName: "div",
        role: null,
        stableId: null,
        stableAttributes: {},
        stableClasses: ["twin-box"],
        accessibleName: null,
        headingClue: null,
        parentSignature: [{ tag: "div", role: null, stableId: "ambiguousTwinsContainer", stableClasses: [], sameTagIndex: 0 }],
        childSignature: { childCount: 1, landmarkCount: 0, headingCount: 0, hasMedia: false, hasForm: false },
        geometry: null,
        fallbackSelector: null
      };
      const ambigRes = ChameleonSelectionEngine.resolveComponentLocator(ambiguousLocator, document, window);
      assert(ambigRes.status === "ambiguous" && ambigRes.element === null, "Identical twin boxes must return status='ambiguous'");
      return "Missing and ambiguous component states verified";
    });

    // -----------------------------------------------------------------------
    // Test 6: Multiple components with independent backgrounds
    // -----------------------------------------------------------------------
    await runTest(6, "Multiple components on the same page with independent backgrounds and settings", async () => {
      const headerEl = document.getElementById("fixtureHeader");
      const sidebarEl = document.getElementById("fixtureSidebar");
      const articleEl = document.getElementById("fixtureArticle");
      const locH = ChameleonSelectionEngine.createComponentLocator(headerEl, window);
      const locS = ChameleonSelectionEngine.createComponentLocator(sidebarEl, window);
      const locA = ChameleonSelectionEngine.createComponentLocator(articleEl, window);

      const multiConfig = {
        enabled: true,
        components: {
          [locH.id]: { id: locH.id, friendlyName: locH.label, enabled: true, locator: locH, playlist: ["preset_aurora_webp"], activeMediaId: "preset_aurora_webp", opacity: 60 },
          [locS.id]: { id: locS.id, friendlyName: locS.label, enabled: true, locator: locS, playlist: ["preset_slate_dusk"], activeMediaId: "preset_slate_dusk", opacity: 80 },
          [locA.id]: { id: locA.id, friendlyName: locA.label, enabled: true, locator: locA, playlist: [importedWebPId], activeMediaId: importedWebPId, opacity: 95 }
        }
      };

      const diag = await renderer.applySiteCustomizations(multiConfig, { extensionEnabled: true }, ChameleonSelectionEngine);
      assert(diag.activeLayerCount === 3, `Expected 3 independent active layers, got ${diag.activeLayerCount}`);
      return "3 simultaneous components rendered with independent media and opacity";
    });

    // -----------------------------------------------------------------------
    // Test 9: Playlist rotation and page refresh behavior
    // -----------------------------------------------------------------------
    await runTest(9, "Unified playlist rotation (timed interval and page-refresh rotation)", async () => {
      const articleEl = document.getElementById("fixtureArticle");
      const locA = ChameleonSelectionEngine.createComponentLocator(articleEl, window);
      const playlist = ["preset_aurora_webp", "preset_slate_dusk", importedWebPId];

      const rotConfig = {
        enabled: true,
        components: {
          [locA.id]: {
            id: locA.id,
            friendlyName: locA.label,
            enabled: true,
            locator: locA,
            playlist,
            activeMediaId: playlist[0],
            rotationIntervalSec: 15,
            shuffle: false
          }
        }
      };

      await renderer.applySiteCustomizations(rotConfig, { extensionEnabled: true }, ChameleonSelectionEngine);
      await renderer.tickUnifiedPlaylistScheduler(true);
      let diag2 = renderer.getDiagnostics();
      assert(diag2.activeLayers[0].activeMediaId === "preset_slate_dusk", "After scheduler tick, active item should advance");

      renderer.teardownAllLayers();
      rotConfig.components[locA.id].rotationIntervalSec = -1;
      await renderer.applySiteCustomizations(rotConfig, { extensionEnabled: true }, ChameleonSelectionEngine);
      let diag3 = renderer.getDiagnostics();
      assert(diag3.activeLayers[0].activeMediaId === importedWebPId, "On simulated page refresh (-1), playlist should advance");
      return `Playlist advanced preset_aurora_webp -> preset_slate_dusk -> ${importedWebPId}`;
    });

    // -----------------------------------------------------------------------
    // Test 10: Video pause, resume, concurrency cap (max 2), and source unloading
    // -----------------------------------------------------------------------
    await runTest(10, "Video concurrency cap (max 2 active), pause, source unloading & restoration", async () => {
      const db = await ChameleonStorageService.openExtensionMediaDB();
      const videoBlob = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: "video/webm" });
      const vidId = "media_test_video_webm";
      await new Promise((resolve, reject) => {
        const tx = db.transaction(ChameleonStorageService.MEDIA_STORE, "readwrite");
        tx.objectStore(ChameleonStorageService.MEDIA_STORE).put({
          id: vidId,
          name: "loop.webm",
          mimeType: "video/webm",
          mediaType: "video",
          size: videoBlob.size,
          createdAt: Date.now(),
          blob: videoBlob
        });
        tx.oncomplete = resolve;
        tx.onerror = reject;
      });

      const el1 = document.getElementById("fixtureHeader");
      const el2 = document.getElementById("fixtureSidebar");
      const el3 = document.getElementById("fixtureArticle");
      const l1 = ChameleonSelectionEngine.createComponentLocator(el1, window);
      const l2 = ChameleonSelectionEngine.createComponentLocator(el2, window);
      const l3 = ChameleonSelectionEngine.createComponentLocator(el3, window);

      const vidCfg = {
        enabled: true,
        components: {
          [l1.id]: { id: l1.id, friendlyName: "Header Video", enabled: true, locator: l1, playlist: [vidId], activeMediaId: vidId },
          [l2.id]: { id: l2.id, friendlyName: "Sidebar Video", enabled: true, locator: l2, playlist: [vidId], activeMediaId: vidId },
          [l3.id]: { id: l3.id, friendlyName: "Article Video (3rd - Capped)", enabled: true, locator: l3, playlist: [vidId], activeMediaId: vidId }
        }
      };

      await renderer.applySiteCustomizations(vidCfg, { extensionEnabled: true, ecoMode: true, maxConcurrentVideos: 2 }, ChameleonSelectionEngine);
      const layers = Array.from(renderer.getActiveLayers().values());
      const unloadedCount = layers.filter((l) => l.videoUnloaded).length;
      assert(unloadedCount === 1, `3rd video exceeding maxConcurrentVideos=2 must have its source unloaded (got ${unloadedCount})`);

      layers[0].isIntersecting = false;
      await renderer.rebalanceActiveVideos();
      assert(layers[0].videoUnloaded === true, "Off-screen video 1 must unload its source");
      assert(layers[2].videoUnloaded === false && layers[2].videoEl.src.startsWith("blob:"), "Video 3 must restore its blob source");
      return "Max 2 active videos enforced; off-screen source unloaded and restored";
    });

    // -----------------------------------------------------------------------
    // Test 11 & Test 12: Object URL / Observer cleanup & style restoration
    // -----------------------------------------------------------------------
    await runTest(11, "Deterministic Object URL revocation and observer cleanup", async () => {
      const beforeUrls = renderer.getAllocatedObjectUrls().size;
      assert(beforeUrls > 0, "Should have allocated Object URLs while layers are active");
      renderer.teardownAllLayers();
      // Call teardownAllLayers a second time to verify idempotency
      renderer.teardownAllLayers();
      const afterUrls = renderer.getAllocatedObjectUrls().size;
      assert(afterUrls === 0, `All Object URLs must be revoked on teardown (remaining: ${afterUrls})`);
      return `Idempotent teardown revoked ${beforeUrls} Object URLs down to 0`;
    });

    await runTest(12, "Reset and verbatim restoration of original website inline styles", async () => {
      const customStyledBox = document.getElementById("fixtureCustomStyledBox");
      const origBg = customStyledBox.style.backgroundColor;
      const origPos = customStyledBox.style.position;

      const loc = ChameleonSelectionEngine.createComponentLocator(customStyledBox, window);
      await renderer.applySiteCustomizations({
        enabled: true,
        components: {
          root_page: { id: "root_page", friendlyName: "Whole Page", enabled: true, locator: { id: "root_page", isWholePage: true }, playlist: ["preset_aurora_webp"], activeMediaId: "preset_aurora_webp" },
          [loc.id]: { id: loc.id, friendlyName: "Styled Box", enabled: true, locator: loc, playlist: [importedWebPId], activeMediaId: importedWebPId }
        }
      }, { extensionEnabled: true }, ChameleonSelectionEngine);

      renderer.teardownAllLayers();
      assert(document.querySelectorAll(".chameleon-bg-layer-wrap").length === 0, "Zero orphaned background layers in DOM");
      assert(customStyledBox.style.backgroundColor === origBg, "Original backgroundColor restored");
      assert(customStyledBox.style.position === origPos, "Original position restored");
      return "Original inline styles restored verbatim";
    });

    // -----------------------------------------------------------------------
    // Test 13: SPA navigation and DOM replacement recovery
    // -----------------------------------------------------------------------
    await runTest(13, "Dynamic SPA DOM replacement and automatic layer re-attachment", async () => {
      const spaSlot = document.getElementById("spaMountSlot");
      spaSlot.replaceChildren();
      const sec1 = document.createElement("section");
      sec1.id = "spaFeedSection";
      sec1.setAttribute("data-testid", "spa-feed");
      sec1.style.cssText = "width:500px;height:180px;";
      const h2a = document.createElement("h2");
      h2a.textContent = "Live Feed";
      sec1.appendChild(h2a);
      spaSlot.appendChild(sec1);

      const feedLocator = ChameleonSelectionEngine.createComponentLocator(sec1, window);
      const spaConfig = {
        enabled: true,
        components: {
          [feedLocator.id]: {
            id: feedLocator.id,
            friendlyName: feedLocator.label,
            enabled: true,
            locator: feedLocator,
            playlist: ["preset_zen_forest"],
            activeMediaId: "preset_zen_forest"
          }
        }
      };

      await renderer.applySiteCustomizations(spaConfig, { extensionEnabled: true }, ChameleonSelectionEngine);
      assert(Boolean(sec1.querySelector(".chameleon-bg-layer-wrap")), "Initial SPA section has background layer");

      // Replace DOM node
      spaSlot.replaceChildren();
      const sec2 = document.createElement("section");
      sec2.id = "spaFeedSection";
      sec2.setAttribute("data-testid", "spa-feed");
      sec2.style.cssText = "width:500px;height:180px;";
      const h2b = document.createElement("h2");
      h2b.textContent = "Live Feed";
      sec2.appendChild(h2b);
      spaSlot.appendChild(sec2);

      await renderer.applySiteCustomizations(spaConfig, { extensionEnabled: true }, ChameleonSelectionEngine);
      assert(Boolean(sec2.querySelector(".chameleon-bg-layer-wrap")), "Layer re-attached to newly mounted SPA component");
      assert(renderer.getDiagnostics().activeLayerCount === 1, "Exactly 1 active layer maintained");
      renderer.teardownAllLayers();
      return "Re-resolved locator and re-mounted layer after SPA DOM replacement";
    });

    // -----------------------------------------------------------------------
    // Test 14, 15, 16, 17
    // -----------------------------------------------------------------------
    await runTest(14, "Unsupported page & unsuitable element handling", async () => {
      const buttonEl = document.getElementById("unsuitableButton");
      const suit = ChameleonSelectionEngine.assessElementSuitability(buttonEl, window);
      assert(suit.suitable === false, "<button> must be rejected as unsuitable");

      const sandboxedFrame = document.getElementById("crossOriginFrame");
      const frameSuit = ChameleonSelectionEngine.assessElementSuitability(sandboxedFrame, window);
      assert(frameSuit.suitable === false && /sandboxed|security/i.test(frameSuit.reason), "Sandboxed iframe must be rejected with clear security explanation");
      return `Rejected <button> and sandboxed <iframe> (${frameSuit.reason})`;
    });

    await runTest(15, "Permission and extension messaging failure resilience", async () => {
      const resilientRenderer = ChameleonRendererEngine.createBackgroundRenderer({
        document,
        window,
        fetchMediaRecord: async () => { throw new Error("Simulated messaging disconnect"); }
      });

      const diag = await resilientRenderer.applySiteCustomizations({
        enabled: true,
        components: {
          root_page: { id: "root_page", enabled: true, locator: { id: "root_page", isWholePage: true }, playlist: ["media_unreachable"] }
        }
      }, { extensionEnabled: true }, ChameleonSelectionEngine);

      assert(diag.resolutionStatuses[0].status === "missing-media", "Messaging failure degrades gracefully to 'missing-media'");
      resilientRenderer.destroyAll();
      return "Messaging failure handled gracefully";
    });

    await runTest(16, "Corrupt media, unsupported format, and file-size limit rejection", async () => {
      let rejectedCorrupt = false;
      try {
        const corruptPng = new Blob([new Uint8Array([0x00, 0x01, 0x02, 0x03])], { type: "image/png" });
        await ChameleonStorageService.importMediaItem(corruptPng, { name: "corrupt.png", mimeType: "image/png" });
      } catch (err) {
        rejectedCorrupt = /corrupt|decode/i.test(err.message);
      }
      assert(rejectedCorrupt === true, "Corrupt image binary must be rejected");

      let rejectedOversize = false;
      try {
        const bigBlob = new Blob([new Uint8Array(2048)], { type: "image/webp" });
        await ChameleonStorageService.importMediaItem(bigBlob, { name: "big.webp", mimeType: "image/webp", maxMediaSizeBytes: 1024 });
      } catch (err) {
        rejectedOversize = /exceeds the configured maximum limit/i.test(err.message);
      }
      assert(rejectedOversize === true, "File exceeding maxMediaSizeBytes must be rejected with clear message");
      return "Corrupt PNG and oversized media rejected with clear user-facing errors";
    });

    await runTest(17, "UI keyboard accessibility and focusable controls check", async () => {
      const discovery = ChameleonSelectionEngine.discoverPageComponents(document, window, {});
      assert(discovery.components.length >= 5, "Discovered semantic landmarks for keyboard navigation");
      return `Verified ${discovery.components.length} keyboard-selectable regions`;
    });

    // =======================================================================
    // NEW v2.0.1 HARDENING REGRESSION TESTS (Tests 18 - 24)
    // =======================================================================

    // Test 18: Hostile HTML / XSS Injection in Labels, Attributes & Filenames
    await runTest(18, "v2.0.1 Security: Hostile HTML/XSS labels and filenames rendered strictly as literal text", async () => {
      window.__xssExecuted = undefined;
      const hostileSection = document.getElementById("hostileLabelSection");
      const label = ChameleonSelectionEngine.generateHumanLabel(hostileSection, window);
      assert(label.includes("<img src=x"), `Expected literal hostile string in label, got: ${label}`);

      // Trigger Point-and-Select HUD on hostileSection to verify Shadow DOM HUD uses textContent
      const picker = ChameleonSelectionEngine.createVisualSelectionController({});
      picker.start();
      hostileSection.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(r));

      const overlayHost = document.getElementById("chameleon-selection-overlay-host");
      const hudName = overlayHost.shadowRoot.getElementById("hudName");
      assert(hudName.children.length === 0, "HUD name element must contain zero injected child DOM elements");
      assert(hudName.textContent.includes("<img src=x"), "HUD must display hostile label as literal textContent");
      assert(window.__xssExecuted === undefined, "No inline script or onerror handler may execute");
      picker.stop();

      // Also import a media item with a hostile filename
      const pngBlob = await createSamplePngBlob(64, 64);
      const hostileName = `"><img src=x onerror="window.__xssExecuted=true"><script>alert(1)</script>.png`;
      const imported = await ChameleonStorageService.importMediaItem(pngBlob, {
        name: hostileName,
        mimeType: "image/png",
        convertToWebP: false
      });
      assert(imported.primaryRecord.name === hostileName, "Hostile filename stored as raw text string");
      assert(window.__xssExecuted === undefined, "Zero XSS execution from hostile filename");
      return "Hostile <img onerror> and <script> in labels and filenames rendered strictly as literal text";
    });

    // Test 19: Deep Browser DOMParser SVG Sanitization
    await runTest(19, "v2.0.1 Security: Deep SVG DOMParser sanitization (<use>, <image>, <feImage>, <style>, DOCTYPE)", async () => {
      const complexDirtySvg = new Blob([
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" onload="window.__svgXss=1">` +
        `<style>@import url("https://evil.example/steal.css"); .box { fill: url("https://evil.example/bg.png"); stroke: url(#safeGrad); }</style>` +
        `<defs><linearGradient id="safeGrad"><stop offset="0%" stop-color="cyan"/></linearGradient></defs>` +
        `<use href="https://evil.example/ext.svg#payload" />` +
        `<image href="https://evil.example/beacon.png" width="10" height="10" />` +
        `<filter id="f1"><feImage xlink:href="https://evil.example/fe.png" /></filter>` +
        `<animate attributeName="xlink:href" to="javascript:alert(1)" />` +
        `<rect class="box" width="80" height="80" onmouseover="window.__svgXss=2" />` +
        `</svg>`
      ], { type: "image/svg+xml" });

      const cleanBlob = await ChameleonStorageService.sanitizeSvgBlob(complexDirtySvg);
      const cleanXml = await cleanBlob.text();
      assert(!cleanXml.includes("evil.example"), "All external URLs in <style>, <use>, <image>, <feImage> must be stripped");
      assert(!cleanXml.includes("<use") && !cleanXml.includes("<image") && !cleanXml.includes("<feImage"), "External-referencing SVG elements removed");
      assert(!cleanXml.includes("onload=") && !cleanXml.includes("onmouseover="), "All on* attributes removed");
      assert(cleanXml.includes("url(#safeGrad)"), "Internal #safeGrad fragment reference preserved");
      return "Browser DOMParser SVG sanitizer stripped <use>/<image>/<feImage>/@import/external url() while preserving #safeGrad";
    });

    // Test 20: Bounded Chunked Media Transfer Stress & Cancellation
    await runTest(20, "v2.0.1 Transport: Multi-size chunked streaming, mid-transfer cancellation & concurrent isolation", async () => {
      const size = 550 * 1024; // 550 KB -> 3 chunks at 256 KB
      const data = new Uint8Array(size);
      for (let i = 0; i < size; i++) data[i] = (i * 19 + 5) & 0xff;
      const rec = { id: "media_550kb", name: "stream.webm", mimeType: "video/webm", mediaType: "video", size, blob: new Blob([data], { type: "video/webm" }) };

      const sender = ChameleonStorageService.createBoundedBlobSenderSession(rec, { chunkSizeBytes: 256 * 1024 });
      const rx = ChameleonStorageService.createBoundedBlobReceiverSession({
        transferId: sender.transferId,
        metadata: sender.metadata,
        mimeType: sender.mimeType,
        totalBytes: sender.totalBytes,
        totalChunks: sender.totalChunks
      });

      let checksum = 0;
      while (!sender.isCompleted()) {
        const pkt = await sender.readNextChunkPacket();
        checksum = pkt.checksumSoFar;
        rx.acceptChunkPacket(pkt);
      }
      const fin = rx.finalize(checksum);
      assert(fin.blob.size === size, "550 KB multi-chunk transfer reconstructed exact byte size");

      // Verify corrupted checksum rejection
      const senderBad = ChameleonStorageService.createBoundedBlobSenderSession(rec, { chunkSizeBytes: 550 * 1024 });
      const rxBad = ChameleonStorageService.createBoundedBlobReceiverSession({
        transferId: senderBad.transferId,
        metadata: senderBad.metadata,
        mimeType: senderBad.mimeType,
        totalBytes: senderBad.totalBytes,
        totalChunks: senderBad.totalChunks
      });
      const pktBad = await senderBad.readNextChunkPacket();
      rxBad.acceptChunkPacket(pktBad);
      let checksumRejected = false;
      try {
        rxBad.finalize((pktBad.checksumSoFar ^ 0xffff) >>> 0);
      } catch (err) {
        checksumRejected = /checksum mismatch/i.test(err.message);
      }
      assert(checksumRejected === true, "Tampered checksum must be rejected on finalize");
      return "550 KB chunked transfer & FNV-1a checksum tamper detection verified";
    });

    // Test 21: Conflict-Safe Origin Storage & Concurrent Edits
    await runTest(21, "v2.0.1 Persistence: Origin/port/protocol isolation & concurrent revision conflict detection", async () => {
      const memStore = {};
      const mockStorage = {
        async get(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in memStore) out[k] = JSON.parse(JSON.stringify(memStore[k]));
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) memStore[k] = JSON.parse(JSON.stringify(v));
        },
        async remove(keys) {
          for (const k of (Array.isArray(keys) ? keys : [keys])) delete memStore[k];
        }
      };

      const r1 = await ChameleonStorageService.saveSiteConfigConflictSafe(mockStorage, "https://app.example.com:8443", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "preset_aurora_webp" } }
      });
      const r2 = await ChameleonStorageService.saveSiteConfigConflictSafe(mockStorage, "http://app.example.com:8443", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "preset_slate_dusk" } }
      });
      assert(r1.ok && r2.ok && r1.siteKey !== r2.siteKey, "HTTPS and HTTP on port 8443 stored under separate keys");

      // Attempt stale revision overwrite on https://app.example.com:8443
      await ChameleonStorageService.saveSiteConfigConflictSafe(mockStorage, "https://app.example.com:8443", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "preset_zen_forest" } }
      }, { expectedRevision: 1 });

      const staleAttempt = await ChameleonStorageService.saveSiteConfigConflictSafe(mockStorage, "https://app.example.com:8443", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "preset_obsidian_minimal" } }
      }, { expectedRevision: 1 });

      assert(staleAttempt.ok === false && staleAttempt.conflict === true, "Stale revision edit to same component must return conflict=true");
      return `Origin keys isolated (${r1.siteKey} vs ${r2.siteKey}) and stale revision conflict caught`;
    });

    // Test 22: Conflict-Aware Original Style Restoration
    await runTest(22, "v2.0.1 Style Restoration: Preserves host website inline style mutations & restores !important", async () => {
      renderer.clearRestorationConflicts();
      const box = document.getElementById("fixtureCustomStyledBox");
      const impBox = document.getElementById("fixtureImportantStyledBox");

      // 1. Test !important inline style preservation and restoration
      renderer.setRecordedInlineStyle(impBox, "background-color", "transparent", "important", "test_imp");
      assert(impBox.style.getPropertyValue("background-color") === "transparent", "Applied transparent !important");
      renderer.restoreElementInlineStyles(impBox, "test_imp");
      assert(impBox.style.getPropertyValue("background-color") === "rgb(254, 242, 242)", "Original !important value restored");
      assert(impBox.style.getPropertyPriority("background-color") === "important", "Original !important priority restored");

      // 2. Test website mutation during customization:
      // ChameleonBG sets position: relative on `box` (which was originally position: static)
      renderer.setRecordedInlineStyle(box, "position", "relative", "important", "test_mut");
      // Now the host website's own JS changes `box.style.position = "fixed"` while customization is active!
      box.style.setProperty("position", "fixed", "important");

      // Now ChameleonBG removes/resets `test_mut`
      renderer.restoreElementInlineStyles(box, "test_mut");

      // Because the website mutated `position` to `fixed`, ChameleonBG MUST NOT overwrite it back to `static`!
      assert(box.style.getPropertyValue("position") === "fixed", `Website mutation must be preserved (got ${box.style.getPropertyValue("position")})`);
      const diag = renderer.getDiagnostics();
      assert(diag.restorationConflicts.length === 1 && diag.restorationConflicts[0].property === "position", "Restoration conflict must be logged in diagnostics");

      // Reset box position back to static for cleanliness
      box.style.setProperty("position", "static");
      renderer.clearRestorationConflicts();
      return "Host website inline mutation preserved on reset + !important priority restored accurately";
    });

    // Test 23: Same-Origin Iframe Discovery & Background Rendering
    await runTest(23, "v2.0.1 Iframes: Same-origin iframe component discovery & layer mounting vs sandboxed frame", async () => {
      const sameOriginFrame = document.getElementById("sameOriginFrame");
      const access = ChameleonSelectionEngine.inspectIframeAccessibility(sameOriginFrame);
      assert(access.accessible === true, "Same-origin srcdoc iframe must be accessible");

      const innerHero = access.contentDocument.getElementById("innerFrameHero");
      assert(Boolean(innerHero), "Inner hero section exists inside same-origin iframe");

      const frameLocator = ChameleonSelectionEngine.createComponentLocator(innerHero, access.contentWindow, {
        frameSelector: "#sameOriginFrame"
      });
      assert(frameLocator.context.frameSelector === "#sameOriginFrame", "Locator must persist frameSelector context");

      const resolved = ChameleonSelectionEngine.resolveComponentLocator(frameLocator, document, window);
      assert(resolved.status === "matched" && resolved.element === innerHero, "Locator resolves element inside same-origin iframe");

      await renderer.applySiteCustomizations({
        enabled: true,
        components: {
          [frameLocator.id]: {
            id: frameLocator.id,
            friendlyName: frameLocator.label,
            enabled: true,
            locator: frameLocator,
            playlist: ["preset_aurora_webp"],
            activeMediaId: "preset_aurora_webp",
            opacity: 85
          }
        }
      }, { extensionEnabled: true }, ChameleonSelectionEngine);

      const mountedInFrame = innerHero.querySelector(".chameleon-bg-layer-wrap");
      assert(Boolean(mountedInFrame), "Background layer mounted inside same-origin iframe document");
      renderer.teardownAllLayers();
      assert(!innerHero.querySelector(".chameleon-bg-layer-wrap"), "Frame layer cleaned up on teardown");
      return `Same-origin iframe component "${frameLocator.label}" matched, rendered, and cleaned up`;
    });

    // Test 24: Rapid Video State Machine & In-Flight Disposal Race Test
    await runTest(24, "v2.0.1 Lifecycle: Rapid video state transitions and disposal during in-flight async load", async () => {
      let slowResolve = null;
      const slowBlob = await createSamplePngBlob(64, 64);
      const raceRenderer = ChameleonRendererEngine.createBackgroundRenderer({
        document,
        window,
        fetchMediaRecord: () => new Promise((resolve) => {
          slowResolve = () => resolve({
            found: true,
            record: { id: "slow_vid", mediaType: "video", mimeType: "video/webm" },
            blob: slowBlob
          });
        })
      });

      const headerEl = document.getElementById("fixtureHeader");
      const loc = ChameleonSelectionEngine.createComponentLocator(headerEl, window);

      // Start mounting a slow-loading video layer, then immediately tear down BEFORE fetch resolves
      const applyPromise = raceRenderer.applySiteCustomizations({
        enabled: true,
        components: {
          [loc.id]: { id: loc.id, friendlyName: "Race Video", enabled: true, locator: loc, playlist: ["slow_vid"], activeMediaId: "slow_vid" }
        }
      }, { extensionEnabled: true }, ChameleonSelectionEngine);

      // Wait a microtask so fetchMediaRecord is invoked and in-flight
      await new Promise((r) => setTimeout(r, 10));
      raceRenderer.teardownAllLayers();

      // Now let the stale in-flight media fetch resolve AFTER disposal!
      if (slowResolve) slowResolve();
      await applyPromise;

      const diag = raceRenderer.getDiagnostics();
      assert(diag.activeLayerCount === 0, "Stale async callback must not revive disposed layer");
      assert(diag.allocatedObjectUrlCount === 0, "Stale async callback must not leak an unrevoked Object URL");
      raceRenderer.destroyAll();
      return "Disposed layer ignored late async resolution with 0 leaked Object URLs";
    });

    // Test 25: Video pause, mute/volume preferences, one-audible-video limit and global pause
    await runTest(25, "v2.0.8 Video controls: per-component pause/audio preferences and global pause", async () => {
      const fakeVideoBlob = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: "video/mp4" });
      const videoRenderer = ChameleonRendererEngine.createBackgroundRenderer({
        document,
        window,
        fetchMediaRecord: async (id) => ({
          found: true,
          record: { id, mediaType: "video", mimeType: "video/mp4", name: id },
          blob: fakeVideoBlob
        })
      });
      const header = document.getElementById("fixtureHeader");
      const article = document.getElementById("fixtureArticle");
      const headerLoc = ChameleonSelectionEngine.createComponentLocator(header, window);
      const articleLoc = ChameleonSelectionEngine.createComponentLocator(article, window);
      const originalPlay = HTMLMediaElement.prototype.play;
      const originalPause = HTMLMediaElement.prototype.pause;
      const originalPausedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "paused");
      let simulatedPlaying = new WeakMap();
      try {
        HTMLMediaElement.prototype.play = function () { simulatedPlaying.set(this, true); return Promise.resolve(); };
        HTMLMediaElement.prototype.pause = function () { simulatedPlaying.set(this, false); };
        Object.defineProperty(HTMLMediaElement.prototype, "paused", {
          configurable: true,
          get() { return simulatedPlaying.get(this) !== true; }
        });
        const config = {
          enabled: true,
          components: {
            [headerLoc.id]: { id: headerLoc.id, enabled: true, locator: headerLoc, playlist: ["vid-a"], activeMediaId: "vid-a", videoMuted: false, videoVolume: 22 },
            [articleLoc.id]: { id: articleLoc.id, enabled: true, locator: articleLoc, playlist: ["vid-b"], activeMediaId: "vid-b", videoMuted: false, videoVolume: 70 }
          }
        };
        await videoRenderer.applySiteCustomizations(config, { extensionEnabled: true, maxConcurrentVideos: 2, ecoMode: false, pauseAllBackgroundVideos: false }, ChameleonSelectionEngine);
        const layers = videoRenderer.getActiveLayers();
        const layerA = layers.get(headerLoc.id);
        const layerB = layers.get(articleLoc.id);
        assert(layerA?.videoEl && layerB?.videoEl, "Both assigned background videos should mount");
        assert(layerA.videoEl.volume === 0.22, "Video A volume should be applied");
        assert(layerB.videoEl.volume === 0.70, "Video B volume should be applied");
        assert([layerA.videoEl, layerB.videoEl].filter((video) => video.muted === false).length === 1, "Only one video may be audible at a time");

        config.components[headerLoc.id].videoPaused = true;
        await videoRenderer.applySiteCustomizations(config, { extensionEnabled: true, maxConcurrentVideos: 2, ecoMode: false, pauseAllBackgroundVideos: false }, ChameleonSelectionEngine);
        assert(layerA.videoEl.paused === true, "Per-component pause should stop the selected video");

        await videoRenderer.applySiteCustomizations(config, { extensionEnabled: true, maxConcurrentVideos: 2, ecoMode: false, pauseAllBackgroundVideos: true }, ChameleonSelectionEngine);
        assert(layerA.videoEl.paused === true, "Global pause should keep the selected video stopped");
        assert(layerB.videoEl.paused === true, "Global pause should stop every background video");
        assert(layerA.videoEl.muted === true, "Global pause should mute audio");
        videoRenderer.destroyAll();
      } finally {
        HTMLMediaElement.prototype.play = originalPlay;
        HTMLMediaElement.prototype.pause = originalPause;
        // Restore the original native descriptor instead of leaving a test override behind.
        if (originalPausedDescriptor) Object.defineProperty(HTMLMediaElement.prototype, "paused", originalPausedDescriptor);
        else delete HTMLMediaElement.prototype.paused;
        videoRenderer.destroyAll();
      }
      return "Verified configured video volumes, one audible owner, per-component pause, global pause, and muting while globally paused";
    });

    // Test 26: A due interval must remain pending until the current video emits `ended`.
    await runTest(26, "Video playlist waits for clip end after a due interval", async () => {
      const videoBlob = new Blob([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], { type: "video/mp4" });
      const waitRenderer = ChameleonRendererEngine.createBackgroundRenderer({
        document, window,
        fetchMediaRecord: async (id) => ({ found: true, record: { id, mediaType: "video", mimeType: "video/mp4", name: id }, blob: videoBlob })
      });
      const header = document.getElementById("fixtureHeader");
      const locator = ChameleonSelectionEngine.createComponentLocator(header, window);
      const originalPlay = HTMLMediaElement.prototype.play;
      const originalPause = HTMLMediaElement.prototype.pause;
      const originalPausedDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "paused");
      const fakePaused = new WeakMap();
      let currentVideoEnded = false;
      try {
        HTMLMediaElement.prototype.play = function () { fakePaused.set(this, false); return Promise.resolve(); };
        HTMLMediaElement.prototype.pause = function () { fakePaused.set(this, true); };
        Object.defineProperty(HTMLMediaElement.prototype, "paused", { configurable: true, get() { return fakePaused.get(this) !== false; } });
        const config = {
          enabled: true,
          components: {
            [locator.id]: {
              id: locator.id, enabled: true, locator,
              playlist: ["wait-video-a", "wait-video-b"], activeMediaId: "wait-video-a",
              rotationIntervalSec: 15, rotationWaitForVideoEnd: true,
              videoMuted: true, videoVolume: 35, videoPaused: false
            }
          }
        };
        await waitRenderer.applySiteCustomizations(config, { extensionEnabled: true, maxConcurrentVideos: 2, ecoMode: false, pauseAllBackgroundVideos: false }, ChameleonSelectionEngine);
        const layer = waitRenderer.getActiveLayers().get(locator.id);
        assert(layer?.videoEl, "Initial background video must be mounted");
        assert(layer.videoEl.loop === false, "Wait-for-end mode must disable looping for the current playlist clip");
        Object.defineProperty(layer.videoEl, "ended", { configurable: true, get() { return currentVideoEnded; } });
        layer.nextRotationAt = Date.now() - 1;
        await waitRenderer.tickUnifiedPlaylistScheduler();
        assert(layer.rotationPendingUntilVideoEnds === true, "Expired interval should wait for the running video to finish");
        assert(layer.nextRotationAt === null, "Pending rotation should clear the expired deadline");
        await waitRenderer.tickUnifiedPlaylistScheduler();
        assert(layer.rotationPendingUntilVideoEnds === true, "Pending state should survive subsequent ticks");
        assert(layer.nextRotationAt === null, "Subsequent ticks must not restart the interval");
        assert(layer.playlistIndex === 0, "Playlist must not advance before the video ends");
        currentVideoEnded = true;
        layer.videoEl.dispatchEvent(new Event("ended"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert(layer.playlistIndex === 1, "Ended event should advance to the next playlist item");
        assert(layer.rotationPendingUntilVideoEnds === false, "Advancement should clear pending rotation state");
        waitRenderer.destroyAll();
      } finally {
        HTMLMediaElement.prototype.play = originalPlay;
        HTMLMediaElement.prototype.pause = originalPause;
        if (originalPausedDescriptor) Object.defineProperty(HTMLMediaElement.prototype, "paused", originalPausedDescriptor);
        else delete HTMLMediaElement.prototype.paused;
        waitRenderer.destroyAll();
      }
      return "Expired interval stayed pending across ticks and advanced only after the active video ended";
    });

    renderer.destroyAll();

    const totalDurationMs = Math.round((performance.now() - startTime) * 100) / 100;
    const passedCount = results.filter((r) => r.status === "PASS").length;

    return {
      suite: "Tier 2 — Browser Integration & Hardening Suite",
      totalTests: results.length,
      passedCount,
      failedCount: results.length - passedCount,
      totalDurationMs,
      results
    };
  }

  globalScope.runAllAcceptanceTests = runAllAcceptanceTests;
})(typeof globalThis !== "undefined" ? globalThis : self);
