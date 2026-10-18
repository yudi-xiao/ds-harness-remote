#!/usr/bin/env node
/**
 * EAS Build post-install hook.
 *
 * EAS uploads the pnpm workspace and runs `pnpm install`, but it does not run
 * this repository's local preparation scripts. Metro needs the workspace
 * packages' `dist` builds and the bundled xterm / PDF.js renderer sources that
 * apps/android's check and CI workflows normally generate, so produce them here
 * before Expo prebuild and the Gradle release build start.
 *
 * The Intelligent UI renderer is optional (the app falls back safely when it is
 * not present) unless DSH_REQUIRE_INTELLIGENT_UI is set.
 */
import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(appRoot, '../..')

function run(command, args, cwd) {
  console.log(`[eas-post-install] ${command} ${args.join(' ')}`)
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env })
}

// pnpm is the detected workspace package manager on the EAS Android image.
run('pnpm', ['--filter', './packages/**', '-r', 'build'], repoRoot)
run(process.execPath, ['scripts/build-terminal.mjs'], appRoot)
run(process.execPath, ['scripts/build-pdf.mjs'], appRoot)
run(process.execPath, ['scripts/build-intelligent-ui.mjs'], appRoot)
