(() => {
  const {
    createLayerCanvas,
    resizeCanvasPreservingContent,
    compositeLayers,
    pointerToCanvasPoint,
    stampDot,
    stampAlongPath,
  } = window.DrawEngine;

  const canvas = document.getElementById('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const canvasScreenEl = document.getElementById('canvasScreen');
  const canvasScreenCtx = canvasScreenEl?.getContext('2d') ?? null;

  const toolEl = document.getElementById('tool');
  const colorEl = document.getElementById('color');
  const bgColorEl = document.getElementById('bgColor');
  const nodeEditorEl = document.getElementById('nodeEditor');
  const nodeLinksEl = document.getElementById('nodeLinks');
  const nodeNodesEl = document.getElementById('nodeNodes');
  const nodeAddEl = document.getElementById('nodeAdd');
  const folderAddEl = document.getElementById('folderAdd');
  const nodeDelEl = document.getElementById('nodeDel');
  const workspaceEl = document.getElementById('workspace');
  const canvasPanelEl = document.getElementById('canvasPanel');
  const canvasHandleEl = document.getElementById('canvasHandle');
  const canvasResizeEl = document.getElementById('canvasResize');
  const nodePanelEl = document.getElementById('nodePanel');
  const nodeHandleEl = document.getElementById('nodeHandle');
  const nodeResizeEl = document.getElementById('nodeResize');
  const nodeResizeTopEl = document.getElementById('nodeResizeTop');
  const nodeResizeRightEl = document.getElementById('nodeResizeRight');
  const nodeResizeBottomEl = document.getElementById('nodeResizeBottom');
  const nodeResizeLeftEl = document.getElementById('nodeResizeLeft');
  const brushPresetListEl = document.getElementById('brushPresetList');
  const brushPresetSaveEl = document.getElementById('brushPresetSave');
  const brushPresetUpdateEl = document.getElementById('brushPresetUpdate');
  const brushPresetDeleteEl = document.getElementById('brushPresetDelete');
  const sizeEl = document.getElementById('size');
  const sizeValueEl = document.getElementById('sizeValue');
  const sizeMinEl = document.getElementById('sizeMin');
  const sizeMinValueEl = document.getElementById('sizeMinValue');
  const sizeMaxEl = document.getElementById('sizeMax');
  const sizeMaxValueEl = document.getElementById('sizeMaxValue');
  const sizePressureEnabledEl = document.getElementById('sizePressureEnabled');
  const blurEl = document.getElementById('blur');
  const blurValueEl = document.getElementById('blurValue');
  const spacingEl = document.getElementById('spacing');
  const spacingValueEl = document.getElementById('spacingValue');
  const opacityEl = document.getElementById('opacity');
  const opacityValueEl = document.getElementById('opacityValue');
  const opacityMinEl = document.getElementById('opacityMin');
  const opacityMinValueEl = document.getElementById('opacityMinValue');
  const opacityMaxEl = document.getElementById('opacityMax');
  const opacityMaxValueEl = document.getElementById('opacityMaxValue');
  const opacityPressureEnabledEl = document.getElementById('opacityPressureEnabled');
  const eyedropperEl = document.getElementById('eyedropper');
  const bucketEl = document.getElementById('bucket');
  const clearEl = document.getElementById('clear');
  const saveEl = document.getElementById('save');
  const saveProjectEl = document.getElementById('saveProject');
  const openProjectEl = document.getElementById('openProject');
  const openProjectInputEl = document.getElementById('openProjectInput');
  const closeProjectEl = document.getElementById('closeProject');
  const savePsdEl = document.getElementById('savePsd');
  const hintEl = document.getElementById('hint');
  const shortcutRowsEl = document.getElementById('shortcutRows');
  const shortcutsResetDefaultEl = document.getElementById('shortcutsResetDefault');
  const shortcutsSaveEl = document.getElementById('shortcutsSave');
  const openCanvasSettingsEl = document.getElementById('openCanvasSettings');
  const canvasSettingsDialogEl = document.getElementById('canvasSettingsDialog');
  const canvasSettingsCloseEl = document.getElementById('canvasSettingsClose');
  const canvasModeResizeEl = document.getElementById('canvasModeResize');
  const canvasModeCropEl = document.getElementById('canvasModeCrop');
  const canvasModeHintEl = document.getElementById('canvasModeHint');
  const canvasWidthInputEl = document.getElementById('canvasWidthInput');
  const canvasHeightInputEl = document.getElementById('canvasHeightInput');
  const lockAspectRowEl = document.getElementById('lockAspectRow');
  const lockAspectInputEl = document.getElementById('lockAspectInput');
  const anchorGridWrapEl = document.getElementById('anchorGridWrap');
  const anchorGridEl = document.getElementById('anchorGrid');
  const canvasSettingsApplyEl = document.getElementById('canvasSettingsApply');
  const openGlobalSettingsEl = document.getElementById('openGlobalSettings');
  const resetViewEl = document.getElementById('resetView');
  const globalSettingsDialogEl = document.getElementById('globalSettingsDialog');
  const globalSettingsCloseEl = document.getElementById('globalSettingsClose');
  const pressureEnabledInputEl = document.getElementById('pressureEnabledInput');
  const stabilizerEl = document.getElementById('stabilizer');
  const stabilizerValueEl = document.getElementById('stabilizerValue');
  const pressureSmoothingEl = document.getElementById('pressureSmoothing');
  const pressureSmoothingValueEl = document.getElementById('pressureSmoothingValue');
  const globalHoldThresholdEl = document.getElementById('globalHoldThreshold');
  const globalHoldThresholdValueEl = document.getElementById('globalHoldThresholdValue');

  const state = {
    drawing: false,
    last: null,
    tool: 'brush',
    color: '#111111',
    bgColor: '#ffffff',
    size: 8,
    blur: 0,
    sizeMinPercent: 10,
    sizeMaxPercent: 100,
    sizePressureEnabled: true,
    opacity: 100,
    opacityMinPercent: 0,
    opacityMaxPercent: 100,
    opacityPressureEnabled: true,
    spacingPct: 15,
    // Global — shared across every brush, not part of any preset (see readGlobalSettings).
    stabilizerStrength: 0,
    pressureSmoothingStrength: 0,
    pressureEnabled: true,
    holdThresholdMs: 350,
    brushPresets: [], // populated at init() from readBrushPresets()
    activeBrushPresetId: null,
    shortcuts: null, // populated at init() from readShortcuts()
    previousTool: null,
    toolHoldStartedAt: null,
    toolHoldCode: null,
    toolHoldTarget: null,
    positionBuffer: [],
    pressureBuffer: [],
    smoothX: 0,
    smoothY: 0,
    smoothedPressure: 1,
    strokeDistanceAcc: 0,
    undo: [],
    redo: [],
    maxHistory: 30,

    layers: [],
    folders: [],
    activeLayerId: null,
    nextNodeId: 1,

    draggingNodeId: null,
    dragOffset: { x: 0, y: 0 },
    dropTargetFolderId: null,
    rafPending: false,

    linkingFromLayerId: null,

    panelDrag: null,

    zoom: 1,
    panX: 0,
    panY: 0,
    spaceDown: false,
    zoomDrag: null,
    panDrag: null,
  };

  const layoutKey = 'paintsoft.layout.v1';
  const canvasSizeKey = 'paintsoft.canvasSize.v1';
  const DEFAULT_CANVAS_WIDTH = 1600;
  const DEFAULT_CANVAS_HEIGHT = 1200;

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  function readLayout() {
    try {
      const raw = localStorage.getItem(layoutKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function writeLayout(next) {
    try {
      localStorage.setItem(layoutKey, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  // The document's own pixel resolution, independent of how big its panel looks on screen —
  // last-used value, persisted across reloads the same way panel layout is.
  function readCanvasSize() {
    try {
      const raw = localStorage.getItem(canvasSizeKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const width = Math.floor(parsed?.width);
      const height = Math.floor(parsed?.height);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      return { width, height };
    } catch {
      return null;
    }
  }

  function writeCanvasSize(width, height) {
    try {
      localStorage.setItem(canvasSizeKey, JSON.stringify({ width, height }));
    } catch {
      // ignore
    }
  }

  // ---- Brush presets ------------------------------------------------------------------
  const brushPresetsKey = 'paintsoft.brushPresets.v1';

  function readBrushPresets() {
    try {
      const raw = localStorage.getItem(brushPresetsKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeBrushPresets(list) {
    try {
      localStorage.setItem(brushPresetsKey, JSON.stringify(list));
    } catch {
      // ignore
    }
  }

  // Only the parameters that shape how a stamp looks/behaves are captured — not color (kept
  // as a separate always-global control, moved to the topbar) and not 手ブレ補正/筆圧補正/
  // 筆圧ON-OFF (moved to the global settings dialog — shared across every brush, see
  // readGlobalSettings/persistGlobalSettings below).
  function captureBrushSettings() {
    return {
      size: state.size,
      sizeMinPercent: state.sizeMinPercent,
      sizeMaxPercent: state.sizeMaxPercent,
      sizePressureEnabled: state.sizePressureEnabled,
      blur: state.blur,
      spacingPct: state.spacingPct,
      opacity: state.opacity,
      opacityMinPercent: state.opacityMinPercent,
      opacityMaxPercent: state.opacityMaxPercent,
      opacityPressureEnabled: state.opacityPressureEnabled,
    };
  }

  function applyBrushSettings(settings) {
    state.size = settings.size ?? state.size;
    sizeEl.value = String(state.size);
    sizeValueEl.textContent = String(state.size);

    state.sizeMinPercent = settings.sizeMinPercent ?? 10;
    if (sizeMinEl) sizeMinEl.value = String(state.sizeMinPercent);
    if (sizeMinValueEl) sizeMinValueEl.textContent = `${state.sizeMinPercent}%`;

    state.sizeMaxPercent = settings.sizeMaxPercent ?? 100;
    if (sizeMaxEl) sizeMaxEl.value = String(state.sizeMaxPercent);
    if (sizeMaxValueEl) sizeMaxValueEl.textContent = `${state.sizeMaxPercent}%`;

    state.sizePressureEnabled = settings.sizePressureEnabled ?? true;
    if (sizePressureEnabledEl) sizePressureEnabledEl.checked = state.sizePressureEnabled;

    state.blur = settings.blur ?? 0;
    if (blurEl) blurEl.value = String(state.blur);
    if (blurValueEl) blurValueEl.textContent = String(state.blur);

    state.spacingPct = settings.spacingPct ?? state.spacingPct;
    if (spacingEl) spacingEl.value = String(state.spacingPct);
    if (spacingValueEl) spacingValueEl.textContent = `${state.spacingPct}%`;

    state.opacity = settings.opacity ?? 100;
    if (opacityEl) opacityEl.value = String(state.opacity);
    if (opacityValueEl) opacityValueEl.textContent = `${state.opacity}%`;

    state.opacityMinPercent = settings.opacityMinPercent ?? 0;
    if (opacityMinEl) opacityMinEl.value = String(state.opacityMinPercent);
    if (opacityMinValueEl) opacityMinValueEl.textContent = `${state.opacityMinPercent}%`;

    state.opacityMaxPercent = settings.opacityMaxPercent ?? 100;
    if (opacityMaxEl) opacityMaxEl.value = String(state.opacityMaxPercent);
    if (opacityMaxValueEl) opacityMaxValueEl.textContent = `${state.opacityMaxPercent}%`;

    state.opacityPressureEnabled = settings.opacityPressureEnabled ?? true;
    if (opacityPressureEnabledEl) opacityPressureEnabledEl.checked = state.opacityPressureEnabled;
  }

  // ---- Current brush settings persistence (auto-saved on every change, restored on load) ---
  // Separate from named presets above: this always mirrors whatever the "現在の設定" sliders
  // are currently set to, so closing and reopening the app resumes with the same brush instead
  // of resetting to the HTML's hardcoded defaults.
  const currentBrushKey = 'paintsoft.currentBrush.v1';

  function readCurrentBrushSettings() {
    try {
      const raw = localStorage.getItem(currentBrushKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function persistCurrentBrushSettings() {
    try {
      localStorage.setItem(
        currentBrushKey,
        JSON.stringify({ ...captureBrushSettings(), activeBrushPresetId: state.activeBrushPresetId })
      );
    } catch {
      // ignore
    }
  }

  // ---- Global settings (グローバル設定 dialog) — shared across every brush, never saved
  // as part of a preset or the per-brush "current" settings above.
  const globalSettingsKey = 'paintsoft.globalSettings.v1';

  function readGlobalSettings() {
    try {
      const raw = localStorage.getItem(globalSettingsKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function persistGlobalSettings() {
    try {
      localStorage.setItem(
        globalSettingsKey,
        JSON.stringify({
          stabilizerStrength: state.stabilizerStrength,
          pressureSmoothingStrength: state.pressureSmoothingStrength,
          pressureEnabled: state.pressureEnabled,
          holdThresholdMs: state.holdThresholdMs,
        })
      );
    } catch {
      // ignore
    }
  }

  // Renders the brush list (separate from the "現在の設定" sliders below it, which always
  // just reflect state.* directly — selecting a row here applies its saved values into
  // those sliders via applyBrushSettings). The active row stays highlighted even if the
  // user nudges a slider afterward; it only changes on selecting a different row, saving a
  // new brush, or deleting the active one.
  function renderBrushPresetList() {
    if (!brushPresetListEl) return;

    if (state.brushPresets.length === 0) {
      brushPresetListEl.innerHTML = '<div class="brushPresetEmpty">（保存されたブラシはありません）</div>';
      return;
    }

    brushPresetListEl.innerHTML = state.brushPresets
      .map((p) => {
        const activeClass = p.id === state.activeBrushPresetId ? ' active' : '';
        return `<div class="brushPresetRow${activeClass}" data-id="${p.id}" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`;
      })
      .join('');

    brushPresetListEl.querySelectorAll('.brushPresetRow').forEach((row) => {
      row.addEventListener('click', () => {
        const id = Number(row.dataset.id);
        const preset = state.brushPresets.find((p) => p.id === id);
        if (!preset) return;
        state.activeBrushPresetId = id;
        applyBrushSettings(preset);
        persistCurrentBrushSettings();
        renderBrushPresetList();
      });
    });
  }

  // ---- Configurable keyboard shortcuts ---------------------------------------------
  const isMac = navigator.platform.toLowerCase().includes('mac');

  // "ctrl" here means "the platform's primary modifier" — Cmd on Mac, Ctrl elsewhere —
  // matching how undo/redo already worked before shortcuts became configurable.
  function primaryModDown(e) {
    return isMac ? e.metaKey : e.ctrlKey;
  }

  // kind:'tool' actions are eligible for the hold-to-temporarily-switch mechanic (see
  // wireUi's keydown handler); kind:'action' actions trigger immediately on keydown.
  const BINDABLE_ACTIONS = [
    { id: 'tool.brush', label: 'ブラシに切り替え', kind: 'tool', tool: 'brush' },
    { id: 'tool.eraser', label: '消しゴムに切り替え', kind: 'tool', tool: 'eraser' },
    { id: 'tool.eyedropper', label: 'スポイトに切り替え', kind: 'tool', tool: 'eyedropper' },
    { id: 'tool.bucket', label: 'バケツに切り替え', kind: 'tool', tool: 'bucket' },
    { id: 'tool.hand', label: 'ハンドツールに切り替え', kind: 'tool', tool: 'hand' },
    { id: 'action.undo', label: '元に戻す', kind: 'action' },
    { id: 'action.redo', label: 'やり直し', kind: 'action' },
    { id: 'action.resetView', label: '表示位置を初期化', kind: 'action' },
  ];

  const DEFAULT_SHORTCUTS = {
    bindings: [
      { action: 'tool.brush', code: 'KeyB', ctrl: false, shift: false, alt: false },
      { action: 'tool.eraser', code: 'KeyE', ctrl: false, shift: false, alt: false },
      { action: 'tool.eyedropper', code: 'KeyI', ctrl: false, shift: false, alt: false },
      { action: 'tool.bucket', code: 'KeyG', ctrl: false, shift: false, alt: false },
      { action: 'tool.hand', code: 'Space', ctrl: false, shift: false, alt: false },
      { action: 'action.undo', code: 'KeyZ', ctrl: true, shift: false, alt: false },
      { action: 'action.redo', code: 'KeyY', ctrl: true, shift: false, alt: false },
      { action: 'action.resetView', code: 'Digit0', ctrl: true, shift: false, alt: false },
    ],
  };

  const shortcutsKey = 'paintsoft.shortcuts.v1';

  // Merges saved bindings OVER a fresh copy of the defaults, keyed by action id — so a
  // future new bindable action doesn't silently vanish for users with an existing save.
  function readShortcuts() {
    const merged = {
      bindings: DEFAULT_SHORTCUTS.bindings.map((b) => ({ ...b })),
    };
    try {
      const raw = localStorage.getItem(shortcutsKey);
      if (!raw) return merged;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed?.bindings)) {
        for (const saved of parsed.bindings) {
          const idx = merged.bindings.findIndex((b) => b.action === saved?.action);
          if (idx >= 0 && saved.code) {
            merged.bindings[idx] = {
              action: saved.action,
              code: saved.code,
              ctrl: !!saved.ctrl,
              shift: !!saved.shift,
              alt: !!saved.alt,
            };
          }
        }
      }
    } catch {
      // ignore, fall back to defaults
    }
    return merged;
  }

  function writeShortcuts(next) {
    try {
      localStorage.setItem(shortcutsKey, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  function getBinding(actionId) {
    return state.shortcuts.bindings.find((b) => b.action === actionId) ?? null;
  }

  function matchesBinding(e, binding) {
    if (!binding) return false;
    if (e.code !== binding.code) return false;
    if (primaryModDown(e) !== !!binding.ctrl) return false;
    if (e.shiftKey !== !!binding.shift) return false;
    if (e.altKey !== !!binding.alt) return false;
    return true;
  }

  function codeToLabel(code) {
    if (!code) return '?';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    return code;
  }

  function formatBinding(binding) {
    if (!binding) return '(未設定)';
    const parts = [];
    if (binding.ctrl) parts.push(isMac ? 'Cmd' : 'Ctrl');
    if (binding.shift) parts.push('Shift');
    if (binding.alt) parts.push(isMac ? 'Option' : 'Alt');
    parts.push(codeToLabel(binding.code));
    return parts.join('+');
  }

  function getPanelPos(panelEl) {
    const left = parseFloat(panelEl.style.left);
    const top = parseFloat(panelEl.style.top);
    const right = parseFloat(panelEl.style.right);
    const bottom = parseFloat(panelEl.style.bottom);

    return {
      left: Number.isFinite(left) ? left : null,
      top: Number.isFinite(top) ? top : null,
      right: Number.isFinite(right) ? right : null,
      bottom: Number.isFinite(bottom) ? bottom : null,
    };
  }

  function applyPanelLayout(panelEl, saved) {
    if (!panelEl || !saved) return;
    // If user dragged previously, we store left/top only.
    if (Number.isFinite(saved.left)) {
      panelEl.style.left = `${saved.left}px`;
      panelEl.style.right = 'auto';
    }
    if (Number.isFinite(saved.top)) {
      panelEl.style.top = `${saved.top}px`;
      panelEl.style.bottom = 'auto';
    }

    if (Number.isFinite(saved.width)) {
      panelEl.style.width = `${saved.width}px`;
    }
    if (Number.isFinite(saved.height)) {
      panelEl.style.height = `${saved.height}px`;
    }
  }

  function initPanelDragging(handleEl, panelEl, name) {
    if (!handleEl || !panelEl || !workspaceEl) return;

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;

      // don't start drag when clicking buttons on node header
      if (e.target?.closest?.('button, input, select, a')) return;

      e.preventDefault();
      e.stopPropagation();
      handleEl.setPointerCapture(e.pointerId);

      const wsRect = workspaceEl.getBoundingClientRect();
      const pRect = panelEl.getBoundingClientRect();
      const offsetX = e.clientX - pRect.left;
      const offsetY = e.clientY - pRect.top;

      // normalize to explicit left/top for free placement
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';

      state.panelDrag = {
        name,
        panelEl,
        pointerId: e.pointerId,
        wsRect,
        panelW: pRect.width,
        panelH: pRect.height,
        offsetX,
        offsetY,
      };
    });

    handleEl.addEventListener('pointermove', (e) => {
      if (!state.panelDrag) return;
      if (state.panelDrag.pointerId !== e.pointerId) return;
      if (state.panelDrag.panelEl !== panelEl) return;

      const wsRect = workspaceEl.getBoundingClientRect();
      const x = e.clientX - wsRect.left - state.panelDrag.offsetX;
      const y = e.clientY - wsRect.top - state.panelDrag.offsetY;

      const maxX = Math.max(0, wsRect.width - state.panelDrag.panelW);
      const maxY = Math.max(0, wsRect.height - state.panelDrag.panelH);

      const left = clamp(x, 0, maxX);
      const top = clamp(y, 0, maxY);

      panelEl.style.left = `${Math.round(left)}px`;
      panelEl.style.top = `${Math.round(top)}px`;

      if (name === 'node') drawNodeLinks();
    });

    const end = (e) => {
      if (!state.panelDrag) return;
      if (state.panelDrag.pointerId !== e.pointerId) return;
      if (state.panelDrag.panelEl !== panelEl) return;

      const layout = readLayout() ?? {};
      layout[name] = {
        left: parseFloat(panelEl.style.left) || 0,
        top: parseFloat(panelEl.style.top) || 0,
        width: parseFloat(panelEl.style.width) || panelEl.getBoundingClientRect().width,
        height: parseFloat(panelEl.style.height) || panelEl.getBoundingClientRect().height,
      };
      writeLayout(layout);
      state.panelDrag = null;

      // moving the canvas panel changes its size constraints sometimes
      layoutCanvasDisplay();
    };

    handleEl.addEventListener('pointerup', end);
    handleEl.addEventListener('pointercancel', end);
  }

  function initPanelResizing(handleEl, panelEl, name) {
    if (!handleEl || !panelEl || !workspaceEl) return;

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handleEl.setPointerCapture(e.pointerId);

      const wsRect = workspaceEl.getBoundingClientRect();
      const pRect = panelEl.getBoundingClientRect();

      // normalize to explicit left/top to compute max bounds
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      if (!panelEl.style.left) panelEl.style.left = `${Math.round(pRect.left - wsRect.left)}px`;
      if (!panelEl.style.top) panelEl.style.top = `${Math.round(pRect.top - wsRect.top)}px`;

      state.panelDrag = {
        name: `${name}:resize`,
        panelEl,
        pointerId: e.pointerId,
        wsRect,
        startX: e.clientX,
        startY: e.clientY,
        startW: pRect.width,
        startH: pRect.height,
      };
    });

    handleEl.addEventListener('pointermove', (e) => {
      const d = state.panelDrag;
      if (!d) return;
      if (d.pointerId !== e.pointerId) return;
      if (d.panelEl !== panelEl) return;
      if (d.name !== `${name}:resize`) return;

      const wsRect = workspaceEl.getBoundingClientRect();
      const left = parseFloat(panelEl.style.left) || 0;
      const top = parseFloat(panelEl.style.top) || 0;
      const maxW = Math.max(120, wsRect.width - left);
      const maxH = Math.max(120, wsRect.height - top);

      const minW = parseFloat(getComputedStyle(panelEl).minWidth) || 200;
      const minH = parseFloat(getComputedStyle(panelEl).minHeight) || 200;

      if (name === 'canvas') {
        // Uniform scale, preserving the canvas's own aspect ratio — whichever axis moved
        // further drives the resize, the other follows so the artwork is never distorted.
        const aspect = canvas.width / canvas.height;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        const desiredW = Math.abs(dx) >= Math.abs(dy) ? d.startW + dx : (d.startH + dy) * aspect;

        const effMinW = Math.max(minW, minH * aspect);
        const effMaxW = Math.min(maxW, maxH * aspect);
        const nextW = clamp(desiredW, effMinW, effMaxW);
        const nextH = nextW / aspect;

        panelEl.style.width = `${Math.round(nextW)}px`;
        panelEl.style.height = `${Math.round(nextH)}px`;
      } else {
        const nextW = clamp(d.startW + (e.clientX - d.startX), minW, maxW);
        const nextH = clamp(d.startH + (e.clientY - d.startY), minH, maxH);

        panelEl.style.width = `${Math.round(nextW)}px`;
        panelEl.style.height = `${Math.round(nextH)}px`;
      }

      if (name === 'node') drawNodeLinks();
      layoutCanvasDisplay();
    });

    const end = (e) => {
      const d = state.panelDrag;
      if (!d) return;
      if (d.pointerId !== e.pointerId) return;
      if (d.panelEl !== panelEl) return;
      if (d.name !== `${name}:resize`) return;

      const layout = readLayout() ?? {};
      layout[name] = {
        left: parseFloat(panelEl.style.left) || 0,
        top: parseFloat(panelEl.style.top) || 0,
        width: parseFloat(panelEl.style.width) || panelEl.getBoundingClientRect().width,
        height: parseFloat(panelEl.style.height) || panelEl.getBoundingClientRect().height,
      };
      writeLayout(layout);
      state.panelDrag = null;
      if (name === 'node') drawNodeLinks();
      layoutCanvasDisplay();
    };

    handleEl.addEventListener('pointerup', end);
    handleEl.addEventListener('pointercancel', end);
  }

  function initPanelEdgeResizing(handleEl, panelEl, name, edge) {
    if (!handleEl || !panelEl || !workspaceEl) return;

    handleEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      handleEl.setPointerCapture(e.pointerId);

      const wsRect = workspaceEl.getBoundingClientRect();
      const pRect = panelEl.getBoundingClientRect();

      // normalize to explicit left/top
      panelEl.style.right = 'auto';
      panelEl.style.bottom = 'auto';
      panelEl.style.left = `${Math.round(pRect.left - wsRect.left)}px`;
      panelEl.style.top = `${Math.round(pRect.top - wsRect.top)}px`;
      if (!panelEl.style.width) panelEl.style.width = `${Math.round(pRect.width)}px`;
      if (!panelEl.style.height) panelEl.style.height = `${Math.round(pRect.height)}px`;

      state.panelDrag = {
        name: `${name}:edge:${edge}`,
        panelEl,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startLeft: parseFloat(panelEl.style.left) || 0,
        startTop: parseFloat(panelEl.style.top) || 0,
        startW: parseFloat(panelEl.style.width) || pRect.width,
        startH: parseFloat(panelEl.style.height) || pRect.height,
      };
    });

    handleEl.addEventListener('pointermove', (e) => {
      const d = state.panelDrag;
      if (!d) return;
      if (d.pointerId !== e.pointerId) return;
      if (d.panelEl !== panelEl) return;
      if (d.name !== `${name}:edge:${edge}`) return;

      const wsRect = workspaceEl.getBoundingClientRect();
      const minW = parseFloat(getComputedStyle(panelEl).minWidth) || 200;
      const minH = parseFloat(getComputedStyle(panelEl).minHeight) || 200;

      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;

      let left = d.startLeft;
      let top = d.startTop;
      let width = d.startW;
      let height = d.startH;

      if (edge === 'right') {
        width = d.startW + dx;
      } else if (edge === 'bottom') {
        height = d.startH + dy;
      } else if (edge === 'left') {
        left = d.startLeft + dx;
        width = d.startW - dx;
      } else if (edge === 'top') {
        top = d.startTop + dy;
        height = d.startH - dy;
      }

      // clamp for left/top edges
      if (width < minW) {
        if (edge === 'left') left = d.startLeft + (d.startW - minW);
        width = minW;
      }
      if (height < minH) {
        if (edge === 'top') top = d.startTop + (d.startH - minH);
        height = minH;
      }

      // clamp inside workspace
      left = clamp(left, 0, Math.max(0, wsRect.width - minW));
      top = clamp(top, 0, Math.max(0, wsRect.height - minH));
      width = clamp(width, minW, Math.max(minW, wsRect.width - left));
      height = clamp(height, minH, Math.max(minH, wsRect.height - top));

      panelEl.style.left = `${Math.round(left)}px`;
      panelEl.style.top = `${Math.round(top)}px`;
      panelEl.style.width = `${Math.round(width)}px`;
      panelEl.style.height = `${Math.round(height)}px`;

      if (name === 'node') drawNodeLinks();
      layoutCanvasDisplay();
    });

    const end = (e) => {
      const d = state.panelDrag;
      if (!d) return;
      if (d.pointerId !== e.pointerId) return;
      if (d.panelEl !== panelEl) return;
      if (d.name !== `${name}:edge:${edge}`) return;

      const layout = readLayout() ?? {};
      layout[name] = {
        left: parseFloat(panelEl.style.left) || 0,
        top: parseFloat(panelEl.style.top) || 0,
        width: parseFloat(panelEl.style.width) || panelEl.getBoundingClientRect().width,
        height: parseFloat(panelEl.style.height) || panelEl.getBoundingClientRect().height,
      };
      writeLayout(layout);
      state.panelDrag = null;
      if (name === 'node') drawNodeLinks();
      layoutCanvasDisplay();
    };

    handleEl.addEventListener('pointerup', end);
    handleEl.addEventListener('pointercancel', end);
  }

  function applyCanvasBackground() {
    canvas.style.backgroundColor = state.bgColor;
  }

  // Ctrl+Space + drag left/right zooms the canvas view in/out. This is a purely visual
  // CSS transform on the <canvas> element — it doesn't touch the backing-store
  // resolution, so drawing coordinates (which are computed from the post-transform
  // bounding rect via pointerToCanvasPoint) stay correct automatically.
  // translate() is applied outside scale() so a pan offset is always in real screen pixels,
  // independent of zoom level — panning by 50px on screen is a 50px move whether zoomed in
  // or out. .canvasWrap has overflow:hidden, so panning/zooming the canvas out of its
  // flex-centered position simply clips at the panel edge (this is the "オーバーパン" —
  // there's no clamping here, the view can be moved arbitrarily far, including fully out of
  // sight; resetView() below is the way back).
  function applyZoom() {
    canvas.style.transform =
      state.zoom === 1 && state.panX === 0 && state.panY === 0
        ? ''
        : `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;

    syncCanvasScreen(); // the on-screen box just changed size/position — re-render at the new scale
  }

  // #canvas's rasterized bitmap always lives at the document's backing-store resolution; if
  // the browser were left to stretch/shrink that bitmap itself for display (via CSS width/
  // transform), a large downscale ratio (e.g. fitting a 1600px-wide document into a 400px
  // panel) looks visibly aliased/jagged — the browser's canvas-element scaling doesn't do a
  // proper box-filtered resample the way Canvas2D's own drawImage does with
  // imageSmoothingQuality set. So #canvas itself stays invisible (opacity:0 in CSS) and
  // purely serves as the pointer/coordinate reference; #canvasScreen is the only thing
  // actually shown, redrawn here at #canvas's exact current on-screen pixel box (device-
  // pixel-ratio aware, so it's crisp on HiDPI displays too) every time content or the view
  // (pan/zoom) changes. Smoothing is enabled only when downscaling (matches how blur=0
  // strokes should still look non-anti-aliased once zoomed in past 100%).
  function syncCanvasScreen() {
    if (!canvasScreenEl || !canvasScreenCtx || !canvasPanelEl) return;

    const wrapRect = canvasPanelEl.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    if (canvasRect.width <= 0 || canvasRect.height <= 0 || canvas.width <= 0) return;

    canvasScreenEl.style.left = `${canvasRect.left - wrapRect.left}px`;
    canvasScreenEl.style.top = `${canvasRect.top - wrapRect.top}px`;
    canvasScreenEl.style.width = `${canvasRect.width}px`;
    canvasScreenEl.style.height = `${canvasRect.height}px`;

    const dpr = window.devicePixelRatio || 1;
    const screenW = Math.max(1, Math.round(canvasRect.width * dpr));
    const screenH = Math.max(1, Math.round(canvasRect.height * dpr));
    if (canvasScreenEl.width !== screenW) canvasScreenEl.width = screenW;
    if (canvasScreenEl.height !== screenH) canvasScreenEl.height = screenH;

    const effectiveScale = canvasRect.width / canvas.width;
    canvasScreenCtx.imageSmoothingEnabled = effectiveScale < 1;
    canvasScreenCtx.imageSmoothingQuality = 'high';
    canvasScreenCtx.clearRect(0, 0, screenW, screenH);
    canvasScreenCtx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, screenW, screenH);
  }

  // Called right as a Ctrl+Space zoom-drag begins. transform-origin defaults to the canvas's
  // OWN center (a fixed point in its un-transformed local space), which only lines up with
  // what's actually visible in the middle of the panel when panX/panY are still 0 — after
  // panning, that fixed local point can end up anywhere (even off-screen), so zooming around
  // it feels like the view jumps instead of zooming in place. Re-anchoring transform-origin,
  // fresh at the start of every zoom gesture, to whatever local point is CURRENTLY rendered
  // at the panel's on-screen center keeps that visible center fixed under the cursor's drag
  // regardless of how far the view has already been panned.
  function anchorZoomOrigin() {
    if (!canvasPanelEl) return;
    const canvasRect = canvas.getBoundingClientRect();
    const panelRect = canvasPanelEl.getBoundingClientRect();
    if (canvasRect.width <= 0 || canvasRect.height <= 0) return;

    const targetScreenX = panelRect.left + panelRect.width / 2;
    const targetScreenY = panelRect.top + panelRect.height / 2;
    const fracX = (targetScreenX - canvasRect.left) / canvasRect.width;
    const fracY = (targetScreenY - canvasRect.top) / canvasRect.height;

    const boxW = parseFloat(canvas.style.width) || canvas.width;
    const boxH = parseFloat(canvas.style.height) || canvas.height;
    canvas.style.transformOrigin = `${fracX * boxW}px ${fracY * boxH}px`;
  }

  // Recenters the canvas and resets zoom to 100% — the way back after panning/zooming
  // (including panning fully out of view, which overpan otherwise has no other recovery for).
  function resetView() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    canvas.style.transformOrigin = '';
    applyZoom();
    setHint('表示位置をリセットしました');
  }

  function configureLayerContext(layerCtx) {
    layerCtx.lineCap = 'round';
    layerCtx.lineJoin = 'round';
    layerCtx.imageSmoothingEnabled = true;
  }

  function createLayer(name, pos) {
    const layerCanvas = createLayerCanvas(canvas.width, canvas.height);

    const layerCtx = layerCanvas.getContext('2d', { willReadFrequently: false });
    configureLayerContext(layerCtx);

    const id = state.nextNodeId++;
    return {
      id,
      kind: 'layer',
      name: name ?? `レイヤー${id}`,
      canvas: layerCanvas,
      ctx: layerCtx,
      visible: true,
      // null = top-level node in the graph; otherwise the id of the folder containing it
      folderId: null,

      // node graph (only meaningful while folderId == null)
      x: pos?.x ?? 16,
      y: pos?.y ?? 16,
      // out: null | { kind: 'output' } | { kind: 'layer', layerId: number }
      out: { kind: 'output' },
      // computed (single input)
      inFromLayerId: null,
    };
  }

  function createFolder(name, pos) {
    const id = state.nextNodeId++;
    return {
      id,
      kind: 'folder',
      name: name ?? `フォルダ${id}`,
      visible: true,
      collapsed: false,
      // null = top-level node in the graph; otherwise the id of the folder containing it
      folderId: null,

      x: pos?.x ?? 16,
      y: pos?.y ?? 16,
      out: { kind: 'output' },
      inFromLayerId: null,

      // mix of layer ids and (nested) folder ids, in stacking order
      childIds: [],
    };
  }

  // Moves an existing top-level layer node into `folder` (used when a layer node is
  // dragged and dropped onto a folder node). Any connection pointing at the layer's
  // output is dropped, since a layer inside a folder no longer routes individually
  // — the folder's own connection governs it, same as a layer added via the "＋" button.
  function moveLayerIntoFolder(layer, folder) {
    for (const n of getRoutableNodes()) {
      if (n.out?.kind === 'layer' && n.out.layerId === layer.id) n.out = null;
    }
    layer.folderId = folder.id;
    layer.out = null;
    folder.childIds.push(layer.id);
    ensureActiveLayer();
    recomputeInputs();
  }

  // Any node (layer or folder) by id, regardless of nesting depth.
  function findAnyNode(id) {
    return state.layers.find((l) => l.id === id) ?? state.folders.find((f) => f.id === id) ?? null;
  }

  // True if `folderId` is `ancestorId` itself or nested (at any depth) inside it.
  // Used to stop a folder from being nested into one of its own descendants.
  function isFolderOrDescendant(folderId, ancestorId) {
    let current = state.folders.find((f) => f.id === folderId);
    while (current) {
      if (current.id === ancestorId) return true;
      current = current.folderId == null ? null : state.folders.find((f) => f.id === current.folderId);
    }
    return false;
  }

  function getActiveLayer() {
    if (state.activeLayerId == null) return null;
    return state.layers.find((l) => l.id === state.activeLayerId) ?? null;
  }

  function ensureActiveLayer() {
    if (state.layers.length === 0) {
      state.activeLayerId = null;
      return;
    }
    if (state.activeLayerId == null || !state.layers.some((l) => l.id === state.activeLayerId)) {
      state.activeLayerId = state.layers[0].id;
    }
  }

  // Nodes that participate in the graph's routing (out/in connections, hop ordering):
  // top-level layers (not inside a folder) plus every folder. A layer that's inside a
  // folder is not individually routable — the folder's own connection governs it.
  function getRoutableNodes() {
    return [
      ...state.layers.filter((l) => l.folderId == null),
      ...state.folders.filter((f) => f.folderId == null),
    ];
  }

  function findRoutableNode(id) {
    return getRoutableNodes().find((n) => n.id === id) ?? null;
  }

  function recomputeInputs() {
    const nodes = getRoutableNodes();
    for (const node of nodes) node.inFromLayerId = null;

    // each target input can have at most one incoming; last write wins (simple rule)
    for (const node of nodes) {
      if (node.out?.kind === 'layer') {
        const target = findRoutableNode(node.out.layerId);
        if (target) target.inFromLayerId = node.id;
      }
    }
  }

  function reaches(startId, targetId) {
    const visited = new Set();
    let currentId = startId;
    while (true) {
      if (currentId == null) return false;
      if (currentId === targetId) return true;
      if (visited.has(currentId)) return false;
      visited.add(currentId);
      const node = findRoutableNode(currentId);
      if (!node?.out || node.out.kind !== 'layer') return false;
      currentId = node.out.layerId;
    }
  }

  function connectNodeOutputToNodeInput(sourceId, targetId) {
    if (sourceId === targetId) return false;

    // prevent cycle: if target can reach source already, connecting source->target would create a loop
    if (reaches(targetId, sourceId)) return false;

    const source = findRoutableNode(sourceId);
    const target = findRoutableNode(targetId);
    if (!source || !target) return false;

    // if target already has an incoming, disconnect it
    if (target.inFromLayerId != null) {
      const prev = findRoutableNode(target.inFromLayerId);
      if (prev && prev.out?.kind === 'layer' && prev.out.layerId === targetId) prev.out = null;
    }

    source.out = { kind: 'layer', layerId: targetId };
    recomputeInputs();
    return true;
  }

  function connectNodeOutputToOutput(sourceId) {
    const source = findRoutableNode(sourceId);
    if (!source) return false;
    source.out = { kind: 'output' };
    recomputeInputs();
    return true;
  }

  function scheduleNodeRerender(alsoComposite) {
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(() => {
      state.rafPending = false;
      renderNodeGraph();
      if (alsoComposite) compositeToScreen();
    });
  }

  function renderNodeGraph() {
    if (!nodeNodesEl || !nodeEditorEl || !nodeLinksEl) return;

    ensureActiveLayer();

    nodeNodesEl.innerHTML = '';

    const outputNodePos = { x: 12, y: 12 };

    // Output node
    const outNode = document.createElement('div');
    outNode.className = 'node';
    outNode.style.left = `${outputNodePos.x}px`;
    outNode.style.top = `${outputNodePos.y}px`;
    outNode.dataset.kind = 'output';
    outNode.innerHTML = `
      <div class="nodeHead">
        <div class="nodePorts left">
          <div id="outputInPort" class="nodePort connected" title="入力（ここに接続されたレイヤーが合成されます）"></div>
        </div>
        <div class="nodeName">出力</div>
        <div class="nodePorts right">
          <div class="nodePort connected" title="出力"></div>
        </div>
      </div>
      <div class="nodeBody">
        <div class="nodeMeta">接続されたレイヤーを合成</div>
      </div>
    `;
    nodeNodesEl.appendChild(outNode);

    const outputInPort = outNode.querySelector('#outputInPort');
    outputInPort.addEventListener('click', (e) => {
      e.stopPropagation();
      if (state.linkingFromLayerId == null) return;
      const node = findRoutableNode(state.linkingFromLayerId);
      if (!node) {
        state.linkingFromLayerId = null;
        renderNodeGraph();
        return;
      }
      pushUndo();
      connectNodeOutputToOutput(node.id);
      state.linkingFromLayerId = null;
      renderNodeGraph();
      compositeToScreen();
    });

    // While dragging a top-level layer node, checks whether the pointer is currently
    // over a top-level folder node and records that folder as the pending drop target
    // (rendered with a highlight; see the `dropTarget` class below).
    const updateFolderDropTarget = (clientX, clientY) => {
      let hitFolderId = null;
      for (const el of nodeNodesEl.querySelectorAll('.node[data-kind="folder"]')) {
        const rect = el.getBoundingClientRect();
        if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
          hitFolderId = Number(el.dataset.nodeId);
          break;
        }
      }
      state.dropTargetFolderId = hitFolderId;
    };

    // generic drag wiring shared by layer nodes and folder nodes
    const wireNodeDrag = (nodeEl, node) => {
      const head = nodeEl.querySelector('[data-drag="1"]');
      head.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.('button')) return;
        e.stopPropagation();
        nodeEl.setPointerCapture(e.pointerId);
        state.draggingNodeId = node.id;
        state.dropTargetFolderId = null;
        const rect = nodeEl.getBoundingClientRect();
        state.dragOffset.x = e.clientX - rect.left;
        state.dragOffset.y = e.clientY - rect.top;
      });

      nodeEl.addEventListener('pointermove', (e) => {
        if (state.draggingNodeId !== node.id) return;
        const editorRect = nodeEditorEl.getBoundingClientRect();
        const x = (e.clientX - editorRect.left) + nodeEditorEl.scrollLeft - state.dragOffset.x;
        const y = (e.clientY - editorRect.top) + nodeEditorEl.scrollTop - state.dragOffset.y;
        node.x = Math.max(0, x);
        node.y = Math.max(0, y);
        if (node.kind === 'layer') updateFolderDropTarget(e.clientX, e.clientY);
        scheduleNodeRerender(true);
      });

      nodeEl.addEventListener('pointerup', () => {
        if (state.draggingNodeId !== node.id) return;
        state.draggingNodeId = null;

        const dropFolder = node.kind === 'layer' && state.dropTargetFolderId != null
          ? state.folders.find((f) => f.id === state.dropTargetFolderId)
          : null;
        state.dropTargetFolderId = null;

        if (dropFolder) {
          pushUndo();
          moveLayerIntoFolder(node, dropFolder);
        }
        renderNodeGraph();
        compositeToScreen();
      });
      nodeEl.addEventListener('pointercancel', () => {
        if (state.draggingNodeId === node.id) state.draggingNodeId = null;
        state.dropTargetFolderId = null;
      });
    };

    // generic out/in port wiring shared by layer nodes and folder nodes
    const wireNodePorts = (nodeEl, node) => {
      const port = nodeEl.querySelector('[data-port="out"]');
      port.addEventListener('pointerdown', (e) => e.stopPropagation());
      port.addEventListener('click', (e) => {
        e.stopPropagation();
        if (node.out) {
          pushUndo();
          node.out = null;
          recomputeInputs();
          if (state.linkingFromLayerId === node.id) state.linkingFromLayerId = null;
          renderNodeGraph();
          compositeToScreen();
          return;
        }

        // arm linking
        state.linkingFromLayerId = node.id;
        renderNodeGraph();
      });

      const inPort = nodeEl.querySelector('[data-port="in"]');
      inPort.addEventListener('pointerdown', (e) => e.stopPropagation());
      inPort.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.linkingFromLayerId == null) return;
        const sourceId = state.linkingFromLayerId;
        pushUndo();
        const ok = connectNodeOutputToNodeInput(sourceId, node.id);
        state.linkingFromLayerId = null;
        if (!ok) {
          setHint('無効な接続です（循環になります）');
        }
        renderNodeGraph();
        compositeToScreen();
      });
    };

    // Layer nodes (only those not grouped inside a folder)
    for (const layer of state.layers.filter((l) => l.folderId == null)) {
      const node = document.createElement('div');
      node.className = 'node' + (layer.id === state.activeLayerId ? ' selected' : '');
      node.style.left = `${Math.round(layer.x)}px`;
      node.style.top = `${Math.round(layer.y)}px`;
      node.dataset.kind = 'layer';
      node.dataset.nodeId = String(layer.id);

      const connectedClass = layer.out ? 'connected' : '';
      const linkingClass = state.linkingFromLayerId === layer.id ? 'connected' : '';
      const inConnectedClass = layer.inFromLayerId != null ? 'connected' : '';
      const visibleChecked = layer.visible ? 'checked' : '';
      const activeTag = layer.id === state.activeLayerId ? '（描画中）' : '';

      node.innerHTML = `
        <div class="nodeHead" data-drag="1" title="ドラッグで移動">
          <div class="nodePorts left">
            <div class="nodePort ${inConnectedClass}" data-port="in" title="入力"></div>
          </div>
          <div class="nodeName">${escapeHtml(layer.name)}${activeTag}</div>
          <div class="nodePorts right">
            <div class="nodePort ${connectedClass} ${linkingClass}" data-port="out" title="クリック→出力ノードの入力をクリックで接続 / もう一度で解除"></div>
          </div>
        </div>
        <div class="nodeBody">
          <label class="nodeToggle" title="表示/非表示">
            <input type="checkbox" data-toggle="visible" ${visibleChecked} />
            表示
          </label>
          <div class="nodeMeta">${layer.out ? '接続中' : '未接続'}</div>
        </div>
      `;

      // select
      node.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.('[data-port], [data-toggle]')) return;
        state.activeLayerId = layer.id;
        renderNodeGraph();
      });

      wireNodeDrag(node, layer);
      wireNodePorts(node, layer);

      // visible toggle
      const vis = node.querySelector('[data-toggle="visible"]');
      vis.addEventListener('pointerdown', (e) => e.stopPropagation());
      vis.addEventListener('change', (e) => {
        pushUndo();
        layer.visible = Boolean(e.target.checked);
        renderNodeGraph();
        compositeToScreen();
      });

      nodeNodesEl.appendChild(node);
    }

    // Folder nodes (only top-level ones; nested folders render inside their parent's body)
    for (const folder of state.folders.filter((f) => f.folderId == null)) {
      const node = document.createElement('div');
      node.className = 'node' + (folder.id === state.dropTargetFolderId ? ' dropTarget' : '');
      node.style.left = `${Math.round(folder.x)}px`;
      node.style.top = `${Math.round(folder.y)}px`;
      node.dataset.kind = 'folder';
      node.dataset.nodeId = String(folder.id);

      const connectedClass = folder.out ? 'connected' : '';
      const linkingClass = state.linkingFromLayerId === folder.id ? 'connected' : '';
      const inConnectedClass = folder.inFromLayerId != null ? 'connected' : '';

      node.innerHTML = `
        <div class="nodeHead" data-drag="1" title="ドラッグで移動">
          <div class="nodePorts left">
            <div class="nodePort ${inConnectedClass}" data-port="in" title="入力"></div>
          </div>
          <div class="nodeName">📁 ${escapeHtml(folder.name)}</div>
          <div class="nodeButtons">
            <button type="button" data-action="addLayerToFolder" data-child-id="${folder.id}" title="フォルダにレイヤーを追加">＋</button>
            <button type="button" data-action="addSubFolder" data-child-id="${folder.id}" title="サブフォルダを追加">📁＋</button>
            <button type="button" data-action="deleteFolder" data-child-id="${folder.id}" title="フォルダを削除">－</button>
          </div>
          <div class="nodePorts right">
            <div class="nodePort ${connectedClass} ${linkingClass}" data-port="out" title="クリック→出力ノードの入力をクリックで接続 / もう一度で解除"></div>
          </div>
        </div>
        <div class="nodeBody folderBody">
          ${renderFolderChildrenHtml(folder)}
        </div>
      `;

      wireNodeDrag(node, folder);
      wireNodePorts(node, folder);
      wireFolderBody(node);

      nodeNodesEl.appendChild(node);
    }

    drawNodeLinks();

    if (nodeDelEl) nodeDelEl.disabled = state.layers.length <= 1 || state.activeLayerId == null;
  }

  function drawNodeLinks() {
    if (!nodeLinksEl || !nodeEditorEl) return;

    const editorRect = nodeEditorEl.getBoundingClientRect();
    const w = Math.max(1, Math.floor(editorRect.width));
    const h = Math.max(1, Math.floor(editorRect.height));
    nodeLinksEl.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const inPort = document.getElementById('outputInPort');
    if (!inPort) {
      nodeLinksEl.innerHTML = '';
      return;
    }

    const portCenter = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.left + r.width / 2 - editorRect.left,
        y: r.top + r.height / 2 - editorRect.top,
      };
    };

    const dst = portCenter(inPort);
    const paths = [];

    const graphNodes = nodeNodesEl.querySelectorAll('.node[data-kind="layer"], .node[data-kind="folder"]');
    for (const nodeEl of graphNodes) {
      const nodeId = Number(nodeEl.dataset.nodeId);
      const node = findRoutableNode(nodeId);
      if (!node?.out) continue;
      const port = nodeEl.querySelector('[data-port="out"]');
      if (!port) continue;

      const src = portCenter(port);

      let dstPort;
      if (node.out.kind === 'output') {
        dstPort = inPort;
      } else if (node.out.kind === 'layer') {
        dstPort = nodeNodesEl.querySelector(`.node[data-node-id="${node.out.layerId}"] [data-port="in"]`);
      }
      if (!dstPort) continue;

      const dst2 = portCenter(dstPort);
      const dx = Math.max(40, Math.abs(dst.x - src.x) * 0.6);
      const c1x = src.x + dx;
      const c1y = src.y;
      const c2x = dst2.x - dx;
      const c2y = dst2.y;
      const d = `M ${src.x} ${src.y} C ${c1x} ${c1y} ${c2x} ${c2y} ${dst2.x} ${dst2.y}`;
      paths.push(`<path d="${d}" fill="none" stroke="rgba(90,168,255,0.55)" stroke-width="2" />`);
    }

    nodeLinksEl.innerHTML = paths.join('');
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // Recursively collects every layer id and folder id nested (at any depth) inside
  // `folder`, including `folder` itself in folderIds. Used for cascading folder delete.
  function collectDescendantIds(folder, layerIds, folderIds) {
    folderIds.add(folder.id);
    for (const childId of folder.childIds) {
      const childLayer = state.layers.find((l) => l.id === childId);
      if (childLayer) {
        layerIds.add(childId);
        continue;
      }
      const childFolder = state.folders.find((f) => f.id === childId);
      if (childFolder) collectDescendantIds(childFolder, layerIds, folderIds);
    }
  }

  // Builds the (possibly nested) HTML for a folder node's body: one row per child
  // layer or child folder, in stacking order. Nested folders render their own
  // children indented underneath, unless collapsed.
  function renderFolderChildrenHtml(folder) {
    if (folder.childIds.length === 0) {
      return '<div class="nodeMeta">空のフォルダ（＋でレイヤー追加）</div>';
    }

    return folder.childIds
      .map((childId) => {
        const childLayer = state.layers.find((l) => l.id === childId);
        if (childLayer) {
          const activeClass = childLayer.id === state.activeLayerId ? ' active' : '';
          const checked = childLayer.visible ? 'checked' : '';
          const activeTag = childLayer.id === state.activeLayerId ? '（描画中）' : '';
          return `
            <div class="folderChildRow${activeClass}" data-child-id="${childLayer.id}" data-child-kind="layer">
              <input type="checkbox" data-child-toggle="visible" data-child-id="${childLayer.id}" ${checked} title="表示/非表示" />
              <span class="folderChildName">${escapeHtml(childLayer.name)}${activeTag}</span>
              <button type="button" data-action="removeFromFolder" data-child-id="${childLayer.id}" title="フォルダから出す">×</button>
            </div>
          `;
        }

        const childFolder = state.folders.find((f) => f.id === childId);
        if (!childFolder) return '';

        const checked = childFolder.visible ? 'checked' : '';
        const expandGlyph = childFolder.collapsed ? '▶' : '▼';
        const nested = childFolder.collapsed
          ? ''
          : `<div class="folderNested">${renderFolderChildrenHtml(childFolder)}</div>`;

        return `
          <div class="folderChildRow folderChildFolder" data-child-id="${childFolder.id}" data-child-kind="folder">
            <button type="button" data-action="toggleFolderCollapse" data-child-id="${childFolder.id}" class="folderExpandBtn" title="開閉">${expandGlyph}</button>
            <input type="checkbox" data-child-toggle="visible" data-child-id="${childFolder.id}" ${checked} title="表示/非表示" />
            <span class="folderChildName">📁 ${escapeHtml(childFolder.name)}（${childFolder.childIds.length}）</span>
            <button type="button" data-action="addLayerToFolder" data-child-id="${childFolder.id}" title="レイヤーを追加">＋</button>
            <button type="button" data-action="addSubFolder" data-child-id="${childFolder.id}" title="サブフォルダを追加">📁＋</button>
            <button type="button" data-action="removeFromFolder" data-child-id="${childFolder.id}" title="フォルダから出す">×</button>
          </div>
          ${nested}
        `;
      })
      .join('');
  }

  // Wires every action inside a folder node's body (add layer, add sub-folder, delete
  // folder, remove-from-parent, visibility toggle, collapse toggle, select-as-active).
  // Delegated via querySelectorAll on the whole node, so it works at any nesting depth.
  function wireFolderBody(nodeEl) {
    nodeEl.querySelectorAll('[data-action="addLayerToFolder"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = state.folders.find((f) => f.id === Number(btn.dataset.childId));
        if (!target) return;
        pushUndo();
        const layer = createLayer(undefined, { x: target.x, y: target.y });
        layer.folderId = target.id;
        layer.out = null;
        state.layers.push(layer);
        target.childIds.push(layer.id);
        state.activeLayerId = layer.id;
        renderNodeGraph();
        compositeToScreen();
      });
    });

    nodeEl.querySelectorAll('[data-action="addSubFolder"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = state.folders.find((f) => f.id === Number(btn.dataset.childId));
        if (!target) return;
        pushUndo();
        const sub = createFolder(undefined, { x: target.x, y: target.y });
        sub.folderId = target.id;
        sub.out = null;
        state.folders.push(sub);
        target.childIds.push(sub.id);
        renderNodeGraph();
        compositeToScreen();
      });
    });

    nodeEl.querySelectorAll('[data-action="deleteFolder"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = state.folders.find((f) => f.id === Number(btn.dataset.childId));
        if (!target) return;

        const layerIds = new Set();
        const folderIds = new Set();
        collectDescendantIds(target, layerIds, folderIds);

        const remaining = state.layers.length - layerIds.size;
        if (remaining < 1) {
          setHint('少なくとも1つはレイヤーが必要です');
          return;
        }

        pushUndo();
        state.layers = state.layers.filter((l) => !layerIds.has(l.id));
        state.folders = state.folders.filter((f) => !folderIds.has(f.id));

        if (target.folderId != null) {
          const parent = state.folders.find((f) => f.id === target.folderId);
          if (parent) parent.childIds = parent.childIds.filter((id) => id !== target.id);
        }

        // clean up dangling connections that pointed at a deleted (top-level) folder
        for (const n of getRoutableNodes()) {
          if (n.out?.kind === 'layer' && folderIds.has(n.out.layerId)) n.out = null;
        }

        ensureActiveLayer();
        recomputeInputs();
        renderNodeGraph();
        compositeToScreen();
      });
    });

    nodeEl.querySelectorAll('[data-action="removeFromFolder"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const child = findAnyNode(Number(btn.dataset.childId));
        if (!child || child.folderId == null) return;
        const parent = state.folders.find((f) => f.id === child.folderId);
        if (!parent) return;
        pushUndo();
        parent.childIds = parent.childIds.filter((id) => id !== child.id);
        child.folderId = null;
        child.x = parent.x + 40;
        child.y = parent.y + 40;
        child.out = { kind: 'output' };
        recomputeInputs();
        renderNodeGraph();
        compositeToScreen();
      });
    });

    nodeEl.querySelectorAll('[data-action="toggleFolderCollapse"]').forEach((btn) => {
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const target = state.folders.find((f) => f.id === Number(btn.dataset.childId));
        if (!target) return;
        target.collapsed = !target.collapsed;
        renderNodeGraph();
      });
    });

    nodeEl.querySelectorAll('[data-child-toggle="visible"]').forEach((input) => {
      input.addEventListener('pointerdown', (e) => e.stopPropagation());
      input.addEventListener('change', (e) => {
        const child = findAnyNode(Number(input.dataset.childId));
        if (!child) return;
        pushUndo();
        child.visible = Boolean(e.target.checked);
        renderNodeGraph();
        compositeToScreen();
      });
    });

    nodeEl.querySelectorAll('.folderChildRow[data-child-kind="layer"]').forEach((row) => {
      row.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target?.closest?.('button, input')) return;
        const childId = Number(row.dataset.childId);
        if (!Number.isFinite(childId)) return;
        state.activeLayerId = childId;
        renderNodeGraph();
      });
    });
  }

  // Recursively appends a folder's drawable content (in child order) to `out`.
  // Nested folders expand in place; an invisible folder (or nested sub-folder)
  // hides everything inside it.
  function collectFolderRenderLayers(folder, out) {
    if (!folder.visible) return;
    for (const childId of folder.childIds) {
      const childLayer = state.layers.find((l) => l.id === childId);
      if (childLayer) {
        if (childLayer.visible) out.push(childLayer);
        continue;
      }
      const childFolder = state.folders.find((f) => f.id === childId);
      if (childFolder) collectFolderRenderLayers(childFolder, out);
    }
  }

  // Back-to-front ordering of every routable (top-level) node, by chain distance to the
  // output node (nearer to output = upper/front), with geometric distance to the output
  // node's anchor as a tie-breaker. Nodes not connected to the output at all (hop == null)
  // are dropped — they contribute nothing to the composite. Shared by computeRenderOrder
  // (screen/PNG compositing) and computeExportLayerOrder (PSD/.clip export).
  function getOrderedRoutableNodes() {
    const nodes = getRoutableNodes();

    const outputAnchor = { x: 12, y: 12 + 16 };
    const nodeW = 220;
    const nodePortY = 16;
    const geomDist2 = (n) => {
      const lx = (n.x ?? 0) + nodeW;
      const ly = (n.y ?? 0) + nodePortY;
      const dx = lx - outputAnchor.x;
      const dy = ly - outputAnchor.y;
      return dx * dx + dy * dy;
    };

    const memo = new Map();
    const visiting = new Set();
    const hopToOutput = (node) => {
      if (!node?.out) return null;
      if (memo.has(node.id)) return memo.get(node.id);
      if (visiting.has(node.id)) return null;
      visiting.add(node.id);

      let d = null;
      if (node.out.kind === 'output') {
        d = 0;
      } else if (node.out.kind === 'layer') {
        const target = findRoutableNode(node.out.layerId);
        const td = hopToOutput(target);
        if (td != null) d = td + 1;
      }

      visiting.delete(node.id);
      memo.set(node.id, d);
      return d;
    };

    return nodes
      .map((n) => ({ node: n, hop: hopToOutput(n) }))
      .filter((x) => x.hop != null)
      .sort((a, b) => {
        if (a.hop !== b.hop) return b.hop - a.hop;
        const da = geomDist2(a.node);
        const db = geomDist2(b.node);
        if (da !== db) return db - da;
        return (a.node.id ?? 0) - (b.node.id ?? 0);
      })
      .map((x) => x.node);
  }

  // Computes the flattened, back-to-front list of drawable layers for compositing.
  // Folders occupy a single slot in that ordering (based on the folder node's own graph
  // position), and expand into their visible child layers (in child order) at that point
  // in the stack.
  function computeRenderOrder() {
    const flat = [];
    for (const node of getOrderedRoutableNodes()) {
      if (node.kind === 'folder') {
        collectFolderRenderLayers(node, flat);
      } else if (node.visible) {
        flat.push(node);
      }
    }
    return flat;
  }

  // Like computeRenderOrder, but for exporting to an external format (PSD, .clip) that has
  // its own per-layer visibility flag: every layer reachable from the output node is
  // included — even ones hidden by their own toggle or an ancestor folder's — tagged with
  // its effective (cascaded) visibility instead of being dropped. Layers not connected to
  // the output at all are still excluded, same as on-screen compositing (see
  // getOrderedRoutableNodes), since node-graph "connection" has no equivalent concept in
  // PSD/.clip to export it as.
  function computeExportLayerOrder() {
    const collect = (folder, ancestorsVisible, out) => {
      const effectiveVisible = ancestorsVisible && folder.visible;
      for (const childId of folder.childIds) {
        const childLayer = state.layers.find((l) => l.id === childId);
        if (childLayer) {
          out.push({ layer: childLayer, visible: effectiveVisible && childLayer.visible });
          continue;
        }
        const childFolder = state.folders.find((f) => f.id === childId);
        if (childFolder) collect(childFolder, effectiveVisible, out);
      }
    };

    const flat = [];
    for (const node of getOrderedRoutableNodes()) {
      if (node.kind === 'folder') {
        collect(node, true, flat);
      } else {
        flat.push({ layer: node, visible: node.visible });
      }
    }
    return flat;
  }

  function compositeToScreen() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 背景色はCSSで見せているが、合成結果にも反映しておく（保存/プレビュー一致）
    ctx.fillStyle = state.bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    compositeLayers(ctx, canvas.width, canvas.height, computeRenderOrder(), { clear: false });
    syncCanvasScreen();
  }

  function setHint(text) {
    if (!hintEl) return;
    hintEl.textContent = text;
  }

  // Fits the canvas's fixed pixel resolution (canvas.width/height) into its panel, preserving
  // aspect ratio (letterboxed), by setting ONLY the CSS display size. Never touches
  // canvas.width/height and never resamples a single pixel — how big the artwork looks on
  // screen and how many actual pixels it has are independent concepts. Cheap enough to call
  // on every panel-resize pointermove.
  function layoutCanvasDisplay() {
    if (!canvasPanelEl) return;
    const availW = canvasPanelEl.clientWidth;
    const availH = canvasPanelEl.clientHeight;
    if (availW <= 0 || availH <= 0) return;

    const docW = canvas.width;
    const docH = canvas.height;
    if (docW <= 0 || docH <= 0) return;

    const scale = Math.min(availW / docW, availH / docH);
    canvas.style.width = `${Math.max(1, Math.floor(docW * scale))}px`;
    canvas.style.height = `${Math.max(1, Math.floor(docH * scale))}px`;

    applyZoom(); // fit scale changed — re-derive whether we're now above/below the 1x threshold
  }

  // The only function (besides restoring a saved snapshot) allowed to change the document's
  // actual pixel resolution. Rescales every layer's existing content to fit the new
  // dimensions — an explicit, undoable, user-requested resize (see setDocumentResolution's
  // caller in the canvas-settings dialog), unlike the old behavior where resolution silently
  // followed whatever size the panel happened to be on screen.
  function setDocumentResolution(newWidth, newHeight) {
    const width = Math.max(1, Math.floor(newWidth));
    const height = Math.max(1, Math.floor(newHeight));
    if (width === canvas.width && height === canvas.height) return;

    pushUndo();

    canvas.width = width;
    canvas.height = height;

    for (const layer of state.layers) {
      resizeCanvasPreservingContent(layer.canvas, width, height);
      configureLayerContext(layer.ctx);
    }

    configureContext();
    writeCanvasSize(width, height);
    compositeToScreen();
    renderNodeGraph();
    layoutCanvasDisplay();
  }

  // "Canvas size" (crop/extend), as opposed to setDocumentResolution's "resize": existing
  // content is placed at its original scale, offset by the anchor (0/0.5/1 per axis — which
  // edge/corner/center it stays pinned to), not stretched. Shrinking naturally clips;
  // growing leaves the new area transparent (compositeToScreen already fills the background
  // color under transparent regions, so no extra fill step is needed here).
  function resizeCanvasWithAnchor(newWidth, newHeight, anchorX, anchorY) {
    const width = Math.max(1, Math.floor(newWidth));
    const height = Math.max(1, Math.floor(newHeight));
    if (width === canvas.width && height === canvas.height) return;

    pushUndo();

    const offsetX = Math.round(anchorX * (width - canvas.width));
    const offsetY = Math.round(anchorY * (height - canvas.height));

    canvas.width = width;
    canvas.height = height;

    for (const layer of state.layers) {
      const snapshot = document.createElement('canvas');
      snapshot.width = layer.canvas.width;
      snapshot.height = layer.canvas.height;
      snapshot.getContext('2d').drawImage(layer.canvas, 0, 0);

      layer.canvas.width = width;
      layer.canvas.height = height;
      configureLayerContext(layer.ctx);
      layer.ctx.drawImage(snapshot, offsetX, offsetY);
    }

    configureContext();
    writeCanvasSize(width, height);
    compositeToScreen();
    renderNodeGraph();
    layoutCanvasDisplay();
  }

  // Ratio between the canvas's actual pixel resolution and how big it currently looks on
  // screen — replaces the old fixed state.dpr factor so brush strokes are sized correctly
  // regardless of *why* those two numbers differ (device pixel ratio, letterboxing, or an
  // explicitly chosen document resolution).
  function getCanvasPixelScale() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0) return 1;
    return canvas.width / rect.width;
  }

  function configureContext() {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.imageSmoothingEnabled = true;
  }

  function buildSnapshot() {
    return {
      width: canvas.width,
      height: canvas.height,
      bgColor: state.bgColor,
      activeLayerId: state.activeLayerId,
      nextNodeId: state.nextNodeId,
      folders: state.folders.map((f) => ({
        id: f.id,
        name: f.name,
        x: f.x,
        y: f.y,
        out: f.out,
        visible: f.visible,
        collapsed: f.collapsed,
        folderId: f.folderId,
        childIds: [...f.childIds],
      })),
      layers: state.layers.map((l) => ({
        id: l.id,
        name: l.name,
        visible: l.visible,
        connected: !!l.out,
        out: l.out,
        x: l.x,
        y: l.y,
        folderId: l.folderId,
        url: l.canvas.toDataURL('image/png'),
      })),
    };
  }

  function pushUndo() {
    try {
      const snapshot = buildSnapshot();
      state.undo.push(snapshot);
      if (state.undo.length > state.maxHistory) state.undo.shift();
      state.redo.length = 0;
    } catch {
      // ignore (e.g., memory)
    }
  }

  function loadImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  async function restoreFromSnapshot(snapshot) {
    if (!snapshot) return;

    const width = Math.max(1, Math.floor(snapshot.width) || canvas.width);
    const height = Math.max(1, Math.floor(snapshot.height) || canvas.height);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      configureContext();
    }

    state.bgColor = snapshot.bgColor ?? state.bgColor;
    if (bgColorEl) bgColorEl.value = state.bgColor;
    applyCanvasBackground();

    state.layers = [];
    state.folders = (snapshot.folders ?? []).map((f) => ({
      id: Number(f.id),
      kind: 'folder',
      name: f.name ?? `フォルダ${f.id}`,
      visible: f.visible !== false,
      collapsed: !!f.collapsed,
      folderId: f.folderId != null ? Number(f.folderId) : null,
      x: f.x ?? 16,
      y: f.y ?? 16,
      out: f.out ?? null,
      inFromLayerId: null,
      childIds: Array.isArray(f.childIds) ? f.childIds.map(Number) : [],
    }));

    const layerDefs = snapshot.layers?.length
      ? snapshot.layers
      : [{ id: 1, name: 'レイヤー1', visible: true, connected: true, x: 16, y: 16, url: null, folderId: null }];

    // Ensure nextNodeId is larger than any restored layer or folder id
    const maxLayerId = Math.max(0, ...layerDefs.map((d) => Number(d.id ?? 0)));
    const maxFolderId = Math.max(0, ...state.folders.map((f) => f.id));
    const maxId = Math.max(maxLayerId, maxFolderId);
    state.nextNodeId = Number(snapshot.nextNodeId ?? 1);
    if (!Number.isFinite(state.nextNodeId) || state.nextNodeId <= maxId) state.nextNodeId = maxId + 1;

    for (const def of layerDefs) {
      const layer = createLayer(def.name, { x: def.x ?? 16, y: def.y ?? 16 });
      if (def.id != null) layer.id = Number(def.id);
      layer.visible = def.visible !== false;
      layer.folderId = def.folderId != null ? Number(def.folderId) : null;
      if (def.out) {
        layer.out = def.out;
      } else if (def.connected !== false) {
        layer.out = { kind: 'output' };
      } else {
        layer.out = null;
      }

      if (def.url) {
        const img = await loadImage(def.url);
        if (img) layer.ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      }
      state.layers.push(layer);
    }

    state.activeLayerId = snapshot.activeLayerId ?? (state.layers[0]?.id ?? null);
    ensureActiveLayer();
    recomputeInputs();
    compositeToScreen();
    renderNodeGraph();
    layoutCanvasDisplay();
  }

  function getPointFromEvent(e) {
    return pointerToCanvasPoint(e, canvas);
  }

  // Pressure only takes effect for pen input; mouse/touch always draw at full strength.
  // For pen input, a reported pressure of exactly 0 is treated as genuinely near-zero
  // (not "unknown, fall back to full") — many tablets report 0 for the very first sample
  // on contact and the last sample on lift-off, and falling back to full there previously
  // made every stroke's entry/exit balloon to maximum width instead of tapering.
  function getPressureFactor(e) {
    if (!state.pressureEnabled || !e) return 1;
    if (e.pointerType !== 'pen') return 1;
    const raw = typeof e.pressure === 'number' ? e.pressure : 0;
    return Math.max(0.05, Math.min(1, raw));
  }

  // Shared spec for any "pressure range" parameter (太さ and 不透明度 both use this): the
  // value sweeps between min% and max% (as fractions of whatever the caller's base unit is)
  // driven by smoothedPressure — or, when pressureEnabled is off, always sits at the max end,
  // matching how each felt before its own pressure toggle existed. Swapping min/max if min >
  // max keeps a sane range regardless of how the two sliders happen to be set relative to
  // each other.
  function getPressureRangeFactor(minPercent, maxPercent, pressureEnabled) {
    const a = Math.max(0, minPercent) / 100;
    const b = Math.max(0, maxPercent) / 100;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const t = pressureEnabled ? state.smoothedPressure : 1;
    return lo + (hi - lo) * t;
  }

  function getStampRadius() {
    const factor = getPressureRangeFactor(state.sizeMinPercent, state.sizeMaxPercent, state.sizePressureEnabled);
    const effectiveSize = state.size * factor;
    return (effectiveSize * getCanvasPixelScale()) / 2;
  }

  function getPressureOpacity() {
    const factor = getPressureRangeFactor(state.opacityMinPercent, state.opacityMaxPercent, state.opacityPressureEnabled);
    const base = Math.max(0, Math.min(100, state.opacity)) / 100;
    return base * factor;
  }

  // Maps a 0-95 strength value to a window size: 1 (no smoothing) at 0, up to 20 samples
  // at max strength. Shared math, independent inputs — 手ブレ補正 (line position) and
  // 筆圧補正 (pressure) are different corrections for different noise (hand wobble vs. a
  // noisy pressure sensor), so each gets its own strength and its own window.
  function strengthToWindowSize(strength) {
    const clamped = Math.max(0, Math.min(95, strength));
    return 1 + Math.round((clamped / 95) * 19);
  }

  function getPositionWindowSize() {
    return strengthToWindowSize(state.stabilizerStrength);
  }

  function getPressureWindowSize() {
    return strengthToWindowSize(state.pressureSmoothingStrength);
  }

  // Pushes one raw {x, y} sample onto the position rolling window (trimmed to 手ブレ補正's
  // window size) and returns its plain arithmetic mean.
  function pushPositionSample(x, y) {
    const windowSize = getPositionWindowSize();
    state.positionBuffer.push({ x, y });
    while (state.positionBuffer.length > windowSize) state.positionBuffer.shift();

    let sx = 0, sy = 0;
    for (const s of state.positionBuffer) {
      sx += s.x;
      sy += s.y;
    }
    const n = state.positionBuffer.length;
    return { x: sx / n, y: sy / n };
  }

  // Pushes one raw pressure sample onto the pressure rolling window (trimmed to 筆圧補正's
  // own, independent window size) and returns its plain arithmetic mean.
  function pushPressureSample(pressure) {
    const windowSize = getPressureWindowSize();
    state.pressureBuffer.push(pressure);
    while (state.pressureBuffer.length > windowSize) state.pressureBuffer.shift();

    let sum = 0;
    for (const p of state.pressureBuffer) sum += p;
    return sum / state.pressureBuffer.length;
  }

  function applyStrokeStyle() {
    const layer = getActiveLayer();
    if (!layer) return;

    if (state.tool === 'eraser') {
      layer.ctx.globalCompositeOperation = 'destination-out';
      layer.ctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      layer.ctx.globalCompositeOperation = 'source-over';
      layer.ctx.fillStyle = state.color;
    }
    layer.ctx.globalAlpha = getPressureOpacity();
  }

  function beginStroke(point, e) {
    state.drawing = true;
    state.last = point;
    // No lag on the very first sample: each window starts out containing only this one
    // value, so its "average" is just the value itself.
    state.positionBuffer = [{ x: point.x, y: point.y }];
    state.pressureBuffer = [getPressureFactor(e)];
    state.smoothX = point.x;
    state.smoothY = point.y;
    state.smoothedPressure = state.pressureBuffer[0];
    state.strokeDistanceAcc = 0;

    pushUndo();

    const layer = getActiveLayer();
    if (!layer) return;

    applyStrokeStyle();
    stampDot(layer.ctx, point.x, point.y, getStampRadius(), state.blur);
    layer.ctx.globalAlpha = 1;
    compositeToScreen();
  }

  function continueStroke(point, e) {
    if (!state.drawing || !state.last) return;

    const layer = getActiveLayer();
    if (!layer) return;

    // Captured before updating smoothedPressure so stampAlongPath can interpolate every
    // stamp within this segment from the previous radius to the new one, instead of jumping
    // straight to the new radius for the whole segment (which reads as a stepped/terraced
    // taper when a segment covers more than one stamp).
    const fromRadius = getStampRadius();

    const pos = pushPositionSample(point.x, point.y);
    state.smoothX = pos.x;
    state.smoothY = pos.y;
    state.smoothedPressure = pushPressureSample(getPressureFactor(e));
    applyStrokeStyle();

    const toRadius = getStampRadius();

    const result = stampAlongPath(
      layer.ctx,
      state.last.x,
      state.last.y,
      state.smoothX,
      state.smoothY,
      fromRadius,
      toRadius,
      state.spacingPct,
      state.strokeDistanceAcc,
      state.blur
    );
    state.strokeDistanceAcc = result.distanceAcc;
    layer.ctx.globalAlpha = 1;

    compositeToScreen();

    state.last = { x: state.smoothX, y: state.smoothY };
  }

  // Stamps any remaining lag between the averaged point/pressure and the actual release
  // point, so a stabilized stroke still reaches where (and at what pressure) the pointer was
  // released. Repeatedly pushing the release values into each window guarantees convergence
  // within max(positionWindow, pressureWindow) iterations — once every sample in a window IS
  // the release value, that window's average is exactly the release value.
  function catchUpStabilizer(targetX, targetY, e) {
    const layer = getActiveLayer();
    if (!layer) return;

    const posWindow = getPositionWindowSize();
    const pressWindow = getPressureWindowSize();
    if (posWindow <= 1 && pressWindow <= 1) return;

    const targetPressure = getPressureFactor(e);
    const iterations = Math.max(posWindow, pressWindow);
    for (let i = 0; i < iterations; i += 1) {
      const fromRadius = getStampRadius();

      const pos = pushPositionSample(targetX, targetY);
      state.smoothX = pos.x;
      state.smoothY = pos.y;
      state.smoothedPressure = pushPressureSample(targetPressure);
      applyStrokeStyle();

      const toRadius = getStampRadius();

      const result = stampAlongPath(
        layer.ctx,
        state.last.x,
        state.last.y,
        state.smoothX,
        state.smoothY,
        fromRadius,
        toRadius,
        state.spacingPct,
        state.strokeDistanceAcc,
        state.blur
      );
      state.strokeDistanceAcc = result.distanceAcc;
      layer.ctx.globalAlpha = 1;
      state.last = { x: state.smoothX, y: state.smoothY };
      const positionSettled = Math.hypot(targetX - state.smoothX, targetY - state.smoothY) < 0.5;
      const pressureSettled = Math.abs(targetPressure - state.smoothedPressure) < 0.01;
      if (positionSettled && pressureSettled) break;
    }
  }

  function endStroke(e) {
    if (!state.drawing) return;

    if (e) {
      const point = getPointFromEvent(e);
      catchUpStabilizer(point.x, point.y, e);
    }

    state.drawing = false;
    state.last = null;
    state.strokeDistanceAcc = 0;

    const layer = getActiveLayer();
    if (layer) layer.ctx.globalAlpha = 1;
    compositeToScreen();
  }

  function sampleColorAt(point) {
    const x = Math.max(0, Math.min(canvas.width - 1, Math.round(point.x)));
    const y = Math.max(0, Math.min(canvas.height - 1, Math.round(point.y)));
    const pixel = ctx.getImageData(x, y, 1, 1).data;
    const hex =
      '#' +
      [pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    state.color = hex;
    if (colorEl) colorEl.value = hex;
  }

  function hexToRgb(hex) {
    let h = hex.startsWith('#') ? hex.slice(1) : hex;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function colorsMatch(r1, g1, b1, a1, r2, g2, b2, a2, tolerance) {
    return (
      Math.abs(r1 - r2) <= tolerance &&
      Math.abs(g1 - g2) <= tolerance &&
      Math.abs(b1 - b2) <= tolerance &&
      Math.abs(a1 - a2) <= tolerance
    );
  }

  // Standard 4-connected, stack-based flood fill on the active layer (not the composited
  // view — filling only the layer the user is actually working on, consistent with every
  // other drawing tool). Matches against the CLICKED pixel's original color throughout (not
  // whatever's already been filled), with a small tolerance so slightly anti-aliased/blurred
  // edges from earlier strokes don't leave a thin unfilled ring around the fill.
  const BUCKET_TOLERANCE = 24;

  function floodFillAt(point) {
    const layer = getActiveLayer();
    if (!layer) return;

    const w = layer.canvas.width;
    const h = layer.canvas.height;
    const startX = Math.round(point.x);
    const startY = Math.round(point.y);
    if (startX < 0 || startY < 0 || startX >= w || startY >= h) return;

    const [fr, fg, fb] = hexToRgb(state.color);
    const fa = Math.round(Math.max(0, Math.min(100, state.opacity)) * 2.55);

    const imageData = layer.ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    const startIdx = (startY * w + startX) * 4;
    const startR = data[startIdx];
    const startG = data[startIdx + 1];
    const startB = data[startIdx + 2];
    const startA = data[startIdx + 3];

    // Already the fill color (within tolerance) — nothing to do, and filling would be a no-op
    // that still costs a full canvas scan.
    if (colorsMatch(startR, startG, startB, startA, fr, fg, fb, fa, 0)) return;

    pushUndo();

    const visited = new Uint8Array(w * h);
    const stack = [startX, startY];
    visited[startY * w + startX] = 1;

    while (stack.length > 0) {
      const y = stack.pop();
      const x = stack.pop();
      const i = (y * w + x) * 4;
      data[i] = fr;
      data[i + 1] = fg;
      data[i + 2] = fb;
      data[i + 3] = fa;

      if (x + 1 < w) tryVisit(x + 1, y);
      if (x - 1 >= 0) tryVisit(x - 1, y);
      if (y + 1 < h) tryVisit(x, y + 1);
      if (y - 1 >= 0) tryVisit(x, y - 1);
    }

    function tryVisit(x, y) {
      const vi = y * w + x;
      if (visited[vi]) return;
      const i = vi * 4;
      if (!colorsMatch(data[i], data[i + 1], data[i + 2], data[i + 3], startR, startG, startB, startA, BUCKET_TOLERANCE)) {
        return;
      }
      visited[vi] = 1;
      stack.push(x, y);
    }

    layer.ctx.putImageData(imageData, 0, 0);
    compositeToScreen();
  }

  function clearCanvas() {
    pushUndo();
    for (const layer of state.layers) {
      layer.ctx.setTransform(1, 0, 0, 1, 0, 0);
      layer.ctx.clearRect(0, 0, layer.canvas.width, layer.canvas.height);
      configureLayerContext(layer.ctx);
    }
    compositeToScreen();
    renderNodeGraph();
  }

  async function undo() {
    if (state.undo.length === 0) return;
    const current = buildSnapshot();
    state.redo.push(current);
    const prev = state.undo.pop();
    await restoreFromSnapshot(prev);
  }

  async function redo() {
    if (state.redo.length === 0) return;
    const current = buildSnapshot();
    state.undo.push(current);
    const next = state.redo.pop();
    await restoreFromSnapshot(next);
  }

  function savePng() {
    // 直前の描画を確実に反映
    compositeToScreen();

    const out = document.createElement('canvas');
    out.width = canvas.width;
    out.height = canvas.height;
    const outCtx = out.getContext('2d');

    outCtx.fillStyle = state.bgColor;
    outCtx.fillRect(0, 0, out.width, out.height);

    compositeLayers(outCtx, out.width, out.height, computeRenderOrder(), { clear: false });

    const a = document.createElement('a');
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const name = `paintsoft_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.png`;

    a.download = name;
    a.href = out.toDataURL('image/png');
    a.click();
  }

  function triggerBlobDownload(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = name;
    a.href = url;
    a.click();
    // revoke once the (async) download has had a chance to start
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function timestampedName(ext) {
    const stamp = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `paintsoft_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}_${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.${ext}`;
  }

  // The app's own lossless project format: buildSnapshot()'s data (every layer/folder,
  // the full node graph and its connections, and the canvas's own pixel resolution), as
  // JSON. Round-trips perfectly through openProjectFile — unlike PSD/.clip, nothing is
  // flattened or dropped.
  function buildProjectFile() {
    return {
      format: 'paintsoft-project',
      version: 1,
      ...buildSnapshot(),
    };
  }

  function saveProjectFile() {
    const blob = new Blob([JSON.stringify(buildProjectFile())], { type: 'application/json' });
    triggerBlobDownload(blob, timestampedName('psft'));
    setHint('プロジェクトを保存しました');
  }

  async function openProjectFile(doc) {
    if (!doc || doc.format !== 'paintsoft-project') {
      setHint('対応していないプロジェクトファイルです（.psft を指定してください）');
      return;
    }

    pushUndo();
    // restoreFromSnapshot applies doc's own width/height directly and never resamples to fit
    // the current panel size, so the loaded artwork stays pixel-perfect.
    await restoreFromSnapshot(doc);
    setHint('プロジェクトを読み込みました');
  }

  // Discards everything (layers, folders, undo/redo history, view) and starts over at the
  // default document size — the same starting state a first-ever launch gets. Confirmed first
  // since, unlike every other destructive action here, this also wipes the undo stack itself,
  // so there's no "just press Ctrl+Z" way back afterward.
  function closeProject() {
    if (!window.confirm('保存していない変更は失われます。プロジェクトを閉じて新規作成しますか？')) return;

    canvas.width = DEFAULT_CANVAS_WIDTH;
    canvas.height = DEFAULT_CANVAS_HEIGHT;
    configureContext();
    writeCanvasSize(DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT);

    state.folders = [];
    state.nextNodeId = 1;
    state.layers = [createLayer('レイヤー1', { x: 60, y: 110 })];
    state.activeLayerId = state.layers[0].id;
    state.linkingFromLayerId = null;
    state.dropTargetFolderId = null;
    state.draggingNodeId = null;

    state.undo = [];
    state.redo = [];

    resetView();
    recomputeInputs();
    layoutCanvasDisplay();
    renderNodeGraph();
    compositeToScreen();
    setHint('新しいプロジェクトを開始しました');
  }

  // ---- PSD export -----------------------------------------------------------------
  // A from-scratch, uncompressed (raw) PSD writer covering just enough of Adobe's format
  // to round-trip real layers into Photoshop/GIMP/etc: per-layer RGBA pixels, name (with a
  // Unicode 'luni' block so Japanese names survive) and visibility. Folder grouping has no
  // flat equivalent in PSD, so folders are expanded in place (same stacking order the
  // canvas shows) rather than reproduced as PSD layer groups — a deliberate best-effort
  // simplification, not an oversight.

  function makeByteWriter() {
    const chunks = [];
    let length = 0;
    const push = (arr) => {
      chunks.push(arr);
      length += arr.length;
    };
    return {
      push,
      u8: (v) => push(Uint8Array.of(v & 0xff)),
      u16: (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, false); push(b); },
      i16: (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v, false); push(b); },
      u32: (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, false); push(b); },
      i32: (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v, false); push(b); },
      ascii: (s) => push(Uint8Array.from(s, (c) => c.charCodeAt(0))),
      bytes: (arr) => push(arr),
      toUint8Array() {
        const out = new Uint8Array(length);
        let off = 0;
        for (const c of chunks) {
          out.set(c, off);
          off += c.length;
        }
        return out;
      },
    };
  }

  function padEven(u8arr) {
    if (u8arr.length % 2 === 0) return u8arr;
    const padded = new Uint8Array(u8arr.length + 1);
    padded.set(u8arr);
    return padded;
  }

  // Legacy (non-Unicode) layer name field: its encoding is tied to the reader's system code
  // page, which makes non-ASCII text unreliable across readers — keep it ASCII-safe and put
  // the real name in a Unicode block instead (every modern reader prefers that anyway).
  function psdPascalName(name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').slice(0, 255) || 'Layer';
    const bytes = Uint8Array.from(ascii, (c) => c.charCodeAt(0));
    const total = 1 + bytes.length;
    const out = new Uint8Array(total + ((4 - (total % 4)) % 4));
    out[0] = bytes.length;
    out.set(bytes, 1);
    return out;
  }

  function psdUnicodeNameBlock(name) {
    const units = new Uint8Array(name.length * 2);
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      units[i * 2] = (code >> 8) & 0xff;
      units[i * 2 + 1] = code & 0xff;
    }
    const inner = makeByteWriter();
    inner.u32(name.length);
    inner.bytes(units);

    const w = makeByteWriter();
    w.ascii('8BIM');
    w.ascii('luni');
    const innerBytes = padEven(inner.toUint8Array());
    w.u32(innerBytes.length);
    w.bytes(innerBytes);
    return w.toUint8Array();
  }

  // Splits an RGBA canvas into 4 separate 8-bit planes (PSD stores channels planar, not
  // interleaved): [R, G, B, A], each width*height bytes.
  function splitRgbaPlanes(canvasEl, width, height) {
    const data = canvasEl.getContext('2d').getImageData(0, 0, width, height).data;
    const n = width * height;
    const r = new Uint8Array(n);
    const g = new Uint8Array(n);
    const b = new Uint8Array(n);
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      r[i] = data[o];
      g[i] = data[o + 1];
      b[i] = data[o + 2];
      a[i] = data[o + 3];
    }
    return [r, g, b, a];
  }

  function buildPsdBytes() {
    const width = canvas.width;
    const height = canvas.height;

    // Normally the same layers the canvas composites (in the same order); if nothing is
    // connected to the output node at all, fall back to exporting every layer as-is rather
    // than writing a PSD with zero layers.
    let items = computeExportLayerOrder();
    if (items.length === 0) {
      items = state.layers.map((l) => ({ layer: l, visible: l.visible }));
    }

    const channelIds = [0, 1, 2, -1]; // R, G, B, alpha
    const layerInfo = makeByteWriter();
    layerInfo.i16(items.length);

    const channelDataByLayer = [];
    for (const { layer, visible } of items) {
      const planes = splitRgbaPlanes(layer.canvas, width, height);

      const rec = makeByteWriter();
      rec.i32(0); rec.i32(0); rec.i32(height); rec.i32(width); // top, left, bottom, right
      rec.u16(channelIds.length);
      const chanDataLen = 2 + width * height; // 2-byte compression method + raw plane bytes
      for (const id of channelIds) {
        rec.i16(id);
        rec.u32(chanDataLen);
      }
      rec.ascii('8BIM');
      rec.ascii('norm'); // blend mode: normal (this app has no per-layer blend modes)
      rec.u8(255); // opacity
      rec.u8(0); // clipping
      rec.u8(visible ? 0x00 : 0x02); // flags: bit 1 set = hidden
      rec.u8(0); // filler

      const extra = makeByteWriter();
      extra.u32(0); // layer mask data
      extra.u32(0); // layer blending ranges data
      extra.bytes(psdPascalName(layer.name));
      extra.bytes(psdUnicodeNameBlock(layer.name));
      const extraBytes = extra.toUint8Array();
      rec.u32(extraBytes.length);
      rec.bytes(extraBytes);

      layerInfo.bytes(rec.toUint8Array());

      const chan = makeByteWriter();
      for (const plane of planes) {
        chan.u16(0); // compression: raw
        chan.bytes(plane);
      }
      channelDataByLayer.push(chan.toUint8Array());
    }
    for (const chanData of channelDataByLayer) layerInfo.bytes(chanData);

    const layerAndMaskInfo = makeByteWriter();
    const layerInfoBytes = padEven(layerInfo.toUint8Array());
    layerAndMaskInfo.u32(layerInfoBytes.length);
    layerAndMaskInfo.bytes(layerInfoBytes);
    layerAndMaskInfo.u32(0); // global layer mask info length

    // Merged/composite preview image — exactly what compositeToScreen() shows.
    compositeToScreen();
    const merged = document.createElement('canvas');
    merged.width = width;
    merged.height = height;
    const mergedCtx = merged.getContext('2d');
    mergedCtx.fillStyle = state.bgColor;
    mergedCtx.fillRect(0, 0, width, height);
    compositeLayers(mergedCtx, width, height, computeRenderOrder(), { clear: false });
    const mergedPlanes = splitRgbaPlanes(merged, width, height);

    const psd = makeByteWriter();
    psd.ascii('8BPS');
    psd.u16(1); // version 1 (regular PSD, not PSB)
    psd.bytes(new Uint8Array(6)); // reserved
    psd.u16(4); // channels: R,G,B,A
    psd.u32(height);
    psd.u32(width);
    psd.u16(8); // depth: 8 bits/channel
    psd.u16(3); // color mode: RGB

    psd.u32(0); // color mode data length
    psd.u32(0); // image resources length

    const lmBytes = padEven(layerAndMaskInfo.toUint8Array());
    psd.u32(lmBytes.length);
    psd.bytes(lmBytes);

    psd.u16(0); // merged image compression: raw
    for (const plane of mergedPlanes) psd.bytes(plane);

    return psd.toUint8Array();
  }

  function savePsd() {
    const bytes = buildPsdBytes();
    const blob = new Blob([bytes], { type: 'image/vnd.adobe.photoshop' });
    triggerBlobDownload(blob, timestampedName('psd'));
    setHint('PSDを書き出しました（フォルダはグループ化されず展開されます）');
  }

  // Called from the WPF host (MainWindow.xaml.cs) after it decodes a .clip file.
  // doc = { width, height, layers: [{ name, x, y, width, height, visible, png }, ...] }
  // layers are ordered back-to-front (bottom of the CLIP layer stack first).
  async function loadClipDocument(doc) {
    if (!doc || !Array.isArray(doc.layers) || doc.layers.length === 0) return;

    pushUndo();

    const docW = Math.max(1, Math.floor(doc.width) || 1);
    const docH = Math.max(1, Math.floor(doc.height) || 1);
    const n = doc.layers.length;

    const newLayers = [];
    for (let i = 0; i < n; i++) {
      const ld = doc.layers[i];
      // Node position controls draw order via geometric distance to the output node
      // (see compositeToScreen): farther = drawn first (below), nearer = drawn last (above).
      // i=0 is the bottom-most clip layer, so give it the largest y (farthest).
      const pos = { x: 40 + (i % 2) * 30, y: 80 + (n - 1 - i) * 80 };
      const layer = createLayer(ld.name, pos);

      layer.canvas.width = docW;
      layer.canvas.height = docH;
      configureLayerContext(layer.ctx);
      layer.visible = ld.visible !== false;
      layer.out = { kind: 'output' };

      if (ld.png) {
        const img = await loadImage(ld.png);
        if (img) layer.ctx.drawImage(img, Math.round(ld.x || 0), Math.round(ld.y || 0));
      }

      newLayers.push(layer);
    }

    state.layers = newLayers;
    state.folders = [];
    state.activeLayerId = newLayers[0]?.id ?? null;
    ensureActiveLayer();
    recomputeInputs();

    // Adopt the clip's native resolution as-is (no resampling) — only the on-screen display
    // size adapts to fit the panel, same as opening a .psft project.
    canvas.width = docW;
    canvas.height = docH;
    configureContext();
    writeCanvasSize(docW, docH);
    layoutCanvasDisplay();

    renderNodeGraph();
    compositeToScreen();
    setHint(`clipファイルを読み込みました（${n}レイヤー）`);
  }

  window.loadClipDocument = loadClipDocument;

  // Called from the WPF host (MainWindow.xaml.cs) to build a .clip file for export.
  // Mirrors loadClipDocument's shape exactly (back-to-front layers, full-canvas rect per
  // layer) so the two stay symmetric; see computeExportLayerOrder for what "back-to-front,
  // with cascaded visibility" means for hidden/folder-nested layers.
  function getClipExportDocument() {
    let items = computeExportLayerOrder();
    if (items.length === 0) {
      items = state.layers.map((l) => ({ layer: l, visible: l.visible }));
    }

    return {
      width: canvas.width,
      height: canvas.height,
      layers: items.map(({ layer, visible }) => ({
        name: layer.name,
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height,
        visible,
        png: layer.canvas.toDataURL('image/png'),
      })),
    };
  }

  window.getClipExportDocument = getClipExportDocument;

  const TOOL_HINTS = {
    brush: 'ブラシ：ドラッグで描画',
    eraser: '消しゴム：ドラッグで消去',
    eyedropper: 'スポイト：クリックで色を採取',
    bucket: 'バケツ：クリックで同色の範囲を塗りつぶし',
    hand: 'ハンド：ドラッグして表示位置を移動',
  };

  // Single source of truth for switching tools — used by the tool dropdown, the eyedropper/
  // bucket buttons, and the hold-to-temporarily-switch mechanic below, so all stay in sync.
  function setTool(next) {
    state.tool = next;
    if ((next === 'brush' || next === 'eraser') && toolEl.value !== next) toolEl.value = next;
    eyedropperEl?.setAttribute('aria-pressed', String(next === 'eyedropper'));
    bucketEl?.setAttribute('aria-pressed', String(next === 'bucket'));
    canvas.classList.toggle('cursorGrab', next === 'hand');
    setHint(TOOL_HINTS[next] ?? 'ドラッグして描画 / Ctrl+Zで戻す / Ctrl+Yでやり直し');
  }

  // Called on keyup for the physical key that armed a tool-hold session (see the keydown
  // handler in wireUi, which switches the tool INSTANTLY on keydown — no delay before the
  // switch itself). This only decides, at release, whether that switch sticks: a short tap
  // (released within holdThresholdMs) commits it permanently, like clicking the tool;
  // holding past the threshold reverts to whatever was active before once released.
  function releaseToolHold(code) {
    if (state.toolHoldCode == null || code !== state.toolHoldCode) return;
    const heldMs = performance.now() - state.toolHoldStartedAt;
    if (heldMs >= state.holdThresholdMs) {
      setTool(state.previousTool ?? 'brush');
    }
    state.toolHoldCode = null;
    state.toolHoldTarget = null;
    state.toolHoldStartedAt = null;
    state.previousTool = null;
  }

  // Aborts an active tool-hold session without knowing whether the key was ever released
  // (e.g. the window lost focus — Alt-Tab — while the key was still physically down and the
  // OS never delivered a keyup). Always reverts rather than commits, since a tap vs. hold
  // can't be distinguished this way — the tool already switched instantly on keydown, so
  // there's always something to revert here as long as a hold session is active.
  function cancelToolHold() {
    if (state.toolHoldCode != null) {
      setTool(state.previousTool ?? 'brush');
    }
    state.toolHoldCode = null;
    state.toolHoldTarget = null;
    state.toolHoldStartedAt = null;
    state.previousTool = null;
  }

  // ---- Shortcuts settings dialog -----------------------------------------------------
  // In-memory copy of state.shortcuts edited while the dialog is open; only committed to
  // state + localStorage when the user clicks 保存, so closing/canceling discards edits.
  let shortcutsDraft = null;
  let capturingButton = null;

  function cloneShortcuts(src) {
    return { bindings: src.bindings.map((b) => ({ ...b })) };
  }

  function renderShortcutRows() {
    if (!shortcutRowsEl) return;
    capturingButton = null;

    shortcutRowsEl.innerHTML = BINDABLE_ACTIONS.map((action) => {
      const binding = shortcutsDraft.bindings.find((b) => b.action === action.id);
      return `
        <div class="shortcutRow">
          <span class="shortcutLabel">${escapeHtml(action.label)}</span>
          <button type="button" class="keyCapture" data-action="${action.id}">${escapeHtml(formatBinding(binding))}</button>
          <button type="button" class="shortcutRowReset" data-action="${action.id}" title="デフォルトに戻す">↺</button>
        </div>
      `;
    }).join('');

    shortcutRowsEl.querySelectorAll('.keyCapture').forEach((btn) => {
      btn.addEventListener('click', () => startCapture(btn));
    });
    shortcutRowsEl.querySelectorAll('.shortcutRowReset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const actionId = btn.dataset.action;
        const def = DEFAULT_SHORTCUTS.bindings.find((b) => b.action === actionId);
        const idx = shortcutsDraft.bindings.findIndex((b) => b.action === actionId);
        if (def && idx >= 0) shortcutsDraft.bindings[idx] = { ...def };
        renderShortcutRows();
      });
    });
  }

  function startCapture(btn) {
    // Reset any OTHER button still mid-capture in place, rather than re-rendering the whole
    // list — renderShortcutRows() replaces every row's DOM node wholesale, which would detach
    // `btn` itself (the one just clicked) from the document right before the lines below try
    // to focus/style it, silently leaving the "listening" state on an invisible orphaned node.
    if (capturingButton && capturingButton !== btn) {
      const prevBinding = shortcutsDraft.bindings.find((b) => b.action === capturingButton.dataset.action);
      capturingButton.classList.remove('listening');
      capturingButton.textContent = formatBinding(prevBinding);
    }
    capturingButton = btn;
    btn.classList.add('listening');
    btn.textContent = 'キー入力待ち…（Escで取消）';
    // Keydown is read from document.activeElement — without this, focus can be left on
    // whatever was focused before (even <body> itself), and since body isn't a descendant of
    // the dialog, a keydown targeting it never bubbles through the dialog's own listener at
    // all, making capture silently never respond to any key press.
    btn.focus();
  }

  // Attached to globalSettingsDialogEl itself (the shortcuts section lives inside it) so it
  // only ever sees keydowns while that dialog is open (native <dialog> traps focus inside it
  // via showModal()); the app-wide shortcut dispatcher in wireUi also short-circuits whenever
  // globalSettingsDialogEl.open is true, so a key pressed here never doubles as triggering the
  // very shortcut being reassigned.
  function handleShortcutsDialogKeydown(e) {
    if (!capturingButton) return;
    e.preventDefault();
    e.stopPropagation();

    if (e.code === 'Escape') {
      capturingButton = null;
      renderShortcutRows();
      return;
    }

    const modifierCodes = ['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
    if (modifierCodes.includes(e.code)) return; // wait for a real key, not the modifier alone

    const actionId = capturingButton.dataset.action;
    const next = { action: actionId, code: e.code, ctrl: primaryModDown(e), shift: e.shiftKey, alt: e.altKey };

    const conflict = shortcutsDraft.bindings.find(
      (b) => b.action !== actionId && b.code === next.code && !!b.ctrl === next.ctrl && !!b.shift === next.shift && !!b.alt === next.alt
    );

    const idx = shortcutsDraft.bindings.findIndex((b) => b.action === actionId);
    if (idx >= 0) shortcutsDraft.bindings[idx] = next;
    capturingButton = null;
    renderShortcutRows();

    if (conflict) {
      const conflictLabel = BINDABLE_ACTIONS.find((a) => a.id === conflict.action)?.label ?? conflict.action;
      setHint(`「${conflictLabel}」と同じキーに割り当てました（両方に反応します）`);
    }
  }

  // ---- Canvas settings dialog (size / resolution) --------------------------------------
  // 'resize' rescales existing content to the new pixel dimensions (setDocumentResolution);
  // 'crop' repositions the canvas boundary around existing content, unscaled
  // (resizeCanvasWithAnchor) — the standard "Image Size" vs. "Canvas Size" distinction.
  let canvasSettingsMode = 'resize';
  let canvasSettingsAnchor = { x: 0.5, y: 0.5 };

  function openCanvasSettingsDialog() {
    if (!canvasSettingsDialogEl) return;
    canvasSettingsMode = 'resize';
    canvasSettingsAnchor = { x: 0.5, y: 0.5 };
    if (canvasWidthInputEl) canvasWidthInputEl.value = String(canvas.width);
    if (canvasHeightInputEl) canvasHeightInputEl.value = String(canvas.height);
    if (lockAspectInputEl) lockAspectInputEl.checked = true;
    anchorGridEl?.querySelectorAll('.anchorCell').forEach((cell) => {
      cell.classList.toggle('active', Number(cell.dataset.x) === 0.5 && Number(cell.dataset.y) === 0.5);
    });
    updateCanvasSettingsModeUI();
    canvasSettingsDialogEl.showModal();
  }

  function updateCanvasSettingsModeUI() {
    const isCrop = canvasSettingsMode === 'crop';
    canvasModeResizeEl?.setAttribute('aria-pressed', String(!isCrop));
    canvasModeCropEl?.setAttribute('aria-pressed', String(isCrop));
    if (canvasModeHintEl) {
      canvasModeHintEl.textContent = isCrop
        ? '絵の内容はそのまま、キャンバスだけを切り抜き/拡張します。'
        : '絵の内容を新しいサイズに合わせて拡大縮小します。';
    }
    if (lockAspectRowEl) lockAspectRowEl.hidden = isCrop;
    if (anchorGridWrapEl) anchorGridWrapEl.hidden = !isCrop;
  }

  function wireUi() {
    // A clicked <button> stays focused afterward, and a focused button treats a later
    // Space press as "activate me" (standard browser behavior) — e.g. click ショートカット設定,
    // go back to drawing, then hit Space (for the Ctrl+Space zoom modifier, or just
    // incidentally) and it reopens on its own. Blur it right after a real mouse click so
    // Space/Enter stop being able to re-trigger it. MouseEvent.detail === 0 reliably means
    // the "click" was itself keyboard-triggered (Enter/Space activating a focused button),
    // so that case is left alone — keyboard users keep normal focus behavior.
    document.addEventListener('click', (e) => {
      if (e.detail === 0) return;
      e.target?.closest?.('button')?.blur();
    });

    toolEl.addEventListener('change', () => {
      setTool(toolEl.value);
    });

    colorEl.addEventListener('input', () => {
      state.color = colorEl.value;
    });

    bgColorEl.addEventListener('input', () => {
      state.bgColor = bgColorEl.value;
      applyCanvasBackground();
      compositeToScreen();
    });

    nodeAddEl?.addEventListener('click', () => {
      pushUndo();
      const count = state.layers.filter((l) => l.folderId == null).length + state.folders.length + 1;
      const pos = { x: 40 + (count % 2) * 30, y: 80 + (count - 1) * 72 };
      const layer = createLayer(undefined, pos);
      layer.out = { kind: 'output' };
      state.layers.push(layer);
      state.activeLayerId = layer.id;
      recomputeInputs();
      renderNodeGraph();
      compositeToScreen();
    });

    folderAddEl?.addEventListener('click', () => {
      pushUndo();
      const count = state.layers.filter((l) => l.folderId == null).length + state.folders.length + 1;
      const pos = { x: 40 + (count % 2) * 30, y: 80 + (count - 1) * 72 };
      const folder = createFolder(undefined, pos);
      folder.out = { kind: 'output' };
      state.folders.push(folder);
      recomputeInputs();
      renderNodeGraph();
      compositeToScreen();
    });

    nodeDelEl?.addEventListener('click', () => {
      if (state.layers.length <= 1) return;
      if (state.activeLayerId == null) return;

      pushUndo();
      const idx = state.layers.findIndex((l) => l.id === state.activeLayerId);
      const removed = idx >= 0 ? state.layers[idx] : null;
      if (idx >= 0) state.layers.splice(idx, 1);

      // if the removed layer belonged to a folder, drop it from that folder's child list
      if (removed?.folderId != null) {
        const folder = state.folders.find((f) => f.id === removed.folderId);
        if (folder) folder.childIds = folder.childIds.filter((id) => id !== removed.id);
      }

      // cleanup dangling outputs (targets may be layers or folders)
      for (const node of getRoutableNodes()) {
        if (node.out?.kind === 'layer' && !findRoutableNode(node.out.layerId)) node.out = null;
      }
      recomputeInputs();

      state.activeLayerId = state.layers[Math.max(0, idx - 1)]?.id ?? state.layers[0]?.id ?? null;
      ensureActiveLayer();
      renderNodeGraph();
      compositeToScreen();
    });

    sizeEl.addEventListener('input', () => {
      state.size = Number(sizeEl.value);
      sizeValueEl.textContent = String(state.size);
      persistCurrentBrushSettings();
    });

    sizeMinEl?.addEventListener('input', () => {
      state.sizeMinPercent = Number(sizeMinEl.value);
      if (sizeMinValueEl) sizeMinValueEl.textContent = `${state.sizeMinPercent}%`;
      persistCurrentBrushSettings();
    });

    sizeMaxEl?.addEventListener('input', () => {
      state.sizeMaxPercent = Number(sizeMaxEl.value);
      if (sizeMaxValueEl) sizeMaxValueEl.textContent = `${state.sizeMaxPercent}%`;
      persistCurrentBrushSettings();
    });

    sizePressureEnabledEl?.addEventListener('change', () => {
      state.sizePressureEnabled = sizePressureEnabledEl.checked;
      persistCurrentBrushSettings();
    });

    blurEl?.addEventListener('input', () => {
      state.blur = Number(blurEl.value);
      if (blurValueEl) blurValueEl.textContent = String(state.blur);
      persistCurrentBrushSettings();
    });

    opacityEl?.addEventListener('input', () => {
      state.opacity = Number(opacityEl.value);
      if (opacityValueEl) opacityValueEl.textContent = `${state.opacity}%`;
      persistCurrentBrushSettings();
    });

    opacityMinEl?.addEventListener('input', () => {
      state.opacityMinPercent = Number(opacityMinEl.value);
      if (opacityMinValueEl) opacityMinValueEl.textContent = `${state.opacityMinPercent}%`;
      persistCurrentBrushSettings();
    });

    opacityMaxEl?.addEventListener('input', () => {
      state.opacityMaxPercent = Number(opacityMaxEl.value);
      if (opacityMaxValueEl) opacityMaxValueEl.textContent = `${state.opacityMaxPercent}%`;
      persistCurrentBrushSettings();
    });

    opacityPressureEnabledEl?.addEventListener('change', () => {
      state.opacityPressureEnabled = opacityPressureEnabledEl.checked;
      persistCurrentBrushSettings();
    });

    brushPresetSaveEl?.addEventListener('click', () => {
      const name = window.prompt('ブラシ名を入力してください', '新しいブラシ');
      if (!name) return;
      const preset = { id: Date.now(), name, ...captureBrushSettings() };
      state.brushPresets.push(preset);
      state.activeBrushPresetId = preset.id;
      writeBrushPresets(state.brushPresets);
      persistCurrentBrushSettings();
      renderBrushPresetList();
      setHint(`ブラシ「${preset.name}」を保存しました`);
    });

    brushPresetUpdateEl?.addEventListener('click', () => {
      const preset = state.brushPresets.find((p) => p.id === state.activeBrushPresetId);
      if (!preset) {
        setHint('更新するブラシをリストから選択してください');
        return;
      }
      Object.assign(preset, captureBrushSettings());
      writeBrushPresets(state.brushPresets);
      setHint(`ブラシ「${preset.name}」を更新しました`);
    });

    brushPresetDeleteEl?.addEventListener('click', () => {
      const preset = state.brushPresets.find((p) => p.id === state.activeBrushPresetId);
      if (!preset) return;
      state.brushPresets = state.brushPresets.filter((p) => p.id !== preset.id);
      state.activeBrushPresetId = null;
      writeBrushPresets(state.brushPresets);
      persistCurrentBrushSettings();
      renderBrushPresetList();
      setHint(`ブラシ「${preset.name}」を削除しました`);
    });

    spacingEl?.addEventListener('input', () => {
      state.spacingPct = Number(spacingEl.value);
      if (spacingValueEl) spacingValueEl.textContent = `${state.spacingPct}%`;
      persistCurrentBrushSettings();
    });

    // 手ブレ補正・筆圧補正・筆圧ON/OFF live in the グローバル設定 dialog and apply to every
    // brush — persisted separately from any brush preset (persistGlobalSettings, not
    // persistCurrentBrushSettings).
    stabilizerEl?.addEventListener('input', () => {
      state.stabilizerStrength = Number(stabilizerEl.value);
      if (stabilizerValueEl) stabilizerValueEl.textContent = String(state.stabilizerStrength);
      persistGlobalSettings();
    });

    pressureSmoothingEl?.addEventListener('input', () => {
      state.pressureSmoothingStrength = Number(pressureSmoothingEl.value);
      if (pressureSmoothingValueEl) pressureSmoothingValueEl.textContent = String(state.pressureSmoothingStrength);
      persistGlobalSettings();
    });

    pressureEnabledInputEl?.addEventListener('change', () => {
      state.pressureEnabled = pressureEnabledInputEl.checked;
      persistGlobalSettings();
    });

    globalHoldThresholdEl?.addEventListener('input', () => {
      state.holdThresholdMs = Number(globalHoldThresholdEl.value);
      if (globalHoldThresholdValueEl) globalHoldThresholdValueEl.textContent = `${state.holdThresholdMs}ms`;
      persistGlobalSettings();
    });

    openGlobalSettingsEl?.addEventListener('click', () => {
      shortcutsDraft = cloneShortcuts(state.shortcuts);
      renderShortcutRows();
      globalSettingsDialogEl?.showModal();
    });
    globalSettingsCloseEl?.addEventListener('click', () => globalSettingsDialogEl?.close());
    globalSettingsDialogEl?.addEventListener('keydown', handleShortcutsDialogKeydown);
    globalSettingsDialogEl?.addEventListener('cancel', () => {
      // Esc closes the native <dialog> by default; treat that the same as clicking 閉じる
      // (discard the shortcuts draft) unless it's actually meant to cancel an in-progress key
      // capture, which handleShortcutsDialogKeydown already consumes via preventDefault/
      // stopPropagation before this ever fires.
      capturingButton = null;
    });
    // <dialog> restores focus to whichever element opened it (the topbar button) once
    // closed — if left focused, a later Space press would activate that button as a normal
    // keyboard-focus action and reopen the dialog. Clearing focus on close (works for every
    // close path: ×, Esc, and clicking outside if ever enabled) prevents that.
    globalSettingsDialogEl?.addEventListener('close', () => {
      document.activeElement?.blur?.();
    });

    resetViewEl?.addEventListener('click', () => resetView());

    eyedropperEl?.addEventListener('click', () => {
      setTool('eyedropper');
    });

    bucketEl?.addEventListener('click', () => {
      setTool('bucket');
    });

    clearEl.addEventListener('click', clearCanvas);
    saveEl.addEventListener('click', savePng);

    saveProjectEl?.addEventListener('click', saveProjectFile);
    savePsdEl?.addEventListener('click', savePsd);

    closeProjectEl?.addEventListener('click', closeProject);

    openProjectEl?.addEventListener('click', () => openProjectInputEl?.click());
    openProjectInputEl?.addEventListener('change', async () => {
      const file = openProjectInputEl.files?.[0];
      openProjectInputEl.value = '';
      if (!file) return;
      try {
        const doc = JSON.parse(await file.text());
        await openProjectFile(doc);
      } catch {
        setHint('プロジェクトファイルの読み込みに失敗しました');
      }
    });

    shortcutsResetDefaultEl?.addEventListener('click', () => {
      shortcutsDraft = cloneShortcuts(DEFAULT_SHORTCUTS);
      renderShortcutRows();
    });

    shortcutsSaveEl?.addEventListener('click', () => {
      state.shortcuts = shortcutsDraft;
      writeShortcuts(state.shortcuts);
      setHint('ショートカットを保存しました');
    });

    openCanvasSettingsEl?.addEventListener('click', () => openCanvasSettingsDialog());
    canvasSettingsCloseEl?.addEventListener('click', () => canvasSettingsDialogEl?.close());

    canvasModeResizeEl?.addEventListener('click', () => {
      canvasSettingsMode = 'resize';
      updateCanvasSettingsModeUI();
    });
    canvasModeCropEl?.addEventListener('click', () => {
      canvasSettingsMode = 'crop';
      updateCanvasSettingsModeUI();
    });

    canvasWidthInputEl?.addEventListener('input', () => {
      if (canvasSettingsMode !== 'resize' || !lockAspectInputEl?.checked || !canvasHeightInputEl) return;
      const w = Number(canvasWidthInputEl.value);
      if (w > 0) canvasHeightInputEl.value = String(Math.round(w / (canvas.width / canvas.height)));
    });
    canvasHeightInputEl?.addEventListener('input', () => {
      if (canvasSettingsMode !== 'resize' || !lockAspectInputEl?.checked || !canvasWidthInputEl) return;
      const h = Number(canvasHeightInputEl.value);
      if (h > 0) canvasWidthInputEl.value = String(Math.round(h * (canvas.width / canvas.height)));
    });

    anchorGridEl?.querySelectorAll('.anchorCell').forEach((cell) => {
      cell.addEventListener('click', () => {
        canvasSettingsAnchor = { x: Number(cell.dataset.x), y: Number(cell.dataset.y) };
        anchorGridEl.querySelectorAll('.anchorCell').forEach((c) => c.classList.toggle('active', c === cell));
      });
    });

    canvasSettingsApplyEl?.addEventListener('click', () => {
      const w = Math.floor(Number(canvasWidthInputEl?.value));
      const h = Math.floor(Number(canvasHeightInputEl?.value));
      if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        setHint('幅・高さには正しい数値を入力してください');
        return;
      }
      if (canvasSettingsMode === 'crop') {
        resizeCanvasWithAnchor(w, h, canvasSettingsAnchor.x, canvasSettingsAnchor.y);
        setHint('キャンバスサイズを変更しました');
      } else {
        setDocumentResolution(w, h);
        setHint('解像度を変更しました');
      }
      canvasSettingsDialogEl?.close();
    });

    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') {
        state.spaceDown = true;
        // Don't hijack Space while the user is operating a focusable control with it
        // (select/checkbox/button default action), only while it's used as the
        // zoom-tool modifier over the canvas/body.
        const tag = e.target?.tagName?.toLowerCase();
        if (tag !== 'input' && tag !== 'select' && tag !== 'button' && tag !== 'textarea') {
          e.preventDefault();
        }
      }

      // The shortcuts dialog handles its own key-capture listener while open (and other
      // dialogs shouldn't have keystrokes double as app shortcuts either), so skip dispatch
      // entirely while any modal dialog is open.
      if (canvasSettingsDialogEl?.open || globalSettingsDialogEl?.open) return;

      const tag = e.target?.tagName?.toLowerCase();
      const isEditable = tag === 'input' || tag === 'select' || tag === 'textarea' || e.target?.isContentEditable;
      if (isEditable || e.repeat) return;

      // Hold-to-temporarily-switch-tool: uniform for every tool.* binding, no per-tool
      // branching. A short tap (released before the threshold) commits the switch
      // permanently, like clicking the tool directly; holding past the threshold switches
      // temporarily and reverts to the previous tool on release (see releaseToolHold below).
      if (state.toolHoldCode == null) {
        const toolAction = BINDABLE_ACTIONS.find((a) => a.kind === 'tool' && matchesBinding(e, getBinding(a.id)));
        if (toolAction) {
          e.preventDefault();
          // Switches instantly on press — no delay before the tool actually changes. Whether
          // this sticks (a quick tap, like clicking the tool) or reverts on release (held past
          // holdThresholdMs) is decided later, in releaseToolHold, purely from how long the key
          // was down; there's nothing to arm/commit here beyond starting that clock.
          state.toolHoldCode = e.code;
          state.toolHoldTarget = toolAction.tool;
          state.toolHoldStartedAt = performance.now();
          state.previousTool = state.tool;
          setTool(toolAction.tool);
          return;
        }
      }

      if (matchesBinding(e, getBinding('action.undo'))) {
        e.preventDefault();
        undo();
        return;
      }
      // Ctrl+Shift+Z is such a universal "redo" convention that it's kept as a fixed
      // fallback alongside whatever key is actually bound to action.redo.
      if (matchesBinding(e, getBinding('action.redo')) || (primaryModDown(e) && e.shiftKey && e.code === 'KeyZ')) {
        e.preventDefault();
        redo();
        return;
      }

      if (matchesBinding(e, getBinding('action.resetView'))) {
        e.preventDefault();
        resetView();
        return;
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') state.spaceDown = false;
      releaseToolHold(e.code);
    });

    window.addEventListener('blur', () => {
      state.spaceDown = false;
      state.zoomDrag = null;
      state.panDrag = null;
      canvas.classList.remove('cursorGrabbing');
      cancelToolHold();
    });

    nodeEditorEl?.addEventListener('scroll', () => drawNodeLinks(), { passive: true });
    window.addEventListener('resize', () => drawNodeLinks(), { passive: true });
  }

  function wireCanvas() {
    canvas.addEventListener('pointerdown', (e) => {
      if (e.ctrlKey && state.spaceDown) {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        anchorZoomOrigin();
        state.zoomDrag = { pointerId: e.pointerId, startX: e.clientX, startZoom: state.zoom };
        setHint('ドラッグでズーム（左:縮小 / 右:拡大）');
        return;
      }

      const point = getPointFromEvent(e);

      if (state.tool === 'hand') {
        e.preventDefault();
        canvas.setPointerCapture(e.pointerId);
        canvas.classList.add('cursorGrabbing');
        state.panDrag = {
          pointerId: e.pointerId,
          startX: e.clientX,
          startY: e.clientY,
          startPanX: state.panX,
          startPanY: state.panY,
        };
        setHint('ドラッグして表示位置を移動');
        return;
      }

      if (state.tool === 'eyedropper') {
        sampleColorAt(point);
        return;
      }

      if (state.tool === 'bucket') {
        floodFillAt(point);
        return;
      }

      canvas.setPointerCapture(e.pointerId);
      beginStroke(point, e);
    });

    canvas.addEventListener('pointermove', (e) => {
      if (state.zoomDrag && state.zoomDrag.pointerId === e.pointerId) {
        const dx = e.clientX - state.zoomDrag.startX;
        state.zoom = clamp(state.zoomDrag.startZoom * Math.pow(2, dx / 200), 0.1, 8);
        applyZoom();
        setHint(`ズーム: ${Math.round(state.zoom * 100)}%`);
        return;
      }

      if (state.panDrag && state.panDrag.pointerId === e.pointerId) {
        state.panX = state.panDrag.startPanX + (e.clientX - state.panDrag.startX);
        state.panY = state.panDrag.startPanY + (e.clientY - state.panDrag.startY);
        applyZoom();
        return;
      }

      continueStroke(getPointFromEvent(e), e);
    });

    const endZoomOrStroke = (e) => {
      if (state.zoomDrag && state.zoomDrag.pointerId === e.pointerId) {
        state.zoomDrag = null;
        setHint('ドラッグして描画 / Ctrl+Zで戻す / Ctrl+Yでやり直し');
        return;
      }
      if (state.panDrag && state.panDrag.pointerId === e.pointerId) {
        state.panDrag = null;
        canvas.classList.remove('cursorGrabbing');
        setHint(TOOL_HINTS.hand);
        return;
      }
      endStroke(e);
    };

    canvas.addEventListener('pointerup', endZoomOrStroke);
    canvas.addEventListener('pointercancel', endZoomOrStroke);
    canvas.addEventListener('pointerleave', endZoomOrStroke);

    // Prevent scrolling on touch while drawing
    canvas.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
    canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  }

  function init() {
    state.tool = toolEl.value;
    state.color = colorEl.value;
    state.bgColor = bgColorEl.value;

    state.brushPresets = readBrushPresets();

    // Restore whatever brush settings were last live (auto-saved on every change below); only
    // on a genuinely first run does this fall back to the HTML's hardcoded slider defaults.
    const savedCurrent = readCurrentBrushSettings();
    if (savedCurrent) {
      state.activeBrushPresetId = savedCurrent.activeBrushPresetId ?? null;
      applyBrushSettings(savedCurrent);
    } else {
      applyBrushSettings({
        size: Number(sizeEl.value),
        sizeMinPercent: sizeMinEl ? Number(sizeMinEl.value) : undefined,
        sizeMaxPercent: sizeMaxEl ? Number(sizeMaxEl.value) : undefined,
        sizePressureEnabled: sizePressureEnabledEl ? sizePressureEnabledEl.checked : undefined,
        blur: blurEl ? Number(blurEl.value) : undefined,
        spacingPct: spacingEl ? Number(spacingEl.value) : undefined,
        opacity: opacityEl ? Number(opacityEl.value) : undefined,
        opacityMinPercent: opacityMinEl ? Number(opacityMinEl.value) : undefined,
        opacityMaxPercent: opacityMaxEl ? Number(opacityMaxEl.value) : undefined,
        opacityPressureEnabled: opacityPressureEnabledEl ? opacityPressureEnabledEl.checked : undefined,
      });
      persistCurrentBrushSettings();
    }

    // Global settings (手ブレ補正・筆圧補正・筆圧ON/OFF) — independent of any brush/preset.
    const savedGlobal = readGlobalSettings();
    state.stabilizerStrength = savedGlobal?.stabilizerStrength ?? (stabilizerEl ? Number(stabilizerEl.value) : 0);
    state.pressureSmoothingStrength =
      savedGlobal?.pressureSmoothingStrength ?? (pressureSmoothingEl ? Number(pressureSmoothingEl.value) : 0);
    state.pressureEnabled = savedGlobal?.pressureEnabled ?? true;
    state.holdThresholdMs =
      savedGlobal?.holdThresholdMs ?? (globalHoldThresholdEl ? Number(globalHoldThresholdEl.value) : 350);
    if (stabilizerEl) stabilizerEl.value = String(state.stabilizerStrength);
    if (stabilizerValueEl) stabilizerValueEl.textContent = String(state.stabilizerStrength);
    if (pressureSmoothingEl) pressureSmoothingEl.value = String(state.pressureSmoothingStrength);
    if (pressureSmoothingValueEl) pressureSmoothingValueEl.textContent = String(state.pressureSmoothingStrength);
    if (pressureEnabledInputEl) pressureEnabledInputEl.checked = state.pressureEnabled;
    if (globalHoldThresholdEl) globalHoldThresholdEl.value = String(state.holdThresholdMs);
    if (globalHoldThresholdValueEl) globalHoldThresholdValueEl.textContent = `${state.holdThresholdMs}ms`;
    if (!savedGlobal) persistGlobalSettings();

    renderBrushPresetList();
    state.shortcuts = readShortcuts();

    const savedSize = readCanvasSize();
    canvas.width = savedSize?.width ?? DEFAULT_CANVAS_WIDTH;
    canvas.height = savedSize?.height ?? DEFAULT_CANVAS_HEIGHT;
    configureContext();
    applyCanvasBackground();

    // restore panel layout
    const layout = readLayout();
    applyPanelLayout(canvasPanelEl, layout?.canvas);
    applyPanelLayout(nodePanelEl, layout?.node);

    layoutCanvasDisplay();

    // init layers
    state.layers = [createLayer('レイヤー1', { x: 60, y: 110 })];
    state.layers[0].out = { kind: 'output' };
    state.activeLayerId = state.layers[0].id;
    recomputeInputs();
    renderNodeGraph();
    compositeToScreen();

    const ro = new ResizeObserver(() => layoutCanvasDisplay());
    ro.observe(canvasPanelEl);

    wireUi();
    wireCanvas();

    initPanelDragging(canvasHandleEl, canvasPanelEl, 'canvas');
    initPanelDragging(nodeHandleEl, nodePanelEl, 'node');
    initPanelResizing(canvasResizeEl, canvasPanelEl, 'canvas');
    initPanelResizing(nodeResizeEl, nodePanelEl, 'node');
    // The canvas panel's edge handles are intentionally not wired: a single-edge drag can't
    // preserve aspect ratio (it can only change one dimension), so the corner handle above
    // (now uniform-scale) is the sole resize affordance for the canvas panel. The node panel
    // keeps all 5 handles — it has no aspect ratio to preserve.
    initPanelEdgeResizing(nodeResizeTopEl, nodePanelEl, 'node', 'top');
    initPanelEdgeResizing(nodeResizeRightEl, nodePanelEl, 'node', 'right');
    initPanelEdgeResizing(nodeResizeBottomEl, nodePanelEl, 'node', 'bottom');
    initPanelEdgeResizing(nodeResizeLeftEl, nodePanelEl, 'node', 'left');

    // ensure links align with layout
    drawNodeLinks();
  }

  init();
})();
