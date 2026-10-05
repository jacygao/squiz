---
name: squiz-review
description: Run squiz's review of a pull request and work what it finds. Load this after opening a pull request and after every push to one, before reporting the work done.
---

# Reviewing a pull request with squiz

Run `squiz review <number>` from the worktree the pull request's branch is
checked out in. It runs a review and waits for it, which takes several minutes.
Give the Bash call a `timeout` of 600000. If the command is moved to the
background anyway, wait for it to finish and read its output before you do
anything else.

- **Exit 0:** nothing is open. You are done.
- **Exit 2:** threads are open, and the command prints them. Its first line names
  a file holding the whole output. Where what you were shown is cut short, read
  that file. Fix what applies, reply on each thread with `squiz reply <id> <text>`
  to say what you changed or why you disagree, commit and push what you changed,
  and run `squiz review <number>` again. A reply is reviewed even with no new
  commit.
- **Exit 3:** the review closed with threads still open. Do not run it again. Say
  in your report which threads are open.
- **Exit 4:** squiz is still reviewing. Run `squiz review <number>` again.
- **Exit 1, or anything else:** the review could not run, or it failed. Put the
  lines it printed in your report, and do not run it again.
