# ChameleonBG v2.3.0 — Custom Website Backgrounds (Chrome, Edge & Firefox)

ChameleonBG lets users select regions of websites and apply custom image/video backgrounds, visual shaders/effects, and rotating playlists. Engineered for cross-browser Manifest V3 compatibility (Mozilla Firefox, Google Chrome, and Microsoft Edge). It does not statically inject into every HTTP/HTTPS page.

---

## 1. What's New in v2.2.0

* **Explicit Audio and Playback State Machine (`video-manager.js`, `renderer-engine.js`)**:
  - Distinguishes user-selected mute preference, playback preference, actual playback, paused status (user, global, or document hidden), and browser autoplay policy blocks.
  - Deterministic audio focus arbitration with monotonic counter (`audioRequestSequence`) ensuring at most one audible video per tab.
  - Standard-compliant handling of Firefox autoplay policy: when audible playback is rejected with `NotAllowedError`, the user's audio preference is retained, playback safely continues muted with status `audio-blocked`, and an extension-owned `#chameleon-inpage-audio-prompt` is mounted directly on the website DOM. Clicking the prompt triggers native user-gesture playback and unmutes the video.
  - Quick video controls (Play/Pause, Mute/Unmute, dynamic status badge) beside the assigned-media summary in the structured component map.

* **Domain Themes & Subdomain Inheritance (`storage-service.js`, `background.js`, `studio.js`, `content.js`)**:
  - Registrable domain derivation (`deriveRegistrableDomain`) supporting multi-part public suffixes (`.co.uk`, `.com.au`, `.co.jp`, etc.), IPv4/IPv6, and localhost.
  - 4-tier precedence engine (`resolveEffectiveConfig`): `Global Settings -> Domain Theme -> Site Profile -> Component Override`.
  - Subdomains automatically inherit their parent domain's default theme, playback parameters, and background assets while preserving exact-origin host permission boundaries and requiring document-level gestures for audible sound.

* **Websites & Themes Dashboard (`studio.html`, `studio.css`, `studio.js`)**:
  - Expanded Websites view in Studio featuring a Domain Themes card grid and Saved Websites list.
  - Domain Theme modal for creating and editing domain-wide themes (name, default mute, default volume, default playback behavior, default background media).
  - Inline theme assignment dropdown per saved website row to bind a site profile to any configured domain theme.
  - Safe deletion: Deleting a site configuration removes only `siteCfg::<origin>`, leaving media files, consent markers, and domain themes intact. Deleting a domain theme removes only `domainTheme::<id>`, gracefully reverting associated sites to global defaults without deleting site customizations.

* **Complete User-Controlled Data Lifecycle (`storage-service.js`, `studio.html`, `studio.js`)**:
  - **Backup Export:** Supports both "Settings Only" and "Full Backup (Settings + Embedded Media)" formats conforming to versioned schema `chameleon-backup-v2` (`schemaVersion: 2`).
  - **Backup Import:** Preflight schema validation checking version, payload integrity, and structural validity before writing to storage. Supports non-destructive "Merge" (combines configurations and retains existing assets) and "Replace" (cleans previous site and domain configs before applying backup).
  - **Clear All Data:** Double-confirmed dangerous action in Settings -> Privacy & Data with explicit prompt and confirmation checkbox to purge all site profiles, domain themes, media blobs, and cached metadata.
  - **Media Usage Tracking:** Extension-wide usage analysis tagging media cards in the Media Library with visual pill badges ("In Use", "Unassigned") and listing referencing sites and domain themes.
  - **Re-entrant Mutex:** Enhanced `withStorageLock` with recursive depth tracking to eliminate composite lock deadlocks during backup imports.

