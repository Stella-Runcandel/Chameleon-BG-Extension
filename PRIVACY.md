# ChameleonBG privacy and site access

Effective November 6, 2026.

ChameleonBG lets you place images and videos you choose behind website pages or
regions. The extension does not have a developer server, analytics, or an
account system. It does not send your imported media or site configurations to
the developer. Those items are saved in Firefox extension storage and
extension-owned IndexedDB on your device. An export goes to a file you choose.

On sites you enable, ChameleonBG reads page structure and element text needed
to identify selectable regions, applies local visual changes, and may capture
the visible tab to show a preview inside the Studio. Site settings are stored
by origin. The extension does not read passwords or form values for this
purpose. The website itself may observe changes made to its page.

The Ko-fi and Patreon buttons open those external services only when you click
them. Those services have their own privacy practices; ChameleonBG does not
send your extension data to them.

## Permissions

- `storage`: keep settings and site access choices in Firefox.
- `unlimitedStorage`: allow local media libraries beyond the small default
  extension storage quota. Available device storage still limits uploads.
- `activeTab`: work with the tab you choose, including a visible-tab preview.
- `scripting`: insert the editor's scripts and styles on an enabled site.
- `contextMenus`: show the **Choose area** page menu item.
- `alarms`: schedule local background housekeeping and playlist updates.
- Optional `http://*/*` and `https://*/*` host access: request access at runtime
  for sites you choose to enable. ChameleonBG also records an exact-origin
  consent choice and does not run on every page merely because a wildcard host
  permission was granted.

You can pause the extension, disable or revoke a site's access, delete site
settings, delete imported media, or clear all ChameleonBG data in the Studio.
Uninstalling the add-on normally removes its browser-managed storage. Export a
backup first if you want to keep your settings and media.

Use media you have the right to use and review a website's rules before
customizing it. ChameleonBG does not grant rights to third-party content or
guarantee that a website will permit visual-modification extensions. The
software license and its warranty disclaimer are in `LICENSE`.
