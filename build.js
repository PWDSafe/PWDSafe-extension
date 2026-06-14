#!/usr/bin/env node
// Builds dist/firefox and dist/chrome from the shared src/ tree.
//
// Both targets share the same file layout (background.js, content.js,
// lib/, options/, popup/). The only differences are:
// - the `browser.*` vs `chrome.*` extension API namespace
// - manifest.json (background config, icon formats, gecko settings)

import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const targets = {
    firefox: { namespace: null },
    chrome: { namespace: 'chrome' },
}

function copyTree(src, dest, transform) {
    mkdirSync(dest, { recursive: true })
    for (const entry of readdirSync(src)) {
        const srcPath = join(src, entry)
        const destPath = join(dest, entry)
        if (statSync(srcPath).isDirectory()) {
            copyTree(srcPath, destPath, transform)
        } else if (entry.endsWith('.js') && transform) {
            writeFileSync(destPath, transform(readFileSync(srcPath, 'utf8')))
        } else {
            copyFileSync(srcPath, destPath)
        }
    }
}

function buildTarget(name) {
    const { namespace } = targets[name]
    const outDir = join(root, 'dist', name)

    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })

    const transform = namespace ? (code) => code.replace(/\bbrowser\./g, `${namespace}.`) : null
    copyTree(join(root, 'src'), outDir, transform)
    copyTree(join(root, 'icons'), join(outDir, 'icons'))

    const manifest = JSON.parse(readFileSync(join(root, `manifest.${name}.json`), 'utf8'))
    manifest.version = pkg.version
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

    console.log(`Built dist/${name}`)
}

const requested = process.argv.slice(2)
const names = requested.length ? requested : Object.keys(targets)

for (const name of names) {
    if (!targets[name]) {
        console.error(`Unknown target: ${name} (expected: ${Object.keys(targets).join(', ')})`)
        process.exit(1)
    }
    buildTarget(name)
}
