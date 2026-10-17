# Orca Agency

## Your AI chats, organized for agency work

Keep Claude and Codex conversations together across client folders. See which chats share a pane, which run side by side, and where your attention is needed.

**[Download the latest release](https://github.com/brooksgolden/Orca-Agency/releases/latest)** · [What's new](https://github.com/brooksgolden/Orca-Agency/releases) · [Upstream Orca](https://github.com/stablyai/orca)

The current 1.4.1045 download is for **Windows ARM64**. The [earlier Windows x64 build](https://github.com/brooksgolden/Orca-Agency/releases/tag/v1.4.1008) remains available.

![Orca Agency demo workspace with four panes and an organized Claude and Codex chat sidebar](media/workspace-overview.png)

*Demo workspaces captured in the app. Example names and content keep private client work out of the screenshots.*

## Keep your chat pod in order

| Feature | See it in Orca Agency |
| --- | --- |
| **Every conversation has a place**<br><br>Claude and Codex icons identify each chat. **Elbows connect tabs in one pane; brackets connect separate panes.** Your sidebar follows the layout as you rearrange it. | <img src="media/split-workspaces.png" alt="Claude and Codex provider icons, nested tabs and bracketed panes in the chat sidebar" width="350"> |
| **A cleaner sidebar, on your terms**<br><br>Choose **Hide Done chats**, **Show only open chats**, or **Collapse Done folders**. Idle chats remain visible unless your chosen filter excludes them. The filter button stays highlighted while a filter is active. | <img src="media/chat-filters.png" alt="Chat grouping and folder filters menu with the three visibility controls" width="420"> |
| **Client folders you can scan at a glance**<br><br>Group conversations by folder, collapse sections and find the client you need. Work in ordinary folders without turning every project into a Git repository. | <img src="media/folder-view.png" alt="Chats grouped into collapsible client folders" width="350"> |
| **Arrange the work around you**<br><br>Use halves or quadrants. Move panes, swap occupied positions and combine tabs again. Keep related conversations together while giving each task the space it needs. | <img src="media/workspace-overview.png" alt="Four demo workspaces arranged in quadrants" width="480"> |
| **Restart the terminal. Keep the conversation.**<br><br>For a verified local Codex session in the same account, restarting resumes the saved conversation with current launch settings. Reopening also uses the selected workspace folder. Account changes retain their confirmation. | <img src="media/resume-conversation.svg" alt="Saved chat to restart to current settings to the same conversation" width="480"><br><sub>Conversation flow diagram.</sub> |
| **Native Windows ARM64**<br><br>A native build for Windows on ARM, including the terminal runtime. The local speech component is omitted. Native architecture is supported; terminal slowdowns remain under investigation. | <img src="media/native-arm64.svg" alt="Native ARM64 Windows app and terminal runtime" width="480"><br><sub>Architecture diagram.</sub> |
| **Navigate with your mouse**<br><br>Mouse side buttons follow the same **Back and Forward history** as the toolbar arrows. Return to the previous view, then move forward again. | <img src="media/mouse-workspace-history.png" alt="Mouse side buttons labeled Back and Forward for workspace history" width="480"> |

## Small touches that keep work flowing

- **One name everywhere:** Rename a chat in the sidebar and its tab follows.
- **Open the file an agent mentions:** Relative file links resolve against the chat's workspace, with safeguards for ambiguous matches.
- **Choose when you're Done:** Opening a completed conversation for review keeps it Done until you submit a new prompt.
- **Less toolbar clutter:** The Command button is off by default, with a setting to enable it where supported.

## Biweekly stable updates, with the Agency features retained

Upstream stable changes are integrated with the Agency additions through Codex implementation, Claude audit, final Codex review and package checks. The next regular update is October 24, 2026. Releases list **Orca Agency updates** separately from **Updates integrated from stable**.

## Download and development

Use the [release page](https://github.com/brooksgolden/Orca-Agency/releases/latest) for available packages, architecture, installation instructions and verification results. Mac and Linux release binaries are not yet verified for this fork. Intermittent terminal stalls and activity indicator discrepancies remain known issues.

Orca Agency is an independent, unofficial fork of [Orca](https://github.com/stablyai/orca). It retains the upstream MIT license, with no OpenAI or Anthropic affiliation. See the [upstream README](README.upstream.md), [update process](docs/agency/weekly-updates.md) and [license](LICENSE).

<sub>Mouse photo: William Hook, CC BY-SA 2.0. Labels and layout added by Orca Agency. See the <a href="media/mouse-photo-attribution.md">media attribution</a>.</sub>
