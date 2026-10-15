# Windows ARM64 package

Build Windows ARM64 with `ORCA_WINDOWS_ARM64_PACKAGE=1` and electron-builder
`--arm64` together. The build hook rejects mismatched architecture and policy.
The installer has a distinct `orca-windows-arm64-setup.exe` name.

This package intentionally omits native offline dictation. The available sherpa
Windows addon is x64 and cannot load inside ARM64 Electron. Catalogs offer cloud
models only, local downloads and saved local selections fail before loading a
native worker, and existing model files remain intact. Cloud transcription still
requires the user's own API key. External tools such as Wispr Flow are separate.
Other platforms and Windows x64 keep their existing speech support.

The platform gating approach follows the independently reviewed idea in upstream
PR 9026, pinned at `369f325f12730b881a82e1d1e123fd356716153c` by Jinhyun Chun.
Agency retains its patched PTY ownership and native verification instead of
replacing them with that branch's packaging implementation.

Prepare target dependencies in an isolated checkout. Verify native PE architecture,
patched job ownership, console runtime checksums, source identity and packaged
functional journeys before installation. Existing x64 auto-update metadata does
not establish a compatible ARM64 update channel. Native Windows ARM64 skips
those automatic checks and rejects desktop download/install requests, directing
users to the reviewed Agency installer. The weekly Agency updater remains separate.
