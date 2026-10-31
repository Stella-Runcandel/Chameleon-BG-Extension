/**
 * ChameleonBG v2.0.9 — Firefox Manifest V3 Background Script (`background.js`)
 * Firefox uses the ordered `background.scripts` manifest entry in this build;
 * this file remains compatible with the shared Chromium source where `importScripts` exists.
 *
 * Hardening improvements in v2.0.1:
 * 1. Bounded Port Media Streaming (`chrome.runtime.onConnect` / `"chameleon-media-port"`):
 *    Streams media blobs in bounded 256 KB chunks with sequential ACK flow control, FNV-1a
 *    checksum validation, timeout protection, explicit cancellation, and automatic cleanup
 *    on tab disconnect—eliminating whole-file Base64 message conversion.
 * 2. Origin-Scoped, Conflict-Safe Site Configuration Persistence:
 *    Delegates to `ChameleonStorageService.getSiteConfigForTarget` and
 *    `ChameleonStorageService.saveSiteConfigConflictSafe` using per-site keys (`siteCfg::<origin>`)
 *    and monotonic revisions.
 * 3. Safe One-Time Migration:
 *    Runs `migrateLegacySiteConfigsOnce(chrome.storage.local)` without deleting original records.
 */

/* global importScripts, ChameleonStorageService, ChameleonAccessControl, ChameleonVideoManager, chrome */
if (typeof importScripts === "function") {
  importScripts("storage-service.js", "access-control.js", "video-manager.js");
}

const DEFAULT_GLOBAL_SETTINGS = {
  extensionEnabled: true,
  ecoMode: true,
  autoConvertWebP: false,
  preserveOriginalOnConvert: true,
  webpQuality: 0.86,
  maxImageDimension: 2560,
  maxConcurrentVideos: 2,
  maxMediaSizeBytes: 50 * 1024 * 1024, // 50 MB configurable ceiling
  warnMediaSizeBytes: 15 * 1024 * 1024, // 15 MB warning threshold
  respectReducedMotion: true,
  pauseAllBackgroundVideos: false
};

const RESTRICTED_URL_PATTERN = /^(chrome|edge|brave|about|view-source|devtools|chrome-extension|moz-extension):/i;
const WEB_STORE_PATTERN = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i;
const SITE_CONSENT_VERSION = ChameleonAccessControl.SITE_CONSENT_VERSION;
const SITE_ACCESS_KEY_PREFIX = ChameleonAccessControl.SITE_ACCESS_KEY_PREFIX;
const SITE_CONFIG_KEY_PREFIX = "siteCfg::";
const INJECTED_FILES = ["storage-service.js", "video-manager.js", "selection-engine.js", "renderer-engine.js", "content.js"];
const inFlightInjections = new Map();
const PENDING_ENABLE_KEY_PREFIX = "pendingEnable::";
const PENDING_ENABLE_TTL_MS = 2 * 60 * 1000;

function isInjectableUrl(url) {
  if (!url || typeof url !== "string") return false;
  if (RESTRICTED_URL_PATTERN.test(url) || WEB_STORE_PATTERN.test(url)) return false;
  return /^https?:\/\//i.test(url);
}

function parseSupportedPageUrl(rawUrl) {
  if (!isInjectableUrl(rawUrl)) return null;
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u;
  } catch (_) { return null; }
}

// Chromium host match patterns do not scope permissions by port. Runtime activation
// is additionally guarded by exact-origin config checks, so a grant on :443 does not
// cause ChameleonBG to activate on another port automatically.
function originPermissionPatternForUrl(rawUrl) {
  return ChameleonAccessControl.originPermissionPatternForUrl(rawUrl);
}

function siteAccessStorageKey(origin) {
  return ChameleonAccessControl.siteAccessStorageKey(origin);
}

function siteConfigStorageKey(origin) {
  return `${SITE_CONFIG_KEY_PREFIX}${String(origin || "").toLowerCase()}`;
}

function isTrustedExtensionPage(sender, pageName) {
  if (!sender || typeof sender.url !== "string") return false;
  // Extension pages may include query parameters and may report sender.tab in some
  // browser implementations. Match the exact extension resource path, not a prefix.
  const senderResource = sender.url.split(/[?#]/, 1)[0];
  return senderResource === chrome.runtime.getURL(pageName);
}

function isTrustedPopupCommand(sender) {
  return isTrustedExtensionPage(sender, "popup.html");
}

function requireTrustedPopupCommand(sender) {
  if (!isTrustedPopupCommand(sender)) {
    throw new Error("This site-access action must be initiated from the ChameleonBG popup.");
  }
}

function isTrustedSiteAccessCommand(sender) {
  return isTrustedExtensionPage(sender, "site-access.html");
}

function isTrustedStudioCommand(sender) {
  return isTrustedExtensionPage(sender, "studio.html");
}

function requireTrustedEnableCommand(sender) {
  if (!isTrustedPopupCommand(sender) && !isTrustedSiteAccessCommand(sender)) {
    throw new Error("Site enablement must be initiated from a trusted ChameleonBG extension page.");
  }
}

async function callPermissionApi(method, details) {
  // Firefox's browser.* namespace is Promise-native. The callback wrapper keeps the
  // same checks compatible with Chromium's chrome.* namespace.
  try {
    if (typeof browser !== "undefined" && browser.permissions && typeof browser.permissions[method] === "function") {
      return await browser.permissions[method](details);
    }
  } catch (error) {
    throw error;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; fn(value); };
    try {
      const result = chrome.permissions[method](details, (value) => {
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) finish(reject, new Error(lastError.message));
        else finish(resolve, value);
      });
      if (result && typeof result.then === "function") {
        result.then((value) => finish(resolve, value), (error) => finish(reject, error));
      }
    } catch (error) { finish(reject, error); }
  });
}

async function hasPersistentlyGrantedOriginPattern(wantedPattern) {
  if (typeof wantedPattern !== "string" || !wantedPattern) return false;
  // Prefer contains() because Firefox may represent granted optional host permissions
  // differently in getAll(). Fall back to getAll() for broad grants and older APIs.
  try {
    if (await callPermissionApi("contains", { origins: [wantedPattern] }) === true) return true;
  } catch (_) {}
  try {
    const current = await callPermissionApi("getAll", {});
    const origins = Array.isArray(current && current.origins) ? current.origins : [];
    return origins.some((grantedPattern) => hostPatternCovers(grantedPattern, wantedPattern));
  } catch (_) {
    return false;
  }
}

async function getSiteRuntimeState(rawUrl) {
  const pageUrl = parseSupportedPageUrl(rawUrl);
  if (!pageUrl) {
    return { supported: false, allowed: false, reason: "This browser page cannot be customized by extensions." };
  }
  const identity = ChameleonStorageService.deriveSiteIdentity(pageUrl.href);
  const origin = identity.originKey;
  const permissionPattern = originPermissionPatternForUrl(pageUrl.href);
  const persistentHostPermissionPresent = await hasPersistentlyGrantedOriginPattern(permissionPattern);

  const accessKey = siteAccessStorageKey(origin);
  const configKey = siteConfigStorageKey(origin);
  const stored = await chrome.storage.local.get([accessKey, configKey, "globalSettings"]);
  const siteAccess = stored[accessKey] || null;
  const siteConfig = stored[configKey] || null;
  // `activeTab` grants temporary access to the currently active tab. Do not mistake
  // that ephemeral access for the persistent optional host permission we need for
  // restoration after navigation/restart. The marker is written only after the user
  // confirms the explicit runtime permission request in the popup.
  const persistentGrantRecorded = ChameleonAccessControl.hasPersistentHostGrant(
    persistentHostPermissionPresent, siteAccess, permissionPattern
  );
  const permissionGranted = persistentGrantRecorded;
  const globalSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...(stored.globalSettings || {}) };
  const evaluated = ChameleonAccessControl.evaluateSiteAccess({
    pageUrl: pageUrl.href,
    permissionGranted,
    siteAccess,
    siteConfig,
    globalSettings
  });

  return {
    ...evaluated,
    permissionPattern,
    persistentHostPermissionPresent,
    persistentGrantRecorded,
    origin,
    hostname: identity.hostname,
    siteKey: origin,
    siteAccess,
    siteConfig
  };
}

