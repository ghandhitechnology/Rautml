import type { FollowUpAttachmentKind } from './types'

export const FRAME_CONTEXT_MESSAGE_TYPE = '__rautml_context_attach'
export const FRAME_CONTEXT_REMOVE_TYPE = '__rautml_context_remove'
export const FRAME_CONTEXT_DOM_EVENT = '__rautml_context_dom_attach'

export interface FrameContextPayload {
  type: typeof FRAME_CONTEXT_MESSAGE_TYPE
  id: string
  kind: FollowUpAttachmentKind
  preview: string
  content: string
}

const CONTEXT_BRIDGE = String.raw`
<style data-rautml-context-style>
  .rml-context-action {
    position: fixed;
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 7px;
    max-width: calc(100vw - 24px);
    padding: 8px 11px;
    border: 0;
    border-radius: 10px;
    color: #fffaf7;
    background: #c96345;
    box-shadow: 0 8px 24px rgba(83, 43, 30, .22), 0 2px 7px rgba(83, 43, 30, .16);
    font: 600 12px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    letter-spacing: -.01em;
    cursor: pointer;
    opacity: 0;
    visibility: hidden;
    transform: translateY(7px) scale(.94);
    filter: blur(3px);
    transition:
      opacity 180ms cubic-bezier(.22, 1, .36, 1),
      transform 240ms cubic-bezier(.22, 1, .36, 1),
      filter 180ms cubic-bezier(.22, 1, .36, 1),
      background-color 160ms ease;
  }
  .rml-context-action::before {
    content: "";
    width: 12px;
    height: 12px;
    background: currentColor;
    clip-path: polygon(46% 0, 58% 35%, 100% 48%, 62% 61%, 50% 100%, 38% 62%, 0 50%, 35% 38%);
    opacity: .92;
  }
  .rml-context-action:hover { background: #b85439; }
  .rml-context-action:focus-visible { outline: 3px solid rgba(201, 99, 69, .28); outline-offset: 3px; }
  .rml-context-action.is-visible {
    opacity: 1;
    visibility: visible;
    transform: translateY(0) scale(1);
    filter: blur(0);
  }
  .rml-context-action.is-confirmation { pointer-events: none; }
  [data-rautml-context-selected] {
    outline: 2px solid #d97757 !important;
    outline-offset: 5px !important;
    animation: rml-context-settle 460ms cubic-bezier(.16, 1, .3, 1) both;
  }
  @keyframes rml-context-settle {
    0% { outline-color: rgba(217, 119, 87, 0); outline-offset: 11px; }
    56% { outline-color: rgba(217, 119, 87, 1); outline-offset: 3px; }
    100% { outline-color: rgba(217, 119, 87, 1); outline-offset: 5px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .rml-context-action { transition-duration: 0ms; filter: none; }
    [data-rautml-context-selected] { animation: none; }
  }
</style>
<script data-rautml-context-bridge>(function () {
  if (window.__rautmlContextBridge) return;
  window.__rautmlContextBridge = true;

  var ATTACH = '${FRAME_CONTEXT_MESSAGE_TYPE}';
  var REMOVE = '${FRAME_CONTEXT_REMOVE_TYPE}';
  var DOM_EVENT = '${FRAME_CONTEXT_DOM_EVENT}';
  var action = document.createElement('button');
  var pendingText = '';
  var hideTimer = 0;
  action.type = 'button';
  action.className = 'rml-context-action';
  action.textContent = 'Ask follow-up';
  action.setAttribute('aria-label', 'Attach selected text to a follow-up question');

  function mount() {
    if (!action.isConnected && document.body) document.body.appendChild(action);
  }

  function token() {
    try { return 'ctx-' + crypto.randomUUID(); }
    catch (e) { return 'ctx-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2); }
  }

  function clean(value, max) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  }

  function hideAction() {
    window.clearTimeout(hideTimer);
    action.classList.remove('is-visible', 'is-confirmation');
    pendingText = '';
  }

  function placeAction(rect) {
    mount();
    var width = action.offsetWidth || 112;
    var x = Math.min(Math.max(12, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 12);
    var y = rect.top - 44;
    if (y < 10) y = Math.min(window.innerHeight - 42, rect.bottom + 9);
    action.style.left = Math.round(x) + 'px';
    action.style.top = Math.round(y) + 'px';
    action.classList.add('is-visible');
  }

  function showTextAction() {
    var selection = window.getSelection && window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return hideAction();
    var text = String(selection.toString() || '').trim().slice(0, 10000);
    if (!clean(text, 10000) || text.length < 2) return hideAction();
    var range = selection.getRangeAt(0);
    var host = range.commonAncestorContainer.nodeType === 1
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
    if (!host || host.closest('.rml-context-action, input, textarea, [contenteditable="true"]')) return hideAction();
    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return hideAction();
    pendingText = text;
    action.textContent = 'Ask follow-up';
    action.setAttribute('aria-label', 'Attach selected text to a follow-up question');
    placeAction(rect);
  }

  function send(payload) {
    try { window.parent.postMessage(payload, '*'); } catch (e) {}
    try {
      if (window.frameElement) {
        window.frameElement.dispatchEvent(new CustomEvent(DOM_EVENT, { detail: payload, bubbles: true }));
      }
    } catch (e) {}
  }

  action.addEventListener('pointerdown', function (event) { event.preventDefault(); });
  action.addEventListener('click', function () {
    if (!pendingText) return;
    var text = pendingText;
    send({ type: ATTACH, id: token(), kind: 'text', preview: clean(text, 180), content: text });
    action.textContent = 'Added to follow-up';
    action.setAttribute('aria-label', 'Selected text added to follow-up');
    action.classList.add('is-confirmation');
    pendingText = '';
    hideTimer = window.setTimeout(hideAction, 850);
  });

  function isDiagramElement(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'figure' || tag === 'canvas') return true;
    if (tag === 'svg') return true;
    if (el.getAttribute && (el.getAttribute('role') === 'img' || el.hasAttribute('data-diagram'))) return true;
    var signature = ((el.id || '') + ' ' + (typeof el.className === 'string' ? el.className : '')).toLowerCase();
    return /(^|[\s_-])(diagram|chart|graph|plot|flowchart|mermaid|visualization)([\s_-]|$)/.test(signature);
  }

  function diagramFrom(target) {
    var el = target && target.nodeType === 1 ? target : target && target.parentElement;
    var fallback = null;
    for (var depth = 0; el && depth < 8; depth += 1, el = el.parentElement) {
      if (!isDiagramElement(el)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 96 || rect.height < 64) continue;
      fallback = el;
      if (String(el.tagName || '').toLowerCase() === 'figure' || el.hasAttribute('data-diagram')) return el;
    }
    return fallback;
  }

  function diagramPreview(el) {
    var labelled = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    var caption = el.querySelector && el.querySelector('figcaption, [data-title], .title, h1, h2, h3');
    var text = clean(labelled || (caption && caption.textContent) || el.textContent, 180);
    return text || 'Selected diagram';
  }

  document.addEventListener('dblclick', function (event) {
    var el = diagramFrom(event.target);
    if (!el) return;
    event.preventDefault();
    var id = el.getAttribute('data-rautml-context-selected') || token();
    var html = String(el.outerHTML || '').slice(0, 10000);
    el.setAttribute('data-rautml-context-selected', id);
    send({
      type: ATTACH,
      id: id,
      kind: 'diagram',
      preview: diagramPreview(el),
      content: html
    });
    action.textContent = 'Added to follow-up';
    action.setAttribute('aria-label', 'Diagram added to follow-up');
    action.classList.add('is-confirmation');
    placeAction(el.getBoundingClientRect());
    hideTimer = window.setTimeout(hideAction, 1000);
  }, true);

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== REMOVE || typeof data.id !== 'string') return;
    var selected = document.querySelectorAll('[data-rautml-context-selected]');
    for (var i = 0; i < selected.length; i += 1) {
      if (selected[i].getAttribute('data-rautml-context-selected') === data.id) {
        selected[i].removeAttribute('data-rautml-context-selected');
      }
    }
  });

  document.addEventListener('mouseup', function (event) {
    if (event.target === action) return;
    window.setTimeout(showTextAction, 0);
  }, true);
  document.addEventListener('keyup', function (event) {
    if (event.key === 'Shift' || event.shiftKey) window.setTimeout(showTextAction, 0);
  }, true);
  document.addEventListener('pointerdown', function (event) {
    if (event.target !== action && !action.contains(event.target)) hideAction();
  }, true);
  window.addEventListener('scroll', hideAction, true);
  window.addEventListener('resize', hideAction);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();</script>
`