* **Security Hardening (`storage-service.js`, `content.js`)**:
  - **Strict Positive Element Allowlist in SVG Sanitization:** `ALLOWED_SVG_TAGS` strictly allows only standard vector graphics tags (`svg`, `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `defs`, `lineargradient`, `radialgradient`, `stop`, `clippath`, `pattern`, `style`, `text`, `tspan`), stripping all unknown, hostile, or executable elements (`<applet>`, `<embed>`, `<foreignObject>`, `<iframe>`, `<object>`, `<script>`, etc.).
  - **Verified Legacy IndexedDB Deletion:** `migrateLegacyPageIndexedDBIfPresent` verifies that all page-origin IndexedDB records successfully migrated to extension storage before invoking `indexedDB.deleteDatabase()`, retaining original data on any partial failure or aborted transfer.

---

## 2. Install in Firefox (Temporary Add-on)

1. Extract the extension ZIP or clone the repository.
2. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select `manifest.json` inside the extension directory.
4. Navigate to any ordinary HTTP or HTTPS website and click the ChameleonBG toolbar icon.
5. Click **I understand — allow access** to grant optional host permissions for that origin.
6. Use **Open Visual Editor** to customize regions, assign media, and configure domain themes.

> **Note:** Temporary add-ons are removed when Firefox restarts. Load `manifest.json` again or use `web-ext run` during development.

---

## 3. Architecture & File Structure

* `manifest.json`: Firefox Manifest V3 declaration with `background.scripts`, optional HTTP/HTTPS host permissions, and extension gecko ID.
* `video-manager.js`: Standalone multi-variable audio & video state machine, deterministic audio focus arbitration, and in-page user gesture prompt injection.
* `access-control.js`: Pure policy helpers for origin normalization, consent tracking, and permissions verification.
* `background.js`: Firefox background event coordinator for dynamic script injection, permission lifecycles, pending enable intents, and studio messaging.
* `storage-service.js`: Extension-origin IndexedDB media storage, registrable domain derivation, 4-tier configuration precedence engine, backup import/export, data purging, and strict SVG element allowlisting.
* `renderer-engine.js`: Multi-layer background renderer, style restoration, and integration with `ChameleonVideoManager`.
* `selection-engine.js`: Shadow-DOM live element picker, breadcrumb navigation, and robust component locator matching.
* `content.js`: Injected page agent handling runtime lifecycle, CSS application, and verified legacy IndexedDB migration.
* `studio.html` / `studio.css` / `studio.js`: Full-screen 4-workspace visual studio (Visual Editor, Media Library, Websites & Themes Dashboard, Settings).
* `popup.html` / `popup.js`: Compact single-click permission launcher with retargeting and site enablement controls.

---

## 4. Automated & Manual Verification

### Automated Unit Test Suite (Tier 1)
Run Node.js unit tests from the project root:
```bash
node tests/unit_tests.js
```
or via the Python test runner:
```bash
python tests/run_all_tests.py --tier 1
```

All 33 unit tests pass (`33/33 PASS`):
* **U1–U7**: Origin isolation, animated GIF detection, deep SVG/CSS sanitization, bounded chunked media transport, conflict-safe storage, v2.0 config migration, origin migration markers.
* **U8–U13**: Permission gate & consent, studio view isolation, live picker routing, popup-to-studio handoff, structured map & sticky settings, media selection & video rotation.
* **U14–U18**: Trusted capability check, websites listing/safe deletion, single-instance studio reuse, pending enable intents, synchronous user gesture consent.
* **U19–U24**: Registrable domain derivation (eTLD+1), 4-tier domain theme precedence, VideoManager audio focus & in-page prompt, backup schema v2 export/import, strict SVG allowlist, and verified legacy IndexedDB migration deletion.
* **U25–U33**: Sender origin enforcement, re-entrancy safe storage mutex, unsafe URI scheme rejection, Firefox fallback IndexedDB detection, audio focus yielding, subdomain domain theme resolution, wildcard permission coverage, seamless MP4 video track looping, topbar layout & auto-save history stack.

### Browser Testing & Manual Checklist
* The test runner (`tests/run_all_tests.py`) runs Tier 1 and transparently reports browser tiers as **BLOCKED** if Selenium is not installed in the Python environment.
* Manual verification checklist:
  1. Load temporary add-on via `about:debugging`.
  2. Confirm single-click consent prompt preserves user gesture and grants host permission.
  3. Verify area selection on a live website with the non-flashing background Studio tab.
  4. Test background video playback: verify video starts muted, unmuting works, and browser autoplay blocks show `#chameleon-inpage-audio-prompt` to enable audio cleanly.
  5. Test Domain Themes: create a theme in the Websites & Themes dashboard and assign it to a site; verify subdomain inheritance.
  6. Test Backup & Restore: export Settings and Full backup, import via Merge and Replace modes, and verify clear all data workflow.
