'use strict';

/* ===================================================================
   Universal Floating Viewer — script.js
   Vanilla JS, no dependencies. Organized into small modules:
     - Store        : localStorage read/write with validation
     - Settings     : app settings state + DOM binding
     - History      : recent URL list
     - UrlUtil       : normalize/validate URLs
     - Preview      : main-page iframe preview + embed-block detection
     - PiP          : Document Picture-in-Picture window management
     - UI           : header, theme, tabs, status bar, dialog
   =================================================================== */

(function () {

  /* ---------------- Store ---------------- */

  const STORAGE_KEY = 'ufv:v1';

  const DEFAULT_STATE = {
    lastUrl: '',
    history: [], // [{ url, title, ts }]
    blockedHosts: [], // hosts the user marked as "refuses to be embedded"
    window: {
      width: 420,
      height: 650,
      bg: '#0d1210',
      radius: 12,
      padding: 0,
      showHeaderInPip: false
    },
    appearance: {
      darkMode: true,
      accent: '#7fae2e',
      fontFamily: "'IBM Plex Sans', system-ui, sans-serif",
      fontSize: 15,
      frameOpacity: 100,
      customCss: ''
    },
    behavior: {
      restoreUrl: true,
      restoreSettings: true,
      keepUrlOnReopen: true,
      autoUpdatePip: true,
      autoPopupBlocked: true
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
        if (!Array.isArray(merged.blockedHosts)) merged.blockedHosts = [];
        merged.blockedHosts = merged.blockedHosts.filter((h) => typeof h === 'string' && h);
        // Clamp numeric fields defensively
        merged.window.width = clamp(num(merged.window.width, 420), 240, 2400);
        merged.window.height = clamp(num(merged.window.height, 650), 200, 2000);
        merged.window.radius = clamp(num(merged.window.radius, 12), 0, 60);
        merged.window.padding = clamp(num(merged.window.padding, 0), 0, 60);
        merged.appearance.fontSize = clamp(num(merged.appearance.fontSize, 15), 10, 28);
        merged.appearance.frameOpacity = clamp(num(merged.appearance.frameOpacity, 100), 10, 100);
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

  /* ---------------- Embed helpers ---------------- */

  // Sites that send X-Frame-Options / CSP frame-ancestors and refuse to be
  // shown inside an iframe. These go straight to a real popup window.
  const KNOWN_BLOCKED = [
    'google.com', 'bing.com', 'facebook.com', 'instagram.com', 'x.com',
    'twitter.com', 'github.com', 'linkedin.com', 'reddit.com', 'netflix.com',
    'amazon.com', 'paypal.com', 'whatsapp.com', 'discord.com', 'tiktok.com',
    'youtube.com', 'zalo.me', 'chat.openai.com', 'chatgpt.com', 'claude.ai'
  ];

  function hostMatches(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  const Embed = {
    /** Turn watch-page links into embeddable player links where possible. */
    toEmbeddable(url) {
      const u = UrlUtil.parse(url);
      if (!u) return url;
      const host = u.hostname.replace(/^www\./, '');
      if (hostMatches(host, 'youtube.com')) {
        if (u.pathname.startsWith('/embed/')) return url;
        const id = u.searchParams.get('v');
        if (u.pathname === '/watch' && id) return 'https://www.youtube.com/embed/' + encodeURIComponent(id);
        const m = u.pathname.match(/^\/(?:shorts|live)\/([\w-]+)/);
        if (m) return 'https://www.youtube.com/embed/' + m[1];
      }
      if (host === 'youtu.be') {
        const id = u.pathname.slice(1).split('/')[0];
        if (id) return 'https://www.youtube.com/embed/' + encodeURIComponent(id);
      }
      if (host === 'vimeo.com') {
        const m = u.pathname.match(/^\/(\d+)/);
        if (m) return 'https://player.vimeo.com/video/' + m[1];
      }
      return url;
    },
    isTransformed(url) {
      return Embed.toEmbeddable(url) !== url;
    },
    /** True when we expect the site to refuse embedding. */
    isBlocked(url) {
      if (Embed.isTransformed(url)) return false;
      const u = UrlUtil.parse(url);
      if (!u) return false;
      const host = u.hostname.replace(/^www\./, '');
      return KNOWN_BLOCKED.some((d) => hostMatches(host, d)) ||
        state.blockedHosts.some((d) => hostMatches(host, d));
    },
    remember(url) {
      const u = UrlUtil.parse(url);
      if (!u) return;
      const host = u.hostname.replace(/^www\./, '');
      if (!state.blockedHosts.includes(host)) {
        state.blockedHosts.push(host);
        persist();
      }
    }
  };

  /* ---------------- App state ---------------- */

  let state = Store.load();
  let currentUrl = '';
  let pipWindow = null;
  let pipIframe = null;

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

    frameWrap: $('#previewFrameWrap'),
    frame: $('#previewFrame'),
    frameEmpty: $('.preview-frame__empty'),
    frameLoading: $('.preview-frame__loading'),
    frameBlocked: $('.preview-frame__blocked'),
    embedHint: $('#embedHint'),
    hintPopupBtn: $('#hintPopupBtn'),
    blockedPopupBtn: $('#blockedPopupBtn'),
    blockedTabBtn: $('#blockedTabBtn'),
    blockedMsg: $('#blockedMsg'),

    tabs: Array.from(document.querySelectorAll('.tabs__btn')),
    panels: Array.from(document.querySelectorAll('.panel')),

    winWidth: $('#winWidth'),
    winHeight: $('#winHeight'),
    winBg: $('#winBg'),
    winBgText: $('#winBgText'),
    winRadius: $('#winRadius'),
    winRadiusOut: $('#winRadiusOut'),
    winPadding: $('#winPadding'),
    winPaddingOut: $('#winPaddingOut'),
    showHeaderInPip: $('#showHeaderInPip'),

    darkModeToggle: $('#darkModeToggle'),
    accentColor: $('#accentColor'),
    accentColorText: $('#accentColorText'),
    fontFamily: $('#fontFamily'),
    fontSize: $('#fontSize'),
    fontSizeOut: $('#fontSizeOut'),
    frameOpacity: $('#frameOpacity'),
    frameOpacityOut: $('#frameOpacityOut'),
    customCss: $('#customCss'),
    applyCssBtn: $('#applyCssBtn'),
    customCssStyle: $('#customCssStyle'),

    restoreUrlToggle: $('#restoreUrlToggle'),
    restoreSettingsToggle: $('#restoreSettingsToggle'),
    keepUrlOnReopenToggle: $('#keepUrlOnReopenToggle'),
    autoUpdatePipToggle: $('#autoUpdatePipToggle'),
    autoPopupBlockedToggle: $('#autoPopupBlockedToggle'),
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
    el.frame.style.opacity = String(state.appearance.frameOpacity / 100);
    el.customCssStyle.textContent = state.appearance.customCss || '';
  }

  function applyHeaderVisibility() {
    el.header.classList.toggle('is-hidden', !!state.headerHidden);
  }

  /* ---------------- Preview (main page iframe) ---------------- */

  const Preview = {
    setState(mode) {
      // mode: 'empty' | 'loading' | 'loaded' | 'blocked'
      el.frameWrap.dataset.state = mode;
      el.frameEmpty.hidden = mode !== 'empty';
      el.frameLoading.hidden = mode !== 'loading';
      el.frameBlocked.hidden = mode !== 'blocked';
      el.frame.hidden = mode !== 'loaded';
    }
  };

  // Loads a URL into the main-page preview iframe. Sites that forbid embedding
  // (X-Frame-Options / CSP frame-ancestors) usually never fire a usable 'load'
  // event, and we can't read cross-origin frame content to confirm either way —
  // so a generous timeout is used as a heuristic, and we never claim success
  // we can't verify.
  let hardTimeout = null;

  // userInitiated = true when triggered by a click/submit, so opening a popup
  // is allowed by the browser. On startup restore we only show the blocked state.
  function loadIntoPreview(url, userInitiated) {
    clearTimeout(hardTimeout);
    el.embedHint.hidden = true;

    // Known (or previously remembered) blocked site: don't even try the iframe.
    if (Embed.isBlocked(url)) {
      el.frame.src = 'about:blank';
      el.blockedMsg.textContent = UrlUtil.hostLabel(url) + ' doesn\u2019t allow being shown inside another page.';
      Preview.setState('blocked');
      if (userInitiated && state.behavior.autoPopupBlocked) {
        PiP.openFallbackPopup(url, true);
      } else {
        showStatus(UrlUtil.hostLabel(url) + ' refuses embedding \u2014 use "Open as popup".', 'error', 5000);
      }
      return;
    }

    Preview.setState('loading');
    let settled = false;

    function finishLoaded() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      Preview.setState('loaded');
      // We can't read cross-origin frames, so a "refused to connect" error page
      // also fires 'load'. Always offer a one-click way out.
      el.embedHint.hidden = false;
      showStatus('Loaded ' + UrlUtil.hostLabel(url), 'success');
    }
    function finishBlocked() {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      el.blockedMsg.textContent = 'This site may not allow embedding.';
      Preview.setState('blocked');
      showStatus('This site refused to be embedded.', 'error', 5000);
    }

    el.frame.onload = finishLoaded;
    el.frame.onerror = finishBlocked;
    hardTimeout = setTimeout(() => {
      if (!settled) finishBlocked();
    }, 9000);

    el.frame.src = Embed.toEmbeddable(url);
  }

  /* ---------------- Document Picture-in-Picture ---------------- */

  const PiP = {
    isSupported() {
      return 'documentPictureInPicture' in window;
    },

    isOpen() {
      return !!pipWindow && !pipWindow.closed;
    },

    async open(url) {
      if (!PiP.isSupported()) {
        showStatus('Your browser does not support floating windows (Document Picture-in-Picture). Try a recent Chrome/Edge, or use "New tab" instead.', 'error', 7000);
        return;
      }
      if (!url) {
        showStatus('Enter and load a URL first.', 'error');
        return;
      }
      if (Embed.isBlocked(url)) {
        PiP.openFallbackPopup(url, true);
        return;
      }
      if (PiP.isOpen()) {
        PiP.navigate(url);
        PiP.syncStyles();
        return;
      }

      try {
        pipWindow = await window.documentPictureInPicture.requestWindow({
          width: state.window.width,
          height: state.window.height
        });
      } catch (err) {
        console.warn('PiP request failed:', err);
        showStatus('Could not open the floating window (it may need a user gesture, or was blocked). Opening a regular popup instead.', 'error', 6000);
        PiP.openFallbackPopup(url);
        return;
      }

      PiP.buildContents(pipWindow, url);

      pipWindow.addEventListener('pagehide', () => {
        pipWindow = null;
        pipIframe = null;
        PiP.updateButtonLabel();
        showStatus('Floating window closed.', 'info', 2000);
      });

      PiP.updateButtonLabel();
      showStatus('Floating window opened.', 'success', 2000);
    },

    buildContents(win, url) {
      const doc = win.document;
      doc.title = 'Floating Viewer';

      // Copy this page's stylesheets so the PiP window matches current theming.
      Array.from(document.styleSheets).forEach((sheet) => {
        try {
          if (sheet.href) {
            const link = doc.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            doc.head.appendChild(link);
          }
        } catch (e) { /* cross-origin stylesheet access can throw; safe to skip */ }
      });
      const inlineStyle = doc.createElement('style');
      inlineStyle.textContent = buildPipInlineCss();
      doc.head.appendChild(inlineStyle);

      doc.documentElement.setAttribute('data-theme', state.appearance.darkMode ? 'dark' : 'light');

      doc.body.innerHTML = '';
      doc.body.className = 'pip-body';

      if (state.window.showHeaderInPip) {
        const header = doc.createElement('div');
        header.className = 'pip-header';
        header.innerHTML =
          '<span class="pip-header__url"></span>' +
          '<button type="button" class="pip-header__popup" title="Page not showing? Open as popup" aria-label="Open as popup window">\u2197</button>' +
          '<button type="button" class="pip-header__close" aria-label="Close floating window">✕</button>';
        header.querySelector('.pip-header__url').textContent = UrlUtil.hostLabel(url);
        header.querySelector('.pip-header__popup').addEventListener('click', () => {
          const target = currentUrl || url;
          Embed.remember(target);
          PiP.openFallbackPopup(target, true);
        });
        header.querySelector('.pip-header__close').addEventListener('click', () => PiP.close());
        doc.body.appendChild(header);
      }

      const frame = doc.createElement('iframe');
      frame.className = 'pip-frame';
      frame.referrerPolicy = 'no-referrer';
      frame.src = Embed.toEmbeddable(url);
      doc.body.appendChild(frame);
      pipIframe = frame;
    },

    syncStyles() {
      if (!PiP.isOpen()) return;
      const doc = pipWindow.document;
      doc.documentElement.setAttribute('data-theme', state.appearance.darkMode ? 'dark' : 'light');
      const style = doc.querySelector('style[data-pip-inline]') || (() => {
        const s = doc.createElement('style');
        s.setAttribute('data-pip-inline', '1');
        doc.head.appendChild(s);
        return s;
      })();
      style.textContent = buildPipInlineCss();
    },

    navigate(url) {
      if (!PiP.isOpen() || !pipIframe) return;
      if (Embed.isBlocked(url)) {
        PiP.openFallbackPopup(url, true);
        return;
      }
      pipIframe.src = Embed.toEmbeddable(url);
      const label = pipWindow.document.querySelector('.pip-header__url');
      if (label) label.textContent = UrlUtil.hostLabel(url);
    },

    close() {
      if (PiP.isOpen()) {
        pipWindow.close();
      }
      pipWindow = null;
      pipIframe = null;
      PiP.updateButtonLabel();
    },

    updateButtonLabel() {
      const span = el.openPipBtn.querySelector('span');
      if (span) span.textContent = PiP.isOpen() ? 'Close floating window' : 'Open floating window';
    },

    openFallbackPopup(url, quiet) {
      const w = state.window.width, h = state.window.height;
      const features = `popup=yes,width=${w},height=${h},resizable=yes,scrollbars=yes`;
      const popup = window.open(url, 'ufv-popup', features);
      if (!popup) {
        showStatus('Popup blocked \u2014 allow popups for this page, or use "New tab".', 'error', 6000);
      } else {
        popup.focus();
        showStatus(quiet ? 'Opened ' + UrlUtil.hostLabel(url) + ' in a popup window (it blocks embedding).' : 'Opened as a regular popup window instead of PiP.', 'info', 4000);
      }
    },

    toggle(url) {
      if (PiP.isOpen()) {
        PiP.close();
      } else {
        PiP.open(url);
      }
    }
  };

  function buildPipInlineCss() {
    const w = state.window;
    return `
      html, body.pip-body { margin: 0; height: 100%; background: ${w.bg}; }
      body.pip-body { display: flex; flex-direction: column; padding: ${w.padding}px; box-sizing: border-box; }
      .pip-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; font: 500 12px var(--font-body, sans-serif);
        color: var(--text, #e7ede9); background: var(--bg-raised, #131a17);
        border-bottom: 1px solid var(--border, #223028);
        border-radius: ${w.radius}px ${w.radius}px 0 0;
      }
      .pip-header__url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .pip-header__popup, .pip-header__close { background: none; border: 0; color: inherit; cursor: pointer; font-size: 14px; padding: 2px 6px; }
      .pip-frame {
        flex: 1; width: 100%; border: 0;
        border-radius: ${state.window.showHeaderInPip ? `0 0 ${w.radius}px ${w.radius}px` : `${w.radius}px`};
        background: #fff;
      }
    `;
  }

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

    loadIntoPreview(normalized, true);
    History.add(normalized);

    if (PiP.isOpen() && state.behavior.autoUpdatePip && !Embed.isBlocked(normalized)) {
      PiP.navigate(normalized);
    }
  }

  /* ---------------- Settings <-> UI binding ---------------- */

  function initSettingsUI() {
    el.winWidth.value = state.window.width;
    el.winHeight.value = state.window.height;
    el.winBg.value = state.window.bg;
    el.winBgText.value = state.window.bg;
    el.winRadius.value = state.window.radius;
    el.winRadiusOut.textContent = state.window.radius;
    el.winPadding.value = state.window.padding;
    el.winPaddingOut.textContent = state.window.padding;
    el.showHeaderInPip.checked = state.window.showHeaderInPip;

    el.darkModeToggle.checked = state.appearance.darkMode;
    el.accentColor.value = state.appearance.accent;
    el.accentColorText.value = state.appearance.accent;
    el.fontFamily.value = state.appearance.fontFamily;
    el.fontSize.value = state.appearance.fontSize;
    el.fontSizeOut.textContent = state.appearance.fontSize;
    el.frameOpacity.value = state.appearance.frameOpacity;
    el.frameOpacityOut.textContent = state.appearance.frameOpacity;
    el.customCss.value = state.appearance.customCss;

    el.restoreUrlToggle.checked = state.behavior.restoreUrl;
    el.restoreSettingsToggle.checked = state.behavior.restoreSettings;
    el.keepUrlOnReopenToggle.checked = state.behavior.keepUrlOnReopen;
    el.autoUpdatePipToggle.checked = state.behavior.autoUpdatePip;
    el.autoPopupBlockedToggle.checked = state.behavior.autoPopupBlocked;
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
    el.winBg.addEventListener('input', () => {
      el.winBgText.value = el.winBg.value;
      state.window.bg = el.winBg.value;
      persist();
      PiP.syncStyles();
    });
    el.winBgText.addEventListener('change', () => {
      if (/^#[0-9a-f]{6}$/i.test(el.winBgText.value)) {
        el.winBg.value = el.winBgText.value;
        state.window.bg = el.winBgText.value;
        persist();
        PiP.syncStyles();
      }
    });
    el.winRadius.addEventListener('input', () => {
      el.winRadiusOut.textContent = el.winRadius.value;
      state.window.radius = num(el.winRadius.value, 12);
      persist();
      PiP.syncStyles();
    });
    el.winPadding.addEventListener('input', () => {
      el.winPaddingOut.textContent = el.winPadding.value;
      state.window.padding = num(el.winPadding.value, 0);
      persist();
      PiP.syncStyles();
    });
    el.showHeaderInPip.addEventListener('change', () => {
      state.window.showHeaderInPip = el.showHeaderInPip.checked;
      persist();
      // Header add/remove needs a rebuild rather than a style sync.
      if (PiP.isOpen()) PiP.buildContents(pipWindow, currentUrl || state.lastUrl);
    });

    // Appearance
    el.darkModeToggle.addEventListener('change', () => {
      state.appearance.darkMode = el.darkModeToggle.checked;
      applyTheme();
      persist();
      PiP.syncStyles();
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
    el.frameOpacity.addEventListener('input', () => {
      el.frameOpacityOut.textContent = el.frameOpacity.value;
      state.appearance.frameOpacity = num(el.frameOpacity.value, 100);
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

    el.autoPopupBlockedToggle.addEventListener('change', () => {
      state.behavior.autoPopupBlocked = el.autoPopupBlockedToggle.checked;
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
      PiP.syncStyles();
    });
  }

  /* ---------------- URL bar ---------------- */

  function bindUrlBar() {
    el.urlForm.addEventListener('submit', (e) => {
      e.preventDefault();
      handleLoadRequest(el.urlInput.value);
    });

    el.urlInput.addEventListener('input', () => el.urlInput.classList.remove('is-invalid'));

    function popupCurrent(remember) {
      const target = currentUrl || UrlUtil.normalize(el.urlInput.value);
      if (!target || !UrlUtil.isValid(target)) {
        showStatus('Load a valid URL first.', 'error');
        return;
      }
      if (remember) {
        Embed.remember(target);
        showStatus('Will open ' + UrlUtil.hostLabel(target) + ' in a popup next time.', 'success', 3000);
      }
      PiP.openFallbackPopup(target, true);
    }
    el.hintPopupBtn.addEventListener('click', () => popupCurrent(true));
    el.blockedPopupBtn.addEventListener('click', () => popupCurrent(true));
    el.blockedTabBtn.addEventListener('click', () => el.openTabBtn.click());

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
      if (PiP.isOpen()) {
        PiP.close();
        return;
      }
      if (!target || !UrlUtil.isValid(target)) {
        showStatus('Load a URL first, then open the floating window.', 'error');
        return;
      }
      PiP.open(target);
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
    if (!PiP.isSupported()) {
      el.openPipBtn.title = 'Document Picture-in-Picture is not supported in this browser — will fall back to a popup window.';
    }
    if (!window.isSecureContext) {
      showStatus('This page isn\u2019t running in a secure context (HTTPS or localhost) — the floating window may be unavailable.', 'error', 6000);
    }

    initSettingsUI();
    applyTheme();
    applyAppearanceVars();
    applyHeaderVisibility();
    History.render();
    PiP.updateButtonLabel();

    bindTabs();
    bindHeaderButtons();
    bindUrlBar();
    bindSettingsEvents();
    bindHistoryButtons();

    if (state.behavior.restoreUrl && state.lastUrl && UrlUtil.isValid(state.lastUrl)) {
      el.urlInput.value = state.lastUrl;
      currentUrl = state.lastUrl;
      loadIntoPreview(state.lastUrl);
    } else {
      Preview.setState('empty');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
