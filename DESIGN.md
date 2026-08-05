---
name: Rautml
description: Research-driven chat where the answer is a web page — a warm atelier with glass chrome over living documents.
colors:
  terracotta-coral: "#d97757"
  coral-kiln: "#c96442"
  coral-wash: "#f5e5dd"
  ivory: "#faf9f5"
  paper: "#ffffff"
  linen: "#f0eee6"
  ink: "#1f1e1d"
  ink-muted: "#73726c"
  hairline: "#e8e6dc"
typography:
  display:
    fontFamily: "Lora, Georgia, 'Times New Roman', serif"
    fontSize: "clamp(26px, 3.6vw, 36px)"
    fontWeight: 500
    lineHeight: 1.32
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Lora, Georgia, 'Times New Roman', serif"
    fontSize: "24px"
    fontWeight: 500
    lineHeight: 1.32
    letterSpacing: "-0.018em"
  title:
    fontFamily: "Lora, Georgia, 'Times New Roman', serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.32
    letterSpacing: "-0.014em"
  body:
    fontFamily: "'Pretendard Variable', Pretendard, -apple-system, sans-serif"
    fontSize: "14.5px"
    fontWeight: 400
    lineHeight: 1.68
  label:
    fontFamily: "'Pretendard Variable', Pretendard, -apple-system, sans-serif"
    fontSize: "11.5px"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0.01em"
rounded:
  sm: "8px"
  md: "12px"
  lg: "16px"
  pill: "999px"
spacing:
  sp-1: "4px"
  sp-2: "8px"
  sp-3: "12px"
  sp-4: "16px"
  sp-5: "20px"
  sp-6: "24px"
  sp-8: "32px"
  sp-10: "40px"
  sp-12: "48px"
components:
  button-send:
    backgroundColor: "{colors.terracotta-coral}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    size: "32px"
  button-send-hover:
    backgroundColor: "{colors.coral-kiln}"
  button-new-chat:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "9px 12px"
  chip-model:
    backgroundColor: "{colors.linen}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    height: "28px"
  input-composer:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "12px 12px 12px 16px"
  card-asset:
    backgroundColor: "{colors.paper}"
    rounded: "{rounded.lg}"
  pill-version-active:
    backgroundColor: "{colors.terracotta-coral}"
    textColor: "#ffffff"
    rounded: "{rounded.pill}"
    height: "22px"
  bubble-user:
    backgroundColor: "{colors.coral-wash}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "11px 16px 12px"
---

# Design System: Rautml

## Overview

**Creative North Star: "The Warm Atelier"**

Rautml is a craftsman's studio, not a chat app. Research happens in open view — you watch the agent search, read, and build on the workbench — and the finished artifact takes the whole room. The interface is calm, literary, and editorial: warm ivory in daylight, deep charcoal after dark, one Terracotta Coral flame marking wherever the maker's hand is at work. Everything the system owns (sidebar, composer, chrome) recedes so everything the model makes (documents, pages, versions) can lead.

The aesthetic philosophy is restraint with craft in the details. Surfaces rest nearly flat; type does the composing; the serif appears only when the product speaks with its own voice. When a document takes over, the shell dissolves into glass — translucent, blurred, floating — because at that moment the page is the room and our chrome is just light on its surface. The confirmed anti-reference is the generic AI-chat aesthetic: no purple gradients, no sparkle icons, no bubble-heavy chat styling.

