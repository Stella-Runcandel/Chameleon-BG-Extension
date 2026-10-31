/* ChameleonBG v2.0.9 — resilient opt-in host-permission onboarding. */
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get("tabId"));
  const requestedSiteKey = params.get("siteKey") || "";
  const originEl = document.getElementById("accessOrigin");
  const statusEl = document.getElementById("accessStatus");
  const ackEl = document.getElementById("chkPolicyAcknowledged");
  const requestBtn = document.getElementById("btnRequestAccess");
  const verifyBtn = document.getElementById("btnVerifyAccess");
  const cancelBtn = document.getElementById("btnCancelAccess");
  const openEditorBtn = document.getElementById("btnOpenEditor");

  // Prefer Firefox's Promise-native browser.* APIs. Keep the chrome.* callback path
  // for Chromium builds and older compatibility implementations.
  const browserApi = typeof browser !== "undefined" ? browser : null;
  const runtimeApi = browserApi?.runtime || (typeof chrome !== "undefined" ? chrome.runtime : null);
  const permissionsApi = browserApi?.permissions || (typeof chrome !== "undefined" ? chrome.permissions : null);
  const tabsApi = browserApi?.tabs || (typeof chrome !== "undefined" ? chrome.tabs : null);

  let capability = null;
  let busy = false;
  let enableAttemptInFlight = false;
  let consentCompletedThisVisit = false;
  let hostPermissionAvailable = false;

  function setStatus(text, kind = "") {
    statusEl.textContent = text;
    statusEl.className = `status${kind ? ` ${kind}` : ""}`;
  }

  function setBusy(value) {
    busy = value;
    requestBtn.disabled = busy || !capability?.supported || !ackEl.checked;
    verifyBtn.disabled = busy || !capability?.supported;
    cancelBtn.disabled = busy;
    ackEl.disabled = busy || consentCompletedThisVisit;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function withTimeout(promise, ms, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function sendMessage(message, timeoutMs = 15000) {
    if (!runtimeApi || typeof runtimeApi.sendMessage !== "function") {
      return Promise.resolve({ ok: false, error: "Extension messaging is unavailable." });
    }
    if (browserApi?.runtime?.sendMessage) {
      return withTimeout(
        browserApi.runtime.sendMessage(message), timeoutMs,
        "ChameleonBG's background process did not respond. Open about:debugging, inspect ChameleonBG, and check the console."
      ).then((response) => response || { ok: false, error: "No response from ChameleonBG." })
        .catch((error) => ({ ok: false, error: error?.message || String(error) }));
    }
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => finish({ ok: false, error: "ChameleonBG's background process did not respond. Reload the add-on and retry." }), timeoutMs);
      try {
        runtimeApi.sendMessage(message, (response) => {
          const err = runtimeApi.lastError;
          finish(err ? { ok: false, error: err.message } : (response || { ok: false, error: "No response from ChameleonBG." }));
        });
      } catch (error) {
        finish({ ok: false, error: error?.message || String(error) });
      }
    });
  }

  function permissionApiCall(method, details) {
    if (!permissionsApi || typeof permissionsApi[method] !== "function") {
      return Promise.reject(new Error(`Browser permissions API method '${method}' is unavailable.`));
    }
    if (browserApi?.permissions?.[method]) {
      try { return Promise.resolve(browserApi.permissions[method](details)); }
      catch (error) { return Promise.reject(error); }
    }
    // The chrome namespace is callback based in several Firefox/Chromium compat modes.
    return new Promise((resolve, reject) => {
      try {
        permissionsApi[method](details, (value) => {
          const lastError = runtimeApi?.lastError;
          if (lastError) reject(new Error(lastError.message));
          else resolve(value);
        });
      } catch (error) { reject(error); }
    });
  }

  function patternCovers(grantedPattern, wantedPattern) {
    if (grantedPattern === "<all_urls>") return true;
    const granted = String(grantedPattern || "").match(/^(\*|https?):\/\/([^/]+)(?:\/.*)?$/i);
    const wanted = String(wantedPattern || "").match(/^(https?):\/\/([^/]+)(?:\/.*)?$/i);
    if (!granted || !wanted) return grantedPattern === wantedPattern;
    const schemeOk = granted[1] === "*" || granted[1].toLowerCase() === wanted[1].toLowerCase();
    const host = granted[2].toLowerCase();
    const target = wanted[2].toLowerCase();
    const hostOk = host === "*" || host === target || (host.startsWith("*.") && (target === host.slice(2) || target.endsWith(`.${host.slice(2)}`)));
    return schemeOk && hostOk;
  }

  async function hasHostPermission(pattern) {
    if (!pattern) return false;
    try {
      const contains = await permissionApiCall("contains", { origins: [pattern] });
      if (contains === true) return true;
    } catch (_) {}
    try {
      const all = await permissionApiCall("getAll", {});
      const origins = Array.isArray(all?.origins) ? all.origins : [];
      return origins.some((origin) => patternCovers(origin, pattern));
    } catch (_) {
      return false;
    }
  }

  async function waitForPermissionVisible(pattern, attempts = 12, intervalMs = 125) {
    for (let i = 0; i < attempts; i += 1) {
      if (await hasHostPermission(pattern)) return true;
      if (i + 1 < attempts) await delay(intervalMs);
    }
    return false;
  }

  // Call this synchronously from the button's click handler so the browser retains
  // the user-activation context required by permissions.request(). The onAdded event
  // is a fallback for Firefox builds where the permission prompt resolves slowly.
  function requestHostPermissionFromGesture(pattern) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const permissionEvent = permissionsApi?.onAdded;
      const cleanup = () => {
        if (timer !== null) clearTimeout(timer);
        if (permissionEvent && typeof permissionEvent.removeListener === "function") {
          try { permissionEvent.removeListener(onPermissionAdded); } catch (_) {}
        }
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const onPermissionAdded = () => {
        waitForPermissionVisible(pattern, 8, 100).then((granted) => {
          if (granted) finish({ granted: true, source: "permissions.onAdded" });
        }).catch(() => {});
      };
      if (permissionEvent && typeof permissionEvent.addListener === "function") {
        try { permissionEvent.addListener(onPermissionAdded); } catch (_) {}
      }
      timer = setTimeout(() => {
        waitForPermissionVisible(pattern, 2, 100).then((granted) => {
          finish(granted
            ? { granted: true, source: "permission recheck" }
            : { granted: false, timedOut: true, error: "Firefox did not report the permission result. If you clicked Allow, press Check permission status below." });
        }).catch((error) => finish({ granted: false, timedOut: true, error: error?.message || String(error) }));
      }, 18000);

      const handleResult = async (reportedGranted, requestError = null) => {
        const visible = await waitForPermissionVisible(pattern, reportedGranted ? 16 : 2, 125).catch(() => false);
        if (reportedGranted || visible) {
          finish({ granted: true, source: reportedGranted ? "permissions.request" : "permission recheck" });
        } else if (requestError) {
          finish({ granted: false, error: requestError.message || String(requestError) });
        } else {
          finish({ granted: false, denied: true });
        }
      };

      try {
        if (browserApi?.permissions?.request) {
          // Direct call before yielding is intentional: browser user gesture is required.
          const requestPromise = browserApi.permissions.request({ origins: [pattern] });
          Promise.resolve(requestPromise).then(
            (granted) => handleResult(granted === true),
            (error) => handleResult(false, error)
          ).catch((error) => finish({ granted: false, error: error?.message || String(error) }));
        } else {
          permissionsApi.request({ origins: [pattern] }, (granted) => {
            const lastError = runtimeApi?.lastError;
            handleResult(granted === true, lastError ? new Error(lastError.message) : null)
              .catch((error) => finish({ granted: false, error: error?.message || String(error) }));
          });
        }
      } catch (error) {
        finish({ granted: false, error: error?.message || String(error) });
      }
    });
  }

  function setControlsAfterEnable(ready) {
    if (ready) {
      requestBtn.hidden = true;
      verifyBtn.hidden = true;
      ackEl.disabled = true;
      openEditorBtn.hidden = false;
      cancelBtn.textContent = "Close";
    } else {
      requestBtn.hidden = false;
      requestBtn.textContent = "Retry activation";
      requestBtn.disabled = !ackEl.checked;
      verifyBtn.hidden = false;
      ackEl.disabled = true;
      openEditorBtn.hidden = true;
    }
  }

  async function enableAfterPermission(sourceLabel = "permission check") {
    if (enableAttemptInFlight) return;
    enableAttemptInFlight = true;
    try {
      setStatus("Browser access confirmed. Enabling ChameleonBG and checking page-agent startup…");
      const result = await sendMessage({
        type: "CHAMELEON_ENABLE_SITE",
        tabId,
        siteKey: requestedSiteKey,
        acceptedPolicyWarning: true,
        permissionRequestConfirmed: true
      });
      if (!result?.ok || result.error) {
        setStatus(`Browser access is granted, but ChameleonBG could not finish activation: ${result?.error || "No response."} You can retry without granting access again.`, "error");
        setControlsAfterEnable(false);
        return;
      }
      capability.permissionGranted = true;
      capability.persistentHostPermissionPresent = true;
      capability.consentAccepted = true;
      consentCompletedThisVisit = true;
      capability.siteEnabled = result.enabled === true;
      const injection = result.injection || {};
      const ready = Boolean(injection.injected || (injection.alreadyLoaded && injection.acknowledged !== false));
      capability.runtimeEnabled = result.enabled === true && ready;
      if (ready) {
        setStatus(`Enabled on this exact origin (${sourceLabel}). Your saved media and settings are unchanged.`, "success");
      } else {
        setStatus(result.warning || injection.error || "Access and consent are saved, but the page agent did not start. Reload the website, then retry activation.", "error");
      }
      setControlsAfterEnable(ready);
    } finally {
      enableAttemptInFlight = false;
    }
  }

  async function enableFromExistingPermission(sourceLabel = "permission check") {
    if (busy || !capability?.supported || !capability.originPattern) return;
    setBusy(true);
    verifyBtn.hidden = true;
    try {
      const granted = await waitForPermissionVisible(capability.originPattern, 4, 125);
      hostPermissionAvailable = granted;
      if (!granted) {
        requestBtn.textContent = "Request browser access";
        setStatus("Firefox has not reported permission for this site yet. Use Request browser access and approve the browser prompt.", "error");
        verifyBtn.hidden = true;
        return;
      }
      capability.persistentHostPermissionPresent = true;
      await enableAfterPermission(sourceLabel);
    } catch (error) {
      setStatus(`Could not verify browser access: ${error?.message || String(error)}`, "error");
      verifyBtn.hidden = false;
    } finally {
      setBusy(false);
      requestBtn.disabled = !capability?.supported || !ackEl.checked;
    }
  }

  function onRequestAccessClick() {
    if (busy || !capability?.supported || !ackEl.checked || !capability.originPattern) return;
    // If the user already granted access before opening this page, do not raise a
    // redundant browser permission request. Revalidate the grant and enable directly.
    if (hostPermissionAvailable) {
      enableFromExistingPermission("existing browser permission");
      return;
    }
    setBusy(true);
    verifyBtn.hidden = true;
    setStatus("Requesting browser access… Keep this tab open while Firefox asks for permission.");

    // CRITICAL: invoke permissions.request synchronously from the user's click handler.
    // Do not await a permission pre-check first; doing so can consume transient user
    // activation and cause hardened Firefox profiles to leave the permission flow stuck.
    const permissionPromise = requestHostPermissionFromGesture(capability.originPattern);
    permissionPromise.then(async (result) => {
      if (!result?.granted) {
        if (result?.timedOut) {
          setStatus(result.error || "Firefox did not report the permission result. If you clicked Allow, use Check permission status.", "error");
          verifyBtn.hidden = false;
        } else if (result?.error) {
          setStatus(`Could not request browser access: ${result.error}`, "error");
          verifyBtn.hidden = false;
        } else {
          setStatus("Browser access was not granted. ChameleonBG remains disabled for this site.", "error");
          verifyBtn.hidden = false;
        }
        return;
      }
      hostPermissionAvailable = true;
      capability.persistentHostPermissionPresent = true;
      await enableAfterPermission(result.source || "browser permission");
    }).catch((error) => {
      setStatus(`Site setup did not finish: ${error?.message || String(error)}. Your saved media has not been deleted.`, "error");
      verifyBtn.hidden = false;
    }).finally(() => {
      setBusy(false);
      requestBtn.disabled = !capability?.supported || !ackEl.checked;
    });
  }

  function onVerifyAccessClick() {
    if (busy || !capability?.supported || !capability.originPattern) return;
    enableFromExistingPermission("manual permission check");
  }

  async function init() {
    if (!Number.isInteger(tabId) || tabId < 0 || !requestedSiteKey) {
      originEl.textContent = "No website was selected.";
      setStatus("Close this tab and reopen ChameleonBG from the website you want to customize.", "error");
      requestBtn.disabled = true;
      return;
    }
    capability = await sendMessage({ type: "CHAMELEON_CHECK_TAB_CAPABILITY", tabId });
    if (!capability?.ok || !capability.supported) {
      originEl.textContent = requestedSiteKey;
      setStatus(capability?.error || capability?.reason || "This browser page cannot be customized.", "error");
      requestBtn.disabled = true;
      verifyBtn.hidden = true;
      return;
    }
    if (String(capability.siteKey).toLowerCase() !== requestedSiteKey.toLowerCase()) {
      originEl.textContent = capability.siteKey || requestedSiteKey;
      setStatus("The selected website changed after this page was opened. Close this tab and reopen ChameleonBG.", "error");
      requestBtn.disabled = true;
      verifyBtn.hidden = true;
      return;
    }
    originEl.textContent = capability.siteKey;
    if (capability.runtimeEnabled) {
      setStatus("ChameleonBG is already enabled on this exact origin.", "success");
      requestBtn.hidden = true;
      openEditorBtn.hidden = false;
      requestBtn.disabled = true;
      ackEl.disabled = true;
      cancelBtn.textContent = "Close";
      return;
    }
    if (capability.consentAccepted) {
      ackEl.checked = true;
      ackEl.disabled = true;
    }
    const alreadyGranted = await hasHostPermission(capability.originPattern);
    hostPermissionAvailable = alreadyGranted;
    capability.persistentHostPermissionPresent = alreadyGranted || capability.persistentHostPermissionPresent === true;
    requestBtn.textContent = alreadyGranted ? "Enable ChameleonBG" : "Request browser access";
    setStatus(alreadyGranted
      ? (capability.consentAccepted
          ? "Browser access is already available. Click Enable ChameleonBG to activate."
          : "Browser access is already available. Confirm the warning above to enable this site.")
      : (capability.consentAccepted
          ? "Consent recorded. Click Request browser access to approve in Firefox."
          : "Review the warning and confirm to request browser permission."));
    requestBtn.disabled = !ackEl.checked;
  }

  ackEl.addEventListener("change", () => {
    requestBtn.disabled = busy || !capability?.supported || !ackEl.checked;
  });
  requestBtn.addEventListener("click", onRequestAccessClick);
  verifyBtn.addEventListener("click", onVerifyAccessClick);
  openEditorBtn.addEventListener("click", async () => {
    try {
      await sendMessage({
        type: "CHAMELEON_OPEN_FULL_STUDIO",
        tabId,
        siteKey: requestedSiteKey,
        section: "editor"
      });
      window.close();
    } catch (error) {
      setStatus(`Could not open the editor: ${error?.message || String(error)}`, "error");
    }
  });
  cancelBtn.addEventListener("click", () => window.close());
  init().catch((error) => setStatus(error?.message || "Could not inspect the selected site.", "error"));
})();
