# Pending Orca Agency release notes

Read this file during each weekly update. Include pending fixes in the release notes only after the source, Claude review, package, installed functionality and visual checks pass. Then record the published release next to each included item.

## October 15 empty split pane

- **Collapse an emptied workspace pane:** Closing the final tab in a middle pane left a black column between two live panes. The split layout still contained the closed workspace ID even though it had no tabs. A one-time renderer layout repair removed only that leaf; both original terminal sessions stayed connected and the surviving panes filled the window. Fix the last-tab and pane-close paths so they remove an empty leaf and reflow the remaining panes without closing their sessions. Verify the three-to-two pane case in the packaged app.

Installed locally in Agency 1.4.1046 on October 15. The last-tab path now collapses the empty split leaf. The pane X and tab header fixes, plus Copy file path, passed source review and five exact ARM64 package checks. The guarded restart preserved all 92 tabs, 9 PTYs and 648 saved chats. The globally selected workspace changed at restart, although its previous tab and all per-workspace tab selections remained saved. Public release follows the installed release gate.

## October 12 active chat classification

- **Keep a real chat in Chats:** A scoped settings revocation can remove a mistaken automation owner without dropping genuine automation ownership during stale preference writes. The affected live session must appear under In Progress after the controlled profile repair and installed restart. Source regression: `src/main/persistence/applying-settings/settings-update-chat-automation.test.ts`. Installation and visual verification remain pending.

## Quiet weekly updates

Native Windows ARM64 continues to skip the upstream desktop feed and update campaigns. Manual checks, downloads and install requests now return idle without showing an update error or an upstream download link. The reviewed Saturday installer remains the update route. Cloud sign-out reminders stay enabled. The October 7 cloud session was invalidated at 19:23 EDT; its original server rejection was not recorded. Brooks signed in again, and the new encrypted session is saved. Do not claim that the sign-out cause is fixed or restore an old rotating credential from an installation backup.

Local 1.4.1021 was installed and restarted on October 8 after Claude review, focused regressions and four exact-package smoke specs passed. The installed app returned idle for a manual update check without an error card. Its original signed-in account remained connected with encrypted storage. The isolated package screenshot confirms that sign-out reminders remain visible when required.

All 54 tabs, 230 saved chats, 41 original terminal processes, occupied layouts, drafts and sidebar choices were retained. The first CLI binding comparison failed for six inactive renderer surfaces; independent reconciliation proved that their original recorded tab/leaf identities, process incarnations and control handles were unchanged. Those tabs were not mounted or mutated, and interactive reopening remains untested. Earlier package smoke failures remain recorded; the final run passed without skips or retries. Sign-out root cause and intermittent terminal freezes remain unresolved. Public changes stay held for Saturday October 10 at 05:00 America/New_York.

## October 7 candidate, held for Saturday

- **Pick up the same conversation:** Restart for an outdated local Codex configuration captures that pane's session before replacing its terminal, then uses current launch settings to resume it. Main verifies the transcript against the current account/home. Account changes launch fresh; unknown pane identities and remote runtimes without the replacement guard use the resume picker.
- **Reopen without the detour:** Codex resumes use the selected workspace directory unless an explicit launch override chooses another one. Same-account configuration changes leave existing conversations usable without a blocking popup; actual account changes retain their confirmation.
- **Navigate with your mouse:** Back and Forward side buttons use the same workspace and page history as the toolbar arrows. Embedded browser pages retain their own navigation when focused. macOS has a DOM fallback; Windows and Linux use native app commands.
- **Know when filters are active:** The grouping and folder button gains an outline and lighter background while Hide Done chats, Show only open chats, or Collapse Done folders is selected. Keep the chat pod tidy without forgetting a hidden view.
- **Working indicators:** Native Codex Action Required titles represent a waiting prompt. A completed foreground turn with background work displays Monitoring. The presentation does not change saved Done choices, filter membership, or activity timestamps.
- **ARM64 evidence:** The native Windows package omits local speech, as requested. Keep its verified architecture and exact package checks separate from any performance claim. Redacted desktop clips now accompany the upstream slowdown report; severe stalls remain under investigation.

