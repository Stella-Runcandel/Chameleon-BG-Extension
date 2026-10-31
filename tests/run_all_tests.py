#!/usr/bin/env python3
"""
ChameleonBG v2.2.0 Firefox Audio Reliability, Domain Themes, Security Hardening & Data Management — Reproducible Automated Test Suite Runner (`tests/run_all_tests.py`)

Usage (from the extension root directory):
  python3 tests/run_all_tests.py
  python3 tests/run_all_tests.py --tier 1


Executes and reports three distinct automated test tiers:
1. Tier 1 — Unit Tests (`node tests/unit_tests.js`)
2. Tier 2 — Browser Integration & Hardening Regression Suite (`tests/test_runner.html` in Chromium, 26 tests)
3. Tier 3 — Browser End-to-End Extension & UI Verification (`--load-extension` unpacked extension load,
   extension-origin popup/studio pages, hostile XSS input rendering, and permission-gate behavior on synthetic sites)
"""

import functools
import http.server
import json
import pathlib
import subprocess
import sys
import threading
import time
from urllib.parse import quote
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import WebDriverWait
    SELENIUM_IMPORT_ERROR = None
except ImportError as exc:
    webdriver = None
    Options = None
    By = None
    Keys = None
    WebDriverWait = None
    SELENIUM_IMPORT_ERROR = str(exc)

TESTS_DIR = pathlib.Path(__file__).resolve().parent
EXT_DIR = TESTS_DIR.parent
MANIFEST = json.loads((EXT_DIR / "manifest.json").read_text(encoding="utf-8"))
BACKGROUND_CONFIG = MANIFEST.get("background", {})
IS_FIREFOX_BUILD = bool(BACKGROUND_CONFIG.get("scripts")) and not bool(BACKGROUND_CONFIG.get("service_worker"))

class QuietHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

