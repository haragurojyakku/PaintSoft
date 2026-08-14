import { PaintApp } from './app/PaintApp';
import { installClipBridge } from './io/clipBridge';

const canvas = document.getElementById('stage');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('Missing #stage canvas');
}

try {
  const app = new PaintApp(canvas, 2048, 1536);
  installClipBridge(app);
  if (import.meta.env.DEV) {
    // Handle for pixel-level checks from the devtools console: the renderer's output is
    // far easier to assert on directly than through a screenshot.
    Reflect.set(window, 'paintApp', app);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const notice = document.createElement('div');
  notice.style.cssText = 'padding:24px;font:14px system-ui;color:#e6e6ea;line-height:1.7';
  notice.textContent = `PaintSoft を起動できませんでした: ${message}`;
  document.body.replaceChildren(notice);
  throw error;
}