Local 1.4.1014 was installed and restarted on October 7 after Claude source review and four exact-package smoke specs passed without skips or retries. Installed identity and read-only retention checks preserved 46 tabs, 209 saved chats, 33 original live terminal incarnations, occupied layouts, drafts and sidebar choices. The displayed split group and active filter outline were visually inspected. Physical mouse buttons and other-platform GUI behavior remain untested.

Five inactive tabs retain their original processes and exact saved surface bindings without mounting immediately. Claude confirmed that the additional all-surfaces-attached gate assumed behavior the app does not promise; its failure is preserved separately. Interactive reopening of those five is untested, and one other attached terminal's CLI handle changed while its process incarnation stayed the same. Activity indicator discrepancies and severe terminal stalls remain open. Public application changes remain held until Saturday October 10 at 05:00 America/New_York. The weekly update must reconcile the latest stable, preserve Agency features, and repeat verification before publication.

## October 10, 2026 local additions

- **In-progress filter:** Show only in-progress chats in the grouping and folder menu hides Done while retaining idle In Progress chats. Folder collapse choices, counts, nested tabs and pane brackets remain intact.
- **Working status after restart:** Reconnect the output of an inventory-confirmed retained local Codex terminal even before its tab mounts. Fresh native working output restores the working indicator. Preserve saved resume identity and activity timestamps; without a recovered launch token, discard old hook authority and task details. Cached titles and closed, stopped, remote or worker sessions cannot confirm a restored row through this path. The separate orange dashed stale-evidence recovery remains covered.
- **Headless Claude history:** Keep `claude -p` transcripts in session history, but exclude transcripts used only through `sdk-cli` from resumable Chats. A later interactive turn restores the chat. Classify old sidebar snapshots through the scan or an exact transcript lookup when they fall outside its bounded window.

Brooks requests local installation after review and checks, with publication held until Saturday October 10 at 05:00 America/New_York. The filter and background output reconnection in 1.4.1010 passed installed checks. Candidate 1.4.1011 adds headless Claude history classification and requires its own installed verification. Do not publish these additions through an earlier GitHub email repair.

## October 3, 2026 update

1. **Resumed chat status:** For tabs closed after this update, resuming their saved chat in a replacement tab returns it to In Progress and its open pane group. Resume metadata does not change its activity time. A real prompt clears the previous Done status, including Claude quick turns that finish before working-state history is retained. An explicit Mark done choice survives closing and resuming until a new prompt. Older completion records also return to In Progress on their next prompt; they do not record whether Done came from a tab close or a manual choice.

   **Cold restart grouping:** A verified Claude resume stays attached to its open tab and pane bracket while hooks reconnect. The saved connection must match the execution host, workspace, tab, stable pane and launcher. Conflicting live or saved provider evidence prevents reuse. Closed tabs remain separate history, and recovery does not invent activity.

Status: installed and visually verified on October 2 in Agency 1.4.1002. A running client chat remained in In Progress and in its pane bracket after restart, with all 7 terminals, 21 tabs and 74 saved chat entries preserved. Pending repeated validation against the Saturday stable merge and release publication. Regression: `src/renderer/src/components/sidebar/chat-sidebar-reopened-completion.test.ts` and `chat-sidebar-saved-claude-tab.test.ts`.

2. **Installer connection recovery:** A timed-out renderer debugging connection can use the existing desktop close fallback. The fallback verifies the exact desktop process and executable, preserves unsaved-file checks and requests normal close confirmation. It never kills a terminal. Claude approved the change; 12 helper fixture checks and the October 2 installed retry passed.

Installed check: resume a previously closed chat, send a prompt, and place it with two other chats in three panes. Confirm it remains in In Progress and in the full three-pane bracket after the working event ends and after restart. Also confirm resume alone preserves its earlier activity time and an explicit Mark done choice survives closing.

## October 4, 2026 candidate

