import type { FollowUpAttachmentKind } from './types'

export const FRAME_CONTEXT_MESSAGE_TYPE = '__rautml_context_attach'
export const FRAME_CONTEXT_REMOVE_TYPE = '__rautml_context_remove'
export const FRAME_CONTEXT_DOM_EVENT = '__rautml_context_dom_attach'
export const FRAME_CONTEXT_MARKS_TYPE = '__rautml_context_marks'
export const FRAME_CONTEXT_OPEN_TYPE = '__rautml_context_open'
export const FRAME_CONTEXT_OPEN_DOM_EVENT = '__rautml_context_dom_open'

export interface FrameContextPayload {
  type: typeof FRAME_CONTEXT_MESSAGE_TYPE
  id: string
  kind: FollowUpAttachmentKind
  preview: string
  content: string
}

/** A selection that was already sent to a follow-up, re-rendered as an in-frame mark. */
export interface QuestionedMark {
  id: string
  kind: FollowUpAttachmentKind
  content: string
}

/** Frame → parent: a mark was clicked, open its spot in the fork thread. */
export interface FrameContextOpenPayload {
  type: typeof FRAME_CONTEXT_OPEN_TYPE
  id: string
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
  [data-rautml-mark] {
    text-decoration-line: underline !important;
    text-decoration-style: dotted !important;
    text-decoration-color: #c96345 !important;
    text-decoration-thickness: 1.5px;
    text-underline-offset: 3px;
    cursor: pointer;
    transition: background-color 160ms ease;
  }
  [data-rautml-mark]:hover { background: rgba(217, 119, 87, .14); }
  .rml-context-note {
    position: absolute;
    z-index: 2147483646;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: 2px solid rgba(255, 250, 247, .92);
    border-radius: 999px;
    color: #fffaf7;
    background: #c96345;
    box-shadow: 0 3px 10px rgba(83, 43, 30, .28);
    cursor: pointer;
    transition: background-color 160ms ease, transform 160ms ease;
  }
  .rml-context-note:hover { background: #b85439; transform: scale(1.08); }
  .rml-context-note svg { width: 12px; height: 12px; }
  @media (prefers-reduced-motion: reduce) {
    .rml-context-action { transition-duration: 0ms; filter: none; }
    [data-rautml-context-selected] { animation: none; }
    .rml-context-note { transition-duration: 0ms; }
  }
</style>
<script data-rautml-context-bridge>(function () {
  if (window.__rautmlContextBridge) return;
  window.__rautmlContextBridge = true;

  var ATTACH = '${FRAME_CONTEXT_MESSAGE_TYPE}';
  var REMOVE = '${FRAME_CONTEXT_REMOVE_TYPE}';
  var DOM_EVENT = '${FRAME_CONTEXT_DOM_EVENT}';
  var MARKS = '${FRAME_CONTEXT_MARKS_TYPE}';
  var OPEN = '${FRAME_CONTEXT_OPEN_TYPE}';
  var OPEN_DOM_EVENT = '${FRAME_CONTEXT_OPEN_DOM_EVENT}';
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
    // Captured without our own injected marks, so a re-questioned diagram still
    // matches its persisted content on later loads.
    var html = cleanOuterHtml(el).slice(0, 10000);
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

  /* ---- persistent marks: dotted underlines + diagram note badges -------- */
  /* The parent posts { type: MARKS, marks } with every selection that was    */
  /* already sent to a follow-up. Text marks become dotted underlines, and    */
  /* diagram marks a corner note icon; clicking either asks the parent to     */
  /* open that exact spot in the fork thread.                                 */

  var lastMarks = [];
  var badgeCleanups = [];
  var retryTimers = [];

  function sendOpen(id) {
    if (!id) return;
    try { window.parent.postMessage({ type: OPEN, id: id }, '*'); } catch (e) {}
    try {
      if (window.frameElement) {
        window.frameElement.dispatchEvent(
          new CustomEvent(OPEN_DOM_EVENT, { detail: { type: OPEN, id: id }, bubbles: true })
        );
      }
    } catch (e) {}
  }

  function unwrapSpan(span) {
    var parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }

  function cleanOuterHtml(el) {
    var clone = el.cloneNode(true);
    var badges = clone.querySelectorAll('.rml-context-note');
    for (var i = 0; i < badges.length; i += 1) {
      if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]);
    }
    var spans = clone.querySelectorAll('[data-rautml-mark]');
    for (var j = 0; j < spans.length; j += 1) unwrapSpan(spans[j]);
    clone.removeAttribute('data-rautml-context-selected');
    return String(clone.outerHTML || '');
  }

  function clearMarks() {
    for (var t = 0; t < retryTimers.length; t += 1) window.clearTimeout(retryTimers[t]);
    retryTimers = [];
    for (var c = 0; c < badgeCleanups.length; c += 1) {
      try { badgeCleanups[c](); } catch (e) {}
    }
    badgeCleanups = [];
    var badges = document.querySelectorAll('.rml-context-note');
    for (var i = 0; i < badges.length; i += 1) {
      if (badges[i].parentNode) badges[i].parentNode.removeChild(badges[i]);
    }
    var spans = document.querySelectorAll('[data-rautml-mark]');
    for (var j = 0; j < spans.length; j += 1) unwrapSpan(spans[j]);
  }

  function collectTextNodes() {
    var nodes = [];
    if (!document.body) return nodes;
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (!node.nodeValue) continue;
      var parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest('script,style,noscript,.rml-context-action,.rml-context-note')) continue;
      nodes.push(node);
    }
    return nodes;
  }

  function wrapTextRange(range, mark) {
    var sc = range.startContainer;
    if (sc.nodeType === 3 && range.startOffset > 0) {
      var tail = sc.splitText(range.startOffset);
      if (range.endContainer === sc) range.setEnd(tail, range.endOffset - range.startOffset);
      range.setStart(tail, 0);
    }
    var ec = range.endContainer;
    if (ec.nodeType === 3 && range.endOffset < ec.nodeValue.length) ec.splitText(range.endOffset);
    var targets = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    while (walker.nextNode()) {
      var node = walker.currentNode;
      if (!node.nodeValue || !node.nodeValue.trim()) continue;
      var inside = false;
      try {
        inside = range.intersectsNode(node) &&
          range.comparePoint(node, 0) === 0 &&
          range.comparePoint(node, node.nodeValue.length) === 0;
      } catch (e) { inside = false; }
      if (!inside) continue;
      var parent = node.parentElement;
      /* an HTML span inside SVG text would break rendering — badges cover those */
      if (!parent || parent.closest('script,style,noscript,svg,.rml-context-action,.rml-context-note')) continue;
      targets.push(node);
    }
    for (var i = 0; i < targets.length; i += 1) {
      var holder = targets[i].parentNode;
      if (!holder) continue;
      var span = document.createElement('span');
      span.setAttribute('data-rautml-mark', mark.id);
      span.setAttribute('title', 'Asked in a follow-up — click to open that thread');
      holder.insertBefore(span, targets[i]);
      span.appendChild(targets[i]);
    }
    return targets.length > 0;
  }

  function markText(mark) {
    if (document.querySelector('[data-rautml-mark="' + mark.id + '"]')) return true;
    var tokens = String(mark.content || '').trim().split(/\s+/);
    var pieces = [];
    for (var i = 0; i < tokens.length; i += 1) {
      if (tokens[i]) pieces.push(tokens[i].replace(/[.*+?^{}()|[\]\\$]/g, '\\$&'));
    }
    if (!pieces.length) return true;
    var nodes = collectTextNodes();
    var full = '';
    var starts = [];
    for (var n = 0; n < nodes.length; n += 1) {
      starts.push(full.length);
      full += nodes[n].nodeValue;
    }
    var match = null;
    try { match = new RegExp(pieces.join('\\s*')).exec(full); } catch (e) { match = null; }
    if (!match) return false;
    var startPos = match.index;
    var endPos = match.index + match[0].length;
    var range = document.createRange();
    var startSet = false;
    var endSet = false;
    for (var k = 0; k < nodes.length; k += 1) {
      var from = starts[k];
      var to = from + nodes[k].nodeValue.length;
      if (!startSet && startPos >= from && startPos < to) {
        range.setStart(nodes[k], startPos - from);
        startSet = true;
      }
      if (startSet && endPos > from && endPos <= to) {
        range.setEnd(nodes[k], endPos - from);
        endSet = true;
        break;
      }
    }
    if (!startSet || !endSet || range.collapsed) return false;
    return wrapTextRange(range, mark);
  }

  function attachBadge(el, mark) {
    var badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'rml-context-note';
    badge.setAttribute('data-rautml-mark-badge', mark.id);
    badge.setAttribute('aria-label', 'This diagram was asked about in a follow-up — open that thread');
    badge.title = 'Asked in a follow-up — click to open that thread';
    badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>';
    document.body.appendChild(badge);
    var reposition = function () {
      if (!el.isConnected) {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
        return;
      }
      var rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) { badge.style.display = 'none'; return; }
      badge.style.display = '';
      var maxLeft = (window.pageXOffset || 0) + document.documentElement.clientWidth - 28;
      badge.style.left = Math.round(Math.min(maxLeft, Math.max(2, rect.right + (window.pageXOffset || 0) - 17))) + 'px';
      badge.style.top = Math.round(Math.max(2, rect.top + (window.pageYOffset || 0) - 7)) + 'px';
    };
    reposition();
    var observer = null;
    if (window.ResizeObserver) {
      observer = new ResizeObserver(reposition);
      observer.observe(el);
      if (document.body) observer.observe(document.body);
    }
    window.addEventListener('resize', reposition);
    var tick = window.setInterval(reposition, 1400);
    badgeCleanups.push(function () {
      if (observer) observer.disconnect();
      window.removeEventListener('resize', reposition);
      window.clearInterval(tick);
    });
  }

  function markDiagram(mark) {
    if (document.querySelector('[data-rautml-mark-badge="' + mark.id + '"]')) return true;
    var prefix = String(mark.content || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!prefix || !document.body) return true;
    var shortPrefix = prefix.slice(0, 100);
    var all = document.body.getElementsByTagName('*');
    var best = null;
    for (var i = 0; i < all.length; i += 1) {
      var el = all[i];
      if (!isDiagramElement(el)) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 96 || rect.height < 64) continue;
      var html = cleanOuterHtml(el).replace(/\s+/g, ' ').trim().slice(0, 200);
      if (html === prefix) { best = el; break; }
      if (!best && html.slice(0, 100) === shortPrefix) best = el;
    }
    if (!best) return false;
    attachBadge(best, mark);
    return true;
  }

  function applyMarks() {
    if (!document.body) return false;
    var missing = false;
    for (var i = 0; i < lastMarks.length; i += 1) {
      var mark = lastMarks[i];
      var ok = mark.kind === 'diagram' ? markDiagram(mark) : markText(mark);
      if (!ok) missing = true;
    }
    return missing;
  }

  function setMarks(list) {
    lastMarks = [];
    for (var i = 0; i < list.length && lastMarks.length < 64; i += 1) {
      var item = list[i];
      if (!item || typeof item.id !== 'string' || typeof item.content !== 'string') continue;
      lastMarks.push({
        /* ids also travel through attribute selectors — keep them quote-free */
        id: item.id.replace(/["'\\]/g, '').slice(0, 120),
        kind: item.kind === 'diagram' ? 'diagram' : 'text',
        content: item.content
      });
    }
    /* Diagrams first: text spans mutate outerHTML and would skew diagram matching. */
    lastMarks.sort(function (a, b) {
      return a.kind === b.kind ? 0 : a.kind === 'diagram' ? -1 : 1;
    });
    clearMarks();
    var missing = applyMarks();
    /* Charts and generated content often render async — retry the strays. */
    if (missing) {
      var delays = [700, 2200, 4500];
      for (var d = 0; d < delays.length; d += 1) {
        retryTimers.push(window.setTimeout(applyMarks, delays[d]));
      }
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.nodeType === 1
      ? event.target
      : event.target && event.target.parentElement;
    if (!target || !target.closest) return;
    var marked = target.closest('[data-rautml-mark], [data-rautml-mark-badge]');
    if (!marked) return;
    event.preventDefault();
    event.stopPropagation();
    sendOpen(marked.getAttribute('data-rautml-mark-badge') || marked.getAttribute('data-rautml-mark') || '');
  }, true);

  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.type !== MARKS || !Array.isArray(data.marks)) return;
    setMarks(data.marks);
  });

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

export function isFrameContextOpenPayload(data: unknown): data is FrameContextOpenPayload {
  if (!data || typeof data !== 'object') return false
  const value = data as Partial<FrameContextOpenPayload>
  return (
    value.type === FRAME_CONTEXT_OPEN_TYPE && typeof value.id === 'string' && value.id.length <= 120
  )
}

/** Parent → frame: render dotted underlines / note badges for questioned selections. */
export function postFrameMarks(frame: HTMLIFrameElement, marks: QuestionedMark[]): void {
  try {
    frame.contentWindow?.postMessage({ type: FRAME_CONTEXT_MARKS_TYPE, marks }, '*')
  } catch {
    /* a frame that is mid-teardown simply misses this round of marks */
  }
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
