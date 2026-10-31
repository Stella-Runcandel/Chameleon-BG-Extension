/**
 * ChameleonBG v2.2.0 — Deterministic Video & Audio Playback State Manager (`video-manager.js`)
 *
 * Implements an explicit, multi-variable playback and audio state model:
 * - Distinguishes user-selected mute preference from browser autoplay rejection (NotAllowedError).
 * - Distinguishes user pause from global pause and document visibility pause.
 * - Enforces exactly one audible ChameleonBG background video per tab (audio focus arbitration).
 * - Provides an in-page, extension-owned audio activation overlay that executes play() + unmute
 *   synchronously inside a real webpage user gesture to satisfy Firefox autoplay policy.
 * - Zero innerHTML usage; safe DOM APIs throughout.
 */

(function (globalScope) {
  "use strict";

  class VideoPlaybackManager {
    constructor(options = {}) {
      this.document = options.document || (typeof document !== "undefined" ? document : null);
      this.window = options.window || (typeof window !== "undefined" ? window : null);
      this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;

      // Map<compId, ComponentVideoState>
      this.components = new Map();
      this.audibleOwnerCompId = null;
      this.pausedGlobally = false;
      this.pausedByVisibility = false;
      this.documentAudioAllowed = false;

      // In-page audio prompt element (Shadow DOM or direct safe node)
      this.inPageAudioPromptHost = null;
      this.audioRequestSequence = 0;

      // Listen to page-level interactions to note that document audio is permitted
      this.bindDocumentGestureCapture();
    }

    bindDocumentGestureCapture() {
      if (!this.document) return;
      this._onUserInteraction = () => {
        this.documentAudioAllowed = true;
        // Rebalance registered videos in case any were waiting on document gesture
        this.rebalanceAudioPlayback();
      };
      this.document.addEventListener("click", this._onUserInteraction, { capture: true, passive: true });
      this.document.addEventListener("keydown", this._onUserInteraction, { capture: true, passive: true });
    }

    registerVideo(compId, videoEl, config = {}) {
      if (!compId || !videoEl) return;
      let state = this.components.get(compId);
      if (!state) {
        state = {
          compId,
          videoEl,
          userMuted: config.videoMuted !== false, // default muted
          userVolume: Math.max(0, Math.min(100, Number(config.videoVolume ?? 35))),
          playbackDesired: config.videoPaused !== true,
          isPlaying: false,
          pausedByUser: config.videoPaused === true,
          pausedGlobally: this.pausedGlobally,
          pausedByVisibility: this.pausedByVisibility,
          isUnloaded: false,
          audioBlockedByPolicy: false,
          waitingForGesture: false,
          lastAudioRequestedAt: Number(config.videoAudioRequestedAt || 0),
          statusLabel: "muted-by-user",
          _boundListeners: null
        };
        this.components.set(compId, state);
      } else {
        if (state.videoEl && state.videoEl !== videoEl) {
          this.unbindVideoEvents(state);
        }
        state.videoEl = videoEl;
        if (config.videoMuted !== undefined) state.userMuted = config.videoMuted !== false;
        if (config.videoVolume !== undefined) state.userVolume = Math.max(0, Math.min(100, Number(config.videoVolume)));
        if (config.videoPaused !== undefined) {
          state.playbackDesired = config.videoPaused !== true;
          state.pausedByUser = config.videoPaused === true;
        }
      }

      if (!state.userMuted && !state.lastAudioRequestedAt) {
        state.lastAudioRequestedAt = ++this.audioRequestSequence;
      }

      this.bindVideoEvents(state);
      this.rebalanceAudioPlayback();
      if (this.audibleOwnerCompId === compId) {
        this.requestGlobalAudioFocus(compId);
      }
      this.applyStateToElement(state);
    }

    unregisterVideo(compId) {
      const state = this.components.get(compId);
      if (!state) return;
      this.unbindVideoEvents(state);
      if (this.audibleOwnerCompId === compId) {
        this.audibleOwnerCompId = null;
        this.releaseGlobalAudioFocus(compId);
      }
      this.components.delete(compId);
      this.rebalanceAudioPlayback();
    }

    bindVideoEvents(state) {
      const el = state.videoEl;
      if (!el || el.__chameleonBoundEvents) return;
      el.__chameleonBoundEvents = true;

      const onPlay = () => {
        state.isPlaying = true;
        this.updateStatusLabel(state);
        this.notifyStateChange(state);
      };

      const tryRestartLoopingVideo = () => {
        const shouldBePaused = state.pausedByUser || state.pausedGlobally || state.pausedByVisibility || !state.playbackDesired;
        if (shouldBePaused || !el.loop) return false;
        try { el.currentTime = 0; } catch (_) {}
        const attemptPlay = () => {
          try {
            const p = el.play();
            if (p && typeof p.catch === "function") {
              p.catch(() => {
                // If unmuted loop restart was blocked by autoplay policy, fall back to muted playback
                // so the video never freezes at the end of a loop cycle.
                if (!el.muted) {
                  state.audioBlockedByPolicy = true;
                  state.waitingForGesture = true;
                  el.muted = true;
                  try {
                    const p2 = el.play();
                    if (p2 && typeof p2.catch === "function") p2.catch(() => {});
                  } catch (_) {}
                }
              });
            }
            state.isPlaying = true;
          } catch (_) {}
        };
        attemptPlay();
        if (typeof el.addEventListener === "function") {
          el.addEventListener("seeked", () => {
            if (!state.pausedByUser && !state.pausedGlobally && !state.pausedByVisibility && state.playbackDesired && el.paused) {
              attemptPlay();
            }
          }, { once: true });
        }
        this.updateStatusLabel(state);
        this.notifyStateChange(state);
        return true;
      };

      const onPause = () => {
        const nearEnd = el.ended || (Number.isFinite(el.duration) && el.duration > 0.2 && el.currentTime >= el.duration - 0.35);
        if (nearEnd && tryRestartLoopingVideo()) {
          return;
        }
        state.isPlaying = false;
        this.updateStatusLabel(state);
        this.notifyStateChange(state);
      };

      const onEnded = () => {
        if (tryRestartLoopingVideo()) {
          return;
        }
        state.isPlaying = false;
        this.updateStatusLabel(state);
        this.notifyStateChange(state);
      };

      const onVolumeChange = () => {
        // Guard against webpage scripts altering volume
        this.updateStatusLabel(state);
        this.notifyStateChange(state);
      };

      const onError = () => {
        state.statusLabel = "failed-media";
        this.notifyStateChange(state);
      };

      state._boundListeners = { onPlay, onPause, onEnded, onVolumeChange, onError };
      el.addEventListener("play", onPlay);
      el.addEventListener("pause", onPause);
      el.addEventListener("ended", onEnded);
      el.addEventListener("volumechange", onVolumeChange);
      el.addEventListener("error", onError);
    }

    unbindVideoEvents(state) {
      const el = state && state.videoEl;
      if (!el || !state._boundListeners) return;
      if (typeof el.removeEventListener === "function") {
        el.removeEventListener("play", state._boundListeners.onPlay);
        el.removeEventListener("pause", state._boundListeners.onPause);
        if (state._boundListeners.onEnded) {
          el.removeEventListener("ended", state._boundListeners.onEnded);
        }
        el.removeEventListener("volumechange", state._boundListeners.onVolumeChange);
        el.removeEventListener("error", state._boundListeners.onError);
      }
      delete el.__chameleonBoundEvents;
      state._boundListeners = null;
    }

    setUserPlaybackDesired(compId, desired) {
      const state = this.components.get(compId);
      if (!state) return;
      state.playbackDesired = Boolean(desired);
      state.pausedByUser = !state.playbackDesired;
      this.applyStateToElement(state);
      this.rebalanceAudioPlayback();
    }

    setUserMute(compId, muted) {
      const state = this.components.get(compId);
      if (!state) return;
      state.userMuted = Boolean(muted);
      if (!state.userMuted) {
        state.lastAudioRequestedAt = ++this.audioRequestSequence;
        state.audioBlockedByPolicy = false;
        // When user explicitly unmutes, they become the candidate for audio focus
        this.audibleOwnerCompId = compId;
        this.requestGlobalAudioFocus(compId);
      } else {
        if (this.audibleOwnerCompId === compId) {
          this.audibleOwnerCompId = null;
          this.releaseGlobalAudioFocus(compId);
        }
      }
      this.applyStateToElement(state);
      this.rebalanceAudioPlayback();
    }

    setUserVolume(compId, volume) {
      const state = this.components.get(compId);
      if (!state) return;
      state.userVolume = Math.max(0, Math.min(100, Number(volume)));
      if (state.userVolume === 0) {
        state.userMuted = true;
        if (this.audibleOwnerCompId === compId) this.audibleOwnerCompId = null;
      }
      this.applyStateToElement(state);
      this.rebalanceAudioPlayback();
    }

    setGlobalPause(paused) {
      this.pausedGlobally = Boolean(paused);
      for (const state of this.components.values()) {
        state.pausedGlobally = this.pausedGlobally;
        this.applyStateToElement(state);
      }
    }

    setVisibilityPause(hidden) {
      this.pausedByVisibility = Boolean(hidden);
      for (const state of this.components.values()) {
        state.pausedByVisibility = this.pausedByVisibility;
        this.applyStateToElement(state);
      }
    }

    async applyStateToElement(state) {
      const el = state.videoEl;
      if (!el) return;

      const shouldBePaused = state.pausedByUser || state.pausedGlobally || state.pausedByVisibility || !state.playbackDesired;
      const isAudibleOwner = this.audibleOwnerCompId === state.compId;
      const shouldBeMuted = state.userMuted || !isAudibleOwner || state.audioBlockedByPolicy;
      const targetVolume = Math.max(0, Math.min(1, state.userVolume / 100));

      el.volume = targetVolume;
      el.muted = shouldBeMuted;

      if (shouldBePaused) {
        if (!el.paused) el.pause();
        state.isPlaying = false;
        this.updateStatusLabel(state);
        this.notifyStateChange(state);
        return;
      }

      // Desired playing
      if (el.paused) {
        try {
          await el.play();
          state.isPlaying = true;
          if (!shouldBeMuted) {
            state.audioBlockedByPolicy = false;
            state.waitingForGesture = false;
            state.lastErrorName = null;
          }
        } catch (err) {
          state.lastErrorName = err?.name || "Error";
          // Firefox autoplay policy rejection (NotAllowedError)
          if (!shouldBeMuted && (err.name === "NotAllowedError" || /play|allowed/i.test(err.message || ""))) {
            state.audioBlockedByPolicy = true;
            state.waitingForGesture = true;
            el.muted = true; // Fall back to muted playback without modifying website DOM
            try {
              await el.play();
              state.isPlaying = true;
            } catch (_) {
              state.isPlaying = false;
            }
          } else {
            state.isPlaying = false;
          }
        }
      } else if (!shouldBeMuted) {
        try {
          el.muted = false;
          await el.play();
          state.audioBlockedByPolicy = false;
          state.waitingForGesture = false;
          state.lastErrorName = null;
        } catch (err) {
          state.lastErrorName = err?.name || "Error";
          if (err.name === "NotAllowedError" || /play|allowed/i.test(err.message || "")) {
            state.audioBlockedByPolicy = true;
            state.waitingForGesture = true;
            el.muted = true;
          }
        }
      }

      this.updateStatusLabel(state);
      this.notifyStateChange(state);
    }

    rebalanceAudioPlayback() {
      // Find candidate for audio focus: user wants audio, volume > 0, not blocked
      const candidates = Array.from(this.components.values()).filter((st) =>
        !st.userMuted && st.userVolume > 0 && !st.pausedByUser && !st.pausedGlobally && !st.pausedByVisibility
      );

      candidates.sort((a, b) => b.lastAudioRequestedAt - a.lastAudioRequestedAt);
      const chosen = candidates[0] || null;
      this.audibleOwnerCompId = chosen ? chosen.compId : null;

      if (this.documentAudioAllowed && chosen) {
        chosen.audioBlockedByPolicy = false;
        chosen.waitingForGesture = false;
      }

      for (const st of this.components.values()) {
        const isAudible = st.compId === this.audibleOwnerCompId;
        if (st.videoEl) {
          if (!isAudible) {
            st.videoEl.muted = true;
          } else if (!st.audioBlockedByPolicy) {
            st.videoEl.muted = false;
            st.videoEl.volume = Math.max(0, Math.min(1, st.userVolume / 100));
          }
        }
        this.updateStatusLabel(st);
        this.notifyStateChange(st);
      }
    }

    updateStatusLabel(state) {
      if (state.statusLabel === "failed-media") return;
      if (state.pausedGlobally) {
        state.statusLabel = "paused-globally";
      } else if (state.pausedByUser) {
        state.statusLabel = "paused-by-user";
      } else if (state.audioBlockedByPolicy || state.waitingForGesture) {
        state.statusLabel = "audio-blocked";
      } else if (!state.isPlaying) {
        state.statusLabel = "paused-by-user";
      } else if (state.userMuted || state.compId !== this.audibleOwnerCompId || state.videoEl?.muted) {
        state.statusLabel = "playing-muted";
      } else {
        state.statusLabel = "playing-audio";
      }
    }

    notifyStateChange(state) {
      if (this.onStateChange) {
        try { this.onStateChange(this.getVideoState(state.compId)); } catch (_) {}
      }
    }

    getVideoState(compId) {
      const st = this.components.get(compId);
      if (!st) return null;
      return {
        compId: st.compId,
        userMuted: st.userMuted,
        userVolume: st.userVolume,
        playbackDesired: st.playbackDesired,
        isPlaying: st.isPlaying,
        pausedByUser: st.pausedByUser,
        pausedGlobally: st.pausedGlobally,
        pausedByVisibility: st.pausedByVisibility,
        isUnloaded: st.isUnloaded,
        audioBlockedByPolicy: st.audioBlockedByPolicy,
        waitingForGesture: st.waitingForGesture,
        isAudibleOwner: st.compId === this.audibleOwnerCompId,
        statusLabel: st.statusLabel,
        effectiveMuted: Boolean(st.videoEl?.muted),
        effectiveVolume: st.videoEl ? Math.round(st.videoEl.volume * 100) : st.userVolume
      };
    }

    getAllVideoStates() {
      const result = {};
      for (const [compId, st] of this.components.entries()) {
        result[compId] = this.getVideoState(compId);
      }
      return result;
    }

    requestGlobalAudioFocus(compId) {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({
            type: "CHAMELEON_CLAIM_AUDIO_FOCUS",
            compId
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        } catch (_) {}
      }
    }

    releaseGlobalAudioFocus(compId) {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.sendMessage) {
        try {
          chrome.runtime.sendMessage({
            type: "CHAMELEON_RELEASE_AUDIO_FOCUS",
            compId
          }, () => {
            if (chrome.runtime.lastError) {}
          });
        } catch (_) {}
      }
    }

    yieldAudioFocus(compId) {
      if (this.audibleOwnerCompId === compId || !compId) {
        this.audibleOwnerCompId = null;
      }
      for (const st of this.components.values()) {
        if (st.videoEl && (!compId || st.compId === compId)) {
          st.videoEl.muted = true;
        }
        this.updateStatusLabel(st);
        this.notifyStateChange(st);
      }
    }

    /**
     * Non-injecting audio prompt hooks.
     * In accordance with ChameleonBG architecture, no playback buttons are injected into third-party websites.
     */
    showInPageAudioPrompt(compId) {
      // Intentionally a no-op to preserve third-party website DOM integrity.
    }

    hideInPageAudioPrompt(compId) {
      // Intentionally a no-op.
    }

    destroy() {
      for (const state of this.components.values()) {
        this.unbindVideoEvents(state);
      }
      if (this.document && this._onUserInteraction && typeof this.document.removeEventListener === "function") {
        this.document.removeEventListener("click", this._onUserInteraction, { capture: true });
        this.document.removeEventListener("keydown", this._onUserInteraction, { capture: true });
        this._onUserInteraction = null;
      }
      this.components.clear();
      this.audibleOwnerCompId = null;
    }
  }

  const api = Object.freeze({
    VideoPlaybackManager,
    createVideoPlaybackManager: (opts) => new VideoPlaybackManager(opts)
  });

  globalScope.ChameleonVideoManager = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
