// scripts/build-dist.js – baut ein frisches dist/ plattformübergreifend
// (Linux/macOS/Windows) für Web-Release und Tauri beforeBuildCommand.
const fs = require('fs');
const path = require('path');

const root = process.env.BUILD_ROOT || process.cwd();
const dist = process.env.DIST_DIR || path.join(root, 'dist');

function copy(relativePath, options = undefined) {
  const src = path.join(root, relativePath);
  const dst = path.join(dist, relativePath);
  fs.cpSync(src, dst, options);
}

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

for (const file of ['index.html', 'manifest.webmanifest', 'sw.js', 'altes_Papier.png', 'llms.txt', 'FEDERWERK_FORMAT.md', 'federwerk.schema.json']) {
  copy(file);
}
for (const dir of ['css', 'js', 'icons', 'screenshots']) {
  copy(dir, { recursive: true });
}

function listFiles(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(full, base, out);
    } else {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

for (const file of listFiles(dist).sort()) {
  console.log(`dist/${file}`);
}
