# Icon-Based Sidebar - Quick Start Guide

## Get Started in 5 Minutes!

### Step 1: Switch to Enhanced Sidebar (2 min)

Find your layout file (likely `src/pages/_app.tsx`):

```tsx
// BEFORE:
import { Layout } from '@/components/layout/Layout';

function MyApp({ Component, pageProps }) {
  return (
    <Layout>
      <Component {...pageProps} />
    </Layout>
  );
}

// AFTER:
import { LayoutEnhanced } from '@/components/layout/LayoutEnhanced';

function MyApp({ Component, pageProps }) {
  return (
    <LayoutEnhanced>
      <Component {...pageProps} />
    </LayoutEnhanced>
  );
}
```

### Step 2: Build & Run (2 min)

```bash
cd apps/dashboard
npm run build
npm run dev
```

### Step 3: Test Features (1 min)

1. **Toggle sidebar:** Press `⌘B` (Mac) or `Ctrl+B` (Windows/Linux)
2. **Hover tooltips:** Collapse sidebar, hover over icons
3. **Mobile menu:** Resize browser to < 768px, click hamburger
4. **Visit demo:** http://localhost:3000/sidebar-demo

---

## What You Get

### Desktop
- **Collapsed by default:** 72px width (icons only)
- **Hover tooltips:** Labels appear on hover
- **Keyboard shortcut:** ⌘B / Ctrl+B to toggle
- **State persists:** Remembers your preference

### Mobile
- **Hamburger menu:** Slides in from left
- **Backdrop overlay:** Darkens screen
- **Auto-close:** Closes on navigation
- **Touch-friendly:** 44px+ tap targets

### Features
- **Active highlighting:** Current page in green
- **Badge notifications:** Show counts on items
- **Smooth animations:** 300ms transitions
- **localStorage:** Persists across sessions

---

## Quick Reference

### Keyboard Shortcuts
- **⌘B** (Mac) / **Ctrl+B** (Windows/Linux) - Toggle sidebar
- More shortcuts: Visit http://localhost:3000/sidebar-demo

### Toggle Programmatically
```tsx
import { useSidebarState } from '@/hooks';

function MyComponent() {
  const { isExpanded, toggle, setIsExpanded } = useSidebarState();

  return (
    <button onClick={toggle}>
      Toggle Sidebar ({isExpanded ? 'Expanded' : 'Collapsed'})
    </button>
  );
}
```

### Add Badge to Nav Item
```tsx
// In SidebarEnhanced.tsx
<NavItem
  href="/escalations"
  icon={<HandIcon />}
  label="Escalations"
  badge={3}  // Shows "3" badge
  isExpanded={isExpanded}
/>
```

### Custom Keyboard Shortcut
```tsx
import { useKeyboardShortcut } from '@/hooks';

useKeyboardShortcut(
  { key: 'k', metaKey: true },
  () => openSearch()
);
```

### Check Mobile/Desktop
```tsx
import { useIsMobile, useIsDesktop } from '@/hooks';

function ResponsiveComponent() {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();

  return isMobile ? <MobileView /> : <DesktopView />;
}
```

---

## Customization

### Change Default State
```tsx
// Start expanded instead of collapsed
<LayoutEnhanced defaultExpanded={true} />
```

### Change Sidebar Width
```tsx
// In SidebarEnhanced.tsx, find:
className={`${isExpanded ? 'w-60' : 'w-[72px]'}`}

// Change to your preferred widths:
className={`${isExpanded ? 'w-64' : 'w-16'}`}

// Update Layout padding to match:
<div className="pl-16">  // Match collapsed width
```

### Change Colors
Edit Tailwind classes in `SidebarEnhanced.tsx`:
- **Background:** `bg-[#121822]` → your color
- **Active:** `bg-[#0F3D2E]` → your color
- **Hover:** `hover:bg-[#1A2230]` → your color

---

## Full Documentation

- **SIDEBAR-README.md** - Complete usage guide
- **SIDEBAR-FEATURES.md** - All features explained
- **SIDEBAR-VISUAL-GUIDE.md** - Visual examples
- **SIDEBAR-IMPLEMENTATION.md** - Technical details
- **CHANGELOG-SIDEBAR.md** - Version history

---

## Demo Page

Visit **http://localhost:3000/sidebar-demo** to see:
- Interactive feature demos
- Keyboard shortcuts reference
- Code examples
- Feature comparison table
- Implementation status

---

## Troubleshooting

### State not persisting?
- Check localStorage is available (not in incognito)
- Clear cache: `localStorage.removeItem('deerdawn-sidebar-expanded')`

### Keyboard shortcut not working?
- Not typing in an input field?
- Using correct modifier key (⌘ on Mac, Ctrl on Windows)?
- No browser extension blocking?

### Mobile menu not showing?
- Screen width < 768px?
- Hamburger button visible (top-left)?
- No z-index conflicts?

### Build errors?
- Run `npm run build` to check TypeScript errors
- Check imports are correct
- Verify all files created successfully

---

## Checklist

Before deploying:

- [ ] Switched to LayoutEnhanced
- [ ] Build successful (`npm run build`)
- [ ] Tested desktop toggle (⌘B)
- [ ] Tested hover tooltips
- [ ] Tested mobile menu (< 768px)
- [ ] Verified active page highlighting
- [ ] Checked no console errors
- [ ] Visited demo page
- [ ] Tested on multiple browsers
- [ ] Ready to deploy!
---

## You're Done!

Your icon-based sidebar is now live with:
- Collapsible design
- Keyboard shortcuts
- Mobile responsive
- State persistence
- Badge notifications
- Smooth animations

**Need help?** Check the documentation files or visit /sidebar-demo

**Ready to deploy?** Run `npm run build` and ship it!

---

**Built for DeerDawn Dashboard**