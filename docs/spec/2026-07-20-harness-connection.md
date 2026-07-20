# Harness Connection and Background Turns Specification

## Problem Statement

Pincer users rely on installed coding CLIs to edit their working tree, but the current Harness connection is harder to extend and less reliable than it needs to be. The implementation mixes Agent and Harness terminology, repeats process and JSON parsing concerns in each integration, silently substitutes another Harness when selection fails, stores unqualified resume tokens, accepts some turns without terminal proof, and reaches outside a CLI to discover provider models.

This makes a fourth built-in Harness unnecessarily risky. A maintainer must understand orchestration, subprocess behavior, persistence, protocol details, and UI assumptions rather than implementing one focused vendor boundary. Protocol drift can remain invisible, and different Harnesses can acquire different lifecycle behavior.

Users also cannot safely treat conversations as independently active work. One global running-turn state is tied to the visible conversation and originating WebSocket. Switching conversations can misroute output, while allowing multiple coding CLIs to edit the same direct-edit working tree would create overwrite races and make per-turn diffs unreliable. Users need to move between conversations without losing a running subprocess, but they do not want worktrees or other isolated project copies.

## Solution

Pincer will make Harness the canonical domain boundary and move all vendor-independent subprocess behavior into one daemon-owned HarnessRunner. Each built-in HarnessDefinition will contain only its stable identity, presentation metadata, declared optional capabilities, default command, turn invocation builder, optional CLI model-catalog operation, and parsed-record decoder. A maintainer adding a Harness will add one definition, one registry entry, and one deterministic fake-CLI contract test; orchestration, persistence, WebSocket handling, and UI behavior will remain unchanged.

The HarnessRunner will own probing, subprocess launch, JSONL framing and parsing, bounded diagnostics, process-tree cancellation, session capture, and strict terminal validation. Pincer will resolve the exact selected Harness, qualify resume tokens with their Harness id, treat model and effort catalogs as advisory, and interact with provider capabilities only through the installed CLI.

A daemon-owned TurnScheduler will preserve active work across conversation navigation and overlay reconnects. It will run one HarnessTurn at a time against the shared project and queue one outstanding turn per other conversation in submission-order FIFO. The browser will be a subscriber rather than the owner of a process. Live output will remain in a bounded daemon memory snapshot and be restored when a conversation is resumed; final results will be persisted once the turn succeeds, fails, or is cancelled.

## User Stories

