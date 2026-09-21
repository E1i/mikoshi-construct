---
"mikoshi-construct": minor
---

`/plan` in Claude Code requires a criterion to be seen failing before the change

The plan command asked for acceptance criteria a harness run or a test can confirm, and for each
criterion to be verified by what the task changes itself. Both are satisfied in full by a criterion
that has never been shown failing, so a task could carry four criteria, all of them green from the
first moment, none of them able to tell a change that worked from one that was never needed. The
command now asks for the criterion to be run and seen failing first.

**It is scoped, and the scope is the point.** The requirement reads *where a criterion can fail
against the repository as it stands*. A criterion for a defect or for absent behaviour can; one
written to forbid a wrong implementation cannot, and the command says nothing about that case in
either direction. Stating the wide form would have a planning agent reject a legitimate guard;
stating the narrow form as universal would do the same. Silence here is the honest state of a
question that is open.

**This is not enforcement, and the distinction is worth reading slowly.** What changes is that the
rule reaches the planning command in Claude Code — not planning in general, and not Cursor, which
this tool gives no `/plan` equivalent. The instruction is prose an agent may or may not follow —
L0 on the scale this tool reports, exactly like the discovery protocol, and nothing reports a
violation of it. The carrier is the evidence a run leaves behind, and it is not built here. Anyone
reporting this release as *the rule now works* is making a claim wider than what was done.
