# A dark theme — what it costs, and the claim that has to be made true first

**Requested by the operator, 2026-08-16.** Roadmapped, not built. This is the design work that has to
land before any pixel changes, because the project already has a documented position on dark mode and
the position rests on a premise that is currently false.

---

## This is not reopening a rejected decision

Worth stating plainly, because the history reads that way at first glance and a future reader would
otherwise re-litigate it.

Dark mode has been through three states here:

1. **The original product spec wanted it.** `docs/spec/product-spec.md` still says *"Dark mode
   default. Accent: amber/gold."*
2. **The 2026-08-04 production design superseded that** with the light editorial identity — paper
   ground, serif headlines, one red accent. `docs/roadmap.md` records the supersession explicitly.
3. **The 2026-08-14 roadmap deleted the leftover config**, and the reason was not "dark is wrong":

   > **Delete the dead dark-mode config and keep the light editorial identity.** A committed look is
   > more credible than a half-built theme, and the `--cw-*` custom properties mean a later dark mode
   > is a token swap, not a rewrite.

What was deleted was **dead config, not a theme**. `tailwind.config.ts` carried `darkMode: "class"`
while `index.html` shipped `<html class="dark">` permanently — so every `dark:` variant in the
codebase was always on, and the shell painted dark grey before React mounted. That is a bug wearing a
feature's clothes, and removing it was right.

**So this request exercises an option the project deliberately left open.** The bar it has to clear is
the one that sentence set: a committed theme, not a half-built one.

## The premise is currently false, and that is the first task

The roadmap's justification is that the `--cw-*` custom properties make dark "a token swap, not a
rewrite." **Checked on 2026-08-16: it would not be.**

- `frontend/src/index.css` defines **42** `--cw-*` custom properties: `--cw-paper`, `--cw-ink`,
  `--cw-accent`, the `--cw-sev1..5` ramp, `--cw-pass`, `--cw-fail`, plus the font stacks.
- `frontend/tailwind.config.ts` defines the same palette **again**, as flat JavaScript hex literals —
  `const paper = "#FFFDF8"`, `const ink = "#16161A"`, `const accent = "#B03A2E"`, and an accent ramp
  from `50` to `600`.

The two agree because somebody typed the same values twice. **Nothing derives from anything.**

Redefining the `--cw-*` variables under `prefers-color-scheme: dark` would therefore restyle only the
few rules that read `var(--cw-*)` — the body background, a handful of base styles — while every
`bg-paper`, `text-ink`, `text-accent`, `border-rule` and `bg-sev4` class in the app kept its baked-in
light hex. The result is light text on a dark ground in some places and the reverse in others: worse
than no dark theme, and discovered halfway through the work.

**Step 0 is to make the sentence true**: point Tailwind's colour tokens at the custom properties
(`paper: "var(--cw-paper)"` and so on) so there is one palette with one definition.

That change is worth making **whether or not dark ever ships**. A duplicated palette that two files
maintain by hand is the same defect class this project has already paid for twice this week — the
frontend's `vote_value` union drifting from `pg_enum`, and the console's record count drifting from
the backend's `SUCCESS_KEYS`. Both got a guard test reading the other file. This one deserves the
same: a test asserting every colour in `tailwind.config.ts` resolves to a `--cw-*` variable, so the
palette cannot fork again.

**Caveat to check during Step 0:** Tailwind cannot compute opacity modifiers (`bg-paper/50`) against
a `var()` unless the variable holds bare channels rather than a hex string. Grep for slash-opacity
usage on palette colours first; if any exists, the variables have to be stored as channel triples and
the raw CSS updated to match. This is exactly the kind of thing that turns "an afternoon" into "a
week", so it gets checked before the work is scheduled, not during.

## What a dark theme actually costs here

### The palette is already drafted and validated

Three mockup pages built on 2026-08-16 carry a complete dark counterpart to the production tokens,
and it holds up in both themes:

