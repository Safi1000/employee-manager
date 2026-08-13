// Render the launcher icon and splash sources for @capacitor/assets.
//
// The sources are generated rather than committed as hand-drawn PNGs because
// the only brand artwork in the repo is a 500px logo.png — upscaled to the
// 1024px Apple requires it is visibly soft. The mark is the same shield the
// sidebar draws (components/Sidebar.tsx → BrandMark), so it is redrawn here as
// vector and rasterised at whatever size each platform wants, sharp at all of
// them.
//
//   npm run assets:gen
//
// writes assets/{icon,icon-foreground,icon-background,splash,splash-dark}.png,
// which `npx capacitor-assets generate` then fans out into every Android
// density bucket and every iOS slot.

import sharp from "sharp";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const AMBER = "#e9a73c";
const INK = "#0B0F14"; // matches SplashScreen.backgroundColor in capacitor.config.ts

/** The shield, drawn on a 32×32 grid, scaled to fill `size` at `scale`. */
const shield = (size, scale, colour) => {
  const s = size * scale;
  const off = (size - s) / 2;
  return `
    <g transform="translate(${off} ${off}) scale(${s / 32})">
      <path d="M16 2.5 4.5 7v8.5c0 6.6 4.7 10.5 11.5 13.3C22.8 25.9 27.5 22 27.5 15.5V7z"
            fill="none" stroke="${colour}" stroke-width="1.8"/>
      <path d="M13 15.5a3 3 0 0 1 3-3 3 3 0 0 1 3 3 3 3 0 0 1-3 3M19 16.5a3 3 0 0 1-3 3 3 3 0 0 1-3-3 3 3 0 0 1 3-3"
            fill="none" stroke="${colour}" stroke-width="1.8"
            stroke-linecap="round"/>
    </g>`;
};

const svg = (size, scale, bg) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${bg ? `<rect width="${size}" height="${size}" fill="${bg}"/>` : ""}
    ${shield(size, scale, AMBER)}
  </svg>`;

const write = (name, markup, size) =>
  sharp(Buffer.from(markup))
    .resize(size, size)
    .png()
    .toFile(`assets/${name}.png`)
    .then(() => console.log(`assets/${name}.png`));

await mkdir("assets", { recursive: true });

await Promise.all([
  // iOS + legacy Android launcher: the mark filling most of a solid tile.
  write("icon", svg(1024, 0.62, INK), 1024),

  // Android adaptive icon. The launcher masks the foreground to a
  // circle/squircle and then insets it a further 16.7%, so the mark is drawn
  // on a transparent layer and sized to survive both crops.
  write("icon-foreground", svg(1024, 0.6, null), 1024),
  write("icon-background", svg(1024, 0, INK), 1024),

  // Splash. 2732² is the size Capacitor slices every orientation out of, and
  // the mark stays small because the outer edges get cropped on tall phones.
  write("splash", svg(2732, 0.16, INK), 2732),
  write("splash-dark", svg(2732, 0.16, INK), 2732),
]);

// Fan the sources out into every Android density bucket and iOS slot.
execFileSync(
  "npx",
  [
    "capacitor-assets",
    "generate",
    "--iconBackgroundColor", INK,
    "--iconBackgroundColorDark", INK,
    "--splashBackgroundColor", INK,
    "--splashBackgroundColorDark", INK,
  ],
  { stdio: "inherit", shell: process.platform === "win32" },
);

// capacitor-assets writes an adaptive icon whose BACKGROUND layer is inset by
// 16.7% as well as the foreground. Any launcher whose mask is wider than that
// — several OEM skins are — then shows transparent corners where the tile
// should be solid. Rewritten here, after generation, because the generator
// overwrites these two files every run.
const adaptiveIcon = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground>
        <inset android:drawable="@mipmap/ic_launcher_foreground" android:inset="16.7%" />
    </foreground>
</adaptive-icon>
`;
const mipmap = "android/app/src/main/res/mipmap-anydpi-v26";
for (const name of ["ic_launcher", "ic_launcher_round"]) {
  await writeFile(`${mipmap}/${name}.xml`, adaptiveIcon);
}
// The flat colour that background now points at. Kept in step with INK.
await writeFile(
  "android/app/src/main/res/values/ic_launcher_background.xml",
  `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${INK}</color>\n</resources>\n`,
);
console.log("adaptive icon background flattened");

// A PWA icon set and manifest are generated whether asked for or not, and this
// app is not installed as a PWA — the web build is served by Vercel from
// dist/, and the manifest points at ../icons paths that do not resolve there.
await rm("icons", { recursive: true, force: true });
await rm("public/manifest.webmanifest", { force: true });
