// Copies the static web app into www/, which Capacitor bundles into the Android app.
import { cpSync, rmSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');
const files = ['index.html', 'style.css', 'app.js', 'config.js', 'social-core.js', 'areas.js', 'social.js', 'privacy.html', 'sw.js', 'manifest.webmanifest', 'icons', 'vendor'];

rmSync(out, { recursive: true, force: true });
mkdirSync(out);
for (const f of files) cpSync(join(root, f), join(out, f), { recursive: true });
console.log(`Copied ${files.length} entries to www/`);