| Token | Light | Dark | Why it moves |
|---|---|---|---|
| `paper` | `#FFFDF8` | `#17171A` | ground |
| `ink` | `#16161A` | `#F1EEE7` | body text |
| `rule` | `#E8E3D8` | `#33323A` | hairlines |
| `muted` | `#6E6A62` | `#948F86` | lifted to stay legible |
| `accent` | `#B03A2E` | `#E0705E` | **the deep red goes muddy on dark and fails contrast** |
| `pass` | `#1E6B45` | `#5DAE84` | same problem, green |
| `sev3` amber | `#C2860C` | `#D9A33C` | same |

The accent is the interesting one. `#B03A2E` is chosen to be authoritative on paper; on a dark ground
it reads as brown and drops below contrast minimums. **A dark theme cannot reuse the brand accent
unchanged**, which means the "one red accent" rule needs a second, stated value rather than a
naive inversion.

### What makes it cheap here

- **Severity is never carried by colour alone.** `SeverityMark` already encodes severity as a
  numeral, a `title`, and an `sr-only` span, with colour only reinforcing. So the ramp can shift
  without any meaning shifting with it — which is usually the expensive part of theming a status UI.
- **No raster images.** Nothing needs a dark variant asset.
- **Tables already restate their semantics** for the responsive stacked variants, so nothing depends
  on a background to be readable as a table.

### What makes it not free

- **Prerendered pages are files already on disk.** `services/prerender/` writes HTML. A theme driven
  purely by `prefers-color-scheme` works on them untouched. A theme with an explicit toggle needs the
  chosen theme applied **before first paint**, or every prerendered page flashes light before going
  dark — and the prerendered pages are the ones crawlers and first-time readers hit.
- **The toggle is a preference, and this project stores almost nothing.** A cookie or
  `localStorage` entry is a small thing, but the privacy page currently describes what is kept, so
  whatever is chosen has to appear there. **Recommendation: ship `prefers-color-scheme` only, with no
  toggle and nothing stored.** It respects the reader's existing choice, adds no state, needs no
  privacy-page change, and cannot flash.
- **Two themes double what a screenshot can mean.** Screenshots of the console appear in `STATUS.md`
  and in incident notes. Not a blocker; worth knowing before someone files a bug about a screenshot
  that does not match their screen.

## Scope, and the order to do it in

1. **Step 0 — one palette.** Tailwind colours point at `--cw-*`; guard test; opacity-modifier check.
   *Do this regardless of dark mode.*
2. **The operator console.** `/admin/*` is where a person spends hours at a time, and it is the tier
   with a real component library (`PressroomUI`) rather than inline class strings — so it is both the
   highest value and the lowest risk. **Start here.**
3. **The public site.** Higher care: it is the published record, it is prerendered, and the light
   editorial identity is a deliberate part of how the project presents itself. Worth asking whether a
   transparency site *should* follow the reader's system preference or commit to one look — this
   spec's position is that following the reader is respectful and the identity survives it, but that
   is the operator's call.
4. **The contrast pass.** Every token pair checked both ways, not eyeballed.

## What must be true whichever way it goes

- **The light theme stays the default and the identity.** Dark follows the reader's system setting;
  it does not become the new brand.
- **No colour may be defined only inside a dark block.** That is how a token ends up undefined in the
  un-stamped default state, which is the classic unreadable-theme bug.
- **Severity, vote outcome and publication state keep their non-colour carriers.** They already have
  them; a theme change must not become the reason one is dropped.
- **Contrast is measured, not judged by eye**, in both themes, including the accent on both grounds.

## Recommended next step

Do **Step 0 alone**, as its own change, and stop there. It removes a real duplicated-palette hazard,
it is small, and it makes the roadmap's existing claim true. Only then decide whether the console
gets a dark theme — with the decision made against a codebase where the answer really is a token
swap, instead of against a sentence that says so.
