---
'mikoshi-construct': patch
---

An answer session on a red CI now gets the FAIL and Error blocks and the tail of the failed-job log, without ANSI codes, passing test lines or runner setup, under a ceiling of 20000 characters, with a line naming how many characters were cut and the link of the job, instead of the first 100000 characters of the log.
