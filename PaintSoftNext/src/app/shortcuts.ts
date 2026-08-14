export type ShortcutAction =
  | 'brush'
  | 'eraser'
  | 'bucket'
  | 'eyedropper'
  | 'selectRect'
  | 'selectLasso'
  | 'transform'
  | 'selectAll'
  | 'deselect'
  | 'invertSelection'
  | 'clearSelection'
  | 'undo'
  | 'redo'
  | 'resetView'
  | 'pan';

export interface ShortcutBinding {
  /** A KeyboardEvent.code, e.g. 'KeyB', 'Space', 'Digit0'. */
  code: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  brush: 'ブラシに切り替え',
  eraser: '消しゴムに切り替え',
  bucket: 'バケツに切り替え',
  eyedropper: 'スポイトに切り替え',
  selectRect: '長方形選択に切り替え',
  selectLasso: 'なげなわ選択に切り替え',
  transform: '変形に切り替え',
  selectAll: 'すべて選択',
  deselect: '選択を解除',
  invertSelection: '選択範囲を反転',
  clearSelection: '選択範囲を消去',
  undo: '元に戻す',
  redo: 'やり直し',
  resetView: '表示位置を初期化',
  pan: '一時的に表示位置を移動（押している間）',
};

export const DEFAULT_SHORTCUTS: Record<ShortcutAction, ShortcutBinding> = {
  brush: bind('KeyB'),
  eraser: bind('KeyE'),
  bucket: bind('KeyG'),
  eyedropper: bind('KeyI'),
  selectRect: bind('KeyM'),
  selectLasso: bind('KeyL'),
  transform: bind('KeyT'),
  selectAll: bind('KeyA', { ctrl: true }),
  deselect: bind('KeyD', { ctrl: true }),
  invertSelection: bind('KeyI', { ctrl: true, shift: true }),
  clearSelection: bind('Delete'),
  undo: bind('KeyZ', { ctrl: true }),
  redo: bind('KeyY', { ctrl: true }),
  resetView: bind('Digit0', { ctrl: true }),
  pan: bind('Space'),
};

export const SHORTCUT_ACTIONS = Object.keys(DEFAULT_SHORTCUTS) as ShortcutAction[];

function bind(code: string, modifiers: Partial<Omit<ShortcutBinding, 'code'>> = {}): ShortcutBinding {
  return { code, ctrl: false, shift: false, alt: false, ...modifiers };
}

const STORAGE_KEY = 'paintsoft.v2.shortcuts';

export function loadShortcuts(): Record<ShortcutAction, ShortcutBinding> {
  const result = { ...DEFAULT_SHORTCUTS };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return result;

    const stored = JSON.parse(raw) as Partial<Record<ShortcutAction, ShortcutBinding>>;
    for (const action of SHORTCUT_ACTIONS) {
      const binding = stored[action];
      // Merged onto the defaults per action, so a binding added in a later build still has
      // a key after loading settings saved by an earlier one.
      if (binding && typeof binding.code === 'string') {
        result[action] = {
          code: binding.code,
          ctrl: binding.ctrl === true,
          shift: binding.shift === true,
          alt: binding.alt === true,
        };
      }
    }
  } catch {
    // Corrupt or unavailable storage just means defaults.
  }
  return result;
}

export function saveShortcuts(shortcuts: Record<ShortcutAction, ShortcutBinding>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shortcuts));
  } catch {
    // Never let a storage failure interrupt drawing.
  }
}

/**
 * Matches on `code` rather than `key` so a binding stays on the same physical key
 * regardless of keyboard layout or whether Shift is held — 'KeyZ' is 'KeyZ' whether the
 * character produced is 'z' or 'Z'.
 */
export function matchesBinding(binding: ShortcutBinding, event: KeyboardEvent): boolean {
  return (
    event.code === binding.code &&
    (event.ctrlKey || event.metaKey) === binding.ctrl &&
    event.shiftKey === binding.shift &&
    event.altKey === binding.alt
  );
}

export function describeBinding(binding: ShortcutBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.shift) parts.push('Shift');
  if (binding.alt) parts.push('Alt');
  parts.push(describeCode(binding.code));
  return parts.join('+');
}

function describeCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  return code;
}

/** Modifier presses on their own are never a binding — they are what a binding is built from. */
export function isModifierOnly(code: string): boolean {
  return (
    code.startsWith('Control') ||
    code.startsWith('Shift') ||
    code.startsWith('Alt') ||
    code.startsWith('Meta') ||
    code === 'CapsLock'
  );
}

export function bindingFromEvent(event: KeyboardEvent): ShortcutBinding {
  return {
    code: event.code,
    ctrl: event.ctrlKey || event.metaKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };
}

/** Actions bound to the same combination as `action`, so the UI can warn about clashes. */
export function findConflicts(
  shortcuts: Record<ShortcutAction, ShortcutBinding>,
  action: ShortcutAction,
): ShortcutAction[] {
  const target = shortcuts[action];
  return SHORTCUT_ACTIONS.filter(
    (other) =>
      other !== action &&
      shortcuts[other].code === target.code &&
      shortcuts[other].ctrl === target.ctrl &&
      shortcuts[other].shift === target.shift &&
      shortcuts[other].alt === target.alt,
  );
}
