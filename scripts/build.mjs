import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

// Build every pack under packs/<name>/ into dist/<id>.garret. A widget is a ui/<widget>/ dir with an
// index.html. If it has a main.tsx, it's a React widget → esbuild bundles it self-contained (CSP
// script-src 'self', no CDN); otherwise it's vanilla and we copy it as-is. Shared code (dirs without
// index.html, e.g. ui/lib) is pulled in by the bundler, not copied. CI attaches dist/*.garret to the
// GitHub Release — binaries never live in source.
const root = resolve(process.cwd())
const packsDir = join(root, 'packs')
const outDir = join(root, 'dist')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const packs = readdirSync(packsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)

for (const name of packs) {
  const dir = join(packsDir, name)
  const manifestPath = join(dir, 'garret.manifest.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const { id } = manifest
  const stage = join(outDir, `.stage-${name}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'dist'), { recursive: true })
  cpSync(manifestPath, join(stage, 'garret.manifest.json'))

  // Bundle the pack's icon (manifest.icon) + README (manifest.readme, default README.md) + each
  // widget's preview screenshot (widget.preview) at the .garret root, next to the manifest — the app
  // reads them from there for the Discover/details UI + the Add-widget gallery.
  const assets = [manifest.icon, manifest.readme || 'README.md', ...(manifest.widgets || []).map((w) => w.preview)]
  for (const rel of assets) {
    if (rel && !rel.includes('..') && existsSync(join(dir, rel))) {
      mkdirSync(join(stage, rel, '..'), { recursive: true })
      cpSync(join(dir, rel), join(stage, rel))
    }
  }

  const uiDir = join(dir, 'ui')
  if (existsSync(uiDir)) {
    for (const w of readdirSync(uiDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const src = join(uiDir, w.name)
      if (!existsSync(join(src, 'index.html'))) continue // shared lib etc. — reachable via import
      const dest = join(stage, 'dist', w.name)
      mkdirSync(dest, { recursive: true })
      cpSync(join(src, 'index.html'), join(dest, 'index.html'))
      const entry = join(src, 'main.tsx')
      if (existsSync(entry)) {
        await build({
          entryPoints: [entry],
          bundle: true,
          format: 'esm',
          jsx: 'automatic',
          minify: true,
          target: ['chrome122'],
          define: { 'process.env.NODE_ENV': '"production"' },
          outfile: join(dest, 'app.js')
        })
      } else {
        for (const f of readdirSync(src)) if (f !== 'index.html') cpSync(join(src, f), join(dest, f), { recursive: true })
      }
    }
  }

  // Host (optional): a widget with a Node `host` → compile host/index.ts to dist/host/index.cjs (the
  // utilityProcess forks this). platform:node keeps Node builtins external; deps are inlined.
  const hostEntry = join(dir, 'host', 'index.ts')
  if (existsSync(hostEntry)) {
    await build({
      entryPoints: [hostEntry],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: ['node20'],
      minify: true,
      outfile: join(stage, 'dist', 'host', 'index.cjs')
    })
    // Ship any host assets (e.g. scrcpy-server.jar) NEXT TO the compiled host — the host reads them
    // via __dirname at runtime.
    const assets = join(dir, 'host', 'assets')
    if (existsSync(assets)) cpSync(assets, join(stage, 'dist', 'host'), { recursive: true })
  }

  const out = join(outDir, `${id}.garret`)
  rmSync(out, { force: true })
  execFileSync('zip', ['-qr', out, '.'], { cwd: stage })
  rmSync(stage, { recursive: true, force: true })
  console.log(`built ${id} → dist/${id}.garret`)
}
