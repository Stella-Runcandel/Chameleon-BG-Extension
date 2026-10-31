# ChameleonBG Firefox build — automated tests

Run commands from the extracted `chameleon-bg-extension` folder.

## Tier 1 — Node.js unit and source-regression tests

Requires Node.js:

```bash
node tests/unit_tests.js
```

This suite tests pure logic plus static source guards for the Firefox manifest, site-permission policy, studio view isolation, live-picker event routing, popup-to-studio picker handoff, component map label styling, migration and media transport.

## Browser integration and end-to-end tests

The archive is a Firefox-specific Manifest V3 build and uses `background.scripts`. The Chromium extension loader cannot faithfully load this Firefox manifest as an installed extension. Browser integration fixtures can run in Chromium, but they do not substitute for testing the extension inside Firefox.

The full runner requires Python 3, Selenium, a compatible browser driver, and an environment that permits local browser tests:

```bash
python3 -m pip install selenium
python3 tests/run_all_tests.py
```

The runner executes Tier 1 first. It explicitly reports browser tiers as **BLOCKED** if Selenium is unavailable. Firefox-specific end-to-end checks still need to be run in a Firefox-capable automation environment or manually in desktop Firefox.

## Firefox manual verification checklist

1. Load `manifest.json` temporarily via `about:debugging#/runtime/this-firefox`.
2. Confirm the toolbar popup opens without a background-script error.
3. Grant access to a test origin using the site-specific consent flow.
4. Open the Studio, switch between Visual Editor, Media Library and Settings, and confirm only one view appears at a time.
5. Click **Select on Live Website**. Confirm the live-page HUD appears before hovering, select a suitable component, confirm it, and verify the Studio returns with that component selected.
6. Verify cancellation with Escape and verify that unsuitable targets provide guidance.
7. Revoke site permission and verify the agent is deactivated without deleting saved media or settings.
8. Test file picker and desktop file-manager drag-and-drop.
9. Let the extension sit idle for several minutes and verify playlist alarm behavior in the hardened profile.
10. Test representative production pages only where their policies permit visual modification.

## Scope and known limitations

This Firefox build is not intended to be loaded into Chrome as-is. Protected browser pages, inaccessible cross-origin or sandboxed frames, and closed shadow roots remain browser-security limitations. Never report browser-level tests as passed unless they were actually executed against the packaged extension.


### v2.0.8 Media Picker, Rotation & Video Controls

The media chooser stages selections until **OK** is clicked; **Cancel** discards the pending selection. Assignment modes are **Set one background** and **Create/replace playlist**. New video assignments default to muted. Custom H:M:S rotation and wait-until-video-end behavior are covered by Test 26. The Visual Editor includes a global Pause/Resume videos control, while a selected component with video media exposes pause/resume and mute controls in the structured map, with volume in the inspector. The renderer permits only one eligible ChameleonBG video per tab to be audible at a time and respects browser autoplay restrictions.


The v2.0.8 integration suite adds Test 26 for video-end playlist rotation: once an interval is due, a running video is allowed to finish and later scheduler ticks must not restart the interval.

### v2.0.9 Firefox picker and permission repair

- U14 exercises the actual background message listener in a Node VM with mocked browser APIs: trusted `studio.html` capability checks must succeed while page-origin attempts are rejected.
- Static guards verify that Firefox site permission requests are invoked directly from the consent button gesture, that `permissions.onAdded` and manual grant-status recovery exist, and that request/message timeouts prevent a stuck spinner.
- `tests/run_all_tests.py` is Firefox-build-aware: its Chromium extension-install tier is skipped for the Firefox-only `background.scripts` package. A Selenium-based run reports missing dependencies as **BLOCKED**, not passed.
- The current environment does not have Selenium or Firefox installed and its managed Chromium blocks local/file URLs. Therefore the permission prompt and live picker still require desktop Firefox verification.

### v2.1.0 Streamlined Site Access, Websites Dashboard, Multi-Site Editor & Single-Instance Studio

- **U15**: Tests `CHAMELEON_LIST_SITES` and `CHAMELEON_DELETE_SITE_CONFIG` in a mocked VM environment. Confirms that only sites with customized components are listed, only `siteCfg::*` is removed on deletion, and media records (`mediaSentinel`), consent, and host permissions remain intact. Confirms content scripts are rejected.
- **U16**: Tests single-instance Studio reuse via `CHAMELEON_OPEN_FULL_STUDIO`. Verifies existing Studio tabs are retargeted via message without creating duplicate tabs, and that picker triggers keep the website tab in the foreground by creating or keeping the Studio tab inactive (`active: false`).
- **U17**: Tests resilient permission onboarding with pending intents (`pendingEnable::*`). Verifies `permissions.onAdded` automatically activates the site from the intent once browser permission is granted, and cleans up expired or ungranted intents.
- **U18**: Static checks verifying synchronous user-gesture permission request in popup (`permissions.request` with no preceding `await`), single-click consent UI, Websites dashboard navigation, and in-place studio retargeting.

### v2.2.0 Audio Reliability, Domain Themes, Security Hardening & Data Management

- **U19**: Tests `deriveRegistrableDomain` across standard domains, multi-part public suffixes (`.co.uk`, `.com.au`, `.co.jp`), protocols, ports, and raw IP addresses / localhost.
- **U20**: Tests 4-tier precedence resolution (`Global defaults -> Domain Theme -> Site Profile -> Component Override`) ensuring default volume, mute state, playback settings, and background assets cascade appropriately.
- **U21**: Tests `ChameleonVideoManager` explicit multi-variable state machine, deterministic audio focus arbitration with monotonic counter (maximum 1 audible video per tab), `NotAllowedError` handling, and in-page `#chameleon-inpage-audio-prompt` native user-gesture activation.
- **U22**: Tests data lifecycle helpers: Settings vs Full JSON backup export (`schemaVersion: 2`), preflight schema validation, and merge vs replace import semantics with re-entrant storage mutex.
- **U23**: Tests security hardening: strict SVG positive element allowlist (`ALLOWED_SVG_TAGS`) stripping hostile, unknown, or active tags (`<applet>`, `<embed>`, `<foreignObject>`, `<iframe>`, `<object>`, `<script>`, etc.) while preserving valid SVG vector graphics.
- **U24**: Tests verified legacy page IndexedDB deletion: verifies that `deleteDatabase()` executes if and only if all records are 100% verified as migrated to extension storage, preserving the database on any failure.

