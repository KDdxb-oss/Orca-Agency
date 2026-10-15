# GitHub notification email review

Windows maintenance scripts for the repository owner's email automation. These are not an Orca app feature or a scheduled GitHub poll.

The authenticated Composio Outlook webhook delivers notification events to a hidden WebSocket listener. A matching Orca automation owns the review prompt and run history, with its clock schedule disabled. A logon-only Windows task starts the listener. Only incoming notifications and connection recovery read email. Active Orca reviews are monitored separately.

Runtime configuration, Composio context, credentials and mail state belong in a private support folder. Never commit them here. The operational copy reads `config.json`, `outlook-trigger-params.json` and the existing Composio user account. `install-email-listener.ps1` requires the matching Orca automation before registering its logon task.

Commands: `setup`, `listen`, `pending`, `replay --message-id ID`, `heartbeat --run-token TOKEN`, `finish --key KEY --reason TEXT --run-token TOKEN [--reply-file FILE]`, and `complete-run --run-token TOKEN`. Retain the batch token returned by `pending`. During repairs, check actual progress at least every five minutes and record a heartbeat when work advances. A lease expires after 30 minutes without progress or four hours total. Replies check the exact thread, exclude self and bots, and record attempts before posting to prevent duplicates after uncertain responses.

Workflow failure notifications launch the reviewed hotfix pipeline immediately. It uses the weekly updater's exclusive lock, Codex and Claude review loop, installation, restart, retained-chat verification and publication checks. Failures stay open until the repair is verified; they are not deferred to Saturday.

Record a heartbeat after acquiring the batch and every two minutes while review makes progress. The three-minute monitor allows a five-minute completion grace after the last heartbeat or decision for a reported completed run with unfinished items. Failed dispatches, completed decisions, and the four-hour cap still release the lease. Token-specific `finish` refuses expired ownership before any public API call; deliberate tokenless manual review remains available.

Run the focused tests with `python -m unittest test_email_bridge`. They cover routing, cross-linked subjects, exact-thread checks, chunk delivery, batch recovery, pagination and duplicate prevention. The runtime requires Python, websocket-client, pywin32, the existing Composio CLI, GitHub CLI and Orca CLI.
