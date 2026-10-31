/**
 * ChameleonBG v2.0.2 — Visual Component Selection, Intelligent Discovery,
 * Same-Origin Frame Traversal & Multi-Signal Locator Engine (`selection-engine.js`)
 *
 * Hardening improvements in v2.0.1:
 * 1. Zero Unsafe HTML Construction: All Shadow-DOM overlay elements and labels are constructed
 *    using `document.createElement` and `textContent`—never `innerHTML` with page-derived strings.
 * 2. Accurate Iframe & Shadow-Root Compatibility:
 *    - Traverses accessible same-origin `<iframe>` documents (`contentDocument`) and open shadow roots,
 *      persisting `frameSelector` and `shadowHostPath` inside `ComponentLocator.context`.
 *    - Detects cross-origin and sandboxed iframes (`sandbox` without `allow-same-origin`),
 *      explaining clearly why they cannot be customized without breaking the parent page.
 */

(function (globalScope) {
  "use strict";

  const VOLATILE_CLASS_PATTERN = /^(css-[a-z0-9]+|sc-[a-zA-Z0-9]+|jsx-\d+|svelte-[a-z0-9]+|tw-[a-z0-9-]+|_[a-zA-Z0-9]{5,}|active|hover|focus|selected|open|closed|visible|hidden|is-[a-z-]+|has-[a-z-]+|js-[a-z-]+|chameleon-.*)$/i;
  const VOLATILE_ID_PATTERN = /(:r[0-9a-z]+:|ember\d+|react-select-\d+|headlessui-[a-z-]+-\d+|mui-\d+|uid-\d+|[0-9a-f]{8}-[0-9a-f]{4})/i;

  const UNSUITABLE_TAGS = new Set([
    "SCRIPT", "STYLE", "LINK", "META", "HEAD", "TITLE", "NOSCRIPT", "TEMPLATE",
    "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "LABEL",
    "IMG", "VIDEO", "AUDIO", "CANVAS", "SVG", "PATH", "OBJECT", "EMBED",
    "BR", "HR", "WBR", "MAP", "AREA", "PARAM", "SOURCE", "TRACK"
  ]);

  const FALLBACK_ONLY_TAGS = new Set([
    "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "UL", "OL", "DL", "FIELDSET", "SUMMARY"
  ]);

  function isExtensionOwnedElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (
      el.id === "chameleon-bg-studio-host" ||
      el.id === "chameleon-selection-overlay-host" ||
      el.hasAttribute("data-chameleon-owned") ||
      el.classList?.contains("chameleon-bg-layer-wrap") ||
      el.classList?.contains("chameleon-bg-media") ||
      el.classList?.contains("chameleon-bg-tint")
    ) {
      return true;
    }
    if (typeof el.closest === "function") {
      if (el.closest("#chameleon-bg-studio-host, #chameleon-selection-overlay-host, [data-chameleon-owned='true'], .chameleon-bg-layer-wrap")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check whether an `<iframe>` element is accessible under Same-Origin Policy and sandbox rules.
   */
  function inspectIframeAccessibility(iframeEl) {
    if (!iframeEl || iframeEl.tagName?.toUpperCase() !== "IFRAME") {
      return { accessible: false, status: "not-iframe", reason: "Not an iframe element." };
    }
    const sandboxAttr = iframeEl.getAttribute("sandbox");
    if (sandboxAttr !== null && !/\ballow-same-origin\b/i.test(sandboxAttr)) {
      return {
        accessible: false,
        status: "sandboxed-frame",
        reason: "Sandboxed iframe (without allow-same-origin) is isolated by browser security policy and cannot be customized."
      };
    }
    try {
      const subDoc = iframeEl.contentDocument;
      const subWin = iframeEl.contentWindow;
      if (!subDoc || !subDoc.body || !subWin) {
        return {
          accessible: false,
          status: "cross-origin-frame",
          reason: "Cross-origin iframe cannot be inspected or modified due to browser security boundaries."
        };
      }
      // Touch location.href to verify same-origin read access
      const _href = subWin.location.href;
      return {
        accessible: true,
        status: "same-origin-frame",
        contentDocument: subDoc,
        contentWindow: subWin,
        href: _href
      };
    } catch (_) {
      return {
        accessible: false,
        status: "cross-origin-frame",
        reason: "Cross-origin iframe cannot be inspected or modified due to browser security boundaries."
      };
    }
  }

  /**
   * Evaluate whether an element is suitable for background customization and which rendering mode applies.
   */
  function assessElementSuitability(el, win = window) {
    if (!el || el.nodeType !== 1 || isExtensionOwnedElement(el)) {
      return {
        suitable: false,
        recommendedMode: "none",
        reason: "Extension interface or non-element node."
      };
    }

    const doc = el.ownerDocument || document;
    const effectiveWin = doc.defaultView || win || window;

    if (el === doc.body || el === doc.documentElement) {
      const isInsideFrame = effectiveWin !== window.top && effectiveWin !== window;
      return {
        suitable: true,
        recommendedMode: isInsideFrame ? "mode-b" : "mode-a",
        badgeText: isInsideFrame ? "Suitable • Frame Body Layer" : "Suitable • Whole-Page Backdrop",
        reason: isInsideFrame ? "Same-origin iframe body layer." : "Full-viewport backdrop layer."
      };
    }

    const tag = el.tagName.toUpperCase();
    if (tag === "IFRAME") {
      const frameCheck = inspectIframeAccessibility(el);
      if (!frameCheck.accessible) {
        return {
          suitable: false,
          recommendedMode: "none",
          badgeText: "Unsupported Frame • Security Boundary",
          reason: frameCheck.reason
        };
      }
      return {
        suitable: false,
        recommendedMode: "none",
        badgeText: "Same-Origin Frame Container • Select Inner Region",
        reason: "Move pointer inside this same-origin frame to select a specific section, or select its parent wrapper."
      };
    }

    if (UNSUITABLE_TAGS.has(tag)) {
      return {
        suitable: false,
        recommendedMode: "none",
        badgeText: "Not Suitable • Interactive or Media Control",
        reason: `<${tag.toLowerCase()}> is a replaced or interactive control that cannot host a background layer.`
      };
    }

    const rect = el.getBoundingClientRect();
    if (rect.width < 48 || rect.height < 32) {
      return {
        suitable: false,
        recommendedMode: "none",
        badgeText: "Too Small (< 48×32 px)",
        reason: "Element is too small to display a meaningful background."
      };
    }

    const computed = effectiveWin.getComputedStyle(el);
    if (computed.display === "none" || computed.visibility === "hidden" || computed.display === "inline") {
      return {
        suitable: false,
        recommendedMode: "none",
        badgeText: computed.display === "inline" ? "Not Suitable • Inline Text Span" : "Hidden Element",
        reason: computed.display === "inline"
          ? "Inline elements cannot host block background layers safely; select its parent container."
          : "Element is not currently visible."
      };
    }

    if (FALLBACK_ONLY_TAGS.has(tag) || computed.display.startsWith("table")) {
      return {
        suitable: true,
        recommendedMode: "mode-c",
        badgeText: "Suitable • Direct Style Fallback (Mode C)",
        reason: "Table or list structure uses controlled background styling to preserve child layout."
      };
    }

    return {
      suitable: true,
      recommendedMode: "mode-b",
      badgeText: "Suitable • Independent Layer (Mode B)",
      reason: "Supports an isolated background layer behind its content."
    };
  }

  /**
   * Generate a clean, human-readable semantic label for any DOM element.
   */
  function generateHumanLabel(el, win = window) {
    if (!el || el.nodeType !== 1) return "Page Area";
    const doc = el.ownerDocument || document;
    const effectiveWin = doc.defaultView || win || window;

    if (el === doc.body || el === doc.documentElement) {
      return effectiveWin !== window ? "Embedded Frame Backdrop" : "Entire Website";
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "iframe") {
      const fCheck = inspectIframeAccessibility(el);
      return fCheck.accessible ? "Same-Origin Embedded Frame" : "Restricted Embedded Frame";
    }

    const role = (el.getAttribute("role") || "").toLowerCase().trim();
    const ariaLabel = (el.getAttribute("aria-label") || "").trim();
    const labelledById = (el.getAttribute("aria-labelledby") || "").trim();
    let labelledByText = "";
    if (labelledById) {
      const refEl = doc.getElementById(labelledById.split(/\s+/)[0]);
      if (refEl) labelledByText = (refEl.textContent || "").trim().slice(0, 36);
    }

    const classAndIdHint = `${el.id || ""} ${typeof el.className === "string" ? el.className : ""}`.toLowerCase();

    if (tag === "header" || role === "banner" || /\b(site-header|masthead|topbar)\b/.test(classAndIdHint)) {
      return ariaLabel ? `Top Header (${truncateText(ariaLabel, 24)})` : "Top Header";
    }
    if (tag === "nav" || role === "navigation" || /\b(navbar|nav-bar|main-nav|navigation)\b/.test(classAndIdHint)) {
      return ariaLabel ? `Navigation (${truncateText(ariaLabel, 24)})` : "Top Navigation";
    }
    if (tag === "main" || role === "main" || /\b(main-content|primary-content)\b/.test(classAndIdHint)) {
      return "Main Content";
    }
    if (tag === "article" || role === "article" || /\b(article-body|post-content|story-body)\b/.test(classAndIdHint)) {
      const h = findNearestHeadingText(el);
      return h ? `Article Body — "${truncateText(h, 26)}"` : "Article Body";
    }
    if (tag === "aside" || role === "complementary" || /\b(sidebar|side-nav|right-rail|left-rail)\b/.test(classAndIdHint)) {
      const rect = el.getBoundingClientRect();
      const vw = Math.max(effectiveWin.innerWidth || 1024, 1);
      if (rect.left > vw * 0.55) return "Right Sidebar";
      if (rect.right < vw * 0.45) return "Left Sidebar";
      return "Sidebar";
    }
    if (tag === "footer" || role === "contentinfo" || /\b(site-footer|page-footer)\b/.test(classAndIdHint)) {
      return "Footer";
    }

    if (/\b(hero|jumbotron|masthead-banner|spotlight)\b/.test(classAndIdHint)) {
      const h = findNearestHeadingText(el);
      return h ? `Hero Banner — "${truncateText(h, 24)}"` : "Hero Banner";
    }
    if (/\b(gallery|carousel|lightbox|media-grid|photo-grid|product-gallery)\b/.test(classAndIdHint)) {
      return "Product Gallery";
    }
    if (/\b(player|video-container|theater|media-player)\b/.test(classAndIdHint) || el.querySelector("video")) {
      return "Video Player Area";
    }
    if (/\b(card|tile|panel|widget|feature-box|pricing-tier)\b/.test(classAndIdHint)) {
      const h = findNearestHeadingText(el);
      return h ? `Feature Card — "${truncateText(h, 24)}"` : "Feature Card";
    }
    if (/\b(feed|timeline|stream|results-list|post-list)\b/.test(classAndIdHint)) {
      return "Content Feed";
    }
    if (tag === "form" || role === "search" || role === "form") {
      return role === "search" ? "Search Panel" : "Form Container";
    }
    if (tag === "section" || role === "region") {
      const labelSource = ariaLabel || labelledByText || findNearestHeadingText(el);
      if (labelSource) return `Section — "${truncateText(labelSource, 28)}"`;
      return "Content Section";
    }

    const headingText = ariaLabel || labelledByText || findNearestHeadingText(el);
    if (headingText) {
      return `Content Block — "${truncateText(headingText, 26)}"`;
    }

    const rect = el.getBoundingClientRect();
    const vw = Math.max(effectiveWin.innerWidth || 1024, 1);
    const vh = Math.max(effectiveWin.innerHeight || 768, 1);
    if (rect.width >= vw * 0.85 && rect.top < vh * 0.25 && rect.height < 140) {
      return "Top Bar Region";
    }
    if (rect.width >= vw * 0.7 && rect.height >= vh * 0.4) {
      return "Primary Page Container";
    }
    if (rect.width < vw * 0.38 && rect.height >= vh * 0.35) {
      return rect.left < vw * 0.5 ? "Left Column Panel" : "Right Column Panel";
    }
    return "Content Panel";
  }

  function findNearestHeadingText(el) {
    if (!el || typeof el.querySelector !== "function") return "";
    const heading = el.querySelector("h1, h2, h3, h4, [role='heading']");
    if (heading && heading.textContent) {
      const cleaned = heading.textContent.replace(/\s+/g, " ").trim();
      if (cleaned.length >= 2) return cleaned;
    }
    return "";
  }

  function truncateText(str, maxLen = 28) {
    const s = String(str || "").replace(/\s+/g, " ").trim();
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 1).trim() + "…";
  }

  function extractStableId(el) {
    const id = (el.id || "").trim();
    if (!id || id.length > 64) return null;
    if (VOLATILE_ID_PATTERN.test(id)) return null;
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) return id;
    return null;
  }

  function extractStableClasses(el) {
    if (!el || !el.classList) return [];
    const out = [];
    for (const cls of Array.from(el.classList)) {
      if (cls.length < 3 || cls.length > 36) continue;
      if (VOLATILE_CLASS_PATTERN.test(cls)) continue;
      if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(cls)) {
        out.push(cls);
      }
      if (out.length >= 4) break;
    }
    return out;
  }

  function extractStableAttributes(el) {
    const attrs = {};
    const candidateNames = [
      "data-testid", "data-test", "data-qa", "data-component",
      "data-section", "data-region", "role", "aria-label", "name"
    ];
    for (const attrName of candidateNames) {
      const val = el.getAttribute(attrName);
      if (val && val.trim().length > 0 && val.trim().length <= 64 && !VOLATILE_ID_PATTERN.test(val)) {
        attrs[attrName] = val.trim();
      }
    }
    return attrs;
  }

  function buildParentSignature(el, maxDepth = 4) {
    const chain = [];
    let curr = el.parentElement;
    const doc = el.ownerDocument || document;
    while (curr && curr !== doc.body && curr !== doc.documentElement && chain.length < maxDepth) {
      const tag = curr.tagName.toLowerCase();
      const role = curr.getAttribute("role") || null;
      const stableId = extractStableId(curr);
      const stableClasses = extractStableClasses(curr).slice(0, 2);
      let sameTagIndex = 0;
      if (curr.parentElement) {
        const siblings = Array.from(curr.parentElement.children).filter((c) => c.tagName === curr.tagName);
        sameTagIndex = siblings.indexOf(curr);
      }
      chain.push({ tag, role, stableId, stableClasses, sameTagIndex });
      curr = curr.parentElement;
    }
    return chain;
  }

  function buildChildSignature(el) {
    const children = Array.from(el.children || []).filter((c) => !isExtensionOwnedElement(c));
    let landmarkCount = 0;
    let headingCount = 0;
    let hasMedia = false;
    let hasForm = false;

    for (const c of children) {
      const t = c.tagName.toLowerCase();
      if (["header", "nav", "main", "article", "aside", "section", "footer"].includes(t)) landmarkCount++;
      if (/^h[1-6]$/.test(t)) headingCount++;
      if (["img", "video", "picture", "figure"].includes(t)) hasMedia = true;
      if (t === "form") hasForm = true;
    }
    if (!headingCount && el.querySelector("h1, h2, h3")) headingCount = 1;
    if (!hasMedia && el.querySelector("img, video")) hasMedia = true;

    return {
      childCount: children.length,
      landmarkCount,
      headingCount,
      hasMedia,
      hasForm
    };
  }

  function buildFallbackSelector(el) {
    const doc = el.ownerDocument || document;
    if (!el || el === doc.body || el === doc.documentElement) return "body";
    const stableId = extractStableId(el);
    if (stableId && typeof CSS !== "undefined" && CSS.escape) {
      return `#${CSS.escape(stableId)}`;
    }
    const nameAttr = el.getAttribute("name");
    if (el.tagName.toUpperCase() === "IFRAME" && nameAttr && /^[a-zA-Z0-9_-]+$/.test(nameAttr)) {
      return `iframe[name="${nameAttr}"]`;
    }
    const path = [];
    let curr = el;
    while (curr && curr !== doc.body && curr !== doc.documentElement && path.length < 5) {
      const tag = curr.tagName.toLowerCase();
      const id = extractStableId(curr);
      if (id && typeof CSS !== "undefined" && CSS.escape) {
        path.unshift(`#${CSS.escape(id)}`);
        break;
      }
      const parent = curr.parentElement;
      if (!parent) {
        path.unshift(tag);
        break;
      }
      const allSameTagSiblings = Array.from(parent.children).filter((c) => c.tagName === curr.tagName);
      const nonExtSameTagSiblings = allSameTagSiblings.filter((c) => !isExtensionOwnedElement(c));
      const idx = allSameTagSiblings.indexOf(curr) + 1;
      path.unshift((nonExtSameTagSiblings.length > 1 || allSameTagSiblings.length > 1) ? `${tag}:nth-of-type(${idx})` : tag);
      curr = parent;
    }
    return path.join(" > ") || "body";
  }

  /**
   * Build a structured, multi-signal ComponentLocator for a selected DOM element.
   * Supports top-level elements, open shadow roots, and same-origin iframe elements.
   */
  function createComponentLocator(el, win = window, context = {}) {
    const doc = (el && el.ownerDocument) || document;
    const effectiveWin = doc.defaultView || win || window;
    const isWholePage = (!el || el === doc.body || el === doc.documentElement) && !context.frameSelector;

    if (isWholePage) {
      return {
        id: "root_page",
        isWholePage: true,
        label: "Entire Website",
        tagName: "body",
        role: "document",
        stableId: null,
        stableAttributes: {},
        stableClasses: [],
        accessibleName: null,
        headingClue: null,
        parentSignature: [],
        childSignature: {},
        geometry: { nx: 0, ny: 0, nw: 1, nh: 1, aspectRatio: 1.5 },
        context: { frameSelector: null, shadowHostPath: null },
        fallbackSelector: "body"
      };
    }

    const vw = Math.max(effectiveWin.innerWidth || 1024, 1);
    const vh = Math.max(effectiveWin.innerHeight || 768, 1);
    const rect = el.getBoundingClientRect();
    const scrollX = effectiveWin.scrollX || effectiveWin.pageXOffset || 0;
    const scrollY = effectiveWin.scrollY || effectiveWin.pageYOffset || 0;

    const stableId = extractStableId(el);
    const stableAttributes = extractStableAttributes(el);
    const stableClasses = extractStableClasses(el);
    const headingClue = truncateText(findNearestHeadingText(el), 60) || null;
    const accessibleName = truncateText(el.getAttribute("aria-label") || el.getAttribute("title") || "", 60) || null;
    const baseLabel = generateHumanLabel(el, effectiveWin);
    const label = context.frameSelector ? `${baseLabel} (in Frame)` : baseLabel;

    const framePrefix = context.frameSelector
      ? context.frameSelector.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").slice(0, 12) + "_"
      : "";
    const slugBase = (stableId || baseLabel)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 24) || "component";
    const posHash = `${Math.round(((rect.left + scrollX) / vw) * 100)}_${Math.round(((rect.top + scrollY) / vh) * 100)}`;
    const id = `comp_${framePrefix}${slugBase}_${posHash}`;

    return {
      id,
      isWholePage: false,
      label,
      tagName: el.tagName.toLowerCase(),
      role: (el.getAttribute("role") || "").toLowerCase() || null,
      stableId,
      stableAttributes,
      stableClasses,
      accessibleName,
      headingClue,
      parentSignature: buildParentSignature(el, 4),
      childSignature: buildChildSignature(el),
      geometry: {
        nx: Number(((rect.left + scrollX) / vw).toFixed(3)),
        ny: Number(((rect.top + scrollY) / vh).toFixed(3)),
        nw: Number((rect.width / vw).toFixed(3)),
        nh: Number((rect.height / vh).toFixed(3)),
        widthPx: Math.round(rect.width),
        heightPx: Math.round(rect.height),
        aspectRatio: rect.height > 0 ? Number((rect.width / rect.height).toFixed(2)) : 1
      },
      context: {
        frameSelector: context.frameSelector || null,
        shadowHostPath: context.shadowHostPath || null
      },
      fallbackSelector: buildFallbackSelector(el)
    };
  }

  function scoreCandidateAgainstLocator(el, locator, win = window) {
    if (!el || el.nodeType !== 1 || isExtensionOwnedElement(el)) {
      return { score: -1, matchedSignals: [] };
    }

    const matchedSignals = [];
    let score = 0;

    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase() || null;
    if (locator.tagName && tag === locator.tagName) {
      score += 12;
      matchedSignals.push(`tag:${tag}`);
    } else if (locator.tagName && tag !== locator.tagName) {
      score -= 8;
    }

    if (locator.role && role === locator.role) {
      score += 10;
      matchedSignals.push(`role:${role}`);
    }

    const elStableId = extractStableId(el);
    if (locator.stableId) {
      if (elStableId === locator.stableId) {
        score += 48;
        matchedSignals.push(`id:#${elStableId}`);
      } else {
        score -= 15;
      }
    }

    const savedAttrs = locator.stableAttributes || {};
    const savedAttrKeys = Object.keys(savedAttrs);
    if (savedAttrKeys.length > 0) {
      let attrPoints = 0;
      for (const k of savedAttrKeys) {
        const currentVal = (el.getAttribute(k) || "").trim();
        if (currentVal && currentVal === savedAttrs[k]) {
          attrPoints += (k === "data-testid" || k === "data-component" || k === "aria-label") ? 24 : 12;
          matchedSignals.push(`attr:${k}="${currentVal}"`);
        }
      }
      score += Math.min(36, attrPoints);
    }

    if (locator.headingClue) {
      const currentHeading = truncateText(findNearestHeadingText(el), 60);
      if (currentHeading && currentHeading.toLowerCase() === locator.headingClue.toLowerCase()) {
        score += 22;
        matchedSignals.push(`heading:"${currentHeading}"`);
      } else if (currentHeading && (
        currentHeading.toLowerCase().includes(locator.headingClue.toLowerCase().slice(0, 14)) ||
        locator.headingClue.toLowerCase().includes(currentHeading.toLowerCase().slice(0, 14))
      )) {
        score += 11;
        matchedSignals.push("heading:partial");
      }
    }

    if (locator.accessibleName) {
      const currentAcc = truncateText(el.getAttribute("aria-label") || el.getAttribute("title") || "", 60);
      if (currentAcc && currentAcc.toLowerCase() === locator.accessibleName.toLowerCase()) {
        score += 16;
        matchedSignals.push(`accessibleName:"${currentAcc}"`);
      }
    }

    if (Array.isArray(locator.stableClasses) && locator.stableClasses.length > 0) {
      const currentClasses = new Set(extractStableClasses(el));
      let matchedClsCount = 0;
      for (const cls of locator.stableClasses) {
        if (currentClasses.has(cls)) matchedClsCount++;
      }
      if (matchedClsCount > 0) {
        const ratio = matchedClsCount / locator.stableClasses.length;
        score += Math.round(ratio * 16);
        matchedSignals.push(`classes:${matchedClsCount}/${locator.stableClasses.length}`);
      }
    }

    if (Array.isArray(locator.parentSignature) && locator.parentSignature.length > 0) {
      const currentParents = buildParentSignature(el, locator.parentSignature.length);
      let parentPoints = 0;
      const compareLen = Math.min(locator.parentSignature.length, currentParents.length);
      for (let i = 0; i < compareLen; i++) {
        const expected = locator.parentSignature[i];
        const actual = currentParents[i];
        if (expected.tag === actual.tag) {
          parentPoints += 4;
          if (expected.stableId && expected.stableId === actual.stableId) parentPoints += 6;
          if (expected.sameTagIndex === actual.sameTagIndex) parentPoints += 2;
        }
      }
      if (parentPoints > 0) {
        score += Math.min(24, parentPoints);
        matchedSignals.push(`parentChain:+${Math.min(24, parentPoints)}`);
      }
    }

    if (locator.childSignature && typeof locator.childSignature.childCount === "number") {
      const currChild = buildChildSignature(el);
      if (currChild.landmarkCount === locator.childSignature.landmarkCount && currChild.hasMedia === locator.childSignature.hasMedia) {
        score += 6;
        matchedSignals.push("childStructure");
      }
      const countDiff = Math.abs(currChild.childCount - locator.childSignature.childCount);
      if (countDiff === 0) score += 4;
      else if (countDiff <= 2) score += 2;
    }

    if (locator.geometry && typeof locator.geometry.nw === "number") {
      const effectiveWin = (el.ownerDocument && el.ownerDocument.defaultView) || win || window;
      const vw = Math.max(effectiveWin.innerWidth || 1024, 1);
      const vh = Math.max(effectiveWin.innerHeight || 768, 1);
      const rect = el.getBoundingClientRect();
      if (rect.width >= 32 && rect.height >= 24) {
        const scrollX = effectiveWin.scrollX || effectiveWin.pageXOffset || 0;
        const scrollY = effectiveWin.scrollY || effectiveWin.pageYOffset || 0;
        const nx = (rect.left + scrollX) / vw;
        const ny = (rect.top + scrollY) / vh;
        const nw = rect.width / vw;
        const nh = rect.height / vh;

        const posDist = Math.hypot(nx - locator.geometry.nx, ny - locator.geometry.ny);
        const sizeDist = Math.hypot(nw - locator.geometry.nw, nh - locator.geometry.nh);
        if (posDist < 0.15 && sizeDist < 0.18) {
          score += 14;
          matchedSignals.push("geometry:close");
        } else if (posDist < 0.35 && sizeDist < 0.35) {
          score += 7;
          matchedSignals.push("geometry:moderate");
        }
      }
    }

    return { score, matchedSignals };
  }

  /**
   * Resolve a saved ComponentLocator against the live DOM, including accessible same-origin iframes
   * and open shadow roots.
   */
  function resolveComponentLocator(locator, rootDoc = document, win = window) {
    if (!locator) {
      return { status: "missing", element: null, score: 0, matchedSignals: [], reason: "Empty component locator." };
    }

    if ((locator.isWholePage || locator.id === "root_page" || locator.fallbackSelector === "body") && !locator.context?.frameSelector) {
      return {
        status: "matched",
        element: rootDoc.body || rootDoc.documentElement,
        score: 100,
        runnerUpScore: 0,
        matchedSignals: ["wholePage:body"],
        reason: "Matched entire website backdrop."
      };
    }

    let searchRoot = rootDoc;
    let effectiveWin = win;

    // 1. Resolve same-origin iframe context if specified
    if (locator.context && locator.context.frameSelector) {
      let frameEl = null;
      try {
        frameEl = rootDoc.querySelector(locator.context.frameSelector);
      } catch (_) {}
      if (!frameEl) {
        return {
          status: "missing",
          element: null,
          score: 0,
          matchedSignals: [],
          reason: `Target iframe (${locator.context.frameSelector}) was not found on this page.`
        };
      }
      const frameCheck = inspectIframeAccessibility(frameEl);
      if (!frameCheck.accessible) {
        return {
          status: "unsupported-frame",
          element: null,
          score: 0,
          matchedSignals: [],
          reason: frameCheck.reason
        };
      }
      searchRoot = frameCheck.contentDocument;
      effectiveWin = frameCheck.contentWindow;
      if (locator.fallbackSelector === "body" || locator.tagName === "body") {
        return {
          status: "matched",
          element: searchRoot.body,
          score: 95,
          runnerUpScore: 0,
          matchedSignals: ["frame:same-origin", "tag:body"],
          reason: "Matched same-origin iframe body."
        };
      }
    }

    // 2. Resolve open shadow root context if specified
    if (locator.context && locator.context.shadowHostPath) {
      try {
        const hostEl = searchRoot.querySelector(locator.context.shadowHostPath);
        if (hostEl && hostEl.shadowRoot) {
          searchRoot = hostEl.shadowRoot;
        } else {
          return {
            status: "missing",
            element: null,
            score: 0,
            matchedSignals: [],
            reason: "Open shadow root host was not found on this page."
          };
        }
      } catch (_) {}
    }

    const tagFilter = locator.tagName && /^[a-z0-9-]+$/i.test(locator.tagName) ? locator.tagName : "*";
    let candidates = Array.from(searchRoot.querySelectorAll(tagFilter));
    if (candidates.length === 0 && tagFilter !== "*") {
      candidates = Array.from(searchRoot.querySelectorAll("header, nav, main, article, aside, section, footer, div, form, figure"));
    }

    let fallbackTarget = null;
    if (locator.fallbackSelector && locator.fallbackSelector !== "body") {
      try {
        fallbackTarget = searchRoot.querySelector(locator.fallbackSelector);
        if (fallbackTarget && !candidates.includes(fallbackTarget)) {
          candidates.push(fallbackTarget);
        }
      } catch (_) {}
    }

    const scored = [];
    for (const el of candidates) {
      if (isExtensionOwnedElement(el) || UNSUITABLE_TAGS.has(el.tagName.toUpperCase())) continue;
      const evaluation = scoreCandidateAgainstLocator(el, locator, effectiveWin);
      if (fallbackTarget && el === fallbackTarget) {
        evaluation.score += 8;
        evaluation.matchedSignals.push("fallbackSelector");
      }
      if (evaluation.score > 0) {
        scored.push({
          element: el,
          score: evaluation.score,
          matchedSignals: evaluation.matchedSignals
        });
      }
    }

    if (scored.length === 0) {
      return {
        status: "missing",
        element: null,
        score: 0,
        runnerUpScore: 0,
        matchedSignals: [],
        reason: `Could not locate "${locator.label || "component"}" on the current page.`
      };
    }

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];
    const runnerUp = scored[1] || { score: 0, element: null };
    const margin = best.score - runnerUp.score;

    const MIN_CONFIDENCE_SCORE = 36;
    const hasUniqueIdentityMatch = best.matchedSignals.some((s) => s.startsWith("id:#") || s.startsWith("attr:data-testid="));

    if (best.score < MIN_CONFIDENCE_SCORE) {
      return {
        status: "missing",
        element: null,
        score: best.score,
        runnerUpScore: runnerUp.score,
        matchedSignals: best.matchedSignals,
        reason: `Low matching confidence (score ${best.score} < ${MIN_CONFIDENCE_SCORE}); left page unchanged.`
      };
    }

    if (!hasUniqueIdentityMatch && scored.length > 1 && margin < 10 && best.score < 75) {
      return {
        status: "ambiguous",
        element: null,
        score: best.score,
        runnerUpScore: runnerUp.score,
        matchedSignals: best.matchedSignals,
        reason: `Multiple page areas matched "${locator.label}" with similar structure (top score ${best.score} vs ${runnerUp.score}). Re-select the exact area to disambiguate.`
      };
    }

    return {
      status: "matched",
      element: best.element,
      score: best.score,
      runnerUpScore: runnerUp.score,
      matchedSignals: best.matchedSignals,
      reason: `Matched via ${best.matchedSignals.slice(0, 4).join(", ")}.`
    };
  }

  /**
   * Discover meaningful, deduplicated page components across the top document,
   * open shadow roots, and accessible same-origin iframes.
   */
  function discoverPageComponents(rootDoc = document, win = window, savedComponentsMap = {}) {
    const vw = Math.max(win.innerWidth || 1024, 1);
    const vh = Math.max(win.innerHeight || 768, 1);

    const discovered = [];
    const seenElements = new Set([rootDoc.body, rootDoc.documentElement]);

    const wholePageLocator = createComponentLocator(rootDoc.body, win);
    discovered.push({
      id: "root_page",
      label: "Entire Website",
      category: "Whole Page",
      dimensionsText: `${vw} × ${vh} px`,
      suitability: assessElementSuitability(rootDoc.body, win),
      locator: wholePageLocator,
      rect: { x: 2, y: 2, w: 96, h: 96 },
      matchStatus: "matched",
      element: rootDoc.body
    });

    const selectorPriority = [
      "header, [role='banner'], nav, [role='navigation']",
      "main, [role='main'], article, [role='article']",
      "aside, [role='complementary'], .sidebar, #sidebar",
      "section, [role='region'], .hero, .banner, .product-gallery, .gallery",
      ".card, .panel, .widget, .feature-card, .tile, figure, form",
      "footer, [role='contentinfo']"
    ];

    const rawCandidates = [];
    for (const sel of selectorPriority) {
      const nodes = Array.from(rootDoc.querySelectorAll(sel));
      for (const el of nodes) {
        if (!seenElements.has(el) && !isExtensionOwnedElement(el)) {
          seenElements.add(el);
          rawCandidates.push({ el, shadowHostPath: null, frameSelector: null, frameOffset: null });
        }
      }
    }

    // Inspect open shadow roots
    const potentialShadowHosts = Array.from(rootDoc.querySelectorAll("*"));
    for (const host of potentialShadowHosts) {
      if (host.shadowRoot && !isExtensionOwnedElement(host)) {
        const hostSel = buildFallbackSelector(host);
        const shadowLandmarks = host.shadowRoot.querySelectorAll("header, nav, main, article, aside, section, footer, .card, .panel");
        for (const sEl of Array.from(shadowLandmarks)) {
          rawCandidates.push({ el: sEl, shadowHostPath: hostSel, frameSelector: null, frameOffset: null });
        }
      }
    }

    // Inspect iframes: traverse same-origin frames and report inaccessible cross-origin/sandboxed frames
    const frameNotices = [];
    const iframes = Array.from(rootDoc.querySelectorAll("iframe"));
    for (const frame of iframes) {
      if (isExtensionOwnedElement(frame)) continue;
      const frameRect = frame.getBoundingClientRect();
      if (frameRect.width < 100 || frameRect.height < 60) continue;

      const frameSelector = buildFallbackSelector(frame);
      const access = inspectIframeAccessibility(frame);

      if (!access.accessible) {
        frameNotices.push({
          type: access.status,
          frameSelector,
          src: frame.getAttribute("src") || "embedded-frame",
          reason: access.reason
        });
      } else {
        const subDoc = access.contentDocument;
        const subNodes = subDoc.querySelectorAll("header, nav, main, article, aside, section, footer, .card, .panel");
        for (const subEl of Array.from(subNodes).slice(0, 6)) {
          rawCandidates.push({
            el: subEl,
            shadowHostPath: null,
            frameSelector,
            frameOffset: { left: frameRect.left, top: frameRect.top }
          });
        }
      }
    }

    const acceptedRects = [];
    for (const item of rawCandidates) {
      if (discovered.length >= 20) break;
      const el = item.el;
      const elWin = (el.ownerDocument && el.ownerDocument.defaultView) || win;
      const suitability = assessElementSuitability(el, elWin);
      if (!suitability.suitable) continue;

      const rawRect = el.getBoundingClientRect();
      if (rawRect.width < 100 || rawRect.height < 40) continue;

      const offsetLeft = item.frameOffset ? item.frameOffset.left : 0;
      const offsetTop = item.frameOffset ? item.frameOffset.top : 0;
      const r = {
        left: rawRect.left + offsetLeft,
        top: rawRect.top + offsetTop,
        right: rawRect.right + offsetLeft,
        bottom: rawRect.bottom + offsetTop,
        width: rawRect.width,
        height: rawRect.height
      };

      if (r.bottom < -100 || r.top > vh * 3.5) continue;

      const isDuplicateBox = acceptedRects.some((ar) => {
        const dx = Math.abs(ar.left - r.left);
        const dy = Math.abs(ar.top - r.top);
        const dw = Math.abs(ar.width - r.width);
        const dh = Math.abs(ar.height - r.height);
        return dx < 8 && dy < 8 && dw < 12 && dh < 12;
      });
      if (isDuplicateBox) continue;

      acceptedRects.push(r);
      const locator = createComponentLocator(el, elWin, {
        shadowHostPath: item.shadowHostPath,
        frameSelector: item.frameSelector
      });
      const mapRect = computeNormalizedMapRect(r, vw, vh);

      discovered.push({
        id: locator.id,
        label: locator.label,
        category: item.frameSelector
          ? "Same-Origin Frame Region"
          : item.shadowHostPath
          ? "Shadow DOM Region"
          : classifyCategory(el),
        dimensionsText: `${Math.round(r.width)} × ${Math.round(r.height)} px`,
        suitability,
        locator,
        rect: mapRect,
        matchStatus: "matched",
        element: el
      });
    }

    // Reconcile saved components
    for (const [savedKey, savedComp] of Object.entries(savedComponentsMap || {})) {
      if (!savedComp || !savedComp.locator) continue;
      if (savedKey === "root_page" || savedComp.locator.isWholePage) continue;

      const resolution = resolveComponentLocator(savedComp.locator, rootDoc, win);
      const existingIdx = discovered.findIndex(
        (d) => d.id === savedKey || (resolution.element && d.element === resolution.element)
      );

      if (existingIdx >= 0) {
        discovered[existingIdx].id = savedKey;
        discovered[existingIdx].label = savedComp.friendlyName || discovered[existingIdx].label;
        discovered[existingIdx].locator = savedComp.locator;
        discovered[existingIdx].matchStatus = resolution.status;
        discovered[existingIdx].matchReason = resolution.reason;
      } else {
        const fallbackGeom = savedComp.locator.geometry || { nx: 0.1, ny: 0.2, nw: 0.8, nh: 0.3 };
        discovered.push({
          id: savedKey,
          label: savedComp.friendlyName || savedComp.locator.label || "Saved Component",
          category: resolution.status === "matched" ? "Saved Region" : `Unresolved (${resolution.status})`,
          dimensionsText: resolution.element
            ? `${Math.round(resolution.element.getBoundingClientRect().width)} × ${Math.round(resolution.element.getBoundingClientRect().height)} px`
            : `${fallbackGeom.widthPx || "?"} × ${fallbackGeom.heightPx || "?"} px`,
          suitability: resolution.element
            ? assessElementSuitability(resolution.element, (resolution.element.ownerDocument && resolution.element.ownerDocument.defaultView) || win)
            : { suitable: false, recommendedMode: "none", badgeText: resolution.status.toUpperCase(), reason: resolution.reason },
          locator: savedComp.locator,
          rect: {
            x: Math.max(4, Math.min(86, Math.round((fallbackGeom.nx || 0.1) * 90) + 4)),
            y: Math.max(6, Math.min(84, Math.round((fallbackGeom.ny || 0.2) * 80) + 6)),
            w: Math.max(16, Math.min(92, Math.round((fallbackGeom.nw || 0.7) * 90))),
            h: Math.max(12, Math.min(84, Math.round((fallbackGeom.nh || 0.3) * 70)))
          },
          matchStatus: resolution.status,
          matchReason: resolution.reason,
          element: resolution.element || null
        });
      }
    }

    return { components: discovered, frameNotices };
  }

  function classifyCategory(el) {
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (["header", "nav", "main", "aside", "footer", "article"].includes(tag) ||
        ["banner", "navigation", "main", "complementary", "contentinfo"].includes(role)) {
      return "Landmark";
    }
    return "Content Region";
  }

  function computeNormalizedMapRect(r, vw, vh) {
    const maxScrollSpan = Math.max(vh * 1.4, r.bottom, 1);
    const x = Math.max(4, Math.min(88, Math.round((Math.max(0, r.left) / vw) * 90) + 4));
    const y = Math.max(6, Math.min(84, Math.round((Math.max(0, r.top) / maxScrollSpan) * 82) + 6));
    const w = Math.max(16, Math.min(96 - x, Math.round((Math.min(vw, r.width) / vw) * 90)));
    const h = Math.max(11, Math.min(94 - y, Math.round((Math.min(vh, r.height) / vh) * 68)));
    return { x, y, w, h };
  }

  // =========================================================================
  // SAFE SHADOW-DOM VISUAL POINT-AND-SELECT CONTROLLER (ZERO innerHTML)
  // =========================================================================
  const OVERLAY_STYLESHEET_TEXT = `
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, sans-serif; }
    .highlight-box {
      position: fixed;
      pointer-events: none;
      border: 2px solid #38bdf8;
      background: rgba(14, 165, 233, 0.10);
      border-radius: 6px;
      transition: top 0.05s linear, left 0.05s linear, width 0.05s linear, height 0.05s linear;
      display: none;
    }
    .highlight-box.unsuitable {
      border-color: #f59e0b;
      background: rgba(245, 158, 11, 0.10);
    }
    .highlight-box.locked {
      border: 2.5px solid #10b981;
      background: rgba(16, 185, 129, 0.12);
    }
    .hud-badge {
      position: fixed;
      pointer-events: none;
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 8px;
      padding: 8px 11px;
      box-shadow: 0 10px 25px rgba(2, 6, 23, 0.65);
      display: none;
      flex-direction: column;
      gap: 3px;
      min-width: 210px;
      max-width: 350px;
    }
    .hud-title {
      font-size: 12.5px;
      font-weight: 600;
      color: #f8fafc;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .hud-dims {
      font-size: 11px;
      color: #94a3b8;
      font-variant-numeric: tabular-nums;
    }
    .hud-suitability {
      font-size: 11px;
      font-weight: 500;
      color: #38bdf8;
    }
    .hud-suitability.warn {
      color: #fbbf24;
    }
    .hud-hint {
      font-size: 10px;
      color: #94a3b8;
      margin-top: 2px;
    }
    .confirm-bar {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      pointer-events: auto;
      background: #0f172a;
      color: #f8fafc;
      border: 1px solid rgba(148, 163, 184, 0.35);
      border-radius: 10px;
      padding: 10px 14px;
      box-shadow: 0 16px 36px rgba(2, 6, 23, 0.75);
      display: none;
      align-items: center;
      gap: 10px;
      font-size: 12.5px;
    }
    .confirm-label {
      font-weight: 600;
      color: #e2e8f0;
      margin-right: 4px;
    }
    .btn {
      border: 1px solid rgba(148, 163, 184, 0.3);
      background: #1e293b;
      color: #f8fafc;
      padding: 6px 11px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    .btn:hover { background: #334155; }
    .btn:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }
    .btn-primary {
      background: #0284c7;
      border-color: #38bdf8;
      color: #ffffff;
    }
    .btn-primary:hover { background: #0369a1; }
  `;

  function createVisualSelectionController(options = {}) {
    let isActive = false;
    let isLockedConfirmation = false;
    let currentCandidateEl = null;
    let currentFrameContext = null; // { frameEl, frameSelector }
    let overlayHost = null;
    let shadow = null;
    let highlightBox = null;
    let hudBadge = null;
    let hudNameEl = null;
    let hudDimsEl = null;
    let hudSuitEl = null;
    let hudHintEl = null;
    let confirmBar = null;
    let confirmTextEl = null;
    let btnConfirmSelection = null;
    let rafId = null;
    const boundFrameDocs = [];

    function mountOverlay() {
      if (overlayHost) return;
      overlayHost = document.createElement("div");
      overlayHost.id = "chameleon-selection-overlay-host";
      overlayHost.setAttribute("data-chameleon-owned", "true");
      overlayHost.style.cssText = "all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483645;";
      shadow = overlayHost.attachShadow({ mode: "open" });

      const styleEl = document.createElement("style");
      styleEl.textContent = OVERLAY_STYLESHEET_TEXT;
      shadow.appendChild(styleEl);

      highlightBox = document.createElement("div");
      highlightBox.className = "highlight-box";
      highlightBox.id = "hlBox";
      shadow.appendChild(highlightBox);

      hudBadge = document.createElement("div");
      hudBadge.className = "hud-badge";
      hudBadge.id = "hudBadge";

      const hudTitle = document.createElement("div");
      hudTitle.className = "hud-title";
      hudNameEl = document.createElement("span");
      hudNameEl.id = "hudName";
      hudNameEl.textContent = "Page Area";
      hudDimsEl = document.createElement("span");
      hudDimsEl.className = "hud-dims";
      hudDimsEl.id = "hudDims";
      hudDimsEl.textContent = "0 × 0 px";
      hudTitle.append(hudNameEl, hudDimsEl);

      hudSuitEl = document.createElement("div");
      hudSuitEl.className = "hud-suitability";
      hudSuitEl.id = "hudSuit";
      hudSuitEl.textContent = "Suitable";

      hudHintEl = document.createElement("div");
      hudHintEl.className = "hud-hint";
      hudHintEl.id = "hudHint";
      hudHintEl.textContent = "Hover to highlight • Click to select • Esc to cancel";

      hudBadge.append(hudTitle, hudSuitEl, hudHintEl);
      shadow.appendChild(hudBadge);

      confirmBar = document.createElement("div");
      confirmBar.className = "confirm-bar";
      confirmBar.id = "confirmBar";
      confirmBar.setAttribute("role", "dialog");
      confirmBar.setAttribute("aria-label", "Confirm selected page area");

      confirmTextEl = document.createElement("span");
      confirmTextEl.className = "confirm-label";
      confirmTextEl.id = "confirmText";
      confirmTextEl.textContent = "Selected: Area";

      btnConfirmSelection = document.createElement("button");
      btnConfirmSelection.type = "button";
      btnConfirmSelection.className = "btn btn-primary";
      btnConfirmSelection.id = "btnConfirmSelection";
      btnConfirmSelection.textContent = "Confirm Selection";

      const btnSelectParent = document.createElement("button");
      btnSelectParent.type = "button";
      btnSelectParent.className = "btn";
      btnSelectParent.id = "btnSelectParent";
      btnSelectParent.title = "Select the parent container of this element";
      btnSelectParent.textContent = "Select Parent";

      const btnPickAnother = document.createElement("button");
      btnPickAnother.type = "button";
      btnPickAnother.className = "btn";
      btnPickAnother.id = "btnPickAnother";
      btnPickAnother.textContent = "Change";

      const btnCancelSelection = document.createElement("button");
      btnCancelSelection.type = "button";
      btnCancelSelection.className = "btn";
      btnCancelSelection.id = "btnCancelSelection";
      btnCancelSelection.textContent = "Cancel (Esc)";

      confirmBar.append(confirmTextEl, btnConfirmSelection, btnSelectParent, btnPickAnother, btnCancelSelection);
      shadow.appendChild(confirmBar);

      document.documentElement.appendChild(overlayHost);

      btnConfirmSelection.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!currentCandidateEl) return;
        const elWin = (currentCandidateEl.ownerDocument && currentCandidateEl.ownerDocument.defaultView) || window;
        const locator = createComponentLocator(currentCandidateEl, elWin, {
          frameSelector: currentFrameContext?.frameSelector || null
        });
        const suitability = assessElementSuitability(currentCandidateEl, elWin);
        const targetEl = currentCandidateEl;
        stop();
        if (typeof options.onSelectConfirmed === "function") {
          options.onSelectConfirmed({ element: targetEl, locator, suitability });
        }
      });

      btnSelectParent.addEventListener("click", (e) => {
        e.stopPropagation();
        const doc = (currentCandidateEl && currentCandidateEl.ownerDocument) || document;
        if (currentCandidateEl && currentCandidateEl.parentElement && currentCandidateEl !== doc.body) {
          currentCandidateEl = findMeaningfulTarget(currentCandidateEl.parentElement);
          updateVisualHighlight(currentCandidateEl, currentFrameContext);
          confirmTextEl.textContent = `Selected: ${generateHumanLabel(currentCandidateEl, doc.defaultView || window)}`;
        }
      });

      btnPickAnother.addEventListener("click", (e) => {
        e.stopPropagation();
        isLockedConfirmation = false;
        confirmBar.style.display = "none";
        highlightBox.classList.remove("locked");
      });

      btnCancelSelection.addEventListener("click", (e) => {
        e.stopPropagation();
        stop();
        if (typeof options.onCancel === "function") options.onCancel();
      });
    }

    function findMeaningfulTarget(rawEl) {
      if (!rawEl || rawEl.nodeType !== 1) return null;
      if (rawEl.tagName.toUpperCase() === "IFRAME") return rawEl;
      const doc = rawEl.ownerDocument || document;
      const win = doc.defaultView || window;
      let curr = rawEl;
      while (curr && curr !== doc.body && curr !== doc.documentElement) {
        const suit = assessElementSuitability(curr, win);
        if (suit.suitable) return curr;
        curr = curr.parentElement;
      }
      return rawEl;
    }

    function updateVisualHighlight(el, frameCtx = null) {
      if (!el || !highlightBox || !hudBadge) return;
      const doc = el.ownerDocument || document;
      const win = doc.defaultView || window;
      const rawRect = el.getBoundingClientRect();
      const frameRect = frameCtx && frameCtx.frameEl ? frameCtx.frameEl.getBoundingClientRect() : { left: 0, top: 0 };

      const rect = {
        left: rawRect.left + frameRect.left,
        top: rawRect.top + frameRect.top,
        bottom: rawRect.bottom + frameRect.top,
        width: rawRect.width,
        height: rawRect.height
      };

      const suit = assessElementSuitability(el, win);
      const label = generateHumanLabel(el, win);

      highlightBox.style.display = "block";
      highlightBox.style.left = `${Math.round(rect.left)}px`;
      highlightBox.style.top = `${Math.round(rect.top)}px`;
      highlightBox.style.width = `${Math.round(rect.width)}px`;
      highlightBox.style.height = `${Math.round(rect.height)}px`;
      highlightBox.classList.toggle("unsuitable", !suit.suitable);
      highlightBox.classList.toggle("locked", isLockedConfirmation);

      hudNameEl.textContent = frameCtx ? `${label} (in Frame)` : label;
      hudDimsEl.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)} px`;
      hudSuitEl.textContent = suit.badgeText || (suit.suitable ? "Suitable" : "Not Suitable");
      hudSuitEl.classList.toggle("warn", !suit.suitable);
      if (hudHintEl) {
        hudHintEl.textContent = suit.suitable
          ? "Click to inspect • Select Parent for a larger area • Esc to cancel"
          : "This area is not a good target. Try a parent region or press Esc.";
      }

      hudBadge.style.display = "flex";
      const hudTop = rect.top > 76 ? rect.top - 68 : Math.min(window.innerHeight - 80, rect.bottom + 8);
      const hudLeft = Math.max(8, Math.min(window.innerWidth - 280, rect.left));
      hudBadge.style.top = `${Math.round(hudTop)}px`;
      hudBadge.style.left = `${Math.round(hudLeft)}px`;
    }

    function handleMoveInContext(e, frameCtx = null) {
      if (!isActive || isLockedConfirmation) return;
      const rawTarget = e.target;
      if (!rawTarget || isExtensionOwnedElement(rawTarget)) return;

      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const meaningful = findMeaningfulTarget(rawTarget);
        currentCandidateEl = meaningful;
        currentFrameContext = frameCtx;
        updateVisualHighlight(meaningful, frameCtx);
      });
    }

    function handleClickInContext(e, frameCtx = null) {
      if (!isActive) return;
      if (overlayHost && (e.target === overlayHost || overlayHost.contains(e.target))) return;
      const studioHost = document.getElementById("chameleon-bg-studio-host");
      if (studioHost && (e.target === studioHost || studioHost.contains(e.target))) return;

      if (!currentCandidateEl) {
        currentCandidateEl = findMeaningfulTarget(e.target);
        currentFrameContext = frameCtx;
      }
      if (!currentCandidateEl) {
        e.preventDefault();
        e.stopPropagation();
        if (hudHintEl) hudHintEl.textContent = "No suitable area detected. Hover over a larger section or press Esc to cancel.";
        return;
      }

      const doc = currentCandidateEl.ownerDocument || document;
      const suit = assessElementSuitability(currentCandidateEl, doc.defaultView || window);
      // Picker mode intentionally consumes page clicks to prevent accidental links or
      // navigation, but always explains why a candidate cannot be selected.
      e.preventDefault();
      e.stopPropagation();
      if (!suit.suitable) {
        updateVisualHighlight(currentCandidateEl, currentFrameContext);
        if (hudHintEl) hudHintEl.textContent = `${suit.reason || "This element is unsuitable."} Try Select Parent or move to a larger region. Esc cancels.`;
        return;
      }

      isLockedConfirmation = true;
      updateVisualHighlight(currentCandidateEl, currentFrameContext);
      confirmTextEl.textContent = `Selected: ${generateHumanLabel(currentCandidateEl, doc.defaultView || window)}`;
      confirmBar.style.display = "flex";
      btnConfirmSelection.focus();
    }

    function onTopPointerMove(e) {
      handleMoveInContext(e, null);
    }

    function onTopClickCapture(e) {
      handleClickInContext(e, null);
    }

    function onKeyDownCapture(e) {
      if (!isActive) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        stop();
        if (typeof options.onCancel === "function") options.onCancel();
      }
    }

    let scrollRafId = null;
    function onScrollUpdate() {
      if (!isActive || !currentCandidateEl) return;
      if (scrollRafId) return;
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        if (isActive && currentCandidateEl) {
          updateVisualHighlight(currentCandidateEl, currentFrameContext);
        }
      });
    }

    function start() {
      if (isActive) return true;
      mountOverlay();
      isActive = true;
      isLockedConfirmation = false;
      currentCandidateEl = null;
      currentFrameContext = null;
      if (confirmBar) confirmBar.style.display = "none";

      document.addEventListener("mousemove", onTopPointerMove, true);
      document.addEventListener("click", onTopClickCapture, true);
      document.addEventListener("keydown", onKeyDownCapture, true);
      document.addEventListener("scroll", onScrollUpdate, { capture: true, passive: true });
      window.addEventListener("resize", onScrollUpdate, { passive: true });

      // Show a clear active state immediately; otherwise the user may not know the
      // picker is armed until the next pointer movement.
      if (hudBadge) {
        hudNameEl.textContent = "Select a page area";
        hudDimsEl.textContent = "Picker active";
        hudSuitEl.textContent = "Move pointer over a region";
        hudSuitEl.classList.remove("warn");
        if (hudHintEl) hudHintEl.textContent = "Click to inspect • Select Parent for a larger area • Esc cancels";
        hudBadge.style.display = "flex";
        hudBadge.style.top = "14px";
        hudBadge.style.left = "14px";
        if (highlightBox) highlightBox.style.display = "none";
      }

      // Also attach listeners to accessible same-origin iframes so moving inside them works seamlessly
      const iframes = Array.from(document.querySelectorAll("iframe"));
      for (const frameEl of iframes) {
        const access = inspectIframeAccessibility(frameEl);
        if (access.accessible && access.contentDocument) {
          const frameSelector = buildFallbackSelector(frameEl);
          const ctx = { frameEl, frameSelector };
          const moveFn = (ev) => handleMoveInContext(ev, ctx);
          const clickFn = (ev) => handleClickInContext(ev, ctx);
          access.contentDocument.addEventListener("mousemove", moveFn, true);
          access.contentDocument.addEventListener("click", clickFn, true);
          access.contentDocument.addEventListener("keydown", onKeyDownCapture, true);
          access.contentDocument.addEventListener("scroll", onScrollUpdate, { capture: true, passive: true });
          boundFrameDocs.push({ doc: access.contentDocument, moveFn, clickFn });
        }
      }
      return true;
    }

    function stop() {
      isActive = false;
      isLockedConfirmation = false;
      currentCandidateEl = null;
      currentFrameContext = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (scrollRafId) {
        cancelAnimationFrame(scrollRafId);
        scrollRafId = null;
      }
      document.removeEventListener("mousemove", onTopPointerMove, true);
      document.removeEventListener("click", onTopClickCapture, true);
      document.removeEventListener("keydown", onKeyDownCapture, true);
      document.removeEventListener("scroll", onScrollUpdate, { capture: true });
      window.removeEventListener("resize", onScrollUpdate);

      for (const entry of boundFrameDocs) {
        try {
          entry.doc.removeEventListener("mousemove", entry.moveFn, true);
          entry.doc.removeEventListener("click", entry.clickFn, true);
          entry.doc.removeEventListener("keydown", onKeyDownCapture, true);
          entry.doc.removeEventListener("scroll", onScrollUpdate, { capture: true });
        } catch (_) {}
      }
      boundFrameDocs.length = 0;

      if (overlayHost) {
        overlayHost.remove();
        overlayHost = null;
        shadow = null;
        highlightBox = null;
        hudBadge = null;
        hudNameEl = null;
        hudDimsEl = null;
        hudSuitEl = null;
        hudHintEl = null;
        confirmBar = null;
        confirmTextEl = null;
        btnConfirmSelection = null;
      }
    }

    return {
      start,
      stop,
      isActive: () => isActive,
      getCurrentCandidate: () => currentCandidateEl
    };
  }

  const SelectionEngine = {
    isExtensionOwnedElement,
    inspectIframeAccessibility,
    assessElementSuitability,
    generateHumanLabel,
    createComponentLocator,
    scoreCandidateAgainstLocator,
    resolveComponentLocator,
    discoverPageComponents,
    createVisualSelectionController
  };

  globalScope.ChameleonSelectionEngine = SelectionEngine;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = SelectionEngine;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
