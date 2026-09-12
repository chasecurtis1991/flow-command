# Flow Command Design System

Source of truth: the Claude Design export (`Flow Command.dc.html`). The values below are ported literally into
`src/App.css`; the in-app **Design system & handoff** page (`/system`) renders the same tokens, type scale, spacing
and component samples, so open the app when in doubt.

## Principles

- One near-black gradient ground (`#0c0e12 → #090a0e`); elevation is translucent glass with a 1px top highlight, not drop shadow.
- A faint accent bloom behind content; the accent is reserved for the primary action and the active state.
- Status is always a 12% tint + full-colour text (and a 5px dot), never a saturated fill.
- Tabular numerals wherever money or quantity appears; money and quantities right-aligned.
- Density is a feature: 32px (compact) / 40px (comfortable) rows, 13px body, 34px sticky header rows.

## Tokens (CSS variables in `src/App.css`)

| Token | Value |
|---|---|
| `--accent` / `--accent-soft` / `--accent-glow` | `#4c8dff` / 16% / 9% (green option: `#3fb97a`) |
| `--text` / `--sub` / `--mute` / `--soft` | `#e6e8eb` / `#9aa0a8` / `#6b7280` / `#c9cdd3` |
| `--green` / `--amber` / `--red` | `#3fb97a` / `#d9a441` / `#e5615c` |
| `--store-retail` / `--store-b2b` / `--store-bulk` | `#4c8dff` / `#b58cf5` / `#3fb97a` |
| `--hairline` / `--border-control` / `--border-raised` | white 7% / 9% / 12% |
| `--glass` | `linear-gradient(180deg, white 4.5%, white 1.8%)` + inset 1px white 5% |
| `--control` / `--raised` / `--selected` | white 3.5% / 7→3% gradient / 13→7% gradient |
| `--row-h` | `40px` (comfortable, default) · `32px` when `html[data-density="compact"]` |
| Radii | 5 / 7 (controls) / 10 (cards) / 14 (dialogs) |
| Motion | `cubic-bezier(.2,.8,.2,1)` 180–380ms; dialogs/toasts overshoot `cubic-bezier(.2,.9,.25,1.15)` |

Accent and density are user settings (Settings → Appearance), applied as `data-accent` / `data-density` on `<html>`
and persisted in `localStorage`.

## Shell

224px sidebar (52px drag strip for the native traffic lights, brand, nav with badges, Design section, connection card)
· 52px top bar (page title with accent bar, segmented store switcher, ⌘K search, alerts) · content with a radial accent
glow. Orders uses a split layout with a fixed 420px detail panel.

## Component classes

`.btn` (+ `-primary -secondary -control -ghost -danger -warn`, `.btn-lg .btn-sm`), `.input` (+ `.input-dark`),
`.pill.{green|amber|red|neutral}`, `.status`, `.dot.{retail|b2b|bulk|green|amber|red|mute}`, `.card` (+ `.card-pad
.card-head .clip`), `.list` / `.list-row`, `.toolbar`, `.thead` / `.row` with `.cols-*` column templates, `.tabs` /
`.tab`, `.seg` / `.seg-item`, `.seg-sm`, `.kpi`, `.state` (loading / empty / error), `.overlay` + `.dialog`
(`.palette`, `.sheet`), `.toast`.

## Keyboard

⌘K palette · ⌘1/2/3 switch store · ⌘R refresh · ⌘⇧R receive lot · ⌘F focus the table search · ⌘, settings ·
↑↓ move the Orders selection · esc closes overlays.
