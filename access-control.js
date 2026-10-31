/**
 * ChameleonBG v2.0.3 — Pure site-access policy helpers.
 * These helpers deliberately contain no Chrome API calls so permission policy can be tested.
 */
(function (root) {
  "use strict";

  const SITE_CONSENT_VERSION = 1;
  const SITE_ACCESS_KEY_PREFIX = "siteAccess::";

  function parseSupportedPageUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return null;
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return null;
      return url;
    } catch (_) {
      return null;
    }
  }

  // Host permissions in Chrome match schemes/hosts/paths but not ports. This grant
  // therefore covers a host across its ports; exact-origin profile checks below limit
  // ChameleonBG's actual activation to the saved origin.
  function originPermissionPatternForUrl(rawUrl) {
    const url = parseSupportedPageUrl(rawUrl);
    if (!url) return null;
    return `${url.protocol}//${url.hostname}/*`;
  }

  function hostPermissionPatternCovers(grantedPattern, wantedPattern) {
    if (typeof grantedPattern !== "string" || typeof wantedPattern !== "string") return false;
    if (grantedPattern === "<all_urls>") return true;
    // `permissions.getAll()` may return a match pattern (`/*`) or an origin-style
    // trailing slash. Paths do not narrow a Chrome host permission's page access.
    const granted = grantedPattern.match(/^(\*|https?|ftp):\/\/([^/]+)(?:\/.*)?$/i);
    const wanted = wantedPattern.match(/^(https?):\/\/([^/]+)(?:\/.*)?$/i);
    if (!granted || !wanted) return grantedPattern === wantedPattern;
    const schemeOk = granted[1] === "*" || granted[1].toLowerCase() === wanted[1].toLowerCase();
    const host = granted[2].toLowerCase();
    const targetHost = wanted[2].toLowerCase();
    const hostOk = host === "*" || host === targetHost || (host.startsWith("*.") && (targetHost === host.slice(2) || targetHost.endsWith("." + host.slice(2))));
    return schemeOk && hostOk;
  }

  function siteAccessStorageKey(origin) {
    let parsed;
    try { parsed = new URL(String(origin || "")); }
    catch (_) { return null; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.origin === "null") return null;
    return `${SITE_ACCESS_KEY_PREFIX}${encodeURIComponent(parsed.origin.toLowerCase())}`;
  }


  function hasPersistentHostGrant(browserPermissionPresent, siteAccess, permissionPattern) {
    return Boolean(
      browserPermissionPresent === true &&
      siteAccess && typeof siteAccess === "object" &&
      Number(siteAccess.hostPermissionGrantedAt) > 0 &&
      typeof permissionPattern === "string" &&
      (siteAccess.permissionPattern === permissionPattern ||
       hostPermissionPatternCovers(siteAccess.permissionPattern, permissionPattern))
    );
  }

  function evaluateSiteAccess(input = {}) {
    const url = parseSupportedPageUrl(input.pageUrl || "");
    if (!url) {
      return {
        supported: false,
        permissionGranted: false,
        consentAccepted: false,
        siteEnabled: false,
        runtimeEnabled: false,
        allowed: false,
        reason: "This browser page cannot be customized by extensions."
      };
    }

    const access = input.siteAccess && typeof input.siteAccess === "object" ? input.siteAccess : null;
    const config = input.siteConfig && typeof input.siteConfig === "object" ? input.siteConfig : null;
    const settings = input.globalSettings && typeof input.globalSettings === "object" ? input.globalSettings : {};
    const permissionGranted = input.permissionGranted === true;
    const consentAccepted = Boolean(
      access && access.consentVersion === SITE_CONSENT_VERSION && Number(access.consentAcceptedAt) > 0
    );
    const siteEnabled = Boolean(
      permissionGranted && consentAccepted && access.enabled === true && (!config || config.enabled !== false)
    );
    const extensionGloballyEnabled = settings.extensionEnabled !== false;
    const runtimeEnabled = siteEnabled && extensionGloballyEnabled;

    let reason = "";
    if (!permissionGranted) reason = "ChameleonBG does not have browser permission for this site yet.";
    else if (!consentAccepted) reason = "Review the site-use warning before enabling ChameleonBG here.";
    else if (!access.enabled || (config && config.enabled === false)) reason = "ChameleonBG is turned off for this site.";
    else if (!extensionGloballyEnabled) reason = "ChameleonBG is globally paused in Settings.";

    return {
      supported: true,
      allowed: runtimeEnabled,
      siteEnabled,
      runtimeEnabled,
      permissionGranted,
      consentAccepted,
      extensionGloballyEnabled,
      origin: url.origin.toLowerCase(),
      hostname: url.hostname.toLowerCase(),
      permissionPattern: originPermissionPatternForUrl(url.href),
      reason
    };
  }

  const api = Object.freeze({
    SITE_CONSENT_VERSION,
    SITE_ACCESS_KEY_PREFIX,
    parseSupportedPageUrl,
    originPermissionPatternForUrl,
    hostPermissionPatternCovers,
    siteAccessStorageKey,
    hasPersistentHostGrant,
    evaluateSiteAccess
  });

  root.ChameleonAccessControl = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