1. As a Pincer user, I want my selected Harness to run exactly, so that a prompt is never sent to a different coding CLI without my knowledge.
2. As a Pincer user, I want an explicit error when my selected Harness is unknown, so that I can correct the selection instead of receiving misleading output.
3. As a Pincer user, I want an explicit error when my selected Harness is not installed, so that I know why the turn cannot start.
4. As a Pincer user, I want available Harnesses detected at startup, so that I can choose among the coding CLIs installed on my machine.
5. As a Pincer user, I want an explicit default Harness to be honored only when available, so that configuration never silently changes my choice.
6. As a Pincer user, I want Pincer to choose the first detected built-in only when I did not configure a default, so that automatic selection remains deterministic.
7. As a Pincer user, I want to override the executable command for each Harness, so that wrappers and nonstandard installations work without hiding other Harnesses.
8. As a Pincer user, I want commands represented as argument arrays rather than shell strings, so that quoting is deterministic and no shell interpretation is introduced.
9. As a Pincer user, I want model choices displayed when a Harness supports them, so that I can select a model before a turn.
10. As a Pincer user, I want effort choices displayed only when a Harness supports them, so that the UI does not pretend unsupported controls work.
11. As a Pincer user, I want model and effort values passed through to the CLI, so that new CLI-supported values are usable even when Pincer's advisory catalog is stale.
12. As a Pincer user, I want a conversation to resume through the same Harness that issued its token, so that session continuity is valid.
13. As a Pincer user, I want switching Harnesses inside a conversation to start a fresh HarnessSession, so that one CLI never receives another CLI's resume token.
14. As a Pincer user, I want my Pincer conversation history preserved when I switch Harnesses, so that changing the execution tool does not erase prior turns.
15. As a Pincer user, I want successful turns to require both a clean process exit and an explicit successful terminal result, so that incomplete or drifting protocols are not reported as successful.
16. As a Pincer user, I want Harness-reported failure to remain a failure even when the process exits cleanly, so that vendor errors are not hidden.
17. As a Pincer user, I want nonzero process exits reported with bounded stderr context, so that failures are actionable without overwhelming the UI.
18. As a Pincer user, I want malformed or newly unknown structured records diagnosed without immediately aborting an otherwise valid turn, so that harmless vendor additions do not break Pincer.
19. As a Pincer user, I want a missing or duplicate terminal result to fail the turn, so that protocol drift cannot silently pass.
20. As a Pincer user, I want cancellation to terminate the full Harness process tree, so that child tools do not remain orphaned.
21. As a Pincer user, I want a running turn to continue when I navigate to another conversation, so that I can inspect or prepare other work without losing progress.
22. As a Pincer user, I want output from a hidden conversation retained under that conversation, so that switching views never mixes messages.
23. As a Pincer user, I want switching back to a running conversation to show its current buffered output, so that I can follow progress immediately.
24. As a Pincer user, I want a running subprocess to survive a temporary WebSocket disconnect, so that network or overlay reconnection does not cancel work.
25. As a Pincer user, I want page reload followed by conversation resume to restore live progress, so that the browser is not a process owner.
26. As a Pincer user, I want completed work that finished while disconnected to appear in persisted history, so that no terminal output is lost.
27. As a Pincer user, I want to submit a turn in another conversation while one is running, so that I can queue independent follow-up work.
28. As a Pincer user, I want queued turns to execute in submission order, so that scheduling is understandable and fair.
29. As a Pincer user, I want changing the visible conversation not to reorder queued turns, so that navigation has no execution side effect.
30. As a Pincer user, I want at most one queued or running turn per conversation, so that I cannot author follow-ups against results I have not seen.
31. As a Pincer user, I want a queued turn to retain the Harness, model, and effort selected when I submitted it, so that later configuration changes do not mutate accepted work.
32. As a Pincer user, I want a queued conversation labelled Queued with its position, so that I understand when its work will start.
33. As a Pincer user, I want a running conversation labelled Running, so that I can find active work from the list.
34. As a Pincer user, I want cancelling a queued turn to remove it without launching a subprocess, so that unwanted work never starts.
35. As a Pincer user, I want cancelling the running turn to start the next queued turn only after termination settles, so that two CLIs never edit the shared tree concurrently.
36. As a Pincer user, I want deleting a conversation with outstanding work to cancel that work first, so that deletion never leaves an orphan process.
37. As a Pincer user, I want per-turn diffs attributed only to the turn that ran, so that queued direct edits remain understandable.
38. As a Pincer user, I want all conversations to edit the existing working tree directly, so that normal HMR behavior remains available without worktrees.
39. As a Pincer user, I want daemon shutdown to cancel the running turn and pending queue, so that Pincer exits cleanly.
40. As a Pincer maintainer, I want Harness to be the only integration term, so that CLI products are not confused with models or autonomous Agents.
41. As a Pincer maintainer, I want runtime Harness contracts to remain daemon-private, so that process concerns do not leak into browser-shared code.
42. As a Pincer maintainer, I want one HarnessRunner implementation, so that probing, stream framing, cancellation, diagnostics, and completion behave identically for every Harness.
43. As a Pincer maintainer, I want each Harness decoder to receive parsed structured records, so that JSON parsing is not duplicated.
44. As a Pincer maintainer, I want a decoder to distinguish emitted events, intentional ignores, and invalid records, so that protocol drift is observable.
45. As a Pincer maintainer, I want one Harness record to emit multiple normalized events, so that vendor envelopes can expose both session and status information cleanly.
46. As a Pincer maintainer, I want optional capabilities declared explicitly, so that adding a Harness does not require fake models, effort levels, or resume behavior.
47. As a Pincer maintainer, I want model discovery limited to supported CLI commands, so that Pincer does not maintain provider authentication or credential parsing.
48. As a Pincer maintainer, I want duplicate Harness ids rejected at startup, so that selection is unambiguous.
49. As a Pincer maintainer, I want a new Harness accepted through a real fake-CLI subprocess contract, so that argv, decoding, lifecycle, and terminal behavior are proven together.
50. As a Pincer maintainer, I want Claude Code, OMP, and Codex to use the same HarnessDefinition contract, so that existing integrations prove the boundary is general.
51. As a Pincer maintainer, I want legacy Agent fields removed through a one-way migration, so that the cleaned domain model does not retain aliases.
52. As an existing Pincer user, I want conversation and turn content preserved through the storage migration, so that upgrading does not erase history.
53. As an existing Pincer user, I want unsafe legacy resume tokens cleared during migration, so that preservation never sends an unprovable token to the wrong Harness.
54. As a Pincer contributor, I want deterministic tests that do not require installed CLIs, credentials, or network access, so that the full contract runs reliably in CI.
55. As a Pincer contributor, I want optional live-CLI smoke checks to supplement deterministic tests, so that current vendor behavior can be sampled without making CI fragile.