async function saveExactSiteEnabled(origin, enabled) {
  const key = siteConfigStorageKey(origin);
  const identity = ChameleonStorageService.deriveSiteIdentity(origin);
  const stored = await chrome.storage.local.get([key]);
  const current = stored[key] || null;
  if (!current && !enabled) return null;
  const baseConfig = current || {
    siteKey: origin,
    hostname: identity.hostname,
    matchScope: "origin",
    enabled: false,
    revision: 0,
    components: {}
  };
  const next = {
    ...baseConfig,
    siteKey: origin,
    hostname: identity.hostname,
    enabled: Boolean(enabled),
    components: baseConfig.components && typeof baseConfig.components === "object" ? baseConfig.components : {}
  };
  const result = await ChameleonStorageService.saveSiteConfigConflictSafe(
    chrome.storage.local,
    origin,
    next,
    { expectedRevision: Number(baseConfig.revision) || 0, baseComponents: next.components }
  );
  if (!result.ok) throw new Error(result.error || "Could not update this site's configuration.");
  return result.siteConfig;
}

async function writeSiteAccess(origin, patch) {
  const key = siteAccessStorageKey(origin);
  const existing = (await chrome.storage.local.get([key]))[key] || {};
  const next = {
    ...existing,
    origin,
    hostname: ChameleonStorageService.deriveSiteIdentity(origin).hostname,
    ...patch,
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [key]: next });
  return next;
}

async function resolveTargetTabFromExtensionPage(message) {
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("No valid website tab was provided.");
  const tab = await chrome.tabs.get(tabId);
  const u = parseSupportedPageUrl(tab && tab.url);
  if (!u) throw new Error("This browser page cannot be customized by ChameleonBG.");
  const origin = ChameleonStorageService.deriveSiteIdentity(u.href).originKey;
  if (message.siteKey && String(message.siteKey).toLowerCase() !== origin) {
    throw new Error("The website tab has navigated to a different origin. Reopen site access for the current page.");
  }
  return { tab, url: u, origin, permissionPattern: originPermissionPatternForUrl(u.href) };
}

async function requestTargetTabForPopup(message, sender) {
  requireTrustedPopupCommand(sender);
  return resolveTargetTabFromExtensionPage(message);
}

async function requestTargetTabForEnable(message, sender) {
  requireTrustedEnableCommand(sender);
  return resolveTargetTabFromExtensionPage(message);
}

async function maybeInjectAuthorizedTab(tabOrId) {
  const tab = typeof tabOrId === "number" ? await chrome.tabs.get(tabOrId).catch(() => null) : tabOrId;
  if (!tab || !Number.isInteger(tab.id)) return { injected: false, reason: "Missing tab." };
  const pageUrl = parseSupportedPageUrl(tab.url);
  if (!pageUrl) return { injected: false, reason: "Unsupported page." };

  const state = await getSiteRuntimeState(pageUrl.href);
  if (!state.allowed) return { injected: false, reason: state.reason || "Site access is disabled." };

  const existing = inFlightInjections.get(tab.id);
  if (existing) return existing;

  const work = (async () => {
    try {
      let alreadyLoaded = false;
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [0] },
          func: () => Boolean(window.__CHAMELEON_BG_V2_LOADED__)
        });
        alreadyLoaded = Boolean(results && results[0] && results[0].result);
      } catch (_) {
        // No script has run yet, or the document navigated between checks.
      }

      if (alreadyLoaded) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { type: "CHAMELEON_RELOAD_SETTINGS", accessAuthorized: true });
          if (response && response.ok !== false) return { injected: false, alreadyLoaded: true, acknowledged: true };
          return { injected: false, alreadyLoaded: true, acknowledged: false, error: response?.error || "The existing page agent did not acknowledge reinitialization." };
        } catch (err) {
          // Do not inject a second copy into the same isolated world; top-level lexical
          // declarations can conflict. Ask the user to reload instead if the old agent
          // is present but cannot be reached.
          return { injected: false, alreadyLoaded: true, acknowledged: false, error: err && err.message ? err.message : String(err) };
        }
      }

      await chrome.scripting.insertCSS({ target: { tabId: tab.id, frameIds: [0] }, files: ["content.css"] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: INJECTED_FILES });
      return { injected: true };
    } catch (err) {
      return { injected: false, error: err && err.message ? err.message : String(err) };
    }
  })().finally(() => inFlightInjections.delete(tab.id));

  inFlightInjections.set(tab.id, work);
  return work;
}

// Shared by CHAMELEON_ENABLE_SITE and the permissions.onAdded pending-intent completion.
const inFlightEnables = new Map();

async function performEnableSite(target, options = {}) {
  const originKey = String(target.origin || "");
  if (inFlightEnables.has(originKey)) {
    return inFlightEnables.get(originKey);
  }
  const enablePromise = (async () => {
    const permissionGranted = await hasPersistentlyGrantedOriginPattern(target.permissionPattern);
    if (!permissionGranted) throw new Error("Persistent browser host permission was not granted for this site.");
    const oldAccessKey = siteAccessStorageKey(target.origin);
    const existingAccess = (await chrome.storage.local.get([oldAccessKey]))[oldAccessKey] || null;
    const hasRecordedPersistentGrant = Boolean(
      existingAccess && Number(existingAccess.hostPermissionGrantedAt) > 0 &&
      (existingAccess.permissionPattern === target.permissionPattern ||
       ChameleonAccessControl.hostPermissionPatternCovers(existingAccess.permissionPattern, target.permissionPattern))
    );
    if (!hasRecordedPersistentGrant && options.permissionRequestConfirmed !== true) {
      throw new Error("Complete the browser permission request from the ChameleonBG popup before enabling this site.");
    }
    const hasValidPriorConsent = Boolean(existingAccess && existingAccess.consentVersion === SITE_CONSENT_VERSION && Number(existingAccess.consentAcceptedAt) > 0);
    if (!hasValidPriorConsent && options.acceptedPolicyWarning !== true) {
      throw new Error("Please review and accept the website policy warning before enabling this site.");
    }
    const global = (await chrome.storage.local.get(["globalSettings"])).globalSettings || {};
    if (global.extensionEnabled === false) throw new Error("ChameleonBG is globally paused. Enable it in Settings first.");
    const profile = await saveExactSiteEnabled(target.origin, true);
    await writeSiteAccess(target.origin, {
      enabled: true,
      consentVersion: SITE_CONSENT_VERSION,
      consentAcceptedAt: hasValidPriorConsent ? existingAccess.consentAcceptedAt : Date.now(),
      consentTextVersion: SITE_CONSENT_VERSION,
      permissionPattern: target.permissionPattern,
      hostPermissionGrantedAt: existingAccess?.hostPermissionGrantedAt || Date.now(),
      revokedExternally: false
    });
    const injection = await maybeInjectAuthorizedTab(target.tab);
    if (!injection.injected && !injection.alreadyLoaded) {
      // Preserve the user's intent and access grant; the popup can explain/retry injection.
      return { enabled: true, siteKey: target.origin, siteConfig: profile, injection, warning: "Access was saved, but the page agent could not be started. Reload the tab and retry." };
    }
    return { enabled: true, siteKey: target.origin, siteConfig: profile, injection };
  })().finally(() => {
    inFlightEnables.delete(originKey);
  });

  inFlightEnables.set(originKey, enablePromise);
  return enablePromise;
}

// Completes enablement for sites whose consent click was recorded just before the
// browser permission prompt (the popup may have been closed by that prompt).
async function completePendingEnables() {
  const all = await chrome.storage.local.get(null);
  const stale = [];
  for (const [key, intent] of Object.entries(all)) {
    if (!key.startsWith(PENDING_ENABLE_KEY_PREFIX)) continue;
    if (!intent || Date.now() - Number(intent.createdAt) > PENDING_ENABLE_TTL_MS) { stale.push(key); continue; }
    try {
      const tab = await chrome.tabs.get(Number(intent.tabId));
      const url = parseSupportedPageUrl(tab && tab.url);
      if (!url || ChameleonStorageService.deriveSiteIdentity(url.href).originKey !== intent.origin) { stale.push(key); continue; }
      const permissionPattern = originPermissionPatternForUrl(url.href);
      if (!(await hasPersistentlyGrantedOriginPattern(permissionPattern))) continue; // not granted (yet)
      await chrome.storage.local.remove([key]);
      await performEnableSite({ tab, url, origin: intent.origin, permissionPattern }, { permissionRequestConfirmed: true, acceptedPolicyWarning: true });
      if (chrome.action && chrome.action.setBadgeText) {
        chrome.action.setBadgeText({ tabId: tab.id, text: "ON" }).catch(() => {});
        chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#16a34a" }).catch(() => {});
      }
    } catch (err) {
      stale.push(key);
      console.warn("[ChameleonBG] Pending enable could not complete:", err);
    }
  }
  if (stale.length) await chrome.storage.local.remove(stale);
}

