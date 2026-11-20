---
date: 2026-11-20
topic: skin-component-system
status: proposal; the decisions in §13 were settled by the owner on 20.11.2026
supersedes: docs/ideation/2026-11-20-skin-layout-system-ideation.html (ranked ideas that only refined the two example containers)
---

# The skin component system: a complete proposal

A skin is the bar's look: a tree of components. This document proposes the whole system from scratch.

The bar is still in development, so nothing below is bound to today's format. Where today's code is mentioned, it is as evidence (what breaks, what is hacked around) or as a migration note.

Contents:

1. Principles
2. The contract every component shares
3. Containers
4. Chrome leaves (no metric)
5. Metric visuals
6. Value types: what fits where
7. Decoration and theming
8. Fitting and degradation
9. Scripts
10. The skin file format
11. Worked examples
12. Migration
13. Decisions for the owner

---

## 1. Principles

1. **One tree, two kinds of node.**
   - A *container* holds other nodes and lays them out.
   - A *leaf* holds nothing. A leaf either draws a metric (a *metric visual*) or draws chrome (a label, a line, a picture).
2. **One size contract for every node.** Every node, container or leaf, answers the same question in the same words: how few columns it can live with, how many it wants, how many it can use, and how many rows it needs. No kind has its own vocabulary for width.
3. **The layout belongs to the platform, not to the author's arithmetic.** An author never pads a glyph with spaces to centre it, never adds an invisible element to push two things apart, and never counts columns to make cells equal. If an example in §11 needs a trick like that, the catalogue is missing something.
4. **Degradation is one written order.** When the terminal is too narrow or too short, the same rules decide everywhere what shrinks, what changes form and what disappears. A skin only states what matters more.
5. **A game is data, and one game ships inside the bar.** A game is variables (its style), a component tree with named entry points (its skins), and assets. The platform's code never refers to a particular game.
   - **The built-in "default" game.** When no game is installed or chosen, which is the first and default state, the bar draws the default game: a few basic metrics on one row, and nothing else (§11.3).
   - **Where it lives.** Its skin is compiled into the bar, so it needs no download and works offline from the first run.
   - **Its npm entry.** It also has an entry in the `claude-game-bar` npm organisation, but only so that it appears in the list of games to choose from, beside the others. The bar never downloads it from there.
6. **Values move the layout in one way only: whether there is something to show.** Sizes come from the parameters and from the value's *type* (the widest thing it can ever show), never from the current value. A bar does not jump when a number gets a digit.

   The one exception is presence. A node with nothing to show may collapse (§2), so an error count going from 0 to 1 can bring its node in. This rule exists today in the same words (`fit.js:9-12`) and stays.

---

## 2. The contract every component shares

Every node, whatever its kind, has these settings.

| Setting | Meaning | Default |
|---|---|---|
| `kind` | which container, chrome leaf or visual it is | required |
| `width` | natural width in columns: what it wants | the kind's own (for a visual, derived from its value type, §6) |
| `min_width` | the fewest columns it can live with | the kind's own (always declared by the kind, never "same as width" by accident) |
| `max_width` | the most columns it can use; past it, spare room goes elsewhere | unbounded for text-like visuals, natural for fixed ones |
| `grow` | a weight: how much of a parent's spare room it takes (0 = none) | 0 |
| `rows` / `min_rows` | the rows it wants and the fewest it can live with | the kind's own |
| `priority` | an integer marks the node as **optional**: it may be dropped when room runs out, the lowest first. A node without a priority is **essential**: it shrinks and loses decoration but is never dropped on its own, only with its container | none (essential) |
| `empty` | what it does when it has nothing to show (below) | `"collapse"` |
| `empty_when` | an expression (§7.2): while it is true, the node counts as having nothing to show, e.g. `"= $act.errors = 0"` | none |
| `align` | where its content sits inside the width it was given: `start`, `center`, `end` | the kind's own |
| `color`, `background` | its text colour and background; **inherited** from its parent when not set | the parent's |
| `script` | a script asset run each render (§9) | none |

How sizes are reported:

- **A container computes its size from its children.** Its `width` and `min_width` are derived, and an author sets them on a container only to cap or fix it.
- **A fixed-size leaf says so.** It declares `width = min_width = max_width`. Examples are an icon, or ten hearts that mean ten tenths.
- **A leaf that changes size in steps says so as well.** Its kind knows the step, and the fit rounds its share down to a whole step. An equalizer gives one column per core; a meter of two-column shanks gives two columns per shank.

### The empty rule

The rule applies to everything: a metric the session does not report, a node whose `empty_when` is true, an empty list, and a container whose children all have nothing to show.

| `empty` | Effect | Typical use |
|---|---|---|
| `collapse` | size 0, as if it did not exist | the default; an anchor cell with nothing in it |
| `blank` | keeps its minimum size and draws its empty look; a box keeps its frame and title | the AGENTS box when no agent runs |
| `zero` | draws as if the value were 0 % | an XP bar without a 7-day limit |
| `full` | draws as if the value were 100 % | Minecraft hearts without a 5-hour limit |

This one setting replaces four mechanisms that overlap today:

- the leaf's `when_absent`;
- the container's `when_empty`;
- the hard-coded "list visuals keep their place" (`fit.js:42`);
- the hard-coded handling of kept-absent elements (`fit.js:44`).

---

## 3. Containers

Eight kinds, each with one job:

| Kind | Job |
|---|---|
| `anchor` | nine places around a centre |
| `list` | a line of nodes, each its own size |
| `box` | a title and a fill or border around its content |
| `grid` | N columns of equal cells, with lines and selected cells |
| `layers` | nodes drawn over each other |
| `switch` | alternatives by a selection criterion: a `case when` over conditions and the room available |
| `repeat` | one template, many copies, from a list written in the skin |
| `each` | one template per item of a list metric, in a fixed number of slots |

Each entry below gives the layout rule, the parameters, how the kind sizes, how it degrades, and where it is used.

### 3.1 `anchor`: nine places around a centre

**Layout.** The area is split into a 3×3 grid of places: `top_left`, `top`, `top_right`, `left`, `center`, `right`, `bottom_left`, `bottom`, `bottom_right`. Each place holds at most one node; use a list to put several things in one place. A row or column of places that holds nothing has size 0.

**Width.** An anchor always takes the whole width its parent gives it. It is the only container that fills by itself, so the root of a skin is usually an anchor, and "the bar is as wide as the terminal" needs no special case.

**Column tracks.** The centre column is as wide as the widest centre place. The two side columns follow `balance`:

- `balance = "mirror"` (the default). Both side columns are equally wide, each `(W − centre) / 2`. The centre is therefore exactly in the middle of the anchor. When the width is odd, the extra column goes to the right.
- `balance = "free"`. Each side takes what it needs, and the centre sits in the room between them. This suits a strip whose centre need not be central, such as a WC3 command bar.

**Row tracks.** Each row of places is as tall as its tallest place. The anchor is as tall as its rows together.

**Placing content in a place.**

- `gravity = "in"` (the default) pulls content toward the centre: left places align their content to the end, right places to the start, the top row down and the bottom row up.
- `gravity = "out"` pushes content to the edges.
- `place_align = { left = "start" }` overrides one place.

**Degradation.** Under `mirror`, each side owns its half of the width as a budget. A side that does not fit its half degrades by the order in §8, inside that side only. The centre is never moved and is never shrunk while a side still has something to give. This is the owner's guarantee: *the mugshot is always exactly in the middle.*

**Parameters.** `top_left` … `bottom_right` (each a node id or an inline node), `balance`, `gravity`, `place_align`.

**Used for.**

- The DOOM bar: the boxes on the left, the mugshot in the centre, the boxes on the right.
- Minecraft: the chat on the left, the HUD in the centre.
- WC3: the minimap at the bottom left, the portrait at the bottom, the command card at the bottom right.

### 3.2 `list`: one after another

**Layout.** Children are placed in a line, either `direction = "horizontal"` or `direction = "vertical"`.

| Parameter | Values | Effect |
|---|---|---|
| `direction` | `horizontal`, `vertical` | the main axis |
| `align` | `start`, `center`, `end`, `between` | where the children sit along the main axis when there is room to spare. `between` puts the first child at the start, the last at the end and the room between them, for hearts on the left and hunger on the right |
| `cross` | `start`, `center`, `end`, `stretch` | where each child sits across the main axis. `stretch` gives every child the list's full cross size, so DOOM boxes in a horizontal list are all as tall as the bar |
| `gap` | columns (or rows) | room between children |
| `separator` | text | a glyph drawn in each gap, e.g. `" / "`. It sits on the inherited background |
| `joined` | `false`, `true` | neighbouring bordered boxes share one wall instead of two. Where walls of boxes of different heights meet, the joints come out right (`┳`, `┫`, `┻`), drawn by the same rule as a grid's lines (§3.4): every piece of line belongs to the boxes on its sides. This gives an irregular grid of panels, such as the WC3 console |
| `cut` | `start`, `end` | the end that loses children first when the list is too small. The default is the open end, the one away from `align`: a list aligned to the end (toward a centre) cuts from its start |

**Size.**

