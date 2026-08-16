# Repetition truncation — the mechanism, and the experiment that would settle it

**Written 2026-08-16 during the third autonomous loop.** Filed as H8. The knob is built; the
experiment is **not run**, and the reason is stated below rather than implied.

---

## The finding

A fifth of extraction chunks end `repetition-truncated`. `docs/STATUS.md` records the measurement:
**5 of 24 chunks unread (20.8%), every one of them `truncated-reply`** — 100%, n=5. A 3,724-character
document produced 22 claims and no truncation; a 5,536-character one produced 127 claims and
truncated, with rejection tallies of `unknown-action: 103` and `not-an-official: 113`. Those tallies
are the signature: the model was emitting the same shape over and over until the ceiling stopped it.

Extraction is **not scheduled automatically** because of this. So this is not a cosmetic defect — it
is the thing standing between this project and reading its own corpus.

## The mechanism, which was sitting in the request the whole time

`services/extraction/openrouter.ts` sends `temperature: 0` and, until this change, **no repetition or
frequency penalty of any kind**.

That combination is the textbook recipe for degenerate repetition. At temperature zero the model
takes the highest-probability token at every step. Once the output enters a repeating cycle, the
cycle is — by construction — the most probable continuation of itself, and greedy decoding has no
stochastic path out of it. It repeats until `max_tokens` truncates the reply.

This is worth stating plainly because the ceiling has already been raised twice in response to this
symptom, from 2048 to 3000 to 8000. **Raising a ceiling does not end a loop; it lengthens it.** A
model that would repeat forever repeats until whatever the new ceiling is, and the run costs more
tokens to arrive at the same truncation. The evidence that this is what happened is in the
docblock's own history.

## Why the obvious fix is the wrong one

Sampling — raising the temperature — would break the loop. It is the wrong trade here.

`temperature: 0` is not an oversight in this codebase; it is load-bearing, and the comment beside it
says why: *"This is an extraction task with a right answer, not a writing task."* A transparency
project that cannot reproduce its own extraction cannot defend it. If a claim about a named official
is challenged, "we ran it again and got something else" is not an answer.

**A frequency penalty breaks the cycle without giving up greedy decoding.** It reshapes token scores
by how often a token has already appeared, so decoding stays deterministic and reproducible while a
repeated token stops being the argmax forever. Same run, same input, same output — but the loop is no
longer a fixed point.

## What was built

`EXTRACTION_FREQUENCY_PENALTY`, resolved once in the client constructor, accepted range −2..2,
**defaulting to 0**.

The load-bearing property is that **at 0 the field is omitted from the request entirely** — not sent
as `frequency_penalty: 0`. The request is byte-for-byte what it was before the knob existed. That is
what keeps every truncation measurement already recorded in `STATUS.md` a statement about the
configuration it was actually taken under. Sending an explicit zero would quietly turn all of those
numbers into claims about a request nobody had run.

Mutation-verified: making the field always present fails both omission tests.

An unusable value (`3`, `banana`, `-5`) falls back to 0 **and warns**. Throwing would let one typo
take extraction down; falling back silently would leave an operator reading a comparison that never
ran as though it had.

## The experiment, which was deliberately not run

**Why not:** it spends the operator's rate-limited free-model quota, unattended, on a judgement call
about model behaviour — and the honest version of it needs enough chunks to beat a very noisy
denominator. The existing loss measurement is already flagged in `STATUS.md` as *"bounded and must be
re-run"* precisely because this corpus verifies ~1 claim per chunk and two of five chunks verify
zero. An underpowered rerun would produce a number that looks like an answer.

**The design, for whoever runs it:**

1. **Fix the sample.** The same documents both times — ideally including the 5,536-character one that
   truncated with `unknown-action: 103`, since it is the known-positive case. Comparing different
   documents measures the documents.
2. **Run at 0 first**, on the current code, to re-establish the baseline on today's model. The model
   has changed under this project before (llama-3.3 stopped being free mid-project), so a baseline
   from 2026-08-11 is not necessarily today's baseline.
3. **Then 0.3, then 0.6.** Low values first; a frequency penalty large enough to suppress repetition
   is also large enough to suppress *legitimately repeated* tokens, and minutes are full of
   legitimate repetition — the same member's name on every vote, "Motion carried" a dozen times.
   **That is the risk this experiment exists to bound**, and it points the opposite way from the
   truncation it fixes.
4. **Measure three things, not one:** the truncated-chunk fraction, the verified-claim count, and the
   rejection tallies. A run that stops truncating *and* stops producing claims has not improved.
5. **Re-run the F2d loss measurement afterwards** at whatever value is chosen. `STATUS.md` already
   requires this after any change to what passes the gate, and this qualifies.

**Success is not "truncation reaches zero."** Some documents genuinely exceed 8000 tokens of real
content. Success is truncation falling while verified claims per chunk hold or rise.

## What must be true whichever value is chosen

- **`temperature: 0` stays.** If a proposal requires sampling, it is a different proposal and it
  needs the reproducibility question answered first.
- **The default stays 0 until a measurement says otherwise**, so the code keeps describing what has
  been observed rather than what is hoped.
- **Free-model enforcement is untouched.** `assertFreeModel` runs before the request is built and
  there is no flag to switch it off; nothing here changes that.
- **Any chosen value is recorded with the run that justified it**, not just set. A tuned constant
  with no measurement beside it is indistinguishable from a guess six weeks later.