// Lists every site that has saved structure/settings, with live open-tab ids.
async function listSavedSites() {
  const all = await chrome.storage.local.get(null);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const sites = [];
  for (const [key, cfg] of Object.entries(all)) {
    if (!key.startsWith(SITE_CONFIG_KEY_PREFIX) || !cfg || typeof cfg !== "object") continue;
    const origin = String(cfg.siteKey || key.slice(SITE_CONFIG_KEY_PREFIX.length)).toLowerCase();
    const parsed = parseSupportedPageUrl(origin);
    if (!parsed) continue;
    const components = cfg.components && typeof cfg.components === "object" ? Object.values(cfg.components) : [];
    if (!components.length) continue;
    const access = all[siteAccessStorageKey(parsed.origin)] || null;
    const openTabIds = tabs.filter((t) => {
      const u = parseSupportedPageUrl(t.url);
      return u && u.origin.toLowerCase() === parsed.origin.toLowerCase();
    }).map((t) => t.id);
    sites.push({
      origin: parsed.origin.toLowerCase(),
      hostname: parsed.hostname,
      componentCount: components.length,
      customizedCount: components.filter((c) => c && c.enabled !== false && ((c.playlist && c.playlist.length > 0) || c.activeMediaId)).length,
      enabled: Boolean(access && access.enabled === true && cfg.enabled !== false),
      themeId: cfg.themeId || null,
      updatedAt: Number(cfg.updatedAt) || 0,
      openTabIds
    });
  }
  sites.sort((a, b) => b.updatedAt - a.updatedAt || a.hostname.localeCompare(b.hostname));
  return sites;
}

async function listOpenSiteTabs() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const result = [];
  for (const t of tabs) {
    const u = parseSupportedPageUrl(t.url);
    if (!t.id || !u) continue;
    const state = await getSiteRuntimeState(u.href);
    result.push({ tabId: t.id, origin: state.origin, hostname: state.hostname, title: t.title || "", allowed: state.allowed === true });
  }
  return result;
}

// Single-instance Studio: reuse an existing Studio tab and re-target it. When the picker is
// requested the Studio opens/stays in the background so the website tab stays in front.
async function openOrFocusStudio({ tabId, siteKey, section, startPicker }) {
  const studioBase = chrome.runtime.getURL("studio.html");
  const allTabs = await chrome.tabs.query({}).catch(() => []);
  const existing = allTabs.find((t) => typeof t.url === "string" && t.url.split(/[?#]/, 1)[0] === studioBase);
  const params = `tabId=${encodeURIComponent(tabId || "")}&siteKey=${encodeURIComponent(siteKey || "")}&view=${encodeURIComponent(section || "editor")}`;
  if (existing) {
    let delivered = false;
    try {
      const reply = await Promise.race([
        chrome.runtime.sendMessage({
          type: "CHAMELEON_STUDIO_RETARGET",
          tabId: tabId ? Number(tabId) : null,
          siteKey: siteKey || "",
          view: section || "editor",
          startPicker: startPicker === true
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 1500))
      ]);
      delivered = Boolean(reply && reply.ok);
    } catch (_) {}
    if (!delivered) {
      // The Studio page may still be loading or predates retargeting: reload it with new params.
      await chrome.tabs.update(existing.id, { url: `${studioBase}?${params}${startPicker ? "&startPicker=1" : ""}`, active: !startPicker });
    } else if (!startPicker) {
      await chrome.tabs.update(existing.id, { active: true });
    }
    return { studioTabId: existing.id, reused: true };
  }
  const created = await chrome.tabs.create({
    url: `${studioBase}?${params}${startPicker ? "&startPicker=1" : ""}`,
    active: !startPicker
  });
  return { studioTabId: created.id, reused: false };
}

async function deactivateTabRuntime(tabId, message = {}) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: "CHAMELEON_SITE_ACCESS_DISABLED", ...message });
  } catch (_) {}
  // Backward compatibility: v2.0.2 content scripts already in an open tab may not
  // know the dedicated deactivation message, but do understand settings reloads.
  try { await chrome.tabs.sendMessage(tabId, { type: "CHAMELEON_RELOAD_SETTINGS" }); } catch (_) {}
}

function isValidSender(sender) {
  if (!sender) return false;
  // Browsers always stamp messages from this extension's own contexts with its id.
  if (sender.id !== chrome.runtime.id) return false;
  return true;
}

// Message types a page-injected content script may send. Everything else is
// restricted to extension-owned pages (popup, studio, site-access).
const CONTENT_SCRIPT_MESSAGE_TYPES = new Set([
  "CHAMELEON_LEGACY_MEDIA_MIGRATION_STATUS",
  "CHAMELEON_LEGACY_MEDIA_MIGRATION_MARK",
  "CHAMELEON_UPDATE_BADGE",
  "CHAMELEON_COMPONENT_PICKED_EVENT",
  "CHAMELEON_OPEN_FULL_STUDIO",
  "CHAMELEON_SAVE_SITE_CONFIG",
  "CHAMELEON_GET_PAGE_ACCESS_STATE",
  "CHAMELEON_GET_OVERVIEW",
  "CHAMELEON_CLAIM_AUDIO_FOCUS",
  "CHAMELEON_RELEASE_AUDIO_FOCUS"
]);

// ===========================================================================
// GLOBAL CROSS-TAB AUDIO COORDINATOR
// Enforces at most one audible ChameleonBG video across all browser tabs.
// ===========================================================================
let globalAudibleSource = null; // { tabId: number, compId: string } | null
const SESSION_AUDIO_OWNER_KEY = "chameleonGlobalAudibleSource";

async function readGlobalAudibleSource() {
  if (globalAudibleSource) return globalAudibleSource;
  if (chrome.storage && chrome.storage.session) {
    try {
      const res = await chrome.storage.session.get([SESSION_AUDIO_OWNER_KEY]);
      if (res && res[SESSION_AUDIO_OWNER_KEY] && Number.isInteger(res[SESSION_AUDIO_OWNER_KEY].tabId)) {
        globalAudibleSource = res[SESSION_AUDIO_OWNER_KEY];
        return globalAudibleSource;
      }
    } catch (_) {}
  }
  return null;
}

async function writeGlobalAudibleSource(value) {
  globalAudibleSource = value || null;
  if (chrome.storage && chrome.storage.session) {
    try {
      if (globalAudibleSource) {
        await chrome.storage.session.set({ [SESSION_AUDIO_OWNER_KEY]: globalAudibleSource });
      } else {
        await chrome.storage.session.remove([SESSION_AUDIO_OWNER_KEY]);
      }
    } catch (_) {}
  }
}

async function claimGlobalAudioFocus(tabId, compId) {
  if (!Number.isInteger(tabId) || !compId) return { granted: false };

  const prevOwner = await readGlobalAudibleSource();
  if (prevOwner && (prevOwner.tabId !== tabId || prevOwner.compId !== compId)) {
    try {
      await chrome.tabs.sendMessage(prevOwner.tabId, {
        type: "CHAMELEON_YIELD_AUDIO_FOCUS",
        compId: prevOwner.compId
      });
    } catch (_) {
      // Previous tab may have closed or navigated
    }
  }

  await writeGlobalAudibleSource({ tabId, compId });
  return { granted: true, audibleOwner: globalAudibleSource };
}

async function releaseGlobalAudioFocus(tabId, compId) {
  const currOwner = await readGlobalAudibleSource();
  if (currOwner && currOwner.tabId === tabId && (!compId || currOwner.compId === compId)) {
    await writeGlobalAudibleSource(null);
  }
  return { released: true };
}