- Along the main axis: the sum of the children plus the gaps. Children of equal size are a `grid` (§3.4), not a list.
- Across: the largest child.
- Spare room along the main axis goes to children with `grow`, by weight. When no child grows, `align` places them.

**Degradation.** Shrink, then drop from the `cut` end, as §8 orders it.

**Used for.**

- The sides of the DOOM bar.
- Each row inside a box, such as "🧠 bar 48%".
- The Minecraft HUD column and its status row.
- The whole one-line default bar.

### 3.3 `box`: a titled, decorated list

A box is a list (all list parameters apply) that also draws its own look. It is the owner's "container that has a name and already renders its visual side".

| Parameter | Values | Effect |
|---|---|---|
| `title` | text | the box's name. Empty means no title |
| `title_align` | `start`, `center`, `end` | where the title sits |
| `fill` | colour, gradient or `none` | a background behind the whole box, the DOOM panel look. A gradient (`["#3a6ea5", "#1c3a5e"]`) runs from the top row to the bottom row, the soft panels of The Sims |
| `border` | `none`, `light`, `heavy`, `double`, `rounded`, `block`, `ascii`, or eight characters of your own | a frame around the box |
| `border_color` | colour | the frame's colour |
| `padding` | columns | room inside the frame on the left and the right |

**What the decoration costs.** The fit adds it to the children's size.

| Look | Extra rows | Extra columns |
|---|---|---|
| fill, no title | 0 | 2 × padding |
| fill with a title | 1 (a title row) | 2 × padding |
| border, with or without a title | 2 (the title sits *in* the top line: `┏━ MODEL ━━┓`) | 2 + 2 × padding |

**Degradation.** A box first gives up decoration, then content:

1. `padding` goes to 0.
2. A `border` becomes a `fill` in the border's colour: −2 columns, and −1 or −2 rows.
3. The title row goes. A box with a title is never narrower than its title until this step.

Only after that do its children shrink and drop. A one-row bar can therefore still show a bordered box's content.

**Used for.**

- DOOM's MODEL, USAGE and PROJECT panels (`fill`, a title).
- The doom-line single row (`fill`, no title).
- WC3's stone-framed panels (`border` with the game's own line set).
- A titled grid: a box around a `grid`.

### 3.4 `grid`: equal cells in N columns

**Layout.** The children fill cells left to right, `columns` cells per row; the number of rows follows from the number of children. Every cell has the same width and the same height. The Minecraft hotbar is a grid of 9×1; a WC3 command card is a grid of 4×3 (`columns = 4`, twelve children).

| Parameter | Values | Effect |
|---|---|---|
| `columns` | integer | cells per row. Default: all children in one row |
| `lines` | a line set (§7.4) or `none` | the lines around and between the cells |
| `line_color` | colour | the colour of the lines |
| `fill` | colour or `none` | the background of the cells |
| `selected_lines` | a line set | the lines around a selected cell. Default: the same set as `lines` |
| `selected_color` | colour | the colour of the lines around a selected cell |
| `selected_fill` | colour or `none` | the background of a selected cell. Default: the same as `fill` |
| `cell_align` | one of the nine anchor places | where a child sits inside its cell. Default `center`, so an item glyph is centred without padding |
| `cut` | `start`, `end` | which cells go first when the grid is too small. Default `end` |

**Size.**

- A cell is as wide as the widest child's natural width, and never narrower than the widest child's minimum. All cells shrink together, so one cell cannot be wider than the others. This is the structural end of the PR #84 bug.
- A cell is as tall as the tallest child.
- With lines, the grid adds one column between cells and on both edges, and one row between cell rows and above and below. Width = `columns × cell + columns + 1`.

**Selection.** A script on the grid returns `selected`: the cells to highlight, as a list of child indices or ids (§9). Any number of cells can be selected, or none.

**How the lines are drawn around selected cells.** Every piece of line belongs to the cells on its sides:

- A line segment next to at least one selected cell is drawn in `selected_lines` and `selected_color`. Any other segment is drawn in `lines` and `line_color`.
- A joint (a corner, a T or a cross) where selected and plain segments meet is drawn in the selected style, **with only the selected arms**. The plain arms are left out, because one glyph has only one colour.
  - Example: the top joint between a selected cell and a plain cell to its right becomes `┓`, the selected cell's corner, instead of `┳`. The plain cell's line starts right after it.
  - So the selected cell gets a closed frame, and the plain cell next to it has an open side.
- Between two **neighbouring selected cells**, the segment has a selected cell on both sides, so every arm of their shared joints is selected. The joint keeps its full shape (`┳`, `╋`, `┻`) in the selected style.

This is what today's hotbar does for one selected cell (`containers.js:237-239`), made general for any number of selected cells and for several rows.

Example: cell 2 selected, light plain lines, heavy selected lines:

```
┌───┬───┏━━━┓───┐
│ a │ b ┃ c ┃ d │
└───┴───┗━━━┛───┘
```

**Degradation.**

- All cells shrink together toward the widest minimum.
- Optional cells then go from the `cut` end.
- In a grid of one row, every dropped cell makes it narrower. In a grid of several rows, the width shrinks only once fewer than `columns` cells are left. A WC3 command card therefore keeps its cells essential and marks the whole grid optional.
- Lines are not simplified away: they are what makes a grid a grid. A grid without lines is `lines = "none"`.

**Used for.**

- The Minecraft hotbar (9×1, heavy lines, selected cells chosen by the highlight script).
- A WC3 command card (4×3) and inventory (2×3).

### 3.5 `layers`: one on top of another

**Layout.** All children share the same area. Later children are drawn over earlier ones. Where an upper layer draws a blank with no background, the layer below shows through.

**Placement.** Each child is placed in the area with `place` (the nine anchor places, e.g. `place = "center"`).

**Size.** The largest child.

**Pictures below, glyphs above.** The layers are of two kinds, composed in two steps:

1. **Picture layers** (`sprite`) compose in pixels into one picture, the upper ones' transparent pixels letting the lower through (the map and the units on it, the face and a round frame over it). Only the result is rastered to glyphs. Rastering each and covering cells would leave jagged edges, because one terminal cell holds only two colours.
2. **Glyph layers** (`text`, `label`, `number`, `marks` and any other non-picture node) are then stamped over the rastered picture, in the order they are written. Glyph layers always lie above picture layers, even when written between them.

**A glyph keeps the picture's background.** Where a glyph lands, it replaces the picture's glyph in that cell, but the cell keeps a background from the picture: **the average colour of the picture's pixels under that cell** (the 2×4 pixels of an octant cell). An enemy's `●` in red over grass sits on that grass's green, and a town's name is written over the terrain it names, not on a black hole. A glyph may set its own background instead.

**Degradation.** Upper layers drop before the base.

**Used for.**

- A number written over the middle of a bar.
- Markers over a minimap (planned).
- A flash or crack over the mugshot.
- A count badge over an icon.

This is what lets the bar itself stay simple: it draws the bar, and something else writes on it.

### 3.6 `switch`: alternatives by a selection criterion

**Layout: a `case when` over its alternatives.** A switch has `cases`, in order. Each case has a condition `when`, an expression (§7.2), and the node it draws. A case without `when` is the `else`.

```toml
[element.console]
kind = "switch"
cases = [
  { when = "$race = 'orc'",   node = "orc-console" },
  { when = "$race = 'human'", node = "human-console" },
  { when = "$rows < 3",       node = "line" },
  { node = "default-console" },                      # else
]
```

The switch draws the first case whose condition holds **and** whose node fits:
- "fits" means fitting the width and the rows the switch was given *after the node's own degradation*: shrunk to its minimums, its decoration simplified and its optional nodes dropped (§8);
- a node is skipped when its essential nodes alone do not fit;
- only one case is ever drawn.

The two criteria combine as follows:
- **Conditions only.** The first true condition wins, and the room decides nothing unless that node cannot fit at all.
- **No conditions at all.** `children = [...]` is shorthand for cases without `when`. The switch is then the first alternative that fits, the skin chain.
- **Both.** The conditions say which cases are allowed, and the room decides among them.
- The size the switch was given is in the expression too, as `$width` and `$rows`, for a rule that wants to say it outright.

**Size.**

- natural: the natural size of the first case whose condition holds;
- minimum: the smallest minimum among the cases that can hold.

**Used for.**

- **A theme per session.** The WC3 race, the condition reading `$race` from the before script (§9). A switch is needed only where the races differ in *structure*. Where they differ only in look (frames, colours, the portrait), variables and expressions do it without a switch (§11.4).
- **The whole skin chain.** A game's root can be a switch over a tall bar, a 3-row bar and a 1-row bar. That replaces the `smaller` chain of separate skin files, and the five DOOM skin files become one tree (§11).
- **One box's narrow form.** The USAGE box can have a one-line alternative: the bars without the box. This is the "forms" of an element, without a new concept.

Alternatives may reuse the same leaves by id (§10), so a metric's look is written once.

### 3.7 `repeat`: one template, many copies

**At load time** this is authoring sugar, not a layout. A `repeat` is replaced by one copy of `template` per entry of `items`. Each entry fills the template's `{placeholders}` (braces without a dollar, so they cannot be mistaken for `$variables`, §7.1):

