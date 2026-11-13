# ADS Swing Importer (plugin Figma)

Ngubah CSS custom property jadi Variables, Text styles, dan Effect styles di Figma.

## Cara pasang
1. Buka Figma **desktop**, terus buka file design apa aja.
2. Menu > Plugins > Development > **Import plugin from manifest...**
3. Pilih `manifest.json` di folder ini.
4. Jalanin dari Plugins > Development > ADS Swing Importer.

## Cara pakai
1. Fetch dari URL (misalnya `https://stat.chara.id/swing/ds/tokens.css`) atau paste CSS-nya.
2. **Check** nampilin apa aja yang bakal dibuat, plus yang dilewatin dan alasannya.
3. **Import** nulis ke file. Kalau dijalanin lagi, yang namanya sama di-update. Nggak ada yang dihapus.

## Masuk ke mana
| CSS | Figma |
|---|---|
| `#hex`, `rgb()`, `hsl()`, `color-mix(in srgb, ...)` | Color variable |
| `px`, `rem` (x16), angka tanpa unit | Number variable, dengan scope (radius, gap, font weight, ukuran) |
| `var(--x)` | Alias ke variable `x` |
| font family | String variable (font pertama) |
| shorthand `font` (`--type-*`) + `--type-*-track` | Text style. Class utility yang punya `text-transform: uppercase` bikin case-nya UPPER. Semua isiannya ke-bind ke variable: family ke `Typography/Family`, weight ke `Typography/Weight/...`, terus size, line height, sama letter spacing ke variable punya style itu sendiri, `Typography/<style>/size`, `/line-height`, `/letter-spacing`. Figma baca variable angka di line height sama letter spacing sebagai px, jadi tracking disimpen dalam px di ukuran itu (H1: -2% dari 36 = -0.72) |
| list `box-shadow` | Effect style |
| `--opacity-*` (0 ... 1) | Number variable `Opacity/N` dalam % (0.5 jadi 50), scope Opacity |
| `--type-*-para` | Paragraph spacing di text style itu, di-bind ke variable `Typography/<style>/paragraph-spacing` (alias ke Spacing) |
| `:root` / `[data-theme=x]` / `.dark` / `prefers-color-scheme: dark` | Mode di satu collection |

Nama dikelompokin per kategori dulu: `--purple-500` jadi `Color/Purple/500`, `--color-text-muted` jadi `Color/Semantic/text-muted`, `--gap-tight` jadi `Spacing/Gap/tight`, `--type-s1s` jadi text style `Subheading/Semibold/S1`, `--elevation-2` jadi `Elevation/2`. Tiap item nyimpen nama CSS-nya di description dan di code syntax WEB, jadi Dev Mode nampilin `var(--purple-500)`. Pas import ulang, item dicari lewat nama CSS itu terus di-rename di tempat, jadi layer yang udah pakai tetap nyambung.

Token yang nggak punya tempat langsung di Figma disesuaiin, nggak dilewatin:
- gradient (`linear-` / `radial-gradient`, termasuk yang berlapis sama warna solid) jadi **paint style** (`Gradient/...`)
- `--elevation-0: none` jadi effect style kosong (`Elevation/0`), kepake buat ngilangin shadow
- shorthand padding (`--bar-pad`, `--inset-banner`) dipecah jadi satu variable per sisi (`Spacing/Bar/top`, `x`, `bottom`)
- `calc()` dihitung; `env(safe-area-inset-*)` dianggap 0 (dicatat di description variable)
- z-index sama tracking `em` jadi variable yang disembunyiin dari picker (`Z-index/...`, `Typography/Tracking/...` dalam %), jadi tetap keliatan di Dev Mode tapi nggak kepake nggak sengaja

## Nambah domain buat fetch
Tambahin di `networkAccess.allowedDomains` di `manifest.json`, terus import ulang manifest-nya.

## Kirim perubahan ke web (Figma → tokens.css)
> **Lagi disembunyiin.** Bagian ini dimatiin di plugin. Kalau mau dinyalain lagi, hapus `hidden` dari `<div class="sec" id="syncSec" hidden>` di `ui.html`, terus import ulang manifest-nya. Server-nya tetap jalan.

Kalau ada yang ngubah variable di file DS (ADS TESTING), perubahannya bisa langsung ditulis ke `tokens.css`. Nggak perlu approval. Tiap update di-backup, dan bisa di-Undo.