## Implementation Decisions

- **Canonical language:** Harness means an installed coding CLI Pincer can invoke. HarnessDefinition describes a built-in integration. InstalledHarness combines a definition with its resolved command, detection state, and advisory catalog. HarnessSelection stores a conversation's exact Harness id plus opaque model and effort values. HarnessSession qualifies an opaque resume token with its issuing Harness id. HarnessTurn is one non-interactive request/result lifecycle. Agent is reserved for a possible future autonomous actor.
- **Ownership boundary:** Runtime definitions, registry resolution, invocation construction, structured-record decoding, process execution, and Turn scheduling belong to the daemon. Shared core contracts contain only serializable descriptors, capabilities, selections, normalized events, live snapshots, and protocol messages. The overlay consumes descriptors generically and never imports a concrete Harness implementation.
- **Extension contract:** Adding a built-in Harness changes one focused HarnessDefinition, one static registry entry, and one deterministic fake-CLI contract test. It does not change orchestration, persistence, WebSocket handling, shared runtime contracts, or UI branches.
- **HarnessDefinition responsibilities:** A definition owns stable id, display metadata, default argv, optional capabilities, advisory static models, optional CLI catalog invocation/decoder, turn invocation construction, and parsed-record decoding. It does not spawn, frame stdout, parse JSON text, cancel, inspect exit codes, persist, or broadcast.
- **HarnessRunner responsibilities:** One shared runner owns process probing, optional catalog capture, detached subprocess launch in the project root, optional stdin, concurrent stdout/stderr draining, newline framing, JSON parsing, bounded diagnostics, normalized event delivery, process-tree cancellation, session capture, and terminal/exit validation.
- **Structured output requirement:** Every supported Harness must emit machine-readable line-delimited structured output. Human terminal text scraping is not supported.
- **Decode result:** A parsed vendor record becomes zero or more normalized events, an intentional ignore, or an invalid-record diagnostic. Decoder exceptions become diagnostics rather than escaping the process loop.
- **Normalized events:** The internal/wire vocabulary covers status, assistant text, tool activity, working-tree diff, session capture, and terminal result. Session and terminal events carry control meaning; visible text/tool/diff events build replayable message blocks.
- **Completion invariant:** Normal success requires process exit code zero and exactly one terminal result whose success value is true. Nonzero exit, explicit terminal failure, no terminal result, or more than one terminal result fails the turn. Cancellation is a separate terminal state.
- **Diagnostic tolerance:** Malformed JSON and unknown record shapes are retained as bounded diagnostics while processing continues. Stderr is retained as a bounded tail. Critical drift is exposed when terminal proof is absent or contradictory.
- **CLI lifecycle:** Pincer launches one non-interactive process per HarnessTurn. Long-lived Harness processes and alternate transports are excluded.
- **Capability model:** Model selection, effort selection, resume, and CLI catalog discovery are explicit optional capabilities. Missing capabilities remove their UI controls rather than supplying fake defaults.
- **Catalog semantics:** Model and effort catalogs are advisory. Pincer presents options but stores/passes opaque strings; the selected CLI performs final validation. Dynamic discovery may use only a supported CLI command. Pincer will not read credential files or call provider APIs.
- **Registry semantics:** Built-in Harnesses are statically ordered. Startup validates unique ids. Registry order is automatic default priority only when no explicit default is configured.
- **Selection semantics:** Conversation resolution is exact. Unknown and unavailable Harnesses produce distinct blocking errors. No fallback Harness is permitted.
- **Session semantics:** Persisted turns record the Harness used and its session token. Resume lookup filters by both conversation and Harness id. Switching Harness starts fresh CLI state while preserving Pincer's history.
- **Configuration:** Project configuration contains an optional default Harness and a command-argv map keyed by Harness id. Unknown ids and malformed argv values are startup errors. CLI options use Harness terminology; a command override is an argv array and applies to the explicitly selected Harness. Precedence remains CLI, project configuration, then built-in defaults.
- **Protocol cutover:** The daemon and bundled overlay move together behind a bumped protocol version. Agent-named events, fields, flags, aliases, and exports are removed rather than deprecated. Every turn lifecycle message carries conversation and runtime turn ids.
- **Storage migration:** A schema-versioned transaction rebuilds legacy tables into canonical Harness columns. Conversation/turn content is copied, turn Harness ids are derived from their legacy conversation, and legacy unqualified resume tokens are cleared because historical ownership cannot be proven. Stale running/queued rows recover as errors.
- **TurnScheduler:** The daemon owns one running HarnessTurn and a submission-order FIFO. Each conversation may own at most one outstanding turn. Same-tree concurrent Harness subprocesses are forbidden because they would race edits and invalidate diff attribution.
- **Queued selection:** Harness, model, and effort are snapshotted at submission. Compatible resume lookup and the working-tree before-diff snapshot occur immediately before execution.
- **Live snapshot:** A queued snapshot contains prompt, selection, state, and queue position. A running snapshot additionally contains bounded normalized message blocks. Adjacent text is coalesced; live text and block counts are capped, with one visible truncation marker when the cap is reached. The same bounded blocks are persisted so live, completion, and replay agree.
- **Persistence timing:** Stream deltas remain in daemon memory. One final turn is written when execution succeeds, fails, or is cancelled. Queued cancellation writes a cancelled turn without spawning; running cancellation persists its bounded buffered output.
- **Socket independence:** The HarnessRunner and TurnScheduler publish through a daemon broadcaster rather than a request socket callback. Connected overlays are subscribers. A failed socket send cannot reject or cancel a running turn.
- **Resume behavior:** Conversation resume combines persisted completed turns with the current queued/running live snapshot. A temporary disconnect does not clear live daemon state. A reconnect requests the current visible conversation snapshot.
- **Overlay state:** Thread messages, streaming position, and live turn state are keyed by conversation id. Incoming events update their owner regardless of the visible view. The Composer derives Send/Stop from only the visible conversation's state. Conversation rows expose Idle, Queued with position, or Running.
- **Cancellation and deletion:** Cancelling a queued turn removes it without launch. Cancelling a running turn waits for its full process tree to stop before advancing the queue. Deletion cancels/settles outstanding work before removing history.
- **Shutdown:** Daemon shutdown cancels the active process and every queued turn before closing persistence. Child-process pipe reattachment after daemon restart is not attempted.
- **Delivery order:** First establish the HarnessDefinition/Runner boundary, migrate built-ins/configuration/protocol/storage, and verify exact execution. Then add TurnScheduler, broadcaster, live snapshots, per-conversation overlay state, and queued-turn UI.