/** Inject the in-frame selection affordance without mutating the persisted asset HTML. */
export function injectFollowUpContext(html: string): string {
  if (html.includes('data-rautml-context-bridge')) return html
  const index = html.toLowerCase().lastIndexOf('</body>')
  if (index === -1) return html + CONTEXT_BRIDGE
  return html.slice(0, index) + CONTEXT_BRIDGE + html.slice(index)
}

export function isFrameContextPayload(data: unknown): data is FrameContextPayload {
  if (!data || typeof data !== 'object') return false
  const value = data as Partial<FrameContextPayload>
  return (
    value.type === FRAME_CONTEXT_MESSAGE_TYPE &&
    typeof value.id === 'string' &&
    value.id.length <= 120 &&
    (value.kind === 'text' || value.kind === 'diagram') &&
    typeof value.preview === 'string' &&
    typeof value.content === 'string'
  )
}

/** Remove the corresponding coral frame from whichever live asset owns it. */
export function removeFrameContext(id: string): void {
  if (typeof document === 'undefined') return
  const message = { type: FRAME_CONTEXT_REMOVE_TYPE, id }
  document.querySelectorAll('iframe').forEach((frame) => {
    try {
      frame.contentWindow?.postMessage(message, '*')
    } catch {
      /* a non-Rautml or cross-origin frame simply ignores the control message */
    }
  })
}
