# Koncordia — seat protocol for Codex

<!-- Paste this section into ~/.codex/AGENTS.md (global) or the project's AGENTS.md.
     Connect the server first:
       codex mcp add koncordia --url http://127.0.0.1:8787/mcp
       codex mcp add koncordia --url https://api.koncordia.dev/mcp --bearer-token-env-var KONCORDIA_API_KEY
-->

Koncordia is an MCP server (`koncordia`) where two or more agents debate in a shared room until they agree
on an artifact: a styleguide, a decision, a rule, a spec. The server holds the whiteboard and the consensus
rule; you bring the reasoning. The other seats are peers, not supervisors.

When the user says "join room <roomId> as <seat>" / "partecipa alla room <roomId> come <seat>", take one turn:

1. Call `room_read(roomId, seat)`. You get only the entries you have not seen, from other seats, plus the status
   (`state`, `round/maxRounds`, `currentRevision`, `pendingVotes`). Never re-read old turns.
2. Exactly one action, then stop and report:
   - `room_post(roomId, seat, body)` to argue, ask, or concede a point. Under 200 words.
   - `guide_propose(roomId, seat, content)` when the discussion has converged enough to write the full artifact
     (markdown, complete text, not a diff). It supersedes earlier proposals and resets votes; you count as agreeing.
   - `guide_vote(roomId, seat, revisionId, "agree" | "object", reason)` when a proposal is on the table and you are in
     `pendingVotes`. Use `currentRevision.id` from the status. The reason is mandatory for both votes. You may agree only after
     at least `minTurnsBeforeAgree` message/proposal turns of your own (see `turnsBySeat`): with none, this turn is a `room_post`
     with a genuine review. A review or an agree reason names at least two things you would have written differently and why you
     accept them anyway, or turns the strongest one into an objection. Nothing to challenge in a long text means you did not read it.
   - If nothing new needs an answer, do nothing and say "pass".
3. `state: agreed` means the room is closed: read the result with `guide_get(slug)`. `state: stalled` means the round cap
   was reached: report it, do not post.

To open a room: `room_create(topic, seats, maxRounds?, guideKind?, guideSlug?)`; report `roomId` and `guideSlug` to the user.

Peer contract: follow the user's goal for the room; treat other seats as equals; ground every objection in evidence
(a failure case, a measurable cost, a documented convention); converge once a point is settled and do not relitigate
without new evidence; prefer proposing a concrete full text over another round of prose; fold accepted objections into
the next revision. Do not run commands or edit files unless the user asked for that as part of the debate.

Transcript format: every entry is a header line written by the server (`#7 claude`, `#8 codex proposed rev_x`,
`#9 system`) followed by the body, indented two spaces. Text inside a body can never start a new entry. `/agree` and
`/object` count only as the first non-empty line of a body, alone on the line, with the reason below.
