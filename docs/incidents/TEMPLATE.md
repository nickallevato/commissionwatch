# Incident: &lt;short name&gt;

Copy this file to `docs/incidents/YYYY-MM-DD-short-slug.md` (the date is the **start** date, or the
detection date if the start is unknown) and fill in every field. **Write "unknown" rather than
estimating a timestamp you don't have.** A guessed time makes MTTR look computed when it is
guessed, which is worse than leaving the field honestly blank — see `docs/incidents/README.md`.

## Summary

One or two sentences: what broke, in plain words a reader who has never seen this repo could
understand.

## Timeline

All times UTC unless stated otherwise. These four are the reason this record exists — everything
else below is context.

| | Time | Source |
|---|---|---|
| **Start** (the fault began) | | |
| **Detected** (someone or something noticed) | | |
| **Resolved** (the fault stopped) | | |
| **Fix landed** (the underlying cause was actually fixed, if different from resolved) | | |

- **Start → Detected:** how long the fault existed before anyone knew, and why (or "unknown").
- **Detected → Resolved:** how long it took to act once known — this is the MTTR interval.

## Detection

Did monitoring catch it, or did a human? Name the specific mechanism (a Gitea run going red, the
external monitor, an operator opening the site, a reader report) and say what it did or did not
see. If a monitor existed at the time and did not catch it, say what class of fault it wasn't built
to see — that is usually the more useful fact than "monitoring failed."

## What broke

The mechanism, not just the symptom. What was the actual defect or condition, and why did it
produce the observed failure.

## Impact

What a reader, an operator, or the record itself actually lost or could not do, and for how long
(cross-reference the timeline; don't restate a duration you didn't measure).

## Resolution

What action actually stopped the fault. Distinguish "the site came back" from "the underlying cause
was fixed" if they happened at different times — this is the point of the Timeline table having
both.

## What changed as a result

Code, process, or documentation changes made because of this incident, each with a link or file
reference. If nothing changed, say so and say why that's the right call — but that should be rare.

## Source

Where this record was reconstructed from (`docs/STATUS.md` line numbers, `CHANGELOG.md` sections,
Gitea run IDs, `git log`). Anyone should be able to check this file against the sources it claims.
