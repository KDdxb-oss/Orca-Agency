# Orca Agency weekly updates

The maintainer's Orca automation runs on Saturdays at **05:00 America/New_York**. It merges the newest upstream stable release while preserving the Agency features. This automation is local to the maintainer's machine; downloading Orca Agency does not schedule it on another computer.

## Review and release process

1. GPT-6 Sol at extra high effort compares the latest stable tag with the recorded upstream base, merges changes, and resolves conflicts against the feature contract below.
2. Run focused regressions, typechecks, code-quality checks, hidden renderer checks, and packaged-app tests.
3. Claude Opus 5.5 at extra high effort audits the changes and evidence. The same implementing Codex session reviews every finding and performs the final review. Failed reviews or checks return to editing and another audit.
4. Assign a unique Agency version when binaries change, commit with normal hooks, and require a clean tree before building. Build each Windows artifact with its matching native toolchain, record the architecture and commit in the package manifest, and test that exact artifact. The installer stages complete files, closes the desktop gracefully, preserves running terminals and chat data, installs, and restarts.
5. Compare installed hashes and retained session identities. Verify functionality and inspect screenshots of the installed sidebar, panes, folders, and Automations. Repair failures and repeat the review and installation cycle.
6. Publish the verified source and artifact to [Orca Agency](https://github.com/brooksgolden/Orca-Agency). Include verified items from [pending release notes](./pending-fixes.md), the upstream base, tests, known limitations, and SHA-256 checksums. Record the release against each included fix after publication.

An unavailable credential or external service produces a clear failure receipt and preserves the previous working installation. A blocked run is never reported as a successful release. No announcement is posted. When neither upstream stable nor Agency source has changed, verify the existing release and record that no update is needed.

## Feature contract

| Area          | Preserve through every update                                                                                                                                                                                                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat identity | Prompted and resumed chats, exact saved-session recovery, manual names, provider icons                                                                                                                                                                   |
| Activity      | Running chats first; opening or resuming does not refresh activity; closed prompted tabs become separate Done chats; tabs closed after this update return to In Progress when resumed; older or explicitly marked Done chats return on their next prompt |
| Sidebar       | Elbows for tabs sharing a pane; brackets for separate panes; 1 folder label per pane; compact rows; collapsible status groups                                                                                                                            |
| Restart       | Idle open tabs retain their identities, nesting, and pane layout                                                                                                                                                                                         |
| Layout        | Drag live, idle, and Done chats; drag blank headers; horizontal and vertical splits, including full-width edges; close empty panes                                                                                                                       |
| Folders       | Directory-based picker, default Uncategorized, configurable default, folder inheritance, change-folder menu                                                                                                                                              |
| Files         | Native Copy Path; verified relative file links; file opens stay in their workspace                                                                                                                                                                       |
| Automations   | Background runs remain outside Chats; Windows tasks and Hermes services remain discoverable                                                                                                                                                              |
| Installation  | Verified staging, graceful shutdown, restart, bounded managed backups, terminal and transcript preservation                                                                                                                                              |

Use the existing regression suites for these areas. The 4 packaged smoke checks cover the chat sidebar, workspace sidebar, file links, and local Hermes tasks. Visual review supplements those tests.

## Versioning and platforms

The first release is **1.4.1000**, based on upstream **v1.4.218**. Later binary changes use a new plain semantic version greater than both the previous Agency version and the merged upstream version. Follow upstream major/minor advances, for example **1.5.1000** for a **1.5.x** base, and raise the patch further if required. Record the upstream stable base separately. Reusing an app version can reuse an old Windows terminal-host runtime, so package metadata must match source and must identify new bytes with a new version.

Use each workspace's frozen lockfile, including the separate mobile workspace. On Windows, use the toolchain matching the artifact's architecture and short test-output paths. Preserve compatibility with existing terminal daemons and remote clients. The ARM64 package omits native speech; external dictation tools remain usable.

## Stable workflow compatibility

Check workflow commands against the selected stable source before publishing. Upstream v1.4.219 imported newer main workflows in `fc0bd7cd2e1` without the Node server migration and supporting scripts. Agency uses the compatible workflow versions from its parent `ae8f42158c8fd570ae8a64aab4a671e48fd25401`, preserving the Bun server, full unit, Windows, SSH, native-cache and browser checks. Keep Agency's Windows Rust bootstrap. Reevaluate this exception when a newer stable contains the corresponding source; do not copy future workflows or suppress failing checks.

GitHub notification emails trigger a separate Orca reviewer through the maintainer's connected Outlook webhook. Confirmed release failures enter the same repair, Claude audit, Codex verification, installation and publication process immediately. This event path does not poll GitHub or wait for the Saturday schedule.

Windows x64 and the local ARM64 package have been verified. Public ARM64 publication requires its own release evidence and checksums. Mac and Linux release packages are not yet verified for this fork. Slow first history discovery and terminal slowdowns remain known limitations. A completed foreground turn with detached work is displayed as Monitoring without changing whether the chat was explicitly marked Done.
