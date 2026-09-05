import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkedExtensionBuild } from './extension-build.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
export const providerFiles = [
  'extension/manifest.json', 'extension/build-info.js', 'extension/content-script.js', 'extension/service-worker.js', 'extension/lifecycle.js',
  'src/chatgpt.mjs', 'src/store.mjs', 'src/native-messaging.mjs', 'src/mcp-stdio.mjs', 'src/cli.mjs', 'src/extension-control.mjs', 'src/conversation-tools.mjs', 'src/provider-server.mjs',
  'scripts/extension-build.mjs', 'scripts/install-native-host.mjs', 'scripts/test.mjs',
  'install/platform-link.mjs', 'install/install-host.mjs', 'install/conversation-sidecar-host', 'install/conversation-sidecar-host.bat', 'install/install-host-win.bat',
  'skills/chatgpt-subagents/SKILL.md', '.github/workflows/test.yml',
  'test/cli.test.mjs', 'test/install.test.mjs', 'test/chatgpt.test.mjs', 'test/store.test.mjs', 'test/native-messaging.test.mjs', 'test/mcp-stdio.test.mjs',
  'test/content-script-runtime.test.mjs', 'test/extension-runtime.test.mjs', 'test/extension.test.mjs',
  'test/extension-update.test.mjs', 'test/extension-build.test.mjs', 'test/provider-server.test.mjs', 'test/native-host-installer.test.mjs', 'test/windows-runtime.test.mjs'
]

export async function exportProvider(destination) {
  const build = await checkedExtensionBuild()
  const output = resolve(destination)
  if (output === resolve(root)) throw new Error('Export requires a new empty directory, not the source checkout')
  // Never overwrite an existing installation, checkout or generated artifact.
  await mkdir(output)
  for (const file of providerFiles) {
    const target = join(output, file)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(join(root, file), target)
  }
  await copyFile(join(root, 'standalone/LICENSE'), join(output, 'LICENSE'))
  await copyFile(join(root, 'standalone/server-entry.mjs'), join(output, 'src/server.mjs'))
  await copyFile(join(root, 'docs/extension-update.md'), join(output, 'README.md'))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  pkg.name = 'chatgpt-conversation'
  pkg.version = '0.1.1'
  delete pkg.scripts['build:provider']
  await writeFile(join(output, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  await writeFile(join(output, '.gitignore'), 'node_modules/\ndata/\n*.log\n')
  await writeFile(join(output, 'PROVENANCE.json'), `${JSON.stringify({ source: 'conversation-sidecar shared provider export', ...build, files: providerFiles }, null, 2)}\n`)
  return { output, ...build, fileCount: providerFiles.length + 6 }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3) throw new Error('Usage: node scripts/export-provider.mjs [new-output-directory]')
  const output = process.argv[2] ?? join(root, 'dist', 'chatgpt-conversation')
  await mkdir(dirname(output), { recursive: true })
  console.log(JSON.stringify(await exportProvider(output)))
}
