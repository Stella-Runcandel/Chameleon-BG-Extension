/**
 * ChameleonBG v2.0.2 — Shared Extension-Origin Media Storage, Format Security,
 * Bounded Chunked Transport & Conflict-Safe Configuration Service (`storage-service.js`)
 *
 * Hardening guarantees in v2.0.1:
 * 1. Deep SVG Sanitization: Rejects XML `<!DOCTYPE` / `<!ENTITY` declarations, strips executable
 *    or external-referencing elements (`script`, `foreignObject`, `use`, `image`, `feImage`, `iframe`,
 *    `object`, `embed`, `a`, `animate*`, `set`, `mpath`, `handler`), removes all `on*` event attributes
 *    and external/data URLs (`href`, `xlink:href`, `src`), and sanitizes `<style>` / inline `style`
 *    declarations against `@import`, `expression()`, and external `url(...)` references.
 * 2. Bounded, Cancellation-Aware Chunked Media Transport: Streams media in bounded slices (default 256 KB)
 *    with unique `transferId`, sequential chunk acknowledgement, 32-bit FNV-1a checksum & byte-length
 *    integrity verification, timeout & cancellation handling, and configurable upload/transfer size limits
 *    (default 50 MB hard limit, 15 MB warning threshold)—eliminating whole-file Base64 memory amplification.
 * 3. Conflict-Safe Origin-Scoped Site Configuration Storage:
 *    - Defaults to exact origin matching (`https://example.com:8443`), with optional `"hostname"` or
 *      `"subdomain"` matching scopes.
 *    - Persists each site under an independent storage key (`siteCfg::<siteKey>`) guarded by an
 *      in-process async mutex queue and monotonic `revision` numbers so concurrent edits across
 *      different sites never overwrite each other and same-site revision conflicts are detected.
 *    - Safely migrates legacy v2.0 hostname-keyed `siteConfigs` once without deleting original records.
 */