**Key Characteristics:**
- Warm two-theme world: ivory calm (light) and charcoal (dark), switched via `[data-theme]`
- One accent hue, Terracotta Coral (#d97757), used sparingly and meaningfully
- Lora serif for identity moments; Pretendard Variable for all UI mechanics (flawless Korean + Latin)
- Glass chrome (blur + translucency) exclusively over generated documents
- Crafted, confident components: quiet at rest, precise physical response to touch
- 4px spatial rhythm, pill geometry for interactive chrome, soft ambient shadows

## Colors

A warm near-monochrome field where a single coral flame carries all meaning; every other tone is ivory, linen, or ink.

### Primary
- **Terracotta Coral** (#d97757): the only hue in the interface. Marks the maker's hand: send button, live-run pulses, active version segment, brand mark, focus rings, streaming caret. Identical in both themes.
- **Coral Kiln** (#c96442): the fired, deeper coral for hover states on accent elements and error-adjacent text. In dark theme, hover brightens instead (#e08b6f) so the accent lifts off charcoal.
- **Coral Wash** (#f5e5dd): the tinted whisper of the accent — user message bubbles, selected options, armed states, `::selection`. Dark equivalent is #453733. The accent almost always arrives as wash first, full coral second.

### Neutral
- **Ivory** (#faf9f5): the app canvas (`--bg`). Dark: #262624 charcoal.
- **Paper** (#ffffff): raised surfaces — composer, cards, popovers, active chat row (`--surface`). Dark: #30302e.
- **Linen** (#f0eee6): recessed surfaces — sidebar, model chip, disabled fills (`--surface-2`). Dark: #3a3a37.
- **Ink** (#1f1e1d): primary text. Dark: #f5f4ee warm off-white.
- **Ink Muted** (#73726c): secondary text, timestamps, placeholders, resting icons. Dark: #a8a69e.
- **Hairline** (#e8e6dc): 1px borders and dividers everywhere. Dark: #3f3e3a.

### Named Rules
**The One Flame Rule.** Terracotta Coral is the interface's only hue. If a second color appears on screen, it came from a generated document — never from the shell. State (hover, pressed, live, error) is expressed through coral intensity and neutral alpha tints, not new colors.

**The Wash-First Rule.** The accent escalates: Coral Wash for ambient presence (selection, bubbles), full Terracotta Coral for the moment of action or life (send, live pip, active segment), Coral Kiln for pressure. Full-coral fills stay small — dots, 32px buttons, 2.5px rails — never large fields.

## Typography

**Display Font:** Lora (with Georgia fallback)
**Body Font:** Pretendard Variable (with -apple-system fallback; one file covers Korean + Latin)
**Mono Font:** ui-monospace / SF Mono stack (code in markdown output)

**Character:** A literary serif lends the product its editorial voice — wordmark, welcome, the titles of things — while a neutral, superbly legible sans does all the work. The pairing reads as a well-set book living inside a precise instrument.

### Hierarchy
- **Display** (500, clamp(26px, 3.6vw, 36px), 1.32): welcome screen title only. Tracked -0.02em.
- **Headline** (Lora 500, 24px / 20px for h2, 1.32): h1/h2 inside rendered markdown responses.
- **Title** (Lora 500–600, 14.5–19px, tight): the names of things — brand wordmark (19px), chat title in the top bar (16px), document and asset titles (14.5px, 600). Always tracked negative (-0.012 to -0.018em).
- **Body** (Pretendard 400, 14.5px, 1.68): all conversation and UI prose. Sizes step 13px (`--fs-sm`) for secondary surfaces and the fork panel, 11.5px (`--fs-xs`) for metadata.
- **Label** (600, 11.5px, +0.01em): tooltips, sheet titles, footnotes, kbd hints. The welcome eyebrow is the one uppercase moment: Lora 13px, +0.14em, coral.

### Named Rules
**The Serif Signature Rule.** Lora appears only where the product speaks with identity: the wordmark, titles of chats/documents/assets, welcome and empty states, markdown h1–h2. Every mechanical label, button, and control is Pretendard. A serif button is a system error.

**The Tabular Rule.** `font-variant-numeric: tabular-nums` globally; counts, versions, and durations never jitter as they tick.

## Layout

The shell is a CSS grid of three columns: 260px linen sidebar, fluid main column, and a 380px fork panel that animates open from 0px (grid-template-columns transition, 420ms). Conversation content centers at `--thread-max` 760px. The top bar is 56px with a subtle backdrop blur.

On macOS desktop, the native red/yellow/green traffic lights sit directly in the sidebar's first row using Electron's hidden-inset titlebar. That row is the draggable window surface; controls remain non-draggable, and no extra titlebar or imitation window controls are drawn.

**Document mode inverts the frame:** when a chat has an asset, the main column drops all padding and scrolling — the generated page runs edge-to-edge and owns the viewport, while our chrome floats above it (glass header bar pinned top, glass composer dock pinned bottom, both `position: absolute` with pointer-events ghosting so the page stays interactive).

Spacing follows a strict 4px rhythm (`--sp-1` 4px through `--sp-12` 48px); micro-offsets (1–2px) are allowed only for optical centering. Density is comfortable, never cramped: 8–12px gaps inside components, 16–24px between blocks. Markdown rhythm: 16px between blocks, 32px before headings.

Breakpoints: 1120px (fork narrows to 340px), 860px (sidebar to 216px, tighter padding, fork ball shrinks), 640px (glass bar sheds theme toggle and dividers). Korean text always sets `word-break: keep-all`.

## Elevation & Depth

**Ambient rest, glass on top.** Surfaces sit nearly flat: a 1px hairline border does the separating, and shadows are a whisper (4–10% black in light theme) that confirms a surface is raised rather than creating drama. True elevation is reserved for one thing — chrome floating over a generated document — which earns the glass treatment: `color-mix` translucency (80–86% surface), `saturate(180%) blur(18px)` backdrop, and the large shadow tier. A gradient scrim grounds the glass header so the document's own type never collides with it.

### Shadow Vocabulary
- **shadow-sm** (`0 1px 2px rgba(31,30,29,0.04), 0 1px 3px rgba(31,30,29,0.05)`): resting raised surfaces — composer, cards, active chat row, tooltips.
- **shadow-md** (`0 2px 6px rgba(31,30,29,0.05), 0 8px 24px rgba(31,30,29,0.07)`): hover lift on cards, the glass header bar, the activity strip.
- **shadow-lg** (`0 4px 12px rgba(31,30,29,0.06), 0 18px 48px rgba(31,30,29,0.1)`): floating layers — popovers, menus, toasts, the glass composer dock and sheet.
- **Coral glow** (`0 10px 30px color-mix(in srgb, var(--accent) 32%, transparent)`): the fork ball only — the one object allowed to radiate.

Dark theme deepens all tiers (24–38% black) and gives glass a lit edge (`--glass-border` mixes 9% ivory) because charcoal glass otherwise dissolves into a bright document.

### Named Rules
**The Two Altitudes Rule.** There are exactly two heights: resting (hairline border + whisper shadow) and floating (glass + blur + shadow-lg). Nothing hovers in between; nothing casts a dramatic shadow while sitting still.

## Shapes

Two form languages, split by role. **Surfaces** are rounded rectangles: 8px (`--r-sm`) for nested rows and small buttons, 12px (`--r-md`) for list rows, timelines, and toasts, 16px (`--r-lg`) for the composer, cards, and popovers. **Interactive chrome** is pill-shaped (999px): send button, model chip, version picker, glass header bar, hint chips, tooltips, the fork ball.

Signature geometry details: the user bubble notches its bottom-right corner (16px radius with an 8px corner) to point at its author; the brand mark is an 11px coral square rotated 45°, turning to 135° when the sidebar is hovered; borders are always 1px hairline, with dashed hairline reserved for empty states.

## Components

### Buttons
- **Character:** crafted and confident — quiet at rest, precise physical response: -1px lift on hover, `scale(0.94)` press, 200ms `cubic-bezier(0.22, 1, 0.36, 1)`.
- **Send (primary):** 32px coral circle, white glyph; hover deepens to Coral Kiln and lifts -1px; disabled falls to Linen + Ink Muted. Stop variant: Coral Wash fill, kiln glyph.
- **Icon buttons:** 26–32px transparent squares (8px radius) or circles on glass; hover paints `--hover` alpha and restores full ink; active paints `--pressed` and scales 0.94.
- **New chat:** Paper surface, hairline border, 12px radius, whisper shadow; the coral plus-glyph rotates 90° on hover while the border warms toward coral.

### Chips
- **Model chip:** 28px pill, Linen fill, 13px/500 text; opens a 316px Paper popover (16px radius, shadow-lg) with selected rows in Coral Wash.
- **Hint chips (welcome):** pill, Paper fill, hairline border, muted text; hover warms border toward coral and lifts -1px.
- **Version picker:** segmented pill — hairline-bordered track (2px padding), 22px segments, tabular numerals; the active segment is a sliding coral thumb with white text; a coral ring pulses once when a new version lands.

### Cards / Containers
- **Asset card:** Paper, 16px radius, hairline border, whisper shadow; header strip in half-linen with a coral glyph and serif title; hover raises to shadow-md. The iframe below the bar is untouched — the artifact speaks.
- **Activity timeline:** 12px radius, 70%-translucent Paper; while live, its border and fill warm with coral and the summary text turns kiln; collapses to one line ("Worked for 1m 05s · 8 steps"). Rows: 22px icon tile, label left, result summary right, 12px spinner (coral arc, 0.7s) or status mark.

### Inputs / Fields
- **Composer:** Paper field, 16px radius, hairline border, whisper shadow; hover warms the border 26% toward coral; focus deepens it to 55% and adds a 3px coral halo (16% alpha). Running state tints the field toward Linen. Footnote hints fade in only on hover/focus. Compact fork variant: 12px radius, 13px text, 28px buttons.
- **Focus everywhere:** `:focus-visible` gets a 2px coral outline, 2px offset — never a suppressed outline without replacement.

### Navigation
- **Sidebar:** Linen column, hairline right border. Chat rows are 12px-radius ghosts: muted text warming to ink on hover, active row raised on Paper with a 2.5px coral rail on its left edge; delete affordance appears only on hover and arms to full coral. Empty state: dashed hairline card with serif title.

### Glass Chrome (signature)
The document-mode furniture: a pill header bar (title in serif, live status dot, version picker, icon tools) and a footer dock (response sheet, activity strip, composer) — all `--glass` translucency, 18px backdrop blur, hairline glass borders, floating over the generated page. A scrim gradient grounds the header. On charcoal, glass gains a lit edge.

### Fork Ball (signature)
A 52px coral orb: 148° gradient (light coral → Terracotta → deep kiln) with a radial top-light halo so it reads spherical, radiating the coral glow shadow. It pulses a coral ring when a new asset arrives and spins a thin arc sweep while a fork run streams. Its pill tooltip slides in from 8px right. The one deliberately loud object in the system.

### Motion
One easing rules everything: `cubic-bezier(0.22, 1, 0.36, 1)` at 200ms (state), 280ms (reveal), 420ms (layout). Animation is transform + opacity only — the streaming caret (opacity blink at the end of the last block), thinking dots (staggered 1.25s rise), live pips (1.4–1.5s pulse), spinners (0.7s linear). `prefers-reduced-motion` collapses all of it.

## Do's and Don'ts

### Do:
- **Do** keep every spatial value on the 4px rhythm (`--sp-*`), reserving 1–2px offsets for optical centering.
- **Do** express state through coral intensity and alpha tints (`--hover` 4.5%, `--pressed` 7.5%) — never through new hues.
- **Do** animate transform and opacity only, with the single house easing `cubic-bezier(0.22, 1, 0.36, 1)`.
- **Do** set `word-break: keep-all` on any surface that renders Korean prose, and `tabular-nums` wherever numbers tick.
- **Do** give dark-theme glass a lit edge (9% ivory in the border) and more body (86% surface) so it holds against bright documents.
- **Do** use `color-mix` to derive intermediate tones from tokens rather than hardcoding new values.

### Don't:
- **Don't** introduce a second accent hue, purple gradients, sparkle icons, or any generic AI-chat styling — the confirmed anti-reference.
- **Don't** wrap assistant responses in bubbles; the assistant is bare prose on the canvas. Only the user gets a Coral Wash bubble.
- **Don't** style inside asset iframes or let shell CSS leak into them — generated documents own themselves entirely.
- **Don't** use Lora for buttons, labels, or any mechanical control; the serif is reserved for identity moments.
- **Don't** apply glass, blur, or shadow-lg to resting surfaces; floating treatment belongs exclusively to chrome over a document and to popovers/toasts.
- **Don't** fill large areas with full-strength coral — the flame stays small (dots, 32px buttons, rails, thumbs).
