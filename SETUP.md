# Setting up Was lesen?

End to end, this takes about **30 minutes** — and most of that is writing your form questions,
not deploying. You do not need to be a developer to follow it, but you will be pasting API keys
into a dashboard.

**Contents**

1. [What you'll need](#1-what-youll-need)
2. [Run it locally](#2-run-it-locally-this-is-the-main-way) · [Deploy it (optional)](#2b-deploy-it-optional--only-for-a-shareable-link)
3. [Who uses which](#3-who-uses-which-nothing-to-configure)
4. [Keep it awake](#4-keep-it-awake-optional-but-recommended)
5. [Build your intake form](#5-build-your-intake-form)
6. [Record what you read](#6-record-what-you-read-no-second-form)
7. [Run your first cycle](#7-run-your-first-cycle)
8. [What it costs](#8-what-it-costs)
9. [Troubleshooting](#9-troubleshooting)

---

## 1. What you'll need

| | What | Where | Cost |
|---|---|---|---|
| **Required** | A Claude subscription + the `claude` CLI | [Install and log in](https://docs.claude.com/en/docs/claude-code/overview) | Covered by your Claude Pro/Max plan |
| **Recommended** | A host, if you want a shareable link | [render.com](https://render.com/) — free plan, no card | Free |
| **Recommended** | Google Books API key | [console.cloud.google.com](https://console.cloud.google.com/) → new project → enable **Books API** → Credentials → API key | Free |
| **Recommended** | A form tool | [Tally](https://tally.so) (free, what this was built against) or Google Forms | Free |
| **Optional** | Uptime pinger | [uptimerobot.com](https://uptimerobot.com) | Free |

> **There is no API key.** Claude is reached through the `claude` CLI you're already logged into,
> so runs come out of your Claude subscription rather than pay-per-token API credits. Verify it
> works before going further — `claude --version` should print a version, and `claude` on its own
> should start without asking you to log in.
>
> **This is why the pipeline only runs on your own machine.** A host has no CLI login, so a
> deployed copy can *display* a map but cannot compute one. That's the intended shape: you run it
> on your laptop, then publish the result for everyone to look at.

> **Why the Google Books key matters.** Open Library alone misses a lot of recent titles.
> Google Books fills in covers and page counts and rescues books Open Library doesn't know. It's
> free and takes three minutes. Anonymous access to Google Books now has a **zero** quota, so
> without a key that fallback is skipped entirely and you'll see more "needs verify" badges.

---

## 2. Run it locally (this is the main way)

```bash
git clone <your fork>
cd was-lesen
npm install
cp .env.example .env    # no secrets to fill in
npm run dev
```

Open http://localhost:5173. That's a fully working app — import a CSV, run, browse the map,
save the result as JSON. If you only ever use it on the laptop you plug into the projector,
**you can stop reading after §5.**

## 2b. Deploy it (optional — only for a shareable link)

Deploy if you want your group to browse the map on their own phones. The deployed copy serves and
publishes; it never runs the pipeline.

1. Fork this repo to your own GitHub account (button, top right).
2. Sign in to [Render](https://dashboard.render.com/) with GitHub.
3. **New → Blueprint**, pick your fork, and let it read `render.yaml`.
4. Set `GOOGLE_BOOKS_API_KEY` when prompted (optional). There is no Anthropic key to set.
5. Deploy. First build takes a few minutes (it's a Docker image).
6. Visit `https://<your-app-name>.onrender.com/api/health`. You want `{"ok":true}` — if you get
   that, the server is alive.

Then set `PUBLISH_TARGET=https://<your-app>.onrender.com` in your **local** `.env`, and the
publish button on your laptop sends the run straight to the hosted app in one click. That's the
only setting involved — there is no key to match up.

**A note on the free plan.** 512 MB RAM, 0.1 CPU, sleeps after 15 minutes idle, and the
filesystem is wiped on every restart. All fine for this, with two consequences worth knowing:

- The published map is stored on that disk, so **a redeploy clears it**. Re-publishing takes one
  click (you keep the run as a JSON file), but don't push code an hour before your meeting.
- If the instance runs out of memory on startup, set `EMBEDDINGS_PROVIDER=none` in the Render
  environment. You lose the semantic layout (the map falls back to a deterministic arrangement);
  everything else works. (`render.yaml` already sets this — clustering happens on your laptop and
  the map arrives with its positions baked in.)

**Hosting somewhere else?** Anything that runs a Node process works — it's one long-running
server (`npm run build && npm start`) or the included `Dockerfile`. Two things to carry over:
set `TRUST_PROXY=1` so the per-IP rate limit sees real client addresses rather than the proxy's,
and keep it to a single instance (the rate limit is in-memory, so it isn't serverless-friendly).

Free options as of mid-2026, if Render doesn't suit: **Google Cloud Run** has a real
never-expiring free quota and scales to zero, but wants a card on file. **Oracle Cloud Always
Free** is the roomiest (2 OCPU / 12 GB ARM) but you manage the VM yourself and provisioning
often reports "out of capacity" outside Frankfurt and Singapore. **Fly.io** and **Railway** no
longer have a genuine free tier. Koyeb's free tier closed after Mistral acquired them.

---

## 3. Who uses which (nothing to configure)

You end up with two screens, and they're for different people at different moments.

**The deployed link is for the group, before you meet.** Send it round a day or two ahead;
people browse the map on their phones, open the books that catch their eye, and arrive with
opinions rather than hearing a list read out. It's also what you project during the session.
They can shortlist into a tray and flip through Present — and that's all it does.

**Your laptop is where the round is made.** Importing the form, running, fixing a member's card,
adding a book someone names mid-session, keeping the past-reads list, publishing.

| | Your laptop | The deployed link |
|---|---|---|
| Who opens it | you | everyone |
| Has your `claude` login | yes | no |
| Run, import, add books, past reads | **yes** | no — those routes aren't even registered |
| Map, book details, tray, Present | yes | **yes** |

There are **no passwords anywhere**, and nothing to lock down. The run controls aren't hidden
behind one on the deployed copy — on that machine they don't exist. So there's no passphrase to
set, and no way to leave the deployment "open" by forgetting one.

> **One accepted trade-off.** Publishing to your deployed copy is unauthenticated, so someone
> who knows the URL could replace the map. Nothing leaks and nothing costs money if they do —
> you republish from your laptop in one click. This keeps the deployment zero-configuration.

---

## 4. Keep it awake (optional but recommended)

Render's free plan sleeps after 15 minutes idle, and the first visitor then waits 30–60 seconds
for it to wake — awkward when you're standing in front of the group.

Fix: a free [UptimeRobot](https://uptimerobot.com) monitor pinging
`https://<your-app>.onrender.com/api/health` every 5 minutes. One always-on service uses about
730 hours a month, and Render's free tier allows 750, so this fits.

---

## 5. Build your intake form

**Shortcut: [copy this Tally template](https://tally.so/templates/reading-interests/wdovK3).**
It already has the right questions with the right wording — duplicate it, adjust anything you
like, and send it out. You can skip the rest of this section.

Building your own? The app matches your form's **column headers by keyword**, so use the
wordings below and it will just work:

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

## 6. Record what you read (no second form)

After the group finishes a book, open the drawer's **Past reads** panel and type it in: title,
author, a 1–5 rating, and one line on how it landed. That's it.

This is what makes the next round smarter. Past reads are excluded from future candidates
automatically, and the note is fed to the scorer as taste evidence — a book by an author the
group panned needs strong counter-evidence to be proposed again, and neighbours of a hit are
treated as good bets.

The list lives at `~/.cache/satisfying-books/past-reads.csv`. It's a plain CSV, so you can open
it in a spreadsheet and fix a title; the app re-reads it whenever it changes.

> Earlier versions imported a second Tally "feedback form" CSV. That's gone — it was a whole
> extra form to build and send for information you can type in ten seconds, and it had to be
> flattened to one note per book anyway.

---

## 7. Run your first cycle

1. Send the intake form to your group. Give them a few days.
2. Export the responses as **CSV** (Tally: Submissions → Export → CSV).
3. Open your app on the laptop (`npm run dev` → http://localhost:5173).
4. Click **load csv** and pick the file. You'll see one card per member. The app quietly cleans
   up typo'd titles and looks up every book mentioned, so cards show "Title (Author)".
5. Skim the cards. Edit anything that came through wrong — it's all editable.
   Use **skip** on anyone who won't be at the next meeting; their tastes, exclusions, and rules
   leave the run entirely.
6. Pick a quality preset (start with **test** — it's cheap and shows you the shape of the output).
7. Hit **Run**. Takes 1–4 minutes depending on group size and model.
8. When the map appears: **save** the run as JSON (keep it — it's your backup), then **publish**
   it.
9. **Send the link round a day or two before you meet.** This is the point of deploying: people
   browse the map on their phones, read what caught their eye, and turn up with an opinion
   instead of hearing a list read out.
10. At the meeting: project the map from your laptop. Click covers for details. Collect
    candidates in the tray, flip through **Present** for the big-cover advocacy view, then vote
    by hand-raise. If someone names a book that isn't there, type it into the bar and score it —
    that only works on the laptop.
11. Afterwards, add what you read under **Past reads** (§6).

**Save runs into `backups/`.** That folder is gitignored, so the files can't be committed —
they carry member names and the paragraphs people wrote. Don't keep them in Downloads or on the
Desktop either; those get emptied, and on a free host the published map is the *only* other copy
(the instance restarts on its own schedule and its disk doesn't survive). Restoring is
*load run → publish*.

---

## 8. What it costs

**Nothing per run.** Claude comes out of your existing Pro/Max subscription, hosting is free on
Render's free plan, and the embeddings that position the map run in-process on your own machine.
A Google Books key is free too.

The **quality preset** in the UI still picks how hard Claude thinks:

| Preset | Model | When |
|---|---|---|
| **test** | Sonnet | Iterating on your form and data |
| **standard** | Sonnet, high effort | Most real runs |
| **best** | Fable, high effort | The meeting that matters |

(The **test** preset asks for Haiku, but the CLI doesn't serve it, so the app maps it onto Sonnet
automatically. Since you're not paying per token, there's little reason to stay on **test** once
your data is clean.)

> **Known limit — large groups.** The CLI caps a single reply at about 4096 tokens and gives no
> way to raise it. Stage 3 scores every surviving book for every member in one reply, so a big
> pool overruns that cap and the run fails at the scoring step. Around 6 members and 70+ books is
> already too big. Fewer members, or fewer candidates, stays under it. Fixing this properly means
> scoring in batches — see `docs/NOTES.md` (M33).

---

## 9. Troubleshooting

**"That CSV doesn't look like an export."**
The app couldn't find a name or interest column. Check that one header contains `name` and one
contains `interested in reading`.

**My members' suggestions went into the wrong bucket.**
Your two "List books" columns are the wrong way round, or your form tool didn't add the ` (2)`
suffix. See the trap note in [§5](#5-build-your-intake-form).

**The run dies at the scoring step / "claude CLI failed".**
Most likely the 4096-token reply cap — see the note in [§8](#8-what-it-costs). Run with fewer
members, or trim the candidate lists, and it will fit. Also check `claude --version` works and
that `claude` starts without prompting you to log in.

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
