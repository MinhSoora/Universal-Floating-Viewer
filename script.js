'use strict';

/* ===================================================================
   Universal Floating Viewer — script.js
   Vanilla JS, no dependencies. Organized into small modules:
     - Store        : localStorage read/write with validation
     - Settings     : app settings state + DOM binding
     - History      : recent URL list
     - UrlUtil       : normalize/validate URLs
     - Card         : site card with direct href links (no iframe)
     - FloatWin     : Floating popup window (navigates straight to the page)
     - UI           : header, theme, tabs, status bar, dialog
   =================================================================== */

(function () {

  /* ---------------- Store ---------------- */

  const STORAGE_KEY = 'ufv:v1';

  const DEFAULT_STATE = {
    lastUrl: '',
    history: [], // [{ url, title, ts }]
    window: {
      width: 420,
      height: 650,
    },
    appearance: {
      darkMode: true,
      accent: '#7fae2e',
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: 15,
      customCss: ''
    },
    behavior: {
      restoreUrl: true,
      restoreSettings: true,
      keepUrlOnReopen: true,
      autoUpdatePip: true
    },
    headerHidden: false
  };

  function deepMerge(base, incoming) {
    if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
      return incoming === undefined ? base : incoming;
    }
    const out = { ...base };
    for (const key of Object.keys(base)) {
      if (Object.prototype.hasOwnProperty.call(incoming, key)) {
        if (typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key])) {
          out[key] = deepMerge(base[key], incoming[key]);
        } else {
          out[key] = incoming[key];
        }
      }
    }
    return out;
  }

  const Store = {
    load() {
      let raw;
      try {
        raw = window.localStorage.getItem(STORAGE_KEY);
      } catch (e) {
        console.warn('LocalStorage unavailable:', e);
        return structuredCloneSafe(DEFAULT_STATE);
      }
      if (!raw) return structuredCloneSafe(DEFAULT_STATE);
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
        const merged = deepMerge(DEFAULT_STATE, parsed);
        // Validate history is an array of well-formed entries
        if (!Array.isArray(merged.history)) merged.history = [];
        merged.history = merged.history.filter(
          (h) => h && typeof h.url === 'string' && UrlUtil.isValid(h.url)
        );
        // Clamp numeric fields defensively
        merged.window.width = clamp(num(merged.window.width, 420), 240, 2400);
        merged.window.height = clamp(num(merged.window.height, 650), 200, 2000);
        merged.appearance.fontSize = clamp(num(merged.appearance.fontSize, 15), 10, 28);
        return merged;
      } catch (e) {
        console.warn('Stored settings were invalid, resetting to defaults:', e);
        return structuredCloneSafe(DEFAULT_STATE);
      }
    },
    save(state) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      } catch (e) {
        console.warn('Could not persist settings to localStorage:', e);
      }
    },
    reset() {
      try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      return structuredCloneSafe(DEFAULT_STATE);
    }
  };

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function structuredCloneSafe(obj) {
    return typeof structuredClone === 'function' ? structuredClone(obj) : JSON.parse(JSON.stringify(obj));
  }

  /* ---------------- UrlUtil ---------------- */

  const UrlUtil = {
    /** Add https:// if the string looks like a bare domain/path with no scheme. */
    normalize(input) {
      let v = (input || '').trim();
      if (!v) return '';
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v; // already has a scheme
      if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^localhost|^\d/.test(v)) {
        // things like "mailto:" or "javascript:" — don't touch, validity check will reject unsafe ones
        return v;
      }
      return 'https://' + v;
    },
    isValid(str) {
      try {
        const u = new URL(str);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch (e) {
        return false;
      }
    },
    parse(str) {
      try { return new URL(str); } catch (e) { return null; }
    },
    hostLabel(str) {
      const u = UrlUtil.parse(str);
      return u ? u.hostname.replace(/^www\./, '') : str;
    }
  };

  /* ---------------- App state ---------------- */

  let state = Store.load();
  let currentUrl = '';
  let floatWin = null;
  let watchTimer = null;

  function persist() {
    if (state.behavior.restoreSettings) {
      Store.save(state);
    } else {
      // Still keep history/lastUrl minimal even if "remember settings" is off,
      // since history + last URL are listed as separate behaviors.
      Store.save({ ...DEFAULT_STATE, history: state.history, lastUrl: state.behavior.restoreUrl ? state.lastUrl : '' });
    }
  }

  /* ---------------- DOM refs ---------------- */

  const $ = (sel) => document.querySelector(sel);

  const el = {
    header: $('.app-header'),
    toggleHeaderBtn: $('#toggleHeaderBtn'),
    themeToggleBtn: $('#themeToggleBtn'),
    statusBar: $('#statusBar'),

    urlForm: $('#urlForm'),
    urlInput: $('#urlInput'),
    loadBtn: $('#loadBtn'),
    openTabBtn: $('#openTabBtn'),
    openPipBtn: $('#openPipBtn'),

    siteEmpty: $('#siteEmpty'),
    siteInfo: $('#siteInfo'),
    siteHost: $('#siteHost'),
    siteUrl: $('#siteUrl'),
    siteLinkSame: $('#siteLinkSame'),
    siteLinkNew: $('#siteLinkNew'),

    tabs: Array.from(document.querySelectorAll('.tabs__btn')),
    panels: Array.from(document.querySelectorAll('.panel')),

    winWidth: $('#winWidth'),
    winHeight: $('#winHeight'),

    darkModeToggle: $('#darkModeToggle'),
    accentColor: $('#accentColor'),
    accentColorText: $('#accentColorText'),
    fontFamily: $('#fontFamily'),
    fontSize: $('#fontSize'),
    fontSizeOut: $('#fontSizeOut'),
    customCss: $('#customCss'),
    applyCssBtn: $('#applyCssBtn'),
    customCssStyle: $('#customCssStyle'),

    restoreUrlToggle: $('#restoreUrlToggle'),
    restoreSettingsToggle: $('#restoreSettingsToggle'),
    keepUrlOnReopenToggle: $('#keepUrlOnReopenToggle'),
    autoUpdatePipToggle: $('#autoUpdatePipToggle'),
    resetSettingsBtn: $('#resetSettingsBtn'),

    historyList: $('#historyList'),
    historyEmpty: $('#historyEmpty'),
    clearHistoryBtn: $('#clearHistoryBtn'),

    confirmDialog: $('#confirmDialog'),
    confirmDialogText: $('#confirmDialogText'),
    confirmCancelBtn: $('#confirmCancelBtn'),
    confirmOkBtn: $('#confirmOkBtn')
  };

  /* ---------------- Status bar ---------------- */

  let statusTimer = null;
  function showStatus(message, kind = 'info', timeout = 3200) {
    el.statusBar.textContent = message;
    el.statusBar.dataset.kind = kind;
    el.statusBar.classList.add('is-visible');
    clearTimeout(statusTimer);
    if (timeout) {
      statusTimer = setTimeout(() => el.statusBar.classList.remove('is-visible'), timeout);
    }
  }

  /* ---------------- Confirm dialog helper ---------------- */

  function confirmAction(message) {
    return new Promise((resolve) => {
      el.confirmDialogText.textContent = message;
      el.confirmDialog.showModal();
      const onOk = () => { cleanup(); resolve(true); };
      const onCancel = () => { cleanup(); resolve(false); };
      function onClose() { cleanup(); resolve(false); }
      function cleanup() {
        el.confirmOkBtn.removeEventListener('click', onOk);
        el.confirmCancelBtn.removeEventListener('click', onCancel);
        el.confirmDialog.removeEventListener('close', onClose);
        el.confirmDialog.close();
      }
      el.confirmOkBtn.addEventListener('click', onOk);
      el.confirmCancelBtn.addEventListener('click', onCancel);
      el.confirmDialog.addEventListener('close', onClose);
    });
  }

  /* ---------------- Theme / header toggle ---------------- */

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.appearance.darkMode ? 'dark' : 'light');
  }

  function applyAppearanceVars() {
    const root = document.documentElement.style;
    root.setProperty('--accent', state.appearance.accent);
    // derive a slightly stronger variant for solid buttons by mixing toward black
    root.setProperty('--accent-strong', state.appearance.accent);
    root.setProperty('--font-body', state.appearance.fontFamily);
    root.setProperty('--base-font-size', state.appearance.fontSize + 'px');
    el.customCssStyle.textContent = state.appearance.customCss || '';
  }

  function applyHeaderVisibility() {
    el.header.classList.toggle('is-hidden', !!state.headerHidden);
  }

  /* ---------------- Site card (thay cho iframe) ---------------- */

  const Card = {
    show(url) {
      const has = !!url;
      el.siteEmpty.hidden = has;
      el.siteInfo.hidden = !has;
      if (!has) return;
      el.siteHost.textContent = UrlUtil.hostLabel(url);
      el.siteUrl.textContent = url;
      el.siteLinkSame.href = url;
      el.siteLinkNew.href = url;
      showStatus('Ready: ' + UrlUtil.hostLabel(url), 'success', 2000);
    }
  };

  /* ---------------- Floating window (popup thật, điều hướng trực tiếp) ---------------- */

  const FloatWin = {
    NAME: 'ufv-popup',

    isOpen() { return !!floatWin && !floatWin.closed; },

    features() {
      const w = state.window.width, h = state.window.height;
      const left = Math.max(0, (screen.availLeft || 0) + screen.availWidth - w - 24);
      const top = (screen.availTop || 0) + 60;
      return `popup=yes,width=${w},height=${h},left=${left},top=${top},resizable=yes,scrollbars=yes`;
    },

    open(url) {
      if (!url) { showStatus('Enter and load a URL first.', 'error'); return; }
      if (FloatWin.isOpen()) {
        FloatWin.navigate(url);
        floatWin.focus();
        return;
      }
      // Mở about:blank cùng origin -> ngắt opener -> rồi điều hướng thẳng tới trang.
      const win = window.open('', FloatWin.NAME, FloatWin.features());
      if (!win) {
        showStatus('Popup blocked — allow popups for this page, or use "New tab".', 'error', 6000);
        return;
      }
      try { win.opener = null; } catch (e) { /* ignore */ }
      win.location.href = url;
      floatWin = win;
      FloatWin.watch();
      FloatWin.updateButtonLabel();
      showStatus('Floating window opened.', 'success', 2000);
    },

    navigate(url) {
      if (!FloatWin.isOpen()) return;
      try { floatWin.location.href = url; } catch (e) { window.open(url, FloatWin.NAME); }
    },

    close() {
      if (FloatWin.isOpen()) floatWin.close();
      floatWin = null;
      clearInterval(watchTimer);
      FloatWin.updateButtonLabel();
    },

    // Không có sự kiện "closed" cho cửa sổ khác origin, nên kiểm tra định kỳ.
    watch() {
      clearInterval(watchTimer);
      watchTimer = setInterval(() => {
        if (!FloatWin.isOpen()) {
          clearInterval(watchTimer);
          floatWin = null;
          FloatWin.updateButtonLabel();
          showStatus('Floating window closed.', 'info', 2000);
        }
      }, 800);
    },

    updateButtonLabel() {
      const span = el.openPipBtn.querySelector('span');
      if (span) span.textContent = FloatWin.isOpen() ? 'Close floating window' : 'Open floating window';
    }
  };

  /* ---------------- History ---------------- */

  const History = {
    MAX: 15,

    add(url, title) {
      const existingIdx = state.history.findIndex((h) => h.url === url);
      if (existingIdx !== -1) state.history.splice(existingIdx, 1);
      state.history.unshift({ url, title: title || UrlUtil.hostLabel(url), ts: Date.now() });
      state.history = state.history.slice(0, History.MAX);
      persist();
      History.render();
    },

    remove(url) {
      state.history = state.history.filter((h) => h.url !== url);
      persist();
      History.render();
    },

    clear() {
      state.history = [];
      persist();
      History.render();
    },

    render() {
      el.historyList.innerHTML = '';
      el.historyEmpty.hidden = state.history.length > 0;
      state.history.forEach((item) => {
        const li = document.createElement('li');
        li.className = 'history__item';

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'history__item-btn';
        btn.title = item.url;
        btn.textContent = item.url;
        btn.addEventListener('click', () => {
          el.urlInput.value = item.url;
          handleLoadRequest(item.url);
        });

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'history__item-remove';
        removeBtn.setAttribute('aria-label', 'Remove ' + item.url + ' from history');
        removeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
        removeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          History.remove(item.url);
        });

        li.appendChild(btn);
        li.appendChild(removeBtn);
        el.historyList.appendChild(li);
      });
    }
  };

  /* ---------------- Core load flow ---------------- */

  function handleLoadRequest(rawInput) {
    const normalized = UrlUtil.normalize(rawInput);
    if (!UrlUtil.isValid(normalized)) {
      el.urlInput.classList.add('is-invalid');
      showStatus('That doesn\u2019t look like a valid http(s) URL.', 'error', 4000);
      return;
    }
    el.urlInput.classList.remove('is-invalid');
    el.urlInput.value = normalized;
    currentUrl = normalized;
    state.lastUrl = normalized;
    persist();

    Card.show(normalized);
    History.add(normalized);

    if (FloatWin.isOpen() && state.behavior.autoUpdatePip) {
      FloatWin.navigate(normalized);
    }
  }

  /* ---------------- Settings <-> UI binding ---------------- */

  function initSettingsUI() {
    el.winWidth.value = state.window.width;
    el.winHeight.value = state.window.height;

    el.darkModeToggle.checked = state.appearance.darkMode;
    el.accentColor.value = state.appearance.accent;
    el.accentColorText.value = state.appearance.accent;
    el.fontFamily.value = state.appearance.fontFamily;
    el.fontSize.value = state.appearance.fontSize;
    el.fontSizeOut.textContent = state.appearance.fontSize;
    el.customCss.value = state.appearance.customCss;

    el.restoreUrlToggle.checked = state.behavior.restoreUrl;
    el.restoreSettingsToggle.checked = state.behavior.restoreSettings;
    el.keepUrlOnReopenToggle.checked = state.behavior.keepUrlOnReopen;
    el.autoUpdatePipToggle.checked = state.behavior.autoUpdatePip;
  }

  function bindSettingsEvents() {
    // Window settings
    el.winWidth.addEventListener('input', () => {
      state.window.width = clamp(num(el.winWidth.value, 420), 240, 2400);
      persist();
    });
    el.winHeight.addEventListener('input', () => {
      state.window.height = clamp(num(el.winHeight.value, 650), 200, 2000);
      persist();
    });

    // Appearance
    el.darkModeToggle.addEventListener('change', () => {
      state.appearance.darkMode = el.darkModeToggle.checked;
      applyTheme();
      persist();
    });
    el.accentColor.addEventListener('input', () => {
      el.accentColorText.value = el.accentColor.value;
      state.appearance.accent = el.accentColor.value;
      applyAppearanceVars();
      persist();
    });
    el.accentColorText.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(el.accentColorText.value)) {
        el.accentColor.value = el.accentColorText.value;
        state.appearance.accent = el.accentColorText.value;
        applyAppearanceVars();
        persist();
      }
    });
    el.fontFamily.addEventListener('change', () => {
      state.appearance.fontFamily = el.fontFamily.value;
      applyAppearanceVars();
      persist();
    });
    el.fontSize.addEventListener('input', () => {
      el.fontSizeOut.textContent = el.fontSize.value;
      state.appearance.fontSize = num(el.fontSize.value, 15);
      applyAppearanceVars();
      persist();
    });
    el.applyCssBtn.addEventListener('click', () => {
      state.appearance.customCss = el.customCss.value;
      applyAppearanceVars();
      persist();
      showStatus('Custom CSS applied.', 'success', 2000);
    });

    // Behavior
    el.restoreUrlToggle.addEventListener('change', () => {
      state.behavior.restoreUrl = el.restoreUrlToggle.checked;
      persist();
    });
    el.restoreSettingsToggle.addEventListener('change', () => {
      state.behavior.restoreSettings = el.restoreSettingsToggle.checked;
      persist();
    });
    el.keepUrlOnReopenToggle.addEventListener('change', () => {
      state.behavior.keepUrlOnReopen = el.keepUrlOnReopenToggle.checked;
      persist();
    });
    el.autoUpdatePipToggle.addEventListener('change', () => {
      state.behavior.autoUpdatePip = el.autoUpdatePipToggle.checked;
      persist();
    });

    el.resetSettingsBtn.addEventListener('click', async () => {
      const ok = await confirmAction('Reset all settings to their defaults? Your history will be kept.');
      if (!ok) return;
      const keptHistory = state.history;
      state = Store.reset();
      state.history = keptHistory;
      persist();
      initSettingsUI();
      applyTheme();
      applyAppearanceVars();
      applyHeaderVisibility();
      showStatus('Settings reset to defaults.', 'success', 2500);
    });
  }

  /* ---------------- Tabs ---------------- */

  function bindTabs() {
    el.tabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        el.tabs.forEach((b) => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-selected', String(b === btn));
        });
        el.panels.forEach((p) => { p.hidden = p.id !== btn.dataset.panel; });
      });
    });
  }

  /* ---------------- Header / theme buttons ---------------- */

  function bindHeaderButtons() {
    el.toggleHeaderBtn.addEventListener('click', () => {
      state.headerHidden = !state.headerHidden;
      applyHeaderVisibility();
      persist();
    });
    el.themeToggleBtn.addEventListener('click', () => {
      state.appearance.darkMode = !state.appearance.darkMode;
      el.darkModeToggle.checked = state.appearance.darkMode;
      applyTheme();
      persist();
    });
  }

  /* ---------------- URL bar ---------------- */

  function bindUrlBar() {
    el.urlForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleLoadRequest(el.urlInput.value);
    });

    el.urlInput.addEventListener('input', () => el.urlInput.classList.remove('is-invalid'));

    el.openTabBtn.addEventListener('click', () => {
      const target = currentUrl || UrlUtil.normalize(el.urlInput.value);
      if (!target || !UrlUtil.isValid(target)) {
        showStatus('Load a valid URL first.', 'error');
        return;
      }
      window.open(target, '_blank', 'noopener,noreferrer');
    });

    el.openPipBtn.addEventListener('click', () => {
      const target = currentUrl || UrlUtil.normalize(el.urlInput.value);
      if (FloatWin.isOpen()) {
        FloatWin.close();
        return;
      }
      if (!target || !UrlUtil.isValid(target)) {
        showStatus('Load a URL first, then open the floating window.', 'error');
        return;
      }
      FloatWin.open(target);
    });
  }

  /* ---------------- Clear history button ---------------- */

  function bindHistoryButtons() {
    el.clearHistoryBtn.addEventListener('click', async () => {
      if (state.history.length === 0) return;
      const ok = await confirmAction('Clear all recent URLs? This can\u2019t be undone.');
      if (ok) {
        History.clear();
        showStatus('History cleared.', 'info', 2000);
      }
    });
  }

  /* ---------------- Init ---------------- */

  function init() {

    initSettingsUI();
    applyTheme();
    applyAppearanceVars();
    applyHeaderVisibility();
    History.render();
    FloatWin.updateButtonLabel();

    bindTabs();
    bindHeaderButtons();
    bindUrlBar();
    bindSettingsEvents();
    bindHistoryButtons();

    if (state.behavior.restoreUrl && state.lastUrl && UrlUtil.isValid(state.lastUrl)) {
      el.urlInput.value = state.lastUrl;
      currentUrl = state.lastUrl;
      Card.show(state.lastUrl);
    } else {
      Card.show('');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
