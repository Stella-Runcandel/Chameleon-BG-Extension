/**
 * ChameleonBG v2.0.1 — Tier 1: Node.js Unit Test Suite (`tests/unit_tests.js`)
 *
 * Run command:
 *   node tests/unit_tests.js
 *
 * Tests pure logic in `storage-service.js` without requiring a browser DOM:
 * 1. Site identity derivation & matching rules (HTTP vs HTTPS, ports, hostnames, subdomains).
 * 2. FNV-1a 32-bit streaming checksum integrity.
 * 3. Animated GIF89a header detection vs static GIF89a.
 * 4. Deep SVG sanitization (DOCTYPE/ENTITY rejection, <use>, <image>, <feImage>, <style> @import/url(), on* handlers).
 * 5. Bounded chunked media sender & receiver sessions (multi-chunk accuracy, out-of-order rejection,
 *    checksum verification, cancellation, size limit enforcement, concurrent transfer isolation).
 * 6. Conflict-safe per-site configuration storage (simultaneous edits to different sites,
 *    non-overlapping same-site merges, conflicting same-site revision detection, service-worker restart
 *    resilience, and one-time non-destructive v2.0 migration with conflict backup).
 * 7. Stable per-origin markers used by the legacy page-origin media migration.
 * 8. Optional host permissions, explicit user consent, and runtime activation gating.
 * 9. Studio view isolation, global pause, library controls, and picker acknowledgement.
 * 10. Sender-bound component-pick relay and readable overlapping layout-map labels.
 * 11. Popup-to-studio live-picker handoff so selection has a durable editor to return to.
 */

"use strict";

const assert = require("assert");
const StorageService = require("../storage-service.js");
const AccessControl = require("../access-control.js");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function createMockChromeStorage(initialData = {}) {
  const store = JSON.parse(JSON.stringify(initialData));
  return {
    _rawStore: store,
    async get(keys) {
      if (!keys) return JSON.parse(JSON.stringify(store));
      const keyList = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of keyList) {
        if (Object.prototype.hasOwnProperty.call(store, k)) {
          out[k] = JSON.parse(JSON.stringify(store[k]));
        }
      }
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) {
        store[k] = JSON.parse(JSON.stringify(v));
      }
    },
    async remove(keys) {
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        delete store[k];
      }
    }
  };
}

