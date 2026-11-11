# ADS Swing Importer (Figma plugin)

Turns CSS custom properties into Figma Variables, Text styles and Effect styles.

## Load it in Figma
1. Open the Figma **desktop** app and any design file.
2. Menu > Plugins > Development > **Import plugin from manifest...**
3. Pick `manifest.json` in this folder.
4. Run it from Plugins > Development > ADS Swing Importer.

## Use it
1. Fetch a URL (e.g. `https://stat.chara.id/swing/ds/tokens.css`) or paste CSS.
2. **Check** shows what will be created and what is skipped, with the reason.
3. **Import** writes it into the file. Running it again updates by name and never deletes.

## What goes where
| CSS | Figma |
|---|---|
| `#hex`, `rgb()`, `hsl()`, `color-mix(in srgb, ...)` | Color variable |
| `px`, `rem` (x16), unitless numbers | Number variable, with scopes (radius, gap, font weight, size) |
| `var(--x)` | Alias to the variable `x` |
| font family stack | String variable (first family) |
| `font` shorthand (`--type-*`) + `--type-*-track` | Text style; utility classes with `text-transform: uppercase` set the case. Every field is bound to a variable: family to `Typography/Family`, weight to `Typography/Weight/...`, and size, line height and letter spacing to the style's own `Typography/<style>/size`, `/line-height`, `/letter-spacing`. Figma reads a number variable on line height and letter spacing as px, so tracking is stored in px at that size (H1: -2% of 36 = -0.72) |
| `box-shadow` lists | Effect style |
| `--opacity-*` (0 ... 1) | Number variable `Opacity/N` in % (0.5 becomes 50), scope Opacity |
| `--type-*-para` | Paragraph spacing on that text style, bound to `Typography/<style>/paragraph-spacing` (an alias of Spacing) |
| `:root` / `[data-theme=x]` / `.dark` / `prefers-color-scheme: dark` | Modes of one collection |

Names are grouped by category first: `--purple-500` becomes `Color/Purple/500`, `--color-text-muted` becomes `Color/Semantic/text-muted`, `--gap-tight` becomes `Spacing/Gap/tight`, `--type-s1s` becomes the text style `Subheading/Semibold/S1`, `--elevation-2` becomes `Elevation/2`. Each item keeps its CSS name in the description and as WEB code syntax, so Dev Mode shows `var(--purple-500)`. A re-import finds items by that CSS name and renames them in place, so layers that already use them stay linked.

Tokens Figma has no direct slot for are adapted, not skipped:
- gradients (`linear-` / `radial-gradient`, layered with solid colors) become **paint styles** (`Gradient/...`)
- `--elevation-0: none` becomes an empty effect style (`Elevation/0`), handy to clear a shadow
- padding shorthands (`--bar-pad`, `--inset-banner`) are split into one variable per side (`Spacing/Bar/top`, `x`, `bottom`)
- `calc()` is computed; `env(safe-area-inset-*)` counts as 0 (noted in the variable description)
- z-index and `em` tracking become variables hidden from pickers (`Z-index/...`, `Typography/Tracking/...` in %), so Dev Mode still shows them but nobody binds them by mistake

## Adding a fetch domain
Add it to `networkAccess.allowedDomains` in `manifest.json`, then re-import the manifest.

## Send changes to the web (Figma → tokens.css)
> **Currently hidden.** The section is switched off in the plugin. To turn it back on, remove `hidden` from `<div class="sec" id="syncSec" hidden>` in `ui.html` and re-import the manifest. The server side still runs.

Variables edited in the DS file (ADS TESTING) can be written straight into `tokens.css`. There is no approval step: every update is backed up and can be undone.