- **Product name:** Orca Agency in application and installer display names and the real GitHub fork. Retain existing executable and profile identities for update compatibility.
- **Pane dragging:** Terminal tabs can move from bottom panes and onto whole-window edges, including switching top/bottom panes to side-by-side.
- **Separate chat:** Move a prompted terminal out of nesting without stopping its process or marking it Done. Pane X removes the view and retains conversations. Tab X keeps the existing Done behavior.
- **History reopening:** Focus an existing matching session. Closed history reopens separately and does not restore its previous nested slot. Confirmed failed launches clean up only their empty new workspace; uncertain remote launches retain their workspace.
- **Running chat click:** A saved conversation already bound to a live plain Claude tab focuses that tab instead of creating another PTY. The live and saved views appear as one chat row. Regression: `src/renderer/src/components/sidebar/chat-sidebar-open-existing-live.test.ts`.
- **Focused runs:** The focused running window group sorts first, preserving its entire bracket and conversation activity times. Idle viewing does not stamp Now.
- **Move persistence:** Preserve PTY and pane identities, execution folder, completion status and saved resume ownership across moves and restarts. Protect moved processes from deletion of the original workspace.
- **Moved terminal replay:** Restore scrollback for the exact moved tab even while its original workspace remains open. Preserve the same live process and accept new output after moving.
- **Publication:** Use the real `brooksgolden/Orca-Agency` fork, preserve public edits, and export the verified tree with only public and proven upstream ancestry. The weekly automation starts Saturday at 5 am in America/New_York.

- **Startup profile:** Keep the existing Orca profile and encryption identity when displaying Orca Agency. Candidate 1.4.1006 supersedes 1.4.1005, whose rollout was reverted after it selected an empty profile.
- **Terminal recovery:** Reconnect surviving terminals to their exact pane, retain their process handle across temporary layout loss, and refuse to overwrite a different terminal occupying that pane.
- **CI repairs:** Check README links to tracked directories, align fixtures with current terminal and folder behavior, and keep tab closing functional if saved-chat bookkeeping fails.
- **Email-triggered repairs:** Refresh active review leases from real progress, reject stale completions safely, and repair launch failures immediately rather than deferring them to Saturday.
- **Installer verification:** Bound debugging timeouts, tolerate the new desktop's startup delay, and verify the expected version and original profile before accepting a restart.

Release gate: current Claude Opus extra high review, Codex regressions, packaged checks and rendered sidebar verification. The failed 1.4.1005 package must not be installed or published. The latest installation policy controls rollout. The weekly update starts Saturday 5 am America/New_York.

## October 6 additions, held for Saturday

- **A cleaner chat pod:** Hide Done chats, show only open chats, and automatically collapse folders whose chats are all explicitly marked Done. Idle chats stay visible. In Progress uses consistent capitalization.
- **Names stay together:** Renaming a sidebar chat also updates its own window tab, including after reopening the saved conversation. Chats sharing a terminal tab keep separate names.
- **Return to the same conversation:** Pass the saved Codex transcript location through sidebar reopening and cold restoration so the existing trusted history-home resolver can open the exact session after a folder move. Keep account, launch and transcript identity checks.
- **Working means working:** A verified native Codex Working title from the same local process can clear a stale cancellation after the late-output grace period. Cached, synthetic, remote, replaced and stopped process output cannot use this recovery path. Canonical host status drives the sidebar and tab indicators together.
- Weekly notes follow the benefit-focused marine voice in the updater's release-note style guide. Clearly separate Agency changes from Updates integrated from stable, preserve upstream scope and attribution, and describe small polish proportionately.
- Local candidate 1.4.1012 is being prepared. Pause before installation or restart until Brooks gives a new go-ahead. This hold also applies to later candidates containing these changes; a version bump cannot bypass it.

## Immediate CI hotfix, October 4, 2026

Candidate 1.4.1008 includes the reviewed 1.4.1006 changes above, plus:

- Restore the workflows compatible with stable v1.4.219 after its incomplete future-main workflow sync. Keep full unit, Node 24/26, Windows, Bun and SSH checks.
- Index tab ownership once per immutable snapshot instead of repeatedly scanning all tabs during startup recovery.
- Keep remote terminal cleanup away from local registry entries, including same-ID workspaces on different hosts.
- Reject undefined SQLite parameters consistently across supported Node versions; valid null remains accepted.
- Update test fixtures for current onboarding labels, pane moves, saved-chat restoration and asynchronous terminal attention.