## Testing Decisions

- Tests defend observable contracts, not internal method calls, class shapes, private queues, source text, or incidental implementation details. A useful test fails for a plausible user-visible bug: wrong Harness execution, bad argv, lost output, protocol drift, cross-session resume, process leakage, queue reordering, cross-conversation routing, or unsafe migration.
- **Primary seam:** Start the real daemon with a deterministic fake coding CLI, drive its real WebSocket protocol, allow the production HarnessRunner to spawn the subprocess, inspect emitted protocol messages, inspect the edited working tree, and inspect the resulting SQLite rows. This is the agreed highest seam and should cover registry resolution, invocation, structured decoding, strict completion, persistence, scheduling, cancellation, reconnect, and diff attribution together.
- **Per-Harness contract:** Claude Code, OMP, and Codex each run their own real HarnessDefinition through the shared HarnessRunner and a fake executable that emits captured vendor-format JSONL. The contract verifies detection, overridden command, default/model/effort/resume argv, text/tool/session/terminal decoding, intentional ignore, invalid record, explicit failure, and terminal proof.
- **Runner failure matrix:** Deterministic fake scenarios cover exit zero plus success, terminal failure, nonzero exit, missing terminal result, duplicate result, malformed JSON, unknown records, bounded stderr/diagnostics, and process-tree cancellation.
- **Persistence seam:** Create a real legacy SQLite schema and rows, open it through the production Store, and assert transactional schema upgrade, content preservation, canonical columns, schema version, cleared unsafe token, compatible-session lookup, and stale-running recovery.
- **Configuration seam:** Parse real CLI/config inputs and start the daemon to verify command precedence, per-Harness overrides, unknown-id rejection, unavailable explicit default, automatic registry priority, and advisory model pass-through.
- **Scheduling seam:** Use the real daemon and a controllable delayed fake CLI. Assert one running process, FIFO start order, one outstanding turn per conversation, immutable queued selection, queued/running cancellation, cancel-before-delete, shutdown cancellation, and serial diff attribution.
- **Reconnect seam:** Disconnect only the WebSocket while the daemon/process remains alive. Reconnect and resume before completion to verify the live snapshot, then repeat with completion during disconnect to verify persisted replay.
- **Overlay routing seam:** Feed ownership-bearing server messages through the existing Zustand store seam. Seed two conversations, stream a hidden conversation while viewing another, and assert only the owner thread changes. Cover queued/running hydration, position changes, completion, error, cancellation, and active Composer state.
- **Browser acceptance seam:** Drive the real overlay in a browser for the final navigation behavior: start A, switch to B, queue B, return to A, observe buffered progress, let B start, reload while B runs, restore B, then cancel. This visual/interaction smoke is required because store tests alone cannot prove the user flow.
- Existing prior art to reuse includes the daemon's temporary-project/WebSocket harness, fake Claude/OMP executables, protocol and Harness configuration integration tests, real SQLite storage tests, process-tree cancellation tests, overlay Zustand store tests, CLI proxy integration test, and compiled daemon/overlay builds.
- Optional smoke against installed Claude Code, OMP, or Codex supplements deterministic coverage. Missing tools, authentication, or network access never replaces or fails the deterministic suite.
- Final verification runs focused daemon/overlay contracts first, then workspace typecheck, lint, daemon build, overlay build, and the complete test suite.

