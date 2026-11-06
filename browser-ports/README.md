# Browser ports

The repository root is the **Firefox 2.4.0 source**. Its `manifest.json` uses Firefox's ordered `background.scripts` and should stay in place for the Firefox build.

## Chromium browsers

| Browser | Where to load a local copy | Manifest to use |
| --- | --- | --- |
| Chrome | `chrome://extensions` → Developer mode → Load unpacked | [`chromium/manifest.json`](chromium/manifest.json) |
| Microsoft Edge | `edge://extensions` → Developer mode → Load unpacked | Same Chromium manifest |
| Brave | Extensions manager → Developer mode → Load unpacked | Same Chromium manifest |
| Opera | Extensions manager → Developer mode → Load unpacked | Same Chromium manifest |
| Vivaldi | Extensions manager → Developer mode → Load unpacked | Same Chromium manifest |

**Exact replacement:** Make a separate copy of the extension source folder. Copy `browser-ports/chromium/manifest.json` over the **root** `manifest.json` in that copy. The copied folder must still contain `background.js`, `storage-service.js`, `access-control.js`, `video-manager.js`, all other extension source files, and `icons/`. Select that copied **root folder** in the browser's **Load unpacked** dialog. Do not select `browser-ports/chromium` by itself. No other source file needs replacing for this initial port.

The replacement manifest swaps Firefox's `background.scripts` array for Chromium's Manifest V3 `background.service_worker` and removes Firefox-only `browser_specific_settings`. `background.js` already imports its shared scripts when it runs as a service worker. The permissions and site consent model remain the same.

**Status:** This is a candidate port for local testing, not a published or fully verified Chrome/Edge/Brave/Opera/Vivaldi release. A successfully loaded manifest is not proof that every feature works. Before distributing a port, test site permission prompts, dynamic script injection, selection, media storage, preview capture, playback, and backup/restore in each target browser. Keep its release packaging and store listing separate from the Firefox upload ZIP.

Safari needs Apple's Safari Web Extension packaging and platform-specific compatibility work; replacing only `manifest.json` is insufficient. No Safari package is provided here. See [Apple's Safari extension guide](https://developer.apple.com/safari/extensions/).

For loading instructions, see the official [Chrome unpacked extension guide](https://developer.chrome.com/docs/extensions/get-started/tutorial/hello-world#load-unpacked) and [Microsoft Edge sideloading guide](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/getting-started/extension-sideloading). Chrome's [service worker documentation](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/basics) explains the background change.
