# ConPTY and terminal slowdown investigation

## Current result

The slowdown remains unresolved. ConPTY 1.25 passes a fresh ARM64 compatibility exercise, but the short comparison does not establish a consistent paste improvement. It is not included in local build 1.4.1014 as a claimed performance fix.

## Upstream leads

| Lead                                                                                                                                                          | Assessment                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [node-pty's pinned ConPTY 1.25 bundle](https://github.com/microsoft/node-pty/tree/d182c6079fc31bab364c1754ee0dca103cd0a7bc/third_party/conpty/1.25.260303002) | Official ARM64 DLL and OpenConsole pair fetched at an immutable commit. Git blob, SHA-256 and PE architecture verified. Existing Orca native binding and process-job patches retained in isolated test copies.                                                             |
| [VS Code PR 315951](https://github.com/microsoft/vscode/pull/315951)                                                                                          | Enabled bundled ConPTY by default. Orca already uses a bundled DLL; its current pair is 1.23. Adoption alone does not demonstrate an Orca speedup.                                                                                                                         |
| [node-pty PR 943](https://github.com/microsoft/node-pty/pull/943)                                                                                             | Fixes a startup deadlock involving a worker paused by the debugger. Our 1.1.0 binding also calls native connect synchronously. A backport needs a worker-readiness lifecycle review and failure-path tests. This is not evidence of the cause of mid-session paste stalls. |
| [Terminal issue 20113](https://github.com/microsoft/terminal/issues/20113)                                                                                    | Similar slow initial output was reported with Terminal 1.25 and TCC. Different application and workload; it does not identify our cause or prove a newer bundle cures it.                                                                                                  |

## Offline comparison

Three alternating rounds per version, with one or four fresh native terminals. Each terminal accepted 16,000 ASCII characters and produced approximately 1 MiB of output. Medians below are milliseconds per terminal. Three rounds are too few to establish a performance trend.

| Concurrent terminals | ConPTY | Input receipt | Output completion |
| -------------------- | ------ | ------------- | ----------------- |
| 1                    | 1.23   | 418           | 77                |
| 1                    | 1.25   | 407           | 92                |
| 4                    | 1.23   | 913           | 118               |
| 4                    | 1.25   | 932           | 82                |

The application renderer, LLMs and Wispr are excluded. Package checks overlapped this exploratory comparison, and host pressure changed between rounds. These results establish basic compatibility, not a controlled performance gain or a reproduction of the reported freeze. Existing retained terminals were untouched.

A second exercise used a separate fresh Node process for each version without package checks competing. Input medians were 337 ms for 1.23 versus 405 ms for 1.25 with one terminal, and 746 ms versus 403 ms with four. One 1.25 sample took about four seconds. Version order and host load were not controlled across those separate runs. This is a lead for a randomized comparison, not proof of a dependable improvement. Both new binaries have valid Microsoft signatures.

## Hardware observations and limits

A timestamped local capture collected CPU per core, process CPU and memory, memory paging, GPU engines and memory, disk latency and queues, and host network throughput. The exploratory window included package checks and the benchmark. Paging bursts and disk queues warrant follow-up. Total CPU below saturation does not exclude a saturated core or a short scheduler stall. GPU counters did not show sustained high utilization in the captured samples.

Network values are host-wide, not attributed to Orca. Changing GPU instances invalidated some counter samples, so GPU coverage is incomplete. Each capture stops after its intended window. It is not a permanent background monitor.

### User-marked paste, October 7

A separate 15-minute capture ran from about 10:24 to 10:39 UTC with four live terminals. Brooks reported the Corner/Instinct paste at about 10:28:17 UTC: the beginning appeared progressively before the remainder became a teal bracketed paste. The exact input start and delay were not measured.

Within 45 seconds of that report, total CPU had a median of 47% and a peak of 61%; some individual cores reached 100%. Available memory had a median of 1,185 MiB. Pages read into memory peaked near 65,779 per second, and disk throughput peaked near 272 MB/s. These page reads can include mapped files and executable images as well as pagefile reads. Package smoke checks overlapped this period, so it cannot isolate the user's Orca workload. Sampled host network traffic peaked near 1.9 MB/s, which does not demonstrate link saturation or exclude a short network stall.

After the smoke checks ended, the 10:30 to 10:38 UTC window still showed variable system pressure: CPU median 41%, available memory minimum 714 MiB and median 1,657 MiB, and memory page reads peaking near 46,825 per second. No specific stall was reported in this later window. Other applications were active. These are investigation leads, not an attribution of the freeze to another application or proof that memory, ARM emulation, networking or ConPTY is the cause.

The recorder's process ID and cadence are saved so its contribution can be separated. Five-second CPU, disk and network samples and ten-second GPU samples can miss shorter events. The next useful evidence is timing through clipboard dispatch, terminal input receipt and renderer paint during the same user-visible stall.

### Paste reports, October 8

Brooks confirms progressive paste with both ordinary Ctrl+V and Wispr Flow. It remains common after the two Priceless AI automations and heavy local checks stopped. He estimates that only about one in ten Codex pastes appears immediately as a teal bracketed block. The other pastes appear in letters, words or sentences, while terminal animations stutter and the Orca interface spinner remains smooth. These are user observations, not measured event timings.

A bounded redacted observer on the actual `pty:writeAccepted` input handler captured no input or paste events during its 120-second window. It recorded terminal output and a maximum sampled main-loop delay of 222 ms. The observer was removed afterward. This window cannot identify the paste bottleneck or establish an improvement. The next capture needs a reproduced paste with receipt, delivery and paint timings; do not attribute it to Wispr alone or assume that the entire interface stalled.

## Next measurements

1. Capture a timestamped slow paste with clipboard dispatch, PTY input receipt, output delivery and renderer paint timing.
2. Run separate input-delivery tests for direct paste and Wispr, with no packaging or compiler workload.
3. Compare a fresh native host with an older retained x64 host using the same offline workload. Preserve saved sessions and drafts.
4. Review the worker-readiness backport separately, including timeout cleanup and process-job ownership.
5. Repeat the ConPTY comparison without competing tests, then run packaged native persistence and cancellation gates before adopting it.

Background verification runs with reduced priority and bounded compiler concurrency. Heavy experiments should run sequentially. No arbitrary CPU cap or automatic termination of user terminals is introduced.