function isExtensionPageSender(sender) {
  return Boolean(sender && typeof sender.url === "string" &&
    sender.url.startsWith(chrome.runtime.getURL("")));
}

// Keys a caller may change through CHAMELEON_SAVE_GLOBAL_SETTINGS, with type/range checks.
const GLOBAL_SETTING_VALIDATORS = {
  extensionEnabled: (v) => typeof v === "boolean",
  ecoMode: (v) => typeof v === "boolean",
  autoConvertWebP: (v) => typeof v === "boolean",
  preserveOriginalOnConvert: (v) => typeof v === "boolean",
  respectReducedMotion: (v) => typeof v === "boolean",
  pauseAllBackgroundVideos: (v) => typeof v === "boolean",
  webpQuality: (v) => typeof v === "number" && v >= 0.1 && v <= 1,
  maxImageDimension: (v) => Number.isInteger(v) && v >= 256 && v <= 16384,
  maxConcurrentVideos: (v) => Number.isInteger(v) && v >= 0 && v <= 16,
  maxMediaSizeBytes: (v) => Number.isFinite(v) && v >= 1024 * 1024 && v <= 2 * 1024 * 1024 * 1024,
  warnMediaSizeBytes: (v) => Number.isFinite(v) && v >= 0 && v <= 2 * 1024 * 1024 * 1024
};

function sanitizeGlobalSettingsPatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== "object") return clean;
  for (const [key, validate] of Object.entries(GLOBAL_SETTING_VALIDATORS)) {
    if (Object.prototype.hasOwnProperty.call(patch, key) && validate(patch[key])) clean[key] = patch[key];
  }
  return clean;
}

let startupMigrationPromise = null;

function ensureStartupMigration() {
  if (!startupMigrationPromise) {
    startupMigrationPromise = (async () => {
      const stored = await chrome.storage.local.get(["globalSettings"]);
      const nextSettings = {
        ...DEFAULT_GLOBAL_SETTINGS,
        ...(stored.globalSettings || {})
      };
      await chrome.storage.local.set({ globalSettings: nextSettings });
      const migResult = await ChameleonStorageService.migrateLegacySiteConfigsOnce(chrome.storage.local);
      if (chrome.alarms) {
        await chrome.alarms.create("chameleon-playlist-alarm", { periodInMinutes: 1 });
      }
      return migResult;
    })().catch((err) => {
      startupMigrationPromise = null;
      console.warn("[ChameleonBG] Startup migration warning:", err);
    });
  }
  return startupMigrationPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureStartupMigration()
    .then(() => deactivateLegacyProfilesWithoutConsent())
    .finally(() => restoreAuthorizedOpenTabs());
});

// No static <all_urls> content script is registered. Scripts are injected only after
// the user grants optional host access, accepts the site warning, and enables that exact origin.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading") {
    releaseGlobalAudioFocus(tabId).catch(() => {});
  }
  if (!tab || !tab.url || changeInfo.status !== "complete") return;
  maybeInjectAuthorizedTab(tab).catch(() => {});
});

if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    releaseGlobalAudioFocus(tabId).catch(() => {});
  });
}

async function restoreAuthorizedOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.filter((t) => t && t.id && isInjectableUrl(t.url)).map((t) => maybeInjectAuthorizedTab(t)));
  } catch (_) {}
}

// On upgrade from the former <all_urls> static-injection model, force every profile
// without explicit current-version consent into a disabled runtime state while keeping
// its component/theme data. This also makes old content scripts in already-open tabs
// remove their layers when they receive CHAMELEON_RELOAD_SETTINGS.
async function deactivateLegacyProfilesWithoutConsent() {
  try {
    const all = await chrome.storage.local.get(null);
    const updates = {};
    for (const [key, profile] of Object.entries(all)) {
      if (!key.startsWith(SITE_CONFIG_KEY_PREFIX) || !profile || typeof profile !== "object") continue;
      const origin = String(profile.siteKey || key.slice(SITE_CONFIG_KEY_PREFIX.length));
      const parsed = parseSupportedPageUrl(origin);
      if (!parsed) continue;
      const accessKey = siteAccessStorageKey(parsed.origin);
      const access = all[accessKey] || null;
      let permissionGranted = false;
      try { permissionGranted = await hasPersistentlyGrantedOriginPattern(originPermissionPatternForUrl(parsed.href)); } catch (_) {}
      const consentValid = Boolean(access && access.consentVersion === SITE_CONSENT_VERSION && Number(access.consentAcceptedAt) > 0 && access.enabled === true && permissionGranted);
      if (!consentValid && profile.enabled !== false) {
        updates[key] = { ...profile, enabled: false, revision: (Number(profile.revision) || 0) + 1, updatedAt: Date.now() };
      }
      if (!consentValid && access && access.enabled !== false) {
        updates[accessKey] = { ...access, enabled: false, consentVersion: 0, consentAcceptedAt: null, hostPermissionGrantedAt: permissionGranted ? access.hostPermissionGrantedAt : null, updatedAt: Date.now(), revokedExternally: !permissionGranted };
      } else if (!permissionGranted && access && access.hostPermissionGrantedAt) {
        updates[accessKey] = { ...access, hostPermissionGrantedAt: null, updatedAt: Date.now(), revokedExternally: true };
      }
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);

    // The old static content scripts can remain in already-open documents during an
    // extension update. They understand RELOAD_SETTINGS and will tear down profiles
    // which were just disabled above. New builds also re-check runtime authorization.
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab && tab.id) {
        try { chrome.tabs.sendMessage(tab.id, { type: "CHAMELEON_RELOAD_SETTINGS" }).catch(() => {}); } catch (_) {}
      }
    }
  } catch (err) {
    console.warn("[ChameleonBG] Legacy site-access migration could not complete:", err);
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureStartupMigration().finally(() => restoreAuthorizedOpenTabs());
});

// If a user grants a previously requested host permission from the browser UI,
// restore only sites that already have a saved explicit consent + enabled setting.
if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    completePendingEnables()
      .catch((err) => console.warn("[ChameleonBG] Pending enable failed:", err))
      .finally(() => restoreAuthorizedOpenTabs().catch(() => {}));
  });
}

// Permission revocation in chrome://extensions must immediately stop active rendering.
if (chrome.permissions && chrome.permissions.onRemoved) {
  chrome.permissions.onRemoved.addListener(async (removed) => {
    const patterns = Array.isArray(removed?.origins) ? removed.origins : [];
    if (!patterns.length) return;
    const all = await chrome.storage.local.get(null);
    const updates = {};
    const revokedOrigins = [];
    for (const [key, access] of Object.entries(all)) {
      if (!key.startsWith(SITE_ACCESS_KEY_PREFIX) || !access || typeof access.origin !== "string") continue;
      const parsed = parseSupportedPageUrl(access.origin);
      if (!parsed) continue;
      const wanted = originPermissionPatternForUrl(parsed.href);
      if (patterns.some((p) => hostPatternCovers(p, wanted))) {
        updates[key] = { ...access, enabled: false, consentVersion: 0, consentAcceptedAt: null, hostPermissionGrantedAt: null, updatedAt: Date.now(), revokedExternally: true };
        revokedOrigins.push(access.origin);
        const configKey = siteConfigStorageKey(access.origin);
        if (all[configKey]) updates[configKey] = { ...all[configKey], enabled: false, revision: (Number(all[configKey].revision) || 0) + 1, updatedAt: Date.now() };
      }
    }
    if (Object.keys(updates).length) await chrome.storage.local.set(updates);
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id) {
        try { chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_SITE_PERMISSION_REVOKED", removedOrigins }).catch(() => {}); } catch (_) {}
        // Older already-open page agents may not recognize the dedicated message.
        try { chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_RELOAD_SETTINGS" }).catch(() => {}); } catch (_) {}
      }
    }
  });
}

function hostPatternCovers(grantedPattern, wantedPattern) {
  return ChameleonAccessControl.hostPermissionPatternCovers(grantedPattern, wantedPattern);
}

