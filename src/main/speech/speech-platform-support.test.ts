import { afterEach, describe, expect, it, vi } from 'vitest'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import {
  assertLocalSpeechSupported,
  getSupportedSpeechModels,
  supportsLocalSpeech
} from './speech-platform-support'

afterEach(() => vi.restoreAllMocks())

describe('speech platform support', () => {
  it('omits offline models only on Windows ARM64 and retains both cloud models', () => {
    const cloud = SPEECH_MODEL_CATALOG.filter((model) => model.provider === 'openai')
    expect(cloud).toHaveLength(2)
    expect(getSupportedSpeechModels(SPEECH_MODEL_CATALOG, 'win32', 'arm64')).toEqual(cloud)
    for (const [platform, architecture] of [
      ['win32', 'x64'],
      ['darwin', 'arm64'],
      ['linux', 'arm64']
    ] as const) {
      expect(supportsLocalSpeech(platform, architecture)).toBe(true)
      expect(getSupportedSpeechModels(SPEECH_MODEL_CATALOG, platform, architecture)).toBe(
        SPEECH_MODEL_CATALOG
      )
    }
  })

  it('rejects saved local selections before native startup on Windows ARM64', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
    expect(assertLocalSpeechSupported).toThrow('Local dictation is unavailable on Windows ARM64.')
  })
})
