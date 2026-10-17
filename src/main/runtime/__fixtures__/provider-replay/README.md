# Provider replay fixtures

Recorded provider sessions that `structured-provider-replay.test.ts` plays through Orca's shipped
structured-session host, adapters and journal. Only the transport is fake
(`structured-provider-replay-test-support.ts`).

| Fixture | Provider | What it covers |
| --- | --- | --- |
| `claude-tool-call.ndjson` | Claude Agent SDK stream | One turn: a Bash tool call, then a final message |
| `claude-subagent.ndjson` | Claude Agent SDK stream | Two `Agent` subagents (frames with `parent_tool_use_id`), then the root's final message |
| `codex-tool-call.ndjson` | Codex app-server JSON-RPC | One turn: a `commandExecution`, then a final message |
| `codex-subagent.ndjson` | Codex app-server JSON-RPC | A spawned child thread whose `turn/completed` lands before the root's |

These four come from T3 Code's replay fixtures (pingdotgg/t3code @ `2fbd4318`,
`apps/server/src/orchestration-v2/testkit/fixtures`). They are MIT licensed; see `LICENSE-t3code`.

## Format

One JSON object per line:

- `transcript_start`: provider, protocol and version metadata.
- `expect_outbound`: a frame the client sent. Claude: `prompt.offer` holds the prompt. Codex: a
  JSON-RPC request (`id`, `method`, `params`).
- `emit_inbound`: a frame the provider sent. Claude: an Agent SDK message, exactly as `query()`
  yields it. Codex: a JSON-RPC result (`id`, `result`) or notification (`method`, `params`).
- `runtime_exit`: the provider process ended.

The replayer swaps in the identities of the run it launched:

- the provider session id;
- Orca's own send echo. For Claude this is a replayed user frame carrying the sent `uuid`, plus
  `command_uuid`. For Codex it is the user item's `clientId` = `clientUserMessageId`.

So a recording made by any client replays as an Orca send.

## Recording a new fixture

Use a throwaway folder and an account you can spend a turn on. Remove anything private from the
output before committing it: home paths, tokens, repository names.

**Claude.** Start the CLI in stream mode, type one prompt as a stream-json user message, then wrap
each output line:

```sh
echo '{"type":"user","message":{"role":"user","content":"<prompt>"},"parent_tool_use_id":null}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose \
      --permission-mode bypassPermissions \
  | jq -c '{type:"emit_inbound",label:.type,frame:.}' > body.ndjson
{ echo '{"type":"transcript_start","provider":"claudeAgent","protocol":"claude-agent-sdk.query","version":"<cli version>"}'
  echo '{"type":"expect_outbound","label":"prompt.offer:1","frame":{"type":"prompt.offer","message":{"type":"user","message":{"role":"user","content":"<prompt>"},"parent_tool_use_id":null}}}'
  cat body.ndjson
  echo '{"type":"runtime_exit"}'; } > claude-<scenario>.ndjson
```

**Codex.** Drive `codex app-server` over stdio: `initialize`, `initialized`, `thread/start`, then
`turn/start` with the prompt. Tee both directions:

- each line you write becomes `{"type":"expect_outbound","label":<method>,"frame":<line>}`;
- each line it writes becomes `{"type":"emit_inbound","label":<method or request method>,"frame":<line>}`.

Stop after the root thread's `turn/completed`.

Then add a row to the table above and a case to `structured-provider-replay.test.ts`.