1. In the **Tokens** tab, under **Send to web**, enter your **Access key** (`sds_...`). It is kept in your own Figma.
2. Click **Check changes**. The plugin reads the live `tokens.css` and compares it with the local variables in the same collection, then lists old → new values.
3. Click **Update N tokens on the web**. `tokens.css` changes right away, after a backup of the old version.
4. Publish the ADS TESTING library so other files get the update.
5. Every update is in History at [stat.chara.id/swing/ds/sync/](https://stat.chara.id/swing/ds/sync/), with who made it and from which file. If one is wrong, the owner clicks **Undo**, then Fetch + **Import tokens** in ADS TESTING so Figma matches again.

For a change made directly in `tokens.css`, Fetch + **Import tokens** in ADS TESTING, then publish.

Sent: hex colors (with alpha), px/rem/em/unitless numbers (written in the unit the web value uses), and aliases to another token (`var(--green-500)`). Font families, one side of a padding shorthand, and `calc()` values are listed as "not sent" and must be changed in `tokens.css`. Text and effect styles are not sent yet.

The owner makes access keys on the sync page under **Access keys** (one per person, revocable). Keys, the queue, history and backups live in `~/swing-ds-sync` on the server, outside the docroot. The server code is in `server/` in this repo.

## Icons
**Icons** reads `icons/index.json` next to the source URL and turns each SVG into a component `Icon/Line/<name>` or `Icon/Solid/<name>` on an **Icons** page, one section per set. The fill is bound to `Color/Semantic/Text/default` and the vector scales, so icons can be resized. Icons that already exist are skipped.

## Components
**Components** builds component sets on a **Components** page, bound to the imported tokens. Rebuilding matches variants by name and updates them in place, so instances stay linked.

Names in Figma are the names in code, so a developer can read an instance and write the markup:

| Figma | Code |
|---|---|
| `Button` · `size` xl / l / m / s / xs | `.btn--xl` / `.btn` (no class) / `.btn--m` / `.btn--s` / `.btn--xs` |
| `tone` primary / neutral / danger / success | no class / `.btn--neutral` / `.btn--danger` / `.btn--success` |
| `appearance` solid / soft / ghost / tertiary | no class / `.btn--soft` / `.btn--ghost` / `.btn--tertiary` |
| `state` pressed / disabled / loading | `:active` or `.is-pressed` / `disabled` / `aria-busy="true"` + loader |
| `label`, `showIconStart` + `iconStart`, `showIconEnd` + `iconEnd` | button text, `<i class="icon">` before / after it |
| `IconButton` · `icon` | `.btn.btn--icon` + `aria-label` |
| `SlideConfirm` · `tone` primary / danger · `state` dragging / loading / disabled · `label`, `busyLabel` | `.slide-confirm`, `--danger`, `.is-dragging`, `.is-done` + `aria-busy`, `aria-disabled`, `data-busy-label` |
| `SwingLoader` · `size` 16 / 24 / 48 / 96 | `.swing-loader`, `--24`, `--96` |

- **Button** (240): all of the above, combined as the DS allows (success is solid only, tertiary is primary/neutral only). For full width (`.btn--block`), set the instance width to Fill.
- **IconButton** (180): square, icon 24 in xl, 20 in l/m, 16 in s/xs, states default / pressed / disabled.
- **SlideConfirm** (8): 342 wide (set the instance to Fill), dragging shown at 50%.
- **SwingLoader** (4, page Loading): static mark; on the web it animates.

Builds from before this naming are renamed in place: same components, same instances.

- **Badge** (48, page Badge): `tone` neutral / primary / success / warning / danger / info / teal / pink · `appearance` soft / solid / dot · `size` m / s · `label`, `showIcon` + `icon`. Code: `.badge--{tone} .badge--{appearance} .badge--s`.
- **Counter** (12, `placement` inline / corner) · `tone` danger / primary / neutral · `size` 20 / 16 · `count`. **Indicator** (2): the 8px dot.
- **Tag** (64, page Tag): `tone` neutral / primary / teal / pink / orange / green / red / on-media · `size` m / s · `state` default / pressed / selected / disabled · `label`, `showIconStart` + `iconStart`, `showCounter`, `showChevron`, `showRemove`. Code: `.tag--{tone} .tag--s`, selected = `aria-pressed="true"`. Known gap: CSS trims the side padding by 4 next to an icon; Figma cannot, so those tags are 4px wider per side.

All pages (one page per component group, each set on its own artboard with the code markup). Sets that the CSS composes use real instances of the smaller ones (a Card holds a Button and a Badge, a Sheet holds Option and Select rows), so changing a base component updates them.

| Page | Sets (variants) |
|---|---|
| Color | swatch per colour variable (ramps, semantic with what they point at, overlays), plus the gradient paint styles |
| Typography | one row per text style: name, var(), font / size / line height / tracking, then the mobile and the desktop (`Desktop/...`, 1024+) specimen side by side |
| Checkbox | Checkbox 10 |
| Radio | Radio 7 |
| Switch | Switch 6 |
| Check | Check 16 |
| TextField | TextField 42 (type text / password / multiline / phone / search) |
| Select | Select 8, Option 4 |
| Menu | MenuItem 6, Menu 2 |
| List | ListItem 40, List 3 |
| Accordion | Accordion 4 |
| Tabs | Tab 4, Tabs 4 |
| Divider | Divider 7 |
| Avatar | Avatar 12, AvatarGroup 3 |
| Caption | Caption 8 |
| Pagination | Dot 4, Dots 4, DotsCount 1, Segment 6, Segments 2 |
| Rating | Star 6, Stars 22, Rating 1, Rate 24 |
| Stepper | Stepper 5 |
| Pin | PinCell 15, Pin 8 |
| Slider | Slider 6 |
| Toaster | Toaster 5 |
| Tooltip | Tooltip 8, MapPin 2 |
| Steps | Step 6, Steps 1 |
| Review | Review 2, Comment 1, ChatRow 2 |
| BottomNav | BottomNavItem 5, BottomNav 3 (items 5, 4, 3) |
| AppBar | Brand 2, AppBar 16 (with type=homeSearch, and type=ads: ADS back arrow + country button) |
| Card | Media 16, Card 4, Stat 2 |
| ActionCard | ActionCard 24 |
| CourseCard | CourseCard 4, CardRail 1, Carousel 1 |
| Sheet | SheetHead 4, ShareApp 1, Sheet 5 |
| Search | SearchRow 4, SearchBar 2, SearchPanel 2 |
| DatePicker | CalDay 10, Calendar 1, DateStripDay 3, DateStrip 1 |
| TimePicker | Slot 6, SlotsGroup 1, TimeWheel 1 |
| SwingPass | SwingPass 2 |

Icons that a ref screen uses but the DS icon set does not have (menu, Activity, Account, Instagram) are built on the Icons page under `Icon/Ref/`.

### Button size=glow + Figma Motion
Button has `size=glow` (padding 12 16 from tokens, height hugs to 44, radius 12, CTA M 14/20, icon 16) with two tones only:
- `glow`: glass + glass line, white label, for purple, dark or photo backgrounds.
- `glowPurple`: glass with no line, Dark 500 label, for light backgrounds.

Each variant has a `glow` layer: a 1.5px ring mask with `sheen` above it (white: 320 angular; purple: 276 x 161 linear, Purple 500 0% at 25% to 100%). Disabled has no glow. On the web: `.btn--glow` / `.btn--glow.btn--glow-purple`.

Plugins cannot write keyframes: after a build, open Motion, select `sheen`, Rotation 0 at 0 ms and -360 at 2000 ms, ease in-out, Loop. Updating Button means adding them again.

### UI components

Screen-level parts: PhotoTile, PassUpsell, SectionHead, ProductCard, PromoBanner, HelpCard, LinkCard. They are main components of the file they are built in, kept on the page of the screen that introduced them (Home's on `Screen / Home`, inside **Components on this screen**), made from DS atoms (Button, icons, tokens). A screen builds or updates the ones it uses. In a UI file that uses the DS as a library they are built there, with the atoms coming from the library, so that file becomes the DS for UI components. They are not part of the base library keys. Parts an earlier build put on their own pages are moved back to the screen page with the same id, and the emptied pages are removed.

### Screens

A ref screen from [stat.chara.id/swing/ref](https://stat.chara.id/swing/ref/index.html), rebuilt from instances only. Each screen gets its own page, `Screen / <name>`: the screen frame (390 wide, auto layout) on the left, and **Components on this screen** on the right, in screen order, each row saying which page (or library) the part comes from. Every part lives on its own DS page, so the next screen reuses it; a screen page holds no components. Photos and art are loaded from stat.chara.id; if that fails, grey boxes are used and the build says which files.

| Screen | Page | Parts |
|---|---|---|
| Home (`ref/home.html`) | Screen / Home | AppBar (homeSearch), Dot, PhotoTile, PassUpsell, SectionHead, ProductCard, PromoBanner, HelpCard, LinkCard, Button, BottomNav (items=3) |
| Account (`ref/account.html`) | Screen / Account | ProfileHead (new UI component), Button (ghost), PromoBanner (from Home), ListItem, BottomNav (items=3, Account active) |
| Updates (`ref/updates.html`) | Screen / Updates | AppBar (center, title H3 on the instance), Tag (solid icon + counter), NotifRow (new UI component) |
| Swing Credits (`ref/swing-credits.html`) | Screen / Swing Credits | AppBar (type=ads), CreditCard, AdsRow, RewardCard, AskBox (new UI components), Button |
| Swing Credits history (`ref/swing-credits-history.html`) | Screen / Swing Credits history | AppBar (type=ads, no actions), Tag (tone=ads, size=ads: 28 tall, dark-400), AdsRow (end=plus / end=minus: swappable icon, amount + word + chevron) |
| Personal information (`ref/personal-info.html`) | Screen / Personal information | AppBar (type=ads, no actions), TextField (state=locked with Change, state=lockedWarning with Verify email + icon), Select, Caption (warning, s), Button (l, bottom bar) |
| Verify email (`ref/verify-email.html`) | Screen / Verify email | MailFoot (new UI component, stores=false/true). An email: the frame is the 357 mail column, not a phone screen |
| Refer & earn (`ref/refer-earn.html`) | Screen / Refer & earn | AppBar (type=centerCountry), CodeCard, StatPanel, StepCard, FaqItem (new UI components), Caption, Divider, Button |
| IG story (`ref/ig-story.html`) | Screen / IG story | CodeHero (new), Button |
| Swing Pass email (`ref/swingpass-email.html`) | Screen / Swing Pass email | KvRow (new), MailFoot (stores=true), Divider, Button. An email: 357 column |
| Swing Pass (`ref/swingpass-page.html`) | Screen / Swing Pass | AppBar (type=adsInverse), PassCard, SaveCard, PayMethod, DealCard, Perk (new), FaqItem (ads=true), Dot, Divider, Button (tone=pass / glass) |
| Swing Pass member (`ref/swingpass-member.html`) | Screen / Swing Pass member | the Swing Pass parts, plus a note box |
| Swing Pass events (`ref/swingpass-events.html`) | Screen / Swing Pass events | EventsHead, EventCard, HostCta (new) |
| Swing Pass event (`ref/swingpass-event.html`) | Screen / Swing Pass event | AppBar (type=adsShare), PromoCard, CreditStrip, InfoTile, Venue, BrandCard (new), Divider, Button (tone=muted / pass) |
| Join Swing Pass (`ref/swingpass-join.html`) | Screen / Join Swing Pass | NoteBar, MethodRow, Plan (new), PayMethod (type=action), Checkbox, SlideConfirm |
| Swing Pass billing (`ref/swingpass-billing.html`) | Screen / Swing Pass billing | NoteBar, MethodRow, Button |
| Swing Pass one time (`ref/swingpass-onetime.html`) | Screen / Swing Pass one time | NoteBar, MethodRow (logo=wide, Logo/Ref/* bank logos) |
| Swing Pass QRIS (`ref/swingpass-qris.html`) | Screen / Swing Pass QRIS | NoteBar (primary), Divider, Button (danger / muted tertiary) |
| Swing Pass waiting (`ref/swingpass-waiting.html`) | Screen / Swing Pass waiting | SwingPass surface, AppBar (adsInverse), PassCard, Button (glass) |
| Swing Pass success (`ref/swingpass-success.html`) | Screen / Swing Pass success | KvRow, Divider, Button |
| Swing Pass success one time (`ref/swingpass-success-onetime.html`) | Screen / Swing Pass success one time | KvRow, Divider, Button |
| Swing Pass cancel (`ref/swingpass-cancel.html`) | Screen / Swing Pass cancel | KvRow, ChoiceRow (new), Divider, Button |
| Swing Pass billing history (`ref/swingpass-history.html`) | Screen / Swing Pass billing history | PayMethod, BillRow (new) |
| Tee time (`ref/teetime.html`) | Screen / Tee time | EventsHead (tee=true), ProductCard (size=l), HostCta (inset=true) |
| Golf course (`ref/golf-course.html`) | Screen / Golf course | DateBtn, SessionTab, RateCard, InclItem, Amenity, StatTile (new), PromoCard, CreditStrip, Venue (size=s), Divider, Button |
| Booking (`ref/booking.html`) | Screen / Booking | PayType, PlayerRow, MiniRow, PriceRow, PayBar (new), KvRow, Stepper, PayMethod, Caption, Divider |
| Booking details (`ref/booking-details.html`) | Screen / Booking details | Badge, KvRow, PlayerRow (kind=player), MiniRow, PriceRow, Caption, Divider |
| Track (`ref/track.html`) | Screen / Track | AppBar (centerCountry), StatPanel, Caption, RefRow (new) |
| Tournament questions (`ref/tournament-questions.html`) | Screen / Tournament questions | Avatar, ChoiceRow, Button |
| Tournament confirm (`ref/tournament-confirm.html`) | Screen / Tournament confirm | KvRow, PlayerRow, MiniRow (error), PriceRow (sub), PayMethod, PayBar, Divider |

The screen frame is redrawn on every build, so edit the parts on their pages, not the frame. A Home built before 10 Nov kept its parts on the screen page; the next build moves the icons to the Icons page and drops the old HomeBar.

### Screens from a published library

A file that has the DS as a library (and no tokens of its own) can build screens from the published DS:

1. In the DS file: build the pages the screen needs, publish the library (components, styles **and** variables), then click **Export library keys** in the Components tab. The keys are saved in the plugin's storage, which belongs to your Figma account, so every file sees them.
2. In the other file: add the library (Assets > Libraries), open the plugin, tick the screen in the **Screens** tab and Build. The screen is made of library instances, and its colours, spacing and text are bound to the library's variables and styles. Only screens are built here; DS pages are refused.

Figma can only import what is published, so after changing the DS: publish, Export library keys again, then rebuild the screen. If a part is missing from the library the build stops and names it; it never makes a local copy. Component names that start with `_` or `.` are not published.

Order: Import tokens, then Import icons, then Build components, then Build screens. Screens have their own tab (4 · Screens), separate from the DS pages in Components.
