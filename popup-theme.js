/* Keep the toolbar popup in the Studio's selected color mode before CSS paints. */
(() => {
  "use strict";

  const themeKey = "chameleonStudioColorMode";
  function syncTheme() {
    let mode = "dark";
    try { mode = localStorage.getItem(themeKey) === "light" ? "light" : "dark"; } catch (_) {}
    document.documentElement.dataset.studioTheme = mode;
  }

  syncTheme();
  window.addEventListener("storage", (event) => {
    if (event.key === themeKey) syncTheme();
  });
})();
