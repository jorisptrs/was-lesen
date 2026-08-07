# Backups

Put saved runs and published-map backups here. **Everything in this folder is gitignored** apart
from this file.

A run's JSON carries member names and the paragraphs they wrote, so it must never be committed —
and it shouldn't live in a folder you periodically empty either. Hence this one.

Two things worth keeping:

- **The run you published.** A deployed copy on a free host has an ephemeral disk: it loses the
  published map whenever the instance restarts, which happens on its own schedule. With the file
  here, restoring is *load run → publish*.
- **Saved runs from past rounds**, if you want to look back at a map or re-publish an old one.

Your laptop also keeps the last thing you published at
`~/.cache/satisfying-books/published-run.json`, which is a second copy of the same thing.