```toml
[element.hotbar]
kind = "grid"
lines = "heavy"
children = [{ kind = "repeat", template = "slot", items = [
  { id = "slot-window", item = "🪓", metric = "model.window" },
  { id = "slot-cost",   item = "💎", metric = "cost.total" },
  # … seven more
] }]
```

**Ids.** Generated ids come from the entry (`id`), so a script that finds slots by id (the hotbar highlight) keeps working.

**Used for.** The hotbar, a WC3 command card, a row of resource counters.

### 3.8 `each`: one template per item of a list

`repeat` copies a template for entries written in the skin. `each` copies it, at render time, for the items of a **list metric**.

| Parameter | Values | Effect |
|---|---|---|
| `metric` | a list metric | the items: running subagents, the task list, the model family, the CPU cores |
| `template` | an element id | what one item looks like. Inside it, `$item` is the item, and `$item.<field>` one of its fields: `$item.text`, `$item.status`, `$item.time` |
| `slots` | integer | how many items it shows at most. **The layout reserves exactly this many slots**, so the number of items never moves the bar (principle 6) |
| `layout` | `horizontal`, `vertical`, or `grid` with `columns` | how the slots are arranged. It is a list or a grid with these slots as children, and takes their parameters |
| `empty` | per slot: `collapse` or `blank` | an unused slot disappears, or stays as an empty place. `blank` keeps the bar completely still |
| `order` | `first`, `last`, `newest` | which items fill the slots when there are more of them than slots |
| `overflow` | text with `{n}` | what the last slot shows when items are left out, e.g. `"+{n}"` |

**Size.** The size of `slots` copies of the template, laid out by `layout`. A slot's size comes from the template, never from the item.

**Degradation.** Optional slots go from the cut end, like the children of a list.

**Used for.**

- **The Sims' moodlets:** one tile per running subagent: an icon, its time below, its frame green while it runs and red when it fails.
- **The Sims' wants and fears:** one slot per task, with its status mark.
- **The Sims' family portraits:** one small portrait per model of the family.
- A DOOM box of agents as tiles instead of rows, if a skin wants it.

`scroll` stays for long text lists, one item per row. `each` is for items drawn as small compositions.

### What is deliberately not a container

| Not a container | Covered by |
|---|---|
| a spacer | `align = "between"`, `grow` and `gap` |
| a conditional container ("show when X") | the `empty` rule with `empty_when` (§7.2), or a `switch` with conditions. Anything richer belongs to a script, which may change how a node looks but never its size |

---

## 4. Chrome leaves (no metric)

| Kind | Draws | Size | Used for |
|---|---|---|---|
| `label` | fixed text or glyphs (`text = "🧠"`) in a colour | its text, fixed | a caption, an icon in front of a bar, a Minecraft slot's item |
| `rule` | a line that fills the space it is given: horizontal in a vertical list, vertical in a horizontal one (`glyph = "│"`) | 1 across, `grow` along | a divider between two halves of a box |
| `image` | a static picture from the game's assets, rastered to glyphs | its picture at its rows | an ornament, a game logo, a WC3 frame corner |

---

## 5. Metric visuals

Each visual draws a value of certain types (§6), in its own way. Every visual has the shared settings of §2. The "Size behaviour" column says how each one reports its size.

| Visual | Draws | Size behaviour | Rows | Own parameters |
|---|---|---|---|---|
| `text` | the value as text; a value longer than its width scrolls or is cut | shrinkable (min ≥ 1) | 1 | `icon` (prefix), `overflow = scroll \| clip \| ellipsis`, `link` |
| `number` | a number, formatted by its type, coloured by thresholds | shrinkable: natural is the widest formatted value, min the compact form (`12.3k` → `12k`, `100%` → `100`) | 1 | `icon`, `prefix`, `suffix`, `sign`, `currency` (`$`, `§`, `€`, for a `money` value), `thresholds` / `color` gradient |
| `bar` | a percentage as a filled bar, with the percentage beside it, inside it or not at all | shrinkable in cells; eighth-blocks give sub-cell precision | 1, or n when vertical | `direction = horizontal \| vertical` (vertical fills from the bottom in eighths, `▁▂▃▄▅▆▇█`: a mood or aspiration meter), `icon`, `label = right \| middle \| none`, `invert` (draw what is left instead of what is used), `fill`, `partials`, `empty`, `track`, `color` gradient |
| `meter` | a percentage as a fixed number of glyphs: hearts, shanks, pips | fixed, or stepped when `count = "auto"` (as many glyphs as fit, between `min_count` and `count`) | 1, or n when vertical | `direction = horizontal \| vertical`, `count`, `glyph`, `half_glyph`, `empty_glyph`, `gap`, `invert`, `from = start \| end` |
| `state` | a known value as its icon (effort → moon phases), a list of flags as icons (thinking on, fast off), or a list of [part, count] as icon + count (git work) | fixed per icon; natural with text, min icons only | 1 | `icons` map, `show_text`, `other` |
| `sparkline` | a time series as a one-row graph, newest on the right | shrinkable (samples per column) | 1–n | `style = block \| braille \| octant`, `max`, `color` |
| `columns` | a list of channels from 0 to 1 as vertical bars (CPU cores) | stepped: one column (or `column_width`) per channel; `fit = all \| as_many_as_fit` | 1–n | `ramp`, `column_width`, `color` gradient |
| `scroll` | a list, one item per row; a longer list shows a window with counts above and below; long items scroll sideways | shrinkable; rows between `min_rows` and `rows` | n | `marks` per status, `mark_colors`, `anchor = top \| boundary`, `overflow` |
| `chat` | a conversation log | shrinkable; rows between `min_rows` and `rows` | n | `libraries`, `conversations`, colours |
| `marks` | glyphs scattered over an area: units on a map as `●`, the player as `▲` turned by heading, place names. A draw script returns them as a list (§5.1); in `layers` they lie over the pictures and keep the picture's background (§3.5) | the size it is given | n | `draw` |
| `sprite` | a picture. Its source is either **frames** from an asset folder, the frame chosen by a script (the mugshot), or a **draw script** that computes the picture each render (a minimap, units on it, a 3D model) (§5.1) | frames: fixed, the largest frame at its rows. Drawn: the size it is given, so it can be shrinkable | n | `frames`, `default_frame` or `draw`; `glyphs`, `background` |

**Trend.** `number`, `bar` and `meter` take `trend = true`. The platform keeps a short history of every metric's value, and the visual draws an arrow for where the value is heading: `↑↑`, `↑`, `↓`, `↓↓`, or nothing when it is steady. The Sims draws its needs this way. The arrows have a column of their own, reserved whether an arrow is drawn or not, so the trend never moves the layout. `trend_window` sets how far back the trend looks (default 60 s).

Renames from today, and why:

- `progress` → `bar`: shorter, and it is what a reader calls it.
- `icon-row` → `meter`: it measures; it is not a row of icons.
- `icon` → `state`: it shows a state, and `icon` is also a parameter on every visual.
- `equalizer` → `columns`: it shows any channel list, not only an equalizer.
- `scroll-list` → `scroll`.
- `animation` → `sprite`.
- `animation-3d` → `sprite` with a `draw` script that renders the model. A 3D renderer is a picture computed by a function, like a map. There is no separate 3D or map visual (§5.1).

### 5.1 Pictures computed by a function

A `sprite` is a picture, whatever makes it. Today it is frames read from the disk. With `draw` it is a picture a **draw script** computes. A map is that, and so are the units on a map and a 3D model seen from a camera. The platform needs no map visual and no 3D renderer: they are the game's draw scripts.

**A draw script** runs each render, after the fit, like any element script.

- **It gets:**
  - the picture's size in pixels, and in cells (a cell is 2×4 pixels with octant glyphs);
  - the variables and the metric values;
  - `$now` and `$tick`;
  - its own `state`;
  - the session's `shared` data (§9).
- **It returns** an RGBA picture of that size, or `unchanged` to keep the last one.
- **The platform** rasters the picture to glyphs exactly as it rasters the mugshot's frames today.

Like every element script, a draw script cannot change its size. It draws into the size the fit gave it. Because it can draw any size, a drawn sprite can be shrinkable (`min_width`), unlike a sprite of frames.

**The minimap, in this model.**
1. **The world is made once.** The before script generates it once per session, by whatever rule the game likes: Perlin noise, or the shape of the repository (folders as regions, files as terrain). It keeps it in the session's `shared` data, together with what has been explored.
2. **The view is drawn every render.** The minimap's draw script turns the world into the picture to show:
   - a window that follows the player, as in GTA;
   - or a 3D-to-2D projection, as in a car's navigation;
   - with fog of war over what is not explored yet.

   All of that is the draw script's choice. The platform knows only that it gets a picture.