## Out of Scope

- Runtime-loaded or third-party Harness plugins.
- Project-authored Harness manifests.
- A published Harness SDK package.
- A declarative command/event mapping DSL.
- Long-lived Harness subprocesses.
- Remote provider API transports.
- Provider credential discovery or authentication handling.
- Human-readable terminal output scraping.
- Cross-Harness context or transcript transfer.
- Multiple concurrent Harness subprocesses editing the same project working tree.
- Git worktrees or temporary project copies for turn isolation.
- Queue reordering or manual priority controls.
- More than one outstanding turn per conversation.
- Persisting every live stream delta to SQLite.
- Keeping turns alive across daemon shutdown.
- Reattaching stdout, stderr, or control to a subprocess after daemon restart.

## Further Notes

- The approved domain glossary and Harness integration ADR are normative for terminology and architectural boundaries.
- The current code already has useful high-level test seams. The implementation should deepen the real daemon/fake-CLI seam instead of introducing mocks for subprocess or WebSocket behavior.
- Direct-edit mode is intentional. Serialization, not filesystem isolation, preserves correctness and HMR behavior.
- The storage migration preserves history but intentionally sacrifices one possible legacy CLI continuation because correctness of token ownership is more important than speculative resume.
- The browser remains a subscriber. Closing or switching its view changes presentation only; only explicit cancellation, deletion, or daemon shutdown terminates work.
