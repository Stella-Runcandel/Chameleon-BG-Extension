# ChameleonBG 2.4.0

ChameleonBG is a Firefox extension for locally customizing website backgrounds
with user-selected images, GIFs, SVGs, and looping videos. You can apply media
to a whole page or a selected region, adjust its appearance, preview framing,
and reuse settings across a domain. It activates only on sites you enable.

## Firefox release

The Firefox release keeps the existing production add-on ID
`chameleonbg@local.experimental` so a signed 2.4.0 upload can update the same
add-on. The release ZIP contains the extension's readable source files with
`manifest.json` at the archive root. It has no runtime dependencies, bundled
sample media, minified code, or remote executable code.

Build the upload ZIP with Python 3.8 or newer:

```text
python scripts/build_firefox.py
```

This creates `dist/chameleonbg-2.4.0-firefox-upload.zip`. Upload that ZIP as a
new version of the existing add-on in the [Firefox Developer Hub](https://addons.mozilla.org/developers/).
Firefox signs the accepted upload. The local ZIP is not signed and is not a
normal-installable XPI.

Run the local unit checks before uploading:

```text
node tests/unit_tests.js
```

The ZIP excludes `tests/`, `store-demos/`, development guides, and Git files.
The source repository contains the unmodified extension source used to build
the ZIP; no separate generated-source archive is needed.

## Permissions and privacy

Required browser API permissions: `storage`, `unlimitedStorage`, `activeTab`,
`contextMenus`, `scripting`, and `alarms`. The extension requests HTTP/HTTPS
host access at runtime for websites you choose. It does not need extra
permissions for 2.4.0. See [PRIVACY.md](PRIVACY.md) for what each permission
does, how local data is used, and how to remove it.

## Support and license

The optional support links in Settings open
[Ko-fi](https://ko-fi.com/stellalabs) and
[Patreon](https://www.patreon.com/cw/Stella_Labs). They do not unlock features.
ChameleonBG is distributed under the [MIT License](LICENSE).
