import fs from 'node:fs/promises';
import path from 'node:path';

const cwd = process.cwd();
const wheelsDir = path.resolve(cwd, 'data', 'wheels');
const vendorDir = path.resolve(cwd, 'data', 'python-vendor');

function normalizeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[-_.]+/g, '-');
}

function extractRequirementName(requirement) {
  const source = String(requirement || '').split(';', 1)[0].trim();
  const match = source.match(/^([A-Za-z0-9_.-]+)/);
  return match ? normalizeName(match[1]) : null;
}

function isCompatibleWheel(filename) {
  return filename.endsWith('.whl') && (
    filename.includes('py3-none-any') ||
    filename.includes('py2.py3-none-any') ||
    (filename.includes('cp312') && filename.includes('win_amd64'))
  );
}

function wheelRank(filename) {
  if (filename.includes('py3-none-any')) {
    return 3;
  }
  if (filename.includes('py2.py3-none-any')) {
    return 2;
  }
  if (filename.includes('cp312') && filename.includes('win_amd64')) {
    return 1;
  }
  return 0;
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }
  return response.json();
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, buffer);
}

async function extractWheel(wheelPath) {
  const zip = await import('node:zlib').catch(() => null);
  void zip;
  const AdmZip = null;
  // Use Python zipfile through the bundled runtime-agnostic launcher.
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '-e',
      [
        "const fs=require('fs');",
        "const { spawnSync } = require('child_process');",
        `const py=${JSON.stringify(process.env.PYTHON_BIN || '')};`,
        `const wheel=${JSON.stringify(wheelPath)};`,
        `const target=${JSON.stringify(vendorDir)};`,
        "const cmd = py || 'python';",
        "const result = spawnSync(cmd, ['-c', \"import zipfile; zipfile.ZipFile(r'''\" + wheel + \"''').extractall(r'''\" + target + \"''')\"], { stdio: 'inherit', shell: false });",
        "process.exit(result.status || 0);"
      ].join(' ')
    ], {
      stdio: 'inherit',
      env: process.env
    });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Wheel extract failed: ${wheelPath}`))));
    child.on('error', reject);
  });
}

async function readWheelMetadata(wheelPath) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python', [
      '-c',
      [
        'import email, json, zipfile, sys',
        'wheel = sys.argv[1]',
        'with zipfile.ZipFile(wheel) as z:',
        "    meta = [n for n in z.namelist() if n.endswith('METADATA')][0]",
        '    message = email.message_from_bytes(z.read(meta))',
        "    print(json.dumps(message.get_all('Requires-Dist') or []))"
      ].join('\n'),
      wheelPath
    ], {
      stdio: ['ignore', 'pipe', 'inherit'],
      env: process.env
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Metadata read failed: ${wheelPath}`));
        return;
      }

      resolve(JSON.parse(output.trim() || '[]'));
    });
    child.on('error', reject);
  });
}

async function vendorPackage(packageName, visited) {
  const normalized = normalizeName(packageName);
  if (!normalized || visited.has(normalized)) {
    return;
  }
  visited.add(normalized);

  const metadata = await fetchJson(`https://pypi.org/pypi/${normalized}/json`);
  const candidates = (metadata.urls || [])
    .filter((file) => isCompatibleWheel(file.filename))
    .sort((left, right) => wheelRank(right.filename) - wheelRank(left.filename));

  if (candidates.length === 0) {
    throw new Error(`No compatible wheel found for ${normalized}`);
  }

  const wheel = candidates[0];
  const wheelPath = path.join(wheelsDir, wheel.filename);
  try {
    await fs.access(wheelPath);
  } catch {
    await downloadFile(wheel.url, wheelPath);
  }

  await extractWheel(wheelPath);

  const requirements = await readWheelMetadata(wheelPath);
  for (const requirement of requirements) {
    const dependency = extractRequirementName(requirement);
    if (!dependency) {
      continue;
    }
    await vendorPackage(dependency, visited);
  }
}

async function main() {
  const packages = process.argv.slice(2);
  if (packages.length === 0) {
    throw new Error('Usage: node scripts/vendor-python-package.mjs <package> [package...]');
  }

  await ensureDir(wheelsDir);
  await ensureDir(vendorDir);

  const visited = new Set();
  for (const packageName of packages) {
    await vendorPackage(packageName, visited);
  }

  console.log(`Vendored ${visited.size} package(s) into ${vendorDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