if (chrome.alarms && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm || alarm.name !== "chameleon-playlist-alarm") return;
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (!tab.id || !isInjectableUrl(tab.url)) continue;
        const state = await getSiteRuntimeState(tab.url);
        if (state.allowed) chrome.tabs.sendMessage(tab.id, { type: "CHAMELEON_ALARM_TICK", timestamp: Date.now() }).catch(() => {});
      }
    } catch (_) {}
  });
}

// ===========================================================================
// 1. BOUNDED CHUNKED PORT MEDIA TRANSPORT (`chameleon-media-port`)
// ===========================================================================
if (chrome.runtime && chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (!port || port.name !== "chameleon-media-port" || !isValidSender(port.sender)) {
      try { port.disconnect(); } catch (_) {}
      return;
    }

    // Active outbound sender sessions on this port: Map<transferId, { session, timeoutId, lastChecksum }>
    const outboundSessions = new Map();
    // Active inbound upload sessions on this port (for legacy migration): Map<transferId, receiverSession>
    const inboundSessions = new Map();
    let isPortDisconnected = false;

    function safePostMessage(payload) {
      if (isPortDisconnected) return false;
      try {
        port.postMessage(payload);
        return true;
      } catch (_) {
        isPortDisconnected = true;
        return false;
      }
    }

    function cleanupTransfer(transferId) {
      const entry = outboundSessions.get(transferId);
      if (entry) {
        if (entry.timeoutId) clearTimeout(entry.timeoutId);
        entry.session.cancel();
        outboundSessions.delete(transferId);
      }
      const inEntry = inboundSessions.get(transferId);
      if (inEntry) {
        inEntry.rx.dispose();
        inboundSessions.delete(transferId);
      }
    }

    function armSessionTimeout(transferId) {
      const entry = outboundSessions.get(transferId);
      if (!entry) return;
      if (entry.timeoutId) clearTimeout(entry.timeoutId);
      entry.timeoutId = setTimeout(() => {
        cleanupTransfer(transferId);
        safePostMessage({
          type: "TRANSFER_ERROR",
          transferId,
          code: "TIMEOUT",
          error: `Media transfer ${transferId} timed out waiting for chunk acknowledgement.`
        });
      }, ChameleonStorageService.DEFAULT_TRANSFER_TIMEOUT_MS);
    }

    async function sendNextSlice(transferId) {
      const entry = outboundSessions.get(transferId);
      if (!entry || isPortDisconnected) return;
      try {
        const packet = await entry.session.readNextChunkPacket();
        if (!packet || isPortDisconnected || !outboundSessions.has(transferId)) return;
        entry.lastChecksum = packet.checksumSoFar;
        armSessionTimeout(transferId);
        safePostMessage({
          type: "TRANSFER_CHUNK",
          ...packet
        });
      } catch (err) {
        cleanupTransfer(transferId);
        safePostMessage({
          type: "TRANSFER_ERROR",
          transferId,
          code: "READ_ERROR",
          error: err.message || String(err)
        });
      }
    }

    port.onMessage.addListener(async (msg) => {
      if (!msg || typeof msg.type !== "string") return;
      const transferId = String(msg.transferId || "");

      if (msg.type === "TRANSFER_REQUEST") {
        if (!transferId || !msg.mediaId) return;
        try {
          // Page-side requesters must belong to an authorized, enabled site.
          if (!isExtensionPageSender(port.sender)) {
            const portState = port.sender && port.sender.url ? await getSiteRuntimeState(port.sender.url) : null;
            if (!portState || !portState.allowed) {
              safePostMessage({ type: "TRANSFER_ERROR", transferId, code: "FORBIDDEN", error: "Media access is not enabled for this site." });
              return;
            }
          }
          const stored = await chrome.storage.local.get(["globalSettings"]);
          const maxMediaSizeBytes = stored.globalSettings?.maxMediaSizeBytes || DEFAULT_GLOBAL_SETTINGS.maxMediaSizeBytes;
          const record = await ChameleonStorageService.getMediaRecordWithBlob(String(msg.mediaId));

          if (!record) {
            safePostMessage({
              type: "TRANSFER_ERROR",
              transferId,
              code: "NOT_FOUND",
              error: `Media item "${msg.mediaId}" was not found.`
            });
            return;
          }

          if (record.mediaType === "preset") {
            safePostMessage({
              type: "TRANSFER_PRESET",
              transferId,
              record
            });
            return;
          }

          if (!record.blob) {
            safePostMessage({
              type: "TRANSFER_ERROR",
              transferId,
              code: "EMPTY_BLOB",
              error: `Media item "${msg.mediaId}" has no binary blob.`
            });
            return;
          }

          const session = ChameleonStorageService.createBoundedBlobSenderSession(record, {
            transferId,
            chunkSizeBytes: msg.chunkSizeBytes || ChameleonStorageService.DEFAULT_CHUNK_SIZE_BYTES,
            maxMediaSizeBytes
          });

          outboundSessions.set(transferId, {
            session,
            timeoutId: null,
            lastChecksum: 0x811c9dc5
          });

          safePostMessage({
            type: "TRANSFER_INIT",
            transferId,
            metadata: session.metadata,
            mimeType: session.mimeType,
            totalBytes: session.totalBytes,
            totalChunks: session.totalChunks,
            chunkSize: session.chunkSize
          });

          await sendNextSlice(transferId);
        } catch (err) {
          cleanupTransfer(transferId);
          safePostMessage({
            type: "TRANSFER_ERROR",
            transferId,
            code: "INIT_FAILED",
            error: err.message || String(err)
          });
        }
      } else if (msg.type === "TRANSFER_ACK") {
        const entry = outboundSessions.get(transferId);
        if (!entry) return;
        if (entry.session.isCompleted()) {
          const finalChecksum = entry.lastChecksum >>> 0;
          const totalBytes = entry.session.totalBytes;
          cleanupTransfer(transferId);
          safePostMessage({
            type: "TRANSFER_COMPLETE",
            transferId,
            totalBytes,
            checksum: finalChecksum
          });
        } else {
          await sendNextSlice(transferId);
        }
      } else if (msg.type === "TRANSFER_CANCEL") {
        cleanupTransfer(transferId);
        safePostMessage({
          type: "TRANSFER_CANCELLED",
          transferId
        });
      } else if (msg.type === "UPLOAD_INIT") {
        try {
          const stored = await chrome.storage.local.get(["globalSettings"]);
          const maxMediaSizeBytes = stored.globalSettings?.maxMediaSizeBytes || DEFAULT_GLOBAL_SETTINGS.maxMediaSizeBytes;
          const incomingId = String(msg.metadata?.id || "").trim();

          // Legacy page-origin migration can be retried after a partial failure. If a prior
          // attempt already imported this ID, acknowledge it without retransferring or replacing
          // the extension-owned record. This makes retries idempotent and protects newer media.
          if (incomingId) {
            const existingRecord = await ChameleonStorageService.getMediaRecordWithBlob(incomingId);
            if (existingRecord) {
              safePostMessage({ type: "UPLOAD_COMPLETE", transferId, skippedExisting: true });
              return;
            }
          }

          const rx = ChameleonStorageService.createBoundedBlobReceiverSession(msg, { maxMediaSizeBytes });
          inboundSessions.set(transferId, { rx, meta: msg.metadata || {} });
          safePostMessage({ type: "UPLOAD_READY", transferId });
        } catch (err) {
          cleanupTransfer(transferId);
          safePostMessage({ type: "UPLOAD_ERROR", transferId, error: err.message });
        }
      } else if (msg.type === "UPLOAD_CHUNK") {
        const inEntry = inboundSessions.get(transferId);
        if (!inEntry) return;
        try {
          const ack = inEntry.rx.acceptChunkPacket(msg);
          safePostMessage({
            type: "UPLOAD_ACK",
            transferId,
            chunkIndex: ack.acknowledgedChunkIndex,
            isComplete: ack.isComplete
          });
        } catch (err) {
          cleanupTransfer(transferId);
          safePostMessage({ type: "UPLOAD_ERROR", transferId, error: err.message });
        }
      } else if (msg.type === "UPLOAD_CANCEL") {
        cleanupTransfer(transferId);
        safePostMessage({ type: "UPLOAD_CANCELLED", transferId });
      } else if (msg.type === "UPLOAD_FINALIZE") {
        const inEntry = inboundSessions.get(transferId);
        if (!inEntry) return;
        try {
          const finalized = inEntry.rx.finalize(msg.checksum);
          inboundSessions.delete(transferId);
          const imported = await ChameleonStorageService.importMediaItem(finalized.blob, {
            id: inEntry.meta.id,
            name: inEntry.meta.name || "Migrated Media",
            mimeType: finalized.blob.type,
            convertToWebP: false,
            preserveOriginal: false,
            skipMetadataProbe: true
          });
          safePostMessage({
            type: "UPLOAD_COMPLETE",
            transferId,
            primaryRecord: imported.primaryRecord
          });
        } catch (err) {
          cleanupTransfer(transferId);
          safePostMessage({ type: "UPLOAD_ERROR", transferId, error: err.message });
        }
      }
    });

    port.onDisconnect.addListener(() => {
      isPortDisconnected = true;
      for (const txId of Array.from(outboundSessions.keys())) {
        cleanupTransfer(txId);
      }
      for (const txId of Array.from(inboundSessions.keys())) {
        cleanupTransfer(txId);
      }
    });
  });
}

