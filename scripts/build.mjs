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
  const { id } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const stage = join(outDir, `.stage-${name}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(join(stage, 'dist'), { recursive: true })
  cpSync(manifestPath, join(stage, 'garret.manifest.json'))

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

  const out = join(outDir, `${id}.garret`)
  rmSync(out, { force: true })
  execFileSync('zip', ['-qr', out, '.'], { cwd: stage })
  rmSync(stage, { recursive: true, force: true })
  console.log(`built ${id} → dist/${id}.garret`)
}