1. Di tab **Tokens**, bagian **Send to web**, isi **Access key** (`sds_...`). Key ini disimpan di Figma lo sendiri.
2. Klik **Check changes**. Plugin ngambil `tokens.css` yang live, terus ngebandingin sama variable lokal di collection yang sama. Hasilnya muncul sebagai daftar nilai lama → baru.
3. Klik **Update N tokens on the web**. `tokens.css` langsung berubah. Sebelum ditulis, versi lamanya di-backup dulu.
4. Publish library ADS TESTING, biar file lain dapet update-nya.
5. Semua update kecatat di History di [stat.chara.id/swing/ds/sync/](https://stat.chara.id/swing/ds/sync/), lengkap sama siapa yang update dan dari file mana. Kalau salah, owner tinggal klik **Undo**, terus Fetch + **Import tokens** di ADS TESTING biar Figma ikut balik.

Kalau perubahannya dibikin langsung di `tokens.css`, cukup Fetch + **Import tokens** di ADS TESTING, terus publish.

Yang bisa dikirim: warna hex (termasuk alpha), angka px/rem/em/tanpa unit (satuannya ngikutin nilai di web), sama alias ke token lain (`var(--green-500)`). Font family, satu sisi dari shorthand padding, dan nilai `calc()` cuma dicatat sebagai "not sent". Yang kayak gini harus diubah langsung di `tokens.css`. Text style sama effect style belum ikut dikirim.

Access key dibikin owner di halaman sync, bagian **Access keys** (satu key per orang, bisa di-revoke). Key, antrean, history, dan backup disimpan di `~/swing-ds-sync` di server, di luar docroot. Kode server ada di folder `server/` di repo ini.

## Icons
Section **Icons** ngebaca `icons/index.json` yang satu folder sama Source URL. Tiap SVG dijadiin component `Icon/Line/<nama>` atau `Icon/Solid/<nama>` di page **Icons**, dikelompokin per section. Fill-nya nyambung ke `Color/Semantic/Text/default`, dan vector-nya di-set Scale, jadi icon bisa di-resize. Icon yang udah ada di-skip.

## Components
Section **Components** bikin component set di page **Components**, langsung nyambung ke token yang udah di-import. Kalau di-build ulang, variant dicari lewat nama terus diupdate di tempat, jadi instance yang udah dipakai tetap nyambung.

### Nama swing
Semua component set dinamain `swing_<part>` pakai snake case: `swing_btn`, `swing_text_field`, `Home/swing_product_card` (folder layarnya tetap, biar panel Assets kekelompok). `tone` tetap jadi property: `swing_btn`, `swing_tag`, `swing_badge` masing-masing satu set, jadi primary, neutral, atau danger tinggal diganti langsung di instance. Set yang punya property jenis lain (`type`, `kind`, atau `control`) dipecah jadi satu set per jenis, dan namanya ikut jenisnya: `swing_text_field_password`, `swing_app_bar_home_search`. Tiap jenis punya artboard sendiri. Nama variant di dalamnya tetap nyebut jenisnya (`type=password`), jadi di Dev Mode jenisnya tetap kebaca. Kalau mau ganti jenis, pakai instance swap.

File yang di-build waktu `tone` masih dipecah (`swing_btn_primary`, `swing_btn_neutral`, ...) bakal digabung lagi waktu di-Update: set tone pertama dipertahanin dan di-rename jadi `swing_btn`, variant tone lain dipindah ke situ, terus set dan artboard yang udah kosong dihapus. Instance yang udah ditaruh tetap nyambung; override teks dan ikon di instance tone lain mungkin perlu diisi ulang.

File yang di-build sebelum ada nama swing bakal di-rename dan dipecah di tempat waktu di-Update. Tiap variant tetap node yang sama, jadi instance yang udah ditaruh tetap nyambung. Abis itu, publish library-nya dan jalanin **Export library keys** lagi di file DS. Kalau nggak, file UI masih nyari nama lama.

Nama instance di layar ngikutin set-nya: `swing_btn · size=m, tone=primary, appearance=solid, state=default`.

Tabel di bawah pakai nama part yang dipakai kode (`Button`). Di Figma, part itu adalah set `swing_btn_*`.

Nama di Figma = nama di kode, jadi developer bisa baca instance terus langsung nulis markup-nya:

| Figma | Kode |
|---|---|
| `Button` · `size` xl / l / m / s / xs | `.swing_btn_xl` / `.swing_btn` (tanpa class) / `.swing_btn_m` / `.swing_btn_s` / `.swing_btn_xs` |
| `tone` primary / neutral / danger / success | tanpa class / `.swing_btn_neutral` / `.swing_btn_danger` / `.swing_btn_success` |
| `appearance` solid / soft / ghost / tertiary | tanpa class / `.swing_btn_soft` / `.swing_btn_ghost` / `.swing_btn_tertiary` |
| `state` pressed / disabled / loading | `:active` atau `.is-pressed` / `disabled` / `aria-busy="true"` + loader |
| `label`, `showIconStart` + `iconStart`, `showIconEnd` + `iconEnd` | teks tombol, `<i class="swing_icon">` sebelum / sesudahnya |
| `IconButton` · `icon` | `.swing_btn.btn--icon` + `aria-label` |
| `SlideConfirm` · `tone` primary / danger · `state` dragging / loading / disabled · `label`, `busyLabel` | `.swing_slide_confirm`, `--danger`, `.is-dragging`, `.is-done` + `aria-busy`, `aria-disabled`, `data-busy-label` |
| `SwingLoader` · `size` 16 / 24 / 48 / 96 | `.swing_loader`, `--24`, `--96` |

- **Button** (240): semua di atas, kombinasinya ngikutin DS (success cuma solid, tertiary cuma primary/neutral). Buat full width (`.swing_btn_block`), set width instance ke Fill.
- **IconButton** (180): kotak, icon 24 di xl, 20 di l/m, 16 di s/xs, state default / pressed / disabled.
- **SlideConfirm** (8): lebar 342 (set instance ke Fill), dragging ditampilin di 50%.
- **SwingLoader** (4, page Loading): mark statis; di web dianimasikan.

Hasil build dengan nama lama di-rename di tempat: component-nya sama, instance-nya tetap nyambung.

- **Badge** (48, page Badge): `tone` neutral / primary / success / warning / danger / info / teal / pink · `appearance` soft / solid / dot · `size` m / s · `label`, `showIcon` + `icon`. Kode: `.swing_badge_{tone} .swing_badge_{appearance} .swing_badge_s`.
- **Counter** (12, `placement` inline / corner) · `tone` danger / primary / neutral · `size` 20 / 16 · `count`. **Indicator** (2): titik 8px.
- **Tag** (64, page Tag): `tone` neutral / primary / teal / pink / orange / green / red / on-media · `size` m / s · `state` default / pressed / selected / disabled · `label`, `showIconStart` + `iconStart`, `showCounter`, `showChevron`, `showRemove`. Kode: `.swing_tag_{tone} .swing_tag_s`, selected = `aria-pressed="true"`. Beda yang diketahui: di CSS padding samping dikurangin 4 kalau ada icon; Figma nggak bisa, jadi tag yang pakai icon 4px lebih lebar per sisi.

Semua page (satu page per grup component, tiap set di artboard sendiri lengkap dengan markup kodenya). Set yang di CSS-nya tersusun dari component lain pakai instance asli (Card isinya Button sama Badge, Sheet isinya Option sama Select), jadi ubah component dasarnya, yang lain ikut ke-update.

| Page | Sets (variants) |
|---|---|
| Color | swatch tiap variable warna (ramp, semantic plus nunjuk ke mana, overlay), plus paint style gradient |
| Typography | satu baris per text style: nama, var(), font / size / line height / tracking, terus contoh mobile sama desktop (`Desktop/...`, 1024+) berdampingan |
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
| AppBar | Brand 2, AppBar 16 (termasuk type=homeSearch, dan type=ads: panah back ADS + tombol negara) |
| Card | Media 16, Card 4, Stat 2 |
| ActionCard | ActionCard 24 |
| FeaturedPromo | FeaturedPromo 2 (state default · claimed) |
| CashbackTable | CashbackTable 2 (current regular · pass) |
| CourseCard | CourseCard 4, CardRail 1, Carousel 1 |
| Sheet | SheetHead 4, ShareApp 1, Sheet 5 |
| Search | SearchRow 4, SearchBar 2, SearchPanel 2 |
| DatePicker | CalDay 10, Calendar 1, DateStripDay 3, DateStrip 1 |
| TimePicker | Slot 6, SlotsGroup 1, TimeWheel 1 |
| SwingPass | SwingPass 2 |

Ikon yang dipakai layar ref tapi belum ada di set ikon DS (menu, Activity, Account, Instagram) dibikin di page Icons dengan nama `Icon/Ref/`.

### Button size=glow + Figma Motion
Button punya `size=glow` (padding 12 16 dari token, tinggi HUG = 44, radius 12, CTA M 14/20, ikon 16) yang cuma ada di dua tone:
- `glow`: glass + garis glass-line, label putih. Buat latar ungu, gelap, atau foto.
- `glowPurple`: glass tanpa garis, label Dark 500. Buat latar terang.

Tiap variant punya layer `glow`: mask cincin 1,5px plus `sheen` di atasnya. Untuk tone `glow`, `sheen` itu kotak 320 dengan gradient angular putih. Untuk `glowPurple`, ukurannya 276 x 161, isinya gradient linear Purple 500 dari 0% di 25% sampai 100%. Disabled nggak punya glow. Di web, class-nya `.swing_btn_glow` / `.swing_btn_glow.btn--glow-purple`.

Plugin nggak bisa ngisi keyframe. Jadi abis build, buka Motion, pilih `sheen`, terus set Rotation 0 di 0 ms dan -360 di 2000 ms, ease in-out, Loop. Kalau Button di-Update, keyframe-nya perlu dipasang ulang.

### UI components

Bagian setingkat layar: PhotoTile, PassUpsell, SectionHead, ProductCard, PromoBanner, HelpCard, LinkCard. Ini main component dari file tempat dia di-build, disimpen di page layar yang pertama kali pakai (punya Home ada di `Screen / Home`, di dalam **Components on this screen**), dan disusun dari atom DS (Button, ikon, token). Layar nge-build atau nge-update komponen yang dia pakai. Di file UI yang pakai DS sebagai library, komponen ini di-build di file itu dan atomnya diambil dari library, jadi file itu jadi DS buat komponen UI. Komponen ini nggak ikut ke library keys DS dasar. Komponen yang dulu ditaruh di page sendiri bakal dipindah balik ke page layar dengan id yang sama, dan page yang jadi kosong dihapus.

### Screens

Layar ref dari [stat.chara.id/swing/ref](https://stat.chara.id/swing/ref/index.html) yang disusun ulang, isinya instance semua. Tiap layar dapet page sendiri, `Screen / <nama>`: frame layar (lebar 390, auto layout) di kiri, dan **Components on this screen** di kanan, urut sesuai layar. Tiap baris nyebutin bagian itu diambil dari page (atau library) mana. Semua bagian tinggal di page DS-nya sendiri, jadi layar berikutnya tinggal pakai ulang. Page layar nggak nyimpen component. Foto dan ilustrasi diambil dari stat.chara.id; kalau gagal, diganti kotak abu dan hasil build nyebutin file mana aja.

| Layar | Page | Bagian |
|---|---|---|
| Home (`ref/home.html`) | Screen / Home | AppBar (homeSearch), Dot, PhotoTile, PassUpsell, SectionHead, ProductCard, PromoBanner, HelpCard, LinkCard, Button, BottomNav (items=3) |
| Account (`ref/account.html`) | Screen / Account | ProfileHead (komponen UI baru), Button (ghost), PromoBanner (dari Home), ListItem, BottomNav (items=3, Account aktif) |
| Updates (`ref/updates.html`) | Screen / Updates | AppBar (center, judul H3 di instance), Tag (ikon solid + counter), NotifRow (komponen UI baru) |
| Swing Credits (`ref/swing-credits.html`) | Screen / Swing Credits | AppBar (type=ads), CreditCard, AdsRow, RewardCard, AskBox (komponen UI baru), Button |
| Swing Credits history (`ref/swing-credits-history.html`) | Screen / Swing Credits history | AppBar (type=ads, tanpa action), Tag (tone=ads, size=ads: tinggi 28, dark-400), AdsRow (end=plus / end=minus: ikon bisa di-swap, jumlah + kata + chevron) |
| Personal information (`ref/personal-info.html`) | Screen / Personal information | AppBar (type=ads, tanpa action), TextField (state=locked dengan Change, state=lockedWarning dengan Verify email + ikon), Select, Caption (warning, s), Button (l, bottom bar) |
| Verify email (`ref/verify-email.html`) | Screen / Verify email | MailFoot (komponen UI baru, stores=false/true). Ini email, jadi frame-nya kolom email 357, bukan layar HP |
| Refer & earn (`ref/refer-earn.html`) | Screen / Refer & earn | AppBar (type=centerCountry), CodeCard, StatPanel, StepCard, FaqItem (komponen UI baru), Caption, Divider, Button |
| IG story (`ref/ig-story.html`) | Screen / IG story | CodeHero (baru), Button |
| Swing Pass email (`ref/swingpass-email.html`) | Screen / Swing Pass email | KvRow (baru), MailFoot (stores=true), Divider, Button. Ini email: kolom 357 |
| Swing Pass (`ref/swingpass-page.html`) | Screen / Swing Pass | AppBar (type=adsInverse), PassCard, SaveCard, PayMethod, DealCard, Perk (baru), FaqItem (ads=true), Dot, Divider, Button (tone=pass / glass) |
| Swing Pass member (`ref/swingpass-member.html`) | Screen / Swing Pass member | bagian-bagian Swing Pass, plus kotak catatan |
| Swing Pass events (`ref/swingpass-events.html`) | Screen / Swing Pass events | EventsHead, EventCard, HostCta (baru) |
| Swing Pass event (`ref/swingpass-event.html`) | Screen / Swing Pass event | AppBar (type=adsShare), PromoCard, CreditStrip, InfoTile, Venue, BrandCard (baru), Divider, Button (tone=muted / pass) |
| Join Swing Pass (`ref/swingpass-join.html`) | Screen / Join Swing Pass | NoteBar, MethodRow, Plan (baru), PayMethod (type=action), Checkbox, SlideConfirm |
| Swing Pass billing (`ref/swingpass-billing.html`) | Screen / Swing Pass billing | NoteBar, MethodRow, Button |
| Swing Pass one time (`ref/swingpass-onetime.html`) | Screen / Swing Pass one time | NoteBar, MethodRow (logo=wide, Logo/Ref/* bank logos) |
| Swing Pass QRIS (`ref/swingpass-qris.html`) | Screen / Swing Pass QRIS | NoteBar (primary), Divider, Button (danger / muted tertiary) |
| Swing Pass waiting (`ref/swingpass-waiting.html`) | Screen / Swing Pass waiting | SwingPass surface, AppBar (adsInverse), PassCard, Button (glass) |
| Swing Pass success (`ref/swingpass-success.html`) | Screen / Swing Pass success | KvRow, Divider, Button |
| Swing Pass success one time (`ref/swingpass-success-onetime.html`) | Screen / Swing Pass success one time | KvRow, Divider, Button |
| Swing Pass cancel (`ref/swingpass-cancel.html`) | Screen / Swing Pass cancel | KvRow, ChoiceRow (baru), Divider, Button |
| Swing Pass billing history (`ref/swingpass-history.html`) | Screen / Swing Pass billing history | PayMethod, BillRow (baru) |
| Tee time (`ref/teetime.html`) | Screen / Tee time | EventsHead (tee=true), ProductCard (size=l), HostCta (inset=true) |
| Golf course (`ref/golf-course.html`) | Screen / Golf course | DateBtn, SessionTab, RateCard, InclItem, Amenity, StatTile (baru), PromoCard, CreditStrip, Venue (size=s), Divider, Button |
| Booking (`ref/booking.html`) | Screen / Booking | PayType, PlayerRow, MiniRow, PriceRow, PayBar (baru), KvRow, Stepper, PayMethod, Caption, Divider |
| Booking details (`ref/booking-details.html`) | Screen / Booking details | Badge, KvRow, PlayerRow (kind=player), MiniRow, PriceRow, Caption, Divider |
| Track (`ref/track.html`) | Screen / Track | AppBar (centerCountry), StatPanel, Caption, RefRow (baru) |
| Tournament questions (`ref/tournament-questions.html`) | Screen / Tournament questions | Avatar, ChoiceRow, Button |
| Tournament confirm (`ref/tournament-confirm.html`) | Screen / Tournament confirm | KvRow, PlayerRow, MiniRow (error), PriceRow (sub), PayMethod, PayBar, Divider |

Frame layar digambar ulang tiap build, jadi yang diedit bagian-bagiannya di page masing-masing, bukan frame-nya. Home yang di-build sebelum 10 Nov masih nyimpen bagiannya di page layar. Build berikutnya mindahin ikonnya ke page Icons dan ngehapus HomeBar lama.

### Layar dari library yang udah di-publish

File yang pakai DS sebagai library (dan nggak punya token sendiri) bisa nyusun layar dari DS yang udah di-publish:

1. Di file DS: build page yang dibutuhin layar, publish library-nya (component, style, **dan** variable), terus klik **Export library keys** di tab Components. Key-nya disimpen di storage plugin, yang nempel di akun Figma lu, jadi kebaca dari file mana aja.
2. Di file lain: tambahin library-nya (Assets > Libraries), buka plugin, centang layarnya di tab **Screens**, terus Build. Layarnya isinya instance library, dan warna, spacing, sama teksnya ke-bind ke variable dan style library. Di file ini cuma layar yang bisa di-build; page DS ditolak.

Figma cuma bisa narik yang udah di-publish. Jadi abis ngubah DS: publish, Export library keys lagi, baru build ulang layarnya. Kalau ada bagian yang belum ada di library, build berhenti dan nyebutin namanya. Plugin nggak pernah bikin copy lokal. Nama component yang diawali `_` atau `.` nggak ikut ke-publish.

Urutan: Import tokens, terus Import icons, terus Build components, terus Build screens. Layar punya tab sendiri (4 · Screens), kepisah dari page DS di Components.