3. **What lies on the map is another layer, in one of two ways:**
   - **As pixels:** a second drawn sprite, transparent wherever nothing stands, composed with the terrain in pixels (§3.5). It is precise to a pixel (2×4 per cell), for a unit moving along a road.
   - **As glyphs:** a `marks` layer. Its draw script returns a list instead of a picture:
     ```js
     return { marks: [
       { col: 3, row: 1, text: "▲", color: "#ffffff" },        // the player, turned by heading ▲▶▼◀
       { col: 7, row: 0, text: "●", color: "#e05440" },        // an enemy
       { col: 3, row: 2, text: "Orgrimmar", color: "#deca80" }, // a name, cut at the edge
     ]}
     ```
     A mark sits on a whole cell, but it is always readable: one pixel of octant graphics is a quarter of a glyph's height, a `●` is not. Each mark keeps the terrain's average colour as its background (§3.5). Single-cell symbols (`● ▲ ★ ◆ ⚑`) work best; an emoji takes two cells.

     **Positions in pixels, placed for reading.** A game that keeps its units in the map's pixels does not have to convert them. A mark may give `x, y` in the pixels of the picture under it, instead of `col, row`. The platform puts it in the cell that holds that pixel (2×4 pixels a cell), then places the marks for reading:
     - **Two marks in one cell.** The second moves to the nearest free neighbouring cell, if one is free within one cell. Otherwise the mark with the higher `priority` stays, or, with `crowd = "count"`, the cell shows the count (`●3`).
     - **A name.** It is written beside its point: to the right where there is room, else to the left. It never covers a mark, and it is cut only at the area's edge.
     - **Steadiness.** A mark that has moved keeps its cell until its pixel position is clearly in another cell, so a unit standing on a cell's edge does not flicker between two cells.

     So pixels can stay the game's own record of where things are, and the marks still read cleanly.

   A game may use both: pixels where position matters, marks where reading matters.

   ```toml
   [element.minimap]
   kind = "layers"
   children = [
     { kind = "sprite", draw = "wc3:scripts/terrain.js" },   # pixels: terrain, roads
     { kind = "sprite", draw = "wc3:scripts/fog.js" },       # pixels: fog of war, composed with the terrain
     { kind = "marks",  draw = "wc3:scripts/units.js" },     # glyphs: units, the player, names
     { kind = "text",   text = "= $zone", place = "top" },   # glyphs: the zone's name over everything
   ]
   ```

**Cost.**
- A draw script runs in the script host with the other scripts. The pictures are small: a minimap of 12×6 cells is 24×24 pixels.
- A script that returns `unchanged` costs no rastering.
- The platform caches the raster of a picture by its content, so a map that only moves every few seconds is rastered only when it moves.
- A heavy renderer (3D) should keep its own work in `state` and draw only when its view changes.

---

## 6. Value types: what fits where

### 6.1 The catalogue's types are too coarse

Today a metric is one of six types (`src/metrics/catalogue.js:15`): percentage, number, text, list, timeseries, conversation. Two of those types cover very different values, so the platform cannot know which visual fits, or how wide a value can ever be:

- **`text`** covers a model name, a branch, a duration (`usage.reset5h`), money (`cost.total`), a fraction (`act.tasks`) and a clock.
- **`list`** covers flags (`model.mode`), counted parts (`git.work`), items (`act.subagents`), channels (`sys.cores`) and names (`model.family`).

Proposal: give each metric a **semantic type** in the catalogue. The type tells the platform three things:

- which visuals can draw it;
- its widest and narrowest rendering, so its natural and minimum width come for free;
- how a `number` or `text` formats it.

| Type | Value | Natural / min width | Metrics |
|---|---|---|---|
| `percent` | 0–100 | `100%` 4 / `99` 2 | `context.hp`, `ratelimit.5h`, `ratelimit.7d`, `health.headroom`, `sys.ram`, `sys.cpu`, `sys.disk` |
| `count` | integer ≥ 0 | `12.3k` 5 / `12k` 3 | `loc.added`, `loc.removed`, `git.status`, `git.ahead`, `git.behind`, `act.agents`, `act.errors`, `sys.zombies`, `save.leanctx`, `save.lingua` (as token counts) |
| `money` | US dollars | `$123.45` 7 / `$123` 4 | `cost.total` |
| `duration` | seconds | `4h59m` 5 / `4h` 2 | `usage.reset5h`, `usage.reset7d`, `sys.session` |
| `time` | clock time | `21:46` 5 / 5 | `sys.clock` |
| `ratio` | [done, total] | `12/34` 5 / `12` 2 | `act.tasks` |
| `label` | a short name | author's width | `model.name`, `advisor.model`, `model.window` |
| `name` | a long name, may link | author's width | `session.name`, `session.title`, `loc.cwd`, `git.branch`, `pr.state` |
| `enum` | one of a known set | its widest member | `model.effort`, `model.style`, `model.permission` |
| `flags` | [[flag, on/off]] | its icons | `model.mode` |
| `counts` | [[part, count]] | icons + counts | `git.work` |
| `items` | a list of entries | author's rows | `act.subagents`, `act.tasklist`, `model.family` |
| `series` | numbers 0–1 over time | author's width | `act.geiger` |
| `channels` | numbers 0–1 side by side | one column each | `sys.cores` |
| `conversation` | a chat log | author's width and rows | (written by a skin's chat) |

Two side effects:

- `loc.churn`, a text "+248 / -209", duplicates `loc.added` and `loc.removed`. It can be retired: a list of two `number`s with a `separator` draws it, coloured.
- For most metrics the producer does not change: only the catalogue entry gains a type. The exception is `money`, `duration`, `time` and `ratio`, whose producers today emit preformatted text. They would emit raw numbers instead, and the visual formats them, so a narrow bar can choose the compact form.
- That exception has consumers beyond the skins, which must move with it:
  - the chat's facts library reads the formatted text: `F.cost`, `F.reset5h`, `F.reset7d`, `F.tasks`, `F.uptime` and `F.clock` (`src/kit/chat/metrics-library.js:87-128`, where the hour is parsed out of `F.clock`). It would format the raw values itself, using the same formatters as the visuals.
  - The published `@claude-game-bar/minecraft` conversations read only those facts (`F.cost`, `F.clock`), not the metrics. As long as the facts stay strings, the package does not change.
  - Skin scripts receive raw metric values. None of the bundled scripts reads these four metrics today.

### 6.2 The matrix: which visual draws which type

✔ = fits; · = can draw it but rarely the right choice.

| Type ↓ / visual → | text | number | bar | meter | state | sparkline | columns | scroll | chat | sprite |
|---|---|---|---|---|---|---|---|---|---|---|
| percent | · | ✔ | ✔ | ✔ | | | | | | ✔ (script) |
| count | · | ✔ | | | | | | | | ✔ (script) |
| money | ✔ | ✔ | | | | | | | | |
| duration, time, ratio | ✔ | | | | | | | | | |
| label, name | ✔ | | | | | | | | | |
| enum | ✔ | | | | ✔ | | | | | |
| flags, counts | | | | | ✔ | | | | | |
| items | | | | | | | | ✔ | | |
| series | | | | | | ✔ | ✔ | | | |
| channels | | | | | | | ✔ | | | |
| conversation | | | | | | | | | ✔ | |

### 6.3 Where each visual fits

| Visual | 1-row bar | a row in a box | a grid cell | a multi-row area |
|---|---|---|---|---|
| text, number, state | ✔ | ✔ | ✔ | — |
| bar | ✔ (few cells) | ✔ | ✔ (≥ 4 cells) | — |
| meter | ✔ | ✔ | — (too wide) | — |
| sparkline | ✔ | ✔ | ✔ | ✔ (more rows, more detail) |
| columns | ✔ (1 row of ramp) | ✔ | ✔ | ✔ |
| scroll, chat | — | — | — | ✔ |
| sprite | — | — | — | ✔ |

The loader checks this matrix. A visual bound to a metric whose type it cannot draw is reported, as today (`canShow`), but against the semantic type.

---

## 7. Decoration and theming

### 7.1 Variables

The bar has one dictionary of variables: names and values. Any parameter of any node can take its value from it, or from an expression over it (§7.2):

- `"$panel"` as the whole value;
- `"wc3:frames/${race}"` inside a string.

**Every metric is a variable too.** The values the daemon reads for the session sit in the same dictionary, under their catalogue ids:
- `$context.hp` is how full the context is;
- `$ratelimit.5h` is the 5-hour limit used;
- `$act.subagents` is the list of running subagents.

A variable a script made (`$race`) and a value the daemon measured (`$context.hp`) are read the same way. A dot reads a field, so the ids work as a tree: `$item.time` is a field of an item, `$context.hp` the `hp` of `context`.

A game may give a metric a name of its own in its `[vars]`, e.g. `health = "= 100 - $context.hp"`. A metric's id is never renamed: the id is the platform's, the alias is the game's.

The dictionary is filled in this order, each step overriding the one before it:

1. **The game's defaults**, in `game.toml`:
   ```toml
   [vars]
   panel     = "#1c2036"
   title     = "#deca80"
   text      = "#d0d0d0"
   good      = "#60c868"
   warn      = "#e0b040"
   bad       = "#e05440"
   threshold = ["$good", "$warn", "$bad"]   # a gradient for numbers and bars
   ```
2. **The skin file's own `[vars]`**, where it differs from its game.
3. **The before script's output** (§9). This is how a session gets its race, its head or its biome.
4. **`vars` on a node**, for that node's subtree only. For example, `{ ref = "panel", vars = { accent = "#b03020" } }` draws the same panel with another accent (§10).

The metric values are not a step of this order: they have their own names (the catalogue ids), which the steps above cannot take. A step that defines a name the catalogue already has is reported.