def start_local_server(directory, host="127.0.0.2"):
    handler = functools.partial(QuietHTTPRequestHandler, directory=str(directory))
    server = http.server.ThreadingHTTPServer((host, 0), handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, port

def discover_extension_id(driver, timeout_seconds=10):
    """Find the loaded MV3 extension ID from its actual Chromium target URL."""
    deadline = time.time() + timeout_seconds
    last_error = None
    while time.time() < deadline:
        try:
            targets = driver.execute_cdp_cmd("Target.getTargets", {}).get("targetInfos", [])
            for target in targets:
                url = target.get("url", "")
                if target.get("type") == "service_worker" and url.startswith("chrome-extension://") and url.endswith("/background.js"):
                    return url.split("/", 3)[2]
            # An extension page can also prove the loaded extension origin if the worker is idle.
            for target in targets:
                url = target.get("url", "")
                if target.get("type") == "page" and url.startswith("chrome-extension://"):
                    return url.split("/", 3)[2]
        except Exception as exc:
            last_error = exc
        time.sleep(0.1)
    detail = f" Last CDP error: {last_error}" if last_error else ""
    raise RuntimeError("Could not discover the loaded ChameleonBG extension ID from Chromium targets." + detail)


def run_tier1_unit_tests():
    proc = subprocess.run(
        ["node", str(TESTS_DIR / "unit_tests.js")],
        cwd=str(EXT_DIR),
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)

def run_tier2_and_tier3_browser_tests():
    server_a, port_a = start_local_server(EXT_DIR, "127.0.0.2")
    server_b, port_b = start_local_server(EXT_DIR, "127.0.0.3")
    origin_a = f"http://127.0.0.2:{port_a}"
    origin_b = f"http://127.0.0.3:{port_b}"

    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1440,900")
    # The Firefox-specific package deliberately omits `background.service_worker`;
    # Chromium's --load-extension runner cannot load that Firefox-only MV3 manifest.
    # Tier 2 remains useful because it tests the standalone browser integration fixture.
    if not IS_FIREFOX_BUILD:
        opts.add_argument(f"--disable-extensions-except={EXT_DIR}")
        opts.add_argument(f"--load-extension={EXT_DIR}")

    driver = webdriver.Chrome(options=opts)
    driver.set_script_timeout(30)
    driver.set_window_size(1440, 900)
    driver.get(f"{origin_a}/tests/test_runner.html")
    tier2_report = None
    extension_id = None
    extension_origin = None

    e2e_results = []

    def record_e2e(test_id, name, fn):
        t0 = time.time()
        try:
            detail = fn()
            e2e_results.append({
                "id": test_id,
                "name": name,
                "status": "PASS",
                "durationMs": round((time.time() - t0) * 1000, 1),
                "detail": detail or "Verified"
            })
        except Exception as exc:
            e2e_results.append({
                "id": test_id,
                "name": name,
                "status": "FAIL",
                "durationMs": round((time.time() - t0) * 1000, 1),
                "error": str(exc)
            })

    try:
        # Tier 2: Execute the 26-scenario Browser Integration, Hardening & Video Controls Suite
        driver.get(f"{origin_a}/tests/test_runner.html")
        time.sleep(0.35)
        tier2_report = driver.execute_async_script("""
          const done = arguments[arguments.length - 1];
          window.runAllAcceptanceTests().then(done).catch((err) => done({ error: err.message }));
        """)

        if tier2_report.get("error") or tier2_report.get("failedCount", 1) > 0:
            raise AssertionError(f"Tier 2 integration suite failed: {tier2_report}")

        if IS_FIREFOX_BUILD:
            return tier2_report, {
                "suite": "Tier 3 — Browser End-to-End Extension & UI Verification",
                "status": "SKIPPED",
                "totalTests": 0,
                "passedCount": 0,
                "failedCount": 0,
                "reason": "This archive is Firefox-specific (background.scripts without background.service_worker). Chromium --load-extension cannot verify the Firefox package; use the documented Firefox about:debugging manual checklist or a Firefox-specific automation runner."
            }

        # Tier 3 — E2E 1: Verify the real extension does not inject without per-site consent + host permission.
        # In particular, a saved config and even a stale consent record must not bypass a missing host grant.
        def e2e_permission_gate():
            host_handle = driver.current_window_handle
            driver.switch_to.new_window("tab")
            extension_handle = driver.current_window_handle
            driver.get(f"{extension_origin}/studio.html?siteKey={quote(origin_a, safe='')}")
            setup = driver.execute_async_script("""
              const done = arguments[arguments.length - 1];
              const origin = arguments[0];
              (async () => {
                const manifest = chrome.runtime.getManifest();
                const url = new URL(origin);
                const pattern = `${url.protocol}//${url.hostname}/*`;
                // Ensure this isolated test profile starts without the optional host grant.
                await chrome.permissions.remove({ origins: [pattern] });
                const permissionGranted = await chrome.permissions.contains({ origins: [pattern] });
                const configKey = `siteCfg::${origin}`;
                const accessKey = `siteAccess::${encodeURIComponent(origin.toLowerCase())}`;
                const testConfig = {
                  siteKey: origin, hostname: url.hostname, matchScope: 'origin', enabled: true,
                  revision: 1, components: {
                    root_page: { id: 'root_page', friendlyName: 'Should Not Inject', enabled: true,
                      locator: { id: 'root_page', isWholePage: true, tagName: 'body' },
                      playlist: ['preset_aurora_webp'], activeMediaId: 'preset_aurora_webp' }
                  }
                };
                const testAccess = { origin, hostname: url.hostname, enabled: true, consentVersion: 1,
                  consentAcceptedAt: Date.now(), updatedAt: Date.now() };
                await chrome.storage.local.set({ [configKey]: testConfig, [accessKey]: testAccess });
                done({ permissionGranted, hasStaticContentScripts: Array.isArray(manifest.content_scripts) && manifest.content_scripts.length > 0,
                  hasRequiredAllUrls: Array.isArray(manifest.host_permissions) && manifest.host_permissions.includes('<all_urls>'),
                  optionalHosts: manifest.optional_host_permissions || [] });
              })().catch((err) => done({ error: String(err && err.stack || err) }));
            """, origin_a)
            assert not setup.get("error"), setup.get("error")
            assert setup["permissionGranted"] is False, "Test profile should not have the optional host grant"
            assert setup["hasStaticContentScripts"] is False, "Manifest must not register unconditional content scripts"
            assert setup["hasRequiredAllUrls"] is False, "Manifest must not require all-sites host permission"
            assert "http://*/*" in setup["optionalHosts"] and "https://*/*" in setup["optionalHosts"]

            driver.switch_to.window(host_handle)
            driver.get(f"{origin_a}/tests/fixtures/extension_smoke.html")
            time.sleep(0.5)
            state = driver.execute_script("""
              return {
                agentLoaded: Boolean(window.__CHAMELEON_BG_V2_LOADED__),
                ownedLayers: document.querySelectorAll('[data-chameleon-owned="true"]').length,
                injectedDock: Boolean(document.querySelector('#chameleon-bg-studio-host, #chameleon-studio-dock-host'))
              };
            """)
            assert state["agentLoaded"] is False, f"Page agent must not be injected without host permission: {state}"
            assert state["ownedLayers"] == 0, f"No background layers may appear without authorization: {state}"
            assert state["injectedDock"] is False, f"No injected UI should appear without authorization: {state}"

            # Confirm that the media library itself remains extension-owned and reusable,
            # independent of whether this test page has been granted host access.
            driver.switch_to.window(extension_handle)
            media = driver.execute_async_script("""
              const done = arguments[arguments.length - 1];
              (async () => {
                const c = document.createElement('canvas'); c.width = 8; c.height = 8;
                const ctx = c.getContext('2d'); ctx.fillStyle = '#8b5cf6'; ctx.fillRect(0, 0, 8, 8);
                const blob = await new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(new Error('PNG encode failed')), 'image/png'));
                const id = 'phase1-permission-gate-' + Date.now();
                await ChameleonStorageService.importMediaItem(blob, { id, name: 'Phase 1 permission gate.png', mimeType: 'image/png', convertToWebP: false, preserveOriginal: false, skipMetadataProbe: true });
                const loaded = await ChameleonStorageService.getMediaRecordWithBlob(id);
                done({ id, size: loaded && loaded.size, blobType: loaded && loaded.blob && loaded.blob.type });
              })().catch(err => done({ error: String(err && err.stack || err) }));
            """)
            assert not media.get("error"), media.get("error")
            assert media.get("size", 0) > 0 and media.get("blobType") == "image/png"
            return (f"Unpacked extension {extension_id} denied page injection and rendered no layers on {origin_a} "
                    f"without host permission, even with a seeded config/consent record; extension-origin media "
                    f"storage remains usable ({media['size']} bytes).")

        record_e2e("E2E-1", "Actual unpacked-extension permission gate and extension-owned media storage", e2e_permission_gate)

        # Tier 3 — E2E 2: Verify Compact Popup UI (`popup.html`)
        def e2e_popup_ui():
            driver.set_window_size(400, 600)
            driver.get(f"{extension_origin}/popup.html")
            time.sleep(0.25)
            open_btn = driver.find_element(By.ID, "btnOpenVisualEditor")
            pick_btn = driver.find_element(By.ID, "btnSelectOnPage")
            lib_btn = driver.find_element(By.ID, "btnOpenMediaLibrary")
            assert open_btn.is_displayed() and pick_btn.is_displayed() and lib_btn.is_displayed()
            return "Compact popup controls (Open Visual Editor, Select Area, Media Library) verified"

        record_e2e("E2E-2", "Actual extension-origin popup document UI (not native toolbar bubble geometry)", e2e_popup_ui)

        # Tier 3 — E2E 3: Verify 3-Panel Studio UI, Keyboard Navigation, Undo & Save/Discard
        def e2e_studio_workflow():
            driver.set_window_size(1440, 900)
            driver.get(f"{extension_origin}/studio.html?siteKey={quote(origin_a, safe='')}")
            time.sleep(0.35)

            left_panel = driver.find_element(By.CSS_SELECTOR, ".panel-left")
            center_panel = driver.find_element(By.CSS_SELECTOR, ".panel-center")
            right_panel = driver.find_element(By.CSS_SELECTOR, ".panel-right")
            assert left_panel.is_displayed() and center_panel.is_displayed() and right_panel.is_displayed()

            map_regions = driver.find_elements(By.CSS_SELECTOR, ".map-tree-row")
            assert len(map_regions) >= 4, "Structured component tree should contain the page root and detected regions"
            map_regions[1].send_keys(Keys.ENTER)
            time.sleep(0.1)
            area_name = driver.find_element(By.ID, "inspectorAreaName").text
            assert area_name == "Top Navigation", f"Expected 'Top Navigation', got '{area_name}'"

            # Open the staged multi-select picker, verify repeat-click deselection, explicit OK, Undo, and Cancel.
            driver.find_element(By.ID, "btnOpenEditorMediaPicker").click()
            WebDriverWait(driver, 5).until(lambda d: d.find_element(By.ID, "editorMediaPickerDialog").get_attribute("open") is not None)
            mode_select = driver.find_element(By.ID, "pickerAssignmentMode")
            mode_select.select_by_value("playlist")
            select_btns = WebDriverWait(driver, 5).until(lambda d: d.find_elements(By.CSS_SELECTOR, "#studioMediaGrid .btn-picker-select"))
            assert len(select_btns) >= 2, "Picker should render selectable media cards and built-in presets"
            select_btns[0].click()
            select_btns[1].click()
            assert "picker-selected" in driver.find_elements(By.CSS_SELECTOR, "#studioMediaGrid .media-item-card")[0].get_attribute("class")
            assert driver.find_element(By.ID, "pickerSelectionCount").text == "2 selected"
            # Clicking an already-selected card again must deselect it without applying changes.
            driver.find_elements(By.CSS_SELECTOR, "#studioMediaGrid .btn-picker-select")[0].click()
            assert driver.find_element(By.ID, "pickerSelectionCount").text == "1 selected"
            assert driver.find_element(By.ID, "btnConfirmEditorMediaPicker").get_attribute("disabled") is None, "One selected playlist item is a valid pending choice"
            driver.find_elements(By.CSS_SELECTOR, "#studioMediaGrid .btn-picker-select")[0].click()
            assert driver.find_element(By.ID, "pickerSelectionCount").text == "2 selected"
            driver.find_element(By.ID, "btnConfirmEditorMediaPicker").click()
            time.sleep(0.1)
            assert driver.find_element(By.ID, "draftStatusLabel").text == "Unsaved Preview"

            undo_btn = driver.find_element(By.ID, "btnStudioUndo")
            assert undo_btn.is_enabled()
            undo_btn.click()
            time.sleep(0.1)
            assert driver.find_element(By.ID, "draftStatusLabel").text == "All Changes Saved"

            driver.find_element(By.ID, "btnOpenEditorMediaPicker").click()
            WebDriverWait(driver, 5).until(lambda d: d.find_element(By.ID, "editorMediaPickerDialog").get_attribute("open") is not None)
            driver.find_elements(By.CSS_SELECTOR, "#studioMediaGrid .btn-picker-select")[0].click()
            driver.find_element(By.ID, "btnCancelEditorMediaPicker").click()
            time.sleep(0.1)
            assert driver.find_element(By.ID, "draftStatusLabel").text == "All Changes Saved", "Cancel must not apply the staged selection"

            # Verify responsive layout at 940x700
            driver.set_window_size(940, 700)
            time.sleep(0.15)
            assert left_panel.is_displayed() and center_panel.is_displayed() and right_panel.is_displayed()
            return "3-panel Studio structured-tree keyboard selection, on-demand media assignment, Undo, and responsive 940×700 layout verified"

        record_e2e("E2E-3", "Structured Visual Studio workflow, on-demand picker, keyboard navigation & Undo/Discard", e2e_studio_workflow)

        # Tier 3 — E2E 4: Verify Hostile XSS Filename Rendering in Studio Media Library
        def e2e_studio_xss_safety():
            driver.set_window_size(1440, 900)
            driver.get(f"{extension_origin}/studio.html?siteKey={quote(origin_a, safe='')}")
            time.sleep(0.3)

            res = driver.execute_async_script("""
              const done = arguments[arguments.length - 1];
              (async () => {
                window.__studioXssTriggered = false;
                const c = document.createElement('canvas');
                c.width = 48; c.height = 48;
                const ctx = c.getContext('2d');
                ctx.fillStyle = '#10b981';
                ctx.fillRect(0, 0, 48, 48);
                const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
                const hostileName = '"><img src=x onerror="window.__studioXssTriggered=true"><script>window.__studioXssTriggered=true</script>.png';
                await window.ChameleonStorageService.importMediaItem(blob, {
                  name: hostileName,
                  mimeType: 'image/png',
                  convertToWebP: false
                });
                // Trigger media library re-render via search input event
                const input = document.getElementById('mediaSearchInput');
                input.dispatchEvent(new Event('input'));
                await new Promise((r) => setTimeout(r, 150));
                const titles = Array.from(document.querySelectorAll('.media-card-title')).map((el) => el.textContent);
                const injectedImgs = document.querySelectorAll('.media-card-title img, .media-card-title script');
                done({
                  xssTriggered: window.__studioXssTriggered,
                  hasLiteralTitle: titles.some((t) => t.includes('<img src=x')),
                  injectedElementCount: injectedImgs.length
                });
              })();
            """)
            assert res["xssTriggered"] is False, "XSS handler must never execute in Studio UI"
            assert res["hasLiteralTitle"] is True, "Hostile filename must appear as literal textContent"
            assert res["injectedElementCount"] == 0, "Zero injected DOM elements inside media card title"
            return "Hostile <img onerror> / <script> filename rendered as literal text in Studio Media Library"

        record_e2e("E2E-4", "Hostile XSS filename rendering safety in Studio Media Library", e2e_studio_xss_safety)

        failed_e2e = [r for r in e2e_results if r["status"] == "FAIL"]
        if failed_e2e:
            raise AssertionError(f"Tier 3 E2E tests failed: {failed_e2e}")

        return tier2_report, {
            "suite": "Tier 3 — Browser End-to-End UI & Permission-Gate Suite",
            "totalTests": len(e2e_results),
            "passedCount": len(e2e_results) - len(failed_e2e),
            "failedCount": len(failed_e2e),
            "results": e2e_results
        }
    finally:
        driver.quit()
        server_a.shutdown()
        server_b.shutdown()

def main():
    tier1_only = "--tier" in sys.argv and "1" in sys.argv or "--unit" in sys.argv

    print("Running Tier 1: Node.js Unit Tests...")
    tier1 = run_tier1_unit_tests()
    print(f"  -> Tier 1 PASS: {tier1['passedCount']}/{tier1['totalTests']} ({tier1['totalDurationMs']} ms)")

    if tier1_only:
        print(json.dumps({
            "version": "2.2.0-firefox-domain-themes-audio-reliability-data-lifecycle",
            "tier1_unit": tier1
        }, indent=2))
        return 0 if tier1.get("failedCount", 0) == 0 else 1

    if SELENIUM_IMPORT_ERROR:
        blocked = {
            "status": "BLOCKED",
            "reason": "Selenium is not installed in this Python environment; browser tests were not executed.",
            "importError": SELENIUM_IMPORT_ERROR
        }
        print("Browser tiers BLOCKED: " + blocked["reason"])
        print(json.dumps({
            "version": "2.2.0-firefox-domain-themes-audio-reliability-data-lifecycle",
            "tier1_unit": tier1,
            "tier2_integration": blocked,
            "tier3_browser_e2e": blocked,
            "manual_verification_required": [
                "User-gesture optional-host permission prompt and actual authorized page injection.",
                "Native toolbar-popup geometry and OS file-picker/drag-and-drop.",
                "Firefox background-script event lifecycle and chrome.alarms wake-up across several minutes in the hardened desktop profile.",
                "Manual smoke tests on live third-party sites and verification that selection returns to the studio."
            ]
        }, indent=2))
        return 2

    print("Running Tier 2 & Tier 3: Chromium Integration & End-to-End Browser Tests...")
    tier2, tier3 = run_tier2_and_tier3_browser_tests()
    print(f"  -> Tier 2 PASS: {tier2['passedCount']}/{tier2['totalTests']} ({tier2['totalDurationMs']} ms)")
    if tier3.get("status") == "SKIPPED":
        print(f"  -> Tier 3 SKIPPED: {tier3['reason']}")
    else:
        print(f"  -> Tier 3 PASS: {tier3['passedCount']}/{tier3['totalTests']}")

    full_summary = {
        "version": "2.2.0-firefox-domain-themes-audio-reliability-data-lifecycle",
        "tier1_unit": tier1,
        "tier2_integration": tier2,
        "tier3_browser_e2e": tier3,
        "tier4_manual_verification_checklist": [
            "Interactive OS file-manager drag-and-drop onto a live third-party website (blocked in headless mode by AllowFileSelectionDialogs policy).",
            "Multi-minute Firefox background-script event lifecycle and chrome.alarms wake-up across browser restarts.",
            "Visual aesthetics check on external production websites (unavailable in offline sandbox VM without outbound internet)."
        ]
    }

    print("\n=== COMPLETE TEST SUITE SUMMARY (JSON) ===")
    print(json.dumps(full_summary, indent=2))

if __name__ == "__main__":
    sys.exit(main() or 0)
