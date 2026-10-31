/**
 * ChameleonBG v2.0.9 — 3-Mode Background Rendering Engine, Conflict-Aware Style Registry,
 * Explicit Video State Machine & Ref-Counted Object URL Lifecycle (`renderer-engine.js`)
 *
 * Hardening improvements in v2.0.1:
 * 1. Conflict-Aware `OriginalStyleRegistry`:
 *    - Records `{ hadProperty, originalValue, originalPriority, appliedValue, appliedPriority }`
 *      for every modified inline property.
 *    - On reset/teardown, verifies whether the property is still in the state applied by ChameleonBG.
 *    - If the host website subsequently mutated that inline property, ChameleonBG preserves the
 *      website's new style rather than overwriting it, and records a diagnostic in `restorationConflicts`.
 * 2. Deterministic Per-Video State Machine & Operation Lock:
 *    - Tracks explicit states: `"unloaded" | "loading" | "active" | "paused" | "failed" | "disposed"`.
 *    - Coalesces concurrent restore requests via `inFlightLoadPromise` and guards against stale async
 *      completions reviving disposed layers via monotonic `opToken` checks.
 * 3. Owner-Tracked Object URL Registry:
 *    - Associates every `blob:` Object URL with explicit owner keys (`layer:<compId>`), revoking only
 *      when no active consumer references it, and making cleanup idempotent.
 * 4. Same-Origin Frame Layer Mounting:
 *    - Injects layer stylesheet into accessible same-origin iframe documents when mounting frame-scoped layers.
 */

