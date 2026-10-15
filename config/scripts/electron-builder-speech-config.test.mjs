import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const electronBuilderConfig = require('../electron-builder.config.cjs')
const { FileMatcher } = require('app-builder-lib/out/fileMatcher')

describe('electron-builder speech resources', () => {
  it('omits incompatible speech resources only for the explicit Windows ARM64 package', () => {
    const configPath = require.resolve('../electron-builder.config.cjs')
    const previous = process.env.ORCA_WINDOWS_ARM64_PACKAGE
    try {
      process.env.ORCA_WINDOWS_ARM64_PACKAGE = '1'
      delete require.cache[configPath]
      const config = require('../electron-builder.config.cjs')
      expect(
        config.win.extraResources.some((resource) =>
          resource.to.startsWith('node_modules/sherpa-onnx')
        )
      ).toBe(false)
      expect(config.nsis.artifactName).toBe('orca-windows-arm64-setup.${ext}')
      expect(config.mac.extraResources).toEqual(electronBuilderConfig.mac.extraResources)
      expect(config.linux.extraResources).toEqual(electronBuilderConfig.linux.extraResources)
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_WINDOWS_ARM64_PACKAGE
      } else {
        process.env.ORCA_WINDOWS_ARM64_PACKAGE = previous
      }
      delete require.cache[configPath]
    }
  })
  it('excludes bundled variants and keeps one target resource per platform', () => {
    expect(electronBuilderConfig.files).toContain('!node_modules/sherpa-onnx*{,/**/*}')
    expect(electronBuilderConfig.asarUnpack).not.toContain('node_modules/sherpa-onnx*/**')

    for (const [platform, packagePath] of [
      ['mac', 'node_modules/sherpa-onnx-darwin-${arch}'],
      ['linux', 'node_modules/sherpa-onnx-linux-${arch}'],
      ['win', 'node_modules/sherpa-onnx-win-x64']
    ]) {
      const speechResources = electronBuilderConfig[platform].extraResources.filter(
        (resource) =>
          typeof resource.to === 'string' && resource.to.startsWith('node_modules/sherpa-onnx')
      )
      expect(speechResources).toEqual([{ from: packagePath, to: packagePath }])
    }

    const matcher = new FileMatcher('/app', '/dest', (value) => value, electronBuilderConfig.files)
    matcher.prependPattern('**/*')
    const isPacked = matcher.createFilter()
    const stat = { isDirectory: () => false }
    for (const packageName of [
      'sherpa-onnx',
      'sherpa-onnx-darwin-arm64',
      'sherpa-onnx-darwin-x64',
      'sherpa-onnx-linux-arm64',
      'sherpa-onnx-linux-x64',
      'sherpa-onnx-win-x64'
    ]) {
      expect(isPacked(`/app/node_modules/${packageName}/index.js`, stat)).toBe(false)
    }
    expect(isPacked('/app/node_modules/ws/index.js', stat)).toBe(true)
  })
})