A name that is not in the dictionary is reported, and the parameter keeps its default. Variables are resolved before the fit, so a variable may change sizes, for example a race whose frame is thicker.

### 7.2 Expressions

**Any parameter of any node can be an expression.** A string that starts with `=` is evaluated, like a spreadsheet formula:

```toml
color = "= case when $context.hp > 80 then $bad when $context.hp > 50 then $warn else $good end"
title = "= case when $act.agents > 0 then 'AGENTS (' || $act.agents || ')' else 'AGENTS' end"
empty_when = "= $act.errors = 0"
```

`"$name"` on its own stays a short way of writing `"= $name"`.

**The language.** It is small, the same everywhere, and it only computes a value. It has no loops and no side effects, and never touches the disk or the network.

| Part | Form |
|---|---|
| values | numbers, `'text'`, `true`, `false`, `null`, variables `$name`, fields `$name.field` |
| arithmetic | `+ - * / %` |
| text | `\|\|` joins |
| comparison | `= <> < <= > >=`, `in (…)` |
| logic | `and`, `or`, `not` |
| choice | `case when <condition> then <value> when … else <value> end`. Without `else`, nothing (`null`), and the parameter keeps its default |
| functions | `has($x)` (the session reports it), `coalesce(a, b, …)`, `min`, `max`, `clamp(x, lo, hi)`, `round`, `floor`, `len` (text or list), `mix(colour, colour, 0–1)`, `format($x, 'compact')` |
| time and room | `$now` (seconds), `$tick`, `$width`, `$rows` (the room the node was given) |

**When it is evaluated.**
- Every render, before the fit, once the variables and the metric values are known.
- An expression is parsed once, when the skin loads. An expression that does not parse is reported, and its parameter keeps its default: the skin still draws.
- The platform evaluates it itself. It is never JavaScript, so a skin cannot run code through it. Code belongs in scripts.
- `$width` and `$rows` are the one exception: they exist only in a switch's conditions, where the room is known (§3.6).

**What expressions replace.** One mechanism instead of several special parameters:

| Was | Now |
|---|---|
| `thresholds` and colour gradients by value | `color = "= case when … end"`, or `mix()` for a smooth blend |
| `empty_values = [0]` | `empty_when = "= $act.errors = 0"`: the node counts as having nothing to show while it is true (§2) |
| `invert` on a bar or meter | `value = "= 100 - $ratelimit.5h"`, what is left instead of what is used |
| `select` on a switch | `cases` with `when` (§3.6) |
| part of what scripts did (blinking, a colour by state) | `color = "= case when floor($now) % 2 = 0 then $bad else $text end"` |

`thresholds`, the gradient and `invert` stay as short forms for the common case. They are expressions underneath.

**A computed value.** A visual normally draws its `metric`. Instead it may draw `value`, an expression, e.g. `value = "= $loc.added + $loc.removed"`.
- A computed value has no catalogue type, so its type is stated: `type = "count"`. The width comes from that type (§6).
- `metric` stays for the plain case: it names the value and its type at once.

**Expressions and the size.** Principle 6 says a value never moves the layout.
- An expression in a size parameter (`width`, `rows`, `columns`, `slots`, a switch condition) may read anything: game variables, the before script's output, the room.
- When a size parameter reads a **metric**, the loader warns that the bar may jump with the value. It is allowed, because a game may want it, but it is then the designer's choice, not an accident.

### 7.3 Inheritance

`background` and `color` pass down the tree. A node that does not set them uses its parent's. A separator sits on the background of the list that draws it. This removes every repeated `separator_background = "#1c2036"` from the DOOM skins: the box sets `fill = "$panel"` once, and everything inside it is on the panel.

### 7.4 Line sets

A box's `border` and a grid's `lines` and `selected_lines` name a line set. A set has eleven characters, in this order:

1. top-left corner
2. horizontal line
3. top joint
4. top-right corner
5. vertical line
6. left joint
7. cross
8. right joint
9. bottom-left corner
10. bottom joint
11. bottom-right corner

A box uses only the corners and the lines. A grid also uses the joints and the cross.

| Name | Characters | Look |
|---|---|---|
| `light` | `┌─┬┐│├┼┤└┴┘` | thin |
| `heavy` | `┏━┳┓┃┣╋┫┗┻┛` | Minecraft hotbar |
| `double` | `╔═╦╗║╠╬╣╚╩╝` | menu frames |
| `rounded` | `╭─┬╮│├┼┤╰┴╯` | soft |
| `ascii` | `+-++\|++++++` | terminals without box drawing |
| `block` | half blocks (box only) | a 1-column-thick coloured frame |
| custom | any eleven characters, in `game.toml` `[lines]` | a game's own (WC3 stone) |

A joint next to a selected grid cell, or where `joined` boxes meet (§3.2), is drawn with only the arms that are really there (§3.4). Every such combination of arms is already in the set: two arms make a corner or a line, three make a joint, and four make the cross. A selected cell's corner always has at least two selected arms.

### 7.5 Ornamental frames

A box's `border` and a grid's `lines` can be one of three levels, each richer and dearer than the one before:

| Level | What it is | Example |
|---|---|---|
| **line set** | the eleven characters of §7.4 | `┏━┳┓` |
| **pattern frame** | each side is a repeated pattern of characters, each with its own colour. A corner may be several characters wide | battlements `▄▀▄▀▄▀` with towers `▟█▙` in the corners, leaves `❦ ❧`, orc spikes `▲▼▲` |
| **image frame** | a "9-slice" picture from the game's assets: corners drawn as they are, sides repeated or stretched to the length. It is rastered to glyphs like the mugshot, so it can be a real texture of stone or wood | `wc3:frames/human/` |

9-slice is the standard way game UIs stretch a decorated frame to any size (Godot's NinePatchRect, Unity's sliced sprites).

**Thickness.** A frame of any level is one character thick on each side, so it costs what a line border costs (§3.3). The game's designer decides where frames are used at all. The minimap can have one and the portrait not: a frame is set per box.

**Overhang.** An image frame may reach into the area it frames: a corner ornament over the edge of the minimap, a crest over the portrait. How that is drawn depends on what it falls on:

- **Over a bitmap** (a sprite, the minimap) the two are composed in pixels, the frame's transparent parts letting the picture through, and the result is rastered to glyphs. Composing glyphs instead would leave jagged edges, because one terminal cell holds only two colours.
- **Over text** the frame's cell simply covers the text's cell, in drawing order.

**Cost.**

- The frame alone is rastered once per size and theme, and cached.
- Only the cells where an overhang meets changing content are composed again. A sprite has a fixed set of frames, so each composed cell is cached by sprite frame, frame image and size; after warming up it is only read. The rasteriser already caches by a key that includes the canvas (`asset-raster.js`), and this extends that key.
- A drawn sprite (the minimap, §5.1) changes, so its overlapped cells are composed again when it draws a new picture, and not when it answers `unchanged`. That is a small area.

**Degradation.** A frame that does not fit steps down its levels, image → pattern → lines → fill, before the box gives up decoration altogether (§3.3).

---

## 8. Fitting and degradation

The fit turns the tree, the session's values and the terminal's width and rows into the drawn tree. It works in three steps:

1. **Measure, bottom-up.** Every node reports `{min, natural, max, rows, min_rows}`:
   - a leaf from its kind, its parameters and its value type;
   - a container from its children and its decoration.

   Nodes with nothing to show are applied first by their `empty` setting, so a `collapse` node measures 0.
2. **Place, top-down.** Each container shares the width it was given among its children (constraints go down, sizes come up). An anchor first splits into its tracks, then lists distribute and grow.
3. **Degrade** when something does not fit, in this one order, applied **at the smallest container that overflows**. For an anchor side, that is the side's own budget: one side's trouble never costs the other side anything.

### The order

