---
name: Fleet Control "Andon"
description: The line's andon board. Lamps light only where the line calls for a human; everything else stays quiet.
colors:
  graphite-bg: "#121314"
  graphite-surface: "#1a1b1d"
  graphite-card: "#222326"
  graphite-pressed: "#2b2d30"
  graphite-hairline: "#34363a"
  graphite-control-line: "#70737a"
  ink: "#ecebe7"
  ink-2: "#bdbbb4"
  ink-3: "#9a988f"
  lamp-run: "#5bd38a"
  lamp-attn: "#f5a524"
  lamp-stop: "#ff6b61"
  lamp-info: "#6cb1ff"
  lamp-ready: "#e6e4dc"
  lamp-off: "#77756f"
  readout-plate: "#17191c"
  phase-worker-done: "#818cf8"
  phase-merging: "#2dd4bf"
  phase-held: "#fb923c"
  enamel-bg: "#eef0ee"
  enamel-surface: "#ffffff"
  enamel-card: "#f6f7f5"
  enamel-control-line: "#8d908a"
  enamel-ink: "#17181a"
  enamel-lamp-run: "#1d7f45"
  enamel-lamp-attn: "#9a5800"
  enamel-lamp-stop: "#c0362c"
  enamel-lamp-info: "#1f62b8"
typography:
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "0.06em"
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.45
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 650
    lineHeight: 1.25
  body-phone:
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  readout:
    fontFamily: "ui-monospace, SF Mono, Cascadia Mono, JetBrains Mono, Menlo, Consolas, monospace"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.1
rounded:
  control: "6px"
  panel: "10px"
  card: "8px"
  plate: "4px"
  sheet: "14px"
  track: "3px"
  grab: "2px"
spacing:
  s1: "4px"
  s2: "8px"
  s3: "12px"
  s4: "16px"
  s5: "24px"
  s6: "32px"
components:
  button:
    backgroundColor: "{colors.graphite-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "44px"
    padding: "0 14px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.graphite-bg}"
    rounded: "{rounded.control}"
    height: "44px"
  ticket-card:
    backgroundColor: "{colors.graphite-card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "8px 12px 12px"
  lane:
    backgroundColor: "{colors.graphite-surface}"
    rounded: "{rounded.panel}"
  readout:
    backgroundColor: "{colors.readout-plate}"
    rounded: "{rounded.plate}"
    padding: "3px 7px"
---

# Design System: Fleet Control "Andon"

## Overview

**Creative North Star: "The Andon Board"**

Fleet Control is the line's andon board. A supervisor walking a factory line glances at the board and sees only one thing: whether any station is calling for a human. Here the stations are the ticket stages, and the human is the owner, usually on a phone. Colour carries **state and nothing else**, as round lamps. A lamp is lit only where the line calls for attention; everything else is unlit and quiet. The page refuses the category default (a navy SaaS dashboard of equal-weight coloured pills) and its opposite (a green-on-black terminal costume).

The world has two moods. Dark is the powder-coated graphite housing. Light is the enamel floor board under daylight. Both follow `prefers-color-scheme`, and the System panel can force either. Surfaces are flat, separated by hairline seams. Controls are neutral push buttons. Labels are small uppercase plates. Pipeline phases are dark LED readouts mounted on the board, and they stay dark in both themes so their colours keep their contrast.

**Key Characteristics:**
- State lives only in lamps: green run, amber needs-you, red stop, blue review, white ready, unlit off.
- Text always accompanies a lamp; a lamp is never the only carrier of state.
- Exceptions first: a "Needs you" call list leads the Board, with the worker's question inline.
- One equal-width row of four stage columns (Plan, Queue, Building and Done) from 1024px; stacked, collapsible stage columns on a phone. Done is grouped by day (Today, Yesterday and Earlier).
- One DOM at every width: the status items and view buttons exist once and move between header, popover, sheet and bottom nav.

## Colors

Two palettes of the same structure: graphite (dark) and enamel (light). Lamp colours are re-tuned per theme so each lamp text keeps at least 4.5:1 on its surface.

