import type { SpeechModelManifest } from '../../shared/speech-types'

export const LOCAL_SPEECH_UNAVAILABLE = 'Local dictation is unavailable on Windows ARM64.'

export function supportsLocalSpeech(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): boolean {
  return platform !== 'win32' || architecture !== 'arm64'
}

export function getSupportedSpeechModels(
  models: SpeechModelManifest[],
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): SpeechModelManifest[] {
  // The Windows x64 addon cannot load inside native ARM64 Electron.
  return supportsLocalSpeech(platform, architecture)
    ? models
    : models.filter((model) => model.provider !== 'local')
}

export function assertLocalSpeechSupported(): void {
  if (!supportsLocalSpeech()) {
    throw new Error(LOCAL_SPEECH_UNAVAILABLE)
  }
}