1. **Shrink** every node toward its minimum, all together, each by the same share of its own range. Stepped nodes round down to whole steps.
2. **Simplify decoration:** padding to 0, then border to fill, then no title row (§3.3).
3. **Switch** inner switches (a box's narrow form) to their next alternative.
4. **Drop optional nodes**, the lowest priority first. Among equal priorities, the one nearest its list's `cut` end goes first. A container left with nothing collapses.
5. When only essential nodes are left and their minimums still do not fit, the **enclosing switch** moves to its next alternative. For the root that means, for example, from the tall bar to the 3-row bar, and then to the 1-row bar.
6. If even the last alternative is too wide, it is drawn cut at the terminal's edge, as today.

**Rows** follow the same order. A node taller than the rows it was given:

1. first uses its `min_rows`, so a scroll list or a chat shows fewer rows;
2. then its decoration gives up rows;
3. then a vertical list drops its optional children;
4. then its switch moves on.

The root switch is the last resort here too.

### What a skin has to say

`essential` is the default because it is the safe one: nothing disappears unless the skin says it may. That is today's rule (`fit.js:4-7`: no priority means never dropped on its own account), and it is what makes a switch fire at all. Without it, the tall DOOM bar would drop box after box down to the bare mugshot and never fall back to the 1-row bar, which shows more.

So a skin marks the optional parts, and only those, with a number:

- DOOM, as today: SYSTEM `1`, SAVE `2`, and new: AGENTS and TASKS `3`. As the terminal narrows these go in that order, and the tall bar then looks like what were the standard and minimal skins. Once only the essential boxes are left and they do not fit their halves, the switch moves on.
- Minecraft: the chat `1`, the hotbar's slots `2` (from the cut end, so from the right).

The shared defaults do the rest:

- shrinking before dropping;
- decoration before content;
- equal priorities cut from the open end;
- a centre never touched while a side can give.

### What the fit guarantees

These are checked by the tests in §12:

- The root never draws wider than the terminal, except when even the last alternative's minimums do not fit, which is the reported cut case.
- Under `balance = "mirror"`, the anchor's centre starts at exactly `⌊(W − centre) / 2⌋`.
- All cells of a grid have the same width and height.
- A node is drawn exactly at the size it was given.
- The same values and size give the same drawing.

---

## 9. Scripts

The interface stays as it is (`src/kit/skin/scripts.js`).

**What a script gets.** Its node's value, the reaction, the time, the size it was given, its children and its own state.

**What it may return:**

- `frame`: a sprite's frame;
- `image`: a drawn sprite's picture, or `unchanged` (a draw script, §5.1);
- `marks`: a `marks` layer's glyphs, each `{ col, row }` or `{ x, y }` in pixels, with `text`, `color` and optionally `background`, `priority` and `label` (§5.1);
- `selected`: the cells a grid highlights, as a list of child indices or ids (any number, or none);
- `params`: parameters drawn instead of the skin's for this render, such as colours, glyphs and icons;
- `state`.

**What a script never does.** It never changes a node's size. The fit is done before scripts run, so a script cannot make the bar jump.

**One change.** `selected` was a single index; it becomes a list, so a grid can highlight several cells at once (§3.4). The Minecraft highlight script returns a list of one.

### The before script

A skin may name one `before` script. It runs **before the fit**, every render, and its only job is to fill the variables (§7.1).

**Its input is fixed by the platform:**

| Input | What it is |
|---|---|
| `session` | the session id |
| `model` | the model's name, and the advisor's |
| `project` | the project folder |
| `size` | the terminal's columns and rows |
| `now` | the time |
| `values` | the session's metric values |
| `state` | what it returned as `state` last time, kept for the whole session |

**Its output is free:**

- `vars`: a dictionary of names and values, any names the game chooses. The rest of the bar reads its variables from it: a frame, an accent colour, which head to draw, the condition a `switch` tests.
- `shared`: the session's large data, such as a generated world map and what of it has been explored.
  - It stays in the script host for the whole session.
  - The draw scripts read it (§5.1), and the before script may update it on a later run (more of the map explored).
  - It never travels to the render process. Only pictures do.
- `state`: kept for the next run.

**Stable within a session.** The script chooses once, keeps the choice in `state` and returns it again on every later run. A session's race or head therefore never changes while it runs, and the next session gets its own. The choice can be random, follow the model, the project or anything else in the input: that is the game's rule, not the platform's.

**Cost.** It runs in the same script host as the other scripts, as a small batch before the fit. Because it usually returns its stored choice, it is cheap. The platform may skip it while its input is unchanged.

**What it does not do.** It does not draw and does not see the layout. It runs before there is one.

---

## 10. The skin file format

**One file per game.** It holds the game's components and its named skins. A skin is an entry point into the tree: a root and a few overrides. The five DOOM files and the two Minecraft files become one each.

```toml
version = 2
game = "doom"

# Named skins: what a user picks. Each is a root in the tree below.
[skin.doom]
root = "bar"
[skin.doom-line]
root = "line"

# Every component is an element with an id. A node may be referenced from several places
# (the leaves shared by the tall, compact and line alternatives); each place draws its own copy.
[element.bar]
kind = "switch"
children = ["tall", "compact", "line"]

# Small leaves can be written inline, without an id of their own.
[element.context]
kind = "list"
direction = "horizontal"
gap = 1
children = [
  { kind = "label", text = "🧠" },
  { kind = "bar", metric = "context.hp", label = "none", grow = 1 },
  { kind = "number", metric = "context.hp", color = "$threshold" },
]
```

**Rules.**

- Ids are unique within the file.
- A child is an id, an inline node, or a reference with its own variables: `{ ref = "panel", vars = { accent = "#b03020" } }` draws the element `panel` with those variables for its subtree (§7.1).
- A skin entry (`[skin.<name>]`) names its `root` and, optionally, its `before` script (§9) and `[vars]` of its own.
- A reference to an id that does not exist is reported, and the reference is skipped.
- An unknown parameter is reported and ignored, so the skin still draws: a skin degrades and never fails, as today.
- `version = 2` marks the new format.
- Inline nodes that span several lines are TOML 1.1 syntax. `smol-toml`, the parser the loader already uses, accepts them, and every example in this document parses with it.
- The loader produces the same kind of tree the fit consumes today. Inline nodes get generated ids (`context.1`, `context.2`) so that warnings can name them.

**User skins.** A user skin is a file of the same format. It may name a game's file as its base (`base = "doom"`) to reuse the game's elements and change only its own skin entries. That is not a general inheritance mechanism: it is the same id space with the user's entries added.

---

## 11. Worked examples

Each example is the proof that the catalogue is complete. None of them uses a padded glyph, a spacer element or a per-cell width.

### 11.1 DOOM: tall, compact and line in one tree

```toml
[element.tall]                      # 6 rows
kind = "anchor"
left = "left-side"
center = "mugshot"
right = "right-side"

[element.left-side]
kind = "list"
direction = "horizontal"
align = "end"                       # hugs the mugshot; cuts from its start (the open end)
cross = "stretch"                   # every box as tall as the bar
gap = 1
children = ["model", "usage", "project", "save"]

[element.right-side]
kind = "list"
direction = "horizontal"
align = "start"
cross = "stretch"
gap = 1
children = ["activity", "agents", "tasks", "system"]

[element.usage]
kind = "box"
title = "USAGE"
fill = "$panel"
direction = "vertical"
cross = "stretch"
children = ["context", "limit-5h", "limit-7d", "ram", "cost"]

[element.limit-5h]
kind = "list"
direction = "horizontal"
gap = 1
children = [
  { kind = "label", text = "🕔" },
  { kind = "bar", metric = "ratelimit.5h", label = "none", grow = 1 },
  { kind = "text", metric = "usage.reset5h" },        # a duration: 5 columns, min 2, no width written
]

[element.churn]                     # "+248 / -209", green and red
kind = "list"
direction = "horizontal"
separator = " / "
children = [
  { kind = "number", metric = "loc.added", prefix = "+", color = "$good" },
  { kind = "number", metric = "loc.removed", prefix = "-", color = "$bad" },
]

[element.agents]
kind = "box"
title = "AGENTS"
fill = "$panel"
empty = "blank"                     # keeps its title when no agent runs
priority = 3                        # optional: goes after SYSTEM and SAVE
children = [{ kind = "scroll", metric = "act.subagents", rows = 4, min_rows = 2, width = 19, min_width = 16 }]

[element.mugshot]                   # no priority: essential
kind = "sprite"
frames = "doom:images/mugshot"
script = "doom:scripts/mugshot.js"
rows = 6

[element.save]
kind = "box"
title = "SAVE"
fill = "$panel"
priority = 2                        # optional; with SYSTEM (1) gone too, this bar is what doom-standard was
# …

[element.compact]                   # 3 rows: the same leaves, fewer boxes
kind = "anchor"
left = { kind = "list", direction = "horizontal", align = "end", cross = "stretch", gap = 1, children = ["model", "usage"] }
center = { kind = "sprite", frames = "doom:images/mugshot", script = "doom:scripts/mugshot.js", rows = 3 }
right = { kind = "list", direction = "horizontal", align = "start", cross = "stretch", gap = 1, children = ["activity"] }

[element.line]                      # 1 row, no mugshot
kind = "box"
fill = "$panel"
padding = 1
direction = "horizontal"
gap = 2
children = ["model-name", "context", "limit-5h", "limit-7d", "branch"]
```

**What happens as the terminal narrows.**

- **Tall layout.**
  - Every box shrinks first.
  - Then the optional boxes go, each on its own side: SYSTEM (right), SAVE (left), then AGENTS and TASKS (right).
  - Each side stays inside its own half, and the mugshot stays in the middle.
- **When the essential boxes (MODEL, USAGE, PROJECT, ACTIVITY) no longer fit their halves, the switch moves to `compact`, and then to `line`.**
- **When the terminal is shorter than 6 rows the switch skips `tall`. When it is shorter than 3 rows, it goes to `line`.**

The old `full`, `standard` and `minimal` skins become what the tall layout looks like at different widths. They are no longer files.

**The boxes `compact` shares with `tall` are the same elements.** In 3 rows they come out lower on their own: a box's rows degrade by §8 (its scroll list uses its `min_rows`), so no second copy of a box is written.

### 11.2 Minecraft

```toml
[element.bar]
kind = "anchor"
gravity = "out"                     # the chat at the terminal's left edge, not hugging the HUD
left = "chat"
center = "hud"

[element.chat]
kind = "chat"
libraries = ["minecraft:conversations/minecraft.js"]
width = 40
min_width = 18
rows = 6
priority = 1                        # the first thing to go

[element.hud]
kind = "list"
direction = "vertical"
cross = "stretch"                   # status and xp as wide as the hotbar
children = ["status", "xp", "hotbar"]

[element.status]                    # hearts left, hunger right: no spacer element
kind = "list"
direction = "horizontal"
align = "between"
children = [
  { kind = "meter", metric = "ratelimit.5h", count = 10, glyph = "♥", empty_glyph = "♡", gap = 1, invert = true, empty = "full", color = "#ff3b3b" },
  { kind = "meter", metric = "context.hp", count = 10, glyph = "🍖", empty_glyph = "🦴", invert = true, from = "end" },
]

[element.xp]
kind = "bar"
metric = "ratelimit.7d"
label = "middle"
fill = "━"
empty = "zero"
color = "#80ff20"

[element.hotbar]
kind = "grid"                       # 9×1: nine equal cells that shrink together (PR #84 cannot happen)
lines = "heavy"
line_color = "#8b8b8b"
selected_color = "#ffffff"
fill = "#262626"
script = "minecraft:scripts/hotbar-highlight.js"   # returns the selected cells
children = [{ kind = "repeat", template = "slot", items = [
  { id = "slot-window", item = "🪓", metric = "model.window" },
  { id = "slot-cost", item = "💎", metric = "cost.total" },
  { id = "slot-changes", item = "🌿", metric = "git.status" },
  { id = "slot-added", item = "🧱", metric = "loc.added" },
  { id = "slot-agents", item = "🐺", metric = "act.agents" },
  { id = "slot-tasks", item = "🏆", metric = "act.tasks" },
  { id = "slot-errors", item = "💥", metric = "act.errors" },
  { id = "slot-cpu", item = "🔥", metric = "sys.cpu" },
  { id = "slot-clock", item = "🕓", metric = "sys.clock" },
] }]

[element.slot]                      # the template: item over its "stack count", centred in its cell
kind = "list"
direction = "vertical"
cross = "center"
priority = 2                        # optional; equal slots go from the hotbar's cut end, the right
children = [
  { kind = "label", text = "{item}" },
  { kind = "text", metric = "{metric}", color = "#ffffff" },
]
```

Today the same skin is 290 lines. Here it is about 70, and nothing in it counts columns.

### 11.3 The one-line default game

The game the bar draws when no other game is installed or chosen. Its skin is compiled into the bar; its entry in the npm organisation exists only so it can be chosen in the list of games (principle 5).

The owner's specification, in this order:

1. 🤖 the model name;
2. the effort moon;
3. thinking, speed and output icons;
4. 🧠 a context bar and percentage;
5. 🕔 a 5h bar and its reset;
6. 📅 a 7d bar and its reset;
7. 📁 the folder;
8. a CPU core equalizer.

```toml
[element.bar]
kind = "list"
direction = "horizontal"
gap = 2
children = [
  { kind = "list", direction = "horizontal", gap = 1, children = [
      { kind = "text", metric = "model.name", icon = "🤖", width = 12, min_width = 6 },
      { kind = "state", metric = "model.effort" },
      { kind = "state", metric = "model.mode" },
      { kind = "state", metric = "model.style" } ] },
  { kind = "list", direction = "horizontal", gap = 1, children = [
      { kind = "label", text = "🧠" },
      { kind = "bar", metric = "context.hp", label = "none", width = 8, min_width = 3 },
      { kind = "number", metric = "context.hp", color = "$threshold" } ] },
  { kind = "list", direction = "horizontal", gap = 1, priority = 3, children = [
      { kind = "label", text = "🕔" },
      { kind = "bar", metric = "ratelimit.5h", label = "none", width = 6, min_width = 3 },
      { kind = "text", metric = "usage.reset5h" } ] },
  { kind = "list", direction = "horizontal", gap = 1, children = [
      { kind = "label", text = "📅" },
      { kind = "bar", metric = "ratelimit.7d", label = "none", width = 6, min_width = 3 },
      { kind = "text", metric = "usage.reset7d" } ] },
  { kind = "text", metric = "loc.cwd", icon = "📁", width = 16, min_width = 6, priority = 2 },
  { kind = "columns", metric = "sys.cores", fit = "as_many_as_fit", priority = 1 },
]
```

As the terminal narrows, everything shrinks first. Then the CPU columns go, then the folder, then the 5h group. The model, the context and the 7d limit stay.

### 11.4 WC3 sketch (the next game)

The design is not settled; this sketch only shows that the pieces are there. The console is an irregular grid of panels: minimap, portrait, unit details and the command card. They share their walls, and the whole thing wears the race's frame. Each session plays one race.

```toml
# game.toml
[vars]
race = "human"                      # the default until the before script has run
```

```toml
# the skin
[skin.wc3]
root = "bar"
before = "wc3:scripts/race.js"      # picks a race once per session; returns vars = { race = "orc" }

[element.bar]
kind = "anchor"
top = "resources"                   # gold, lumber, food = cost, lines, context
bottom = "console"

[element.console]
kind = "list"
direction = "horizontal"
joined = true                       # the panels share their walls
cross = "stretch"
children = ["minimap", "portrait", "details", "commands"]

[element.minimap]
kind = "box"
border = "wc3:frames/${race}"       # an image frame, one per race
children = [{ kind = "layers", children = [
  { kind = "sprite", draw = "wc3:scripts/minimap.js" },   # terrain, fog of war, the view
  { kind = "sprite", draw = "wc3:scripts/units.js" },     # units and pings over it, transparent elsewhere
] }]

[element.portrait]                  # no frame of its own: the designer may decide so
kind = "sprite"
frames = "wc3:images/heads/${race}"
script = "wc3:scripts/portrait.js"

[element.details]
kind = "box"
border = "wc3:frames/${race}"
direction = "vertical"
children = ["unit-name", "unit-stats"]

[element.commands]
kind = "grid"
columns = 4                         # a 4×3 command card
lines = "wc3:frames/${race}"
selected_color = "$accent"          # the commands available right now
children = [{ kind = "repeat", template = "command", items = [ … ] }]
```

The races differ only in look here, so variables carry them and no `switch` is needed. A race whose console were built differently would get its own case under a `switch`, `when = "$race = 'orc'"` (§3.6).

The new pieces WC3 needs are draw scripts (the minimap, the units, a 3D portrait), image frames, joined panels and the before script. None of them is a new container: the container set holds.

### 11.5 The Sims sketch (a test of the catalogue)

The Sims 2 and 3 draw a soft, rounded control panel:

- the Sim's round portrait, with the family's small portraits above it;
- the needs as bars in two columns, with arrows for rising and falling;
- a vertical mood (The Sims 3) or aspiration meter (The Sims 2);
- a row of moodlets, or of wants and fears, each a tile with an icon and a timer;
- tabs, the clock, money in simoleons and the speed controls.

```toml
[element.panel]
kind = "box"
border = "rounded"
fill = ["#3a6ea5", "#1c3a5e"]       # the soft blue gradient
direction = "horizontal"
gap = 1
children = ["portrait", "mood", "needs", "moodlets"]

[element.portrait]
kind = "layers"
children = [
  { kind = "sprite", frames = "sims:images/heads/${head}", script = "sims:scripts/face.js" },
  { kind = "image", image = "sims:frames/round-portrait", place = "center" },   # the round frame over the face
]

[element.mood]                      # the vertical mood meter
kind = "bar"
metric = "health.headroom"
direction = "vertical"
rows = 4
color = ["#e05440", "#e0b040", "#60c868"]

[element.needs]                     # needs in two columns, each with its trend
kind = "grid"
columns = 2
lines = "none"
children = [{ kind = "repeat", template = "need", items = [
  { icon = "🍔", metric = "context.hp" },
  { icon = "⚡", metric = "ratelimit.5h" },
  { icon = "🛁", metric = "ratelimit.7d" },
  { icon = "🎉", metric = "sys.ram" },
] }]

[element.need]
kind = "list"
direction = "horizontal"
gap = 1
children = [
  { kind = "label", text = "{icon}" },
  { kind = "bar", metric = "{metric}", label = "none", trend = true, invert = true, width = 8, min_width = 4 },
]

[element.moodlets]                  # one tile per running subagent, six slots that never move
kind = "each"
metric = "act.subagents"
template = "moodlet"
slots = 6
layout = "horizontal"
empty = "blank"
overflow = "+{n}"

[element.moodlet]
kind = "box"
border = "rounded"
border_color = "#60c868"
direction = "vertical"
cross = "center"
children = [
  { kind = "label", text = "🤖" },
  { kind = "label", text = "$item.time" },
]
```

**What this sketch needed.** Each of these was added to the catalogue because of it:

- `each`;
- `direction = "vertical"` on `bar` and `meter`;
- `trend`;
- a gradient `fill`;
- `currency` (simoleons, `§`).

Everything else (rounded boxes, a grid of needs without lines, the portrait with a frame over it, tabs through the before script and a `switch`) was already there.

---

## 12. Migration

The owner asked to bulldoze, so this is a clean break: skin format `version = 2`, bar `3.0.0`, and no adapter for version 1. The order below keeps every step reviewable.

1. **The ledger, on today's engine, first.**
   - For every skin and every width from 40 to 250, and rows 1 to 8, record a compact signature:
     - the skin chosen;
     - the elements dropped and absent;
     - each node's width;
     - whether the bar was clipped.
   - Commit the result as a golden breakpoint map.
   - Today's snapshot tests sample three widths (`test/games/render-snapshot.test.mjs:56`, `WIDTHS = [60, 100, 200]`). That is how the 80-column break of PR #84 slipped through.
   - From this step on, every change below shows up as a reviewed diff of that map.
2. **Semantic value types in the catalogue** (§6). Producers emit raw numbers for money, durations, the clock and ratios. This step is additive and changes nothing on screen yet.
3. **The engine core:**
   - the node contract (§2);
   - the measure, place and degrade passes (§8);
   - `list`, `anchor`, `box`, `switch`, `layers`;
   - the v2 loader with inline nodes, shared ids and `repeat`.

   Conformance tests cover every kind:
   - its drawing is exactly its given size;
   - `min ≤ natural ≤ max`;
   - steps are respected.
4. **Visuals** renamed and moved onto the contract (§5). `number` and `state` gain minimums.
5. **Skins rewritten:**
   - `doom.toml`: one file with three alternatives;
   - `minecraft.toml`: one file;
   - the new one-line default game.

   Diff the ledger: every change must be intended.
6. **Asset packages and the chat.**
   - The hotbar-highlight script keeps its slot ids, because the `repeat` items carry them. The mugshot script is unchanged.
   - The chat's facts library formats the four metrics that become raw numbers (§6.1). The Minecraft conversations read only those facts, so its package is unaffected while the facts stay strings.
   - Bump `@claude-game-bar/doom` or `@claude-game-bar/minecraft` only if one of their scripts reads a renamed parameter or one of those four raw values. Check this with a grep of `packages/` at the time.
7. **Docs.** `docs/architecture.md` and CONTRIBUTING's skin section are rewritten from this document. Release as 3.0.0.

### Old → new

| Today | Proposed |
|---|---|
| `row`, `column` | `list` with `direction` |
| frame `box` | `box` (a container) |
| frame `grid` (hotbar), one selected cell | container `grid`, any number of selected cells, any number of rows |
| `center`, `center_sides`, root special case (`fit.js:211-214`) | `anchor` |
| `shrink = lockstep \| start \| end` | priority levels and `cut` |
| `grow = none \| fill` | `grow` weight; `cross = "stretch"` |
| `when_empty` keep / shrink / hide | `empty` = blank / blank / collapse |
| `when_absent` hide / empty / full | `empty` = collapse / zero / full |
| `smaller` chain of skin files | root `switch` in one file |
| `separator_background` on every row | inherited background |
| `between` spacer element | `align = "between"` |
| `" 🪓"` padded icons | `label` centred by `cross = "center"` |
| `progress`, `icon-row`, `icon`, `equalizer`, `scroll-list`, `animation`, `animation-3d` | `bar`, `meter`, `state`, `columns`, `scroll`, `sprite`, `sprite` with a draw script |
| `width`/`min_width`, `cells`/`min_cells`, `columns`/`min_columns`, `count` | `width`, `min_width`, `max_width` on every node |

---

## 13. Decisions

All seven were settled by the owner on 20.11.2026, as recommended.

1. **The centre is exact.**
   - Under `balance = "mirror"`, a side that does not fit its half loses its own boxes rather than pushing the mugshot off centre. At narrow widths this drops more than today's drifting centre does.
   - `balance = "free"` exists for layouts that do not want it.
2. **The hotbar is a `grid`, a container of its own** (§3.4). Equal cells in N columns, lines in their own colour, any number of selected cells in their own lines and colour. A box with dividers and a list with equal tracks were dropped for it. The same grid serves WC3's 4×3 command card.
3. **One file per game, with a root `switch` instead of the `smaller` chain.**
   - The five DOOM skins become one tree whose widths produce what were separate files.
   - Named skins stay as entry points (`doom`, `doom-line`).
   - It is the largest reduction in the whole proposal. Today's 7 files hold 1,728 lines. One DOOM file and one Minecraft file, with inline leaves and `repeat`, should come to a fraction of that. The real count comes with the rewrite.
4. **Semantic value types in the catalogue** (§6). This touches:
   - the catalogue;
   - the producers of four metrics (money, durations, the clock, ratios), which switch to raw numbers;
   - the chat's facts library, which then formats them itself.

   The published conversation package is not affected. Without the types, every width is typed by hand again, and the matrix "which visual fits which metric" cannot be checked.
5. **A clean break:** skin format 2, bar 3.0.0, and no adapter for version 1. No third-party skins are known. If some turn up, a one-off conversion script is cheaper than an adapter kept forever.
6. **Authoring sugar, all three:** inline nodes, shared ids and `repeat`. They are what makes the Minecraft skin about 70 lines instead of 290, and none of them reaches the fit: the loader expands them.
7. **Planned visuals:** ~~the names `map` and `model3d` are reserved~~, superseded by decision 16: a map and a 3D model are a `sprite` with a draw script.

Settled later the same day, in the discussion about WC3:

8. **The hotbar is a `grid`** with any number of selected cells, line and selection colours, and joints drawn from the arms that are really there (§3.4).
9. **Joined panels:** `joined = true` on a list of bordered boxes (§3.2).
10. **Ornamental frames in three levels:** lines, patterns and 9-slice images, an image frame possibly overhanging into a bitmap (§7.5).
11. **A theme per session comes from the before script.** Its input is fixed by the platform: session id, model, project, size, time, values and state. Its output is a free dictionary of variables that the rest of the bar reads (§7.1, §9). A `switch` chooses its case by conditions over those variables (§3.6). The race is chosen per session.
12. **Sizes and frames of WC3** are designed when WC3 is built. The platform only has to allow any choice: a frame per box, any height.

Added after testing the catalogue against The Sims 2 and 3 (§11.5):

13. **`each`**, a template per item of a list metric in a fixed number of slots (§3.8).
14. **Vertical `bar` and `meter`**; **`trend`** arrows from a short value history kept by the platform; a **gradient `fill`**; a **`currency`** on numbers (§3.3, §5).

Added after the review of chapter 3:

15. **Expressions everywhere** (§7.2). Any parameter can be an expression (a string starting with `=`), with a `case when … then … else … end` for choices. Metric values are variables under their catalogue ids (`.hp`) beside the game's and the before script's variables, read the same way. A `switch` is a `case when` over its alternatives, each with a `when` condition and the last without one as the `else`, combined with the room available (§3.6). `empty_values`, `select` and value thresholds give way to expressions; `thresholds`, the gradient and `invert` stay as short forms.
16. **A map and a 3D model are a `sprite` with a draw script** (§5.1). A sprite's source is frames on the disk or a script that computes the picture each render. The before script can generate the session's world once (Perlin noise, the repository's structure) and keep it in `shared`. The draw script makes the view from it (a scrolling window, a 3D-to-2D projection, fog of war). Picture layers compose in pixels before rastering (§3.5). The `map` and `model3d` visuals are dropped.
17. **Glyphs over pictures.** In `layers`, picture layers compose in pixels and are rastered first, then glyph layers are stamped over them. A glyph has its own colour and takes as its background the average colour of the picture under its cell. A new visual, `marks`, places glyphs (units, the player, names) from a draw script's list (§3.5, §5, §5.1). A mark is given in cells, or in pixels (as a minimap keeps its units). Then the platform snaps it to its cell and places the marks for reading: crowded marks move to a free neighbour, names go beside their point, and a mark on a cell's edge does not flicker.

---

## 14. Considered and not adopted

- **Drawing over the conversation** (a GTA "WASTED" or "MISSION PASSED" over the text above the bar, a Witcher 3 health bar and map in the top-right corner of the terminal). The status line owns only its own rows.
  - Writing to the terminal around Claude Code would damage the transcript in the scrollback, and a terminal cannot give back what it showed.
  - Claude Code's mods (in the build of 20.11.2026) offer no overlay on the terminal's transcript. They offer a toast (plain text), a band of rows above the prompt, a side pane, and a backdrop *behind* the conversation in the desktop and mobile apps only. Images over cells work only in kitty and Ghostty.
  - The owner's judgement: without the original game's effect over the text, it loses its point, so it is not pursued. A side pane through a mod could hold a health bar and a map on a wide terminal, but that is not a corner overlay.
- **A see-through layer inside the bar** (`layers` with `blend = "tint"`, recolouring the cells under a banner instead of covering them). It would work inside the bar, which knows its own characters. It was declined for the same reason: the effect belongs over the whole screen or not at all.
- **GTA findings, noted but not decided.** Testing the catalogue against GTA San Andreas and GTA V added no container. It found these gaps, kept here for when a game needs them:
  - `delta`: the last change of a value shown for a few seconds, e.g. "+$500";
  - `recent`: a node shown only for N seconds after its value changes, like a district name on entering it;
  - `bigtext`: text drawn in a game's bitmap font over several rows, like Pricedown digits or DOOM's large status numbers;
  - an event metric (`act.events`) for a notification feed;
  - zero padding on numbers (`pad`).