(function (globalScope) {
  "use strict";

  const INJECTED_FRAME_CSS = `
    .chameleon-bg-layer-wrap {
      position: absolute !important;
      top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
      width: 100% !important; height: 100% !important;
      pointer-events: none !important; z-index: -1 !important;
      overflow: hidden !important; border-radius: inherit !important;
      margin: 0 !important; padding: 0 !important; border: none !important; box-sizing: border-box !important;
    }
    .chameleon-bg-layer-wrap[data-chameleon-mode="mode-a"] {
      position: fixed !important; top: 0 !important; left: 0 !important;
      width: 100vw !important; height: 100vh !important; border-radius: 0 !important;
    }
    .chameleon-bg-media, .chameleon-bg-tint {
      position: absolute !important; top: 0 !important; left: 0 !important;
      width: 100% !important; height: 100% !important;
      pointer-events: none !important; margin: 0 !important; padding: 0 !important; border: none !important;
    }
  `;

  function createBackgroundRenderer(options = {}) {
    const doc = options.document || document;
    const win = options.window || window;
    const fetchMediaRecord = options.fetchMediaRecord;
    const onStatusChange = options.onStatusChange || (() => {});

    const originalStylesMap = new Map();
    const restorationConflicts = [];
    const activeLayers = new Map();
    const urlToConsumers = new Map();
    const ownerToUrl = new Map();
    const componentResolutionStatus = new Map();

    let globalSettings = {
      extensionEnabled: true,
      ecoMode: true,
      maxConcurrentVideos: 2,
      respectReducedMotion: true,
      pauseAllBackgroundVideos: false
    };

    let audibleOwnerCompId = null;
    let unifiedSchedulerTimer = null;
    let sharedIntersectionObserver = null;
    let sharedResizeObserver = null;
    let visibilityListenerBound = false;
    let rebalancePromise = null;
    let rebalanceQueued = false;

    const videoManagerApi = (typeof ChameleonVideoManager !== "undefined" ? ChameleonVideoManager : globalScope.ChameleonVideoManager);
    const videoPlaybackManager = videoManagerApi && typeof videoManagerApi.createVideoPlaybackManager === "function"
      ? videoManagerApi.createVideoPlaybackManager({
          document: doc,
          window: win,
          onStateChange: () => {
            try { onStatusChange(getDiagnostics()); } catch (_) {}
          }
        })
      : null;

    if (videoPlaybackManager) {
      const origYield = videoPlaybackManager.yieldAudioFocus.bind(videoPlaybackManager);
      videoPlaybackManager.yieldAudioFocus = (compId) => {
        if (!compId || audibleOwnerCompId === compId) {
          audibleOwnerCompId = null;
        }
        for (const [id, layer] of activeLayers.entries()) {
          if (layer.videoEl && (!compId || id === compId)) {
            layer.videoEl.muted = true;
          }
        }
        return origYield(compId);
      };
    }

    // =======================================================================
    // 1. CONFLICT-AWARE INLINE STYLE REGISTRY
    // =======================================================================
    function setRecordedInlineStyle(el, prop, value, priority = "", ownerCompId = "chameleon") {
      if (!el || !el.style) return;
      let propMap = originalStylesMap.get(el);
      if (!propMap) {
        propMap = new Map();
        originalStylesMap.set(el, propMap);
      }

      const currentVal = el.style.getPropertyValue(prop);
      const currentPrio = el.style.getPropertyPriority(prop);

      if (!propMap.has(prop)) {
        el.style.setProperty(prop, value, priority);
        const readBackVal = el.style.getPropertyValue(prop);
        const readBackPrio = el.style.getPropertyPriority(prop);

        propMap.set(prop, {
          hadProperty: currentVal !== "",
          originalValue: currentVal,
          originalPriority: currentPrio,
          appliedValue: readBackVal,
          appliedPriority: readBackPrio,
          ownerCompId
        });
      } else {
        const entry = propMap.get(prop);
        const wasMutatedByWebsite =
          currentVal !== entry.appliedValue || currentPrio !== entry.appliedPriority;

        if (wasMutatedByWebsite) {
          entry.hadProperty = currentVal !== "";
          entry.originalValue = currentVal;
          entry.originalPriority = currentPrio;
        }

        el.style.setProperty(prop, value, priority);
        entry.appliedValue = el.style.getPropertyValue(prop);
        entry.appliedPriority = el.style.getPropertyPriority(prop);
        entry.ownerCompId = ownerCompId;
      }
    }

    function restoreElementInlineStyles(el, filterOwnerCompId = null) {
      if (!el || !el.style) return;
      const propMap = originalStylesMap.get(el);
      if (!propMap) return;

      for (const [prop, entry] of Array.from(propMap.entries())) {
        if (filterOwnerCompId && entry.ownerCompId && entry.ownerCompId !== filterOwnerCompId) {
          continue;
        }

        const currentVal = el.style.getPropertyValue(prop);
        const currentPrio = el.style.getPropertyPriority(prop);
        const isStillOwnedByChameleon =
          currentVal === entry.appliedValue && currentPrio === entry.appliedPriority;

        if (isStillOwnedByChameleon) {
          if (!entry.hadProperty || entry.originalValue === "" || entry.originalValue === null || entry.originalValue === undefined) {
            el.style.removeProperty(prop);
          } else {
            el.style.setProperty(prop, entry.originalValue, entry.originalPriority || "");
          }
        } else {
          restorationConflicts.push({
            compId: entry.ownerCompId || "unknown",
            elementTag: (el.tagName || "element").toLowerCase(),
            elementId: el.id || null,
            property: prop,
            originalValue: entry.originalValue,
            chameleonAppliedValue: entry.appliedValue,
            websiteCurrentValue: currentVal,
            action: "preserved-website-mutation"
          });
        }

        propMap.delete(prop);
      }

      if (propMap.size === 0) {
        originalStylesMap.delete(el);
      }
    }

    // =======================================================================
    // 2. OWNER-TRACKED OBJECT URL REGISTRY (IDEMPOTENT CLEANUP)
    // =======================================================================
    function acquireObjectUrlForOwner(blob, ownerKey) {
      if (!blob || !ownerKey || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
        return null;
      }
      releaseObjectUrlForOwner(ownerKey);

      const url = URL.createObjectURL(blob);
      ownerToUrl.set(ownerKey, url);
      let consumers = urlToConsumers.get(url);
      if (!consumers) {
        consumers = new Set();
        urlToConsumers.set(url, consumers);
      }
      consumers.add(ownerKey);
      return url;
    }

    function releaseObjectUrlForOwner(ownerKey) {
      if (!ownerKey) return;
      const url = ownerToUrl.get(ownerKey);
      if (!url) return;
      ownerToUrl.delete(ownerKey);

      const consumers = urlToConsumers.get(url);
      if (consumers) {
        consumers.delete(ownerKey);
        if (consumers.size === 0) {
          urlToConsumers.delete(url);
          try {
            URL.revokeObjectURL(url);
          } catch (_) {}
        }
      } else {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }
    }

    function revokeAllObjectUrls() {
      for (const url of Array.from(urlToConsumers.keys())) {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }
      urlToConsumers.clear();
      ownerToUrl.clear();
    }

    // =======================================================================
    // 3. SHARED OBSERVERS (INTERSECTION + RESIZE + VISIBILITY)
    // =======================================================================
    function ensureSharedObservers() {
      if (!sharedIntersectionObserver && typeof win.IntersectionObserver === "function") {
        sharedIntersectionObserver = new win.IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              for (const layer of activeLayers.values()) {
                if (layer.targetEl === entry.target && layer.videoState !== "disposed") {
                  layer.isIntersecting = entry.isIntersecting;
                }
              }
            }
            rebalanceActiveVideos();
          },
          { threshold: 0.02 }
        );
      }

      if (!sharedResizeObserver && typeof win.ResizeObserver === "function") {
        sharedResizeObserver = new win.ResizeObserver((entries) => {
          for (const entry of entries) {
            for (const layer of activeLayers.values()) {
              if (layer.targetEl === entry.target && layer.wrapEl && layer.mode === "mode-b" && layer.videoState !== "disposed") {
                syncLayerGeometry(layer);
              }
            }
          }
        });
      }

      if (!visibilityListenerBound && doc.addEventListener) {
        doc.addEventListener("visibilitychange", onDocumentVisibilityChange);
        visibilityListenerBound = true;
      }
    }

    function onDocumentVisibilityChange() {
      if (videoPlaybackManager) {
        videoPlaybackManager.setVisibilityPause(doc.hidden);
      }
      if (doc.hidden) {
        for (const layer of activeLayers.values()) {
          if (layer.videoEl && layer.videoState !== "disposed") {
            layer.videoEl.pause();
            if (layer.videoState === "active") {
              layer.videoState = "paused";
            }
          }
        }
      } else {
        rebalanceActiveVideos();
        tickUnifiedPlaylistScheduler();
      }
    }

    function syncLayerGeometry(layer) {
      if (!layer || !layer.targetEl || !layer.wrapEl || layer.mode !== "mode-b") return;
      const sh = Math.max(layer.targetEl.scrollHeight || 0, layer.targetEl.clientHeight || 0);
      if (sh > 0 && layer.targetEl.scrollHeight > layer.targetEl.clientHeight * 1.05) {
        layer.wrapEl.style.setProperty("height", `${sh}px`, "important");
      } else {
        layer.wrapEl.style.setProperty("height", "100%", "important");
      }
    }

    // =======================================================================
    // 4. DETERMINISTIC PER-VIDEO LIFECYCLE STATE MACHINE
    // =======================================================================
    function rebalanceActiveVideos() {
      rebalanceQueued = true;
      if (rebalancePromise) return rebalancePromise;

      const task = (async () => {
        await Promise.resolve();
        try {
          while (rebalanceQueued) {
            rebalanceQueued = false;
            const maxVideos = Math.max(1, Number(globalSettings.maxConcurrentVideos) || 2);
            const globallyPaused = Boolean(doc.hidden || globalSettings.pauseAllBackgroundVideos === true);
            const allVideoLayers = Array.from(activeLayers.values()).filter((layer) =>
              layer.videoState !== "disposed" && layer.videoEl && layer.mediaType === "video"
            );
            for (const layer of allVideoLayers) {
              const shouldPlayOnce = layer.config?.rotationWaitForVideoEnd === true && Number(layer.config?.rotationIntervalSec || 0) > 0 && Array.isArray(layer.config?.playlist) && layer.config.playlist.length > 1;
              layer.videoEl.loop = !shouldPlayOnce;
            }
            const eligibleLayers = globallyPaused ? [] : allVideoLayers.filter((layer) =>
              layer.isIntersecting !== false && layer.config?.videoPaused !== true && !layer.waitingAtEndForRotation
            ).slice(0, maxVideos);
            const eligibleSet = new Set(eligibleLayers);
            // Only one eligible layer may be audible. Others remain muted even if their
            // component preferences request sound, preventing overlapping background audio.
            const audibleCandidates = eligibleLayers.filter((layer) =>
              layer.config?.videoMuted === false && Number(layer.config?.videoVolume ?? 35) > 0 && !layer.audioPlaybackBlocked
            );
            audibleCandidates.sort((a, b) => Number(b.config?.videoAudioRequestedAt || 0) - Number(a.config?.videoAudioRequestedAt || 0));
            const audibleOwner = audibleCandidates[0] || null;
            const prevAudibleOwnerCompId = audibleOwnerCompId;
            audibleOwnerCompId = audibleOwner ? audibleOwner.compId : null;
            if (audibleOwnerCompId && audibleOwnerCompId !== prevAudibleOwnerCompId && videoPlaybackManager) {
              videoPlaybackManager.requestGlobalAudioFocus(audibleOwnerCompId);
            } else if (!audibleOwnerCompId && prevAudibleOwnerCompId && videoPlaybackManager) {
              videoPlaybackManager.releaseGlobalAudioFocus(prevAudibleOwnerCompId);
            }

            for (const layer of allVideoLayers) {
              const eligibleToPlay = eligibleSet.has(layer);
              const wantsAudio = layer.config?.videoMuted === false && Number(layer.config?.videoVolume ?? 35) > 0;
              const isAudibleOwner = layer.compId === audibleOwnerCompId && wantsAudio;
              const volume = Math.max(0, Math.min(1, Number(layer.config?.videoVolume ?? 35) / 100));

              if (!eligibleToPlay) {
                layer.videoEl.muted = true;
                layer.videoEl.volume = volume;
                if (!layer.videoEl.paused) layer.videoEl.pause();
                if (layer.videoState === "active") layer.videoState = "paused";
                const shouldUnload = globalSettings.ecoMode && !layer.videoUnloaded && (
                  globallyPaused || layer.config?.videoPaused === true || allVideoLayers.indexOf(layer) >= maxVideos
                );
                if (shouldUnload) unloadVideoSource(layer);
                continue;
              }

              if (layer.videoState === "unloaded" || layer.videoUnloaded) {
                await restoreUnloadedVideoSource(layer);
              }
              if (layer.videoState === "disposed" || !layer.videoEl) continue;
              layer.videoEl.volume = volume;
              layer.videoEl.muted = !isAudibleOwner;
              layer.videoState = "active";

              if (layer.videoEl.paused) {
                try {
                  await layer.videoEl.play();
                  layer.audioPlaybackBlocked = false;
                } catch (_) {
                  // Never bypass autoplay policy. If audible playback is rejected,
                  // fall back to muted playback and suppress repeated attempts until
                  // the user changes the audio preference.
                  if (isAudibleOwner) {
                    layer.audioPlaybackBlocked = true;
                    layer.videoEl.muted = true;
                    if (videoPlaybackManager) {
                      videoPlaybackManager.showInPageAudioPrompt(layer.compId);
                    }
                  }
                  try {
                    layer.videoEl.muted = true;
                    await layer.videoEl.play();
                    layer.videoState = "active";
                  } catch (_) {
                    layer.videoState = "paused";
                  }
                }
              } else if (!isAudibleOwner) {
                layer.videoEl.muted = true;
              }
            }
          }
        } finally {
          rebalancePromise = null;
        }
      })();
      rebalancePromise = task;
      return task;
    }

    function unloadVideoSource(layer) {
      if (!layer || layer.videoState === "disposed" || !layer.videoEl || layer.videoUnloaded) return;
      layer.opToken++;
      if (layer.abortController) {
        try { layer.abortController.abort(); } catch (_) {}
        layer.abortController = null;
      }
      layer.inFlightLoadPromise = null;
      const prevTime = Number(layer.videoEl.currentTime);
      if (Number.isFinite(prevTime) && prevTime > 0) {
        layer.savedCurrentTime = prevTime;
      }
      layer.videoEl.pause();
      releaseObjectUrlForOwner(layer.ownerKey);
      layer.objectUrl = null;
      layer.videoEl.removeAttribute("src");
      try {
        layer.videoEl.load();
      } catch (_) {}
      layer.videoUnloaded = true;
      layer.videoState = "unloaded";
    }

    async function restoreUnloadedVideoSource(layer) {
      if (!layer || layer.videoState === "disposed" || !layer.videoEl || !layer.activeMediaId) return;
      if (layer.inFlightLoadPromise) {
        return layer.inFlightLoadPromise;
      }
      if (!layer.videoUnloaded && layer.videoState !== "unloaded") return;
      if (typeof fetchMediaRecord !== "function") return;

      const token = ++layer.opToken;
      layer.videoState = "loading";
      const abortCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      layer.abortController = abortCtrl;

      const loadTask = (async () => {
        try {
          const res = await fetchMediaRecord(layer.activeMediaId, abortCtrl ? abortCtrl.signal : null);
          if (layer.videoState === "disposed" || layer.opToken !== token || !layer.videoEl) {
            return;
          }
          if (!res || !res.found || !res.blob) {
            layer.videoState = "failed";
            return;
          }
          const newUrl = acquireObjectUrlForOwner(res.blob, layer.ownerKey);
          if (layer.videoState === "disposed" || layer.opToken !== token || !layer.videoEl) {
            releaseObjectUrlForOwner(layer.ownerKey);
            return;
          }
          layer.objectUrl = newUrl;
          layer.videoEl.src = newUrl;
          if (Number.isFinite(layer.savedCurrentTime) && layer.savedCurrentTime > 0) {
            const resumeTime = layer.savedCurrentTime;
            const applyResumeTime = () => {
              try {
                if (layer.videoEl && resumeTime > 0 && (!Number.isFinite(layer.videoEl.duration) || resumeTime < layer.videoEl.duration)) {
                  layer.videoEl.currentTime = resumeTime;
                }
              } catch (_) {}
            };
            applyResumeTime();
            if (typeof layer.videoEl.addEventListener === "function") {
              layer.videoEl.addEventListener("loadedmetadata", applyResumeTime, { once: true });
            }
          }
          layer.videoUnloaded = false;
          layer.videoState = "paused";
        } catch (_) {
          if (layer.videoState !== "disposed" && layer.opToken === token) {
            layer.videoState = "failed";
          }
        } finally {
          if (layer.opToken === token) {
            layer.inFlightLoadPromise = null;
            layer.abortController = null;
          }
        }
      })();

      layer.inFlightLoadPromise = loadTask;
      return loadTask;
    }

    // =======================================================================
    // 5. UNIFIED PLAYLIST SCHEDULER
    // =======================================================================
    function ensureUnifiedScheduler() {
      let hasRotatingComponent = false;
      for (const layer of activeLayers.values()) {
        const intervalSec = Number(layer.config?.rotationIntervalSec || 0);
        if (intervalSec > 0 && Array.isArray(layer.config?.playlist) && layer.config.playlist.length > 1) {
          hasRotatingComponent = true;
          break;
        }
      }

      if (!hasRotatingComponent) {
        if (unifiedSchedulerTimer) {
          clearInterval(unifiedSchedulerTimer);
          unifiedSchedulerTimer = null;
        }
        return;
      }

      if (!unifiedSchedulerTimer) {
        unifiedSchedulerTimer = setInterval(() => {
          if (doc.hidden) return;
          tickUnifiedPlaylistScheduler();
        }, 1000);
      }
    }

    async function advancePlaylistLayer(layer) {
      if (!layer || layer.videoState === "disposed") return;
      const cfg = layer.config;
      if (!cfg || !Array.isArray(cfg.playlist) || cfg.playlist.length <= 1) return;
      if (cfg.shuffle) {
        const current = layer.playlistIndex;
        let next = Math.floor(Math.random() * cfg.playlist.length);
        if (next === current) next = (next + 1) % cfg.playlist.length;
        layer.playlistIndex = next;
      } else layer.playlistIndex = (layer.playlistIndex + 1) % cfg.playlist.length;
      const nextMediaId = cfg.playlist[layer.playlistIndex];
      cfg.activeMediaId = nextMediaId;
      layer.rotationPendingUntilVideoEnds = false;
      layer.waitingAtEndForRotation = false;
      const intervalSec = Number(cfg.rotationIntervalSec || 0);
      layer.nextRotationAt = intervalSec > 0 ? Date.now() + intervalSec * 1000 : null;
      await mountOrUpdateMediaOnLayer(layer, nextMediaId);
    }

    async function tickUnifiedPlaylistScheduler(forceAdvanceAll = false) {
      if (doc.hidden && !forceAdvanceAll) return;
      const now = Date.now();
      for (const layer of activeLayers.values()) {
        if (layer.videoState === "disposed") continue;
        const cfg = layer.config;
        if (!cfg || !Array.isArray(cfg.playlist) || cfg.playlist.length <= 1) continue;
        const intervalSec = Number(cfg.rotationIntervalSec || 0);
        if (intervalSec <= 0) continue;
        // Once the interval has elapsed while a clip is still running, leave the
        // rotation pending until that clip's `ended` event advances the playlist.
        // Do not restart the timer simply because nextRotationAt was cleared.
        if (!forceAdvanceAll && layer.rotationPendingUntilVideoEnds) continue;
        if (!forceAdvanceAll && !layer.nextRotationAt) { layer.nextRotationAt = now + intervalSec * 1000; continue; }
        if (forceAdvanceAll || now >= layer.nextRotationAt) {
          const waitForVideoEnd = cfg.rotationWaitForVideoEnd === true && layer.mediaType === "video" && layer.videoEl;
          if (!forceAdvanceAll && waitForVideoEnd && !layer.videoEl.ended) {
            layer.rotationPendingUntilVideoEnds = true;
            layer.waitingAtEndForRotation = false;
            layer.nextRotationAt = null;
            continue;
          }
          layer.rotationPendingUntilVideoEnds = false;
          layer.waitingAtEndForRotation = false;
          await advancePlaylistLayer(layer);
        }
      }
      await rebalanceActiveVideos();
    }

    // =======================================================================
    // 6. LAYER CREATION, STYLING & 3-MODE RENDERING
    // =======================================================================
    async function applySiteCustomizations(siteConfig, settings = {}, selectionEngine = null) {
      globalSettings = { ...globalSettings, ...settings };
      componentResolutionStatus.clear();

      if (!globalSettings.extensionEnabled || !siteConfig || siteConfig.enabled === false) {
        teardownAllLayers();
        onStatusChange(getDiagnostics());
        return getDiagnostics();
      }

      ensureSharedObservers();

      const componentsMap = siteConfig.components || {};
      const desiredIds = new Set(Object.keys(componentsMap));

      for (const existingId of Array.from(activeLayers.keys())) {
        const cfg = componentsMap[existingId];
        if (!desiredIds.has(existingId) || !cfg || cfg.enabled === false || getEffectivePlaylist(cfg).length === 0) {
          removeLayer(existingId);
        }
      }

      for (const [compId, compCfg] of Object.entries(componentsMap)) {
        if (!compCfg || compCfg.enabled === false) continue;
        const playlist = getEffectivePlaylist(compCfg);
        if (playlist.length === 0) {
          removeLayer(compId);
          continue;
        }

        const locator = compCfg.locator || {
          id: compId,
          isWholePage: compId === "root_page" || compId === "body",
          label: compCfg.friendlyName || (compId === "root_page" ? "Entire Website" : "Page Area"),
          fallbackSelector: compId === "root_page" ? "body" : compId
        };

        let resolution = {
          status: "matched",
          element: compId === "root_page" || compId === "body" ? doc.body : doc.querySelector(locator.fallbackSelector || compId),
          score: 100,
          reason: "Direct match"
        };

        if (selectionEngine && typeof selectionEngine.resolveComponentLocator === "function") {
          resolution = selectionEngine.resolveComponentLocator(locator, doc, win);
        }

        componentResolutionStatus.set(compId, {
          id: compId,
          label: compCfg.friendlyName || locator.label || compId,
          status: resolution.status,
          score: resolution.score,
          reason: resolution.reason
        });

        if (resolution.status !== "matched" || !resolution.element) {
          removeLayer(compId);
          continue;
        }

        await renderComponentLayer(compId, resolution.element, compCfg, selectionEngine);
      }

      ensureUnifiedScheduler();
      await rebalanceActiveVideos();
      onStatusChange(getDiagnostics());
      return getDiagnostics();
    }

    function getEffectivePlaylist(compCfg) {
      if (!compCfg) return [];
      if (Array.isArray(compCfg.playlist) && compCfg.playlist.length > 0) {
        return compCfg.playlist.filter(Boolean);
      }
      if (compCfg.activeMediaId) {
        return [compCfg.activeMediaId];
      }
      return [];
    }

    function ensureFrameStylesheet(targetDoc) {
      if (!targetDoc || targetDoc === doc || !targetDoc.head) return;
      if (targetDoc.getElementById("chameleon-frame-layer-styles")) return;
      const style = targetDoc.createElement("style");
      style.id = "chameleon-frame-layer-styles";
      style.setAttribute("data-chameleon-owned", "true");
      style.textContent = INJECTED_FRAME_CSS;
      targetDoc.head.appendChild(style);
    }

    async function renderComponentLayer(compId, targetEl, compCfg, selectionEngine) {
      const ownerDoc = targetEl.ownerDocument || doc;
      const ownerWin = ownerDoc.defaultView || win;
      ensureFrameStylesheet(ownerDoc);

      const suitability = selectionEngine && typeof selectionEngine.assessElementSuitability === "function"
        ? selectionEngine.assessElementSuitability(targetEl, ownerWin)
        : { suitable: true, recommendedMode: targetEl === doc.body ? "mode-a" : "mode-b" };

      if (!suitability.suitable) {
        componentResolutionStatus.set(compId, {
          id: compId,
          label: compCfg.friendlyName || compId,
          status: "unsupported",
          reason: suitability.reason || "Element cannot safely host a background."
        });
        removeLayer(compId);
        return;
      }

      const mode = compCfg.renderModeOverride || suitability.recommendedMode || (targetEl === doc.body ? "mode-a" : "mode-b");
      let layer = activeLayers.get(compId);

      if (layer && (layer.targetEl !== targetEl || layer.mode !== mode || (layer.wrapEl && !targetEl.contains(layer.wrapEl)))) {
        removeLayer(compId);
        layer = null;
      }

      if (!layer) {
        layer = createLayerStructure(compId, targetEl, ownerDoc, ownerWin, mode, compCfg);
        activeLayers.set(compId, layer);
      } else {
        const audioPreferenceChanged = layer.config?.videoMuted !== compCfg.videoMuted ||
          Number(layer.config?.videoVolume ?? 35) !== Number(compCfg.videoVolume ?? 35) ||
          Number(layer.config?.videoAudioRequestedAt || 0) !== Number(compCfg.videoAudioRequestedAt || 0);
        if (audioPreferenceChanged) layer.audioPlaybackBlocked = false;
        layer.config = compCfg;
        if (layer.videoEl && videoPlaybackManager) {
          videoPlaybackManager.registerVideo(compId, layer.videoEl, compCfg);
        }
      }

      configureHostElementForMode(layer);

      const playlist = getEffectivePlaylist(compCfg);
      let desiredMediaId = compCfg.activeMediaId && playlist.includes(compCfg.activeMediaId)
        ? compCfg.activeMediaId
        : playlist[layer.playlistIndex % playlist.length];

      if (Number(compCfg.rotationIntervalSec) === -1 && !layer.selectedOnRefresh) {
        layer.selectedOnRefresh = true;
        if (compCfg.shuffle) {
          layer.playlistIndex = Math.floor(Math.random() * playlist.length);
        } else {
          const prevIdx = Math.max(0, playlist.indexOf(compCfg.activeMediaId));
          layer.playlistIndex = (prevIdx + 1) % playlist.length;
        }
        desiredMediaId = playlist[layer.playlistIndex];
        compCfg.activeMediaId = desiredMediaId;
      } else {
        const currentIdx = playlist.indexOf(desiredMediaId);
        if (currentIdx >= 0) {
          layer.playlistIndex = currentIdx;
        }
      }

      const intervalSec = Number(compCfg.rotationIntervalSec || 0);
      if (intervalSec > 0 && playlist.length > 1 && !layer.nextRotationAt) {
        layer.nextRotationAt = Date.now() + intervalSec * 1000;
      } else if (intervalSec <= 0) {
        layer.nextRotationAt = null;
      }

      await mountOrUpdateMediaOnLayer(layer, desiredMediaId);
      applyVisualAdjustments(layer);
    }

    function createLayerStructure(compId, targetEl, ownerDoc, ownerWin, mode, compCfg) {
      const layer = {
        compId,
        ownerKey: `layer:${compId}`,
        targetEl,
        ownerDoc,
        ownerWin,
        mode,
        config: compCfg,
        wrapEl: null,
        mediaEl: null,
        videoEl: null,
        tintEl: null,
        activeMediaId: null,
        mediaType: null,
        objectUrl: null,
        videoUnloaded: false,
        videoState: "unloaded",
        audioPlaybackBlocked: false,
        opToken: 0,
        inFlightLoadPromise: null,
        abortController: null,
        isIntersecting: true,
        playlistIndex: 0,
        nextRotationAt: null,
        selectedOnRefresh: false,
        rotationPendingUntilVideoEnds: false,
        waitingAtEndForRotation: false,
        softenedAncestors: []
      };

      if (mode === "mode-a" || mode === "mode-b") {
        const wrapEl = ownerDoc.createElement("div");
        wrapEl.className = "chameleon-bg-layer-wrap";
        wrapEl.setAttribute("data-chameleon-owned", "true");
        wrapEl.setAttribute("data-chameleon-mode", mode);
        wrapEl.setAttribute("data-chameleon-comp-id", compId);

        const tintEl = ownerDoc.createElement("div");
        tintEl.className = "chameleon-bg-tint";
        tintEl.setAttribute("data-chameleon-owned", "true");
        wrapEl.appendChild(tintEl);

        targetEl.insertBefore(wrapEl, targetEl.firstChild);
        layer.wrapEl = wrapEl;
        layer.tintEl = tintEl;

        if (sharedIntersectionObserver) {
          try { sharedIntersectionObserver.observe(targetEl); } catch (_) {}
        }
        if (sharedResizeObserver && mode === "mode-b") {
          try { sharedResizeObserver.observe(targetEl); } catch (_) {}
        }
      }

      return layer;
    }

    function configureHostElementForMode(layer) {
      const { compId, targetEl, ownerDoc, ownerWin, mode, config } = layer;
      if (!targetEl) return;

      if (mode === "mode-a") {
        setRecordedInlineStyle(ownerDoc.documentElement, "background-color", "transparent", "important", compId);
        setRecordedInlineStyle(ownerDoc.body, "background-color", "transparent", "important", compId);
        setRecordedInlineStyle(ownerDoc.body, "isolation", "isolate", "important", compId);

        if (config.softenOpaqueWrappers !== false) {
          const topContainers = Array.from(ownerDoc.querySelectorAll("body > div, body > main, #app, #root, main")).slice(0, 6);
          const vw = Math.max(ownerWin.innerWidth || 1024, 1);
          const backdropBlurPx = Math.max(0, Math.min(24, Number(config.backdropBlurPx ?? 0)));
          for (const el of topContainers) {
            if (el.hasAttribute("data-chameleon-owned")) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < vw * 0.8) continue;
            const computedBg = ownerWin.getComputedStyle(el).backgroundColor;
            if (computedBg && computedBg !== "rgba(0, 0, 0, 0)" && computedBg !== "transparent") {
              const rgbMatch = computedBg.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[\s,/]+([0-9.]+))?\s*\)/);
              if (rgbMatch) {
                const alpha = rgbMatch[4] !== undefined ? parseFloat(rgbMatch[4]) : 1;
                if (alpha > 0.88) {
                  setRecordedInlineStyle(el, "background-color", `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, 0.72)`, "", compId);
                  if (backdropBlurPx > 0) {
                    setRecordedInlineStyle(el, "backdrop-filter", `blur(${backdropBlurPx}px)`, "", compId);
                  } else {
                    restoreElementInlineStyles(el, compId);
                    setRecordedInlineStyle(el, "background-color", `rgba(${rgbMatch[1]}, ${rgbMatch[2]}, ${rgbMatch[3]}, 0.72)`, "", compId);
                  }
                  if (!layer.softenedAncestors.includes(el)) {
                    layer.softenedAncestors.push(el);
                  }
                }
              }
            }
          }
        }
      } else if (mode === "mode-b") {
        const computed = ownerWin.getComputedStyle(targetEl);
        if (computed.position === "static") {
          setRecordedInlineStyle(targetEl, "position", "relative", "important", compId);
        }
        if (computed.isolation !== "isolate") {
          setRecordedInlineStyle(targetEl, "isolation", "isolate", "important", compId);
        }
        syncLayerGeometry(layer);
      }
    }

    async function mountOrUpdateMediaOnLayer(layer, requestedMediaId) {
      if (!layer || layer.videoState === "disposed") return;
      const playlist = getEffectivePlaylist(layer.config);
      if (playlist.length === 0) return;

      if (layer.activeMediaId === requestedMediaId && (layer.mediaEl || layer.mode === "mode-c") && !layer.videoUnloaded) {
        return;
      }

      const token = ++layer.opToken;
      if (layer.abortController) {
        try { layer.abortController.abort(); } catch (_) {}
        layer.abortController = null;
      }
      layer.inFlightLoadPromise = null;

      const abortCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      layer.abortController = abortCtrl;
      layer.videoState = "loading";

      let recordBundle = null;
      let resolvedId = requestedMediaId;

      const candidateIds = [
        requestedMediaId,
        ...playlist.filter((id) => id !== requestedMediaId)
      ].filter(Boolean);

      for (const candidateId of candidateIds) {
        if (typeof fetchMediaRecord === "function") {
          try {
            const res = await fetchMediaRecord(candidateId, abortCtrl ? abortCtrl.signal : null);
            if (layer.videoState === "disposed" || layer.opToken !== token) return;
            if (res && res.found && (res.record || res.blob)) {
              recordBundle = res;
              resolvedId = candidateId;
              break;
            }
          } catch (_) {
            if (layer.videoState === "disposed" || layer.opToken !== token) return;
          }
        }
      }

      if (layer.videoState === "disposed" || layer.opToken !== token) return;

      if (!recordBundle) {
        layer.videoState = "failed";
        componentResolutionStatus.set(layer.compId, {
          id: layer.compId,
          label: layer.config?.friendlyName || layer.compId,
          status: "missing-media",
          reason: "Assigned media item was deleted or could not be loaded."
        });
        return;
      }

      releaseObjectUrlForOwner(layer.ownerKey);
      layer.objectUrl = null;

      if (layer.mediaEl) {
        if (layer.videoEl) {
          if (videoPlaybackManager) videoPlaybackManager.unregisterVideo(layer.compId);
          layer.videoEl.pause();
          layer.videoEl.removeAttribute("src");
        }
        layer.mediaEl.remove();
        layer.mediaEl = null;
        layer.videoEl = null;
      }

      const rec = recordBundle.record || {};
      const blob = recordBundle.blob || null;
      layer.rotationPendingUntilVideoEnds = false;
      layer.waitingAtEndForRotation = false;
      layer.effectiveVideoEndSec = null;
      layer._lastLoopRestartAt = 0;
      layer.activeMediaId = resolvedId;
      layer.mediaType = rec.mediaType || (blob && blob.type.startsWith("video/") ? "video" : "image");
      layer.videoUnloaded = false;

      if (layer.mode === "mode-c" && layer.mediaType === "video") {
        // Promote mode-c container to mode-b so <video> can be mounted
        const tag = (layer.targetEl?.tagName || "").toUpperCase();
        if (!["IMG", "INPUT", "BR", "HR", "IFRAME", "VIDEO", "AUDIO", "CANVAS"].includes(tag)) {
          layer.mode = "mode-b";
          const ownerDoc = layer.ownerDoc || doc;
          const wrapEl = ownerDoc.createElement("div");
          wrapEl.className = "chameleon-bg-layer-wrap";
          wrapEl.setAttribute("data-chameleon-owned", "true");
          wrapEl.setAttribute("data-chameleon-mode", "mode-b");
          wrapEl.setAttribute("data-chameleon-comp-id", layer.compId);
          const tintEl = ownerDoc.createElement("div");
          tintEl.className = "chameleon-bg-tint";
          tintEl.setAttribute("data-chameleon-owned", "true");
          wrapEl.appendChild(tintEl);
          layer.targetEl.insertBefore(wrapEl, layer.targetEl.firstChild);
          layer.wrapEl = wrapEl;
          layer.tintEl = tintEl;
          configureHostElementForMode(layer);
        }
      }

      if (layer.mode === "mode-c") {
        layer.videoState = "paused";
        if (rec.mediaType === "preset" && rec.gradient) {
          setRecordedInlineStyle(layer.targetEl, "background-image", rec.gradient, "important", layer.compId);
        } else if (blob) {
          const objUrl = acquireObjectUrlForOwner(blob, layer.ownerKey);
          layer.objectUrl = objUrl;
          setRecordedInlineStyle(layer.targetEl, "background-image", `url("${objUrl}")`, "important", layer.compId);
        }
        return;
      }

      const ownerDoc = layer.ownerDoc || doc;
      if (layer.mediaType === "video" && blob) {
        const videoEl = ownerDoc.createElement("video");
        videoEl.className = "chameleon-bg-media";
        videoEl.setAttribute("data-chameleon-owned", "true");
        videoEl.muted = true; // Always start muted; preferences are applied by the shared playback manager.
        videoEl.volume = Math.max(0, Math.min(1, Number(layer.config?.videoVolume ?? 35) / 100));
        const shouldPlayOnce = layer.config?.rotationWaitForVideoEnd === true &&
          Number(layer.config?.rotationIntervalSec || 0) > 0 &&
          Array.isArray(layer.config?.playlist) &&
          layer.config.playlist.length > 1;
        videoEl.loop = !shouldPlayOnce;
        if (!shouldPlayOnce) {
          videoEl.setAttribute("loop", "");
        }
        videoEl.playsInline = true;
        videoEl.preload = "auto";

        const objUrl = acquireObjectUrlForOwner(blob, layer.ownerKey);
        layer.objectUrl = objUrl;
        layer.sourceBlob = blob;
        videoEl.src = objUrl;
        layer.videoState = "paused";
        layer.savedCurrentTime = 0;

        // Pre-compute exact video track duration from MP4 container (`moov -> trak -> mdhd/tkhd/elst/stts/stsz`)
        // or apply user-configured Loop End Cutoff (`videoLoopEndSec`) so even the VERY FIRST loop wraps
        // immediately where the visual video ends without playing a trailing audio tail on a frozen frame!
        const userLoopStartSec = Math.max(0, Number(layer.config?.videoLoopStartSec || 0));
        const userLoopEndSec = Math.max(0, Number(layer.config?.videoLoopEndSec || 0));
        if (userLoopEndSec > 0.25 && userLoopEndSec > userLoopStartSec + 0.2) {
          layer.effectiveVideoEndSec = userLoopEndSec;
        } else if (rec && typeof rec.videoTrackDuration === "number" && rec.videoTrackDuration > 0.25) {
          if (!rec.audioTrackDuration || rec.audioTrackDuration > rec.videoTrackDuration + 0.08) {
            layer.effectiveVideoEndSec = Math.max(0.25, rec.videoTrackDuration - 0.06);
          }
        }
        if (userLoopStartSec > 0) {
          try { videoEl.currentTime = userLoopStartSec; } catch (_) {}
        }
        if (
          !layer.effectiveVideoEndSec &&
          typeof globalScope.ChameleonStorageService?.extractMp4TrackDurations === "function" &&
          (rec.mimeType === "video/mp4" || (blob.type && blob.type.includes("mp4")) || !blob.type)
        ) {
          globalScope.ChameleonStorageService.extractMp4TrackDurations(blob).then((mp4Meta) => {
            if (layer.videoState === "disposed" || layer.videoEl !== videoEl || !mp4Meta) return;
            const cfgEnd = Math.max(0, Number(layer.config?.videoLoopEndSec || 0));
            if (cfgEnd > 0.25) {
              layer.effectiveVideoEndSec = cfgEnd;
              return;
            }
            const vDur = Number(mp4Meta.videoTrackDuration || 0);
            const aDur = Number(mp4Meta.audioTrackDuration || 0);
            const mDur = Number(mp4Meta.movieDuration || videoEl.duration || 0);
            const maxOtherDur = Math.max(aDur, mDur);
            if (vDur > 0.25 && (maxOtherDur > vDur + 0.08 || (Number.isFinite(videoEl.duration) && videoEl.duration > vDur + 0.08))) {
              layer.effectiveVideoEndSec = Math.max(0.25, vDur - 0.06);
            } else if (vDur > 0.25 && !layer.effectiveVideoEndSec) {
              // Store parsed video track duration so we can also compare once videoEl.loadedmetadata fires
              layer._parsedVideoTrackDuration = vDur;
            }
          }).catch(() => {});
        }

        videoEl.addEventListener("loadedmetadata", () => {
          if (layer.videoState === "disposed" || layer.videoEl !== videoEl) return;
          const cfgEnd = Math.max(0, Number(layer.config?.videoLoopEndSec || 0));
          if (cfgEnd > 0.25) {
            layer.effectiveVideoEndSec = cfgEnd;
            return;
          }
          const vDur = Number(layer._parsedVideoTrackDuration || rec?.videoTrackDuration || 0);
          if (vDur > 0.25 && Number.isFinite(videoEl.duration) && videoEl.duration > vDur + 0.08) {
            layer.effectiveVideoEndSec = Math.max(0.25, vDur - 0.06);
          }
        });

        videoEl.onerror = () => {
          componentResolutionStatus.set(layer.compId, {
            id: layer.compId,
            label: layer.config?.friendlyName || layer.compId,
            status: "video-error",
            reason: "Video playback failed in this browser tab."
          });
        };

        layer.wrapEl.insertBefore(videoEl, layer.tintEl);
        layer.mediaEl = videoEl;
        layer.videoEl = videoEl;
        if (videoPlaybackManager) {
          videoPlaybackManager.registerVideo(layer.compId, videoEl, layer.config);
        }
        let lastDecodedVideoFrameCount = -1;
        let lastDecodedVideoFrameTime = 0;
        let lastFrameAdvanceTimestamp = 0;
        let lastVisualPixelHash = null;
        let lastVisualPixelTime = 0;
        let lastVisualChangeTimestamp = 0;
        let visualProbeCanvas = null;
        let visualProbeCtx = null;

        const computeVisualFrameHash = () => {
          try {
            if (!videoEl.videoWidth || !videoEl.videoHeight) return null;
            if (!visualProbeCanvas) {
              visualProbeCanvas = ownerDoc.createElement("canvas");
              visualProbeCanvas.width = 8;
              visualProbeCanvas.height = 8;
              visualProbeCtx = visualProbeCanvas.getContext("2d", { willReadFrequently: true });
            }
            if (!visualProbeCtx) return null;
            visualProbeCtx.drawImage(videoEl, 0, 0, 8, 8);
            const data = visualProbeCtx.getImageData(0, 0, 8, 8).data;
            let h = 2166136261 >>> 0;
            for (let i = 0; i < data.length; i += 4) {
              // Quantize by >> 2 so minor compression noise doesn't count as motion
              h ^= (data[i] >> 2);
              h = Math.imul(h, 16777619) >>> 0;
              h ^= (data[i + 1] >> 2);
              h = Math.imul(h, 16777619) >>> 0;
              h ^= (data[i + 2] >> 2);
              h = Math.imul(h, 16777619) >>> 0;
            }
            return h >>> 0;
          } catch (_) {
            return null;
          }
        };

        const getDecodedVideoFrames = () => {
          try {
            if (typeof videoEl.getVideoPlaybackQuality === "function") {
              const q = videoEl.getVideoPlaybackQuality();
              if (q && typeof q.totalVideoFrames === "number") return q.totalVideoFrames;
            }
            if (typeof videoEl.mozParsedFrames === "number") return videoEl.mozParsedFrames;
            if (typeof videoEl.webkitDecodedFrameCount === "number") return videoEl.webkitDecodedFrameCount;
          } catch (_) {}
          return null;
        };

        const restartLoopingLayerVideo = () => {
          if (layer.videoState === "disposed" || layer.videoEl !== videoEl) return;
          if (layer.config?.videoPaused === true || globalSettings.pauseAllBackgroundVideos || doc.hidden || layer.isIntersecting === false) return;
          const now = Date.now();
          if (layer._lastLoopRestartAt && now - layer._lastLoopRestartAt < 250) return;
          layer._lastLoopRestartAt = now;
          lastDecodedVideoFrameCount = -1;
          lastDecodedVideoFrameTime = 0;
          lastFrameAdvanceTimestamp = now;
          lastVisualPixelHash = null;
          lastVisualPixelTime = 0;
          lastVisualChangeTimestamp = now;

          videoEl.loop = true;
          videoEl.setAttribute("loop", "");
          const loopStartSec = Math.max(0, Number(layer.config?.videoLoopStartSec || 0));
          try {
            if (loopStartSec > 0 && (!Number.isFinite(videoEl.duration) || loopStartSec < videoEl.duration - 0.25)) {
              videoEl.currentTime = loopStartSec;
            } else {
              videoEl.currentTime = 0;
            }
          } catch (_) {}
          const attemptResume = () => {
            if (layer.videoState === "disposed" || layer.videoEl !== videoEl) return;
            if (layer.config?.videoPaused === true || globalSettings.pauseAllBackgroundVideos || doc.hidden || layer.isIntersecting === false) return;
            try {
              const p = videoEl.play();
              if (p && typeof p.catch === "function") {
                p.catch(() => {
                  if (!videoEl.muted) {
                    layer.audioPlaybackBlocked = true;
                    videoEl.muted = true;
                    try {
                      const p2 = videoEl.play();
                      if (p2 && typeof p2.catch === "function") p2.catch(() => {});
                    } catch (_) {}
                  }
                });
              }
              layer.videoState = "active";
            } catch (_) {}
          };
          attemptResume();
          if (typeof videoEl.addEventListener === "function") {
            videoEl.addEventListener("seeked", () => {
              if (videoEl.paused) attemptResume();
            }, { once: true });
          }
          setTimeout(() => {
            if (layer.videoState !== "disposed" && layer.videoEl === videoEl &&
                layer.config?.videoPaused !== true && !globalSettings.pauseAllBackgroundVideos && !doc.hidden && layer.isIntersecting !== false) {
              const stuckAtEnd = videoEl.ended || (Number.isFinite(videoEl.duration) && videoEl.duration > 0.25 && videoEl.currentTime >= videoEl.duration - 0.35);
              if (videoEl.paused || stuckAtEnd) {
                if (stuckAtEnd) {
                  try { videoEl.currentTime = 0; } catch (_) {}
                }
                attemptResume();
              }
            }
          }, 80);
          setTimeout(() => {
            if (layer.videoState !== "disposed" && layer.videoEl === videoEl &&
                layer.config?.videoPaused !== true && !globalSettings.pauseAllBackgroundVideos && !doc.hidden && layer.isIntersecting !== false) {
              const stillStuckAtEnd = videoEl.ended || (Number.isFinite(videoEl.duration) && videoEl.duration > 0.25 && videoEl.currentTime >= videoEl.duration - 0.25);
              if ((videoEl.paused || stillStuckAtEnd) && layer.objectUrl) {
                // Hard decoder reset if the Firefox blob: decoder stalled at EOF and ignored currentTime = 0
                try {
                  const wasMuted = videoEl.muted;
                  const prevVol = videoEl.volume;
                  videoEl.src = layer.objectUrl;
                  videoEl.muted = wasMuted;
                  videoEl.volume = prevVol;
                  videoEl.loop = true;
                  try { videoEl.load(); } catch (_) {}
                  attemptResume();
                } catch (_) {}
              }
            }
          }, 260);
        };

        videoEl.addEventListener("timeupdate", () => {
          if (layer.videoState === "disposed" || layer.videoEl !== videoEl) return;
          const interval = Number(layer.config?.rotationIntervalSec || 0);
          const canWaitAndRotate = layer.config?.rotationWaitForVideoEnd === true && interval > 0 && Array.isArray(layer.config?.playlist) && layer.config.playlist.length > 1;
          if (canWaitAndRotate) return;

          const now = Date.now();
          const curTime = Number(videoEl.currentTime || 0);
          const dur = Number(videoEl.duration || 0);
          const userConfiguredEndSec = Math.max(0, Number(layer.config?.videoLoopEndSec || 0));
          const userConfiguredStartSec = Math.max(0, Number(layer.config?.videoLoopStartSec || 0));
          if (userConfiguredEndSec > 0.25 && userConfiguredEndSec > userConfiguredStartSec + 0.2) {
            layer.effectiveVideoEndSec = userConfiguredEndSec;
          }

          // 1. Detect audio/video track duration mismatch or frozen trailing hold frame
          // (where video frames stop changing for >600ms while audio continues playing).
          // Cut the trailing audio tail and loop immediately where the video ends!
          if (!videoEl.paused && !videoEl.ended && curTime > 1.0 && !layer.effectiveVideoEndSec) {
            const frames = getDecodedVideoFrames();
            if (frames !== null && frames > 0) {
              if (frames !== lastDecodedVideoFrameCount || curTime < lastDecodedVideoFrameTime) {
                lastDecodedVideoFrameCount = frames;
                lastDecodedVideoFrameTime = curTime;
                lastFrameAdvanceTimestamp = now;
              } else if (
                lastFrameAdvanceTimestamp > 0 &&
                now - lastFrameAdvanceTimestamp >= 650 &&
                curTime - lastDecodedVideoFrameTime >= 0.45
              ) {
                layer.effectiveVideoEndSec = Math.max(0.5, lastDecodedVideoFrameTime);
                restartLoopingLayerVideo();
                return;
              }
            }

            // Also sample 8x8 visual pixel hash to catch videos where the encoder baked a static hold frame
            // for the remaining 18s of audio (where totalVideoFrames still increments or stays fixed)
            if (Number.isFinite(dur) && dur > 2.5 && dur - curTime > 1.0) {
              const pixHash = computeVisualFrameHash();
              if (pixHash !== null) {
                if (pixHash !== lastVisualPixelHash || curTime < lastVisualPixelTime) {
                  lastVisualPixelHash = pixHash;
                  lastVisualPixelTime = curTime;
                  lastVisualChangeTimestamp = now;
                } else if (
                  lastVisualChangeTimestamp > 0 &&
                  now - lastVisualChangeTimestamp >= 900 &&
                  curTime - lastVisualPixelTime >= 0.8 &&
                  curTime >= Math.min(2.5, dur * 0.2)
                ) {
                  layer.effectiveVideoEndSec = Math.max(0.5, lastVisualPixelTime + 0.1);
                  restartLoopingLayerVideo();
                  return;
                }
              }
            }
          }

          // 2. If we already discovered an earlier video-track EOF on this clip, loop right at that point
          if (layer.effectiveVideoEndSec && curTime >= layer.effectiveVideoEndSec) {
            restartLoopingLayerVideo();
            return;
          }

          // 3. Standard container duration EOF guard
          if (Number.isFinite(dur) && dur > 0.25) {
            if (curTime >= dur - 0.15) {
              if (videoEl.ended || videoEl.paused) {
                restartLoopingLayerVideo();
              } else {
                setTimeout(() => {
                  if (layer.videoState === "disposed" || layer.videoEl !== videoEl) return;
                  if (!canWaitAndRotate && (videoEl.ended || videoEl.paused || videoEl.currentTime >= videoEl.duration - 0.06)) {
                    restartLoopingLayerVideo();
                  }
                }, 90);
              }
            }
          }
        });
        videoEl.addEventListener("ended", () => {
          if (layer.videoState === "disposed" || layer.videoEl !== videoEl) return;
          const interval = Number(layer.config?.rotationIntervalSec || 0);
          const canWaitAndRotate = layer.config?.rotationWaitForVideoEnd === true && interval > 0 && Array.isArray(layer.config?.playlist) && layer.config.playlist.length > 1;
          if (canWaitAndRotate && layer.rotationPendingUntilVideoEnds) {
            layer.videoState = "paused";
            advancePlaylistLayer(layer).then(() => rebalanceActiveVideos()).catch(() => {});
          } else if (canWaitAndRotate) {
            layer.videoState = "paused";
            layer.waitingAtEndForRotation = true;
            rebalanceActiveVideos();
          } else {
            // Single video or standard looping playlist: explicitly restart from 0 if the browser
            // fired `ended` on a blob: stream instead of looping seamlessly.
            restartLoopingLayerVideo();
            rebalanceActiveVideos();
          }
          onStatusChange(getDiagnostics());
        });
      } else {
        const divEl = ownerDoc.createElement("div");
        divEl.className = "chameleon-bg-media";
        divEl.setAttribute("data-chameleon-owned", "true");

        if (rec.mediaType === "preset" && rec.gradient) {
          divEl.style.backgroundImage = rec.gradient;
        } else if (blob) {
          const objUrl = acquireObjectUrlForOwner(blob, layer.ownerKey);
          layer.objectUrl = objUrl;
          divEl.style.backgroundImage = `url("${objUrl}")`;
        }

        layer.videoState = "paused";
        layer.wrapEl.insertBefore(divEl, layer.tintEl);
        layer.mediaEl = divEl;
        layer.videoEl = null;
      }
    }

    function applyVisualAdjustments(layer) {
      if (!layer || !layer.config || layer.videoState === "disposed") return;
      const cfg = layer.config;

      const opacity = Math.min(100, Math.max(0, Number(cfg.opacity ?? 85))) / 100;
      const brightness = Number(cfg.brightness ?? 100);
      const contrast = Number(cfg.contrast ?? 100);
      const saturation = Number(cfg.saturation ?? 100);
      const blur = Math.max(0, Number(cfg.blur ?? 0));
      const tintOpacity = Math.min(95, Math.max(0, Number(cfg.tintOpacity ?? 20))) / 100;
      const tintColor = cfg.tintColor || "#0f172a";
      const fitMode = cfg.fitMode || "cover";

      const filterParts = [];
      if (brightness !== 100) filterParts.push(`brightness(${brightness}%)`);
      if (contrast !== 100) filterParts.push(`contrast(${contrast}%)`);
      if (saturation !== 100) filterParts.push(`saturate(${saturation}%)`);
      if (blur > 0) filterParts.push(`blur(${blur}px)`);
      const filterString = filterParts.length > 0 ? filterParts.join(" ") : "none";

      if (layer.mode === "mode-c") {
        setRecordedInlineStyle(layer.targetEl, "background-size", fitMode === "repeat" ? "280px auto" : fitMode, "important", layer.compId);
        setRecordedInlineStyle(layer.targetEl, "background-repeat", fitMode === "repeat" ? "repeat" : "no-repeat", "important", layer.compId);
        setRecordedInlineStyle(layer.targetEl, "background-position", "center center", "important", layer.compId);
        return;
      }

      if (layer.mediaEl) {
        layer.mediaEl.style.setProperty("opacity", String(opacity), "important");
        layer.mediaEl.style.setProperty("filter", filterString, "important");

        if (layer.mediaEl.tagName === "VIDEO") {
          layer.mediaEl.style.setProperty("object-fit", fitMode === "repeat" ? "cover" : fitMode, "important");
          layer.mediaEl.style.setProperty("object-position", "center center", "important");
          layer.mediaEl.volume = Math.max(0, Math.min(1, Number(cfg.videoVolume ?? 35) / 100));
        } else {
          if (fitMode === "repeat") {
            layer.mediaEl.style.setProperty("background-size", "300px auto", "important");
            layer.mediaEl.style.setProperty("background-repeat", "repeat", "important");
          } else {
            layer.mediaEl.style.setProperty("background-size", fitMode, "important");
            layer.mediaEl.style.setProperty("background-repeat", "no-repeat", "important");
            layer.mediaEl.style.setProperty("background-position", "center center", "important");
          }
        }
      }

      if (layer.tintEl) {
        layer.tintEl.style.setProperty("background-color", hexToRgba(tintColor, tintOpacity), "important");
        const backdropBlurPx = Math.max(0, Math.min(24, Number(cfg.backdropBlurPx ?? 0)));
        if (backdropBlurPx > 0) {
          layer.tintEl.style.setProperty("backdrop-filter", `blur(${backdropBlurPx}px)`, "important");
        } else {
          layer.tintEl.style.removeProperty("backdrop-filter");
        }
      }

      if (layer.targetEl) {
        const textContrastMode = String(cfg.textContrastMode || "none");
        if (textContrastMode === "auto-shadow") {
          setRecordedInlineStyle(layer.targetEl, "text-shadow", "0 1px 4px rgba(0, 0, 0, 0.88), 0 0 10px rgba(0, 0, 0, 0.55)", "important", layer.compId);
        } else if (textContrastMode === "light-halo") {
          setRecordedInlineStyle(layer.targetEl, "text-shadow", "0 1px 4px rgba(255, 255, 255, 0.92), 0 0 10px rgba(255, 255, 255, 0.65)", "important", layer.compId);
        } else if (textContrastMode === "force-light") {
          setRecordedInlineStyle(layer.targetEl, "color", "#f8fafc", "important", layer.compId);
          setRecordedInlineStyle(layer.targetEl, "text-shadow", "0 1px 4px rgba(0, 0, 0, 0.92), 0 0 12px rgba(0, 0, 0, 0.65)", "important", layer.compId);
        } else {
          // Restore only text-shadow/color if previously set while keeping layout styles intact
          setRecordedInlineStyle(layer.targetEl, "text-shadow", "", "", layer.compId);
        }
      }
    }

    // =======================================================================
    // 7. IDEMPOTENT LAYER REMOVAL & FULL TEARDOWN
    // =======================================================================
    function removeLayer(compId) {
      const layer = activeLayers.get(compId);
      if (!layer) return;

      layer.videoState = "disposed";
      layer.opToken++;

      if (layer.abortController) {
        try { layer.abortController.abort(); } catch (_) {}
        layer.abortController = null;
      }
      layer.inFlightLoadPromise = null;

      if (layer.videoEl) {
        if (videoPlaybackManager) {
          videoPlaybackManager.unregisterVideo(compId);
        }
        layer.videoEl.pause();
        layer.videoEl.removeAttribute("src");
        try {
          layer.videoEl.load();
        } catch (_) {}
      }

      releaseObjectUrlForOwner(layer.ownerKey);
      layer.objectUrl = null;

      if (layer.targetEl) {
        if (sharedIntersectionObserver) {
          try { sharedIntersectionObserver.unobserve(layer.targetEl); } catch (_) {}
        }
        if (sharedResizeObserver) {
          try { sharedResizeObserver.unobserve(layer.targetEl); } catch (_) {}
        }
        restoreElementInlineStyles(layer.targetEl, compId);
      }

      if (layer.mode === "mode-a") {
        const ownerDoc = layer.ownerDoc || doc;
        restoreElementInlineStyles(ownerDoc.documentElement, compId);
        restoreElementInlineStyles(ownerDoc.body, compId);
      }

      for (const anc of layer.softenedAncestors || []) {
        restoreElementInlineStyles(anc, compId);
      }

      if (layer.wrapEl) {
        layer.wrapEl.remove();
      }

      activeLayers.delete(compId);
      ensureUnifiedScheduler();
    }

    function teardownAllLayers() {
      for (const compId of Array.from(activeLayers.keys())) {
        removeLayer(compId);
      }
      revokeAllObjectUrls();

      for (const el of Array.from(originalStylesMap.keys())) {
        restoreElementInlineStyles(el, null);
      }
      originalStylesMap.clear();

      if (unifiedSchedulerTimer) {
        clearInterval(unifiedSchedulerTimer);
        unifiedSchedulerTimer = null;
      }
    }

    function destroyAll() {
      if (videoPlaybackManager) {
        try { videoPlaybackManager.destroy(); } catch (_) {}
      }
      teardownAllLayers();
      if (sharedIntersectionObserver) {
        sharedIntersectionObserver.disconnect();
        sharedIntersectionObserver = null;
      }
      if (sharedResizeObserver) {
        sharedResizeObserver.disconnect();
        sharedResizeObserver = null;
      }
      if (visibilityListenerBound && doc.removeEventListener) {
        doc.removeEventListener("visibilitychange", onDocumentVisibilityChange);
        visibilityListenerBound = false;
      }
    }

    async function requestAudiblePlayback(compId) {
      const layer = activeLayers.get(compId);
      if (!layer || layer.videoState === "disposed" || !layer.videoEl || layer.videoUnloaded) return { ok: false, error: "No active background video was found for this component." };
      if (globalSettings.pauseAllBackgroundVideos || doc.hidden || layer.config?.videoPaused === true) return { ok: false, error: "Resume this background video before enabling audio." };
      layer.audioPlaybackBlocked = false;
      layer.config.videoMuted = false;
      layer.config.videoAudioRequestedAt = Date.now();
      if (videoPlaybackManager) {
        videoPlaybackManager.setUserMute(compId, false);
      }
      layer.videoEl.muted = false;
      layer.videoEl.volume = Math.max(0, Math.min(1, Number(layer.config.videoVolume ?? 35) / 100));
      try {
        await layer.videoEl.play();
        layer.videoState = "active";
        await rebalanceActiveVideos();
        return { ok: true, compId };
      } catch (error) {
        layer.videoEl.muted = true; layer.audioPlaybackBlocked = true; layer.videoState = layer.videoEl.paused ? "paused" : "active";
        if (videoPlaybackManager) {
          videoPlaybackManager.showInPageAudioPrompt(compId);
        }
        await rebalanceActiveVideos();
        return { ok: false, error: error?.message || "The browser blocked background audio." };
      }
    }

    function getDiagnostics() {
      const activeList = [];
      let playingVideos = 0;
      for (const [id, layer] of activeLayers.entries()) {
        const isPlaying = Boolean(layer.videoEl && !layer.videoEl.paused && layer.videoState === "active");
        if (isPlaying) playingVideos++;
        const vmState = videoPlaybackManager ? videoPlaybackManager.getVideoState(id) : null;
        activeList.push({
          compId: id,
          mode: layer.mode,
          activeMediaId: layer.activeMediaId,
          mediaType: layer.mediaType,
          videoState: layer.videoState,
          videoUnloaded: layer.videoUnloaded,
          videoPausedByUser: layer.config?.videoPaused === true,
          videoMutedPreference: layer.config?.videoMuted !== false,
          videoVolume: Math.max(0, Math.min(100, Number(layer.config?.videoVolume ?? 35))),
          audioPlaybackBlocked: layer.audioPlaybackBlocked === true,
          isPlaying,
          statusLabel: vmState?.statusLabel || (layer.audioPlaybackBlocked ? "audio-blocked" : (isPlaying ? (layer.config?.videoMuted !== false ? "playing-muted" : "playing-audio") : "paused-by-user")),
          detailedVideoState: vmState
        });
      }
      return {
        activeLayerCount: activeLayers.size,
        allocatedObjectUrlCount: urlToConsumers.size,
        modifiedStyleElementCount: originalStylesMap.size,
        playingVideoCount: playingVideos,
        pauseAllBackgroundVideos: globalSettings.pauseAllBackgroundVideos === true,
        audibleOwnerCompId,
        videoStates: videoPlaybackManager ? videoPlaybackManager.getAllVideoStates() : {},
        activeLayers: activeList,
        resolutionStatuses: Array.from(componentResolutionStatus.values()),
        restorationConflicts: [...restorationConflicts]
      };
    }

    function clearRestorationConflicts() {
      restorationConflicts.length = 0;
    }

    function hexToRgba(hex, alpha) {
      const clean = String(hex || "#0f172a").replace("#", "").trim();
      const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean.padEnd(6, "0");
      const num = parseInt(full.slice(0, 6), 16) || 0;
      const r = (num >> 16) & 255;
      const g = (num >> 8) & 255;
      const b = num & 255;
      return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    return {
      applySiteCustomizations,
      removeLayer,
      teardownAllLayers,
      destroyAll,
      tickUnifiedPlaylistScheduler,
      rebalanceActiveVideos,
      getDiagnostics,
      clearRestorationConflicts,
      requestAudiblePlayback,
      videoPlaybackManager,
      getActiveLayers: () => activeLayers,
      getAllocatedObjectUrls: () => new Set(urlToConsumers.keys()),
      setRecordedInlineStyle,
      restoreElementInlineStyles
    };
  }

  const RendererEngine = {
    createBackgroundRenderer
  };

  globalScope.ChameleonRendererEngine = RendererEngine;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = RendererEngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
