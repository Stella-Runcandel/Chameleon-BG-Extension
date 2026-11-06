"""Build a reviewable Firefox upload ZIP using only the Python standard library.

Run from any directory: python scripts/build_firefox.py
The allowlist deliberately excludes tests, fixtures, demos, repository metadata,
build scripts, and local developer files from the submitted add-on.
"""

import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parent.parent
FILES = (
    "manifest.json",
    "LICENSE",
    "PRIVACY.md",
    "access-control.js",
    "background.js",
    "content.css",
    "content.js",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "popup-theme.js",
    "popup.css",
    "popup.html",
    "popup.js",
    "renderer-engine.js",
    "selection-engine.js",
    "site-access.css",
    "site-access.html",
    "site-access.js",
    "storage-service.js",
    "studio.css",
    "studio.html",
    "studio.js",
    "video-manager.js",
)


def main():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    version = manifest["version"]
    if version != "2.4.0":
        raise SystemExit(f"Expected release version 2.4.0, got {version}")
    if manifest["browser_specific_settings"]["gecko"]["id"] != "chameleonbg@local.experimental":
        raise SystemExit("Refusing to package a different Firefox add-on ID")
    if "test" in manifest["name"].lower():
        raise SystemExit("Refusing to package a test-labelled add-on")

    destination = ROOT / "dist" / f"chameleonbg-{version}-firefox-upload.zip"
    destination.parent.mkdir(exist_ok=True)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for name in FILES:
            source = ROOT / name
            if not source.is_file():
                raise SystemExit(f"Missing release file: {name}")
            entry = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            archive.writestr(entry, source.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)

    with ZipFile(destination) as archive:
        if archive.namelist() != list(FILES) or archive.testzip() is not None:
            raise SystemExit("Release ZIP verification failed")
        for name in FILES:
            if archive.read(name) != (ROOT / name).read_bytes():
                raise SystemExit(f"Release ZIP differs from source: {name}")

    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    print(f"Created {destination}")
    print(f"Files: {len(FILES)}; bytes: {destination.stat().st_size}; SHA-256: {digest}")


if __name__ == "__main__":
    main()
