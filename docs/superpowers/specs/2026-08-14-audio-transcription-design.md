# Audio and transcription — the normalisation layer

> Design of record, added 2026-08-14 at the operator's direction: extract audio, transcribe it
> ourselves, and make the result third-party verifiable by checksum. That is the dataset
> normalisation and ingestion layer.
>
> Companion to `2026-08-14-transcripts-design.md`, which covers **published** captions. This covers
> what happens where there are none.

## Why this exists

The transcripts probe left two holes that no fetcher can fill:

- **Gallatin publishes audio, not captions**, through AV Capture All, and its 2013–2020 Bozeman
  equivalent does not exist at all — 8 of 8 sampled clips from that era return an 8-byte stub.
- The archive spans 2013–2026. **Roughly half of it has no transcript to fetch**, and no amount of
  polite crawling will produce one, because the custodian never made one.

If the record is only searchable where a vendor happened to caption it, the searchable record is
shaped by the vendor's product decisions rather than by what was said. Transcribing the audio
ourselves is how the corpus becomes uniform across thirteen years and two jurisdictions.

That makes this the **normalisation layer**: whatever a jurisdiction publishes — captions, audio,
video, or a CD from a records request — the output is one shape, addressed one way, verifiable by
anyone.

## What this does not change

**It does not unlock a blocked source.** AV Capture All sits behind an AWS WAF challenge, and
obtaining its data means minting a token, which is defeating an access control. `SKILL.md`'s hard
line is unchanged and this spec does not route around it. The acquisition path for Gallatin remains:
ask the clerk, then a public-records request for the audio. What this spec adds is that **when the
audio arrives — by any lawful route, including a disc in the post — there is a pipeline waiting for
it.**

That ordering matters and should be stated to the operator plainly: this feature makes the records
request *worth making*. Without it, a delivered audio file is a blob nobody can search.

## 1. Audio is an artifact, like everything else

No new storage concept. Audio enters through the existing content-addressed path: bytes → sha256 →
`artifacts` row → MinIO at `artifacts/{sha[0:2]}/{sha}`, with `artifacts.sha256`'s unique index
making a re-delivery of the same file a no-op.

Two things it needs that text artifacts do not:

- **A duration and a codec**, read from the container, because "we transcribed 4 minutes of a
  3-hour meeting" is a failure that otherwise looks like a short meeting.
- **An acquisition record.** `artifacts` already stores a source URL and fetch time, which is wrong
  for a file that arrived as an email attachment or on physical media. Add an
  `acquisition` discriminator — `fetched` | `records_request` | `supplied` — and, for the latter
  two, the `records_requests` row it came from. Migration 027 already built that table and P7 built
  the generator. **The records path stops being a dead end and becomes an ingestion source**, which
  is the quiet structural win in this spec.

## 2. The transcript is a generated artifact, and it is labelled as one

This is the part that carries risk, so it is the part with the most rules.

A machine transcript is **not a record**. It is this project's best reading of a recording, and ASR
gets names wrong — the transcripts probe found a published human-adjacent caption file spelling one
person three different ways in a single document (`Greg Sullivan` / `Gregg Sullivan` /
`Gregg Sulivan`). Our own output will be worse, not better.

So:

**Rule 1 — a generated transcript may never be the citation for a claim about a person.**
`minute_claims.artifact_sha256` must point at a *published* document: minutes, an agenda, or a
custodian-published caption file. A generated transcript is searchable, quotable as "our transcript
of the recording", and **excluded from the claim extraction corpus by the extractor's own query**,
not by convention. This is the same principle the transcripts spec already fixed for published
captions — speaker attribution is anchored on the minutes, never on audio — extended to the case
where we made the text ourselves.

**Rule 2 — every rendering says what it is.** "Machine transcript of the audio recording. Not an
official record. Times are approximate. Names may be misspelled." Next to the text, not in a
footer. The `<Absence>` grammar from the vocabulary spec gets a sibling: a `<Generated>` marker,
used identically everywhere.

**Rule 3 — no speaker names, ever.** The ASR may diarise (speaker A, speaker B) and that is useful
for readability. It may **not** be joined to a person. `>>` is a CEA-608 speaker-*change* marker,
not an identity; voice identification is not something this project does; and a transcript that
attributes a sentence to a named official with 90% accuracy is a defamation engine. Diarisation
labels stay anonymous, and there is no column to put a name in.

**Rule 4 — it is held like everything else.** A generated transcript is unpublished until an
operator publishes it, and its meeting must be published. Same wall, same helpers.

## 3. Verification — the checksum design

The operator asked for third-party verification, and this is the part that makes the dataset
defensible rather than merely available.

The claim we want a stranger to be able to check is: **"this transcript was produced from this
audio, by this model, at this version, and has not been altered since."**

Each transcription run writes a **manifest**:

```json
{
  "audio_sha256":       "…",          // the bytes we transcribed
  "audio_bytes":        123456789,
  "audio_duration_ms":  10800000,
  "transcript_sha256":  "…",          // the bytes we produced
  "engine":             "whisper.cpp",
  "engine_version":     "1.7.2",
  "model":              "large-v3",
  "model_sha256":       "…",          // the weights, pinned
  "params":             { "language": "en", "temperature": 0, "beam_size": 5 },
  "produced_at":        "2026-08-14T…Z",
  "acquisition":        { "kind": "records_request", "reference": "CW-…" }
}
```

