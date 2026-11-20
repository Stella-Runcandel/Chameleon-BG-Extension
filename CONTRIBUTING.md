# Contributing to ChameleonBG

Thanks for your interest in improving **ChameleonBG**! Whether you're reporting a bug, suggesting a UX improvement, or submitting a pull request, this guide will get you up and running quickly.

---

## 1. Local Development Setup

ChameleonBG has **no build step** and **no runtime dependencies**—just plain JavaScript, HTML, and CSS.

1. Fork and clone the repository:
   ```bash
   git clone https://github.com/Stella-Runcandel/Chameleon-BG-Extension.git
   cd Chameleon-BG-Extension
   ```
2. Load it temporarily in Firefox:
   - Open `about:debugging#/runtime/this-firefox`
   - Click **Load Temporary Add-on…** and choose the root `manifest.json`
   - Click **Reload** on that page anytime you edit extension files.

---

## 2. Core Project Rules

Before opening a pull request, please follow these non-negotiable standards (also detailed in [`AGENTS.md`](AGENTS.md)):

1. **Zero `innerHTML` / `outerHTML` / `insertAdjacentHTML`:**
   - Build all DOM nodes safely using `document.createElement`, `textContent`, `append`, and `replaceChildren()`.
2. **Privacy & Strict Origin Gating:**
   - Never add unconditional `host_permissions` or static `content_scripts` to `manifest.json`.
   - Keep `permissions.request()` synchronous inside user click handlers (no `await` before requesting permission).
   - Never trust `siteKey` sent from an untrusted content script when serving privileged data in `background.js`.
3. **Non-Destructive Host Page Edits:**
   - Tag all extension-injected DOM nodes on webpages with `data-chameleon-owned="true"`.
   - Route inline style edits on host elements through `setRecordedInlineStyle()` so resetting an area restores the original page cleanly.
4. **AMO Compliance:**
   - Keep `"name"` in `manifest.json` at **45 characters or fewer**.
   - Keep all code unminified and readable.

---

## 3. Running Tests

All tests must pass before submitting a PR:

- **Unit Tests (39 tests — fast, runs in Node.js):**
  ```bash
  node tests/unit_tests.js
  ```
- **Real Firefox E2E Browser Tests (5 tests — runs in an isolated temporary Firefox profile):**
  ```bash
  node tests/firefox_e2e_tests.mjs
  ```

---

## 4. Reporting Bugs & Requesting Features

Open an issue on **[GitHub Issues](https://github.com/Stella-Runcandel/Chameleon-BG-Extension/issues)** and include:
- Your Firefox version and ChameleonBG version.
- Steps to reproduce (and a screenshot/video if visual).
- Whether the issue happens on one specific site or everywhere.

---

## 5. Pull Request Checklist

- [ ] Changes stay focused and preserve existing functionality.
- [ ] Zero `innerHTML` / `outerHTML` / `insertAdjacentHTML` introduced.
- [ ] `node tests/unit_tests.js` passes (all tests green).
- [ ] `node tests/firefox_e2e_tests.mjs` passes if UI or Firefox behavior changed.
- [ ] Tested manually in Firefox via `about:debugging#/runtime/this-firefox`.