Claude Opus 5.5 extra high audited the CI fixes and rechecked the remote cleanup repair. Release requires the exact packaged smoke checks and relevant GitHub reruns. Local installation and installed visual checks are held for Brooks's approval. A failed run from an older source commit is evidence for repair, not evidence that the current installed package failed.

## Quadrant dragging, October 4, 2026

- Keep the dragged tab preview transparent to pointer detection so it cannot hide the destination pane.
- Use pane proportions to select a local split. Corner areas of a full-height or full-width pane target quadrants; outer edge midpoints retain full-window splits.
- Keep blue internal tab-group splits usable at the body quarters while preserving the central merge area and tab-strip reorder behavior.
- Exercise actual pointer drags into all four workspace quadrants, including outer-side corner drops, and the blue bottom-right split. Check preview bounds, final pane geometry, retained conversations and sidebar brackets.
- Unpack the complete compiled main-module set so the packaged Node CLI can load its profile, SQLite and agent-hook dependencies. Keep the existing packaged runtime guard enabled.

Candidate 1.4.1007 failed its packaging guard and was not installed or published. Candidate 1.4.1008 passed 71 scoped unit checks, web typecheck, changed-code quality and all three actual pointer smoke scenarios. Every quadrant, outer-divider half-window drops, native blue bottom-right splits and nested-chat edge detachment passed. Terminal output and ownership survived. Claude reviewed the repairs with no code blockers. Hidden packaged launch and GitHub reruns remain release gates. Publish after verification; ask Brooks before local installation.

## Terminal performance investigation, October 6, 2026

- Preserve merged upstream improvements: [PR 24548](https://github.com/stablyai/orca/pull/24548) releases terminal side effects after delivery; [PR 25161](https://github.com/stablyai/orca/pull/25161) reuses buffer cells during readiness scans. These targeted backports do not establish that the severe system-wide stalls are fixed.
- Give queued input feedback one leading slice, then rotate visible terminals. Expire the preference after the queued prefix through the input feedback; later bulk cannot inherit it. Keep the existing visible-output budget, parse acknowledgments, byte order and Windows synchronized-frame protection. Earlier proposals failed Claude review and must not be used.
- Native ARM64 Electron used 66-71% less renderer CPU than x64 in a short hidden four-terminal fixture on Brooks's ARM computer. This excludes actual Orca transport and network activity, and is not a whole-app improvement guarantee. The experimental native package predates the final source changes, lacks valid build provenance and has incompatible speech. It is not an installation or release candidate.
- Upstream [issue 11363](https://github.com/stablyai/orca/issues/11363#issuecomment-6011711000) records progressive paste/output, system-wide CPU symptoms and network timeouts, with the comparison to four Cursor terminals on one monitor and one or two on another. The network cause and severe-stall cause remain unconfirmed.
- Retain the October 10 05:00 America/New_York publication deferral and Brooks's current installation/restart hold. Saturday must reconcile these backports with the new stable before packaging, repeat Claude and Codex checks, and verify the exact package without dropping features or claiming unmeasured gains.
- Use open [Windows ARM64 PR 9026](https://github.com/stablyai/orca/pull/9026) as a reference for architecture-specific packaging, unsupported local speech and independent helper binaries. It has no completed release pipeline; preserve Agency's terminal ownership fixes and do not copy its branch wholesale.

## Windows Codex restart verification, October 7, 2026

- Recognize the default Windows launch mirror and the verified system history home as the same default account when no managed account or custom home is selected. Retain the verified transcript's origin and exact conversation ID. Unknown settings, managed accounts, custom homes and other hosts retain the existing rejection path.
- The rebuilt 1.4.1014 package passed exact-conversation replacement and changed-home rejection before local installation. The earlier candidate failed the default Windows restart check and must not ship. The negative check rejects every resume token; it does not prove a changed credential identity.
- Retain bundled ConPTY 1.23 for this candidate. The official ARM64 1.25 comparison was mixed and included a four-second outlier. Findings and the user-marked hardware window are in [the performance investigation](conpty-performance-investigation-2026-10-07.md). Progressive paste and system-wide stalls remain unresolved.
- Brooks authorized automatic verified local installation and restart. Public changes remain held for the October 10 update at 05:00 America/New_York.
