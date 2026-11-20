/**
 * ChameleonBG v3 Experimental — Real Firefox E2E Browser Test Suite
 * Runs against an isolated temporary Firefox profile (never touches user profiles).
 * Usage: node tests/firefox_e2e_tests.mjs
 */
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const PROFILE_DIR = path.join(os.tmpdir(), `chameleonbg-ff-e2e-${Date.now()}`);
const PORT = 2845;

const FIREFOX_CANDIDATES = [
  process.env.FIREFOX_PATH,
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
  "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe",
  "/usr/bin/firefox",
  "/Applications/Firefox.app/Contents/MacOS/firefox",
].filter(Boolean);

const FIREFOX_EXE = FIREFOX_CANDIDATES.find((p) => fs.existsSync(p));
if (!FIREFOX_EXE) {
  console.error("Firefox executable not found. Set FIREFOX_PATH to run Firefox E2E tests.");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tiny valid 1x1 PNG (68 bytes) used to test multi-item library & long-filename UI without external deps
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

class MarionetteClient {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.pending = new Map();
    this.handshakeResolve = null;
    this.handshakePromise = new Promise((r) => { this.handshakeResolve = r; });
    socket.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this._drain();
    });
  }
  _drain() {
    while (true) {
      const colonIdx = this.buf.indexOf(":");
      if (colonIdx === -1) return;
      const len = parseInt(this.buf.subarray(0, colonIdx).toString("utf8"), 10);
      if (Number.isNaN(len) || this.buf.length < colonIdx + 1 + len) return;
      const body = this.buf.subarray(colonIdx + 1, colonIdx + 1 + len).toString("utf8");
      this.buf = this.buf.subarray(colonIdx + 1 + len);
      const parsed = JSON.parse(body);
      if (!Array.isArray(parsed) && parsed.applicationType) {
        this.handshakeResolve(parsed);
      } else if (Array.isArray(parsed) && parsed[0] === 1) {
        const [, id, err, res] = parsed;
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          if (err) p.reject(new Error(`${err.error}: ${err.message}`));
          else p.resolve(res);
        }
      }
    }
  }
  send(cmd, params = {}) {
    const id = this.nextId++;
    const payload = JSON.stringify([0, id, cmd, params]);
    const frame = `${Buffer.byteLength(payload, "utf8")}:${payload}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(frame, "utf8");
    });
  }
  close() {
    try { this.socket.destroy(); } catch {}
  }
}

async function connectMarionette(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      await new Promise((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      const client = new MarionetteClient(sock);
      await client.handshakePromise;
      return client;
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`Timed out connecting to Marionette on port ${port}`);
}

async function exec(m, script, args = []) {
  const res = await m.send("WebDriver:ExecuteScript", { script, args });
  return res.value;
}

async function execAsync(m, script, args = []) {
  const res = await m.send("WebDriver:ExecuteAsyncScript", { script, args });
  return res.value;
}

async function getHandles(m) {
  const raw = await m.send("WebDriver:GetWindowHandles", {});
  return Array.isArray(raw) ? raw : (Array.isArray(raw?.value) ? raw.value : []);
}

async function openExtTab(m, url) {
  const beforeSet = new Set(await getHandles(m));
  await m.send("Marionette:SetContext", { value: "chrome" });
  await exec(m, `
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win.gBrowser.selectedTab = win.gBrowser.addTrustedTab(arguments[0]);
  `, [url]);
  await m.send("Marionette:SetContext", { value: "content" });
  await sleep(900);
  const afterArr = await getHandles(m);
  const newHandle = afterArr.find((h) => !beforeSet.has(h)) || afterArr[afterArr.length - 1];
  await m.send("WebDriver:SwitchToWindow", { handle: newHandle });
  await sleep(500);
  return newHandle;
}

async function main() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROFILE_DIR, "user.js"),
    [
      `user_pref("marionette.port", ${PORT});`,
      'user_pref("xpinstall.signatures.required", false);',
      'user_pref("browser.shell.checkDefaultBrowser", false);',
      'user_pref("browser.startup.homepage_override.mstone", "ignore");',
      'user_pref("datareporting.policy.firstRunURL", "");',
      'user_pref("trailhead.firstrun.didSeeAboutWelcome", true);',
      'user_pref("browser.tabs.warnOnClose", false);',
      'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    ].join("\n"),
    "utf8"
  );

  const ff = spawn(
    FIREFOX_EXE,
    ["--marionette", "--profile", PROFILE_DIR, "--no-remote", "--width=1366", "--height=860", "about:blank"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    }
  );

  const results = [];
  async function runTest(id, name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ id, name, status: "PASS", durationMs: Date.now() - t0, detail });
      console.log(`PASS [${id}] ${name} (${Date.now() - t0}ms)${detail ? " — " + detail : ""}`);
    } catch (err) {
      results.push({ id, name, status: "FAIL", durationMs: Date.now() - t0, error: err?.message || String(err) });
      console.error(`FAIL [${id}] ${name}: ${err?.message || err}`);
    }
  }

  let m;
  try {
    m = await connectMarionette(PORT);
    await m.send("WebDriver:NewSession", { capabilities: {} });
    const addonRes = await m.send("Addon:Install", { path: EXT_DIR, temporary: true });
    await sleep(1000);

    let extUuid = null;
    for (let i = 0; i < 15; i++) {
      const prefsPath = path.join(PROFILE_DIR, "prefs.js");
      if (fs.existsSync(prefsPath)) {
        const text = fs.readFileSync(prefsPath, "utf8");
        const match = text.match(/extensions\.webextensions\.uuids",\s*("(?:[^"\\]|\\.)*")/);
        if (match) {
          const decoded = JSON.parse(JSON.parse(match[1]));
          extUuid = decoded[addonRes.value] || decoded["chameleonbg@local.experimental"];
          if (extUuid) break;
        }
      }
      await sleep(250);
    }
    assert(extUuid, "Extension UUID must be registered in Firefox temp profile");
    const base = `moz-extension://${extUuid}`;

    // Open Khan Academy in tab 1
    await m.send("WebDriver:Navigate", { url: "https://www.khanacademy.org/" });
    await sleep(1800);

    // B1: Popup clean state on protected browser page
    await runTest("B1", "Popup loads cleanly with single notice and no duplicate errors", async () => {
      await openExtTab(m, `${base}/popup.html`);
      await sleep(600);
      const state = await exec(m, `
        return {
          noticeHidden: document.getElementById('unsupportedNotice')?.hidden,
          stateTextHidden: document.getElementById('siteAccessStateText')?.hidden,
          activeControlsHidden: document.getElementById('popupActiveControls')?.hidden
        };
      `);
      assert.strictEqual(state.noticeHidden, false, "Unsupported notice should be visible on browser/extension page");
      assert.strictEqual(state.stateTextHidden, true, "Duplicate siteAccessStateText should be hidden on unsupported page");
      assert.strictEqual(state.activeControlsHidden, true, "Dead active controls should be hidden on unsupported page");
      return "Single friendly notice shown; dead controls hidden";
    });

    // B2: Studio Visual Editor default layout & single Pick button
    let studioHandle;
    await runTest("B2", "Visual Editor opens Customize by default with a single Pick button and no empty playlist clutter", async () => {
      studioHandle = await openExtTab(m, `${base}/studio.html?siteKey=${encodeURIComponent("https://www.khanacademy.org")}`);
      await sleep(1000);
      const state = await exec(m, `
        const pickButtons = Array.from(document.querySelectorAll('#viewEditor button'))
          .filter((b) => /pick on (website|site)/i.test(b.textContent || ''));
        return {
          appearanceHidden: document.getElementById('editorPanelAppearance')?.hidden,
          areasHidden: document.getElementById('editorPanelAreas')?.hidden,
          pickButtonCount: pickButtons.length,
          rotationHidden: document.getElementById('playlistRotationControls')?.hidden,
          pauseVideosHidden: document.getElementById('btnPauseBackgroundVideos')?.hidden,
          discardHidden: document.getElementById('btnStudioDiscard')?.hidden,
          saveHidden: document.getElementById('btnStudioSave')?.hidden,
        };
      `);
      assert.strictEqual(state.appearanceHidden, false, "Customize panel must be open by default");
      assert.strictEqual(state.areasHidden, true, "All Areas tab must be hidden by default");
      assert.strictEqual(state.pickButtonCount, 1, `Expected exactly 1 Pick button, found ${state.pickButtonCount}`);
      assert.strictEqual(state.rotationHidden, true, "Playlist rotation controls must be hidden when <2 items");
      assert.strictEqual(state.pauseVideosHidden, true, "Pause videos button must be hidden when 0 videos");
      assert.strictEqual(state.discardHidden, true, "Discard button must be hidden in Auto-save mode");
      assert.strictEqual(state.saveHidden, true, "Save button must be hidden in Auto-save mode");
      return "Customize open, 1 Pick button, zero empty clutter";
    });

    // B3: 18-item media picker scrollability + Icons/List File-Explorer toggle
    await runTest("B3", "Media picker scrolls cleanly with 18+ items without squishing cards and toggles Icons/List", async () => {
      await exec(m, `document.getElementById('btnOpenEditorMediaPicker')?.click();`);
      await sleep(500);
      await execAsync(m, `
        const [b64, done] = arguments;
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], "5e7b9f9150cbcd001176c5db_18___cave_sunshaft.png", { type: "image/png" }));
        for (let i = 1; i <= 17; i++) {
          dt.items.add(new File([bytes], "wallpaper_sample_" + String(i).padStart(2, "0") + ".png", { type: "image/png" }));
        }
        const input = document.getElementById("studioFileInput");
        input.files = dt.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        setTimeout(() => done(true), 2200);
      `, [TINY_PNG_B64]);
      await sleep(600);

      const gridMetrics = await exec(m, `
        const grid = document.getElementById('studioMediaGrid');
        const card = grid?.querySelector('.media-item-card');
        const thumb = card?.querySelector('.media-thumb-wrap');
        return {
          cardCount: grid?.querySelectorAll('.media-item-card').length || 0,
          gridClientH: grid?.clientHeight || 0,
          gridScrollH: grid?.scrollHeight || 0,
          cardH: card ? card.getBoundingClientRect().height : 0,
          thumbH: thumb ? thumb.getBoundingClientRect().height : 0,
        };
      `);
      assert(gridMetrics.cardCount >= 18, `Expected >=18 cards, got ${gridMetrics.cardCount}`);
      assert(gridMetrics.cardH >= 170, `Cards must not squish in Icons view (got ${gridMetrics.cardH}px)`);
      assert(gridMetrics.thumbH >= 90, `Thumbnails must remain full height (got ${gridMetrics.thumbH}px)`);
      assert(gridMetrics.gridScrollH > gridMetrics.gridClientH, "Media picker grid must scroll when many items exist");

      // Switch to List view
      await exec(m, `document.querySelector('#editorMediaPickerDialog .view-toggle-btn[data-media-view="list"]')?.click();`);
      await sleep(300);
      const listMetrics = await exec(m, `
        const grid = document.getElementById('studioMediaGrid');
        const card = grid?.querySelector('.media-item-card');
        return {
          hasListClass: grid?.classList.contains('media-view-list'),
          cardH: card ? card.getBoundingClientRect().height : 0,
          savedMode: localStorage.getItem('chameleon_media_view_mode'),
        };
      `);
      assert.strictEqual(listMetrics.hasListClass, true, "Grid must have media-view-list class in List mode");
      assert(listMetrics.cardH >= 44 && listMetrics.cardH <= 84, `List rows should be compact (got ${listMetrics.cardH}px)`);
      assert.strictEqual(listMetrics.savedMode, "list", "View mode must persist to localStorage");

      // Switch back to Icons view for cleanliness
      await exec(m, `document.querySelector('#editorMediaPickerDialog .view-toggle-btn[data-media-view="grid"]')?.click();`);
      await sleep(200);
      return `Icons card=${Math.round(gridMetrics.cardH)}px (scrollable ${gridMetrics.gridScrollH}px/${gridMetrics.gridClientH}px), List row=${Math.round(listMetrics.cardH)}px`;
    });

    // B4 & B5: Apply long filename, verify no Remove button clipping, test Quick Looks & Undo + tab switch hygiene
    await runTest("B4", "Long filename does not clip Remove button, Quick Looks update sliders, and Undo restores values", async () => {
      // Select the long-named wallpaper and apply it
      await exec(m, `
        const cards = Array.from(document.querySelectorAll('#studioMediaGrid .media-item-card'));
        const target = cards.find((c) => (c.textContent || '').includes('cave_sunshaft')) || cards[0];
        // Deselect others if any, select target
        cards.forEach((c) => {
          if (c.classList.contains('picker-selected') && c !== target) c.querySelector('button')?.click();
        });
        if (target && !target.classList.contains('picker-selected')) target.querySelector('button')?.click();
      `);
      await sleep(250);
      await exec(m, `document.getElementById('btnConfirmEditorMediaPicker')?.click();`);
      await sleep(500);

      const clipCheck = await exec(m, `
        const panel = document.getElementById('editorPanelAppearance');
        const removeBtn = panel?.querySelector('.playlist-row button');
        if (!panel || !removeBtn) return { ok: false };
        const pRect = panel.getBoundingClientRect();
        const bRect = removeBtn.getBoundingClientRect();
        return { ok: true, panelRight: pRect.right, btnRight: bRect.right, btnWidth: bRect.width };
      `);
      assert.strictEqual(clipCheck.ok, true, "Assigned playlist row with Remove button must exist");
      assert(clipCheck.btnRight <= clipCheck.panelRight + 1, `Remove button clipped past panel edge (${clipCheck.btnRight} > ${clipCheck.panelRight})`);

      // Click Easy Read Quick Look and verify sliders actually update
      await exec(m, `document.querySelector('.quick-look-btn[data-look="easy-read"]')?.click();`);
      await sleep(300);
      const afterLook = await exec(m, `
        return {
          opacity: document.getElementById('sliderOpacity')?.value,
          dimmer: document.getElementById('sliderDimmer')?.value,
          glass: document.getElementById('sliderBackdropBlur')?.value,
          blur: document.getElementById('sliderBlur')?.value,
          contrast: document.getElementById('selectTextContrastMode')?.value,
        };
      `);
      assert.strictEqual(afterLook.opacity, "88", "Easy Read must set opacity=88");
      assert.strictEqual(afterLook.dimmer, "32", "Easy Read must set dimmer=32");
      assert.strictEqual(afterLook.glass, "8", "Easy Read must set frosted glass=8");
      assert.strictEqual(afterLook.blur, "2", "Easy Read must set blur=2");
      assert.strictEqual(afterLook.contrast, "light-halo", "Easy Read must set light-halo");

      // Click Back (Undo) and verify values restore
      await exec(m, `document.getElementById('btnStudioUndo')?.click();`);
      await sleep(300);
      const afterUndo = await exec(m, `
        return {
          dimmer: document.getElementById('sliderDimmer')?.value,
          glass: document.getElementById('sliderBackdropBlur')?.value,
        };
      `);
      assert.strictEqual(afterUndo.dimmer, "20", "Undo must restore previous dimmer=20");
      assert.strictEqual(afterUndo.glass, "0", "Undo must restore previous glass=0");

      // Switch to Media Library and back to Visual Editor; verify topbar stays clean
      await exec(m, `document.getElementById('tabBtnLibrary')?.click();`);
      await sleep(300);
      await exec(m, `document.getElementById('tabBtnEditor')?.click();`);
      await sleep(300);
      const topbarAfter = await exec(m, `
        return {
          pauseHidden: document.getElementById('btnPauseBackgroundVideos')?.hidden,
          discardHidden: document.getElementById('btnStudioDiscard')?.hidden,
          saveHidden: document.getElementById('btnStudioSave')?.hidden,
        };
      `);
      assert.strictEqual(topbarAfter.pauseHidden, true, "Pause videos must stay hidden after returning from Library");
      assert.strictEqual(topbarAfter.discardHidden, true, "Discard must stay hidden in Auto-save after returning from Library");
      assert.strictEqual(topbarAfter.saveHidden, true, "Save must stay hidden in Auto-save after returning from Library");
      return "No Remove clipping, Easy Read + Undo verified, topbar clean after view switch";
    });

    // B5: Preview tab opens without visually switching away from Studio
    await runTest("B5", "Preview tab opens cleanly without visually switching browser tabs", async () => {
      await exec(m, `document.getElementById('tabBtnPreview')?.click();`);
      await sleep(700);
      const currentHandle = (await m.send("WebDriver:GetWindowHandle", {})).value;
      const previewVisible = await exec(m, `return !document.getElementById('viewPreview')?.hidden;`);
      assert.strictEqual(currentHandle, studioHandle, "Active tab must remain Studio (no visual switch to target tab)");
      assert.strictEqual(previewVisible, true, "Preview view must be visible");
      return "Studio stayed active with zero tab flash when entering Preview";
    });

    const failed = results.filter((r) => r.status === "FAIL");
    console.log(`\nFirefox E2E Summary: ${results.length - failed.length}/${results.length} passed, ${failed.length} failed.`);
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    if (m) m.close();
    try { ff.kill(); } catch {}
    await sleep(400);
    try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
