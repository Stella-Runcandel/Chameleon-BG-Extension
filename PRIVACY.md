# ChameleonBG Privacy Policy

**Effective Date:** November 21, 2026

## Short Version
**ChameleonBG collects zero data.** There is no developer server, no analytics, no telemetry, and no user accounts. Every wallpaper, playlist, theme, and site preference you create stays strictly on your device inside your browser's local storage.

---

## What Data Is Stored (Locally Only)
- **Imported Media:** Images, GIFs, SVGs, and videos you import are stored locally in extension-owned **IndexedDB** (`ChameleonBG_ExtMediaDB`) on your device. They are never uploaded anywhere.
- **Site Settings & Themes:** Per-site visual configurations, Domain Themes, and opt-in site access records are stored locally in **`chrome.storage.local`**.
- **Preview Snapshots:** When you open Studio or pick an area on a page, ChameleonBG may capture a temporary screenshot of that visible tab to display inside Studio's **Preview** framing view. This snapshot is kept strictly in memory (up to 6 tabs), is never sent off-device, and clears when the extension restarts.
- **Backups:** Exported backup files are saved only where you choose on your computer.

## What ChameleonBG Accesses on Enabled Sites
ChameleonBG **never runs on a website until you explicitly enable that site** and grant browser host permission. On enabled sites only:
- It inspects page layout structure to let you pick customizable regions and mount background layers cleanly behind page content.
- It does **not** read passwords, form inputs, cookies, or private account data.
- Note that websites themselves can observe visual/DOM changes made inside their page.

## Browser Permissions Explained
| Permission | Why It Is Needed |
| --- | --- |
| `storage` | Save your site looks, Domain Themes, and opt-in access preferences locally. |
| `unlimitedStorage` | Allow storing large local wallpaper/video libraries beyond the small default browser quota. |
| `activeTab` | Interact with the active tab you choose, including capturing a local framing preview. |
| `scripting` | Inject ChameleonBG's background renderer and element picker **only** on sites you explicitly enable. |
| `contextMenus` | Provide the right-click **Choose area** shortcut on webpages. |
| `alarms` | Schedule local playlist rotations and background housekeeping. |
| Optional `http://*/*` & `https://*/*` | Requested **at runtime** only when you explicitly turn ChameleonBG on for a website. Even if a broad host permission exists, ChameleonBG still enforces an exact-origin opt-in check before running. |

## External Links
Optional support links (**Ko-fi** and **Patreon**) in Settings only open those websites if you click them. ChameleonBG never sends any data to external services.

## Your Controls & Data Deletion
You are always in full control of your data:
- Pause ChameleonBG globally or per website at any time.
- Remove a website's browser permission via **Remove Access** in the popup or in Firefox Add-ons settings.
- Delete individual wallpapers, reset a single website, or wipe everything in **Settings → Privacy & Data → Clear All Data**.
- Uninstalling ChameleonBG removes its browser-managed local storage.

## Questions or Security Reports
If you have privacy questions or want to report a security issue, please open an issue at [GitHub Issues](https://github.com/Stella-Runcandel/Chameleon-BG-Extension/issues).