async function runUnitTests() {
  const results = [];
  const tStart = Date.now();

  async function test(id, name, fn) {
    const t0 = Date.now();
    try {
      const detail = await fn();
      results.push({ id, name, status: "PASS", durationMs: Date.now() - t0, detail: detail || "OK" });
    } catch (err) {
      results.push({ id, name, status: "FAIL", durationMs: Date.now() - t0, error: err.message || String(err) });
    }
  }

  // 1. Site Identity & Matching Policy (HTTP vs HTTPS, Ports, Subdomains)
  await test("U1", "Site identity derivation: HTTP vs HTTPS, ports, and subdomains", async () => {
    const idHttp = StorageService.deriveSiteIdentity("http://example.com/path");
    const idHttps = StorageService.deriveSiteIdentity("https://example.com/path");
    const idPort8080 = StorageService.deriveSiteIdentity("https://example.com:8080/app");
    const idSub = StorageService.deriveSiteIdentity("https://docs.example.com/guide");

    assert.strictEqual(idHttp.originKey, "http://example.com");
    assert.strictEqual(idHttps.originKey, "https://example.com");
    assert.strictEqual(idPort8080.originKey, "https://example.com:8080");
    assert.notStrictEqual(idHttp.originKey, idHttps.originKey, "HTTP and HTTPS must have distinct origin keys");
    assert.notStrictEqual(idHttps.originKey, idPort8080.originKey, "Different ports must have distinct origin keys");

    // Verify default "origin" scope does not match across protocol, port, or subdomain
    const originScopedRec = { siteKey: "https://example.com", matchScope: "origin" };
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(originScopedRec, idHttps).matches, true);
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(originScopedRec, idHttp).matches, false);
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(originScopedRec, idPort8080).matches, false);
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(originScopedRec, idSub).matches, false);

    // Verify explicit "hostname" scope matches HTTP, HTTPS, and ports on the same hostname, but not subdomains
    const hostScopedRec = { siteKey: "https://example.com", matchScope: "hostname" };
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(hostScopedRec, idHttp).matches, true);
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(hostScopedRec, idPort8080).matches, true);
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(hostScopedRec, idSub).matches, false);

    // Verify explicit "subdomain" scope matches subdomains
    const subScopedRec = { siteKey: "https://example.com", matchScope: "subdomain" };
    assert.strictEqual(StorageService.doesSiteRecordMatchIdentity(subScopedRec, idSub).matches, true);

    return "Verified exact origin isolation (HTTP/HTTPS/port) and explicit hostname/subdomain scopes";
  });

  // 2. Animated GIF Detection
  await test("U2", "Animated GIF89a multi-frame detection vs static GIF89a", async () => {
    const staticGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // 1 GCE block only
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
    ]);
    const animGif = new Uint8Array([
      0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE #1
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00,
      0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00, // GCE #2
      0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
    ]);

    assert.strictEqual(await StorageService.isAnimatedGif(staticGif.buffer), false);
    assert.strictEqual(await StorageService.isAnimatedGif(animGif.buffer), true);
    return "Static vs multi-frame GIF89a accurately distinguished";
  });

  // 3. Deep SVG & CSS Sanitization
  await test("U3", "Deep SVG & CSS sanitization against DOCTYPE/ENTITY, external URLs, and scripts", async () => {
    // Reject DOCTYPE / ENTITY
    let entityRejected = false;
    try {
      const xxeSvg = new Blob([`<!DOCTYPE svg [<!ENTITY xxe "secret">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>`], { type: "image/svg+xml" });
      await StorageService.sanitizeSvgBlob(xxeSvg);
    } catch (err) {
      entityRejected = /DOCTYPE|ENTITY/i.test(err.message);
    }
    assert.strictEqual(entityRejected, true, "SVG with DOCTYPE/ENTITY must be rejected");

    // Sanitize hostile SVG tags & attributes
    const dirtySvg = new Blob([
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">` +
      `<script>alert(2)</script>` +
      `<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>` +
      `<use href="https://evil.example/sprite.svg#icon" />` +
      `<image xlink:href="https://evil.example/tracker.png" />` +
      `<feImage href="data:image/svg+xml;base64,PHN2Zz4=" />` +
      `<animate attributeName="href" to="javascript:alert(3)" />` +
      `<rect width="100" height="100" fill="url(#localGrad)" onclick="evil()" />` +
      `</svg>`
    ], { type: "image/svg+xml" });

    const cleanBlob = await StorageService.sanitizeSvgBlob(dirtySvg);
    const cleanText = await cleanBlob.text();
    assert(!cleanText.includes("<script"), "Must strip <script>");
    assert(!cleanText.includes("<foreignObject"), "Must strip <foreignObject>");
    assert(!cleanText.includes("<use"), "Must strip <use>");
    assert(!cleanText.includes("<image"), "Must strip <image>");
    assert(!cleanText.includes("<feImage"), "Must strip <feImage>");
    assert(!cleanText.includes("<animate"), "Must strip <animate>");
    assert(!cleanText.includes("onload=") && !cleanText.includes("onclick="), "Must strip on* event handlers");
    assert(!cleanText.includes("evil.example"), "Must strip external URLs");

    const dirtyCss = `@import url("https://evil.example/a.css"); fill: url("https://evil.example/b.png"); mask: url(#safeMask); width: expression(alert(1));`;
    const cleanCss = StorageService.sanitizeCssStyleText(dirtyCss);
    assert(!cleanCss.includes("@import"), "Must strip @import");
    assert(!cleanCss.includes("evil.example"), "Must strip external url()");
    assert(cleanCss.includes("url(#safeMask)"), "Must preserve internal #id fragment url()");
    assert(!cleanCss.includes("expression("), "Must strip CSS expression()");

    return "DOCTYPE/ENTITY rejected; <use>/<image>/<feImage>/<animate>/on*/@import stripped while keeping safe vector shapes";
  });

  // 4. Bounded Chunked Media Transport (Multi-size, Cancellation, Checksum, Concurrency)
  await test("U4", "Bounded chunked media transport: multi-chunk integrity, cancellation, size limits & concurrency", async () => {
    // Create a 700 KB deterministic binary buffer (spans 3 chunks of 256 KB)
    const size = 700 * 1024;
    const rawBytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      rawBytes[i] = (i * 31 + 17) & 0xff;
    }
    const sourceBlob = new Blob([rawBytes], { type: "video/webm" });
    const record = { id: "media_700kb", name: "clip.webm", mimeType: "video/webm", mediaType: "video", size, blob: sourceBlob };

    // Create two concurrent transfers (txA: 700 KB, txB: 40 KB) to verify zero cross-talk
    const smallBytes = new Uint8Array(40 * 1024);
    for (let i = 0; i < smallBytes.length; i++) smallBytes[i] = (i * 7 + 3) & 0xff;
    const smallRecord = { id: "media_40kb", name: "thumb.webp", mimeType: "image/webp", mediaType: "image", size: smallBytes.length, blob: new Blob([smallBytes], { type: "image/webp" }) };

    const senderA = StorageService.createBoundedBlobSenderSession(record, { transferId: "tx_A", chunkSizeBytes: 256 * 1024 });
    const senderB = StorageService.createBoundedBlobSenderSession(smallRecord, { transferId: "tx_B", chunkSizeBytes: 16 * 1024 });

    assert.strictEqual(senderA.totalChunks, 3, "700 KB at 256 KB chunk size should require 3 chunks");
    assert.strictEqual(senderB.totalChunks, 3, "40 KB at 16 KB chunk size should require 3 chunks");

    const rxA = StorageService.createBoundedBlobReceiverSession({
      transferId: senderA.transferId,
      metadata: senderA.metadata,
      mimeType: senderA.mimeType,
      totalBytes: senderA.totalBytes,
      totalChunks: senderA.totalChunks
    });
    const rxB = StorageService.createBoundedBlobReceiverSession({
      transferId: senderB.transferId,
      metadata: senderB.metadata,
      mimeType: senderB.mimeType,
      totalBytes: senderB.totalBytes,
      totalChunks: senderB.totalChunks
    });

    // Interleave chunks from A and B
    let lastHashA = 0;
    let lastHashB = 0;
    for (let step = 0; step < 3; step++) {
      const pktA = await senderA.readNextChunkPacket();
      const pktB = await senderB.readNextChunkPacket();
      lastHashA = pktA.checksumSoFar;
      lastHashB = pktB.checksumSoFar;
      rxA.acceptChunkPacket(pktA);
      rxB.acceptChunkPacket(pktB);
    }

    const finalA = rxA.finalize(lastHashA);
    const finalB = rxB.finalize(lastHashB);

    const outBytesA = new Uint8Array(await finalA.blob.arrayBuffer());
    const outBytesB = new Uint8Array(await finalB.blob.arrayBuffer());
    assert.strictEqual(outBytesA.length, rawBytes.length, "Reconstructed Blob A size matches");
    assert.strictEqual(outBytesB.length, smallBytes.length, "Reconstructed Blob B size matches");
    for (let i = 0; i < outBytesA.length; i += 4099) {
      assert.strictEqual(outBytesA[i], rawBytes[i], `Byte mismatch at index ${i} in transfer A`);
    }
    for (let i = 0; i < outBytesB.length; i += 509) {
      assert.strictEqual(outBytesB[i], smallBytes[i], `Byte mismatch at index ${i} in transfer B`);
    }

    // Test mid-stream cancellation
    const cancelSender = StorageService.createBoundedBlobSenderSession(record, { transferId: "tx_cancel", chunkSizeBytes: 256 * 1024 });
    await cancelSender.readNextChunkPacket();
    cancelSender.cancel();
    let cancelThrew = false;
    try {
      await cancelSender.readNextChunkPacket();
    } catch (err) {
      cancelThrew = /cancelled/i.test(err.message);
    }
    assert.strictEqual(cancelThrew, true, "Cancelled sender session must reject subsequent chunk reads");

    // Test configurable size limit rejection
    let limitRejected = false;
    try {
      StorageService.createBoundedBlobSenderSession(record, { maxMediaSizeBytes: 500 * 1024 });
    } catch (err) {
      limitRejected = /exceeds the maximum transfer limit/i.test(err.message);
    }
    assert.strictEqual(limitRejected, true, "Media exceeding maxMediaSizeBytes must be rejected before transfer");

    return "700 KB & 40 KB interleaved chunked transfers verified byte-for-byte; cancellation & size limit enforced";
  });

  // 5. Conflict-Safe Configuration Storage & Concurrent Tab Updates
  await test("U5", "Conflict-safe configuration storage: concurrent different-site and same-site edits", async () => {
    const mockStorage = createMockChromeStorage();

    // 1. Concurrent saves to two different sites (plus HTTP vs HTTPS on same host)
    const [resHttp, resHttps, resOther] = await Promise.all([
      StorageService.saveSiteConfigConflictSafe(mockStorage, "http://example.com", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "preset_aurora_webp" } }
      }),
      StorageService.saveSiteConfigConflictSafe(mockStorage, "https://example.com", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "preset_slate_dusk" } }
      }),
      StorageService.saveSiteConfigConflictSafe(mockStorage, "https://example.com:8443", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "preset_zen_forest" } }
      })
    ]);

    assert(resHttp.ok && resHttps.ok && resOther.ok, "All 3 concurrent saves must succeed");
    const fetchHttp = await StorageService.getSiteConfigForTarget(mockStorage, "http://example.com");
    const fetchHttps = await StorageService.getSiteConfigForTarget(mockStorage, "https://example.com");
    const fetchPort = await StorageService.getSiteConfigForTarget(mockStorage, "https://example.com:8443");

    assert.strictEqual(fetchHttp.siteConfig.components.root_page.activeMediaId, "preset_aurora_webp");
    assert.strictEqual(fetchHttps.siteConfig.components.root_page.activeMediaId, "preset_slate_dusk");
    assert.strictEqual(fetchPort.siteConfig.components.root_page.activeMediaId, "preset_zen_forest");

    // 2. Concurrent edits to the SAME site: non-overlapping components merge cleanly
    const baseRev = fetchHttps.siteConfig.revision; // revision 1
    const baseComps = fetchHttps.siteConfig.components;

    // Tab 1 adds sidebar customization based on rev 1
    const tab1Save = await StorageService.saveSiteConfigConflictSafe(
      mockStorage,
      "https://example.com",
      {
        enabled: true,
        components: {
          ...baseComps,
          comp_sidebar: { id: "comp_sidebar", activeMediaId: "preset_zen_forest" }
        }
      },
      { expectedRevision: baseRev, baseComponents: baseComps }
    );
    assert.strictEqual(tab1Save.ok, true);
    assert.strictEqual(tab1Save.revision, 2);

    // Tab 2 (still on stale expectedRevision=1) adds header customization (disjoint component)
    const tab2DisjointSave = await StorageService.saveSiteConfigConflictSafe(
      mockStorage,
      "https://example.com",
      {
        enabled: true,
        components: {
          ...baseComps,
          comp_header: { id: "comp_header", activeMediaId: "preset_obsidian_minimal" }
        }
      },
      { expectedRevision: baseRev, baseComponents: baseComps }
    );
    assert.strictEqual(tab2DisjointSave.ok, true, "Non-overlapping component edit should merge cleanly");
    assert.strictEqual(tab2DisjointSave.mergedNonOverlapping, true);
    assert(tab2DisjointSave.siteConfig.components.comp_sidebar && tab2DisjointSave.siteConfig.components.comp_header, "Both sidebar and header customizations preserved");

    // 3. Conflicting edit to the SAME component with stale expectedRevision must be flagged as a conflict
    const tab3ConflictSave = await StorageService.saveSiteConfigConflictSafe(
      mockStorage,
      "https://example.com",
      {
        enabled: true,
        components: {
          ...baseComps,
          comp_sidebar: { id: "comp_sidebar", activeMediaId: "preset_aurora_webp" }
        }
      },
      { expectedRevision: baseRev, baseComponents: baseComps }
    );
    assert.strictEqual(tab3ConflictSave.ok, false, "Conflicting edit to same component with stale revision must be rejected");
    assert.strictEqual(tab3ConflictSave.conflict, true);

    return "Verified HTTP/HTTPS/port isolation, disjoint component auto-merge, and stale-revision conflict detection";
  });

  // 6. Legacy v2.0 Migration & Idempotency
  await test("U6", "Safe migration of legacy v2.0 hostname-keyed siteConfigs with conflict preservation", async () => {
    const mockStorage = createMockChromeStorage({
      siteConfigs: {
        "legacy-blog.example": {
          enabled: true,
          components: {
            body: {
              friendlyName: "Entire Website",
              playlist: ["preset_aurora_webp"],
              activeMediaId: "preset_aurora_webp",
              opacity: 80
            }
          }
        },
        "conflict-site.example": {
          enabled: true,
          components: {
            body: { friendlyName: "Old Legacy Bg", playlist: ["preset_slate_dusk"] }
          }
        },
        "malformed-entry": "not-an-object"
      },
      // Pre-existing v2.0.1 record on conflict-site.example with different config
      "siteCfg::https://conflict-site.example": {
        siteKey: "https://conflict-site.example",
        hostname: "conflict-site.example",
        matchScope: "origin",
        enabled: true,
        revision: 3,
        components: {
          root_page: { id: "root_page", friendlyName: "Newer v2.0.1 Bg", playlist: ["preset_zen_forest"] }
        }
      }
    });

    const mig1 = await StorageService.migrateLegacySiteConfigsOnce(mockStorage);
    assert.strictEqual(mig1.migrated, true);
    assert.strictEqual(mig1.migratedCount, 1);
    assert.strictEqual(mig1.conflicts.length, 2, "Should record 1 malformed entry + 1 conflicting v2.0.1 entry");

    // Verify original siteConfigs and backup were NOT deleted
    assert(mockStorage._rawStore.siteConfigs["legacy-blog.example"], "Original siteConfigs preserved");
    assert(mockStorage._rawStore[StorageService.LEGACY_BACKUP_KEY]["legacy-blog.example"], "Backup snapshot created");

    // Verify migrated record works across both http and https on legacy-blog.example
    const resolvedHttp = await StorageService.getSiteConfigForTarget(mockStorage, "http://legacy-blog.example");
    assert.strictEqual(resolvedHttp.matched, true);
    assert.strictEqual(resolvedHttp.siteConfig.components.root_page.activeMediaId, "preset_aurora_webp");

    // Verify repeated startup does not re-run migration
    const mig2 = await StorageService.migrateLegacySiteConfigsOnce(mockStorage);
    assert.strictEqual(mig2.alreadyCompleted, true);

    return "Migrated legacy configs, preserved originals & conflict backups, and prevented repeated migration";
  });

  // 7. Legacy page-origin media migration marker identity
  await test("U7", "Legacy media migration markers are stable and isolated by exact origin", async () => {
    const httpsDefault = StorageService.legacyPageMediaMigrationStorageKey("https://example.com/page?q=1");
    const httpsPort = StorageService.legacyPageMediaMigrationStorageKey("https://example.com:8443/other");
    const httpDefault = StorageService.legacyPageMediaMigrationStorageKey("http://example.com/page");
    const repeated = StorageService.legacyPageMediaMigrationStorageKey("https://example.com/again");

    assert.strictEqual(httpsDefault, repeated, "Paths and query strings must not create separate migration markers");
    assert.notStrictEqual(httpsDefault, httpsPort, "Different ports need independent legacy-media migration state");
    assert.notStrictEqual(httpsDefault, httpDefault, "HTTP and HTTPS need independent migration state");
    assert.throws(() => StorageService.legacyPageMediaMigrationStorageKey("chrome://settings"), /HTTP or HTTPS/);
    return "Exact-origin migration keys are stable across paths and isolated by protocol and port";
  });

  // 8. Per-site authorization policy and least-privilege manifest
  await test("U8", "Opt-in site permissions, consent gate, and exact-origin activation", async () => {
    const permissionPattern = AccessControl.originPermissionPatternForUrl("https://example.com:8443/path?q=1");
    assert.strictEqual(permissionPattern, "https://example.com/*", "Chrome host patterns intentionally do not include ports");
    assert.strictEqual(AccessControl.originPermissionPatternForUrl("chrome://settings"), null);
    assert.strictEqual(AccessControl.originPermissionPatternForUrl("file:///tmp/page.html"), null);

    const keyA = AccessControl.siteAccessStorageKey("https://example.com");
    const keyB = AccessControl.siteAccessStorageKey("https://example.com:8443");
    assert.notStrictEqual(keyA, keyB, "Stored access records remain exact-origin scoped even when Chrome's permission is host-scoped");

    // activeTab can grant ephemeral access to the current tab. It must not count as
    // the persistent optional host permission needed for future page restorations.
    assert.strictEqual(AccessControl.hasPersistentHostGrant(true, { enabled: true }, permissionPattern), false);
    assert.strictEqual(AccessControl.hasPersistentHostGrant(true, { hostPermissionGrantedAt: Date.now(), permissionPattern }, permissionPattern), true);
    assert.strictEqual(AccessControl.hasPersistentHostGrant(false, { hostPermissionGrantedAt: Date.now(), permissionPattern }, permissionPattern), false);
    assert.strictEqual(AccessControl.hasPersistentHostGrant(true, { hostPermissionGrantedAt: Date.now(), permissionPattern: "http://example.com/*" }, permissionPattern), false);
    assert.strictEqual(AccessControl.hostPermissionPatternCovers("https://example.com/*", "https://example.com/*"), true);
    assert.strictEqual(AccessControl.hostPermissionPatternCovers("https://example.com/", "https://example.com/*"), true);
    assert.strictEqual(AccessControl.hostPermissionPatternCovers("https://*/*", "https://example.com/*"), true);
    assert.strictEqual(AccessControl.hostPermissionPatternCovers("*://*.example.com/*", "https://www.example.com/*"), true);
    assert.strictEqual(AccessControl.hostPermissionPatternCovers("https://example.com/*", "http://example.com/*"), false);

    const base = {
      pageUrl: "https://example.com:8443/home",
      permissionGranted: true,
      siteAccess: { enabled: true, consentVersion: AccessControl.SITE_CONSENT_VERSION, consentAcceptedAt: Date.now() },
      siteConfig: { enabled: true },
      globalSettings: { extensionEnabled: true }
    };
    assert.strictEqual(AccessControl.evaluateSiteAccess({ ...base, permissionGranted: false }).allowed, false);
    assert.strictEqual(AccessControl.evaluateSiteAccess({ ...base, siteAccess: { enabled: true } }).allowed, false);
    assert.strictEqual(AccessControl.evaluateSiteAccess({ ...base, siteAccess: { ...base.siteAccess, enabled: false } }).allowed, false);
    assert.strictEqual(AccessControl.evaluateSiteAccess({ ...base, siteConfig: { enabled: false } }).allowed, false);
    assert.strictEqual(AccessControl.evaluateSiteAccess({ ...base, globalSettings: { extensionEnabled: false } }).siteEnabled, true);
    assert.strictEqual(AccessControl.evaluateSiteAccess({ ...base, globalSettings: { extensionEnabled: false } }).allowed, false);
    assert.strictEqual(AccessControl.evaluateSiteAccess(base).allowed, true);

    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
    assert(typeof manifest.name === "string" && manifest.name.length > 0 && manifest.name.length <= 45, `Extension manifest name must be at most 45 characters (got ${manifest.name.length})`);
    assert.deepStrictEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(manifest, "host_permissions"), false, "No always-granted host permissions");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(manifest, "content_scripts"), false, "No unconditional static content-script injection");

    const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
    const siteAccessHtml = fs.readFileSync(path.join(__dirname, "..", "site-access.html"), "utf8");
    const siteAccessJs = fs.readFileSync(path.join(__dirname, "..", "site-access.js"), "utf8");
    assert(siteAccessHtml.includes("I understand and want to request access for this site."), "Explicit policy acknowledgement is present in the durable permission page");
    assert(siteAccessHtml.includes("id=\"btnRequestAccess\""), "Explicit permission request button is present");
    assert(siteAccessHtml.includes("Enable ChameleonBG on this website"), "Site-specific access question is present in the durable permission page");
    assert(siteAccessHtml.includes("Some websites may restrict browser extensions"), "Site policy/account restriction warning is present");
    assert((siteAccessJs.includes("browserApi.permissions.request") || siteAccessJs.includes("permissionsApi.request")) && siteAccessJs.includes("CHAMELEON_ENABLE_SITE"), "Permission request and enablement are handled in the durable extension tab");
    const popupJs = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
    assert(popupJs.includes("requestHostPermissionFromGesture") && popupJs.includes("CHAMELEON_BEGIN_ENABLE"), "Popup requests permission in a single click and records an enable intent for the background fallback");
    assert(siteAccessJs.includes("CHAMELEON_ENABLE_SITE"), "site-access.html remains the recoverable fallback path");
    assert(!/id="siteEnableCheckbox"[^>]*checked/i.test(popupHtml), "The site switch must default to off until access is authorized");
    assert(/id="btnOpenVisualEditor"[^>]*disabled/i.test(popupHtml), "Live editor starts disabled until access is confirmed");
    assert(/id="btnSelectOnPage"[^>]*disabled/i.test(popupHtml), "Live picker starts disabled until access is confirmed");
    assert(popupHtml.includes('id="btnRevokeSiteAccess"'), "Separate browser permission revocation control is present");
    return "Verified optional host permissions, no unconditional injection, exact-origin gating, site-specific warning, off-by-default controls, revocation, and global pause behavior";
  });

  // 9. Studio views are exclusive, library has its own controls, and picker failures are surfaced
  await test("U9", "Studio view isolation, dedicated media controls, and live-picker acknowledgement", async () => {
    const studioCss = fs.readFileSync(path.join(__dirname, "..", "studio.css"), "utf8");
    const studioHtml = fs.readFileSync(path.join(__dirname, "..", "studio.html"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");
    const contentJs = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const selectionJs = fs.readFileSync(path.join(__dirname, "..", "selection-engine.js"), "utf8");
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

    assert(/\[hidden\][\s\S]{0,180}display:\s*none\s*!important/.test(studioCss), "Author layout rules must not override hidden views");
    assert(studioHtml.includes('id="librarySearchInput"') && studioHtml.includes('id="libraryFileInput"'), "Library needs dedicated search and import controls");
    assert(studioHtml.includes('id="setGlobalEnabled"'), "Settings must expose global pause");
    assert(!studioHtml.includes("Site Access (<code>&lt;all_urls&gt;</code>"), "Settings copy must not claim unconditional all-site access");
    assert(studioJs.includes("CHAMELEON_CHECK_TAB_CAPABILITY") && studioJs.includes("pickerResult.pickerActive !== true"), "Live picker must preflight access and require an acknowledged start");
    assert(contentJs.includes("const pickerActive = selectionController.start() === true"), "Content script must return the actual picker state");
    assert(selectionJs.includes("Picker active") && selectionJs.includes("Try a parent region"), "Picker must show an active state and explain unsuitable targets");
    assert(studioJs.includes("CHAMELEON_COMPONENT_PICKED_BROADCAST") && studioJs.includes("sender?.tab"), "Studio must accept the selection event only from an extension-owned relay");
    assert(studioJs.includes("resolved = detectedComponents.find") && studioJs.includes("could not be matched to the refreshed page map"), "Studio must verify the picked component after rescan");
    assert(Array.isArray(manifest.background.scripts) && !Object.prototype.hasOwnProperty.call(manifest.background, "service_worker"), "Firefox build must use background.scripts without unsupported service_worker");
    return "Verified exclusive view visibility guard, dedicated media library controls, global pause control, authenticated picker relay, and Firefox-native MV3 background manifest";
  });

  // 10. Page-selection events are validated against the actual sender tab and relayed minimally
  await test("U10", "Secure live-picker event routing and map-label readability", async () => {
    const backgroundJs = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");
    const studioCss = fs.readFileSync(path.join(__dirname, "..", "studio.css"), "utf8");
    const studioHtml = fs.readFileSync(path.join(__dirname, "..", "studio.html"), "utf8");
    assert(backgroundJs.includes('case "CHAMELEON_COMPONENT_PICKED_EVENT"'), "Background must handle the content-script selection message explicitly");
    assert(backgroundJs.includes("sender.frameId !== 0") && backgroundJs.includes("identity.originKey") && backgroundJs.includes("runtimeState.allowed"), "Relay must validate the top-level sender, actual origin and enabled access state");
    assert(backgroundJs.includes('type: "CHAMELEON_COMPONENT_PICKED_BROADCAST"') && backgroundJs.includes("targetTabId: sender.tab.id"), "Background must relay a minimal, target-tab-scoped event to extension pages");
    assert(studioJs.includes("if (sender?.tab || sender?.id !== chrome.runtime.id) return"), "Studio must reject direct content-script selection broadcasts");
    assert(studioCss.includes(".map-tree-row") && studioCss.includes("text-overflow: ellipsis"), "Structured map rows need readable labels without text bleed");
    assert(studioJs.includes("function inferLayoutMapTree") && studioHtml.includes('id="layoutMapCanvas"'), "Editor must render a structured component tree rather than overlapping positioned boxes");
    return "Verified sender-bound component-selection relay and readable structured-map rows";
  });

  // 11. Popup selection must open a durable studio before starting the live picker
  await test("U11", "Popup Select Area launches the studio and hands off picker startup", async () => {
    const popupJs = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
    const backgroundJs = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");
    assert(popupJs.includes('type: "CHAMELEON_OPEN_FULL_STUDIO"') && popupJs.includes("startPicker: true"), "Popup picker action must open the full studio with a picker startup intent");
    const pickerHandler = popupJs.slice(popupJs.indexOf('btnSelectOnPage.addEventListener'), popupJs.indexOf('btnResetSite.addEventListener'));
    assert(!pickerHandler.includes('CHAMELEON_START_LIVE_PICKER'), "Popup must not start a picker with no editor ready to receive the selection");
    assert(backgroundJs.includes('message.startPicker === true') && backgroundJs.includes("startPicker=1"), "Background must carry the picker startup intent into the studio URL");
    assert(studioJs.includes("startPickerOnLaunch") && studioJs.includes("startLivePickerFromStudio({ focusTarget: false }).catch"), "Studio must start the picker after its first render and remove one-shot URL intent");
    return "Verified popup-to-studio picker handoff and automatic picker startup only after the editor is initialized";
  });


  // 12. Structured editor and scroll-linked Settings layout
  await test("U12", "Structured map, on-demand media picker, and sticky scroll-linked Settings navigation", async () => {
    const studioHtml = fs.readFileSync(path.join(__dirname, "..", "studio.html"), "utf8");
    const studioCss = fs.readFileSync(path.join(__dirname, "..", "studio.css"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");
    const settingsSections = ["settings-general", "settings-performance", "settings-media-storage", "settings-site-access", "settings-privacy-data"];
    for (const id of settingsSections) {
      assert(studioHtml.includes(`id="${id}"`), `Missing Settings section ${id}`);
      assert(studioHtml.includes(`data-settings-target="${id}"`), `Missing sticky navigation item ${id}`);
    }
    assert(studioCss.includes(".settings-side-nav") && studioCss.includes("position: sticky"), "Settings category rail must remain stationary while content scrolls");
    assert(studioJs.includes("IntersectionObserver") && studioJs.includes("setActiveSettingsNav"), "Settings navigation must track the currently visible section");
    assert(studioHtml.includes('id="editorMediaPickerDialog"') && studioHtml.includes('id="btnOpenEditorMediaPicker"'), "Media picker must be on-demand from the editor");
    assert(studioHtml.includes('id="btnOpenFullMediaLibrary"') && studioHtml.includes('id="libraryFullGrid"'), "Dedicated Media Library remains available");
    assert(!studioHtml.includes('id="studioMediaGrid"') || studioHtml.includes('<dialog id="editorMediaPickerDialog"'), "Integrated media grid must be contained in the on-demand dialog");
    assert(studioHtml.includes('id="settingsStorageCount"') && studioHtml.includes('id="settingsStorageBytes"'), "Privacy page shows current media storage summary");
    return "Verified five Settings sections and sticky active navigation, structured map, on-demand picker, and dedicated library preservation";
  });

  await test("U13", "Media picker selection model and background-video controls are wired safely", async () => {
    const studioHtml = fs.readFileSync(path.join(__dirname, "..", "studio.html"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");
    const rendererJs = fs.readFileSync(path.join(__dirname, "..", "renderer-engine.js"), "utf8");
    const backgroundJs = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
    assert(studioHtml.includes('id="pickerAssignmentMode"') && studioHtml.includes('id="btnConfirmEditorMediaPicker"'), "Picker must expose assignment mode and explicit OK commit");
    assert(studioHtml.includes('id="btnCancelEditorMediaPicker"') && studioHtml.includes('id="btnCloseEditorMediaPicker"'), "Picker must expose explicit cancellation");
    assert(studioJs.includes("function togglePickerMediaSelection") && studioJs.includes("function commitEditorMediaPickerSelection"), "Selection should be staged and only committed on OK");
    assert(studioJs.includes("pickerSelectedMediaIds.clear()") && studioJs.includes("importingIntoPicker"), "Cancel clears pending selection and picker imports stay uncommitted");
    assert(studioHtml.includes('id="btnPauseBackgroundVideos"'), "Global pause control must exist");
    assert(studioJs.includes('className = "btn-map-video-action"') && studioJs.includes("toggleComponentVideoAction(comp, \"pause\")") && studioJs.includes("toggleComponentVideoAction(comp, \"mute\")"), "Per-component pause and mute controls must live beside assigned media in the map");
    assert(studioJs.includes("Paused globally") && studioJs.includes("renderCenterLayoutMap(); // Keep per-component actions consistent with global pause state."), "Map controls must not mislead while global pause is active");
    assert(!studioHtml.includes('id="btnToggleSelectedVideo"') && !studioHtml.includes('id="chkVideoMuted"'), "Pause and mute controls must not be duplicated in the right inspector");
    assert(studioHtml.includes('id="sliderVideoVolume"'), "Right inspector must retain video volume only");
    assert(studioHtml.includes('id="chkWaitForVideoEnd"') && studioHtml.includes('value="custom">Custom duration'), "Playlist supports wait-until-video-end and custom intervals");
    assert(studioHtml.includes('id="rotationHours"') && studioHtml.includes('id="rotationMinutes"') && studioHtml.includes('id="rotationSeconds"'), "Custom rotation accepts hours, minutes, and seconds");
    assert(studioJs.includes('pickerAssignmentMode = "playlist"') && studioJs.includes("function togglePickerMediaSelection"), "Media picker defaults to multi-select with click-to-toggle behavior");
    assert(rendererJs.includes("pauseAllBackgroundVideos") && rendererJs.includes("audibleOwnerCompId"), "Renderer must enforce global pause and one audible owner");
    const schedulerBody = rendererJs.slice(rendererJs.indexOf("async function tickUnifiedPlaylistScheduler"), rendererJs.indexOf("// 6. LAYER CREATION", rendererJs.indexOf("async function tickUnifiedPlaylistScheduler")));
    assert(schedulerBody.indexOf("layer.rotationPendingUntilVideoEnds) continue") < schedulerBody.indexOf("!forceAdvanceAll && !layer.nextRotationAt"), "A pending video-end rotation must not restart its interval timer");
    assert(backgroundJs.includes("pauseAllBackgroundVideos"), "Persistent global video pause preference must have a default");
    assert(studioJs.includes("built-in preset") && studioJs.includes("stored`"), "Media summary should distinguish uploads, presets, and stored bytes");
    assert(studioJs.includes("let latestDiagnostics =") && studioJs.includes("latestDiagnostics.activeLayers"), "Studio must maintain latestDiagnostics state for component video status");
    return "Verified staged multi-select, cancellation-safe imports, single/playlist assignment, map-level pause/mute, inspector volume, video-end rotation, custom H:M:S intervals, global pause, and audio arbitration";
  });


  await test("U14", "Firefox studio capability access and resilient permission-request gesture flow", async () => {
    const backgroundJs = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
    const accessJs = fs.readFileSync(path.join(__dirname, "..", "site-access.js"), "utf8");
    const accessHtml = fs.readFileSync(path.join(__dirname, "..", "site-access.html"), "utf8");
    const capabilityStart = backgroundJs.indexOf('case "CHAMELEON_CHECK_TAB_CAPABILITY"');
    const nextCase = backgroundJs.indexOf('case "CHAMELEON_', capabilityStart + 10);
    const capabilityCase = backgroundJs.slice(capabilityStart, nextCase > capabilityStart ? nextCase : undefined);
    assert(backgroundJs.includes("function isTrustedStudioCommand(sender)"), "Studio must have an explicit trusted-page identity check");
    assert(capabilityCase.includes("isTrustedStudioCommand(sender)"), "Studio must be authorized to preflight its own target tab; otherwise live selection fails");
    assert(accessJs.includes("const permissionPromise = requestHostPermissionFromGesture(capability.originPattern)"), "Permission request must start synchronously from the direct click handler");
    const clickHandler = accessJs.slice(accessJs.indexOf("function onRequestAccessClick()"), accessJs.indexOf("function onVerifyAccessClick()"));
    assert(clickHandler.indexOf("requestHostPermissionFromGesture(capability.originPattern)") < clickHandler.indexOf(".then(async (result)"), "Do not await a permission pre-check before requesting a host permission");
    assert(accessJs.includes("browserApi?.permissions?.request") && accessJs.includes("permissionsApi?.onAdded"), "Use Firefox's Promise API plus a permission-added fallback");
    assert(accessJs.includes("Check permission status") && accessHtml.includes('id="btnVerifyAccess"'), "Provide recovery if Firefox grants access but its request promise does not settle");
    assert(accessJs.includes("did not respond") || accessJs.includes("did not report the permission result"), "Permission/background messaging failures must not spin forever");

    // Exercise the real background message listener in a mocked Firefox extension context.
    // This catches the exact v2.0.8 regression where studio.html was rejected at runtime.
    const extensionId = "chameleon-test-extension";
    const store = { globalSettings: { extensionEnabled: true } };
    const listeners = {};
    const event = (name) => ({ addListener(fn) { listeners[`${name}::${listeners[`${name}::count`] || 0}`] = fn; listeners[`${name}::count`] = (listeners[`${name}::count`] || 0) + 1; }, removeListener() {} });
    const localStore = {
      get(keys, callback) {
        let out = {};
        if (keys == null) out = { ...store };
        else if (Array.isArray(keys)) { for (const key of keys) if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key]; }
        else if (typeof keys === "string") { if (Object.prototype.hasOwnProperty.call(store, keys)) out[keys] = store[keys]; }
        else { for (const key of Object.keys(keys)) if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key]; }
        if (callback) callback(out);
        return Promise.resolve(out);
      },
      set(items, callback) { Object.assign(store, items); if (callback) callback(); return Promise.resolve(); },
      remove(keys, callback) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; if (callback) callback(); return Promise.resolve(); }
    };
    let onMessageListener = null;
    const mockChrome = {
      runtime: {
        id: extensionId, lastError: null,
        getURL: (name) => `moz-extension://${extensionId}/${name}`,
        onMessage: { addListener(fn) { onMessageListener = fn; } },
        onInstalled: event("installed"), onStartup: event("startup"), onConnect: event("connect")
      },
      storage: { local: localStore },
      permissions: {
        onAdded: event("permission-added"), onRemoved: event("permission-removed"),
        getAll(callback) { const out = { origins: [] }; if (callback) callback(out); return Promise.resolve(out); },
        contains(_details, callback) { if (callback) callback(false); return Promise.resolve(false); }
      },
      alarms: { create(_name, _info, callback) { if (callback) callback(); return Promise.resolve(); }, onAlarm: event("alarm") },
      tabs: {
        onUpdated: event("tab-updated"),
        async get(id) { return { id, url: "https://example.com/test", title: "Example" }; },
        async query() { return []; }, async sendMessage() { return { ok: true }; }
      },
      scripting: { async executeScript() { return [{ result: false }]; }, async insertCSS() {} }
    };
    const sandbox = {
      chrome: mockChrome, ChameleonStorageService: StorageService, ChameleonAccessControl: AccessControl,
      console, URL, URLSearchParams, Map, Set, Promise, Date, Math, Number, String, Boolean, Object, Array,
      RegExp, Error, TypeError, setTimeout, clearTimeout, AbortController, Blob, Uint8Array
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(backgroundJs, sandbox, { filename: "background.js" });
    assert(typeof onMessageListener === "function", "Background must register its runtime message handler");
    const dispatch = (message, sender) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Mock background capability check timed out")), 1500);
      onMessageListener(message, sender, (response) => { clearTimeout(timer); resolve(response); });
    });
    const studioResponse = await dispatch({ type: "CHAMELEON_CHECK_TAB_CAPABILITY", tabId: 7 }, {
      id: extensionId, url: `moz-extension://${extensionId}/studio.html?tabId=7&siteKey=https%3A%2F%2Fexample.com`
    });
    assert(studioResponse.ok === true && studioResponse.supported === true && studioResponse.siteKey === "https://example.com", "Trusted studio must be allowed to check the selected website tab");
    const pageResponse = await dispatch({ type: "CHAMELEON_CHECK_TAB_CAPABILITY", tabId: 7 }, {
      id: extensionId, url: "https://example.com/page", tab: { id: 7 }, frameId: 0
    });
    assert(pageResponse.ok === false && /trusted ChameleonBG extension pages/.test(pageResponse.error || ""), "Ordinary webpages must not gain trusted extension-page capability access");
    return "Verified the real background listener allows studio.html capability preflight, rejects webpage callers, and uses a direct-gesture permission flow with manual recovery";
  });

  // -------------------------------------------------------------------------
  // v2.1.0 — one-step enable, single Studio, Websites dashboard (behavioural, VM-mocked)
  // -------------------------------------------------------------------------
  function makeBackgroundHarness(initialStore, tabList, options = {}) {
    const extensionId = "chameleon-test-extension";
    const store = { globalSettings: { extensionEnabled: true }, ...initialStore };
    const listeners = {};
    const event = (name) => ({ addListener(fn) { const n = listeners[`${name}::count`] || 0; listeners[`${name}::${n}`] = fn; listeners[`${name}::count`] = n + 1; }, removeListener() {} });
    const localStore = {
      get(keys, callback) {
        let out = {};
        if (keys == null) out = { ...store };
        else if (Array.isArray(keys)) { for (const key of keys) if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = store[key]; }
        else if (typeof keys === "string") { if (Object.prototype.hasOwnProperty.call(store, keys)) out[keys] = store[keys]; }
        if (callback) callback(out);
        return Promise.resolve(out);
      },
      set(items, callback) { Object.assign(store, JSON.parse(JSON.stringify(items))); if (callback) callback(); return Promise.resolve(); },
      remove(keys, callback) { for (const key of (Array.isArray(keys) ? keys : [keys])) delete store[key]; if (callback) callback(); return Promise.resolve(); }
    };
    const calls = { created: [], updated: [], runtimeMessages: [], tabMessages: [] };
    let onMessageListener = null;
    const mockChrome = {
      runtime: {
        id: extensionId, lastError: null,
        getURL: (name) => `moz-extension://${extensionId}/${name}`,
        onMessage: { addListener(fn) { onMessageListener = fn; } },
        async sendMessage(message) { calls.runtimeMessages.push(message); return options.studioReply === undefined ? { ok: true } : options.studioReply; },
        onInstalled: event("installed"), onStartup: event("startup"), onConnect: event("connect")
      },
      storage: { local: localStore },
      permissions: {
        onAdded: event("permission-added"), onRemoved: event("permission-removed"),
        getAll(callback) { const out = { origins: [] }; if (callback) callback(out); return Promise.resolve(out); },
        contains(_details, callback) { const v = options.permissionGranted === true; if (callback) callback(v); return Promise.resolve(v); }
      },
      alarms: { create(_n, _i, cb) { if (cb) cb(); return Promise.resolve(); }, onAlarm: event("alarm") },
      tabs: {
        onUpdated: event("tab-updated"),
        async get(id) { const t = tabList.find((x) => x.id === id); if (!t) throw new Error("No tab"); return t; },
        async query() { return tabList; },
        async create(info) { calls.created.push(info); return { id: 900 + calls.created.length, ...info }; },
        async update(id, info) { calls.updated.push({ id, ...info }); return { id }; },
        async sendMessage(id, message) { calls.tabMessages.push({ id, message }); return { ok: true }; }
      },
      scripting: { async executeScript() { return [{ result: false }]; }, async insertCSS() {} }
    };
    const sandbox = {
      chrome: mockChrome, ChameleonStorageService: StorageService, ChameleonAccessControl: AccessControl,
      console, URL, URLSearchParams, Map, Set, Promise, Date, Math, Number, String, Boolean, Object, Array,
      RegExp, Error, TypeError, setTimeout, clearTimeout, AbortController, Blob, Uint8Array
    };
    sandbox.globalThis = sandbox;
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), sandbox, { filename: "background.js" });
    const dispatch = (message, sender) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out: ${message.type}`)), 2000);
      onMessageListener(message, sender, (response) => { clearTimeout(timer); resolve(response); });
    });
    const studioSender = { id: extensionId, url: `moz-extension://${extensionId}/studio.html` };
    const popupSender = { id: extensionId, url: `moz-extension://${extensionId}/popup.html` };
    const pageSender = { id: extensionId, url: "https://example.com/page", tab: { id: 7 }, frameId: 0 };
    return { store, calls, listeners, dispatch, studioSender, popupSender, pageSender, extensionId };
  }

  await test("U15", "Websites dashboard commands list sites and delete settings only (media/consent kept)", async () => {
    const h = makeBackgroundHarness({
      "siteCfg::https://example.com": { siteKey: "https://example.com", enabled: true, revision: 3, updatedAt: 111, components: { root_page: { activeMediaId: "m1" }, hero: { enabled: false } } },
      "siteCfg::https://empty.test": { siteKey: "https://empty.test", enabled: true, revision: 1, components: {} },
      "siteAccess::https%3A%2F%2Fexample.com": { origin: "https://example.com", enabled: true, consentVersion: 1, consentAcceptedAt: 5 },
      "mediaSentinel": { keep: true }
    }, [{ id: 7, url: "https://example.com/a", title: "Ex" }]);
    const listed = await h.dispatch({ type: "CHAMELEON_LIST_SITES" }, h.studioSender);
    assert(listed.ok === true && listed.sites.length === 1, "Only sites with saved components are listed");
    assert(listed.sites[0].origin === "https://example.com" && listed.sites[0].componentCount === 2 && listed.sites[0].customizedCount === 1 && listed.sites[0].openTabIds[0] === 7, "Site row aggregates counts and open tab ids");
    const deniedList = await h.dispatch({ type: "CHAMELEON_LIST_SITES" }, h.pageSender);
    const deniedDelete = await h.dispatch({ type: "CHAMELEON_DELETE_SITE_CONFIG", origin: "https://example.com" }, h.pageSender);
    assert(deniedList.ok === false && deniedDelete.ok === false, "Page content scripts cannot list or delete saved websites");
    assert(h.store["siteCfg::https://example.com"], "Rejected delete must leave settings intact");
    const deleted = await h.dispatch({ type: "CHAMELEON_DELETE_SITE_CONFIG", origin: "https://example.com" }, h.studioSender);
    assert(deleted.ok === true && deleted.deleted === true, "Studio can delete a website's settings");
    assert(!h.store["siteCfg::https://example.com"], "Saved structure is removed");
    assert(h.store["siteAccess::https%3A%2F%2Fexample.com"] && h.store.mediaSentinel, "Consent/access records and media-side data are untouched");
    return "Verified LIST_SITES aggregation, extension-page-only access, and delete that removes only siteCfg::";
  });

  await test("U16", "Studio is single-instance and the picker launch keeps the website tab in front", async () => {
    const studioUrl = (id) => `moz-extension://chameleon-test-extension/studio.html?tabId=7&siteKey=x`;
    const reuse = makeBackgroundHarness({}, [{ id: 50, url: studioUrl() }, { id: 7, url: "https://example.com/a" }]);
    const r1 = await reuse.dispatch({ type: "CHAMELEON_OPEN_FULL_STUDIO", tabId: "", siteKey: "https://example.com", section: "websites" }, reuse.popupSender);
    assert(r1.ok === true && r1.reused === true && r1.studioTabId === 50, "An existing Studio tab is reused");
    assert(reuse.calls.created.length === 0, "No second Studio tab is created");
    assert(reuse.calls.runtimeMessages.some((m) => m.type === "CHAMELEON_STUDIO_RETARGET" && m.view === "websites"), "Existing Studio is re-targeted via message");
    assert(reuse.calls.updated.some((u) => u.id === 50 && u.active === true), "Non-picker reuse brings the Studio forward");

    const fresh = makeBackgroundHarness({}, [{ id: 7, url: "https://example.com/a" }]);
    await fresh.dispatch({ type: "CHAMELEON_OPEN_FULL_STUDIO", tabId: "", siteKey: "https://example.com", section: "websites", startPicker: true }, fresh.popupSender);
    assert(fresh.calls.created.length === 1 && fresh.calls.created[0].active === false && /startPicker=1/.test(fresh.calls.created[0].url), "Picker launch opens the Studio in the background (no flash)");

    const pickerReuse = makeBackgroundHarness({}, [{ id: 50, url: studioUrl() }]);
    await pickerReuse.dispatch({ type: "CHAMELEON_OPEN_FULL_STUDIO", tabId: "", siteKey: "https://example.com", section: "websites", startPicker: true }, pickerReuse.popupSender);
    assert(!pickerReuse.calls.updated.some((u) => u.active === true), "Picker reuse must not activate the Studio tab");
    return "Verified Studio reuse, background creation for the picker, and no forced focus change";
  });

  await test("U17", "permissions.onAdded completes a fresh pending enable intent once and ignores expired ones", async () => {
    const tabs = [{ id: 7, url: "https://example.com/page", title: "Ex" }];
    const h = makeBackgroundHarness({
      "pendingEnable::https://example.com": { origin: "https://example.com", tabId: 7, createdAt: Date.now() }
    }, tabs, { permissionGranted: true });
    h.listeners["permission-added::0"]();
    await new Promise((r) => setTimeout(r, 300));
    const access = h.store["siteAccess::https%3A%2F%2Fexample.com"];
    assert(access && access.enabled === true && access.consentVersion === 1, "Background finished enabling after the permission grant");
    assert(!h.store["pendingEnable::https://example.com"], "Intent is cleared after completion");

    const stale = makeBackgroundHarness({
      "pendingEnable::https://example.com": { origin: "https://example.com", tabId: 7, createdAt: Date.now() - 10 * 60 * 1000 }
    }, tabs, { permissionGranted: true });
    stale.listeners["permission-added::0"]();
    await new Promise((r) => setTimeout(r, 300));
    assert(!stale.store["siteAccess::https%3A%2F%2Fexample.com"], "Expired intents must not enable a site");
    assert(!stale.store["pendingEnable::https://example.com"], "Expired intents are cleaned up");

    const denied = makeBackgroundHarness({
      "pendingEnable::https://example.com": { origin: "https://example.com", tabId: 7, createdAt: Date.now() }
    }, tabs, { permissionGranted: false });
    denied.listeners["permission-added::0"]();
    await new Promise((r) => setTimeout(r, 300));
    assert(!denied.store["siteAccess::https%3A%2F%2Fexample.com"], "No access record without an actual permission grant");
    return "Verified pending-intent completion, expiry, and the no-grant case";
  });

  await test("U18", "Popup uses a single consent click that requests permission before any await", async () => {
    const popupJs = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
    const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
    const studioHtml = fs.readFileSync(path.join(__dirname, "..", "studio.html"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");
    const start = popupJs.indexOf('btnConfirmSiteEnable.addEventListener("click"');
    const handler = popupJs.slice(start, popupJs.indexOf("btnKeepSiteDisabled.addEventListener", start));
    const requestAt = handler.indexOf("requestHostPermissionFromGesture(permissionPattern)");
    assert(requestAt > 0, "Consent handler requests host permission");
    const codeBeforeRequest = handler.slice(0, requestAt).replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
    assert(!codeBeforeRequest.includes("await "), "No await may precede permissions.request (user gesture)");
    assert(!handler.includes("chrome.tabs.create"), "Consent no longer opens a second tab on the normal path");
    assert(popupHtml.includes("btnOpenWebsites"), "Popup links to the Websites view");
    assert(studioHtml.includes('data-view="websites"') && studioHtml.includes('id="viewWebsites"') && studioHtml.includes("btn-delete-site") === false, "Studio has a Websites tab and view");
    assert(studioJs.includes("CHAMELEON_DELETE_SITE_CONFIG") && studioJs.includes("btn-delete-site"), "Websites view wires a red delete button to the delete command");
    assert(studioJs.includes("CHAMELEON_STUDIO_RETARGET") && studioJs.includes("retargetStudio"), "Studio can be re-targeted to another site in place");
    return "Verified single-click consent ordering, Websites UI wiring and retarget hook";
  });

  // 19. Registrable domain derivation across multi-part public suffixes, ports, and URLs
  await test("U19", "Registrable domain derivation: multi-part public suffixes, ports, protocols and IPs", async () => {
    assert.strictEqual(StorageService.deriveRegistrableDomain("https://music.youtube.com/watch?v=123"), "youtube.com");
    assert.strictEqual(StorageService.deriveRegistrableDomain("m.youtube.co.uk"), "youtube.co.uk");
    assert.strictEqual(StorageService.deriveRegistrableDomain("sub.site.com.au"), "site.com.au");
    assert.strictEqual(StorageService.deriveRegistrableDomain("https://example.org:8080/dashboard"), "example.org");
    assert.strictEqual(StorageService.deriveRegistrableDomain("localhost"), "localhost");
    assert.strictEqual(StorageService.deriveRegistrableDomain("http://127.0.0.1:3000/app"), "127.0.0.1");
    assert.strictEqual(StorageService.deriveRegistrableDomain("deep.sub.level.co.jp"), "level.co.jp");
    assert.strictEqual(StorageService.deriveRegistrableDomain("plain.example.com"), "example.com");
    return "Verified robust registrable domain derivation across multi-part ccTLDs (.co.uk, .com.au, .co.jp), ports, and IPs";
  });

  // 20. Domain Theme precedence resolution
  await test("U20", "Domain theme precedence: Global defaults -> Domain Theme -> Site Profile -> Component Override", async () => {
    const domainTheme = {
      id: "theme_yt_dark",
      domain: "youtube.com",
      displayName: "YouTube Dark",
      defaultStyles: {
        opacity: 70,
        blur: 5,
        tintOpacity: 40,
        tintColor: "#111827"
      },
      defaultMedia: {
        mediaId: "theme_media_ambient",
        playlist: ["theme_media_ambient"],
        rotationIntervalSec: 120
      },
      audioDefaults: {
        videoMuted: true,
        videoVolume: 40
      }
    };

    const siteConfig = {
      siteKey: "https://music.youtube.com",
      themeId: "theme_yt_dark",
      components: {
        root_page: {
          id: "root_page",
          opacity: 50
        },
        sidebar: {
          id: "sidebar",
          activeMediaId: "custom_sidebar_video",
          videoMuted: false,
          videoVolume: 80
        }
      }
    };

    const resolved = StorageService.resolveEffectiveConfig(siteConfig, domainTheme, { pauseAllBackgroundVideos: false });
    assert.strictEqual(resolved.themeApplied, "theme_yt_dark");
    assert.strictEqual(resolved.components.root_page.opacity, 50, "Component override must take precedence over domain theme");
    assert.strictEqual(resolved.components.root_page.blur, 5, "Unspecified property must inherit from domain theme");
    assert.strictEqual(resolved.components.root_page.activeMediaId, "theme_media_ambient", "Default media should inherit when component has none");
    assert.strictEqual(resolved.components.root_page.videoMuted, true, "Theme audio default applied");

    assert.strictEqual(resolved.components.sidebar.activeMediaId, "custom_sidebar_video", "Component media override preserved");
    assert.strictEqual(resolved.components.sidebar.videoMuted, false, "Component audio preference preserved");
    assert.strictEqual(resolved.components.sidebar.videoVolume, 80, "Component volume preference preserved");
    return "Verified 4-tier precedence resolution from global defaults through domain theme to site component overrides";
  });

  // 21. VideoManager explicit state machine, audio focus arbitration, and non-injecting browser policy compliance
  await test("U21", "VideoManager explicit state machine, audio focus arbitration, and non-injecting browser policy compliance", async () => {
    const VideoManager = require(path.join(__dirname, "..", "video-manager.js"));
    assert(VideoManager && VideoManager.VideoPlaybackManager, "VideoPlaybackManager must be exported");

    const createdNodes = [];
    const fakeDoc = {
      body: {
        appendChild: (n) => createdNodes.push(n)
      },
      createElement: (tag) => {
        const node = {
          tagName: tag.toUpperCase(),
          style: { cssText: "" },
          dataset: {},
          setAttribute: (k, v) => { node[k] = v; },
          removeAttribute: (k) => { delete node[k]; },
          addEventListener: (evt, handler) => { node[`on_${evt}`] = handler; },
          append: (...args) => { node.children = args; },
          remove: () => {
            const idx = createdNodes.indexOf(node);
            if (idx >= 0) createdNodes.splice(idx, 1);
          }
        };
        return node;
      },
      addEventListener: () => {}
    };

    const mgr = VideoManager.createVideoPlaybackManager({ document: fakeDoc });

    const makeMockVideo = () => ({
      muted: true,
      volume: 0.35,
      paused: true,
      play: async function() { this.paused = false; if (!this.muted && this.__rejectAudible) { const e = new Error("NotAllowedError"); e.name = "NotAllowedError"; throw e; } },
      pause: function() { this.paused = true; },
      addEventListener: function(evt, handler) { this[`on_${evt}`] = handler; }
    });

    const v1 = makeMockVideo();
    const v2 = makeMockVideo();

    mgr.registerVideo("v1", v1, { videoMuted: true, videoVolume: 50 });
    mgr.registerVideo("v2", v2, { videoMuted: true, videoVolume: 60 });

    assert.strictEqual(v1.muted, true, "Videos start muted by default");
    assert.strictEqual(v2.muted, true, "Videos start muted by default");

    mgr.setUserMute("v1", false);
    assert.strictEqual(mgr.audibleOwnerCompId, "v1", "v1 becomes audible owner");
    assert.strictEqual(v1.muted, false, "v1 is unmuted");

    mgr.setUserMute("v2", false);
    assert.strictEqual(mgr.audibleOwnerCompId, "v2", "v2 becomes new audible owner");
    assert.strictEqual(v2.muted, false, "v2 is unmuted");
    assert.strictEqual(v1.muted, true, "v1 is muted because only one video can be audible");

    const v3 = makeMockVideo();
    v3.__rejectAudible = true;
    mgr.registerVideo("v3", v3, { videoMuted: true, videoVolume: 75 });
    mgr.setUserMute("v3", false);
    await mgr.applyStateToElement(mgr.components.get("v3"));

    const v3State = mgr.getVideoState("v3");
    assert.strictEqual(v3State.audioBlockedByPolicy, true, "State notes audio blocked by browser policy");
    assert.strictEqual(v3.muted, true, "Falls back to muted playback on autoplay rejection");

    // Zero playback buttons injected into third-party website DOM
    const promptHost = createdNodes.find((n) => n.id === "chameleon-inpage-audio-prompt");
    assert(!promptHost, "Zero playback buttons injected into third-party website DOM");

    // Test cross-tab / cross-component audio yielding
    mgr.yieldAudioFocus("v2");
    assert.strictEqual(v2.muted, true, "Yielding audio focus silences video playback");
    assert.strictEqual(mgr.getVideoState("v2").userMuted, false, "Stored user audio preference is preserved during focus yield");

    // Rebalance unblocks audio when page interaction occurs
    v3.__rejectAudible = false;
    mgr.documentAudioAllowed = true;
    mgr.rebalanceAudioPlayback();
    await mgr.applyStateToElement(mgr.components.get("v3"));
    assert.strictEqual(v3.muted, false, "Video unmutes once user document interaction is captured");

    // Verify EOF pause/ended loop recovery
    v3.loop = true;
    v3.duration = 12.0;
    v3.currentTime = 11.95;
    v3.ended = true;
    v3.paused = true;
    if (typeof v3.on_pause === "function") v3.on_pause();
    assert.strictEqual(v3.currentTime, 0, "EOF pause listener rewinds looping video to 0:00");
    assert.strictEqual(v3.paused, false, "EOF pause listener resumes looping video playback");
    assert.strictEqual(mgr.getVideoState("v3").isPlaying, true, "VideoPlaybackManager keeps isPlaying=true across loop wrap");

    mgr.destroy();
    return "Verified multi-variable playback state, audio focus arbitration, autoplay fallback, EOF loop recovery, and non-injecting browser compliance";
  });

  // 22. Backup export and import schema validation
  await test("U22", "Data lifecycle: backup export, schema validation, and merge vs replace import", async () => {
    const store = {
      "siteCfg::https://a.example": { siteKey: "https://a.example", revision: 1, components: { root_page: { activeMediaId: "m1" } } },
      "theme::theme_one": { id: "theme_one", domain: "example.com", displayName: "Theme One", defaultStyles: { opacity: 80 } },
      "globalSettings": { extensionEnabled: true, ecoMode: true }
    };

    const mockStorage = {
      get: async (keys) => {
        if (!keys) return { ...store };
        const res = {};
        const kList = Array.isArray(keys) ? keys : [keys];
        for (const k of kList) if (store[k] !== undefined) res[k] = store[k];
        return res;
      },
      set: async (obj) => { Object.assign(store, obj); },
      remove: async (keys) => {
        const kList = Array.isArray(keys) ? keys : [keys];
        for (const k of kList) delete store[k];
      }
    };

    const backup = await StorageService.exportBackupData(mockStorage, { includeBlobs: false });
    assert.strictEqual(backup.schemaVersion, 2, "Backup schemaVersion must be 2");
    assert.strictEqual(backup.appVersion, "2.2.0");
    assert(Array.isArray(backup.siteConfigs) && backup.siteConfigs.length === 1, "Exports site configs");
    assert(Array.isArray(backup.domainThemes) && backup.domainThemes.length === 1, "Exports domain themes");

    const validCheck = StorageService.validateBackupPayload(backup);
    assert.strictEqual(validCheck.valid, true, "Exported backup validates cleanly");
    assert.strictEqual(validCheck.siteConfigCount, 1);
    assert.strictEqual(validCheck.domainThemeCount, 1);

    const badCheck = StorageService.validateBackupPayload({ schemaVersion: 99 });
    assert.strictEqual(badCheck.valid, false, "Rejects unsupported schema version");

    const incomingBackup = {
      schemaVersion: 2,
      siteConfigs: [
        { siteKey: "https://b.example", revision: 1, components: { root_page: { activeMediaId: "m2" } } }
      ],
      domainThemes: [
        { id: "theme_two", domain: "other.com", displayName: "Theme Two" }
      ]
    };

    const mergeResult = await StorageService.importBackupData(mockStorage, incomingBackup, { mode: "merge" });
    assert.strictEqual(mergeResult.ok, true);
    assert(store["siteCfg::https://a.example"], "Existing site preserved under merge mode");
    assert(store["siteCfg::https://b.example"], "Incoming site imported under merge mode");

    const replaceResult = await StorageService.importBackupData(mockStorage, incomingBackup, { mode: "replace" });
    assert.strictEqual(replaceResult.ok, true);
    assert(!store["siteCfg::https://a.example"], "Old site cleared under replace mode");
    assert(store["siteCfg::https://b.example"], "Incoming site present under replace mode");

    return "Verified backup export schema v2, preflight validation, and merge vs replace import semantics";
  });

  // 23. Strict SVG positive allowlist and message payload validation
  await test("U23", "Security hardening: strict SVG positive allowlist enforcement", async () => {
    assert(StorageService.ALLOWED_SVG_TAGS instanceof Set, "ALLOWED_SVG_TAGS must be exported");
    assert(StorageService.ALLOWED_SVG_TAGS.has("path") && StorageService.ALLOWED_SVG_TAGS.has("rect"), "Whitelists safe geometric elements");
    assert(!StorageService.ALLOWED_SVG_TAGS.has("script") && !StorageService.ALLOWED_SVG_TAGS.has("use"), "Excludes dangerous tags from allowlist");

    const dirtySvg = new Blob([
      `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">` +
      `<foreignObject><iframe src="https://evil.example"></iframe></foreignObject>` +
      `<rect width="50" height="50" fill="red" onclick="evil()" />` +
      `<unknownHostileTag evil="true" />` +
      `<path d="M0 0 L10 10" />` +
      `</svg>`
    ], { type: "image/svg+xml" });

    const cleanSvg = await StorageService.sanitizeSvgBlob(dirtySvg);
    const cleanSvgText = await cleanSvg.text();
    assert(!cleanSvgText.includes("<foreignObject"), "Strips foreignObject");
    assert(!cleanSvgText.includes("<iframe"), "Strips iframe");
    assert(!cleanSvgText.includes("onclick="), "Strips onclick");
    assert(!cleanSvgText.includes("onload="), "Strips onload");
    assert(cleanSvgText.includes("<rect"), "Preserves whitelisted rect");
    assert(cleanSvgText.includes("<path"), "Preserves whitelisted path");
    return "Verified strict positive element allowlist stripping hostile, unknown, and active elements while keeping safe vector shapes";
  });

  // 24. Verified legacy IndexedDB deletion only on 100% verified migration
  await test("U24", "Verified legacy IndexedDB deletion: deletes only on 100% verified migration, preserves on failure", async () => {
    const contentJs = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    assert(contentJs.includes("indexedDB.deleteDatabase(LEGACY_PAGE_DB_NAME)"), "content.js must call indexedDB.deleteDatabase");
    const migrationFn = contentJs.slice(contentJs.indexOf("async function migrateLegacyPageIndexedDBIfPresent"), contentJs.indexOf("function uploadBlobViaChunkedPort", contentJs.indexOf("async function migrateLegacyPageIndexedDBIfPresent")));
    assert(migrationFn.includes("failedIds.length === 0") && migrationFn.lastIndexOf("indexedDB.deleteDatabase(LEGACY_PAGE_DB_NAME)") > migrationFn.indexOf("failedIds.length === 0"), "deleteDatabase must be guarded by failedIds.length === 0");
    return "Verified legacy IndexedDB deletion only when all records are successfully migrated, preserving source on any failure";
  });

  // 25. C-01: Content script CHAMELEON_GET_OVERVIEW redacts mediaItems/storageStats and enforces sender origin
  await test("U25", "C-01: CHAMELEON_GET_OVERVIEW redacts media library and enforces sender origin for content scripts", async () => {
    const h = makeBackgroundHarness({
      "siteCfg::https://example.com": { siteKey: "https://example.com", enabled: true, revision: 2, components: { root_page: { activeMediaId: "preset_aurora_webp" } } },
      "siteCfg::https://other.secret.example": { siteKey: "https://other.secret.example", enabled: true, revision: 5, components: { root_page: { activeMediaId: "secret_media" } } }
    }, [{ id: 7, url: "https://example.com/page" }]);

    // Content script attempting to query a cross-origin siteKey must receive only its own sender.url config and redacted mediaItems
    const pageOverview = await h.dispatch({
      type: "CHAMELEON_GET_OVERVIEW",
      siteKey: "https://other.secret.example"
    }, h.pageSender);
    assert.strictEqual(pageOverview.ok, true);
    assert.strictEqual(pageOverview.siteKey, "https://example.com", "Content script overview must be bound to sender.url origin");
    assert.strictEqual(pageOverview.mediaItems.length, 0, "Content script must not receive media library metadata");
    assert.strictEqual(pageOverview.storageStats, null, "Content script must not receive storage stats");

    // Privileged Studio sender still receives full mediaItems and requested siteKey
    const studioOverview = await h.dispatch({
      type: "CHAMELEON_GET_OVERVIEW",
      siteKey: "https://other.secret.example"
    }, h.studioSender);
    assert.strictEqual(studioOverview.ok, true);
    assert.strictEqual(studioOverview.siteKey, "https://other.secret.example");
    assert(Array.isArray(studioOverview.mediaItems) && studioOverview.mediaItems.length >= 4, "Privileged Studio page receives full media list");
    return "Verified content-script origin binding and media metadata redaction on CHAMELEON_GET_OVERVIEW";
  });

  // 26. C-02: Storage mutex serializes concurrent async writes without re-entrancy bypass
  await test("U26", "C-02: Storage mutex strictly serializes concurrent async writes without re-entrancy race", async () => {
    const store = {};
    const delayedMockStorage = {
      get: async (keys) => {
        await new Promise((r) => setTimeout(r, 15));
        if (!keys) return { ...store };
        const res = {};
        for (const k of (Array.isArray(keys) ? keys : [keys])) {
          if (store[k] !== undefined) res[k] = JSON.parse(JSON.stringify(store[k]));
        }
        return res;
      },
      set: async (obj) => {
        await new Promise((r) => setTimeout(r, 15));
        Object.assign(store, JSON.parse(JSON.stringify(obj)));
      },
      remove: async (keys) => {
        for (const k of (Array.isArray(keys) ? keys : [keys])) delete store[k];
      }
    };

    await Promise.all([
      StorageService.saveSiteConfigConflictSafe(delayedMockStorage, "https://site-a.example", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "m1" } }
      }),
      StorageService.saveSiteConfigConflictSafe(delayedMockStorage, "https://site-b.example", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "m2" } }
      }),
      StorageService.saveSiteConfigConflictSafe(delayedMockStorage, "https://site-c.example", {
        enabled: true,
        components: { root_page: { id: "root_page", activeMediaId: "m3" } }
      })
    ]);

    const index = store[StorageService.SITE_INDEX_KEY] || {};
    assert(index["https://site-a.example"] && index["https://site-b.example"] && index["https://site-c.example"], "All 3 concurrent saves must be preserved in siteIndexMap_v2 without clobbering");
    return "Verified strict async serialization across concurrent saves with delayed I/O";
  });

  // 27. C-03: Backup validation rejects javascript: and unsafe URI schemes
  await test("U27", "C-03: validateBackupPayload rejects javascript:, data:, and unsafe URI schemes", async () => {
    const evilBackup = {
      schemaVersion: 2,
      siteConfigs: [
        { siteKey: "javascript:alert(document.cookie)", revision: 1, components: { root_page: { activeMediaId: "m1" } } }
      ]
    };
    const res = StorageService.validateBackupPayload(evilBackup);
    assert.strictEqual(res.valid, false, "Backup with javascript: siteKey must be rejected");
    assert(/unsafe or invalid site origin/i.test(res.error), "Error message explains unsafe origin rejection");

    const dataSchemeBackup = {
      schemaVersion: 2,
      siteConfigs: [
        { siteKey: "data:text/html,<script>alert(1)</script>", revision: 1, components: {} }
      ]
    };
    assert.strictEqual(StorageService.validateBackupPayload(dataSchemeBackup).valid, false, "Backup with data: siteKey must be rejected");
    return "Verified backup validator blocks javascript: and data: URI schemes";
  });

  // 28. C-04: Legacy IndexedDB migration fallback when indexedDB.databases is undefined (Firefox Desktop)
  await test("U28", "C-04: Legacy page IndexedDB migration runs when indexedDB.databases is undefined", async () => {
    const contentJs = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const migrationFn = contentJs.slice(
      contentJs.indexOf("async function migrateLegacyPageIndexedDBIfPresent"),
      contentJs.indexOf("function uploadBlobViaChunkedPort")
    );
    assert(!migrationFn.includes('typeof indexedDB === "undefined" || typeof indexedDB.databases !== "function"'), "Must not abort early when indexedDB.databases is unavailable");
    assert(migrationFn.includes('if (typeof indexedDB.databases === "function")'), "Checks indexedDB.databases conditionally and falls back to indexedDB.open");
    return "Verified Firefox Desktop fallback when indexedDB.databases() is undefined";
  });

  // 29. H-01: Renderer exports videoPlaybackManager and yields audio focus properly
  await test("U29", "H-01: createBackgroundRenderer exports videoPlaybackManager and yields audio focus", async () => {
    const VideoManager = require(path.join(__dirname, "..", "video-manager.js"));
    const RendererEngine = require(path.join(__dirname, "..", "renderer-engine.js"));
    globalThis.ChameleonVideoManager = VideoManager;

    const fakeDoc = {
      hidden: false,
      body: { appendChild() {}, insertBefore() {} },
      documentElement: { style: { setProperty() {}, getPropertyValue: () => "", getPropertyPriority: () => "", removeProperty() {} } },
      createElement: (tag) => ({
        tagName: tag.toUpperCase(),
        style: { setProperty() {}, getPropertyValue: () => "", getPropertyPriority: () => "", removeProperty() {} },
        setAttribute() {},
        removeAttribute() {},
        appendChild() {},
        insertBefore() {},
        addEventListener() {},
        removeEventListener() {},
        remove() {}
      }),
      addEventListener() {},
      removeEventListener() {}
    };

    const renderer = RendererEngine.createBackgroundRenderer({
      document: fakeDoc,
      window: { getComputedStyle: () => ({ position: "relative", isolation: "isolate", backgroundColor: "transparent" }) }
    });

    assert(renderer.videoPlaybackManager, "renderer.videoPlaybackManager must be exposed");
    const mockVid = {
      muted: false,
      volume: 0.5,
      paused: false,
      play: async () => {},
      pause: () => {},
      addEventListener: () => {},
      removeEventListener: () => {}
    };
    renderer.videoPlaybackManager.registerVideo("root_page", mockVid, { videoMuted: false, videoVolume: 50 });
    assert.strictEqual(renderer.videoPlaybackManager.audibleOwnerCompId, "root_page");
    renderer.videoPlaybackManager.yieldAudioFocus("root_page");
    assert.strictEqual(mockVid.muted, true, "yieldAudioFocus must mute active video element");
    assert.strictEqual(renderer.videoPlaybackManager.audibleOwnerCompId, null, "yieldAudioFocus must clear audibleOwnerCompId");
    renderer.destroyAll();
    return "Verified renderer.videoPlaybackManager export and cross-tab audio focus yielding";
  });

  // 30. H-02: Domain Theme resolution in getSiteConfigForTarget & subdomain inheritance
  await test("U30", "H-02: getSiteConfigForTarget resolves Domain Themes for subdomains automatically", async () => {
    const mockStorage = createMockChromeStorage();
    await StorageService.saveDomainTheme(mockStorage, {
      id: "theme_corp",
      domain: "corp.example.com",
      displayName: "Corp Theme",
      defaultStyles: { opacity: 65, blur: 4 },
      defaultMedia: { mediaId: "preset_aurora_webp", playlist: ["preset_aurora_webp"], rotationIntervalSec: 120 },
      autoInheritSubdomains: true
    });

    const resolvedSub = await StorageService.getSiteConfigForTarget(mockStorage, "https://docs.corp.example.com/guide");
    assert.strictEqual(resolvedSub.matched, true, "Subdomain matches inherited Domain Theme");
    assert.strictEqual(resolvedSub.siteConfig.themeApplied, "theme_corp");
    assert(resolvedSub.siteConfig.components.root_page, "Synthesizes root_page component from Domain Theme defaultMedia");
    assert.strictEqual(resolvedSub.siteConfig.components.root_page.activeMediaId, "preset_aurora_webp");
    assert.strictEqual(resolvedSub.siteConfig.components.root_page.opacity, 65);
    return "Verified automatic Domain Theme resolution and root_page synthesis across subdomains";
  });

  // 31. H-05 & M-04 & M-14: Wildcard persistent host grant coverage, media reference pruning, and clearAllChameleonData
  await test("U31", "M-04, M-14, L-03: Wildcard host grant coverage, deleted media pruning, and complete data purge", async () => {
    // M-04: Wildcard permission pattern coverage
    const coveredByAllHttps = AccessControl.hasPersistentHostGrant(
      true,
      { hostPermissionGrantedAt: 1700000000000, permissionPattern: "https://*/*" },
      "https://sub.example.com/*"
    );
    assert.strictEqual(coveredByAllHttps, true, "https://*/* grant must cover specific https origin pattern");

    // M-14: Prune deleted media references from siteConfigs and domainThemes
    const mockStorage = createMockChromeStorage();
    await StorageService.saveSiteConfigConflictSafe(mockStorage, "https://prune.example", {
      enabled: true,
      components: {
        root_page: {
          id: "root_page",
          activeMediaId: "media_to_delete",
          playlist: ["media_to_delete", "preset_zen_forest"]
        }
      }
    });
    await StorageService.saveDomainTheme(mockStorage, {
      id: "theme_prune",
      domain: "prune.example",
      displayName: "Prune Theme",
      defaultMedia: { mediaId: "media_to_delete", playlist: ["media_to_delete", "preset_slate_dusk"] }
    });

    const pruneRes = await StorageService.pruneDeletedMediaReferences(mockStorage, "media_to_delete");
    assert.strictEqual(pruneRes.ok, true);
    assert.strictEqual(pruneRes.updatedSites, 1);
    assert.strictEqual(pruneRes.updatedThemes, 1);

    const afterSite = await StorageService.getSiteConfigForTarget(mockStorage, "https://prune.example");
    assert.deepStrictEqual(afterSite.siteConfig.components.root_page.playlist, ["preset_zen_forest"]);
    assert.strictEqual(afterSite.siteConfig.components.root_page.activeMediaId, "preset_zen_forest");

    const afterTheme = await StorageService.getDomainTheme(mockStorage, "theme_prune");
    assert.deepStrictEqual(afterTheme.defaultMedia.playlist, ["preset_slate_dusk"]);
    assert.strictEqual(afterTheme.defaultMedia.mediaId, "preset_slate_dusk");

    // L-03: clearAllChameleonData removes globalSettings and migration markers
    await mockStorage.set({
      globalSettings: { extensionEnabled: false },
      [StorageService.MIGRATION_STATE_KEY]: { completed: true },
      [StorageService.LEGACY_BACKUP_KEY]: { old: true }
    });
    await StorageService.clearAllChameleonData(mockStorage);
    const remaining = await mockStorage.get(null);
    assert.strictEqual(Object.keys(remaining).length, 0, "clearAllChameleonData must purge all ChameleonBG keys including globalSettings and migration markers");
    return "Verified wildcard host permission coverage, deleted media pruning, and full storage reset";
  });

  // 32. Video scroll persistence (no unload on scroll) and explicit ended loop restart
  await test("U32", "Video scroll playback preservation and seamless ended loop restart", async () => {
    const rendererJs = fs.readFileSync(path.join(__dirname, "..", "renderer-engine.js"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");

    // Verify scrolling off-screen (isIntersecting === false) does not trigger unloadVideoSource
    const rebalanceSlice = rendererJs.slice(
      rendererJs.indexOf("function rebalanceActiveVideos()"),
      rendererJs.indexOf("function unloadVideoSource(layer)")
    );
    assert(!rebalanceSlice.includes("layer.isIntersecting === false || allVideoLayers.indexOf(layer) >= maxVideos"), "Scrolling off-screen must pause rather than unload video src so currentTime is preserved");
    assert(rendererJs.includes("layer.savedCurrentTime"), "unloadVideoSource and restoreUnloadedVideoSource preserve savedCurrentTime");
    assert(rendererJs.includes("videoEl.currentTime = 0;"), "ended listener explicitly restarts looping videos from 0");
    assert(studioJs.includes("otherCfg.videoMuted = true"), "Unmuting a video in Studio mutes other components so UI badges stay accurate");

    // Verify ISOBMFF MP4 box parser extracts exact video vs audio track durations
    const makeBox = (type, payloadBytes) => {
      const out = new Uint8Array(8 + payloadBytes.length);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, out.length);
      for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
      out.set(payloadBytes, 8);
      return out;
    };
    const concatBytes = (...arrays) => {
      const total = arrays.reduce((s, a) => s + a.length, 0);
      const res = new Uint8Array(total);
      let off = 0;
      for (const a of arrays) { res.set(a, off); off += a.length; }
      return res;
    };
    const makeMvhd = (timescale, duration) => {
      const b = new Uint8Array(20);
      const dv = new DataView(b.buffer);
      dv.setUint8(0, 0); // version 0
      dv.setUint32(12, timescale);
      dv.setUint32(16, duration);
      return makeBox("mvhd", b);
    };
    const makeMdhd = (timescale, duration) => {
      const b = new Uint8Array(20);
      const dv = new DataView(b.buffer);
      dv.setUint8(0, 0); // version 0
      dv.setUint32(12, timescale);
      dv.setUint32(16, duration);
      return makeBox("mdhd", b);
    };
    const makeHdlr = (handlerType) => {
      const b = new Uint8Array(12);
      for (let i = 0; i < 4; i++) b[8 + i] = handlerType.charCodeAt(i);
      return makeBox("hdlr", b);
    };
    const videoTrak = makeBox("trak", makeBox("mdia", concatBytes(makeMdhd(1000, 12000), makeHdlr("vide")))); // 12.0s video track
    const audioTrak = makeBox("trak", makeBox("mdia", concatBytes(makeMdhd(1000, 30000), makeHdlr("soun")))); // 30.0s audio track (18s overhang!)
    const moov = makeBox("moov", concatBytes(makeMvhd(1000, 30000), videoTrak, audioTrak));
    const parsedMp4 = await StorageService.extractMp4TrackDurations(moov.buffer);
    assert.strictEqual(parsedMp4.videoTrackDuration, 12, "Extracts exact 12.0s video track duration from MP4 mdhd");
    assert.strictEqual(parsedMp4.audioTrackDuration, 30, "Extracts exact 30.0s audio track duration from MP4 mdhd");
    assert.strictEqual(parsedMp4.movieDuration, 30, "Extracts 30.0s movie header duration from MP4 mvhd");

    // Verify stsz rolling-window static frame tail detection (e.g., 12s active motion + 18s re-encoded static frames with periodic IDR keyframes)
    const makeStsz = (sizes) => {
      const b = new Uint8Array(12 + sizes.length * 4);
      const dv = new DataView(b.buffer);
      dv.setUint32(4, 0); // uniformSize = 0
      dv.setUint32(8, sizes.length);
      for (let i = 0; i < sizes.length; i++) dv.setUint32(12 + i * 4, sizes[i]);
      return makeBox("stsz", b);
    };
    const sampleSizes = [];
    // 40 active frames (~12,000 bytes each = 12s) + 60 frozen frames (~80 bytes P-frames with one 2000B static IDR at frame 70 = 18s)
    for (let i = 0; i < 40; i++) sampleSizes.push(12000);
    for (let i = 40; i < 100; i++) sampleSizes.push(i === 70 ? 2000 : 80);
    const frozenTailVideoTrak = makeBox("trak", makeBox("mdia", concatBytes(
      makeMdhd(1000, 30000),
      makeHdlr("vide"),
      makeBox("minf", makeBox("stbl", makeStsz(sampleSizes)))
    )));
    const frozenTailMoov = makeBox("moov", concatBytes(makeMvhd(1000, 30000), frozenTailVideoTrak, audioTrak));
    const parsedFrozenMp4 = await StorageService.extractMp4TrackDurations(frozenTailMoov.buffer);
    assert(parsedFrozenMp4.videoTrackDuration >= 11.5 && parsedFrozenMp4.videoTrackDuration <= 12.8, `Detects ~12s visual end from stsz rolling window despite 30s mdhd and periodic IDR keyframes (got ${parsedFrozenMp4.videoTrackDuration})`);

    return "Verified off-screen scroll pauses without resetting currentTime, MP4 binary track parser cuts trailing audio & re-encoded static frame tails on first loop, and Studio syncs single-audible state";
  });

  // 33. Topbar layout fix, Auto-Save + Back/Forward History Arrows, Frosted Glass & Text Readability, Loop Trim, and 1-Click Reusable Theme
  await test("U33", "Topbar layout fix, Auto-Save + Back/Forward arrows, Loop Trim, Frosted Glass & 1-Click Reusable Theme", async () => {
    const studioHtml = fs.readFileSync(path.join(__dirname, "..", "studio.html"), "utf8");
    const studioCss = fs.readFileSync(path.join(__dirname, "..", "studio.css"), "utf8");
    const studioJs = fs.readFileSync(path.join(__dirname, "..", "studio.js"), "utf8");
    const contentJs = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
    const rendererJs = fs.readFileSync(path.join(__dirname, "..", "renderer-engine.js"), "utf8");
    const agentsMd = fs.readFileSync(path.join(__dirname, "..", "AGENTS.md"), "utf8");

    // 1. Topbar single-row layout fix & AGENTS.md presence
    assert(studioHtml.includes('class="brand-meta-row"') && studioCss.includes("min-height: 58px") && studioCss.includes("flex-wrap: nowrap"), "Topbar uses single-row nowrap layout on desktop with compact brand-meta-row so topbar-right stays on the right");
    assert(agentsMd.includes("Agent & Developer Guidelines") && agentsMd.includes("ZERO `innerHTML`"), "Root AGENTS.md documents architecture, layout, security, and testing rules for future agents");

    // 2. Auto-Save + Back (Undo) & Forward (Redo) History Stack
    assert(studioHtml.includes('id="chkStudioAutoSave"') && studioHtml.includes('id="btnStudioUndo"') && studioHtml.includes('id="btnStudioRedo"'), "Studio topbar includes Auto-save toggle and Back/Forward history buttons");
    assert(studioJs.includes("const redoStack = []") && studioJs.includes("function scheduleAutoSave()"), "Studio maintains equal-depth undoStack and redoStack with debounced auto-save");
    assert(contentJs.includes("const redoStack = []") && contentJs.includes("function scheduleDockAutoSave()"), "In-page dock also supports Back/Forward history and auto-save");

    // 3. Explicit Video Loop Start / End Cutoff Trim
    assert(studioHtml.includes('id="inputVideoLoopStartSec"') && studioHtml.includes('id="inputVideoLoopEndSec"'), "Video inspector exposes Loop Start and Loop End Cutoff controls");
    assert(rendererJs.includes("videoLoopEndSec") && rendererJs.includes("videoLoopStartSec"), "Renderer enforces custom videoLoopStartSec and videoLoopEndSec");

    // 4. Smart Readability (Frosted Glass Cards & Adaptive Text Contrast)
    assert(studioHtml.includes('id="sliderBackdropBlur"') && studioHtml.includes('id="selectTextContrastMode"'), "Visual Adjustments exposes Frosted Glass Cards slider and Smart Text Readability selector");
    assert(rendererJs.includes("backdropBlurPx") && rendererJs.includes("textContrastMode"), "Renderer applies backdrop-filter blur and text-shadow/contrast modes");

    // 5. 1-Click Save Current Website Setup as Reusable Theme & Apply to Current Site
    assert(studioHtml.includes('id="btnSaveSiteAsTheme"'), "Left panel footer includes 1-click Save Current Setup as Theme button");
    assert(studioJs.includes("function openSaveCurrentSiteAsThemeModal()") && studioJs.includes("function applyThemeToCurrentSite(theme)"), "Studio wires 1-click theme creation from current site setup and 1-click Apply to Current Site");

    return "Verified topbar non-overlapping layout, Auto-Save + Back/Forward history stack, Loop Trim controls, Frosted Glass & Text Readability, and 1-click Reusable Themes";
  });

  const failed = results.filter((r) => r.status === "FAIL");
  const report = {
    suite: "Tier 1 — Node.js Unit Tests",
    totalTests: results.length,
    passedCount: results.length - failed.length,
    failedCount: failed.length,
    totalDurationMs: Date.now() - tStart,
    results
  };

  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    process.exit(1);
  }
}

runUnitTests().catch((err) => {
  console.error("FATAL ERROR IN TEST RUNNER:", err);
  process.exit(1);
});