### Primary
- **Lamp Run** (#5bd38a dark, #1d7f45 light): in progress, a live heartbeat, healthy.
- **Lamp Attn** (#f5a524 dark, #9a5800 light): needs you, blocked, stalled, at 75% of a budget.
- **Lamp Stop** (#ff6b61 dark, #c0362c light): failed, dead, over budget, the danger button, the P0 plate.
- **Lamp Info** (#6cb1ff dark, #1f62b8 light): in review, links and PR chips, the focus ring.

### Neutral
- **Graphite housing** (#121314 page, #1a1b1d panels and stage columns, #222326 cards, #2b2d30 pressed): the dark surfaces.
- **Enamel board** (#eef0ee page, #ffffff panels, #f6f7f5 cards, #e9ebe8 pressed): the light surfaces.
- **Ink** (#ecebe7 text, #bdbbb4 secondary, #9a988f tertiary, never below 4.5:1): dark-theme text. Light: #17181a, #3f4044, #5d5e62.
- **Hairline** (#34363a dark, #dcdedb light): decorative seams. **Control line** (#70737a dark, #8d908a light, at least 3:1): input and control boundaries.
- **Readout plate** (#17191c, both themes): the dark module behind a pipeline phase. 047's three literal phase colours (#818cf8 worker-done, #2dd4bf merging, #fb923c held) are kept exactly.
- **Lamp Ready** (#e6e4dc dark, #2f3034 light) and **Lamp Off** (#77756f dark, #7f807b light): the white standby lamp and the unlit lamp, both drawn as outlines.

### Named Rules
**The Lit-Means-Act Rule.** A lamp is lit only when the line calls for a human or work is running. Done, draft and ready are outlines. Rarity is the signal.

**The Words-With-Lamps Rule.** Every lamp has its state in text beside it. Lamps are `aria-hidden`.

**The Dark-Plate Rule.** Pipeline readouts keep 047's phase colours on `--readout-plate` in both themes; their contrast never depends on the page theme.

## Typography

**Display Font:** the system UI sans (`system-ui` with platform fallbacks). No web font is loaded.
**Body Font:** the same system UI sans.
**Label/Mono Font:** the system monospace, only for ticket ids, ports, branch names, costs, counts, logs and paths.

**Character:** a quiet, native sans that stays out of the way, with mono used as measurement rather than costume. Hierarchy comes from size steps and weight, not from a second family.

### Hierarchy
- **Readout** (700, 1.75rem / 28px mono, 1.1): telemetry figures, tabular numerals (23px on a phone).
- **Headline** (650, 1.4375rem / 23px, 1.25): the drawer title on desktop.
- **Title** (650, 1.1875rem / 19px, 1.25): section headings (`h2`).
- **Body** (400-600, 0.9375rem / 15px, 1.45): cards, rows, prose. Prose has a 72ch measure.
- **Body on a phone and inputs** (400, 1rem / 16px, 1.5): rendered Markdown below 768px, and every input and textarea at every width (16px stops iOS zoom).
- **Label** (650, 0.75rem / 12px, 0.06em, uppercase): plates, column titles, station names, table labels. No text is below 12px.

### Named Rules
**The Six-Steps Rule.** The scale is 12 / 13 / 15 / 19 / 23 / 28 and nothing in between.

## Layout

A four-pixel spacing scale (`--s1` to `--s7`). Breakpoints: phone below 768 (designed for 360-430), tablet 768-1023, laptop 1024-1279, desktop 1280 and up.

- **Desktop (1280+):** a two-tier sticky header (identity, views and actions; then the system strip), the andon strip, the line on the left (the four stage columns Plan, Queue, Building and Done, equal width and never scrolling sideways; from 768 to 1023px columns of at least 268px scroll sideways inside the board with an edge fade; each column scrolls vertically inside itself) and the "Needs you" call list as a sticky 360px right column.
- **Tablet and laptop:** the call list moves above the line and shows four rows with "Show all". Below 1024 the system strip moves into the System popover.
- **Phone:** a 56px app bar, the andon strip (scrolling inside itself), the call list, stacked collapsible stage columns, a fixed bottom nav (64px plus the safe area) and a full-screen ticket drawer with a sticky action dock.
- Nothing scrolls sideways at the page level at any width from 320 up. Hit areas are at least 44x44px on every element; hover is decoration only.

## Elevation & Depth

Flat by default. Regions are separated by hairline seams, not shadows. Only floating layers carry a shadow with an offset and a soft blur: the drawer, the System sheet, dialogs and toasts. There is no `backdrop-filter`, no gradient fill, and no hover lift.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 12px 32px -8px rgb(0 0 0 / 0.55), 0 2px 6px rgb(0 0 0 / 0.35)` dark, softer in light): drawer, sheets, dialogs, toasts.
- **Lamp glow** (`box-shadow: 0 0 10px color-mix(in srgb, <lamp> 60%, transparent)`): the lit state of a physical lamp. It is used on lamps only, never on surfaces, text or buttons.

### Named Rules
**The Glow-Is-A-Lamp Rule.** The only glow in the system is the one on a lit lamp.

## Shapes

Radius is 6px for controls and plates, 8px for cards, 10px for stage columns, panels and sheets. There are no pills; the only round shapes are lamps (10px circles, a 2px outline when unlit). A cap-height "plate" (1px border, 4px radius) is the recurring silhouette for labels and states.

**The top bar is the exception, at 1024px and up.** It uses one corner radius, 6px, and only on things you can press when they show a box (a hover or pressed fill, the primary Resume button). Status readouts in the bar are unboxed: no border, no fill, so no corner. The active view is a square 2px marker, not a rounded shape. Phones and tablets keep the plates above.

## Components

### Buttons
- **Shape:** 44px minimum height and width, 6px radius, a 1px control-line border.
- **Default:** a neutral push button on the card surface. **Primary:** a lit white (dark) or black (light) button, one per context. **Danger:** red outline; armed, it fills red and reads "Confirm stop".
- **Ghost toolbar button:** the top bar's actions (Phone link, Pause or Resume live updates, Refresh now, System) show no border and no fill at rest; a 6px `--surface-3` fill appears on hover, and a pressed one (`aria-pressed`) shows a `--surface-2` fill with a 1px `--text-2` border, so a paused feed never looks like a hovered one. Each is still 44 by 44 minimum. Under `forced-colors: active` the bar's hairlines, rail and toolbar separators and the active-view marker are drawn in system colours (`CanvasText`), because shadows and backgrounds are removed.
- **Focus:** a 3px `--focus` ring with a 2px offset on every control. Pressed-state toggles use `aria-pressed`.

### Chips (plates)
- **Style:** 12px uppercase, 0.06em tracking, a 1px border in the lamp colour of its state, 4px radius. P0 is a filled red plate; P2 an outline plate; `team`, `paused` and `pending` are quiet plates.
- **Desktop status rail:** at 1024px and up the system plates in the header's second tier become unboxed readouts (same 12px uppercase label, no border, no fill) separated by 1px hairline rules. They read `--text-2` and are coloured only when they call for a human: the swarm readout in its lamp colour (running, paused, degraded), a polling fallback and a stale watchdog in the attention colour, a missing token in the stop colour. The readout's own leading glyph is its one lamp.

### Cards / Containers
- **Ticket card:** card surface, 8px radius, hairline border. Row 1: id, priority and mode plates, PR link; row 2: the title (15px, 600, three lines); row 3: the pipeline readout, a `stalled` or `dead` flag, and dependencies as "after 012 · 045". A card being built adds, after the readout, a step track (`card-track`: three 8px-or-wider segments for Build, Review and Merge, filled in `--lamp-run` when complete, `--lamp-info` when current, an outline in `--lamp-off` when later; it has a text alternative such as "Step 2 of 3: Review"), then a row with `Attempt N of M` and a spend bar with `$X of $Y` (fill `--lamp-run`, `--lamp-attn` from 70% of the cap, `--lamp-stop` from 100%, estimates). A failed or over-budget card has no track and says `Stopped after N attempts` or `Cap hit: ...` when it is still known. In Plan, Queue and Building a dependent stands under the ticket that blocks it: indented 12px a level (two levels at most), joined by a connector line drawn in `--line-strong`, with `waits for NNN` for screen readers. A draft can be dragged onto the Queue column (native drag and drop, 1024px and wider, no touch): while it is dragged Queue shows the `drop-ready` highlight (a dashed 2px outline in `--lamp-ready`, solid while the card is over it, `drop-over`), and a drop asks "Approve NNN?" before anything is sent. The column mixes statuses, so row 1 also carries a status element (`card-status`, right after the id): a lamp, a word ("Being written", "Draft", "Ready", "In progress", "In review", "Blocked", "Failed", "Over budget") and, on the three states that need the owner, a symbol (question mark, cross, capped bar). Those cards also get a 1px outline in the amber or red lamp colour; colour is never the only signal. Done cards have no status element. A `button.ticket-open` carries focus and its `aria-label` ("Open ticket <id>: <title>") holds the title; the visible title is painted from the `data-t` attribute with CSS generated content (a known trade-off: it cannot be selected, found with find-in-page or translated; the board filter covers search).
- **Stage columns:** Plan, Queue, Building and Done, 10px radius on the surface colour; the header is a heading with a button (52px on a phone) holding the lamp, name and count, and in Building the number of tickets that need the owner. Done holds three collapsible groups, Today, Yesterday and Earlier, each a heading with a button and a count.
- **Call row:** a bordered panel with the kind label in lamp colour, the ticket id, the title, the worker's question quoted with a 1px rule, and Answer / Open.

### Inputs / Fields
- **Style:** 16px text, a 1px control-line border (3:1), the panel surface, 44px minimum height, a visible label.
- **Focus:** the 3px focus ring. **Disabled:** reduced opacity with a visible reason beside it ("Actions need the access token.").

### Navigation
- **Views:** Board, Ring, Graph, Telemetry, Ports, Audit as one set of buttons in a `nav`. In the header at 768 and up (each button spans the bar's height with no fill, border or radius; the active view is `--text` ink with a square 2px station marker on the bar's bottom edge, and hover shows a 2px `--line-strong` bar); a fixed bottom nav with icon and 12px label below 768. The Board button carries a count chip.
- **Andon strip:** a row of 48px stations (Needs you, then one per stage with lamp, name and count) that jump to a stage.

### Dependency graph
- **Structure:** the line's map of open work, a state x depth grid. Rows are lamp states, exceptions first (Stopped, In flight, Ready, Draft); columns are the levels of open work ahead (Clear, Waiting · 1 level, Waiting · 2 levels, In a cycle). A band without an open ticket is not shown; the lamp in its header follows the Board's lamp map.
- **Answer first:** a brief of up to four lines with lamps ("Can start now: 903, 902.", what each stop holds, what is in flight) sits above the grid, then Find and Show done.
- **Card:** neutral (card surface, 8px radius, hairline border), 44px minimum height: lamp, mono id, status word, the full title (13px, 600, two lines), then "Waits on 910 (failed), 904 (in progress)" in words with a stopped dependency in its lamp colour, "Held by ... upstream" and "Unblocks ...". Dispatch-ready cards wear a 2px run-colour ring and no glow; in review keeps a dashed outline.
- **Done shelf:** done tickets leave the grid and wait as 44px chips, newest first, behind **Show done** (stored in `mc.graph.done`). No line is drawn from a done ticket.
- **Lines (1024 and up):** thin orthogonal rails (1.5px, control-line colour, 6px rounded corners, an arrowhead) from a dependency's right edge to the waiting ticket's left edge, in a lane per source; dashed in the lamp colour from a stopped ticket. Below 1024 the bands stack as lists and the words carry every relation.

### Ring view
A second picture of the fleet beside the Board (ticket 091), in three concentric parts inside one square that follows its own width: a core with one segment per worker slot (the count follows `concurrency.maxParallelWorkers`), a ring of the tickets that wait, and a rim with one thin tick per done ticket. The centre is an HTML plate in `--surface-1` with the count ("5 of 8", a 28px readout, 23px on a phone) and one state word (Running, Idle, Paused, Degraded; amber for the last two); all text on the drawing is HTML, never SVG text.
- **Look per state, from the lamp tokens only:** in progress is a filled green mark with a play symbol, blocked a filled amber one with a question mark, failed and over-budget filled red (cross, coin), in review filled blue (eye); being written is a blue dashed outline with a pencil, draft a grey dashed outline, ready a neutral solid outline, an idle slot a dim outline; a done tick is a thin radial line, the newest five green. Colour is never the only sign: every lit mark carries a symbol, and a ticket that needs you carries a **halo**, a second ring in the mark's colour, which stays as a still ring without motion.
- **Folding:** tickets that need you, are in review or run without a slot are always single marks; ready, draft and being-written tickets are single up to 14 (6 on a phone), then the next 6 stay single and one count badge per status takes the rest. The rim shows at most 200 ticks, then "+N older".
- **Motion:** exactly three CSS animations. `ring-sweep` is a short arc that turns around the core (6s a turn, 18s when degraded, none when idle or paused), `ring-rim` turns the rim once in 600s and stops under the pointer or keyboard focus, `ring-pulse` breathes each halo (1.6s, opacity and scale only). No script drives any animation, and all three are off under `prefers-reduced-motion` and `forced-colors`.
- **Reach:** every ticket on the ring is a mark you can click, tap or reach with Tab and open in the drawer; the rim is one Tab stop with arrow keys. Marks on the drawing are the one exception to the 44px rule, because every ticket also has a full-size control (44px) under the ring: the Needs you rows, the chips and the list they open. On a phone ticks are not controls; the rim opens the Done list.

### Pipeline readout (signature component)
A dark LED module: 12px, no uppercase, the phase colour on `--readout-plate` with a 40% tinted border. 047's nine phases keep their exact colours.

## Do's and Don'ts

### Do:
- **Do** light a lamp only where a human is called or work is running, and put the state in words beside it.
- **Do** use `STATUS_LAMP` as the single status-to-lamp map for stage columns, stations, the graph, the drawer plate and the call list.
- **Do** keep every control at least 44x44px and every text at least 12px, in both themes.
- **Do** insert server strings with `textContent`, and render Markdown from DOM nodes so source HTML can only be text.
- **Do** re-render a region only when its input changed, so focus and scroll survive a refresh.

### Don't:
- **Don't** use colour for anything but state: buttons stay neutral.
- **Don't** add gradients, `backdrop-filter`, glass, hover lift or `transition: all`. The one gradient is the mask for the board's edge fade.
- **Don't** use emoji as icons. Icons are the inline SVG sprite, one 1.75 stroke. The four hook strings (`#swarm-badge`, `#auth-status`, `#live-badge`, `#notify-badge`) keep their glyphs, drawn as text symbols.
- **Don't** put information only in a tooltip or only in a colour.
- **Don't** load a web font, a CDN script or a stylesheet: the page is one self-contained file.
