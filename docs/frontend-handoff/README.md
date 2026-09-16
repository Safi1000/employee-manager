# Bastion (crm-design) — Frontend Handoff for Mobile-Responsive Work

Written 2026-09-16 from a read of the code as it stands on `main`. No screenshots; every claim
below was taken from the source, and each section names the file it came from so you can
verify against the code rather than against this document.

| File | What it covers |
|---|---|
| [01-architecture.md](01-architecture.md) | Tech stack and how each library is actually used, folder layout, every route + its permission gate, global providers, the layout shell |
| [02-design-system.md](02-design-system.md) | Colour tokens (light + dark), typography, spacing/radius, the reusable component patterns, and an honest account of **what is already responsive today** |
| [03-page-inventory.md](03-page-inventory.md) | Every page: purpose, DOM hierarchy, tables (columns), summary cards, modals, page-specific interaction patterns |
| [04-patterns-and-gaps.md](04-patterns-and-gaps.md) | Behaviours that must survive the responsive pass, and a ranked list of things that will make it hard |

## The three things to know before opening a file

1. **There is no component library in use.** MUI and 30+ Radix packages are in `package.json`
   and `src/app/components/ui/` holds a full shadcn set, but **nothing outside that folder imports
   any of it** (verified: zero imports of `components/ui/*`, zero of `@mui/*`, zero direct
   `@radix-ui/*`). Every page is hand-written Tailwind v4 utility classes plus ~40 small in-house
   components in `src/app/components/`. Treat MUI/Radix/shadcn as dead weight, not as tools.

2. **Responsive work has already started — this is not a greenfield.** A Capacitor native shell
   ships the same bundle to Android/iOS. Twelve list pages already render a `md:hidden` card
   stack (`MobileCardList`) beside a `hidden md:block` table. 81 form grids were changed to
   `grid-cols-1 sm:grid-cols-2`. The root font is 85% below 768px. The sidebar is a drawer on
   mobile. `docs/MOBILE.md` is the prior author's account of that pass and is worth reading in
   full. What is **not** done: the finance ledgers, the attendance grids, most modals' internal
   layouts, and the dozen or so pages listed in §5 of `02-design-system.md`.

3. **The breakpoint is `md` (768px), and it is the only one that matters.** `sm:` appears
   ~200 times (almost all on form grids), `md:` ~280 times, `lg:` ~40 times, `xl:` never.
   Mobile means `< 768px`; there is no tablet tier.

## Reading order

Architecture → Design system → skim the inventory for the pages you'll touch first →
Patterns & gaps. The inventory is long by design (it is the reference); don't read it linearly.
