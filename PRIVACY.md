# ChameleonBG — Privacy Policy & Global Legal Compliance Declaration

**Effective Date:** October 25, 2026  
**Extension Name:** ChameleonBG — Custom Website Backgrounds, Themes & Audio

---

## 1. Zero Data Collection Guarantee

**ChameleonBG operates 100% locally on your device.**

- **No Personal Data Collected:** We do not collect, request, access, log, or process your name, email address, IP address, device identifiers, location, or any other personal information.
- **No Browsing History or Website Content Tracked:** ChameleonBG only activates on specific website origins (`protocol://hostname:port`) that you explicitly authorize. Even on authorized websites, your browsing activity, page content, and form inputs are never read or transmitted anywhere.
- **No External Servers, Cloud Uploads, or Telemetry:** All images, animated GIFs, SVGs, videos, Domain Themes, and per-site customization profiles are stored strictly inside your browser's local storage (`storage.local` and extension-owned `IndexedDB`). ChameleonBG makes **zero** network requests to developer servers or third-party analytics services.
- **Mozilla Firefox `data_collection_permissions` Declaration:** In `manifest.json`, ChameleonBG explicitly declares `"data_collection_permissions": { "required": ["none"] }`.

---

## 2. Regional Privacy Compliance (US, EU/EEA/UK, Japan, South Korea, India)

Because ChameleonBG processes and stores all user data strictly locally on the user's own device with zero external transmission, no personal data is transferred to a data controller or third-party processor:

- **European Union, EEA & United Kingdom (GDPR & ePrivacy Directive):**
  - *Data Controller / Processor Status:* We do not act as a remote data controller or processor of your personal data because no data ever leaves your browser.
  - *Right to Erasure & Data Portability:* You have complete local control over your data at all times. You can export your configurations and media via **Settings & Permissions → Backup & Restore**, revoke access or delete settings for any individual website via the **Websites** tab, or permanently erase all stored data via **Clear All ChameleonBG Data** (or by uninstalling the extension).
- **United States (CCPA / CPRA & State Privacy Laws):**
  - We do not collect, sell, rent, or share any personal information or consumer data as defined under the California Consumer Privacy Act (CCPA) / California Privacy Rights Act (CPRA).
- **Japan (Act on the Protection of Personal Information — APPI):**
  - No personal information or personally referable information is acquired, stored externally, or provided to any third party.
- **South Korea (Personal Information Protection Act — PIPA):**
  - ChameleonBG collects zero personal information and requires explicit, opt-in user permission (`optional_host_permissions`) before running on any website.
- **India (Digital Personal Data Protection Act, 2023 — DPDP Act):**
  - No digital personal data is collected or processed by the developer. All customization files remain within the user's personal browser environment.

---

## 3. Permissions Used & Why They Are Required

ChameleonBG follows the principle of least privilege:

1. **`storage` & `unlimitedStorage`:** Used exclusively to save your website background preferences, Domain Themes, and uploaded background images/videos locally inside your browser without hitting small default storage quotas.
2. **`activeTab` & `scripting`:** Used to mount your custom background layers and launch the interactive on-page area picker only on websites you choose to customize.
3. **`alarms`:** Used locally inside the browser to prune expired temporary permission-request state cleanly.
4. **`optional_host_permissions` (`http://*/*`, `https://*/*`):** Requested on-demand so ChameleonBG only runs on websites you explicitly approve.

---

## 4. Terms of Use, Assumption of Risk & Limitation of Liability

- **Neutral Local Tool (No Stream Recording or DRM Circumvention):** ChameleonBG is strictly a local visual styling tool that renders user-selected backgrounds inside the user's own browser. It does not download, rip, record, or intercept third-party audio/video streams or bypass any Digital Rights Management (DRM) or access controls.
- **User Responsibility & Assumption of Risk:** By installing or enabling ChameleonBG on a website, you agree that you are solely responsible for:
  1. Ensuring you have the legal right to use any local images, GIFs, SVGs, or videos you import into your browser; and
  2. Complying with the Terms of Service and account rules of any third-party website you choose to customize.
- **Indemnification & Release:** You assume all risks associated with enabling visual modifications on third-party websites and agree to hold the developer(s) harmless from any claims, account restrictions, damages, or disputes arising from your use of the extension or your locally imported media.
- **Disclaimer of Warranties & Limitation of Liability:** CHAMELEONBG IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. IN NO EVENT SHALL THE DEVELOPER(S) BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE USE OF THIS EXTENSION.
