# ChameleonBG — Agent & Developer Guidelines (`AGENTS.md`)

Welcome! Any AI agent or developer working on the **ChameleonBG** Firefox/WebExtension repository (`d:\chameleon-bg-extension`) MUST read and follow these guidelines before making changes.

---

## 1. Project Overview & Architecture

**ChameleonBG** is a privacy-first browser extension that lets users customize websites they visit locally by replacing page or component backgrounds with custom images, animated GIFs, sanitized SVGs, or looping videos (single item or rotating playlist), along with visual adjustments (opacity, brightness, contrast, saturation, Gaussian blur, frosted glass backdrop blur, readability dimmer, and smart text contrast) and reusable Domain Themes.

### Core Files & Responsibilities
- [`manifest.json`](manifest.json): MV3 WebExtension manifest (`background.scripts` for Firefox compatibility, `optional_host_permissions: ["http://*/*", "https://*/*"]`, no unconditional static `content_scripts`).
  - **Constraint**: `"name"` in `manifest.json` MUST remain **at most 45 characters** (enforced by unit test `U8` for Chrome Web Store & Firefox AMO compliance).
- [`storage-service.js`](storage-service.js): Shared storage & media engine:
  - Extension-owned IndexedDB (`ChameleonBG_ExtMediaDB`) for uploaded blobs & metadata.
  - ISOBMFF MP4 binary box parser (`extractMp4TrackDurations`) that inspects `moov`, `mvhd`, `trak`, `tkhd`, `edts`/`elst`, `mdhd`, `hdlr`, `stts`, and `stsz` (with a 6-frame rolling window) to detect audio/video duration mismatches and frozen static tails.
  - Strict positive-allowlist SVG sanitizer (`sanitizeSvgBlob`) and CSS sanitizer (`sanitizeCssStyleText`).
  - Bounded 256 KB chunked media sender/receiver sessions with streaming FNV-1a 32-bit checksums.
  - Conflict-safe per-site configuration storage (`saveSiteConfigConflictSafe`) serialized via a strict async promise-queue mutex (`withStorageMutex`).
  - 4-tier Domain Theme resolution (`resolveEffectiveConfig`: Global Defaults → Domain Theme → Site Profile → Component Override).
- [`access-control.js`](access-control.js): Exact-origin (`protocol://hostname:port`) access evaluation, optional host permission pattern matching (including wildcard coverage like `https://*/*`), and explicit user consent verification.
- [`background.js`](background.js): Extension background coordinator:
  - Dynamic script/CSS registration & injection (`content.css`, `storage-service.js`, `video-manager.js`, `selection-engine.js`, `renderer-engine.js`, `content.js`) only on authorized origins.
  - Sender-bound privilege enforcement (`isExtensionPrivilegedSender`, `isTrustedStudioCommand`).
  - Cross-tab single-audible-owner arbitration (`audibleTabState`).
  - Single-instance Studio tab management (`CHAMELEON_OPEN_FULL_STUDIO`, `CHAMELEON_STUDIO_RETARGET`).
- [`selection-engine.js`](selection-engine.js): Live interactive DOM component picker, suitability classifier (`Mode A` whole-page backdrop, `Mode B` independent child layer, `Mode C` inline background fallback), and multi-signal locator generator/resolver.
- [`renderer-engine.js`](renderer-engine.js): Non-destructive DOM layer mounting (`createBackgroundRenderer`):
  - Records original inline styles (`setRecordedInlineStyle` / `restoreElementInlineStyles`) so resetting an area or disabling a site restores the host webpage cleanly.
  - Seamless video looping (`restartLoopingLayerVideo`) with 3-tier cutoff detection: MP4 binary `videoTrackDuration`, 8×8 canvas pixel-freeze detection (`computeVisualFrameHash`), and user-configurable `videoLoopStartSec` / `videoLoopEndSec`.
  - Preserves video `currentTime` when scrolling off-screen (pauses via `IntersectionObserver` without unloading `video.src`).
- [`video-manager.js`](video-manager.js): Explicit per-component video playback & audio focus state machine (`VideoPlaybackManager`). Never injects floating audio buttons into third-party websites.
- [`content.js`](content.js): Content-script coordinator, chunked media port client, legacy v1 IndexedDB migration (`migrateLegacyPageIndexedDBIfPresent`), SPA navigation observer, and Shadow DOM in-page inspector dock.
- [`studio.html`](studio.html), [`studio.css`](studio.css), [`studio.js`](studio.js): Full 3-panel Visual Customization Studio (`Visual Editor`, `Media Library`, `Websites & Domain Themes`, `Settings & Permissions`), featuring Auto-Save, bounded `← Back` (Undo) and `Forward →` (Redo) history stacks, Frosted Glass & Text Readability controls, and 1-click Reusable Theme creation/application.
- [`popup.html`](popup.html), [`popup.js`](popup.js), [`site-access.html`](site-access.html), [`site-access.js`](site-access.js): Toolbar popup and durable site permission consent flow.

