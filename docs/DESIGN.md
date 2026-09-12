# Flow Command Design System

Design language based on Claude Design export, adapted for Flow Gardens operations dashboard.

## Design Principles

- **Dark-first**: Deep blacks with subtle gradients for depth
- **Soft accents**: Blues, purples, greens with transparency for soft washes
- **Minimal borders**: Subtle white borders at 7-14% opacity
- **Card depth**: Gradient fills + inset highlight + subtle border
- **Status via tint**: Never solid candy colors; always ~12% alpha tint + colored dot
- **Precision typography**: SF Pro system stack, monospace for technical data

## Color Tokens

### Backgrounds
```css
--bg-base: #0c0e12           /* Primary app background */
--bg-secondary: #090a0e       /* Gradient endpoint */
--bg-elevated: #13151a        /* Sidebar, topbar, cards */
--bg-card: gradient           /* Subtle white gradient overlay */
```

### Text
```css
--text-primary: #e6e8eb       /* Primary text */
--text-secondary: #9aa0a8     /* Labels, secondary info */
--text-tertiary: #6b7280      /* Muted, disabled */
--text-muted: #c9cdd3         /* Light secondary */
```

### Accent Blue (Primary)
```css
--accent-primary: #4c8dff     /* Interactive elements, links */
--accent-soft: rgba(76, 141, 255, 0.16)  /* Soft wash backgrounds */
--accent-glow: rgba(76, 141, 255, 0.09)  /* Subtle glow */
--accent-dark: #06080c        /* Text on accent gradient */
```

### Status Colors
```css
--success: #3fb97a            /* Paid, fulfilled, healthy */
--success-soft: rgba(63, 185, 122, 0.12)
--warning: #d9a441            /* Pending, needs review */
--warning-soft: rgba(217, 164, 65, 0.12)
--danger: #e5615c             /* Failed, expired, alert */
--danger-soft: rgba(229, 97, 92, 0.12)
```

### Store Identity
```css
--store-retail: #4c8dff       /* Blue dot for Retail */
--store-b2b: #b58cf5          /* Purple dot for B2B/Wholesale */
--store-bulk: #3fb97a         /* Green dot for Bulk/Craft */
```

### Borders
```css
--border-subtle: rgba(255, 255, 255, 0.07)   /* Card borders */
--border-medium: rgba(255, 255, 255, 0.10)   /* Hover states */
--border-strong: rgba(255, 255, 255, 0.14)   /* Focus */
```

## Layout Structure

### Shell Dimensions
```css
--sidebar-width: 224px
--topbar-height: 52px
--detail-panel-width: 420px
```

### Grid Template
```
┌──────────┬──────────────────────────┐
│ Sidebar  │ Topbar                   │
│  224px   │                          │
├──────────┼──────────────────────────┤
│          │                          │
│  Nav     │  Content                 │
│  +       │  (page-specific)         │
│  Status  │                          │
│          │                          │
└──────────┴──────────────────────────┘
```

## Typography

### Fonts
- **Body**: SF Pro Display / -apple-system stack
- **Mono**: SF Mono, Monaco, Cascadia Code (for SKUs, table headers, technical data)

### Scale
```css
28px / 600  /* Page greeting */
20px / 600  /* Detail panel headers */
18px / 600  /* Section titles */
16px / 600  /* Card titles */
14px / 400  /* Body text */
13px / 500  /* Table data, buttons */
12px / 500  /* Labels, metadata */
11px / 600  /* Uppercase section headers */
10px / 600  /* Mono table headers */
```

## Component Patterns

### Cards
```css
.card {
  background: var(--bg-card);           /* Gradient fill */
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  position: relative;
}

.card::before {
  /* Inset top highlight */
  content: '';
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, 
    transparent, 
    rgba(255,255,255,0.12), 
    transparent
  );
}
```

### Status Pills
```css
.status-pill {
  height: 22px;
  padding: 4px 10px;
  border-radius: 11px;
  font-size: 11px;
  background: var(--success-soft);  /* Tinted, not solid */
  color: var(--success);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-pill .dot {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: var(--success);
}
```

### Buttons
```css
/* Primary */
.btn-primary {
  height: 32px;
  padding: 0 16px;
  background: linear-gradient(135deg, 
    var(--accent-primary) 0%, 
    #3d71cc 100%
  );
  color: var(--accent-dark);
  border-radius: 7px;
  box-shadow: 
    0 1px 2px rgba(0,0,0,0.1),
    inset 0 1px 0 rgba(255,255,255,0.1);
}

/* Secondary */
.btn-secondary {
  background: rgba(255,255,255,0.06);
  border: 1px solid var(--border-subtle);
  color: var(--text-primary);
}
```

### Navigation
```css
.nav-item.active {
  background: var(--accent-soft);
  color: var(--accent-primary);
  position: relative;
}

.nav-item.active::before {
  /* Inset left accent bar */
  content: '';
  position: absolute;
  left: 0; top: 4px; bottom: 4px;
  width: 3px;
  background: var(--accent-primary);
  border-radius: 0 2px 2px 0;
}
```

### Store Switcher (Segmented Control)
```css
.store-switcher {
  display: flex;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  padding: 3px;
  gap: 2px;
}

.store-option.active {
  background: rgba(255,255,255,0.1);
  color: var(--text-primary);
}

.store-dot.retail { background: var(--store-retail); }
.store-dot.b2b { background: var(--store-b2b); }
.store-dot.bulk { background: var(--store-bulk); }
```

### Tables
```css
thead th {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.8px;
  color: var(--text-tertiary);
  font-family: 'SF Mono', Monaco, monospace;
}

tbody tr:hover {
  background: rgba(255,255,255,0.02);
}

tbody tr.selected {
  background: rgba(76,141,255,0.06);
}
```

## Border Radii
```css
--radius-sm: 6px    /* Small elements */
--radius-md: 7px    /* Buttons, inputs, controls */
--radius-lg: 10px   /* Cards */
--radius-xl: 12px   /* Panels */
```

## Shadows & Effects
- **Button hover**: `0 4px 12px rgba(76,141,255,0.3)`
- **Glow**: Use accent color at 9-16% alpha
- **Inset highlights**: 1px white gradient at top of cards
- **Status dots**: `box-shadow: 0 0 8px <color>` for active states

## Animation
```css
transition: all 0.15s ease;  /* Default for all interactive */
```

## Accessibility
- Min contrast 4.5:1 for body text
- Status conveyed via icon + color + text
- Focus states: border-color increase to `--border-strong`
- Keyboard nav: outline on focused elements

## CSS Organization
1. CSS variables (`:root`)
2. Reset & base
3. Shell layout (`.app-shell`, grid)
4. Sidebar
5. Topbar
6. Content
7. Page layouts
8. Cards
9. Buttons
10. Status pills
11. Tables
12. Forms
13. Utility classes

## Implementation Notes
- Use CSS variables for all colors/sizes — no hardcoded values
- Cards always have gradient + border + inset highlight
- Never use solid fills for status (always tinted background + colored dot)
- Monospace for technical data (SKUs, domains, timestamps with seconds)
- Active nav item: soft wash + inset accent bar (not solid fill)
- Store dots: 6-8px circles with identity color