// ===========================================================================
// 2. VALIDATED RUNTIME MESSAGE ROUTER
// ===========================================================================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isValidSender(sender) || !message || typeof message.type !== "string") {
    sendResponse({ ok: false, error: "Invalid message or unauthorized sender." });
    return false;
  }

  handleRuntimeMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => {
      sendResponse({
        ok: false,
        error: err && err.message ? err.message : String(err)
      });
    });

  return true;
});

function getLegacyPageMigrationKeyForSender(sender) {
  // Only a content script attached to an ordinary top-level web tab may read/write
  // the migration marker for its own origin. Never trust an origin supplied by page data.
  if (!sender || !sender.tab || sender.frameId !== 0 || !sender.url) {
    throw new Error("Legacy media migration markers are available only to a top-level page content script.");
  }
  let parsed;
  try { parsed = new URL(sender.url); } catch (_) {
    throw new Error("Invalid sender URL for legacy media migration.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Legacy media migration is supported only on HTTP and HTTPS pages.");
  }
  return ChameleonStorageService.legacyPageMediaMigrationStorageKey(parsed.origin);
}

async function handleRuntimeMessage(message, sender) {
  await ensureStartupMigration();
  const type = message.type;

  // Role guard: page content scripts get a narrow allow-list; the rest needs an extension page.
  if (!isExtensionPageSender(sender) && !CONTENT_SCRIPT_MESSAGE_TYPES.has(type)) {
    throw new Error("This command is available only to trusted ChameleonBG extension pages.");
  }

  switch (type) {
    case "CHAMELEON_LEGACY_MEDIA_MIGRATION_STATUS": {
      const markerKey = getLegacyPageMigrationKeyForSender(sender);
      const stored = await chrome.storage.local.get([markerKey]);
      const migration = stored[markerKey] || null;
      return {
        migration,
        completed: Boolean(migration && migration.completed === true)
      };
    }

    case "CHAMELEON_LEGACY_MEDIA_MIGRATION_MARK": {
      const markerKey = getLegacyPageMigrationKeyForSender(sender);
      const requestedStatus = String(message.status || "retryable-failure");
      const successfulStatuses = new Set(["complete", "no-legacy-db", "no-legacy-store", "no-legacy-records"]);
      const completed = message.completed === true && successfulStatuses.has(requestedStatus);
      const current = (await chrome.storage.local.get([markerKey]))[markerKey] || {};
      const migration = {
        ...current,
        status: requestedStatus,
        completed,
        migratedCount: Math.max(0, Number(message.migratedCount) || 0),
        failedCount: Math.max(0, Number(message.failedCount) || 0),
        failedIds: Array.isArray(message.failedIds) ? message.failedIds.slice(0, 100).map((v) => String(v).slice(0, 200)) : [],
        lastError: message.lastError ? String(message.lastError).slice(0, 500) : null,
        updatedAt: Date.now()
      };
      if (completed) migration.completedAt = Date.now();
      else delete migration.completedAt;
      await chrome.storage.local.set({ [markerKey]: migration });
      return { migration, completed };
    }

    case "CHAMELEON_UPDATE_BADGE": {
      const count = Math.max(0, Number(message.count) || 0);
      const tabId = sender.tab ? sender.tab.id : message.tabId;
      if (tabId && chrome.action) {
        await chrome.action.setBadgeText({
          tabId,
          text: count > 0 ? String(count) : ""
        });
        await chrome.action.setBadgeBackgroundColor({
          tabId,
          color: "#0284c7"
        });
      }
      return { count };
    }

    case "CHAMELEON_GET_PAGE_ACCESS_STATE": {
      if (!sender || !sender.tab || sender.frameId !== 0 || !sender.url) {
        throw new Error("Page access state can only be queried by a top-level page content script.");
      }
      return getSiteRuntimeState(sender.url);
    }

    case "CHAMELEON_ENABLE_SITE": {
      const target = await requestTargetTabForEnable(message, sender);
      return performEnableSite(target, {
        permissionRequestConfirmed: message.permissionRequestConfirmed === true,
        acceptedPolicyWarning: message.acceptedPolicyWarning === true
      });
    }

    case "CHAMELEON_BEGIN_ENABLE": {
      // Records the user's explicit consent click BEFORE the browser permission prompt is
      // shown. If the toolbar popup is dismissed by the prompt, permissions.onAdded finishes
      // enabling from this short-lived intent. Extension pages only (role guard above).
      requireTrustedEnableCommand(sender);
      const target = await resolveTargetTabFromExtensionPage(message);
      await chrome.storage.local.set({
        [`${PENDING_ENABLE_KEY_PREFIX}${target.origin}`]: { origin: target.origin, tabId: target.tab.id, createdAt: Date.now() }
      });
      return { pending: true, origin: target.origin };
    }

    case "CHAMELEON_CANCEL_ENABLE": {
      requireTrustedEnableCommand(sender);
      const target = await resolveTargetTabFromExtensionPage(message);
      await chrome.storage.local.remove([`${PENDING_ENABLE_KEY_PREFIX}${target.origin}`]);
      return { cancelled: true };
    }

    case "CHAMELEON_LIST_SITES":
      return { sites: await listSavedSites() };

    case "CHAMELEON_THEME_LIST":
      return { themes: await ChameleonStorageService.listDomainThemes(chrome.storage.local) };

    case "CHAMELEON_THEME_GET": {
      const themeId = String(message.themeId || "");
      const theme = await ChameleonStorageService.getDomainTheme(chrome.storage.local, themeId);
      return { theme };
    }

    case "CHAMELEON_THEME_SAVE": {
      if (!message.theme || typeof message.theme !== "object") {
        throw new Error("Invalid theme payload.");
      }
      const saveRes = await ChameleonStorageService.saveDomainTheme(chrome.storage.local, message.theme);
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id && isInjectableUrl(t.url)) {
          chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_RELOAD_SETTINGS" }).catch(() => {});
        }
      }
      return { ...saveRes, themes: await ChameleonStorageService.listDomainThemes(chrome.storage.local) };
    }

    case "CHAMELEON_THEME_DELETE": {
      const themeId = String(message.themeId || "");
      const delRes = await ChameleonStorageService.deleteDomainTheme(chrome.storage.local, themeId, {
        unassignSites: message.unassignSites !== false,
        deleteSiteConfigs: message.deleteSiteConfigs === true
      });
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id && isInjectableUrl(t.url)) {
          chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_RELOAD_SETTINGS" }).catch(() => {});
        }
      }
      return { ...delRes, themes: await ChameleonStorageService.listDomainThemes(chrome.storage.local) };
    }

    case "CHAMELEON_THEME_ASSIGN_SITE": {
      const siteKey = String(message.siteKey || message.origin || "");
      const themeId = message.themeId ? String(message.themeId) : null;
      const assignRes = await ChameleonStorageService.assignSiteToTheme(chrome.storage.local, siteKey, themeId);
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id && isInjectableUrl(t.url)) {
          chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_RELOAD_SETTINGS" }).catch(() => {});
        }
      }
      return { ...assignRes, sites: await listSavedSites() };
    }

    case "CHAMELEON_GET_MEDIA_REFERENCES": {
      const usage = await ChameleonStorageService.getMediaUsageReferences(chrome.storage.local);
      return { usage };
    }

    case "CHAMELEON_EXPORT_BACKUP": {
      const backup = await ChameleonStorageService.exportBackupData(chrome.storage.local, {
        includeBlobs: message.includeBlobs === true
      });
      return { backup };
    }

    case "CHAMELEON_IMPORT_BACKUP": {
      if (!message.backup || typeof message.backup !== "object") {
        throw new Error("Invalid backup payload for import.");
      }
      const importRes = await ChameleonStorageService.importBackupData(chrome.storage.local, message.backup, {
        mode: message.mode === "replace" ? "replace" : "merge"
      });
      return { ...importRes, sites: await listSavedSites() };
    }

    case "CHAMELEON_CLEAR_ALL_DATA": {
      if (message.confirmed !== true) {
        throw new Error("Clearing all data requires explicit confirmation.");
      }
      const clearRes = await ChameleonStorageService.clearAllChameleonData(chrome.storage.local);
      return { ...clearRes, sites: [] };
    }

    case "CHAMELEON_DELETE_SITE_CONFIG": {
      const parsed = parseSupportedPageUrl(String(message.origin || message.siteKey || ""));
      if (!parsed) throw new Error("A valid website origin is required.");
      const origin = ChameleonStorageService.deriveSiteIdentity(parsed.href).originKey;
      // Removes ONLY the saved structure/settings. Media (IndexedDB), consent and the
      // browser permission are deliberately left untouched.
      await ChameleonStorageService.saveSiteConfigConflictSafe(chrome.storage.local, origin, null, { forceOverwrite: true });
      await chrome.storage.local.remove([siteConfigStorageKey(origin)]);
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        const tabUrl = parseSupportedPageUrl(t.url);
        if (t.id && tabUrl && ChameleonStorageService.deriveSiteIdentity(tabUrl.href).originKey === origin) {
          chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_RELOAD_SETTINGS" }).catch(() => {});
        }
      }
      return { deleted: true, origin, sites: await listSavedSites() };
    }

    case "CHAMELEON_LIST_OPEN_SITES":
      return { sites: await listOpenSiteTabs() };

    case "CHAMELEON_DISABLE_SITE": {
      const target = await requestTargetTabForPopup(message, sender);
      await writeSiteAccess(target.origin, { enabled: false, disabledAt: Date.now(), disabledReason: "user" });
      const profile = await saveExactSiteEnabled(target.origin, false);
      await deactivateTabRuntime(target.tab.id, { origin: target.origin, userInitiated: true });
      return { enabled: false, siteKey: target.origin, siteConfig: profile };
    }

    case "CHAMELEON_REVOKE_SITE_ACCESS": {
      const target = await requestTargetTabForPopup(message, sender);
      const permissionStillGranted = await hasPersistentlyGrantedOriginPattern(target.permissionPattern);
      if (permissionStillGranted) throw new Error("Browser permission is still granted, possibly through a broader host grant. Remove it in the browser's extension site-access settings first.");
      await writeSiteAccess(target.origin, { enabled: false, consentVersion: 0, consentAcceptedAt: null, hostPermissionGrantedAt: null, disabledReason: "permission-revoked", revokedAt: Date.now() });
      const profile = await saveExactSiteEnabled(target.origin, false);
      await deactivateTabRuntime(target.tab.id, { origin: target.origin, permissionRevoked: true });
      return { enabled: false, permissionGranted: false, siteKey: target.origin, siteConfig: profile };
    }

    case "CHAMELEON_GET_OVERVIEW": {
      const isPrivileged = isExtensionPageSender(sender);
      const stored = await chrome.storage.local.get(["globalSettings"]);
      const globalSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...(stored.globalSettings || {}) };
      let targetRef = message.siteKey || message.origin || message.url || message.hostname || "https://local-page";
      if (!isPrivileged) {
        if (!sender || !sender.tab || sender.frameId !== 0 || !sender.url) {
          throw new Error("Overview queries from content scripts require a top-level webpage context.");
        }
        targetRef = sender.url;
      }
      const identity = ChameleonStorageService.deriveSiteIdentity(targetRef);
      const exactKey = siteConfigStorageKey(identity.originKey);
      const accessKey = siteAccessStorageKey(identity.originKey);
      const exactFetch = await chrome.storage.local.get([exactKey, accessKey]);
      const resolvedSite = await ChameleonStorageService.getSiteConfigForTarget(chrome.storage.local, targetRef);
      const state = await getSiteRuntimeState(/^https?:\/\//i.test(String(targetRef)) ? String(targetRef) : identity.originKey);
      if (!isPrivileged) {
        return {
          globalSettings,
          siteKey: resolvedSite.siteKey,
          hostnameConfig: resolvedSite.siteConfig,
          exactSiteConfig: resolvedSite.domainTheme ? resolvedSite.siteConfig : (exactFetch[exactKey] || null),
          siteAccess: exactFetch[accessKey] || null,
          siteRuntimeState: state,
          storageStats: null,
          mediaItems: []
        };
      }
      const stats = await ChameleonStorageService.getStorageUsageStats();
      const mediaItems = await ChameleonStorageService.listMediaMetadata({
        includePresets: true,
        query: message.query || "",
        mediaType: message.mediaType || "all",
        sortBy: message.sortBy || "newest"
      });
      return {
        globalSettings,
        siteKey: resolvedSite.siteKey,
        hostnameConfig: resolvedSite.siteConfig,
        exactSiteConfig: exactFetch[exactKey] || null,
        siteAccess: exactFetch[accessKey] || null,
        siteRuntimeState: state,
        storageStats: stats,
        mediaItems
      };
    }

    case "CHAMELEON_MEDIA_LIST": {
      const mediaItems = await ChameleonStorageService.listMediaMetadata({
        includePresets: message.includePresets !== false,
        query: message.query || "",
        mediaType: message.mediaType || "all",
        sortBy: message.sortBy || "newest"
      });
      const storageStats = await ChameleonStorageService.getStorageUsageStats();
      return { mediaItems, storageStats };
    }

    case "CHAMELEON_MEDIA_DELETE": {
      const mediaId = String(message.mediaId || "");
      await ChameleonStorageService.deleteMediaRecord(mediaId);
      await ChameleonStorageService.pruneDeletedMediaReferences(chrome.storage.local, mediaId);
      const storageStats = await ChameleonStorageService.getStorageUsageStats();
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (t.id && isInjectableUrl(t.url)) {
          chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_MEDIA_DELETED", mediaId }).catch(() => {});
        }
      }
      return { deletedId: mediaId, storageStats };
    }

    case "CHAMELEON_SAVE_SITE_CONFIG": {
      let targetKey = String(message.siteKey || message.origin || message.hostname || "").trim();
      if (!isExtensionPageSender(sender)) {
        // A page content script may only save the profile of its own exact origin.
        const senderUrl = parseSupportedPageUrl(sender && sender.url);
        if (!senderUrl || !sender.tab || sender.frameId !== 0) throw new Error("Site config saves must come from a top-level page.");
        const senderKey = ChameleonStorageService.deriveSiteIdentity(senderUrl.href).originKey;
        if (targetKey && targetKey !== senderKey) throw new Error("Site config save did not match the sending page.");
        const runtimeState = await getSiteRuntimeState(senderUrl.href);
        if (!runtimeState.allowed) throw new Error("ChameleonBG site access is not enabled for this page.");
        targetKey = senderKey;
      }
      if (!targetKey) throw new Error("Missing siteKey or origin.");

      const saveResult = await ChameleonStorageService.saveSiteConfigConflictSafe(
        chrome.storage.local,
        targetKey,
        message.siteConfig,
        {
          expectedRevision: message.expectedRevision,
          baseComponents: message.baseComponents,
          forceOverwrite: Boolean(message.forceOverwrite)
        }
      );

      if (!saveResult.ok && saveResult.conflict) {
        return {
          ok: false,
          conflict: true,
          siteKey: saveResult.siteKey,
          expectedRevision: saveResult.expectedRevision,
          currentRevision: saveResult.currentRevision,
          currentConfig: saveResult.currentConfig,
          error: saveResult.error
        };
      }

      const notifiedTabIds = new Set();
      if (message.targetTabId) {
        notifiedTabIds.add(Number(message.targetTabId));
        chrome.tabs.sendMessage(message.targetTabId, {
          type: "CHAMELEON_RELOAD_SETTINGS",
          siteConfig: saveResult.siteConfig
        }).catch(() => {});
      }
      const openTabs = await chrome.tabs.query({}).catch(() => []);
      for (const t of openTabs) {
        if (!t.id || notifiedTabIds.has(t.id) || !isInjectableUrl(t.url)) continue;
        const tabIdentity = ChameleonStorageService.deriveSiteIdentity(t.url);
        const matchRes = ChameleonStorageService.doesSiteRecordMatchIdentity(saveResult.siteConfig, tabIdentity);
        if (matchRes.matches || tabIdentity.originKey === saveResult.siteKey) {
          chrome.tabs.sendMessage(t.id, {
            type: "CHAMELEON_RELOAD_SETTINGS",
            siteConfig: saveResult.siteConfig
          }).catch(() => {});
        }
      }
      return {
        conflict: false,
        mergedNonOverlapping: saveResult.mergedNonOverlapping,
        siteKey: saveResult.siteKey,
        revision: saveResult.revision,
        siteConfig: saveResult.siteConfig
      };
    }

    case "CHAMELEON_SAVE_GLOBAL_SETTINGS": {
      const stored = await chrome.storage.local.get(["globalSettings"]);
      const updated = {
        ...DEFAULT_GLOBAL_SETTINGS,
        ...(stored.globalSettings || {}),
        ...sanitizeGlobalSettingsPatch(message.globalSettings)
      };
      await chrome.storage.local.set({ globalSettings: updated });
      const tabs = await chrome.tabs.query({});
      for (const t of tabs) {
        if (!t.id || !isInjectableUrl(t.url)) continue;
        const state = await getSiteRuntimeState(t.url);
        if (state.allowed) chrome.tabs.sendMessage(t.id, { type: "CHAMELEON_RELOAD_SETTINGS" }).catch(() => {});
        else await deactivateTabRuntime(t.id, { origin: state.origin || null, globalPause: true });
      }
      return { globalSettings: updated };
    }

    case "CHAMELEON_OPEN_FULL_STUDIO": {
      const targetTabId = message.tabId || (sender.tab ? sender.tab.id : null);
      const targetSiteKey = message.siteKey || message.origin || message.hostname || "";
      const viewTab = message.section || "editor";
      if (viewTab === "editor" && targetTabId) {
        const target = await chrome.tabs.get(Number(targetTabId)).catch(() => null);
        const state = target ? await getSiteRuntimeState(target.url) : null;
        if (!state || !state.allowed) throw new Error(state?.reason || "Enable ChameleonBG for this site from the popup before opening the live editor.");
      }
      const result = await openOrFocusStudio({
        tabId: targetTabId,
        siteKey: targetSiteKey,
        section: viewTab,
        startPicker: message.startPicker === true
      });
      return { studioTabId: result.studioTabId, reused: result.reused };
    }

    case "CHAMELEON_COMPONENT_PICKED_EVENT": {
      // The page-side content script reports a confirmed component selection.
      // Validate its sender and bind the event to the actual tab URL before relaying
      // a minimal payload to extension pages. Never forward page-provided locator
      // objects or arbitrary DOM data through this event channel.
      if (!sender || !sender.tab || !Number.isInteger(sender.tab.id) || sender.frameId !== 0 || !sender.url) {
        throw new Error("Component selection events must originate from a top-level authorized webpage.");
      }
      const parsedSenderUrl = parseSupportedPageUrl(sender.url);
      if (!parsedSenderUrl) throw new Error("Component selection originated from an unsupported page.");
      const identity = ChameleonStorageService.deriveSiteIdentity(parsedSenderUrl.href);
      if (typeof message.siteKey !== "string" || message.siteKey !== identity.originKey) {
        throw new Error("Component selection site identity did not match the sending tab.");
      }
      const compId = typeof message.compId === "string" ? message.compId : "";
      if (!compId || compId.length > 300 || /[\u0000-\u001f]/.test(compId)) {
        throw new Error("Component selection identifier is invalid.");
      }
      const runtimeState = await getSiteRuntimeState(parsedSenderUrl.href);
      if (!runtimeState.allowed) throw new Error("ChameleonBG site access is no longer enabled for this page.");

      // Use a distinct relay type to avoid relying on undocumented assumptions about
      // whether sibling extension pages receive the original content-script message.
      try {
        await chrome.runtime.sendMessage({
          type: "CHAMELEON_COMPONENT_PICKED_BROADCAST",
          targetTabId: sender.tab.id,
          siteKey: identity.originKey,
          compId
        });
      } catch (_) {
        // If no studio is open, keep the content-side selection valid without
        // turning a harmless missing receiver into an uncaught messaging error.
      }
      return { eventRelayed: true, targetTabId: sender.tab.id };
    }

    case "CHAMELEON_COMPONENT_PICKED_BROADCAST": {
      // Runtime messages are broadcast to extension contexts; if this relay reaches
      // the background listener too, acknowledge it without re-broadcasting.
      return { ignored: true };
    }

    case "CHAMELEON_CHECK_TAB_CAPABILITY": {
      if (!isTrustedPopupCommand(sender) && !isTrustedSiteAccessCommand(sender) && !isTrustedStudioCommand(sender)) {
        throw new Error("Tab capability checks are available only to trusted ChameleonBG extension pages.");
      }
      const tabId = Number(message.tabId);
      if (!Number.isInteger(tabId) || tabId < 0) return { supported: false, reason: "No active website tab selected." };
      try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab || !isInjectableUrl(tab.url)) {
          return {
            supported: false,
            url: tab?.url || "",
            reason: "This browser page is protected by browser security rules and cannot be customized by extensions."
          };
        }
        const state = await getSiteRuntimeState(tab.url);
        let agentReady = false;
        let injectionError = null;
        // This is a recovery path for previously authorized sites: if a navigation
        // event was missed or the browser restarted during a load, retry injection
        // only after the policy gate has already allowed this exact origin.
        if (state.allowed) {
          const injection = await maybeInjectAuthorizedTab(tab);
          agentReady = Boolean(injection.injected || (injection.alreadyLoaded && injection.acknowledged !== false));
          injectionError = agentReady ? null : (injection.error || "The page agent could not be started. Reload the tab and try again.");
        }
        const identity = ChameleonStorageService.deriveSiteIdentity(tab.url);
        return {
          supported: true,
          url: tab.url,
          siteKey: identity.originKey,
          hostname: identity.hostname,
          title: tab.title || "",
          origin: identity.originKey,
          originPattern: originPermissionPatternForUrl(tab.url),
          permissionGranted: state.permissionGranted,
          persistentHostPermissionPresent: state.persistentHostPermissionPresent,
          persistentGrantRecorded: state.persistentGrantRecorded,
          consentAccepted: state.consentAccepted,
          siteEnabled: state.siteEnabled,
          runtimeEnabled: state.runtimeEnabled && agentReady,
          pageAgentReady: agentReady,
          injectionError,
          extensionGloballyEnabled: state.extensionGloballyEnabled,
          accessReason: injectionError || state.reason,
          siteAccess: state.siteAccess
        };
      } catch (_) {
        return { supported: false, reason: "Could not access the target tab." };
      }
    }

    case "CHAMELEON_CLAIM_AUDIO_FOCUS": {
      const tabId = (sender && sender.tab) ? sender.tab.id : Number(message.tabId);
      const compId = typeof message.compId === "string" ? message.compId : "";
      return await claimGlobalAudioFocus(tabId, compId);
    }

    case "CHAMELEON_RELEASE_AUDIO_FOCUS": {
      const tabId = (sender && sender.tab) ? sender.tab.id : Number(message.tabId);
      const compId = typeof message.compId === "string" ? message.compId : "";
      return await releaseGlobalAudioFocus(tabId, compId);
    }

    case "CHAMELEON_GET_GLOBAL_AUDIO_STATE": {
      return { audibleOwner: await readGlobalAudibleSource() };
    }

    default:
      throw new Error(`Unsupported message type: ${type}`);
  }
}
