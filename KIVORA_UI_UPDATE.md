# Kivora UI update

- **One Short per screen**: app shell locked to the live viewport (`100dvh`); the feed is the only scroller and each card is exactly the feed height, so the neighbouring video can no longer peek in. (Final block at the end of `src/styles.css`.)
- **Popups removed**: the "browser blocked playback / audible autoplay" toasts are gone. The in-player "Tap to play" button stays.
- **Icons**: new app icon (`public/icon*.png`, `icon.svg`, maskable + apple-touch) and a custom SVG UI icon set (`Icon`, `BrandMark` in `src/main.jsx`) replacing text glyphs.
- Service worker cache bumped to v3 so the new icons/CSS load.

## "Google hasn't verified this app"
Caused by the OAuth consent screen, not the code. In Google Cloud Console -> APIs & Services -> OAuth consent screen:
1. Set Publishing status to **In production** (Testing mode always warns; Testing allows only listed test users).
2. Fill app name, logo (public/icon-512.png), support email, home page, privacy policy and terms URLs (/privacy, /terms in the app), and add your domain under Authorized domains.
3. Click **Verify / Submit for verification**. The YouTube scopes (`youtube.force-ssl`, `youtube.readonly`) are sensitive, so Google reviews them (a demo video showing Like/Save is required). Until approved, users see the warning and can continue via Advanced -> Go to Kivora.
4. Sign-in itself only needs basic scopes (no review). Kivora already requests YouTube scopes only when a user taps Like/Save.

## Update 2
- **Ads Studio** is mobile-first: single-column cards/forms, 48px tap targets, 16px inputs (no zoom), 2-column expense monitor, wider layout only from 760px.
- **Ads Studio notes** (step cards, notice boxes) use black text on the light cards, readable in dark mode.
- **Menus** (main menu, categories, quick menu) are height-limited to the screen and scroll instead of truncating.
- **Faster video start**: YouTube player script is loaded at app start and preconnected; each Short shows its thumbnail instantly and fades it out when playback begins; off-screen pre-created players no longer autoplay (saves bandwidth); thumbnails are cached by the service worker (cache v3).

## Update 3
- Categories dropdown now anchors to the header: full-width on phones, 2-column grid, scrolls (max ~52% screen height), no more off-screen clipping. Main menu anchored the same way.
- Videos now fill the whole screen page (player scaled to cover, removing YouTube's black letterbox bars on phones); one screen = one video + its info.
- TikTok-style thin light lines mark the top and bottom edge of every video screen.
