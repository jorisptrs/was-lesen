# Setting up Was lesen?

End to end, this takes about **30 minutes** — and most of that is writing your form questions,
not deploying. You do not need to be a developer to follow it, but you will be pasting API keys
into a dashboard.

**Contents**

1. [What you'll need](#1-what-youll-need)
2. [Deploy it](#2-deploy-it)
3. [Lock it down ← don't skip](#3-lock-it-down--dont-skip)
4. [Keep it awake](#4-keep-it-awake-optional-but-recommended)
5. [Build your intake form](#5-build-your-intake-form)
6. [Build your feedback form](#6-build-your-feedback-form-optional)
7. [Run your first cycle](#7-run-your-first-cycle)
8. [What it costs](#8-what-it-costs)
9. [Free runs on a Claude subscription](#9-free-runs-on-a-claude-subscription-optional)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. What you'll need

| | What | Where | Cost |
|---|---|---|---|
| **Required** | Anthropic API key | [console.anthropic.com](https://console.anthropic.com/settings/keys) → API keys → Create key | Pay per run, see [§8](#8-what-it-costs) |
| **Required** | A host | [render.com](https://render.com/) — free plan, no card | Free |
| **Recommended** | Google Books API key | [console.cloud.google.com](https://console.cloud.google.com/) → new project → enable **Books API** → Credentials → API key | Free |
| **Recommended** | A form tool | [Tally](https://tally.so) (free, what this was built against) or Google Forms | Free |
| **Optional** | Uptime pinger | [uptimerobot.com](https://uptimerobot.com) | Free |

> **Why the Google Books key matters.** Open Library alone misses a lot of recent titles.
> Google Books fills in covers and page counts and rescues books Open Library doesn't know. It's
> free and takes three minutes. Anonymous access to Google Books now has a **zero** quota, so
> without a key that fallback is skipped entirely and you'll see more "needs verify" badges.

---

## 2. Deploy it

The repo ships a `render.yaml` blueprint, so Render configures itself.

1. Fork this repo to your own GitHub account (button, top right).
2. Sign in to [Render](https://dashboard.render.com/) with GitHub.
3. **New → Blueprint**, pick your fork, and let it read `render.yaml`.
4. It will prompt for the two secret values. Paste them:
   - `ANTHROPIC_API_KEY` — from step 1
   - `GOOGLE_BOOKS_API_KEY` — optional but recommended
5. Deploy. First build takes a few minutes (it's a Docker image).
6. Visit `https://<your-app-name>.onrender.com/api/health`. You want `{"ok":true}` or similar —
   if you get that, the server is alive.

**A note on the free plan.** 512 MB RAM, 0.1 CPU, sleeps after 15 minutes idle, and the
filesystem is wiped on every restart. All fine for this, with two consequences worth knowing:

- The published map is stored on that disk, so **a redeploy clears it**. Re-publishing takes one
  click (you keep the run as a JSON file), but don't push code an hour before your meeting.
- If the instance runs out of memory on startup, set `EMBEDDINGS_PROVIDER=none` in the Render
  environment. You lose the semantic layout (the map falls back to a deterministic arrangement);
  everything else works.

---

## 3. Lock it down ← don't skip

**Set `APP_PASSPHRASE` in Render → your service → Environment.** Any string; treat it like a
password.

Without it, your app is **completely open**: anyone who finds the URL can start runs, and every
run spends *your* Anthropic credits. The per-IP rate limit is the only thing standing between a
stranger and your bill.

With it set:

- **Everyone** who opens the link sees the latest published map, read-only. They can pan, zoom,
  tap a cover for details, and collect books into a tray. They cannot run or publish.
- **You** click **unlock** (top right), enter the passphrase once, and get the full app. Your
  browser remembers it.

Members never need the passphrase. Only you do.

---

## 4. Keep it awake (optional but recommended)

Render's free plan sleeps after 15 minutes idle, and the first visitor then waits 30–60 seconds
for it to wake — awkward when you're standing in front of the group.

Fix: a free [UptimeRobot](https://uptimerobot.com) monitor pinging
`https://<your-app>.onrender.com/api/health` every 5 minutes. One always-on service uses about
730 hours a month, and Render's free tier allows 750, so this fits.

---

## 5. Build your intake form

This is the only fiddly part, because the app matches your form's **column headers by keyword**.
Use the question wordings below and it will just work.

Make one form (I use [Tally](https://tally.so)) with these questions:

| # | Ask this | Matched by | Becomes |
|---|---|---|---|
| 1 | **Your name** | `name` | Who the member is |
| 2 | **How many pages can you read in two weeks?** | `pages` | Their reading budget — feeds the pace graph |
| 3 | **What are you interested in reading right now?** | `interested in reading` | Their taste paragraph — the main signal |
| 4 | **Concretely, name 3–5 books you've loved.** | `concretely` | Taste examples (and candidate seeds) |
| 5 | **List books you've already read and don't want to redo.** | `list books` | Hard exclusions |
| 6 | **List books you'd like to suggest to the group.** | `list books` *(second one)* | Candidate seeds — "Suggested by X" |
| 7 | **Anything else we should know?** | `anything` | Group rules (languages, formats, length limits) |
| 8 | **One belief you hold that you'd like stress-tested — or a question where you suspect you might be wrong.** | `stress-test`, `belief`, or `wrong` | Lets the scoring reward books that challenge what they *asked* to have challenged |

Questions 7 and 8 are optional; the rest carry their weight.

> **The one real trap.** Questions 5 and 6 both start with "List books". Tally handles duplicate
> question titles by appending ` (2)` to the second one in the CSV export — and the app relies on
> exactly that to tell them apart: **the plain one is "already read", the "(2)" one is
> "suggestions"**. If your form tool doesn't do this, or you word them differently, just make sure
> only one column contains the phrase "list books" without a `(2)`, or edit the mapping block in
> `client/src/lib/tallyCsv.ts` (it's clearly commented and lives in one place).

> **Second trap.** Don't use the words *finish*, *satisfied*, or *rating* in your intake form
> questions. The app decides which of your two forms a CSV came from by looking for a "book"
> column alongside one of those words — using them here makes your intake CSV look like a
> feedback CSV.

Question 8 deserves a word, since it looks odd on a book-club form. It exists so the tool can
reward a book that argues *against* something a member believes — but only because that member
asked for it. Nobody gets challenge imposed on them; it's opt-in by construction.

---

## 6. Build your feedback form (optional)

Send this out **after** the group finishes a book. It's what makes the next round smarter: past
reads get excluded automatically, and the ratings calibrate future scoring.

| Ask this | Matched by |
|---|---|
| **Your name** | `name` |
| **Which book?** | `book` |
| **Did you finish it?** | `finish` |
| **How satisfied were you? (1–5)** | `satisf` or `rating` |
| **One line of feedback** | `feedback` or `one line` |
| **Did this book change your mind about anything? Name the belief — or "none".** | `change your mind` or `belief` |

You upload this with the same "load csv" link; the app detects which form it is.

---

## 7. Run your first cycle

1. Send the intake form to your group. Give them a few days.
2. Export the responses as **CSV** (Tally: Submissions → Export → CSV).
3. Open your app, click **unlock**, enter your passphrase.
4. Click **load csv** and pick the file. You'll see one card per member. The app quietly cleans
   up typo'd titles and looks up every book mentioned, so cards show "Title (Author)".
5. Skim the cards. Edit anything that came through wrong — it's all editable.
   Use **skip** on anyone who won't be at the next meeting; their tastes, exclusions, and rules
   leave the run entirely.
6. Pick a quality preset (start with **test** — it's cheap and shows you the shape of the output).
7. Hit **Run**. Takes 1–4 minutes depending on group size and model.
8. When the map appears: **save** the run as JSON (keep it — it's your backup), then **publish**
   it so everyone on the link sees the same map.
9. At the meeting: project the map. Click covers for details. Collect candidates in the tray,
   flip through **Present** for the big-cover advocacy view, then vote by hand-raise.

**Keep the saved JSON files somewhere outside the repo.** They contain member names and their
paragraphs.

---

## 8. What it costs

Per run, roughly:

| Preset | Model | Cost |
|---|---|---|
| **test** | Haiku | ~$0.25 |
| **standard** | Sonnet | ~$1 |
| **best** | Fable | ~$2 |

Plus a few cents for title cleanup and the rule filter. For a monthly book club that's a couple
of dollars a year at **test**, or ~$25/year if you always use **best**.

Iterate on **test** while you're getting your form and your group's data right, then run
**best** for the meeting that matters. The difference shows up most in the cluster names and in
how well the scoring reads a subtle paragraph.

Hosting is free. Embeddings are free (they run in-process, on the server, no API).

---

## 9. Free runs on a Claude subscription (optional)

If you have a Claude Pro or Max subscription, you can run the pipeline through the
[Claude CLI](https://docs.claude.com/en/docs/claude-code/overview) instead of paying per token.
This only works on **your own machine** — a host has no CLI login.

```bash
npm install
cp .env.example .env       # set CLAUDE_BACKEND=cli
npm run dev
```

Then bridge the result to your hosted app: run locally → **save** the JSON → open the hosted app
→ unlock → **load run** → **publish**. Or set `PUBLISH_TARGET=https://<your-app>.onrender.com`
and `PUBLISH_PASSPHRASE=<your APP_PASSPHRASE>` in your local `.env`, and **publish** forwards
there in one click.

---

## 10. Troubleshooting

**"That CSV doesn't look like an export."**
The app couldn't find a name or interest column. Check that one header contains `name` and one
contains `interested in reading`.

**My members' suggestions went into the wrong bucket.**
Your two "List books" columns are the wrong way round, or your form tool didn't add the ` (2)`
suffix. See the trap note in [§5](#5-build-your-intake-form).

**Lots of books show "needs verify".**
Usually a missing `GOOGLE_BOOKS_API_KEY`. Some books are genuinely just niche or non-English —
the badge is honest there, flagging rather than mis-matching.

**The map is a grid instead of clusters.**
Embeddings didn't run. Either `EMBEDDINGS_PROVIDER=none`, or the instance ran out of memory.
The run itself is unaffected — layout degrades, nothing else.

**The published map vanished.**
You (or a push) redeployed. The disk is ephemeral. Load your saved JSON and publish again.

**First visitor waits a minute.**
The instance was asleep. See [§4](#4-keep-it-awake-optional-but-recommended).

**Runs are slow or time out on Render free.**
0.1 CPU is genuinely slow for local embeddings. Set `EMBEDDINGS_PROVIDER=none`, or run locally
and publish the result.

---

Every other knob is documented inline in [`.env.example`](.env.example). The reasoning behind
the design — including the parts that were built and then deleted — is in
[`docs/NOTES.md`](docs/NOTES.md).