(function (globalScope) {
  "use strict";

  const EXT_DB_NAME = "ChameleonBG_ExtensionMediaDB";
  const EXT_DB_VERSION = 2;
  const MEDIA_STORE = "mediaRecords";

  const SITE_KEY_PREFIX = "siteCfg::";
  const SITE_INDEX_KEY = "siteConfigIndex_v2_0_1";
  const MIGRATION_STATE_KEY = "migrationState_v2_0_1";
  const LEGACY_BACKUP_KEY = "legacySiteConfigsBackup_v2_0";
  const THEME_KEY_PREFIX = "theme::";
  const THEME_INDEX_KEY = "domainThemeIndex";
  const BACKUP_SCHEMA_VERSION = 2;

  const DEFAULT_CHUNK_SIZE_BYTES = 256 * 1024; // 256 KB per slice
  const DEFAULT_MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50 MB configurable ceiling
  const DEFAULT_WARN_MEDIA_BYTES = 15 * 1024 * 1024; // 15 MB large-file warning threshold
  const DEFAULT_TRANSFER_TIMEOUT_MS = 12000;

  const SUPPORTED_IMAGE_MIMES = new Set([
    "image/webp",
    "image/avif",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/svg+xml"
  ]);

  const SUPPORTED_VIDEO_MIMES = new Set([
    "video/webm",
    "video/mp4",
    "video/ogg"
  ]);

  const ALLOWED_SVG_TAGS = new Set([
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "defs",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "pattern",
    "style",
    "text",
    "tspan"
  ]);

  const FORBIDDEN_SVG_TAGS = new Set([
    "script",
    "foreignobject",
    "iframe",
    "object",
    "embed",
    "use",
    "image",
    "feimage",
    "a",
    "animate",
    "animatemotion",
    "animatetransform",
    "set",
    "mpath",
    "handler",
    "listener",
    "audio",
    "video",
    "canvas"
  ]);

  const FORBIDDEN_SVG_ATTRS = new Set([
    "href",
    "xlink:href",
    "src",
    "data",
    "action",
    "formaction",
    "dynsrc",
    "lowsrc"
  ]);

  const BUILTIN_PRESETS = [
    {
      id: "preset_aurora_webp",
      name: "Northern Aurora",
      mimeType: "text/css-gradient",
      mediaType: "preset",
      size: 0,
      width: 1920,
      height: 1080,
      createdAt: 1700000001000,
      gradient: "radial-gradient(circle at 20% 25%, rgba(16, 185, 129, 0.72) 0%, rgba(14, 165, 233, 0.62) 48%, rgba(15, 23, 42, 0.96) 100%)"
    },
    {
      id: "preset_slate_dusk",
      name: "Warm Slate Dusk",
      mimeType: "text/css-gradient",
      mediaType: "preset",
      size: 0,
      width: 1920,
      height: 1080,
      createdAt: 1700000002000,
      gradient: "linear-gradient(135deg, #1e1b4b 0%, #4c1d95 46%, #c2410c 92%)"
    },
    {
      id: "preset_zen_forest",
      name: "Deep Botanical Mist",
      mimeType: "text/css-gradient",
      mediaType: "preset",
      size: 0,
      width: 1920,
      height: 1080,
      createdAt: 1700000003000,
      gradient: "linear-gradient(160deg, #064e3b 0%, #115e59 52%, #0f172a 100%)"
    },
    {
      id: "preset_obsidian_minimal",
      name: "Obsidian Studio Neutral",
      mimeType: "text/css-gradient",
      mediaType: "preset",
      size: 0,
      width: 1920,
      height: 1080,
      createdAt: 1700000004000,
      gradient: "radial-gradient(circle at 78% 18%, rgba(71, 85, 105, 0.42), rgba(9, 13, 22, 0.98) 72%)"
    }
  ];

  let dbInstancePromise = null;

  function openExtensionMediaDB() {
    if (dbInstancePromise) return dbInstancePromise;
    dbInstancePromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        dbInstancePromise = null;
        return reject(new Error("IndexedDB is unavailable in this execution context."));
      }
      const req = indexedDB.open(EXT_DB_NAME, EXT_DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(MEDIA_STORE)) {
          const store = db.createObjectStore(MEDIA_STORE, { keyPath: "id" });
          store.createIndex("createdAt", "createdAt", { unique: false });
          store.createIndex("mediaType", "mediaType", { unique: false });
          store.createIndex("name", "name", { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          dbInstancePromise = null;
        };
        db.onclose = () => {
          dbInstancePromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        dbInstancePromise = null;
        reject(req.error || new Error("Failed to open extension IndexedDB."));
      };
      req.onblocked = () => {
        dbInstancePromise = null;
        reject(new Error("IndexedDB upgrade blocked by another open tab."));
      };
    });
    return dbInstancePromise;
  }

  // =========================================================================
  // 1. FORMAT VALIDATION, ANIMATED GIF DETECTION & DEEP SVG SANITIZATION
  // =========================================================================
  async function isAnimatedGif(blobOrBuffer) {
    try {
      const buffer = blobOrBuffer instanceof ArrayBuffer
        ? blobOrBuffer
        : await blobOrBuffer.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (bytes.length < 13) return false;
      const header = String.fromCharCode(...bytes.subarray(0, 6));
      if (header !== "GIF87a" && header !== "GIF89a") return false;

      let gceCount = 0;
      for (let i = 6; i < bytes.length - 4; i++) {
        if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) {
          gceCount++;
          if (gceCount > 1) return true;
        }
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  function sanitizeCssStyleText(cssText) {
    if (!cssText) return "";
    // Strip @import, expression(), -moz-binding, behavior, and any url(...) that is not an internal #id fragment
    return String(cssText)
      .replace(/@import\b[^;{}]*;?/gi, "")
      .replace(/expression\s*\([^)]*\)/gi, "")
      .replace(/-moz-binding\s*:[^;{}]*/gi, "")
      .replace(/behavior\s*:[^;{}]*/gi, "")
      .replace(/url\s*\(\s*(['"]?)\s*(?!#)[^)]*\1\s*\)/gi, "none");
  }

  /**
   * Deeply sanitize untrusted SVG content:
   * - Rejects DOCTYPE and ENTITY declarations (prevents XML entity expansion / external DTD fetch).
   * - Removes script, foreignObject, use, image, feImage, iframe, object, embed, animate*, set, a.
   * - Removes all `on*` event handlers and external/data resource attributes (`href`, `xlink:href`, `src`).
   * - Sanitizes `<style>` and inline `style` attributes against external `url()` and `@import`.
   */
  async function sanitizeSvgBlob(blob) {
    const rawText = await blob.text();
    if (!rawText || !/<svg[\s>]/i.test(rawText)) {
      throw new Error("Invalid or corrupt SVG file: missing <svg> root element.");
    }
    if (/<!DOCTYPE|<!ENTITY/i.test(rawText)) {
      throw new Error("Rejected unsafe SVG: XML DOCTYPE or ENTITY declarations are not permitted.");
    }

    // Regex pre-pass for worker environments without DOMParser
    let cleaned = rawText
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<foreignObject[\s\S]*?>[\s\S]*?<\/foreignObject>/gi, "")
      .replace(/<(?:use|image|feImage|iframe|object|embed|animate|animateMotion|animateTransform|set|mpath|handler|listener)\b[^>]*\/?>/gi, "")
      .replace(/\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
      .replace(/\s(?:href|xlink:href|src|data|action|formaction)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

    if (typeof DOMParser !== "undefined") {
      const parser = new DOMParser();
      const doc = parser.parseFromString(cleaned, "image/svg+xml");
      const parserError = doc.querySelector("parsererror");
      if (parserError || !doc.documentElement || doc.documentElement.tagName.toLowerCase() !== "svg") {
        throw new Error("Malformed SVG XML structure.");
      }

      const allElements = [doc.documentElement, ...Array.from(doc.documentElement.querySelectorAll("*"))];
      for (const el of allElements) {
        const localName = (el.localName || el.tagName || "").toLowerCase();
        if (!ALLOWED_SVG_TAGS.has(localName)) {
          el.remove();
          continue;
        }

        if (localName === "style") {
          el.textContent = sanitizeCssStyleText(el.textContent);
        }

        for (const attr of Array.from(el.attributes || [])) {
          const attrName = attr.name.toLowerCase();
          const attrVal = (attr.value || "").trim();
          if (attrName.startsWith("on") || FORBIDDEN_SVG_ATTRS.has(attrName) || /^(?:javascript|data):/i.test(attrVal)) {
            el.removeAttribute(attr.name);
          } else if (attrName === "style") {
            const safeStyle = sanitizeCssStyleText(attrVal);
            if (safeStyle.trim()) {
              el.setAttribute("style", safeStyle);
            } else {
              el.removeAttribute("style");
            }
          } else if (/url\s*\(\s*['"]?\s*(?:https?:|data:|javascript:|\/\/)/i.test(attrVal)) {
            el.removeAttribute(attr.name);
          }
        }
      }

      cleaned = new XMLSerializer().serializeToString(doc.documentElement);
    }

    return new Blob([cleaned], { type: "image/svg+xml" });
  }

  async function convertRasterToWebP(sourceBlob, options = {}) {
    const maxDim = Number(options.maxDimension) || 2560;
    const quality = Math.min(1, Math.max(0.4, Number(options.quality) || 0.86));

    if (typeof createImageBitmap === "function" && typeof OffscreenCanvas !== "undefined") {
      const bitmap = await createImageBitmap(sourceBlob);
      try {
        let width = bitmap.width;
        let height = bitmap.height;
        if (width > maxDim || height > maxDim) {
          const scale = Math.min(maxDim / width, maxDim / height);
          width = Math.max(1, Math.round(width * scale));
          height = Math.max(1, Math.round(height * scale));
        }
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext("2d");
        ctx.drawImage(bitmap, 0, 0, width, height);
        const webpBlob = await canvas.convertToBlob({ type: "image/webp", quality });
        return {
          blob: webpBlob,
          width,
          height,
          originalBytes: sourceBlob.size,
          convertedBytes: webpBlob.size,
          savedBytes: sourceBlob.size - webpBlob.size
        };
      } finally {
        bitmap.close();
      }
    }

    if (typeof document !== "undefined" && typeof Image !== "undefined") {
      return new Promise((resolve, reject) => {
        const tempUrl = URL.createObjectURL(sourceBlob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(tempUrl);
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;
          if (!width || !height) {
            return reject(new Error("Image has invalid zero dimensions."));
          }
          if (width > maxDim || height > maxDim) {
            const scale = Math.min(maxDim / width, maxDim / height);
            width = Math.max(1, Math.round(width * scale));
            height = Math.max(1, Math.round(height * scale));
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          canvas.toBlob(
            (webpBlob) => {
              canvas.width = 0;
              canvas.height = 0;
              if (!webpBlob) return reject(new Error("Browser failed to encode WebP."));
              resolve({
                blob: webpBlob,
                width,
                height,
                originalBytes: sourceBlob.size,
                convertedBytes: webpBlob.size,
                savedBytes: sourceBlob.size - webpBlob.size
              });
            },
            "image/webp",
            quality
          );
        };
        img.onerror = () => {
          URL.revokeObjectURL(tempUrl);
          reject(new Error("Browser could not decode the selected image file."));
        };
        img.src = tempUrl;
      });
    }

    throw new Error("No suitable Canvas encoder available in this context.");
  }

  /**
   * Parse an MP4 (ISOBMFF) Blob/ArrayBuffer to extract individual track durations (`vide` vs `soun`)
   * from `moov -> trak -> mdia -> (mdhd + hdlr)` and `tkhd` / `edts -> elst` boxes.
   * When a video file has an audio track longer than its video track (causing an 18s frozen frame
   * with trailing audio before looping), `videoTrackDuration` gives the exact visual cutoff timestamp!
   */
  async function extractMp4TrackDurations(blobOrBuffer) {
    try {
      let buf = null;
      if (blobOrBuffer instanceof ArrayBuffer) {
        buf = blobOrBuffer;
      } else if (blobOrBuffer && typeof blobOrBuffer.arrayBuffer === "function") {
        // Read up to 16 MB or full blob if smaller; if moov is at the end of a larger file, inspect head & tail
        if (blobOrBuffer.size <= 24 * 1024 * 1024) {
          buf = await blobOrBuffer.arrayBuffer();
        } else {
          // Scan top-level boxes via slices to find `moov` without loading a huge `mdat` into memory
          let offset = 0;
          const totalSize = blobOrBuffer.size;
          while (offset + 8 <= totalSize) {
            const hdrBuf = await blobOrBuffer.slice(offset, Math.min(totalSize, offset + 16)).arrayBuffer();
            const hdrView = new DataView(hdrBuf);
            let boxSize = hdrView.getUint32(0);
            const type = String.fromCharCode(hdrView.getUint8(4), hdrView.getUint8(5), hdrView.getUint8(6), hdrView.getUint8(7));
            let hdrLen = 8;
            if (boxSize === 1 && hdrBuf.byteLength >= 16) {
              boxSize = Number(hdrView.getBigUint64(8));
              hdrLen = 16;
            } else if (boxSize === 0) {
              boxSize = totalSize - offset;
            }
            if (boxSize < hdrLen) break;
            if (type === "moov" && boxSize <= 16 * 1024 * 1024) {
              buf = await blobOrBuffer.slice(offset, offset + boxSize).arrayBuffer();
              break;
            }
            offset += boxSize;
          }
        }
      }
      if (!buf || buf.byteLength < 16) {
        return { movieDuration: null, videoTrackDuration: null, audioTrackDuration: null, tracks: [] };
      }

      const view = new DataView(buf);
      const readType = (pos) => String.fromCharCode(
        view.getUint8(pos),
        view.getUint8(pos + 1),
        view.getUint8(pos + 2),
        view.getUint8(pos + 3)
      );

      let movieTimescale = 0;
      let movieDuration = 0;
      const tracks = [];

      const parseContainer = (start, end, currentTrack) => {
        let cursor = start;
        while (cursor + 8 <= end && cursor + 8 <= buf.byteLength) {
          let boxSize = view.getUint32(cursor);
          const boxType = readType(cursor + 4);
          let headerSize = 8;
          if (boxSize === 1) {
            if (cursor + 16 > end || cursor + 16 > buf.byteLength) break;
            boxSize = Number(view.getBigUint64(cursor + 8));
            headerSize = 16;
          } else if (boxSize === 0) {
            boxSize = end - cursor;
          }
          if (boxSize < headerSize || cursor + boxSize > buf.byteLength) break;

          const contentStart = cursor + headerSize;
          const contentEnd = cursor + boxSize;

          if (boxType === "moov") {
            parseContainer(contentStart, contentEnd, null);
          } else if (boxType === "mvhd" && contentStart + 20 <= contentEnd) {
            const version = view.getUint8(contentStart);
            if (version === 1 && contentStart + 32 <= contentEnd) {
              movieTimescale = view.getUint32(contentStart + 20);
              movieDuration = Number(view.getBigUint64(contentStart + 24));
            } else {
              movieTimescale = view.getUint32(contentStart + 12);
              movieDuration = view.getUint32(contentStart + 16);
            }
          } else if (boxType === "trak") {
            const trk = {
              handlerType: null,
              mdhdTimescale: 0,
              mdhdDurationSec: null,
              tkhdDurationSec: null,
              elstDurationSec: null,
              sttsDurationSec: null,
              stszSampleCount: 0,
              stszNonEmptyRatio: 1
            };
            parseContainer(contentStart, contentEnd, trk);
            tracks.push(trk);
          } else if (boxType === "tkhd" && currentTrack && contentStart + 24 <= contentEnd) {
            const version = view.getUint8(contentStart);
            let rawDur = 0;
            if (version === 1 && contentStart + 36 <= contentEnd) {
              rawDur = Number(view.getBigUint64(contentStart + 28));
            } else if (version === 0 && contentStart + 24 <= contentEnd) {
              rawDur = view.getUint32(contentStart + 20);
            }
            if (movieTimescale > 0 && rawDur > 0) {
              currentTrack.tkhdDurationSec = rawDur / movieTimescale;
            }
          } else if ((boxType === "edts" || boxType === "mdia" || boxType === "minf" || boxType === "stbl") && currentTrack) {
            parseContainer(contentStart, contentEnd, currentTrack);
          } else if (boxType === "elst" && currentTrack && contentStart + 8 <= contentEnd) {
            const version = view.getUint8(contentStart);
            const entryCount = view.getUint32(contentStart + 4);
            let ePos = contentStart + 8;
            let totalElstDur = 0;
            for (let i = 0; i < entryCount; i++) {
              if (version === 1) {
                if (ePos + 20 > contentEnd) break;
                totalElstDur += Number(view.getBigUint64(ePos));
                ePos += 20;
              } else {
                if (ePos + 12 > contentEnd) break;
                totalElstDur += view.getUint32(ePos);
                ePos += 12;
              }
            }
            if (movieTimescale > 0 && totalElstDur > 0) {
              currentTrack.elstDurationSec = totalElstDur / movieTimescale;
            }
          } else if (boxType === "mdhd" && currentTrack && contentStart + 20 <= contentEnd) {
            const version = view.getUint8(contentStart);
            let ts = 0;
            let dur = 0;
            if (version === 1 && contentStart + 32 <= contentEnd) {
              ts = view.getUint32(contentStart + 20);
              dur = Number(view.getBigUint64(contentStart + 24));
            } else {
              ts = view.getUint32(contentStart + 12);
              dur = view.getUint32(contentStart + 16);
            }
            currentTrack.mdhdTimescale = ts;
            if (ts > 0 && dur > 0) {
              currentTrack.mdhdDurationSec = dur / ts;
            }
          } else if (boxType === "hdlr" && currentTrack && contentStart + 12 <= contentEnd) {
            currentTrack.handlerType = readType(contentStart + 8);
          } else if (boxType === "stts" && currentTrack && contentStart + 8 <= contentEnd) {
            // Decode Time-to-Sample box: detects exact sample deltas and abnormally stretched final frame delta
            const entryCount = view.getUint32(contentStart + 4);
            let sPos = contentStart + 8;
            let totalDelta = 0;
            let totalSamples = 0;
            let lastEntryCount = 0;
            let lastEntryDelta = 0;
            for (let i = 0; i < entryCount; i++) {
              if (sPos + 8 > contentEnd) break;
              const sc = view.getUint32(sPos);
              const sd = view.getUint32(sPos + 4);
              totalSamples += sc;
              totalDelta += sc * sd;
              lastEntryCount = sc;
              lastEntryDelta = sd;
              sPos += 8;
            }
            const ts = currentTrack.mdhdTimescale || movieTimescale;
            if (ts > 0 && totalDelta > 0) {
              // If the final stts entry is a single stretched hold frame (> 0.5s while normal frames are ~0.033s),
              // exclude that artificial trailing hold delta!
              let effectiveDelta = totalDelta;
              if (entryCount >= 2 && lastEntryCount <= 2 && totalSamples > 10) {
                const lastFrameSec = (lastEntryCount * lastEntryDelta) / ts;
                const avgPriorFrameSec = ((totalDelta - lastEntryCount * lastEntryDelta) / Math.max(1, totalSamples - lastEntryCount)) / ts;
                if (lastFrameSec > 0.5 && avgPriorFrameSec > 0 && lastFrameSec > avgPriorFrameSec * 6) {
                  effectiveDelta -= lastEntryCount * lastEntryDelta;
                }
              }
              currentTrack.sttsDurationSec = effectiveDelta / ts;
            }
          } else if (boxType === "stsz" && currentTrack && contentStart + 12 <= contentEnd) {
            // Sample Size box: detects if trailing video frames are tiny duplicate/frozen P/B repeat packets
            const uniformSize = view.getUint32(contentStart + 4);
            const sampleCount = view.getUint32(contentStart + 8);
            currentTrack.stszSampleCount = sampleCount;
            if (uniformSize === 0 && sampleCount > 20 && contentStart + 12 + sampleCount * 4 <= contentEnd) {
              // Compute average sample size across the first half of the video (active motion)
              const activeSampleCount = Math.max(10, Math.floor(sampleCount * 0.45));
              let sumFirstHalf = 0;
              for (let i = 0; i < activeSampleCount; i++) {
                sumFirstHalf += view.getUint32(contentStart + 12 + i * 4);
              }
              const avgActiveSampleBytes = sumFirstHalf / activeSampleCount;
              // A frozen/static frame tail in H.264/HEVC encodes P/B frames that are < 8% of normal motion frame size (or < 180 bytes)
              // while any keyframes (IDR) inside the static tail appear only once every 30-250 frames.
              // Scan backward and require at least 5 out of 6 consecutive frames to exceed the motion threshold
              // so isolated static IDR keyframes don't mask a frozen tail AND active motion frames aren't diluted!
              const freezeThresholdBytes = Math.max(180, Math.min(1200, avgActiveSampleBytes * 0.08));
              let lastRealSampleIdx = sampleCount - 1;
              while (lastRealSampleIdx > 6) {
                let motionFramesInWindow = 0;
                const winLen = Math.min(6, lastRealSampleIdx + 1);
                for (let w = 0; w < winLen; w++) {
                  if (view.getUint32(contentStart + 12 + (lastRealSampleIdx - w) * 4) > freezeThresholdBytes) {
                    motionFramesInWindow++;
                  }
                }
                if (motionFramesInWindow >= 4) break;
                lastRealSampleIdx--;
              }
              if (lastRealSampleIdx < sampleCount - 15) {
                currentTrack.stszNonEmptyRatio = (lastRealSampleIdx + 1) / sampleCount;
              }
            }
          }

          cursor += boxSize;
        }
      };

      parseContainer(0, buf.byteLength, null);

      const movieDurationSec = movieTimescale > 0 && movieDuration > 0 ? movieDuration / movieTimescale : null;
      let videoTrackDuration = null;
      let audioTrackDuration = null;

      for (const t of tracks) {
        const candidates = [t.mdhdDurationSec, t.tkhdDurationSec, t.elstDurationSec, t.sttsDurationSec].filter(
          (v) => typeof v === "number" && Number.isFinite(v) && v > 0.1
        );
        if (candidates.length === 0) continue;
        // Use the shortest positive duration reported across mdhd / tkhd / elst / stts for that track
        let effectiveTrackDur = Math.min(...candidates);
        if (t.handlerType === "vide" && typeof t.stszNonEmptyRatio === "number" && t.stszNonEmptyRatio < 0.96) {
          effectiveTrackDur = Math.max(0.25, effectiveTrackDur * t.stszNonEmptyRatio);
        }
        if (t.handlerType === "vide") {
          videoTrackDuration = videoTrackDuration === null ? effectiveTrackDur : Math.min(videoTrackDuration, effectiveTrackDur);
        } else if (t.handlerType === "soun") {
          audioTrackDuration = audioTrackDuration === null ? effectiveTrackDur : Math.max(audioTrackDuration, effectiveTrackDur);
        }
      }

      return {
        movieDuration: movieDurationSec,
        videoTrackDuration,
        audioTrackDuration,
        tracks
      };
    } catch (_) {
      return { movieDuration: null, videoTrackDuration: null, audioTrackDuration: null, tracks: [] };
    }
  }

  async function inspectMediaMetadata(blob, mimeType) {
    if (mimeType === "image/svg+xml") {
      return { width: null, height: null, duration: null };
    }
    if (mimeType.startsWith("image/")) {
      if (typeof createImageBitmap === "function") {
        const bmp = await createImageBitmap(blob);
        const meta = { width: bmp.width, height: bmp.height, duration: null };
        bmp.close();
        return meta;
      }
      if (typeof Image !== "undefined") {
        return new Promise((resolve, reject) => {
          const u = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            URL.revokeObjectURL(u);
            resolve({ width: img.naturalWidth, height: img.naturalHeight, duration: null });
          };
          img.onerror = () => {
            URL.revokeObjectURL(u);
            reject(new Error("Corrupt or unsupported image file."));
          };
          img.src = u;
        });
      }
      return { width: null, height: null, duration: null };
    }

    if (mimeType.startsWith("video/")) {
      const mp4Meta = mimeType === "video/mp4"
        ? await extractMp4TrackDurations(blob)
        : { movieDuration: null, videoTrackDuration: null, audioTrackDuration: null };
      if (typeof document !== "undefined") {
        const probeVideo = document.createElement("video");
        const canPlay = probeVideo.canPlayType(mimeType);
        if (canPlay === "") {
          throw new Error(`Your browser does not support decoding ${mimeType} videos.`);
        }
        return new Promise((resolve, reject) => {
          const u = URL.createObjectURL(blob);
          probeVideo.preload = "metadata";
          probeVideo.muted = true;
          const cleanup = () => {
            probeVideo.removeAttribute("src");
            try { probeVideo.load(); } catch (_) {}
            URL.revokeObjectURL(u);
          };
          probeVideo.onloadedmetadata = () => {
            const rawDur = Number.isFinite(probeVideo.duration) ? probeVideo.duration : null;
            const effectiveDur = (mp4Meta.videoTrackDuration && rawDur && rawDur > mp4Meta.videoTrackDuration + 0.08)
              ? mp4Meta.videoTrackDuration
              : rawDur;
            const meta = {
              width: probeVideo.videoWidth || null,
              height: probeVideo.videoHeight || null,
              duration: effectiveDur ? Math.round(effectiveDur * 10) / 10 : null,
              videoTrackDuration: mp4Meta.videoTrackDuration || null,
              audioTrackDuration: mp4Meta.audioTrackDuration || null
            };
            cleanup();
            resolve(meta);
          };
          probeVideo.onerror = () => {
            cleanup();
            reject(new Error(`Browser failed to decode video stream (${mimeType}). Try WebM (VP9) or MP4 (H.264).`));
          };
          probeVideo.src = u;
        });
      }
      return {
        width: null,
        height: null,
        duration: mp4Meta.videoTrackDuration ? Math.round(mp4Meta.videoTrackDuration * 10) / 10 : null,
        videoTrackDuration: mp4Meta.videoTrackDuration || null,
        audioTrackDuration: mp4Meta.audioTrackDuration || null
      };
    }

    throw new Error(`Unsupported media type: ${mimeType}`);
  }

  /**
   * Import a media File/Blob into the shared extension IndexedDB with configurable size limits.
   */
  async function importMediaItem(fileOrBlob, options = {}) {
    if (!fileOrBlob || typeof fileOrBlob.size !== "number" || fileOrBlob.size <= 0) {
      throw new Error("Selected file is empty or unreadable.");
    }

    const maxAllowedBytes = Number(options.maxMediaSizeBytes) || DEFAULT_MAX_MEDIA_BYTES;
    const warnThresholdBytes = Number(options.warnMediaSizeBytes) || DEFAULT_WARN_MEDIA_BYTES;

    if (fileOrBlob.size > maxAllowedBytes) {
      throw new Error(
        `File size (${formatBytes(fileOrBlob.size)}) exceeds the configured maximum limit of ${formatBytes(maxAllowedBytes)}. Please compress the file or increase the limit in Settings.`
      );
    }

    let mimeType = (fileOrBlob.type || options.mimeType || "").toLowerCase().trim();
    const rawName = String(fileOrBlob.name || options.name || "untitled-media").trim();

    if (!mimeType) {
      if (/\.webp$/i.test(rawName)) mimeType = "image/webp";
      else if (/\.avif$/i.test(rawName)) mimeType = "image/avif";
      else if (/\.png$/i.test(rawName)) mimeType = "image/png";
      else if (/\.jpe?g$/i.test(rawName)) mimeType = "image/jpeg";
      else if (/\.gif$/i.test(rawName)) mimeType = "image/gif";
      else if (/\.svg$/i.test(rawName)) mimeType = "image/svg+xml";
      else if (/\.webm$/i.test(rawName)) mimeType = "video/webm";
      else if (/\.mp4$/i.test(rawName)) mimeType = "video/mp4";
      else if (/\.ogv|\.ogg$/i.test(rawName)) mimeType = "video/ogg";
    }

    const isImage = SUPPORTED_IMAGE_MIMES.has(mimeType);
    const isVideo = SUPPORTED_VIDEO_MIMES.has(mimeType);
    if (!isImage && !isVideo) {
      throw new Error(
        `Unsupported file format "${mimeType || rawName}". Supported images: WebP, AVIF, PNG, JPEG, GIF, SVG. Supported videos: WebM, MP4, Ogg.`
      );
    }

    let workingBlob = fileOrBlob instanceof Blob
      ? fileOrBlob
      : new Blob([fileOrBlob], { type: mimeType });

    let animatedGif = false;
    if (mimeType === "image/gif") {
      animatedGif = await isAnimatedGif(workingBlob);
    } else if (mimeType === "image/svg+xml") {
      workingBlob = await sanitizeSvgBlob(workingBlob);
    }

    const meta = options.skipMetadataProbe
      ? { width: null, height: null, duration: null }
      : await inspectMediaMetadata(workingBlob, mimeType);

    let finalBlob = workingBlob;
    let finalMime = mimeType;
    let finalName = rawName;
    let width = meta.width;
    let height = meta.height;
    const sizeWarning = workingBlob.size > warnThresholdBytes
      ? `Large media file (${formatBytes(workingBlob.size)}): consider WebP or shorter WebM loops to reduce storage and memory footprint.`
      : null;

    let conversionReport = {
      attempted: false,
      converted: false,
      originalMime: mimeType,
      originalBytes: workingBlob.size,
      finalBytes: workingBlob.size,
      savedBytes: 0,
      keptOriginalId: null,
      sizeWarning,
      reason: sizeWarning
    };

    const canConvertRaster = (mimeType === "image/png" || mimeType === "image/jpeg") && !animatedGif;
    const shouldConvert = options.convertToWebP === true && canConvertRaster;

    const db = await openExtensionMediaDB();
    const savedRecords = [];

    if (shouldConvert && options.preserveOriginal !== false) {
      const origId = "media_orig_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
      const origRecord = {
        id: origId,
        name: rawName + " (Original)",
        mimeType,
        mediaType: "image",
        size: workingBlob.size,
        width,
        height,
        duration: null,
        isAnimated: false,
        isOriginalBackup: true,
        createdAt: Date.now() - 1,
        blob: workingBlob
      };
      await putRecordWithQuotaGuard(db, origRecord);
      savedRecords.push(origRecord);
      conversionReport.keptOriginalId = origId;
    }

    if (shouldConvert) {
      conversionReport.attempted = true;
      try {
        const result = await convertRasterToWebP(workingBlob, {
          maxDimension: options.maxDimension || 2560,
          quality: options.quality || 0.86
        });
        if (result.blob && result.blob.size < workingBlob.size) {
          finalBlob = result.blob;
          finalMime = "image/webp";
          finalName = rawName.replace(/\.(png|jpe?g)$/i, "") + ".webp";
          width = result.width;
          height = result.height;
          conversionReport.converted = true;
          conversionReport.finalBytes = finalBlob.size;
          conversionReport.savedBytes = workingBlob.size - finalBlob.size;
          conversionReport.reason = `Converted to WebP: reduced file storage by ${formatBytes(conversionReport.savedBytes)}.`;
        } else {
          conversionReport.reason = "Original file was already smaller than or equal to WebP output; kept original.";
        }
      } catch (convErr) {
        conversionReport.reason = `WebP conversion skipped (${convErr.message}); kept original file.`;
      }
    } else if (mimeType === "image/gif" && animatedGif) {
      conversionReport.reason = "Animated GIF detected: preserved multi-frame GIF without static conversion.";
    } else if (mimeType === "image/svg+xml") {
      conversionReport.reason = "Vector SVG sanitized and preserved natively without rasterization.";
    }

    const primaryId = options.id || ("media_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
    const primaryRecord = {
      id: primaryId,
      name: finalName,
      mimeType: finalMime,
      mediaType: isVideo ? "video" : "image",
      size: finalBlob.size,
      originalBytes: workingBlob.size,
      savedBytes: conversionReport.savedBytes,
      width,
      height,
      duration: meta.duration,
      videoTrackDuration: meta.videoTrackDuration || null,
      audioTrackDuration: meta.audioTrackDuration || null,
      isAnimated: animatedGif,
      originalBackupId: conversionReport.keptOriginalId,
      conversionReport,
      createdAt: Date.now(),
      blob: finalBlob
    };

    await putRecordWithQuotaGuard(db, primaryRecord);
    savedRecords.unshift(primaryRecord);

    return {
      primaryRecord: stripBlobFromMetadata(primaryRecord),
      allSaved: savedRecords.map(stripBlobFromMetadata),
      conversionReport
    };
  }

  function putRecordWithQuotaGuard(db, record) {
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(MEDIA_STORE, "readwrite");
      } catch (err) {
        dbInstancePromise = null;
        return reject(err);
      }
      const req = tx.objectStore(MEDIA_STORE).put(record);
      req.onerror = () => {
        const err = req.error;
        if (err && (err.name === "QuotaExceededError" || /quota/i.test(err.message || ""))) {
          reject(new Error("Browser storage quota exceeded. Existing files were preserved; please delete unused items from the Media Library."));
        } else {
          reject(err || new Error("Failed to write media record to IndexedDB."));
        }
      };
      tx.oncomplete = () => resolve(record);
      tx.onerror = () => {
        const err = tx.error;
        if (err && (err.name === "QuotaExceededError" || /quota/i.test(err.message || ""))) {
          reject(new Error("Browser storage quota exceeded. Existing files were preserved; please delete unused items from the Media Library."));
        } else {
          reject(err || new Error("IndexedDB transaction failed."));
        }
      };
    });
  }

  function stripBlobFromMetadata(rec) {
    if (!rec) return null;
    const { blob, ...metadata } = rec;
    return metadata;
  }

  async function listMediaMetadata(filterOptions = {}) {
    let records = [];
    if (typeof indexedDB !== "undefined") {
      try {
        const db = await openExtensionMediaDB();
        records = await new Promise((resolve, reject) => {
          const tx = db.transaction(MEDIA_STORE, "readonly");
          const req = tx.objectStore(MEDIA_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      } catch (_) {}
    }

    let items = records.map(stripBlobFromMetadata);
    if (filterOptions.includePresets !== false) {
      items = [...BUILTIN_PRESETS, ...items];
    }
    if (filterOptions.mediaType && filterOptions.mediaType !== "all") {
      items = items.filter((item) => item.mediaType === filterOptions.mediaType);
    }
    if (filterOptions.query && filterOptions.query.trim()) {
      const q = filterOptions.query.trim().toLowerCase();
      items = items.filter(
        (item) =>
          (item.name || "").toLowerCase().includes(q) ||
          (item.mimeType || "").toLowerCase().includes(q)
      );
    }

    const sortBy = filterOptions.sortBy || "newest";
    items.sort((a, b) => {
      if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
      if (sortBy === "size-desc") return (b.size || 0) - (a.size || 0);
      if (sortBy === "size-asc") return (a.size || 0) - (b.size || 0);
      if (sortBy === "oldest") return (a.createdAt || 0) - (b.createdAt || 0);
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return items;
  }

  async function getMediaRecordWithBlob(id) {
    if (!id) return null;
    if (id.startsWith("preset_")) {
      return BUILTIN_PRESETS.find((p) => p.id === id) || null;
    }
    if (typeof indexedDB === "undefined") return null;
    const db = await openExtensionMediaDB();
    return new Promise((resolve) => {
      const tx = db.transaction(MEDIA_STORE, "readonly");
      const req = tx.objectStore(MEDIA_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function deleteMediaRecord(id) {
    if (!id || id.startsWith("preset_") || typeof indexedDB === "undefined") return false;
    const db = await openExtensionMediaDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE, "readwrite");
      tx.objectStore(MEDIA_STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getStorageUsageStats() {
    let records = [];
    if (typeof indexedDB !== "undefined") {
      try {
        const db = await openExtensionMediaDB();
        records = await new Promise((resolve, reject) => {
          const tx = db.transaction(MEDIA_STORE, "readonly");
          const req = tx.objectStore(MEDIA_STORE).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      } catch (_) {}
    }

    let totalBytes = 0;
    let imageCount = 0;
    let videoCount = 0;
    for (const r of records) {
      totalBytes += r.size || (r.blob ? r.blob.size : 0) || 0;
      if (r.mediaType === "video") videoCount++;
      else imageCount++;
    }

    let quotaBytes = null;
    if (typeof navigator !== "undefined" && navigator.storage && typeof navigator.storage.estimate === "function") {
      try {
        const est = await navigator.storage.estimate();
        quotaBytes = est.quota || null;
      } catch (_) {}
    }

    return {
      itemCount: records.length,
      imageCount,
      videoCount,
      totalBytes,
      formattedTotal: formatBytes(totalBytes),
      quotaBytes
    };
  }

  // =========================================================================
  // 2. BOUNDED, CANCELLATION-AWARE CHUNKED MEDIA TRANSPORT ENGINE
  // =========================================================================
  /**
   * Compute incremental 32-bit FNV-1a checksum over a Uint8Array chunk.
   */
  function updateFnv1a32(bytes, hash = 0x811c9dc5) {
    let h = hash >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function uint8SliceToBase64(bytes) {
    let binary = "";
    const step = 0x4000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(binary);
  }

  function base64ToUint8Slice(b64) {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  /**
   * Create a bounded, cancellation-aware sender session that slices a Blob into
   * fixed-size chunks (`chunkSizeBytes`, default 256 KB) lazily on demand.
   * Never converts the entire file into Base64 at once; only a single 256 KB slice
   * is read and encoded per acknowledged step.
   */
  function createBoundedBlobSenderSession(record, options = {}) {
    const blob = record.blob;
    if (!blob || typeof blob.size !== "number") {
      throw new Error("Invalid Blob for transfer session.");
    }
    const maxBytes = Number(options.maxMediaSizeBytes) || DEFAULT_MAX_MEDIA_BYTES;
    if (blob.size > maxBytes) {
      throw new Error(
        `Media size (${formatBytes(blob.size)}) exceeds the maximum transfer limit of ${formatBytes(maxBytes)}.`
      );
    }

    const chunkSize = Math.max(4096, Number(options.chunkSizeBytes) || DEFAULT_CHUNK_SIZE_BYTES);
    const totalBytes = blob.size;
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
    const transferId = options.transferId || ("tx_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9));

    let currentChunkIndex = 0;
    let runningHash = 0x811c9dc5;
    let cancelled = false;
    let completed = false;

    const { blob: _omitted, ...metadata } = record;

    async function readNextChunkPacket() {
      if (cancelled) throw new Error(`Transfer ${transferId} was cancelled.`);
      if (completed || currentChunkIndex >= totalChunks) return null;

      const idx = currentChunkIndex;
      const start = idx * chunkSize;
      const end = Math.min(totalBytes, start + chunkSize);
      const sliceBlob = blob.slice(start, end);
      const buf = await sliceBlob.arrayBuffer();
      if (cancelled) throw new Error(`Transfer ${transferId} was cancelled.`);

      const bytes = new Uint8Array(buf);
      runningHash = updateFnv1a32(bytes, runningHash);
      currentChunkIndex++;

      const isFinalChunk = currentChunkIndex >= totalChunks;
      if (isFinalChunk) completed = true;

      return {
        transferId,
        chunkIndex: idx,
        totalChunks,
        byteLength: bytes.length,
        totalBytes,
        chunkBase64: uint8SliceToBase64(bytes),
        checksumSoFar: runningHash >>> 0,
        isFinalChunk
      };
    }

    function cancel() {
      cancelled = true;
    }

    return {
      transferId,
      metadata,
      mimeType: blob.type || record.mimeType || "application/octet-stream",
      totalBytes,
      totalChunks,
      chunkSize,
      readNextChunkPacket,
      cancel,
      isCancelled: () => cancelled,
      isCompleted: () => completed
    };
  }

  /**
   * Create a bounded receiver accumulator that validates chunk ordering, size limits,
   * and final FNV-1a checksum before assembling the final `Blob(parts)` without intermediate concatenation.
   */
  function createBoundedBlobReceiverSession(initPacket, options = {}) {
    const {
      transferId,
      metadata,
      mimeType,
      totalBytes,
      totalChunks
    } = initPacket || {};

    if (!transferId || typeof totalBytes !== "number" || totalBytes < 0 || !totalChunks || totalChunks < 1) {
      throw new Error("Invalid transfer initialization packet.");
    }

    const maxBytes = Number(options.maxMediaSizeBytes) || DEFAULT_MAX_MEDIA_BYTES;
    if (totalBytes > maxBytes) {
      throw new Error(
        `Incoming media (${formatBytes(totalBytes)}) exceeds the maximum limit of ${formatBytes(maxBytes)}.`
      );
    }

    const parts = [];
    let receivedBytes = 0;
    let expectedChunkIndex = 0;
    let runningHash = 0x811c9dc5;
    let disposed = false;

    function acceptChunkPacket(packet) {
      if (disposed) {
        throw new Error(`Receiver session ${transferId} is already disposed.`);
      }
      if (!packet || packet.transferId !== transferId) {
        throw new Error(`Transfer ID mismatch: expected ${transferId}, got ${packet?.transferId}.`);
      }
      if (packet.chunkIndex !== expectedChunkIndex) {
        throw new Error(`Out-of-order chunk in ${transferId}: expected index ${expectedChunkIndex}, got ${packet.chunkIndex}.`);
      }

      const bytes = base64ToUint8Slice(packet.chunkBase64 || "");
      if (bytes.length !== packet.byteLength) {
        throw new Error(`Chunk ${packet.chunkIndex} byte length mismatch (${bytes.length} vs ${packet.byteLength}).`);
      }
      if (receivedBytes + bytes.length > totalBytes) {
        dispose();
        throw new Error(`Transfer ${transferId} overflowed declared size (${totalBytes} B).`);
      }

      runningHash = updateFnv1a32(bytes, runningHash);
      parts.push(bytes);
      receivedBytes += bytes.length;
      expectedChunkIndex++;

      return {
        acknowledgedChunkIndex: packet.chunkIndex,
        receivedBytes,
        isComplete: expectedChunkIndex === totalChunks
      };
    }

    function finalize(expectedChecksum) {
      if (disposed) {
        throw new Error(`Cannot finalize disposed transfer ${transferId}.`);
      }
      if (expectedChunkIndex !== totalChunks || receivedBytes !== totalBytes) {
        dispose();
        throw new Error(
          `Incomplete transfer ${transferId}: received ${receivedBytes}/${totalBytes} bytes across ${expectedChunkIndex}/${totalChunks} chunks.`
        );
      }
      if (expectedChecksum !== undefined && (runningHash >>> 0) !== (expectedChecksum >>> 0)) {
        dispose();
        throw new Error(`Integrity checksum mismatch for transfer ${transferId}.`);
      }
      const reconstructedBlob = new Blob(parts, { type: mimeType || "application/octet-stream" });
      parts.length = 0;
      disposed = true;
      return {
        transferId,
        record: metadata,
        blob: reconstructedBlob,
        totalBytes: reconstructedBlob.size,
        checksum: runningHash >>> 0
      };
    }

    function dispose() {
      parts.length = 0;
      receivedBytes = 0;
      disposed = true;
    }

    return {
      transferId,
      totalBytes,
      totalChunks,
      acceptChunkPacket,
      finalize,
      dispose,
      isDisposed: () => disposed
    };
  }

  // =========================================================================
  // 3. CONFLICT-SAFE ORIGIN-SCOPED SITE CONFIGURATION STORAGE & MIGRATION
  // =========================================================================
  let storageMutexChain = Promise.resolve();

  function withStorageLock(taskFn) {
    const next = storageMutexChain.then(() => taskFn());
    storageMutexChain = next.catch(() => {});
    return next;
  }

  /**
   * Compute canonical site identity from a URL or Location object.
   * Defaults to exact origin (`protocol://hostname:port`).
   */
  function deriveSiteIdentity(urlOrLocation) {
    try {
      const u = typeof urlOrLocation === "string"
        ? new URL(urlOrLocation)
        : new URL(urlOrLocation.href || `${urlOrLocation.protocol}//${urlOrLocation.host}`);
      if (u.protocol === "file:") {
        const cleanPath = (u.pathname || "/").replace(/\/[^/]*$/, "") || "/";
        return {
          originKey: `file://${cleanPath}`,
          protocol: "file:",
          hostname: "local-file",
          port: "",
          hostWithPort: "local-file"
        };
      }
      const originKey = `${u.protocol}//${u.hostname}${u.port ? ":" + u.port : ""}`.toLowerCase();
      return {
        originKey,
        protocol: u.protocol.toLowerCase(),
        hostname: u.hostname.toLowerCase(),
        port: u.port || "",
        hostWithPort: `${u.hostname}${u.port ? ":" + u.port : ""}`.toLowerCase()
      };
    } catch (_) {
      const raw = String(urlOrLocation || "local-page").trim().toLowerCase();
      if (/^https?:\/\//.test(raw)) {
        return { originKey: raw, protocol: raw.split("//")[0], hostname: raw.split("//")[1] || raw, port: "", hostWithPort: raw.split("//")[1] || raw };
      }
      return {
        originKey: `https://${raw}`,
        protocol: "https:",
        hostname: raw.replace(/:\d+$/, ""),
        port: (raw.match(/:(\d+)$/) || ["", ""])[1],
        hostWithPort: raw
      };
    }
  }

  function makeStorageKeyForSite(siteKey) {
    return `${SITE_KEY_PREFIX}${siteKey}`;
  }

  /**
   * Build a stable extension-storage key for legacy media migration performed by a
   * top-level HTTP(S) page. Keep it separate by exact origin, including port.
   */
  function legacyPageMediaMigrationStorageKey(rawOrigin) {
    let parsed;
    try { parsed = new URL(String(rawOrigin || "")); }
    catch (_) { throw new Error("Invalid origin for legacy media migration marker."); }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Legacy media migration markers require an HTTP or HTTPS origin.");
    }
    if (parsed.origin === "null") throw new Error("Opaque origins cannot have legacy media migration markers.");
    return `legacyPageMediaMigration::${encodeURIComponent(parsed.origin.toLowerCase())}`;
  }

  /**
   * Check whether a candidate stored site record applies to a given page URL/Location
   * according to its configured `matchScope` (`"origin"` | `"hostname"` | `"subdomain"`).
   */
  function doesSiteRecordMatchIdentity(record, pageIdentity) {
    if (!record || !pageIdentity) return { matches: false, specificity: 0 };
    const scope = record.matchScope || "origin";
    const recId = deriveSiteIdentity(record.siteKey || record.originKey || record.hostname || "");

    if (scope === "origin") {
      if (record.siteKey === pageIdentity.originKey || recId.originKey === pageIdentity.originKey) {
        return { matches: true, specificity: 300 };
      }
      return { matches: false, specificity: 0 };
    }

    if (scope === "hostname") {
      if (recId.hostname === pageIdentity.hostname && recId.port === pageIdentity.port) {
        return { matches: true, specificity: 220 };
      }
      if (recId.hostname === pageIdentity.hostname) {
        return { matches: true, specificity: 200 };
      }
      return { matches: false, specificity: 0 };
    }

    if (scope === "subdomain") {
      if (recId.hostname === pageIdentity.hostname) {
        return { matches: true, specificity: 150 };
      }
      if (pageIdentity.hostname.endsWith("." + recId.hostname)) {
        return { matches: true, specificity: 100 + recId.hostname.length };
      }
      return { matches: false, specificity: 0 };
    }

    return { matches: false, specificity: 0 };
  }

  /**
   * One-time safe migration from legacy v2.0 `siteConfigs` (keyed by bare hostname)
   * to v2.0.1 per-site keys (`siteCfg::<siteKey>`).
   * - Never deletes the original `siteConfigs` before verification.
   * - Stores a permanent recovery copy in `legacySiteConfigsBackup_v2_0`.
   * - Detects conflicts if a per-site key already exists and records both for recovery.
   */
  async function migrateLegacySiteConfigsOnce(storageArea) {
    if (!storageArea) return { migrated: false, reason: "no-storage" };
    return withStorageLock(async () => {
      const existing = await storageArea.get([MIGRATION_STATE_KEY, "siteConfigs", SITE_INDEX_KEY]);
      if (existing[MIGRATION_STATE_KEY] && existing[MIGRATION_STATE_KEY].completed === true) {
        return { migrated: false, alreadyCompleted: true, state: existing[MIGRATION_STATE_KEY] };
      }

      const legacyMap = existing.siteConfigs;
      const indexMap = existing[SITE_INDEX_KEY] && typeof existing[SITE_INDEX_KEY] === "object"
        ? { ...existing[SITE_INDEX_KEY] }
        : {};
      const conflicts = [];
      let migratedCount = 0;

      if (legacyMap && typeof legacyMap === "object" && !Array.isArray(legacyMap)) {
        await storageArea.set({ [LEGACY_BACKUP_KEY]: JSON.parse(JSON.stringify(legacyMap)) });

        for (const [legacyKey, rawConfig] of Object.entries(legacyMap)) {
          if (!rawConfig || typeof rawConfig !== "object" || Array.isArray(rawConfig)) {
            conflicts.push({ legacyKey, reason: "malformed-legacy-record" });
            continue;
          }

          const identity = deriveSiteIdentity(legacyKey);
          const canonicalSiteKey = /^https?:\/\/|^file:\/\//i.test(legacyKey)
            ? identity.originKey
            : `https://${identity.hostWithPort}`;
          const storageKey = makeStorageKeyForSite(canonicalSiteKey);

          const currentStored = await storageArea.get([storageKey]);
          const existingV201 = currentStored[storageKey];

          const normalizedComponents = {};
          for (const [compKey, compVal] of Object.entries(rawConfig.components || {})) {
            if (!compVal || typeof compVal !== "object") continue;
            const isWholePage = compKey === "body" || compKey === "root_page";
            const cid = isWholePage ? "root_page" : compKey;
            normalizedComponents[cid] = {
              ...compVal,
              id: cid,
              locator: compVal.locator || {
                id: cid,
                isWholePage,
                label: compVal.friendlyName || (isWholePage ? "Entire Website" : "Page Area"),
                tagName: isWholePage ? "body" : "div",
                fallbackSelector: compKey
              }
            };
          }

          const migratedRecord = {
            siteKey: canonicalSiteKey,
            hostname: identity.hostname,
            // Legacy configs were hostname-keyed, so preserve hostname matching unless already origin-scoped
            matchScope: rawConfig.matchScope || (/^https?:\/\//i.test(legacyKey) ? "origin" : "hostname"),
            enabled: rawConfig.enabled !== false,
            revision: Number(rawConfig.revision) || 1,
            updatedAt: rawConfig.updatedAt || Date.now(),
            migratedFromLegacyKey: legacyKey,
            components: normalizedComponents
          };

          if (existingV201 && JSON.stringify(existingV201.components) !== JSON.stringify(migratedRecord.components)) {
            // Conflict detected: preserve both by writing a recovery record and keeping the newer one
            const conflictBackupKey = `siteCfgConflict::${canonicalSiteKey}::${Date.now()}`;
            await storageArea.set({ [conflictBackupKey]: migratedRecord });
            conflicts.push({
              legacyKey,
              siteKey: canonicalSiteKey,
              conflictBackupKey,
              reason: "existing-v201-record-differs"
            });
          } else {
            await storageArea.set({ [storageKey]: migratedRecord });
            indexMap[canonicalSiteKey] = {
              siteKey: canonicalSiteKey,
              hostname: identity.hostname,
              matchScope: migratedRecord.matchScope,
              revision: migratedRecord.revision,
              updatedAt: migratedRecord.updatedAt
            };
            migratedCount++;
          }
        }
      }

      const migrationState = {
        completed: true,
        version: "2.0.1",
        migratedCount,
        conflicts,
        completedAt: Date.now()
      };

      await storageArea.set({
        [SITE_INDEX_KEY]: indexMap,
        [MIGRATION_STATE_KEY]: migrationState
      });

      return { migrated: true, migratedCount, conflicts, state: migrationState };
    });
  }

  /**
   * Resolve the best-matching site configuration for a page URL or origin/hostname identifier.
   * Specificity order:
   * 1. Exact origin key match (`https://example.com:8443`)
   * 2. Hostname scope match (`example.com` across http/https)
   * 3. Subdomain scope match (`*.example.com`)
   */
  async function getSiteConfigForTarget(storageArea, targetUrlOrKey) {
    const identity = deriveSiteIdentity(targetUrlOrKey);
    const directStorageKey = makeStorageKeyForSite(identity.originKey);

    const initialFetch = await storageArea.get([directStorageKey, SITE_INDEX_KEY, "globalSettings"]);
    const globalSettings = initialFetch.globalSettings || {};
    const matchedTheme = await findThemeForTarget(storageArea, targetUrlOrKey);

    const applyThemeIfPresent = (record) => {
      if (!matchedTheme) return record;
      const cloned = JSON.parse(JSON.stringify(record));
      if (!cloned.components || Object.keys(cloned.components).length === 0) {
        if (matchedTheme.defaultMedia?.mediaId || (Array.isArray(matchedTheme.defaultMedia?.playlist) && matchedTheme.defaultMedia.playlist.length > 0)) {
          cloned.components = {
            root_page: {
              id: "root_page",
              friendlyName: "Entire Website",
              locator: { id: "root_page", isWholePage: true, label: "Entire Website", tagName: "body" }
            }
          };
        }
      }
      return resolveEffectiveConfig(cloned, matchedTheme, globalSettings);
    };

    if (initialFetch[directStorageKey]) {
      return {
        matched: true,
        siteKey: identity.originKey,
        siteConfig: applyThemeIfPresent(initialFetch[directStorageKey]),
        domainTheme: matchedTheme || null
      };
    }

    const indexMap = initialFetch[SITE_INDEX_KEY] || {};
    const candidateKeys = Object.keys(indexMap).map(makeStorageKeyForSite);
    if (candidateKeys.length > 0) {
      const allStored = await storageArea.get(candidateKeys);
      let bestRecord = null;
      let bestSpecificity = 0;

      for (const record of Object.values(allStored)) {
        if (!record || typeof record !== "object") continue;
        const evalMatch = doesSiteRecordMatchIdentity(record, identity);
        if (evalMatch.matches && evalMatch.specificity > bestSpecificity) {
          bestSpecificity = evalMatch.specificity;
          bestRecord = record;
        }
      }

      if (bestRecord) {
        return {
          matched: true,
          siteKey: bestRecord.siteKey,
          siteConfig: applyThemeIfPresent(bestRecord),
          domainTheme: matchedTheme || null
        };
      }
    }

    const defaultConfig = {
      siteKey: identity.originKey,
      hostname: identity.hostname,
      matchScope: "origin",
      enabled: true,
      revision: 0,
      updatedAt: null,
      components: {}
    };

    if (matchedTheme) {
      return {
        matched: true,
        siteKey: identity.originKey,
        siteConfig: applyThemeIfPresent(defaultConfig),
        domainTheme: matchedTheme
      };
    }

    return {
      matched: false,
      siteKey: identity.originKey,
      siteConfig: defaultConfig,
      domainTheme: null
    };
  }

  async function saveSiteConfigConflictSafeUnlocked(storageArea, rawSiteKey, incomingConfig, options = {}) {
      const identity = deriveSiteIdentity(rawSiteKey);
      const siteKey = /^https?:\/\/|^file:\/\//i.test(rawSiteKey)
        ? identity.originKey
        : (incomingConfig?.siteKey || identity.originKey);
      const storageKey = makeStorageKeyForSite(siteKey);

      const stored = await storageArea.get([storageKey, SITE_INDEX_KEY]);
      const currentRecord = stored[storageKey] || null;
      const indexMap = stored[SITE_INDEX_KEY] && typeof stored[SITE_INDEX_KEY] === "object"
        ? { ...stored[SITE_INDEX_KEY] }
        : {};

      // Handle explicit deletion / reset of site config
      if (incomingConfig === null) {
        await storageArea.remove([storageKey]);
        delete indexMap[siteKey];
        await storageArea.set({ [SITE_INDEX_KEY]: indexMap });
        return {
          ok: true,
          deleted: true,
          siteKey,
          revision: 0,
          siteConfig: {
            siteKey,
            hostname: identity.hostname,
            matchScope: "origin",
            enabled: true,
            revision: 0,
            components: {}
          }
        };
      }

      const currentRev = currentRecord ? (Number(currentRecord.revision) || 0) : 0;
      const expectedRev = options.expectedRevision !== undefined && options.expectedRevision !== null
        ? Number(options.expectedRevision)
        : null;

      let finalComponents = { ...(incomingConfig.components || {}) };
      let mergedNonOverlapping = false;

      if (currentRecord && expectedRev !== null && expectedRev !== currentRev && !options.forceOverwrite) {
        // Detect whether we can safely merge disjoint component additions or if there is a true conflict
        const baseComponents = options.baseComponents || null;
        const currComps = currentRecord.components || {};
        const incComps = incomingConfig.components || {};

        let hasOverlappingConflict = false;
        if (incomingConfig.enabled !== undefined && incomingConfig.enabled !== currentRecord.enabled) {
          hasOverlappingConflict = true;
        }

        const allCompKeys = new Set([...Object.keys(currComps), ...Object.keys(incComps)]);
        const merged = { ...currComps };

        for (const k of allCompKeys) {
          const inCurr = JSON.stringify(currComps[k] || null);
          const inInc = JSON.stringify(incComps[k] || null);
          const inBase = baseComponents ? JSON.stringify(baseComponents[k] || null) : null;

          if (inCurr === inInc) continue;

          if (baseComponents) {
            const changedInCurr = inCurr !== inBase;
            const changedInInc = inInc !== inBase;
            if (changedInCurr && changedInInc) {
              hasOverlappingConflict = true;
              break;
            } else if (changedInInc) {
              if (incComps[k]) merged[k] = incComps[k];
              else delete merged[k];
            }
          } else {
            // Without base snapshot, if both have the same component key with different values, flag conflict
            if (currComps[k] && incComps[k]) {
              hasOverlappingConflict = true;
              break;
            } else if (incComps[k]) {
              merged[k] = incComps[k];
            }
          }
        }

        if (hasOverlappingConflict) {
          return {
            ok: false,
            conflict: true,
            siteKey,
            expectedRevision: expectedRev,
            currentRevision: currentRev,
            currentConfig: currentRecord,
            error: `Configuration conflict detected for ${siteKey}: another tab saved revision ${currentRev} (your editor had revision ${expectedRev}).`
          };
        }

        finalComponents = merged;
        mergedNonOverlapping = true;
      }

      const nextRevision = currentRev + 1;
      const nextRecord = {
        siteKey,
        hostname: identity.hostname,
        matchScope: incomingConfig.matchScope || currentRecord?.matchScope || "origin",
        enabled: incomingConfig.enabled !== false,
        themeId: incomingConfig.themeId !== undefined ? incomingConfig.themeId : (currentRecord?.themeId || null),
        revision: nextRevision,
        updatedAt: Date.now(),
        components: finalComponents
      };

      indexMap[siteKey] = {
        siteKey,
        hostname: identity.hostname,
        matchScope: nextRecord.matchScope,
        revision: nextRevision,
        updatedAt: nextRecord.updatedAt
      };

      await storageArea.set({
        [storageKey]: nextRecord,
        [SITE_INDEX_KEY]: indexMap
      });

      return {
        ok: true,
        conflict: false,
        mergedNonOverlapping,
        siteKey,
        revision: nextRevision,
        siteConfig: nextRecord
      };
  }

  async function saveSiteConfigConflictSafe(storageArea, rawSiteKey, incomingConfig, options = {}) {
    return withStorageLock(() => saveSiteConfigConflictSafeUnlocked(storageArea, rawSiteKey, incomingConfig, options));
  }

  const MULTI_PART_SLD = new Set([
    "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk", "ac.uk", "gov.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au",
    "co.nz", "org.nz", "net.nz", "govt.nz", "ac.nz",
    "co.jp", "ne.jp", "or.jp", "go.jp", "ac.jp", "ed.jp",
    "com.br", "net.br", "org.br", "gov.br",
    "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
    "com.sg", "edu.sg", "gov.sg", "org.sg", "net.sg",
    "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
    "co.za", "org.za", "net.za",
    "com.mx", "org.mx", "gob.mx", "edu.mx",
    "com.tr", "org.tr", "net.tr", "edu.tr", "gov.tr",
    "co.kr", "ne.kr", "or.kr", "re.kr", "pe.kr", "go.kr",
    "com.tw", "org.tw", "net.tw", "edu.tw", "gov.tw",
    "com.hk", "org.hk", "net.hk", "edu.hk", "gov.hk",
    "com.my", "org.my", "net.my", "edu.my", "gov.my",
    "com.ph", "org.ph", "net.ph", "edu.ph", "gov.ph",
    "com.ru", "net.ru", "org.ru",
    "gc.ca", "qc.ca"
  ]);

  function deriveRegistrableDomain(urlOrHostname) {
    if (!urlOrHostname) return "";
    let raw = String(urlOrHostname).trim().toLowerCase();
    try {
      if (/^[a-z]+:\/\//i.test(raw)) {
        raw = new URL(raw).hostname.toLowerCase();
      } else {
        raw = raw.split("/")[0].split("?")[0].split("#")[0];
        raw = raw.replace(/:\d+$/, "");
      }
    } catch (_) {
      raw = raw.split("/")[0].replace(/:\d+$/, "");
    }

    if (!raw) return "";

    if (raw === "localhost" || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(raw) || raw.includes(":")) {
      return raw;
    }

    const parts = raw.split(".").filter(Boolean);
    if (parts.length <= 2) {
      return parts.join(".");
    }

    const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`;
    const isMultiPart = MULTI_PART_SLD.has(lastTwo) ||
      (parts[parts.length - 1].length === 2 && parts[parts.length - 2].length <= 3 && /^[a-z]+$/.test(lastTwo));

    if (isMultiPart && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }

    return parts.slice(-2).join(".");
  }

  function makeStorageKeyForTheme(themeId) {
    return `${THEME_KEY_PREFIX}${String(themeId || "").toLowerCase()}`;
  }

  async function listDomainThemes(storageArea) {
    if (!storageArea) return [];
    const indexRes = await storageArea.get([THEME_INDEX_KEY]);
    const indexMap = indexRes[THEME_INDEX_KEY] || {};
    const themeKeys = Object.keys(indexMap).map(makeStorageKeyForTheme);
    if (!themeKeys.length) return [];
    const themesRes = await storageArea.get(themeKeys);
    return Object.values(themesRes).filter((t) => t && typeof t === "object");
  }

  async function getDomainTheme(storageArea, themeId) {
    if (!storageArea || !themeId) return null;
    const key = makeStorageKeyForTheme(themeId);
    const res = await storageArea.get([key]);
    return res[key] || null;
  }

  async function saveDomainThemeUnlocked(storageArea, themeData) {
    if (!storageArea || !themeData || typeof themeData !== "object") {
      throw new Error("Invalid domain theme payload.");
    }
    const id = String(themeData.id || `theme_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
    const domain = deriveRegistrableDomain(themeData.domain || themeData.displayName || "custom");
    const key = makeStorageKeyForTheme(id);

    const record = {
      id,
      domain,
      displayName: String(themeData.displayName || domain || "Custom Theme").trim(),
      defaultStyles: {
        opacity: Math.max(0, Math.min(100, Number(themeData.defaultStyles?.opacity ?? 85))),
        brightness: Number(themeData.defaultStyles?.brightness ?? 100),
        contrast: Number(themeData.defaultStyles?.contrast ?? 100),
        saturation: Number(themeData.defaultStyles?.saturation ?? 100),
        blur: Math.max(0, Number(themeData.defaultStyles?.blur ?? 0)),
        tintOpacity: Math.max(0, Math.min(95, Number(themeData.defaultStyles?.tintOpacity ?? 20))),
        tintColor: themeData.defaultStyles?.tintColor || "#0f172a",
        fitMode: themeData.defaultStyles?.fitMode || "cover"
      },
      defaultMedia: {
        type: themeData.defaultMedia?.type || (Array.isArray(themeData.defaultMedia?.playlist) && themeData.defaultMedia.playlist.length > 0 ? "playlist" : "single"),
        mediaId: themeData.defaultMedia?.mediaId || null,
        playlist: Array.isArray(themeData.defaultMedia?.playlist) ? [...themeData.defaultMedia.playlist] : [],
        rotationIntervalSec: Number(themeData.defaultMedia?.rotationIntervalSec ?? 60),
        rotationWaitForVideoEnd: themeData.defaultMedia?.rotationWaitForVideoEnd !== false
      },
      audioDefaults: {
        videoMuted: themeData.audioDefaults?.videoMuted !== false,
        videoVolume: Math.max(0, Math.min(100, Number(themeData.audioDefaults?.videoVolume ?? 35)))
      },
      assignedSites: Array.isArray(themeData.assignedSites) ? [...new Set(themeData.assignedSites.map(String))] : [],
      autoInheritSubdomains: themeData.autoInheritSubdomains !== false,
      createdAt: Number(themeData.createdAt || Date.now()),
      updatedAt: Date.now()
    };

    const indexRes = await storageArea.get([THEME_INDEX_KEY]);
    const indexMap = indexRes[THEME_INDEX_KEY] && typeof indexRes[THEME_INDEX_KEY] === "object"
      ? { ...indexRes[THEME_INDEX_KEY] }
      : {};

    indexMap[id] = {
      id,
      domain,
      displayName: record.displayName,
      assignedSiteCount: record.assignedSites.length,
      updatedAt: record.updatedAt
    };

    await storageArea.set({
      [key]: record,
      [THEME_INDEX_KEY]: indexMap
    });

    return { ok: true, theme: record };
  }

  async function saveDomainTheme(storageArea, themeData) {
    if (!storageArea || !themeData || typeof themeData !== "object") {
      throw new Error("Invalid domain theme payload.");
    }
    return withStorageLock(() => saveDomainThemeUnlocked(storageArea, themeData));
  }

  async function deleteDomainTheme(storageArea, themeId, options = {}) {
    if (!storageArea || !themeId) return { ok: false, error: "Missing themeId" };
    return withStorageLock(async () => {
      const key = makeStorageKeyForTheme(themeId);
      const indexRes = await storageArea.get([THEME_INDEX_KEY]);
      const indexMap = indexRes[THEME_INDEX_KEY] ? { ...indexRes[THEME_INDEX_KEY] } : {};

      if (options.unassignSites !== false) {
        const siteIndexRes = await storageArea.get([SITE_INDEX_KEY]);
        const siteIndex = siteIndexRes[SITE_INDEX_KEY] || {};
        const siteKeys = Object.keys(siteIndex).map(makeStorageKeyForSite);
        if (siteKeys.length > 0) {
          const siteConfigs = await storageArea.get(siteKeys);
          const updates = {};
          for (const [sk, cfg] of Object.entries(siteConfigs)) {
            if (cfg && cfg.themeId === themeId) {
              if (options.deleteSiteConfigs) {
                await storageArea.remove([sk]);
                delete siteIndex[cfg.siteKey];
              } else {
                cfg.themeId = null;
                cfg.updatedAt = Date.now();
                updates[sk] = cfg;
              }
            }
          }
          if (Object.keys(updates).length > 0) {
            await storageArea.set(updates);
          }
          if (options.deleteSiteConfigs) {
            await storageArea.set({ [SITE_INDEX_KEY]: siteIndex });
          }
        }
      }

      await storageArea.remove([key]);
      delete indexMap[themeId];
      await storageArea.set({ [THEME_INDEX_KEY]: indexMap });

      return { ok: true, deleted: true, themeId };
    });
  }

  async function assignSiteToTheme(storageArea, siteKey, themeId) {
    if (!storageArea || !siteKey) return { ok: false, error: "Missing siteKey" };
    return withStorageLock(async () => {
      const storageKey = makeStorageKeyForSite(siteKey);
      const res = await storageArea.get([storageKey]);
      const siteConfig = res[storageKey] || null;

      if (!siteConfig) {
        return { ok: false, error: "Site configuration not found for " + siteKey };
      }

      const prevThemeId = siteConfig.themeId;
      siteConfig.themeId = themeId || null;
      siteConfig.updatedAt = Date.now();
      await storageArea.set({ [storageKey]: siteConfig });

      if (prevThemeId && prevThemeId !== themeId) {
        const prevKey = makeStorageKeyForTheme(prevThemeId);
        const prevRes = await storageArea.get([prevKey]);
        if (prevRes[prevKey]) {
          const prevTheme = prevRes[prevKey];
          prevTheme.assignedSites = (prevTheme.assignedSites || []).filter((s) => s !== siteKey);
          prevTheme.updatedAt = Date.now();
          await storageArea.set({ [prevKey]: prevTheme });
        }
      }

      if (themeId) {
        const themeKey = makeStorageKeyForTheme(themeId);
        const themeRes = await storageArea.get([themeKey]);
        if (themeRes[themeKey]) {
          const theme = themeRes[themeKey];
          if (!theme.assignedSites) theme.assignedSites = [];
          if (!theme.assignedSites.includes(siteKey)) {
            theme.assignedSites.push(siteKey);
            theme.updatedAt = Date.now();
            await storageArea.set({ [themeKey]: theme });
          }
        }
      }

      return { ok: true, siteConfig };
    });
  }

  async function findThemeForTarget(storageArea, targetUrlOrKey) {
    if (!storageArea) return null;
    const regDomain = deriveRegistrableDomain(targetUrlOrKey);
    const themes = await listDomainThemes(storageArea);
    if (!themes.length) return null;

    const identity = deriveSiteIdentity(targetUrlOrKey);
    for (const theme of themes) {
      if (Array.isArray(theme.assignedSites) && theme.assignedSites.includes(identity.originKey)) {
        return theme;
      }
    }

    for (const theme of themes) {
      if (theme.autoInheritSubdomains && theme.domain === regDomain) {
        return theme;
      }
    }

    return null;
  }

  function resolveEffectiveConfig(siteConfig, domainTheme, globalSettings = {}) {
    const baseGlobalDefaults = {
      opacity: 85,
      brightness: 100,
      contrast: 100,
      saturation: 100,
      blur: 0,
      tintOpacity: 20,
      tintColor: "#0f172a",
      fitMode: "cover",
      videoMuted: true,
      videoVolume: 35,
      videoPaused: globalSettings?.pauseAllBackgroundVideos === true,
      rotationIntervalSec: 60,
      rotationWaitForVideoEnd: true
    };

    const themeStyles = domainTheme?.defaultStyles || {};
    const themeAudio = domainTheme?.audioDefaults || {};
    const themeMedia = domainTheme?.defaultMedia || {};

    const effectiveDefaults = {
      ...baseGlobalDefaults,
      ...themeStyles,
      ...themeAudio,
      activeMediaId: themeMedia.mediaId || null,
      playlist: Array.isArray(themeMedia.playlist) ? [...themeMedia.playlist] : [],
      rotationIntervalSec: themeMedia.rotationIntervalSec || baseGlobalDefaults.rotationIntervalSec,
      rotationWaitForVideoEnd: themeMedia.rotationWaitForVideoEnd !== false
    };

    const cfg = siteConfig ? JSON.parse(JSON.stringify(siteConfig)) : { components: {} };
    if (!cfg.components) cfg.components = {};

    for (const [compId, comp] of Object.entries(cfg.components)) {
      if (!comp || typeof comp !== "object") continue;
      const resolved = {
        ...effectiveDefaults,
        ...comp
      };

      if (!resolved.activeMediaId && (!resolved.playlist || resolved.playlist.length === 0)) {
        if (effectiveDefaults.activeMediaId) resolved.activeMediaId = effectiveDefaults.activeMediaId;
        if (effectiveDefaults.playlist?.length) resolved.playlist = effectiveDefaults.playlist;
      }

      cfg.components[compId] = resolved;
    }

    cfg.themeApplied = domainTheme ? domainTheme.id : null;
    return cfg;
  }

  async function getMediaUsageReferences(storageArea) {
    if (!storageArea) return {};
    const res = await storageArea.get(null);
    const usage = {};

    function track(mediaId, siteInfo, themeInfo) {
      if (!mediaId || typeof mediaId !== "string") return;
      if (!usage[mediaId]) {
        usage[mediaId] = { count: 0, usedInSites: [], usedInThemes: [] };
      }
      usage[mediaId].count++;
      if (siteInfo) usage[mediaId].usedInSites.push(siteInfo);
      if (themeInfo) usage[mediaId].usedInThemes.push(themeInfo);
    }

    for (const [k, v] of Object.entries(res)) {
      if (k.startsWith(SITE_KEY_PREFIX) && v && typeof v === "object") {
        const siteKey = v.siteKey || k.slice(SITE_KEY_PREFIX.length);
        for (const [compId, comp] of Object.entries(v.components || {})) {
          if (!comp) continue;
          const label = comp.friendlyName || comp.locator?.label || compId;
          if (comp.activeMediaId) {
            track(comp.activeMediaId, { siteKey, compId, compLabel: label }, null);
          }
          if (Array.isArray(comp.playlist)) {
            for (const pid of comp.playlist) {
              if (pid !== comp.activeMediaId) {
                track(pid, { siteKey, compId, compLabel: label }, null);
              }
            }
          }
        }
      } else if (k.startsWith(THEME_KEY_PREFIX) && v && typeof v === "object") {
        const themeId = v.id || k.slice(THEME_KEY_PREFIX.length);
        const displayName = v.displayName || themeId;
        if (v.defaultMedia?.mediaId) {
          track(v.defaultMedia.mediaId, null, { themeId, displayName });
        }
        if (Array.isArray(v.defaultMedia?.playlist)) {
          for (const pid of v.defaultMedia.playlist) {
            if (pid !== v.defaultMedia.mediaId) {
              track(pid, null, { themeId, displayName });
            }
          }
        }
      }
    }

    return usage;
  }

  async function pruneDeletedMediaReferences(storageArea, mediaId) {
    if (!storageArea || !mediaId) return { ok: false, updatedSites: 0, updatedThemes: 0 };
    return withStorageLock(async () => {
      const allStored = await storageArea.get(null);
      const updates = {};
      let updatedSites = 0;
      let updatedThemes = 0;

      for (const [k, v] of Object.entries(allStored)) {
        if (k.startsWith(SITE_KEY_PREFIX) && v && typeof v === "object") {
          let siteModified = false;
          const nextSite = JSON.parse(JSON.stringify(v));
          for (const [compId, comp] of Object.entries(nextSite.components || {})) {
            if (!comp || typeof comp !== "object") continue;
            let compChanged = false;
            if (Array.isArray(comp.playlist) && comp.playlist.includes(mediaId)) {
              comp.playlist = comp.playlist.filter((id) => id !== mediaId);
              compChanged = true;
            }
            if (comp.activeMediaId === mediaId) {
              comp.activeMediaId = (Array.isArray(comp.playlist) && comp.playlist.length > 0) ? comp.playlist[0] : null;
              compChanged = true;
            }
            if (compChanged) {
              nextSite.components[compId] = comp;
              siteModified = true;
            }
          }
          if (siteModified) {
            nextSite.revision = (Number(nextSite.revision) || 0) + 1;
            nextSite.updatedAt = Date.now();
            updates[k] = nextSite;
            updatedSites++;
          }
        } else if (k.startsWith(THEME_KEY_PREFIX) && v && typeof v === "object") {
          let themeModified = false;
          const nextTheme = JSON.parse(JSON.stringify(v));
          if (nextTheme.defaultMedia && typeof nextTheme.defaultMedia === "object") {
            if (Array.isArray(nextTheme.defaultMedia.playlist) && nextTheme.defaultMedia.playlist.includes(mediaId)) {
              nextTheme.defaultMedia.playlist = nextTheme.defaultMedia.playlist.filter((id) => id !== mediaId);
              themeModified = true;
            }
            if (nextTheme.defaultMedia.mediaId === mediaId) {
              nextTheme.defaultMedia.mediaId = (Array.isArray(nextTheme.defaultMedia.playlist) && nextTheme.defaultMedia.playlist.length > 0)
                ? nextTheme.defaultMedia.playlist[0]
                : null;
              themeModified = true;
            }
          }
          if (themeModified) {
            nextTheme.updatedAt = Date.now();
            updates[k] = nextTheme;
            updatedThemes++;
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await storageArea.set(updates);
      }

      return { ok: true, updatedSites, updatedThemes };
    });
  }

  function isSafeHttpOrFileSiteKey(rawKey) {
    if (!rawKey || typeof rawKey !== "string") return false;
    const trimmed = rawKey.trim();
    if (!trimmed) return false;
    if (/^(javascript|data|vbscript|blob|chrome|chrome-extension|moz-extension|about):/i.test(trimmed)) {
      return false;
    }
    try {
      const parsed = new URL(trimmed);
      return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "file:";
    } catch (_) {
      // Allow bare hostnames if they contain no scheme colon (except port digits)
      if (/^[a-z0-9.-]+(?::\d+)?$/i.test(trimmed)) return true;
      return false;
    }
  }

  async function encodeBlobToBase64Chunked(blob) {
    const CHUNK_MULT = 3 * 32768; // 98,304 bytes (divisible by 3 for clean Base64 concatenation)
    const totalSize = blob.size || 0;
    const parts = [];
    for (let offset = 0; offset < totalSize; offset += CHUNK_MULT) {
      const slice = blob.slice(offset, Math.min(totalSize, offset + CHUNK_MULT));
      const buf = await slice.arrayBuffer();
      parts.push(uint8SliceToBase64(new Uint8Array(buf)));
    }
    return parts.join("");
  }

  async function exportBackupData(storageArea, options = {}) {
    if (!storageArea) throw new Error("Storage area unavailable.");
    const includeBlobs = options.includeBlobs === true;
    const maxExportBytes = Number(options.maxTotalBlobBytes) || 150 * 1024 * 1024;
    const allStored = await storageArea.get(null);

    const siteConfigs = [];
    const domainThemes = [];
    const siteAccess = [];
    let globalSettings = {};

    for (const [k, v] of Object.entries(allStored)) {
      if (k.startsWith(SITE_KEY_PREFIX)) siteConfigs.push(v);
      else if (k.startsWith(THEME_KEY_PREFIX)) domainThemes.push(v);
      else if (k.startsWith("siteAccess::")) siteAccess.push(v);
      else if (k === "globalSettings") globalSettings = v;
    }

    let metadataList = [];
    if (typeof indexedDB !== "undefined") {
      try { metadataList = await listMediaMetadata(); } catch (_) {}
    }
    const mediaBlobs = [];
    let accumulatedBlobBytes = 0;

    if (includeBlobs && typeof indexedDB !== "undefined") {
      for (const meta of metadataList) {
        if (!meta?.id || meta.mediaType === "preset") continue;
        const rec = await getMediaRecordWithBlob(meta.id);
        if (rec && rec.blob) {
          accumulatedBlobBytes += Number(rec.blob.size || 0);
          if (accumulatedBlobBytes > maxExportBytes) {
            throw new Error(`Full media backup exceeds safe memory limit (${formatBytes(maxExportBytes)}). Export settings-only or remove large videos first.`);
          }
          const base64Data = await encodeBlobToBase64Chunked(rec.blob);
          mediaBlobs.push({
            id: rec.id,
            name: rec.name,
            mimeType: rec.mimeType,
            mediaType: rec.mediaType,
            size: rec.size,
            width: rec.width,
            height: rec.height,
            base64Data
          });
        }
      }
    }

    return {
      schemaVersion: BACKUP_SCHEMA_VERSION,
      appVersion: "2.2.0",
      type: includeBlobs ? "chameleon-backup-full" : "chameleon-backup-settings",
      exportedAt: Date.now(),
      globalSettings,
      domainThemes,
      domainThemeIndex: allStored[THEME_INDEX_KEY] || {},
      siteConfigs,
      siteIndex: allStored[SITE_INDEX_KEY] || {},
      siteAccess,
      mediaMetadata: metadataList,
      mediaBlobs
    };
  }

  function validateBackupPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return { valid: false, error: "Backup file is empty or not valid JSON." };
    }
    const version = Number(payload.schemaVersion || payload.version || 0);
    if (version !== 1 && version !== 2) {
      return { valid: false, error: `Unsupported backup schema version: ${version}. Expected 1 or 2.` };
    }

    const siteConfigs = Array.isArray(payload.siteConfigs) ? payload.siteConfigs : (payload.siteConfigs && typeof payload.siteConfigs === "object" ? Object.values(payload.siteConfigs) : []);
    const domainThemes = Array.isArray(payload.domainThemes) ? payload.domainThemes : [];
    const mediaBlobs = Array.isArray(payload.mediaBlobs) ? payload.mediaBlobs : [];
    const siteAccess = Array.isArray(payload.siteAccess) ? payload.siteAccess : [];

    for (const site of siteConfigs) {
      if (!site || typeof site !== "object") {
        return { valid: false, error: "Backup contains malformed site configuration entry." };
      }
      const keyCandidate = site.siteKey || site.origin || site.hostname || "";
      if (!isSafeHttpOrFileSiteKey(keyCandidate)) {
        return { valid: false, error: `Rejected unsafe or invalid site origin in backup: ${String(keyCandidate).slice(0, 64)}` };
      }
    }

    for (const acc of siteAccess) {
      if (acc && typeof acc === "object" && acc.origin && !isSafeHttpOrFileSiteKey(acc.origin)) {
        return { valid: false, error: `Rejected unsafe siteAccess origin in backup: ${String(acc.origin).slice(0, 64)}` };
      }
    }

    return {
      valid: true,
      version,
      type: payload.type || (mediaBlobs.length > 0 ? "chameleon-backup-full" : "chameleon-backup-settings"),
      exportedAt: payload.exportedAt || null,
      siteConfigCount: siteConfigs.length,
      domainThemeCount: domainThemes.length,
      mediaBlobCount: mediaBlobs.length,
      summary: {
        siteConfigs,
        domainThemes,
        mediaBlobs,
        globalSettings: payload.globalSettings || null
      }
    };
  }

  async function importBackupData(storageArea, backupPayload, options = {}) {
    const validation = validateBackupPayload(backupPayload);
    if (!validation.valid) throw new Error(validation.error);

    const mode = options.mode === "replace" ? "replace" : "merge";

    return withStorageLock(async () => {
      const summary = validation.summary;

      if (mode === "replace") {
        const allKeys = Object.keys(await storageArea.get(null));
        const keysToRemove = allKeys.filter((k) =>
          k.startsWith(SITE_KEY_PREFIX) || k.startsWith(THEME_KEY_PREFIX) || k === SITE_INDEX_KEY || k === THEME_INDEX_KEY
        );
        if (keysToRemove.length > 0) {
          await storageArea.remove(keysToRemove);
        }
      }

      if (summary.globalSettings && typeof summary.globalSettings === "object") {
        await storageArea.set({ globalSettings: summary.globalSettings });
      }

      let themesImported = 0;
      for (const theme of summary.domainThemes) {
        if (theme && theme.id) {
          await saveDomainThemeUnlocked(storageArea, theme);
          themesImported++;
        }
      }

      let sitesImported = 0;
      for (const site of summary.siteConfigs) {
        if (site && site.siteKey && isSafeHttpOrFileSiteKey(site.siteKey)) {
          await saveSiteConfigConflictSafeUnlocked(storageArea, site.siteKey, site, { forceOverwrite: true });
          sitesImported++;
        }
      }

      let blobsImported = 0;
      if (summary.mediaBlobs && summary.mediaBlobs.length > 0 && typeof indexedDB !== "undefined") {
        const db = await openExtensionMediaDB();
        for (const mb of summary.mediaBlobs) {
          if (!mb || !mb.id || !mb.base64Data) continue;
          try {
            const rawBytes = base64ToUint8Slice(mb.base64Data);
            const blob = new Blob([rawBytes], { type: mb.mimeType || "application/octet-stream" });
            const record = {
              id: mb.id,
              name: mb.name || "imported-media",
              mimeType: mb.mimeType,
              mediaType: mb.mediaType || "image",
              size: blob.size,
              width: mb.width || 0,
              height: mb.height || 0,
              createdAt: Date.now(),
              blob
            };
            await putRecordWithQuotaGuard(db, record);
            blobsImported++;
          } catch (_) {}
        }
      }

      return {
        ok: true,
        mode,
        sitesImported,
        themesImported,
        blobsImported
      };
    });
  }

  async function clearAllChameleonData(storageArea) {
    if (!storageArea) throw new Error("Storage area unavailable.");
    return withStorageLock(async () => {
      const allKeys = Object.keys(await storageArea.get(null));
      const chameleonKeys = allKeys.filter((k) =>
        k.startsWith(SITE_KEY_PREFIX) ||
        k.startsWith(THEME_KEY_PREFIX) ||
        k.startsWith("siteAccess::") ||
        k.startsWith("pendingEnable::") ||
        k.startsWith("legacyPageMediaMigration::") ||
        k.startsWith("siteCfgConflict::") ||
        k === SITE_INDEX_KEY ||
        k === THEME_INDEX_KEY ||
        k === MIGRATION_STATE_KEY ||
        k === LEGACY_BACKUP_KEY ||
        k === "globalSettings" ||
        k === "siteConfigs"
      );
      if (chameleonKeys.length > 0) {
        await storageArea.remove(chameleonKeys);
      }

      if (typeof indexedDB !== "undefined") {
        try {
          const db = await openExtensionMediaDB();
          await new Promise((resolve, reject) => {
            const tx = db.transaction(MEDIA_STORE, "readwrite");
            tx.objectStore(MEDIA_STORE).clear();
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        } catch (_) {}
      }

      return { ok: true, clearedKeysCount: chameleonKeys.length };
    });
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  }

  const StorageService = {
    EXT_DB_NAME,
    MEDIA_STORE,
    SITE_KEY_PREFIX,
    SITE_INDEX_KEY,
    MIGRATION_STATE_KEY,
    LEGACY_BACKUP_KEY,
    THEME_KEY_PREFIX,
    THEME_INDEX_KEY,
    BACKUP_SCHEMA_VERSION,
    ALLOWED_SVG_TAGS,
    DEFAULT_CHUNK_SIZE_BYTES,
    DEFAULT_MAX_MEDIA_BYTES,
    DEFAULT_WARN_MEDIA_BYTES,
    DEFAULT_TRANSFER_TIMEOUT_MS,
    BUILTIN_PRESETS,
    SUPPORTED_IMAGE_MIMES,
    SUPPORTED_VIDEO_MIMES,
    openExtensionMediaDB,
    isAnimatedGif,
    sanitizeCssStyleText,
    sanitizeSvgBlob,
    convertRasterToWebP,
    extractMp4TrackDurations,
    inspectMediaMetadata,
    importMediaItem,
    listMediaMetadata,
    getMediaRecordWithBlob,
    deleteMediaRecord,
    getStorageUsageStats,
    updateFnv1a32,
    createBoundedBlobSenderSession,
    createBoundedBlobReceiverSession,
    deriveSiteIdentity,
    deriveRegistrableDomain,
    makeStorageKeyForTheme,
    listDomainThemes,
    getDomainTheme,
    saveDomainTheme,
    deleteDomainTheme,
    assignSiteToTheme,
    findThemeForTarget,
    resolveEffectiveConfig,
    getMediaUsageReferences,
    pruneDeletedMediaReferences,
    isSafeHttpOrFileSiteKey,
    exportBackupData,
    validateBackupPayload,
    importBackupData,
    clearAllChameleonData,
    legacyPageMediaMigrationStorageKey,
    doesSiteRecordMatchIdentity,
    migrateLegacySiteConfigsOnce,
    getSiteConfigForTarget,
    saveSiteConfigConflictSafe,
    formatBytes
  };

  globalScope.ChameleonStorageService = StorageService;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = StorageService;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
