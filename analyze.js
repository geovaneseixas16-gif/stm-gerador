const fs = require('fs');
const { PNG } = require('pngjs');

const png = PNG.sync.read(fs.readFileSync(process.argv[2] || 'public/template.png'));
const { width, height, data } = png;
console.log('Image size:', width, 'x', height);

function px(x, y) {
  const i = (y * width + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}
const isPurple = (r, g, b) => r > 120 && r < 200 && g < 90 && b > 200;
const isWhite = (r, g, b) => r > 200 && g > 200 && b > 200;

// Bounding box of the big purple square (only count rows/cols with long purple runs)
let minX = width, maxX = -1, minY = height, maxY = -1;
for (let y = 0; y < height; y++) {
  let run = 0, best = 0, runStart = 0, bestStart = 0;
  for (let x = 0; x < width; x++) {
    const [r, g, b] = px(x, y);
    if (isPurple(r, g, b)) { if (run === 0) runStart = x; run++; if (run > best) { best = run; bestStart = runStart; } }
    else run = 0;
  }
  if (best > width * 0.5) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (bestStart < minX) minX = bestStart;
    if (bestStart + best - 1 > maxX) maxX = bestStart + best - 1;
  }
}
console.log('Purple square bbox: x', minX, '-', maxX, ' y', minY, '-', maxY);
console.log('Square size:', maxX - minX + 1, 'x', maxY - minY + 1);

// Corner radius: how many rows from top until the row reaches full width
let radius = 0;
for (let y = minY; y < minY + 200; y++) {
  let first = -1, last = -1;
  for (let x = minX; x <= maxX; x++) {
    const [r, g, b] = px(x, y);
    if (isPurple(r, g, b)) { if (first < 0) first = x; last = x; }
  }
  if (first <= minX + 2 && last >= maxX - 2) { radius = y - minY; break; }
}
console.log('Approx corner radius:', radius);

// White text bbox in region between y=0 and top of square, excluding the top-left logo/username row
let tMinX = width, tMaxX = -1, tMinY = height, tMaxY = -1;
for (let y = Math.round(height * 0.13); y < minY; y++) {
  for (let x = 0; x < width; x++) {
    const [r, g, b] = px(x, y);
    if (isWhite(r, g, b)) {
      if (x < tMinX) tMinX = x;
      if (x > tMaxX) tMaxX = x;
      if (y < tMinY) tMinY = y;
      if (y > tMaxY) tMaxY = y;
    }
  }
}
console.log('Text bbox: x', tMinX, '-', tMaxX, ' y', tMinY, '-', tMaxY);
console.log('Text block height:', tMaxY - tMinY + 1, 'center y:', (tMinY + tMaxY) / 2);

// Line detection: rows in text region that contain white pixels (to count lines / line height)
let rows = [];
for (let y = tMinY; y <= tMaxY; y++) {
  let has = false;
  for (let x = 0; x < width; x++) {
    const [r, g, b] = px(x, y);
    if (isWhite(r, g, b)) { has = true; break; }
  }
  rows.push(has ? 1 : 0);
}
// find gaps
let segs = [], start = -1;
for (let i = 0; i < rows.length; i++) {
  if (rows[i] && start < 0) start = i;
  if (!rows[i] && start >= 0) { segs.push([tMinY + start, tMinY + i - 1]); start = -1; }
}
if (start >= 0) segs.push([tMinY + start, tMaxY]);
console.log('Text line segments (y ranges):', JSON.stringify(segs));

// Background color samples (pattern area, away from content)
console.log('BG samples:', px(Math.round(width/2), Math.round((maxY + height)/2 - 60)), px(60, Math.round(height*0.16)), px(width - 60, Math.round(height*0.5)));
