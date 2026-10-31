/**
 * ChameleonBG v2.0.5 — Compact Popup Controller (`popup.js`)
 *
 * Hardening improvements in v2.0.1:
 * - Zero `innerHTML` usage (`replaceChildren()` + `createElement`).
 * - Origin-scoped site identity (`siteKey: https://example.com:8443`) passed to `background.js`
 *   and `studio.html` so different protocols and ports do not collide.
 */

/* global ChameleonStorageService, chrome */
(() => {
  "use strict";

  const previewObjectUrls = new Set();

  function cleanupPreviewUrls() {
    for (const u of previewObjectUrls) {
      try { URL.revokeObjectURL(u); } catch (_) {}
    }
    previewObjectUrls.clear();
  }

  window.addEventListener("unload", cleanupPreviewUrls);

  function sendMessage(payload) {
    return new Promise((resolve) => {
      if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
        return resolve({ ok: false });
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

  document.addEventListener("DOMContentLoaded", async () => {
    const siteHostLabel = document.getElementById("siteHostLabel");
    const siteEnableCheckbox = document.getElementById("siteEnableCheckbox");
    const unsupportedNotice = document.getElementById("unsupportedNotice");
    const unsupportedReasonText = document.getElementById("unsupportedReasonText");
    const customizationStatusText = document.getElementById("customizationStatusText");
    const btnOpenVisualEditor = document.getElementById("btnOpenVisualEditor");
    const btnSelectOnPage = document.getElementById("btnSelectOnPage");
    const btnOpenMediaLibrary = document.getElementById("btnOpenMediaLibrary");
    const btnOpenSettings = document.getElementById("btnOpenSettings");
    const btnOpenWebsites = document.getElementById("btnOpenWebsites");
    const btnResetSite = document.getElementById("btnResetSite");
    const btnRevokeSiteAccess = document.getElementById("btnRevokeSiteAccess");
    const savedMediaStrip = document.getElementById("savedMediaStrip");
    const storageUsageText = document.getElementById("storageUsageText");
    const consentPanel = document.getElementById("siteConsentPanel");
    const consentHostname = document.getElementById("siteConsentHostname");
    const consentOrigin = document.getElementById("siteConsentOrigin");
    const btnConfirmSiteEnable = document.getElementById("btnConfirmSiteEnable");
    const btnKeepSiteDisabled = document.getElementById("btnKeepSiteDisabled");
    const consentFeedback = document.getElementById("siteConsentFeedback");
    const siteAccessStateText = document.getElementById("siteAccessStateText");

    let activeTab = null;
    try {
      if (typeof chrome !== "undefined" && chrome.tabs && chrome.tabs.query) {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        activeTab = tabs[0] || null;
      }
    } catch (_) {}

    let capability = await sendMessage({
      type: "CHAMELEON_CHECK_TAB_CAPABILITY",
      tabId: activeTab?.id
    });

    const currentSiteKey = capability.siteKey || capability.origin || "https://local-page";
    const currentHostname = capability.hostname || "local-page";
    const siteOrigin = capability.origin || currentSiteKey;
    const permissionPattern = capability.originPattern || null;
    siteHostLabel.textContent = capability.supported ? siteOrigin : "Protected Browser Page";
    consentHostname.textContent = currentHostname;
    consentOrigin.textContent = siteOrigin;

    if (!capability.supported) {
      unsupportedNotice.hidden = false;
      unsupportedReasonText.textContent = capability.reason || "This page cannot be customized.";
      siteEnableCheckbox.disabled = true;
      btnOpenVisualEditor.disabled = true;
      btnSelectOnPage.disabled = true;
      btnRevokeSiteAccess.hidden = true;
      siteAccessStateText.textContent = capability.reason || "This browser page is unsupported.";
      siteAccessStateText.dataset.state = "error";
    }

    const overview = await sendMessage({
      type: "CHAMELEON_GET_OVERVIEW",
      siteKey: currentSiteKey,
      hostname: currentHostname
    });

    // Do not accidentally show a theme inherited from another origin as if it were
    // this site's own profile. Cross-subdomain inheritance is a later feature.
    let siteCfg = overview.exactSiteConfig || {
      siteKey: currentSiteKey,
      hostname: currentHostname,
      matchScope: "origin",
      enabled: false,
      revision: 0,
      components: {}
    };
    let permissionGranted = capability.permissionGranted === true;
    let consentAccepted = capability.consentAccepted === true;
    let siteEnabled = capability.siteEnabled === true;
    let runtimeEnabled = capability.runtimeEnabled === true;
    let extensionGloballyEnabled = capability.extensionGloballyEnabled !== false;
    let siteAccess = capability.siteAccess || overview.siteAccess || null;

    function setFeedback(message, isError = false) {
      consentFeedback.textContent = message;
      consentFeedback.hidden = !message;
      consentFeedback.style.color = isError ? "#fecaca" : "#bbf7d0";
    }

    function renderAccessState() {
      siteEnableCheckbox.checked = siteEnabled;
      siteEnableCheckbox.disabled = !capability.supported || (!extensionGloballyEnabled && !siteEnabled);
      btnOpenVisualEditor.disabled = !runtimeEnabled;
      btnSelectOnPage.disabled = !runtimeEnabled;
      btnRevokeSiteAccess.hidden = !(permissionGranted || capability.persistentHostPermissionPresent) || !capability.supported;

      if (!capability.supported) {
        siteAccessStateText.textContent = "Unavailable on this browser page.";
        siteAccessStateText.dataset.state = "error";
      } else if (!extensionGloballyEnabled) {
        siteAccessStateText.textContent = "ChameleonBG is globally paused. Saved site settings are preserved.";
        siteAccessStateText.dataset.state = "off";
      } else if (runtimeEnabled) {
        siteAccessStateText.textContent = "Enabled on this exact origin.";
        siteAccessStateText.dataset.state = "enabled";
      } else if (siteEnabled && capability.injectionError) {
        siteAccessStateText.textContent = capability.injectionError;
        siteAccessStateText.dataset.state = "error";
      } else if (!permissionGranted && capability.persistentHostPermissionPresent) {
        siteAccessStateText.textContent = "Off · confirm site access in ChameleonBG before it can run here.";
        siteAccessStateText.dataset.state = "off";
      } else if (!permissionGranted) {
        siteAccessStateText.textContent = "Off · persistent browser access has not been granted for this host.";
        siteAccessStateText.dataset.state = "off";
      } else if (!consentAccepted) {
        siteAccessStateText.textContent = "Off · review the site-use warning before enabling.";
        siteAccessStateText.dataset.state = "off";
      } else {
        siteAccessStateText.textContent = "Off · your saved settings and media are kept.";
        siteAccessStateText.dataset.state = "off";
      }
    }

    function showConsentPanel() {
      consentPanel.hidden = false;
      setFeedback("");
      btnConfirmSiteEnable.focus();
    }

    function hideConsentPanel() {
      consentPanel.hidden = true;
      setFeedback("");
    }

    if (overview.storageStats) {
      const st = overview.storageStats;
      storageUsageText.textContent = `${st.itemCount} saved • ${st.formattedTotal} used`;
    }

    const configuredEntries = Object.values(siteCfg.components || {}).filter(
      (c) => c && c.enabled !== false && ((c.playlist && c.playlist.length > 0) || c.activeMediaId)
    );
    updateCustomizationStatus();
    renderAccessState();
    await renderSavedMediaStrip(savedMediaStrip, overview.mediaItems || [], activeTab, runtimeEnabled);

    function updateCustomizationStatus() {
      if (configuredEntries.length > 0) {
        customizationStatusText.textContent = configuredEntries.length === 1
          ? `1 area (${configuredEntries[0].friendlyName || "Customized"})`
          : `${configuredEntries.length} areas customized`;
        btnResetSite.hidden = false;
      } else {
        customizationStatusText.textContent = "None configured";
        btnResetSite.hidden = true;
      }
    }

    async function enableSite(acceptedPolicyWarning) {
      if (!activeTab?.id || !capability.supported) return;
      const response = await sendMessage({
        type: "CHAMELEON_ENABLE_SITE",
        tabId: activeTab.id,
        siteKey: currentSiteKey,
        acceptedPolicyWarning: acceptedPolicyWarning === true,
        permissionRequestConfirmed: acceptedPolicyWarning === true
      });
      if (!response.ok || response.error) {
        siteEnabled = false;
        runtimeEnabled = false;
        siteEnableCheckbox.checked = false;
        setFeedback(response.error || "Could not enable ChameleonBG on this site.", true);
        renderAccessState();
        return false;
      }

      siteEnabled = response.enabled === true;
      permissionGranted = true;
      consentAccepted = true;
      siteAccess = { ...(siteAccess || {}), enabled: true, consentVersion: 1, consentAcceptedAt: siteAccess?.consentAcceptedAt || Date.now() };
      if (response.siteConfig) siteCfg = response.siteConfig;

      // Persisted consent and a granted permission do not prove injection succeeded.
      // Keep page-editing actions disabled until the page agent is actually available.
      const injectionReady = Boolean(response.injection && (response.injection.injected || (response.injection.alreadyLoaded && response.injection.acknowledged !== false)));
      runtimeEnabled = siteEnabled && extensionGloballyEnabled && injectionReady;
      capability.injectionError = injectionReady ? null : (response.warning || "The page agent could not be started. Reload the tab and try again.");
      hideConsentPanel();
      renderAccessState();
      await renderSavedMediaStrip(savedMediaStrip, overview.mediaItems || [], activeTab, runtimeEnabled);
      if (response.warning || !injectionReady) {
        siteAccessStateText.textContent = response.warning || "Site access is saved, but ChameleonBG could not start on this tab. Reload the page and try again.";
        siteAccessStateText.dataset.state = "error";
      }
      return true;
    }

    async function disableSite() {
      if (!activeTab?.id || !capability.supported) return;
      const response = await sendMessage({
        type: "CHAMELEON_DISABLE_SITE",
        tabId: activeTab.id,
        siteKey: currentSiteKey
      });
      if (!response.ok) {
        siteEnableCheckbox.checked = siteEnabled;
        siteAccessStateText.textContent = response.error || "Could not turn off this site.";
        siteAccessStateText.dataset.state = "error";
        return;
      }
      siteEnabled = false;
      runtimeEnabled = false;
      if (response.siteConfig) siteCfg = response.siteConfig;
      siteAccess = { ...(siteAccess || {}), enabled: false };
      hideConsentPanel();
      renderAccessState();
      await renderSavedMediaStrip(savedMediaStrip, overview.mediaItems || [], activeTab, false);
    }

    siteEnableCheckbox.addEventListener("change", async () => {
      if (siteEnableCheckbox.checked) {
        // First enable and any re-enable after permission revocation require the
        // explicit in-product policy warning plus a runtime host permission grant.
        if (!permissionGranted || !consentAccepted) {
          siteEnableCheckbox.checked = false;
          showConsentPanel();
        } else {
          await enableSite(false);
        }
      } else if (siteEnabled) {
        await disableSite();
      }
    });

    // Single consent click: ask the browser for host permission synchronously (it needs
    // the user gesture), record the intent first so the background can finish enabling even
    // if Firefox closes this popup while its permission prompt is shown.
    function requestHostPermissionFromGesture(pattern) {
      const browserApi = typeof browser !== "undefined" ? browser : null;
      if (browserApi && browserApi.permissions && browserApi.permissions.request) {
        return Promise.resolve(browserApi.permissions.request({ origins: [pattern] }));
      }
      return new Promise((resolve, reject) => {
        chrome.permissions.request({ origins: [pattern] }, (granted) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(granted === true);
        });
      });
    }

    btnConfirmSiteEnable.addEventListener("click", () => {
      if (!activeTab?.id || !permissionPattern || !capability.supported) {
        setFeedback("This page does not support site-specific permission requests.", true);
        return;
      }
      btnConfirmSiteEnable.disabled = true;
      btnKeepSiteDisabled.disabled = true;
      setFeedback("Approve the browser permission prompt to finish…");
      // Synchronous call preserves transient user activation for permissions.request.
      let permissionPromise;
      try { permissionPromise = requestHostPermissionFromGesture(permissionPattern); }
      catch (err) { permissionPromise = Promise.reject(err); }
      const intentWritten = sendMessage({ type: "CHAMELEON_BEGIN_ENABLE", tabId: activeTab.id, siteKey: currentSiteKey });

      (async () => {
        try {
          const granted = await permissionPromise;
          await intentWritten;
          if (!granted) {
            await sendMessage({ type: "CHAMELEON_CANCEL_ENABLE", tabId: activeTab.id, siteKey: currentSiteKey });
            setFeedback("Browser access was not granted. ChameleonBG stays off for this site.", true);
            return;
          }
          let ok = await enableSite(true);
          if (!ok) {
            // The background may already have finished enabling from the recorded intent.
            const recheck = await sendMessage({ type: "CHAMELEON_CHECK_TAB_CAPABILITY", tabId: activeTab.id });
            if (recheck && recheck.runtimeEnabled === true) {
              capability = recheck;
              permissionGranted = true; consentAccepted = true; siteEnabled = true; runtimeEnabled = true;
              hideConsentPanel();
              renderAccessState();
              ok = true;
            }
          }
          await sendMessage({ type: "CHAMELEON_CANCEL_ENABLE", tabId: activeTab.id, siteKey: currentSiteKey });
        } catch (err) {
          setFeedback(err && err.message ? err.message : "Could not request browser access.", true);
        } finally {
          btnConfirmSiteEnable.disabled = false;
          btnKeepSiteDisabled.disabled = false;
        }
      })();
    });

    btnKeepSiteDisabled.addEventListener("click", () => {
      siteEnableCheckbox.checked = false;
      hideConsentPanel();
      renderAccessState();
    });

    btnRevokeSiteAccess.addEventListener("click", async () => {
      if (!permissionGranted || !permissionPattern) return;
      const agreed = window.confirm(
        `Revoke ChameleonBG's browser access for ${siteOrigin}? This may affect access on the same host across ports. Your saved media and site settings will be kept.`
      );
      if (!agreed) return;
      btnRevokeSiteAccess.disabled = true;
      try {
        const removed = await chrome.permissions.remove({ origins: [permissionPattern] });
        if (!removed) throw new Error("The browser did not revoke this permission.");
        const response = await sendMessage({
          type: "CHAMELEON_REVOKE_SITE_ACCESS",
          tabId: activeTab?.id,
          siteKey: currentSiteKey
        });
        if (!response.ok) throw new Error(response.error || "Permission was removed, but site cleanup needs a retry.");
        permissionGranted = false;
        consentAccepted = false;
        siteEnabled = false;
        runtimeEnabled = false;
        siteAccess = { ...(siteAccess || {}), enabled: false, consentVersion: 0, consentAcceptedAt: null };
        hideConsentPanel();
        renderAccessState();
        await renderSavedMediaStrip(savedMediaStrip, overview.mediaItems || [], activeTab, false);
      } catch (err) {
        siteAccessStateText.textContent = err && err.message ? err.message : "Could not revoke browser permission.";
        siteAccessStateText.dataset.state = "error";
      } finally {
        btnRevokeSiteAccess.disabled = false;
      }
    });

    btnOpenVisualEditor.addEventListener("click", async () => {
      if (!runtimeEnabled) return;
      const response = await sendMessage({
        type: "CHAMELEON_OPEN_FULL_STUDIO",
        tabId: activeTab?.id || "",
        siteKey: currentSiteKey,
        hostname: currentHostname,
        section: "editor"
      });
      if (!response.ok) {
        siteAccessStateText.textContent = response.error || "Could not open the editor.";
        siteAccessStateText.dataset.state = "error";
        return;
      }
      window.close();
    });

    btnOpenMediaLibrary.addEventListener("click", async () => {
      await sendMessage({ type: "CHAMELEON_OPEN_FULL_STUDIO", tabId: activeTab?.id || "", siteKey: currentSiteKey, hostname: currentHostname, section: "library" });
      window.close();
    });

    btnOpenSettings.addEventListener("click", async () => {
      await sendMessage({ type: "CHAMELEON_OPEN_FULL_STUDIO", tabId: activeTab?.id || "", siteKey: currentSiteKey, hostname: currentHostname, section: "settings" });
      window.close();
    });

    btnOpenWebsites.addEventListener("click", async () => {
      await sendMessage({ type: "CHAMELEON_OPEN_FULL_STUDIO", tabId: activeTab?.id || "", siteKey: currentSiteKey, hostname: currentHostname, section: "websites" });
      window.close();
    });

    btnSelectOnPage.addEventListener("click", async () => {
      if (!activeTab?.id || !runtimeEnabled) return;
      btnSelectOnPage.disabled = true;
      const originalText = btnSelectOnPage.textContent;
      btnSelectOnPage.textContent = "Opening selector…";
      try {
        // Open the full editor first, then have it start the picker on the page.
        // Starting the picker directly from the toolbar popup left no durable editor
        // open to receive the selected component or let the user assign a background.
        const response = await sendMessage({
          type: "CHAMELEON_OPEN_FULL_STUDIO",
          tabId: activeTab.id,
          siteKey: currentSiteKey,
          hostname: currentHostname,
          section: "editor",
          startPicker: true
        });
        if (!response?.ok) {
          siteAccessStateText.textContent = response?.error || "Could not open the visual editor. Please try again.";
          siteAccessStateText.dataset.state = "error";
          return;
        }
        window.close();
      } catch (err) {
        siteAccessStateText.textContent = `Could not open the page selector: ${err?.message || err}`;
        siteAccessStateText.dataset.state = "error";
      } finally {
        btnSelectOnPage.disabled = false;
        btnSelectOnPage.textContent = originalText;
      }
    });

    btnResetSite.addEventListener("click", async () => {
      if (!activeTab?.id || !runtimeEnabled) return;
      const response = await sendMessage({
        type: "CHAMELEON_SAVE_SITE_CONFIG",
        siteKey: currentSiteKey,
        hostname: currentHostname,
        siteConfig: null,
        targetTabId: activeTab.id
      });
      if (!response.ok) {
        siteAccessStateText.textContent = response.error || "Could not reset this site's customizations.";
        siteAccessStateText.dataset.state = "error";
        return;
      }
      customizationStatusText.textContent = "None configured";
      btnResetSite.hidden = true;
    });
  });

  async function renderSavedMediaStrip(container, mediaItems, activeTab, isTabSupported) {
    cleanupPreviewUrls();
    container.replaceChildren();
    const topItems = mediaItems.slice(0, 4);

    for (const item of topItems) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "strip-thumb";
      btn.setAttribute("role", "listitem");
      btn.title = isTabSupported
        ? `Apply "${item.name}" to Entire Website`
        : item.name;

      if (item.mediaType === "preset" && item.gradient) {
        btn.style.backgroundImage = item.gradient;
      } else if (typeof ChameleonStorageService !== "undefined" && isTabSupported) {
        // Decode full blobs for thumbnails only when the strip is actionable (lighter popup open).
        const fullRec = await ChameleonStorageService.getMediaRecordWithBlob(item.id);
        if (fullRec && fullRec.blob) {
          const u = URL.createObjectURL(fullRec.blob);
          previewObjectUrls.add(u);
          if (fullRec.mediaType === "image") {
            btn.style.backgroundImage = `url("${u}")`;
          } else if (fullRec.mediaType === "video") {
            const vidThumb = document.createElement("video");
            vidThumb.src = u;
            vidThumb.muted = true;
            vidThumb.preload = "metadata";
            vidThumb.style.cssText = "position:absolute;inset:0;width:100%;height:100%;object-fit:cover;pointer-events:none;border-radius:inherit;";
            btn.appendChild(vidThumb);
          }
        }
      }

      const label = document.createElement("span");
      label.textContent = item.name;
      btn.appendChild(label);

      btn.addEventListener("click", async () => {
        if (!activeTab?.id || !isTabSupported) return;
        await chrome.tabs.sendMessage(activeTab.id, {
          type: "CHAMELEON_APPLY_QUICK_PRESET",
          compId: "root_page",
          presetId: item.id
        }).catch(() => {});
        document.getElementById("customizationStatusText").textContent = "1 area (Entire Website)";
        document.getElementById("btnResetSite").hidden = false;
      });

      container.appendChild(btn);
    }
  }
})();
