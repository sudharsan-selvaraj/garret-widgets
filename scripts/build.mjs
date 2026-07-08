import { cpSync, mkdirSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'

// Build every pack under packs/<name>/ into dist/<id>.garret. A pack is garret.manifest.json + a
// ui/ tree (source); the manifest references those UIs under dist/, so we copy ui/ → dist/ in a
// staging dir and zip it. CI (.github/workflows/release.yml) runs this and attaches dist/*.garret
// to the GitHub Release — binaries never live in source.
const root = resolve(process.cwd())
const packsDir = join(root, 'packs')
const outDir = join(root, 'dist')

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const names = readdirSync(packsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

for (const name of names) {
  const dir = join(packsDir, name)
  const manifestPath = join(dir, 'garret.manifest.json')
  if (!existsSync(manifestPath)) continue
  const { id } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const stage = join(outDir, `.stage-${name}`)
  rmSync(stage, { recursive: true, force: true })
  mkdirSync(stage, { recursive: true })
  cpSync(manifestPath, join(stage, 'garret.manifest.json'))
  // ui/<widget> (source) → dist/<widget> (the manifest's `ui` paths).
  if (existsSync(join(dir, 'ui'))) cpSync(join(dir, 'ui'), join(stage, 'dist'), { recursive: true })
  const out = join(outDir, `${id}.garret`)
  rmSync(out, { force: true })
  execFileSync('zip', ['-qr', out, '.'], { cwd: stage })
  rmSync(stage, { recursive: true, force: true })
  console.log(`built ${id} → dist/${id}.garret`)
}