---

## 2. Non-Negotiable Security & Code Hygiene Rules

1. **ZERO `innerHTML` / `outerHTML` / `insertAdjacentHTML`**:
   - Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML` anywhere in extension code (`studio.js`, `content.js`, `popup.js`, `selection-engine.js`, etc.).
   - Always construct DOM elements using `document.createElement`, `textContent`, `append`, and `replaceChildren()`.
2. **Strict Origin & Sender Validation**:
   - Content scripts run inside untrusted third-party web pages. Never trust `message.siteKey` from a content script when returning sensitive data (`CHAMELEON_GET_OVERVIEW` must bind to `sender.url` and redact `mediaItems`/`storageStats` for content-script callers).
   - Privileged commands (`CHAMELEON_LIST_SITES`, `CHAMELEON_DELETE_SITE_CONFIG`, `CHAMELEON_CLEAR_ALL_DATA`, `CHAMELEON_IMPORT_BACKUP`, `CHAMELEON_CHECK_TAB_CAPABILITY`) must be restricted to trusted extension pages (`isExtensionPrivilegedSender` / `isTrustedStudioCommand`).
   - Synchronous user-gesture requirements: `permissions.request()` in `popup.js` and `site-access.js` MUST be called synchronously inside the click handler before any `await` (enforced by unit tests `U14` and `U18`).
3. **Never Touch User Profile Directories Outside the Workspace**:
   - Do NOT run shell/PowerShell commands that scan or modify the user's personal `%APPDATA%\Mozilla\Firefox\Profiles` directory. Keep all work and testing strictly within `d:\chameleon-bg-extension` (or an isolated temporary profile if launching automated browser tests).
4. **Preserve Host Webpage DOM Integrity**:
   - All extension-injected nodes on host pages MUST carry `data-chameleon-owned="true"`.
   - Any inline style modified on a host element MUST go through `setRecordedInlineStyle(el, prop, val, priority, compId)` so `restoreElementInlineStyles` can revert it without clobbering host-page mutations.

---

## 3. UI & Layout Guidelines (`studio.html` / `studio.css`)

- **Single-Row Topbar (`.studio-topbar`)**:
  - `.studio-topbar` must remain a clean single horizontal bar (`flex-wrap: nowrap` on desktop viewports `>1020px`, `justify-content: space-between`) with `.topbar-left` on the left and `.topbar-right` pinned to the far right (`margin-left: auto`).
  - Keep `#targetSiteSubtitle` and `#siteSwitcher` side-by-side inside `.brand-meta-row` so revealing `#siteSwitcher` never pushes the topbar height down or causes `.topbar-right` to wrap onto a second line.
  - When `studioAutoSaveEnabled` is active and there are no unsaved edits, `#btnStudioDiscard` and `#btnStudioSave` automatically hide (`hidden = true`) so the topbar stays compact while remaining in the DOM for manual-save mode and unit tests.
- **Exclusive View Visibility**:
  - `[hidden] { display: none !important; }` must always be respected across `#viewEditor`, `#viewLibrary`, `#viewWebsites`, and `#viewSettings`.

---

## 4. Testing & Git Workflow

1. **Always Run the Unit Test Suite Before Finishing**:
   ```powershell
   node tests/unit_tests.js
   ```
   - All **33/33** tests in [`tests/unit_tests.js`](tests/unit_tests.js) (`U1` through `U33`) MUST pass with `0` failures.
   - Several unit tests (`U8`–`U18`, `U32`, `U33`) assert specific DOM IDs and function signatures across `studio.html`, `studio.js`, `popup.js`, `background.js`, and `renderer-engine.js`. Do not rename or remove tested IDs (`#btnStudioUndo`, `#btnStudioRedo`, `#chkStudioAutoSave`, `#btnStudioDiscard`, `#btnStudioSave`, `#sliderVideoVolume`, `#inputVideoLoopStartSec`, `#inputVideoLoopEndSec`, `#sliderBackdropBlur`, `#selectTextContrastMode`, `#btnSaveSiteAsTheme`, etc.).
2. **Use the Local Git Repository Properly**:
   - Do not leave large piles of uncommitted changes in the working tree.
   - After verifying your changes with `node tests/unit_tests.js`, stage the modified extension files (`git add ...`) and create a clear, descriptive commit (`git commit -m "..."`) on the local repository.
   - Do not commit temporary scratch files or `.agents/` working directories unless explicitly requested by the user.