Three properties, each of which someone actually relies on:

- **Integrity** — `transcript_sha256` lets anyone confirm the file they were handed is the file we
  published. This is the cheap one and it works today via the weekly record receipt, whose
  `MANIFEST.sha256` already covers every published file.
- **Provenance** — `audio_sha256` ties the transcript to a specific recording, and the acquisition
  record ties that recording to how it was lawfully obtained. A transcript with no traceable audio
  is not publishable.
- **Reproducibility** — engine, version, model weights hash, and decode parameters. **Pin
  `temperature: 0` and a fixed beam size**, because a transcript nobody can regenerate is a claim
  resting on a black box, and this project's whole argument is that its claims can be checked.

Honesty about the limit, which must be stated in the spec and on the page rather than discovered:
**ASR is not bit-for-bit reproducible across hardware.** Floating-point non-determinism between GPU
and CPU, and between GPU models, will change a word here and there even at temperature 0. So the
verifiable claim is precisely scoped:

> *Same engine, same version, same weights, same parameters, same audio → substantially the same
> transcript. We publish the hashes so you can check the inputs exactly and the output closely.*

Report a **similarity threshold**, not equality, and publish the method (word error rate against the
stored transcript). Claiming byte-equality and being wrong would be worse than claiming nothing.

The manifest itself is stored as an artifact and is content-addressed, so the verification record is
subject to the same rules as everything it describes.

**Anchoring, deferred but designed for.** Publishing the weekly `MANIFEST.sha256` to a public git
repository — which the delivery spec already specifies — gives a timestamped, externally-witnessed
record of what we said and when. That is sufficient. Do not reach for a blockchain; a git commit in
a repository other people clone is the same guarantee with no new dependency, and this project's
credibility rests on being checkable, not on being novel.

## 4. Engine choice

**Self-hosted, and this is not close.**

- Sending a public meeting's audio to a commercial API is defensible; sending thirteen years of it,
  continuously, is building a dependency whose pricing and retention terms we do not control, over
  material where a provider's data-use terms would become a fact we have to disclose on the
  Methodology page.
- `whisper.cpp` with pinned weights runs on the existing host, produces WebVTT directly — which
  means the transcripts spec's VTT parsing path is reused rather than duplicated — and makes the
  model hash pinnable, which the reproducibility claim requires and a hosted API cannot offer.
- Cost is CPU time on hardware we already pay for. A three-hour meeting is minutes of GPU or a
  couple of hours of CPU, and this is a backfill, not a real-time need.

It runs as a **queue stage** (`transcribe`), on the same `SKIP LOCKED` mechanism the extraction
throughput spec moves extraction onto. Long-running, restart-safe, one at a time, with the failure
text landing in `ingestion_jobs` like every other stage. Not a route, not an unawaited promise.

The engine is a pin in config, swappable, exactly like the LLM models — and the manifest records
which one ran, so a corpus transcribed by two engines over time stays auditable.

## 5. What it unlocks

Beyond search coverage:

- **The 2013–2020 Bozeman archive becomes readable.** That is where the stubs are, and it is a
  decade of record that currently exists only as video nobody can query.
- **Full-text search doubles**, on top of A0's fix (minutes are currently not indexed at all).
- **The records-request path becomes an ingestion source**, closing the loop P7 built and giving the
  statutory channel a technical destination.
- **The claim pipeline gains a corroboration signal** — not a citation. Where the minutes record a
  vote and the transcript contains no corresponding discussion at all, that discrepancy is worth an
  operator's attention. It is never published as a finding on its own, because ASR gaps are common
  and silence proves nothing.

## Tests the plan must require

- A generated transcript is excluded from the claim-extraction corpus by the extractor's query, not
  by a caller — asserted by running the extractor against a meeting whose only text is a generated
  transcript and getting zero claims.
- There is no schema path to attach a person's name to a diarisation label — a foreign-key
  enumeration test, the same shape the geography spec uses.
- A transcript renders with its generated-content marker on every surface, including the feed and
  the artifact viewer.
- The manifest's `audio_sha256` matches the stored artifact, and a manifest referencing an absent
  artifact is rejected.
- Re-transcribing identical audio with identical pins is a no-op (the `artifacts.sha256` index),
  and re-transcribing with a changed model produces a second manifest rather than overwriting.
- An audio artifact with `acquisition: 'records_request'` and no `records_requests` reference is
  rejected by the database.
- A transcription job that dies mid-run is re-claimed and leaves a readable error, not a `running`
  row forever — the same constraint trap `extraction_runs` has.

## Open questions

**Does a generated transcript get published at all, or is it operator-console only at first?**
Specified as publishable-after-review. But the first hundred are the ones that reveal the error
rate, and publishing them before that rate is known is the wrong order. Recommendation: transcribe,
index for the operator's search, and hold publication until a sample has been read against the
audio and a measured word error rate exists to put on the Methodology page.

**Does Bozeman's audio need a records request too?** The 2013–2020 clips have video pages; whether
the media itself is fetchable under the same posture as the captions is unprobed. Probe before
designing — the answer changes whether this is a backfill we can run next week or one that waits on
a custodian.
