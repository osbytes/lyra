// Camera for Lyra media takes. Load it into a Chrome tab through the
// extension's javascript_tool (a script tag from a local server, or the whole
// file pasted when a page's CSP blocks that). It adds `window.__cam`: a stage pop-up sized
// to the frame, a drawn cursor, scripted clicks and typing, eased zoom in and
// out, hidden scrollbars, and the screen rectangle that `screencapture -R`
// needs. It changes only the tab it is pasted into and the stage it opens;
// a reload removes it. Usage is in ../SKILL.md.
//
// Zoom is a CSS transform on <body>, which never changes layout, so nothing
// reflows mid-take. Radix portals mount inside <body> and zoom with the page.
// The cursor lives on <html>, outside the transform, so it stays the same size.
function __camInstall() {
  if (window.__cam) return 'camera ready';

  // One curve for every move, so all takes feel the same.
  const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)';
  const body = document.body;
  const state = { s: 1, tx: 0, ty: 0 };
  // The arrow is drawn on a 24-unit grid with its tip at (4, 3), then scaled
  // up to SIZE px so it reads clearly in a 1280x720 frame on a phone.
  const SIZE = 32;
  const HOT_X = (4 * SIZE) / 24;
  const HOT_Y = (3 * SIZE) / 24;
  // 'off': hidden on purpose (stills, hideCursor); a press does not show it.
  // 'on': visible. 'zoom': faded out by a zoom; the next move or press brings it back.
  const pointer = { x: 0, y: 0, mode: 'off' };

  const style = document.createElement('style');
  style.id = '__cam-style';
  style.textContent = `
    html.__cam-on, html.__cam-on * { scrollbar-width: none !important; }
    html.__cam-on ::-webkit-scrollbar { display: none !important; }
    #__cam-cursor { position: fixed; left: 0; top: 0; width: ${SIZE}px; height: ${SIZE}px;
      z-index: 2147483647; pointer-events: none; opacity: 0;
      transition: transform 650ms ${EASE}, opacity 200ms linear; }
    #__cam-cursor svg { transition: transform 120ms ease-out; transform-origin: ${HOT_X}px ${HOT_Y}px; }
    #__cam-cursor.__down svg { transform: scale(0.82); }
    .__cam-ring { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px;
      border-radius: 50%; border: 2px solid rgba(20, 20, 20, 0.35); pointer-events: none;
      z-index: 2147483646; animation: __cam-ring 450ms ease-out forwards; }
    @keyframes __cam-ring { from { transform: scale(0.4); opacity: 1; } to { transform: scale(1.4); opacity: 0; } }
  `;
  document.head.appendChild(style);
  document.documentElement.classList.add('__cam-on');

  // A plain macOS-style arrow: black with a white edge, readable on any surface.
  const cursor = document.createElement('div');
  cursor.id = '__cam-cursor';
  cursor.innerHTML =
    `<svg width="${SIZE}" height="${SIZE}" viewBox="0 0 24 24"><path d="M4 3 L4 19 L8.5 15 L11.5 21.5 L14 20.4 L11 14 L17 14 Z" fill="#111" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  document.documentElement.appendChild(cursor);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // A target is an element, a CSS selector, or `text=Label`: the visible
  // control whose text starts with Label (most app buttons have no stable
  // selector). The last match wins, so a just-opened menu beats the page.
  const CONTROLS = 'button, a, [role=option], [role=menuitem], [role=button], [role=tab], label, input, th, td, [data-sonner-toast]';
  const find = (target) => {
    if (typeof target !== 'string') return target;
    if (!target.startsWith('text=')) return document.querySelector(target);
    const want = target.slice(5).trim().toLowerCase();
    const hits = [...document.querySelectorAll(CONTROLS)].filter(
      (el) => el.getClientRects().length && (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase().startsWith(want),
    );
    return hits[hits.length - 1] ?? null;
  };
  const resolve = (target) => {
    const el = find(target);
    if (!el) throw new Error(`camera: nothing matches ${target}`);
    return el;
  };

  const rectOf = (target) => {
    if (target && typeof target === 'object' && 'x' in target && 'w' in target) return target;
    const r = resolve(target).getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };

  const placeCursor = (x, y) => {
    Object.assign(pointer, { x, y });
    cursor.style.transform = `translate(${x - HOT_X}px, ${y - HOT_Y}px)`;
  };

  const moveCursor = (x, y, ms = 650) => {
    cursor.style.transition = `transform ${ms}ms ${EASE}, opacity 200ms linear`;
    cursor.style.opacity = '1';
    pointer.mode = 'on';
    placeCursor(x, y);
    return wait(ms);
  };

  // Ripple on every real press, including the extension's own clicks. A press
  // after a zoom brings the cursor back; one after hideCursor() does not.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (pointer.mode === 'off') return;
      moveCursor(e.clientX, e.clientY, 0);
      cursor.classList.add('__down');
      const ring = document.createElement('div');
      ring.className = '__cam-ring';
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      document.documentElement.appendChild(ring);
      setTimeout(() => ring.remove(), 500);
    },
    true,
  );
  document.addEventListener('pointerup', () => cursor.classList.remove('__down'), true);

  // A cursor pinned to the screen while the page scales under it looks stuck.
  // During a zoom it fades out while riding along with the point of the page
  // it was over, so it leaves with the content; the next cursor move or press
  // fades it back in from there.
  const applyZoom = (s, tx, ty, ms) => {
    if (pointer.mode === 'on' && ms > 0) {
      const lx = (pointer.x + scrollX - state.tx) / state.s;
      const ly = (pointer.y + scrollY - state.ty) / state.s;
      cursor.style.transition = `transform ${ms}ms ${EASE}, opacity ${Math.min(250, ms)}ms linear`;
      cursor.style.opacity = '0';
      pointer.mode = 'zoom';
      placeCursor(tx + s * lx - scrollX, ty + s * ly - scrollY);
    }
    Object.assign(state, { s, tx, ty });
    body.style.transformOrigin = '0 0';
    body.style.transition = `transform ${ms}ms ${EASE}`;
    body.style.transform = s === 1 && tx === 0 && ty === 0 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    return wait(ms);
  };

  // Keep the zoomed page covering the viewport: never show an empty edge.
  const clamp = (t, scroll, view, s) => Math.min(scroll * (1 - s), Math.max((view + scroll) * (1 - s), t));

  // macOS draws a 1pt border down the window's sides and rounds its bottom
  // corners (about 15pt), and Chrome's toolbar draws a hairline and a 7pt
  // shadow over the top of the page. The viewport gets this much slack on
  // each edge, and the frame is cut from inside it, so none of them shows.
  const SIDE = 2;
  const TOP = 8;
  const BOTTOM = 16;
  const frame = { w: 1280, h: 720 };

  window.__cam = {
    /**
     * Window size to pass to resize_window so the recorded frame is exactly
     * w×h CSS px. Call it again after resizing: Chrome's bars can change height.
     */
    windowFor(w = 1280, h = 720) {
      Object.assign(frame, { w, h });
      return {
        width: w + SIDE * 2 + (outerWidth - innerWidth),
        height: h + TOP + BOTTOM + (outerHeight - innerHeight),
      };
    },
    /** The frame, the viewport around it, and pixel density. `ok` must be true before a take. */
    viewport() {
      const ok = innerWidth === frame.w + SIDE * 2 && innerHeight === frame.h + TOP + BOTTOM;
      return { frame: `${frame.w}x${frame.h}`, viewport: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, ok };
    },
    /** `x,y,w,h` in screen points for `screencapture -R`: the frame, or one element plus padding. */
    captureRect(target, pad = 24) {
      const top = screenY + (outerHeight - innerHeight) + TOP;
      const left = screenX + (outerWidth - innerWidth) + SIDE;
      if (!target) return `${left},${top},${frame.w},${frame.h}`;
      const r = rectOf(target);
      const x = Math.max(SIDE, r.x - pad);
      const y = Math.max(TOP, r.y - pad);
      const w = Math.min(SIDE + frame.w - x, r.w + pad * 2);
      const h = Math.min(TOP + frame.h - y, r.h + pad * 2);
      return [left - SIDE + x, top - TOP + y, w, h].map(Math.round).join(',');
    },
    /** Center of an element in viewport CSS px, for the extension's click. */
    centerOf(target) {
      const r = rectOf(target);
      return { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
    },
    /** Glide the drawn cursor to an element (or {x,y}) before clicking it. */
    async cursorTo(target, ms = 650) {
      const p = target && typeof target === 'object' && 'x' in target && !('w' in target) ? target : this.centerOf(target);
      await moveCursor(p.x, p.y, ms);
      return p;
    },
    hideCursor() {
      pointer.mode = 'off';
      cursor.style.opacity = '0';
    },
    /**
     * Ease the camera onto an element. Without a scale it fits the element
     * with `pad` px around it, between 1x and `max`.
     */
    zoomTo(target, { scale, pad = 48, max = 2, ms = 900 } = {}) {
      const r = rectOf(target);
      // Measure in untransformed page coordinates, so zooming from a zoom works.
      const lx = (r.x + scrollX - state.tx) / state.s;
      const ly = (r.y + scrollY - state.ty) / state.s;
      const lw = r.w / state.s;
      const lh = r.h / state.s;
      const fit = Math.min(frame.w / (lw + pad * 2), frame.h / (lh + pad * 2));
      const s = Math.max(1, Math.min(max, scale ?? fit));
      // Center on the recorded frame, not the slightly larger viewport.
      const tx = clamp(SIDE + frame.w / 2 + scrollX - s * (lx + lw / 2), scrollX, innerWidth, s);
      const ty = clamp(TOP + frame.h / 2 + scrollY - s * (ly + lh / 2), scrollY, innerHeight, s);
      return applyZoom(s, tx, ty, ms).then(() => ({ scale: Number(s.toFixed(2)) }));
    },
    /** Ease back to the full frame. */
    zoomOut(ms = 900) {
      return applyZoom(1, 0, 0, ms);
    },
    /** Click like a person: pointer and mouse events at the element's center, then click. */
    async click(target) {
      const el = resolve(target);
      const p = await this.cursorTo(el);
      const at = { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0 };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...at, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mousedown', at));
      await wait(90);
      el.dispatchEvent(new PointerEvent('pointerup', { ...at, pointerType: 'mouse', isPrimary: true }));
      el.dispatchEvent(new MouseEvent('mouseup', at));
      el.click();
    },
    /** Type into an input one character at a time, in a way React state sees. */
    async type(target, text, perChar = 55) {
      const el = target ? resolve(target) : document.activeElement;
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setValue = Object.getOwnPropertyDescriptor(proto, 'value').set;
      for (const ch of text) {
        setValue.call(el, el.value + ch);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        await wait(perChar);
      }
    },
    /** Press a key (Enter, Escape, ArrowDown) on the focused element. */
    key(name) {
      const el = document.activeElement ?? document.body;
      const at = { key: name, code: name, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', at));
      el.dispatchEvent(new KeyboardEvent('keyup', at));
    },
    /** The element a target names, for reading the page while planning a shot. */
    find(target) {
      return find(target);
    },
    /**
     * Run a whole take inside the page and return at once. The extension
     * draws a "Claude is working" border over the tab while any of its calls
     * runs, and the page cannot hide it, so no extension call may be running
     * while screencapture records. Start this, then start the recording.
     *
     * Steps: { wait: ms } { cursor: target } { click: target }
     * { type: [target or null for the focused field, text] } { key: 'Enter' }
     * { zoom: target, ...zoomTo options } { zoomOut: true } { hideCursor: true }
     * `__cam.scene` reports { running, step, error } for checking afterwards.
     */
    play(steps, { delay = 1500 } = {}) {
      const scene = (this.scene = { running: true, step: 0, error: null });
      (async () => {
        await wait(delay);
        for (const s of steps) {
          if (s.wait) await wait(s.wait);
          else if (s.cursor) await this.cursorTo(s.cursor);
          else if (s.click) await this.click(s.click);
          else if (s.type) await this.type(...s.type);
          else if (s.key) this.key(s.key);
          else if (s.zoom) await this.zoomTo(s.zoom, s);
          else if (s.zoomOut) await this.zoomOut();
          else if (s.hideCursor) this.hideCursor();
          scene.step += 1;
        }
      })()
        .catch((err) => (scene.error = String(err)))
        .finally(() => (scene.running = false));
      return `playing ${steps.length} steps after ${delay} ms`;
    },
    /**
     * Open the page in its own pop-up window, sized to the frame, and install
     * the camera there. Record and drive that window, not this tab: the
     * extension paints a "Claude is working" border over every tab in its
     * group while Claude works, and a pop-up is outside the group. Same-origin
     * only. Returns the stage's viewport; use `__cam.stage.__cam` afterwards.
     */
    async openStage(url = location.href, w = frame.w, h = frame.h) {
      const stage = window.open(url, 'lyra-stage', `popup,width=${w + SIDE * 2},height=${h + TOP + BOTTOM},left=0,top=0`);
      if (!stage) throw new Error('camera: the pop-up was blocked; allow pop-ups for this site');
      for (let i = 0; i < 100; i += 1) {
        await wait(100);
        if (stage.location.href !== 'about:blank' && stage.document.readyState === 'complete') break;
      }
      stage.eval(window.__camSource);
      const size = stage.__cam.windowFor(w, h);
      stage.resizeTo(size.width, size.height);
      await wait(400);
      this.stage = stage;
      return stage.__cam.viewport();
    },
    /**
     * Chrome blocks a pop-up that no click opened, and javascript_tool is not
     * a click. This arms the next click on the page to open the stage: call
     * it, then left_click anywhere with the extension, then read
     * `__cam.stageResult` (the stage's viewport, or the error).
     */
    armStage(url = location.href, w = frame.w, h = frame.h) {
      this.stageResult = null;
      document.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.openStage(url, w, h).then(
            (v) => (this.stageResult = v),
            (err) => (this.stageResult = String(err)),
          );
        },
        { capture: true, once: true },
      );
      return 'armed: click the page once to open the stage';
    },
    /** Install the camera again in the stage after a full page load (client routing keeps it). */
    reinstallStage() {
      if (!this.stage.__cam) this.stage.eval(window.__camSource);
      return this.stage.__cam.viewport();
    },
    /** Hide anything that is not part of the shot (dev badges, a stray toast). */
    hide(...selectors) {
      selectors.forEach((sel) => document.querySelectorAll(sel).forEach((el) => (el.style.visibility = 'hidden')));
    },
    /** Remove everything the camera added. */
    off() {
      body.style.transform = '';
      body.style.transition = '';
      cursor.remove();
      style.remove();
      document.documentElement.classList.remove('__cam-on');
      delete window.__cam;
    },
  };
  return 'camera ready';
}
// Kept as text so openStage() can install the same camera in the stage window.
window.__camSource = `(${__camInstall.toString()})()`;
__camInstall();
