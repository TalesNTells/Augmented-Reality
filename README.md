# Tales 'N' Tells — AR

A small AR site that brings your registered artworks to life through the phone camera.

- **Visitors**: open the site (or scan the QR code next to an artwork with the normal phone camera) → tap **Open camera** → point it at any registered artwork → the animation plays on top of the art and stays locked to it. A QR code is just a shortcut: it opens the same camera page with that artwork's preview, and the camera still recognises *every* registered artwork, QR code or not.
- **You**: log in to `/admin`, upload the artwork photo + its animation video, get the QR code. That's it.

Only artworks you have registered are recognised. Anything else does nothing.

Design (fonts, colours, logo, day/night mode) is taken from the main Tales 'N' Tells site.

---

## 1. Put it online (Vercel)

1. Push this folder to a GitHub repo (or run `npx vercel` inside it).
2. In Vercel: **New Project → import the repo → Deploy** (no build settings needed).
3. In the project: **Storage → Create → Blob**, and connect it to the project. This is where artwork images, videos and tracking files are kept.
4. **Settings → Environment Variables** → add:
   - `ADMIN_PASSWORD` — your admin password (use something long)
   - `AUTH_SECRET` — optional, any random string (signs the login cookie)
5. **Redeploy** (Deployments → ⋯ → Redeploy) so the variables and Blob store take effect.
6. Open `https://your-site.vercel.app/admin` and log in.

Optional: add a custom domain such as `ar.yourdomain.com` (Settings → Domains). **Do this before printing any QR codes** — QR codes contain the web address.

Then open `public/js/config.js` and set `mainSite` to your main website's address so the "Main site" links appear.

## 2. Add an artwork

1. `/admin` → **+ New artwork**
2. Type a title, drop in the **artwork photo** (the clearest, flattest, best-lit picture of the finished piece) and the **animation video**.
3. Press **Bring it to life**. Your browser then:
   - compiles the tracking data for that artwork,
   - uploads the three files,
   - rebuilds the combined scanner so the main page can find it too.
   Keep the tab open until it finishes (a few seconds to a minute or two).
4. Click **QR code** on the artwork → download PNG/SVG → print it and put it next to the artwork.

You can **Pause** an artwork (hides it without deleting), **Edit** it (title, replace video or photo — the QR code never changes), or **Delete** it.

## 3. Getting good tracking ("kept on track")

The camera recognises an artwork by its fine detail, so some art tracks better than other art.

| Tracks well | Tracks badly |
| --- | --- |
| Detailed, high-contrast, textured, busy artwork (comic pages, illustrations with linework) | Large flat colour areas, soft gradients, minimal designs |
| A flat print / canvas with matte finish | Glossy surfaces that reflect lights, curved or folded surfaces |
| Photo taken straight-on, evenly lit, sharp | Photo with glare, tilt, or shadows |

The admin gives a quick "will it track?" hint when you add the photo. The real test is always pointing a phone at it — test each new piece in the place it'll be displayed.

**Video tips**
- Export the video in the **same shape as the artwork** (portrait art → portrait video). Otherwise it's cropped to fill the artwork; the admin warns you.
- Use **MP4 (H.264)**. Keep it under ~20 MB so it starts fast on mobile data.
- It loops automatically and starts muted (phones require this); a speaker button lets the viewer turn sound on.
- Transparent (alpha) video is not supported — the video fully covers the artwork.

How it stays locked on: MindAR tracks the artwork every frame and smooths the position; short losses (hand shake, blink of glare) are forgiven; if it's truly lost, the animation pauses and resumes on the same frame when found again. The screen is kept awake while the camera is open, and the camera restarts itself if the phone was locked and the OS stopped it.

Tuning knobs are in `public/js/config.js` (`missTolerance`, `warmupTolerance`, `maxTrack`).

## 4. Run it on your computer (optional)

```bash
npm install        # only needed if you want the Blob client locally; not required for local mode
npm run dev        # http://localhost:3000   admin password: "admin" (or $ADMIN_PASSWORD)
```

With no Blob token set, files are saved to `./.data` instead. Phones need **https** for the camera, so to try it on a phone either deploy, or tunnel (`npx localtunnel --port 3000`).

## How it works / files

```
public/index.html        visitor page (/ and /a/<slug>)
public/admin.html        admin page (/admin)
public/js/app.js         camera + AR logic (three.js + MindAR, loaded from CDN)
public/js/admin.js       admin UI, tracking-file compiler, uploads, QR codes
public/js/config.js      settings
public/css/site.css      Tales 'N' Tells design system
api/artworks.js          public, read-only list of registered artworks
api/admin.js             login, upload handshake, save/delete (password protected)
api/_lib/                auth + storage (Vercel Blob in production, ./.data locally)
vercel.json              /a/<slug> and /admin routes
```

- Each artwork gets its own tracking file (fast, used by its QR page) **and** is included in one combined file (used by the main scanner). The combined file is rebuilt in the admin's browser whenever an artwork is added, changed or removed — with dozens of artworks, expect that step to take a minute or two.
- QR codes are generated inside the site (`public/js/qr.js`, no outside library). The AR libraries (MindAR 1.2.5, three.js 0.147) load from jsDelivr/unpkg. If you ever change the MindAR version, change it in **both** `public/index.html` (the import map) and `public/js/config.js` (`compilerUrl`), then press **Rebuild scanner** in the admin and re-save artworks whose tracking data was built with the old version.
- Security: the admin is protected by a password and a signed, HTTP-only cookie; all admin writes also need a custom header; uploaded paths and URLs are validated. Artwork images and videos are, by design, publicly readable (visitors' phones must load them).

## Known limits

- Works in current Safari (iPhone) and Chrome (Android). In-app browsers (Instagram/Facebook) sometimes block the camera — if someone scans a QR from inside such an app, they may need "Open in Safari/Chrome".
- Vercel Hobby (free) plan is enough to start; Blob storage has its own free allowance — check Vercel's current limits if you host lots of large videos.
