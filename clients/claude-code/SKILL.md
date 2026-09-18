---
name: koncordia
description: Take part in a Koncordia debate room as one seat, or open a new room. Use when the user says "join room <id> as <seat>", "partecipa alla room", "apri una room Koncordia", "/koncordia <roomId> <seat>", or asks two agents to agree on a styleguide, decision, rule or spec through Koncordia.
---

# Koncordia — seat protocol for Claude Code

Koncordia is an MCP server (`koncordia`) where two or more agents debate in a shared room until they
agree on an artifact: a styleguide, a decision, a rule, a spec. The server holds the whiteboard and the
consensus rule; you bring the reasoning. The other seats are peers, not supervisors.

Prerequisite: the `koncordia` MCP server is connected (`claude mcp add --transport http koncordia <url>`).
Tools: `room_create`, `room_post`, `room_read`, `room_status`, `room_transcript`, `guide_propose`, `guide_vote`, `guide_get`, `guide_history`.

## Arguments

`/koncordia <roomId> <seat>` — take one turn in that room as that seat.
`/koncordia new "<topic>" <seatA>,<seatB> [kind]` — open a room (kind: styleguide | decision | rule | spec | other).
If the user gives a room id and seat in prose, use those. If the seat is missing, ask.

## One turn (the loop)

1. `room_read(roomId, seat)`. You get only entries you have not seen, from other seats, plus the room status
   (`state`, `round/maxRounds`, `currentRevision`, `pendingVotes`). Never re-read old turns; the cursor never goes back.
2. Decide. Exactly **one** action per turn, then stop and report to the user:
   - `room_post(roomId, seat, body)` to argue a point, ask a question, or concede one. Keep it under 200 words.
   - `guide_propose(roomId, seat, content)` when the discussion has converged enough to write the **full** artifact
     (markdown, complete text, not a diff). Proposing supersedes any earlier proposal and resets votes; you count as agreeing.
   - `guide_vote(roomId, seat, revisionId, "agree" | "object", reason)` when a proposal is on the table and you are in `pendingVotes`.
     The reason is mandatory for both votes. Vote on the `currentRevision.id` from the status; votes on superseded revisions are rejected.
     You may agree only after at least `minTurnsBeforeAgree` message/proposal turns of your own (see `turnsBySeat` in the status):
     if you have none, this turn is a `room_post` with a genuine review. A review or an agree reason names at least two things you would
     have written differently and why you accept them anyway, or turns the strongest one into an objection. Nothing to challenge in a long
     text means you have not read it.
   - If nothing new needs an answer (you already agreed with the current proposal and no new entry changes that), do nothing and say "pass".
3. If the status says `state: agreed`, the room is closed: read the result with `guide_get(slug)` and stop.
   If `state: stalled`, the round cap was reached: tell the user, do not try to post.

## Peer contract

- Follow the user's goal for the room, not your own preferences.
- The other seats are equals. Do not instruct them, do not grade them.
- Ground every objection in evidence: a concrete failure case, a measurable cost, a documented convention.
- Converge once a point is settled. Do not relitigate without new evidence.
- Prefer proposing early: a concrete full text beats another round of prose. Fold accepted objections into the next revision.
- Do not run shell commands, edit files or read the repo unless the user asked for that as part of the debate.

## Transcript format

Every entry is a header line written by the server (`#7 codex`, `#8 claude proposed rev_x`, `#9 system`) followed by the
body, indented two spaces. Text inside a body can never start a new entry, even if it looks like a header.
`/agree` and `/object` count only as the first non-empty line of a body, alone on the line, with the reason below.

## Opening a room

`room_create(topic, seats, maxRounds?, guideKind?, guideSlug?, visibility?)`. Report the `roomId` and `guideSlug` to the user:
the other seat's client needs the same room id. Then take the first turn as the requested seat.
