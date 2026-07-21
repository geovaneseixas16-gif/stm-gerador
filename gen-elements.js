// Build step v4: splits the template into a clean background, recolourable corner
// ornaments and movable sprites.
//
// Outputs (all 944x1680 unless noted):
//   public/bg_plain.png     - dark mesh only: ornaments removed, left-edge artefact fixed
//   public/orn_purple.png   - alpha mask of the PURPLE ornament shapes (white RGB + alpha)
//   public/orn_white.png    - alpha mask of the WHITE ornament shapes
//   public/sprite_logo.png     - circular STM avatar (+glow)
//   public/sprite_username.png - @STMSTORECONTAS
//   public/sprite_footer.png   - "ADQUIRA KEYS STEAM..."
//   public/sprite_button.png   - stmstore.shop pill + hand cursor
//
// Element geometry (native 944x1680) is mirrored in public/index.html DEFAULTS.
const fs = require('fs');
const { PNG } = require('pngjs');

const src = PNG.sync.read(fs.readFileSync('public/template_full.png'));
const patch = PNG.sync.read(fs.readFileSync('erase_patch.png'));
const { width, height } = src;

// ---------------------------------------------------------------------------
// 0. FIX the baked-in artefact: the original art has a light-grey 1-2px column
//    down the left edge (x=0 reads ~133 brightness vs ~10 for the mesh), which
//    showed up as a thin white line on the finished post. Copy the first clean
//    column (x=2) over x=0 and x=1 — where a real ornament touches the edge the
//    source column is the ornament itself, so the artwork is preserved.
// ---------------------------------------------------------------------------
for (let y = 0; y < height; y++) {
  const si = (y * width + 2) * 4;
  for (const x of [0, 1]) {
    const di = (y * width + x) * 4;
    for (let k = 0; k < 4; k++) src.data[di + k] = src.data[si + k];
  }
}

const px = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const clamp01 = v => Math.min(Math.max(v, 0), 1);

// ---------------------------------------------------------------------------
// 1. movable sprites (cut from the original art)
// ---------------------------------------------------------------------------
function makeSprite(x0, y0, w, h, alphaFn, name) {
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = px(src, x0 + x, y0 + y);
      const a = clamp01(alphaFn(x0 + x, y0 + y, r, g, b));
      const di = (y * w + x) * 4;
      out.data[di] = r; out.data[di + 1] = g; out.data[di + 2] = b;
      out.data[di + 3] = Math.round(a * 255);
    }
  }
  fs.writeFileSync('public/' + name, PNG.sync.write(out));
  console.log(' ', name, w + 'x' + h);
}

// logo: circle centre (140,155) r107 plus purple glow feathered to r124.
// The glow wedge reaching the "@" (x>=244) is masked so no ghost text tags along.
makeSprite(16, 31, 249, 249, (x, y) => {
  if (x >= 244) return 0;
  const d = Math.hypot(x - 140, y - 155);
  return d <= 107 ? 1 : 1 - (d - 107) / 17;
}, 'sprite_logo.png');

const lumaKey = (x, y, r, g, b) => (Math.max(r, g, b) - 20) / 60;
makeSprite(244, 128, 404, 48, lumaKey, 'sprite_username.png');
makeSprite(282, 1342, 380, 92, lumaKey, 'sprite_footer.png');

function rrectAlpha(x, y, l, t, rgt, btm, rad) {
  const cx = (l + rgt) / 2, cy = (t + btm) / 2;
  const hw = (rgt - l) / 2 - rad, hh = (btm - t) / 2 - rad;
  const qx = Math.max(Math.abs(x - cx) - hw, 0);
  const qy = Math.max(Math.abs(y - cy) - hh, 0);
  return clamp01(0.75 - (Math.hypot(qx, qy) - rad));
}
makeSprite(285, 1462, 386, 95, (x, y, r, g, b) => {
  const rect = rrectAlpha(x, y, 292, 1468, 658, 1518, 14);
  const cursor = (x > 578 && y > 1512) ? (Math.max(r, g, b) - 35) / 55 : 0;
  return Math.max(rect, cursor);
}, 'sprite_button.png');

// ---------------------------------------------------------------------------
// 2. background with every movable/editable thing erased
// ---------------------------------------------------------------------------
const bg = new PNG({ width, height });
src.data.copy(bg.data);

function fillMesh(x0, y0, x1, y1) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const si = (((y - y0) % patch.height) * patch.width + ((x - x0) % patch.width)) * 4;
      const di = (y * width + x) * 4;
      for (let k = 0; k < 4; k++) bg.data[di + k] = patch.data[si + k];
    }
  }
}
fillMesh(0, 31, 270, 290);      // logo + glow
fillMesh(244, 128, 648, 176);   // username
fillMesh(110, 298, 870, 446);   // headline band
fillMesh(46, 477, 899, 1269);   // purple video square
fillMesh(282, 1342, 662, 1434); // footer
fillMesh(285, 1462, 671, 1557); // button + cursor

// ---------------------------------------------------------------------------
// 3. corner ornaments -> two recolourable alpha masks, then erase them from bg
//    Mesh brightness tops out around 19, solid ornament is ~253: threshold 18
//    with a ramp keeps the anti-aliased edges smooth.
// ---------------------------------------------------------------------------
const ORN_REGIONS = [
  { x0: 745, y0: 0,    x1: 943, y1: 145  }, // top-right
  { x0: 0,   y0: 1285, x1: 170, y1: 1679 }, // bottom-left
  { x0: 695, y0: 1490, x1: 943, y1: 1679 }, // bottom-right
];

const ornPurple = new PNG({ width, height });
const ornWhite = new PNG({ width, height });
for (const r of ORN_REGIONS) {
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const [R, G, B] = px(bg, x, y);
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      const a = clamp01((mx - 18) / 230);
      if (a <= 0) continue;
      const sat = mx ? (mx - mn) / mx : 0;
      const target = sat < 0.18 ? ornWhite : ornPurple; // greys -> white shapes
      const di = (y * width + x) * 4;
      target.data[di] = 255; target.data[di + 1] = 255; target.data[di + 2] = 255;
      target.data[di + 3] = Math.round(a * 255);
    }
  }
  fillMesh(r.x0, r.y0, r.x1, r.y1); // wipe the ornament area back to plain mesh
}

fs.writeFileSync('public/orn_purple.png', PNG.sync.write(ornPurple));
fs.writeFileSync('public/orn_white.png', PNG.sync.write(ornWhite));
fs.writeFileSync('public/bg_plain.png', PNG.sync.write(bg));
console.log('  orn_purple.png / orn_white.png / bg_plain.png', width + 'x' + height);
