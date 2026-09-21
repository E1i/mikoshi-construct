---
"mikoshi-construct": patch
---

An observation: an acceptance played a second role at 0027's first use

Decision 0027 requires an acceptance to be red on the current tree before the implementation exists.
Its first application — decision 0028 — carried two axes, and only one behaved that way. The second
was green and could not have been red, because the defect it describes does not exist on that tree;
it becomes red only against a specifically named wrong implementation, which is what it was run
against.

So an acceptance has two legitimate roles and the rule describes one: detecting an existing defect,
which is red on the current tree, and forbidding a named wrong fix, which never is. The second needs
a clause the first does not, or it is satisfiable by construction — the named wrong implementation
must be one a reasonable implementer would actually reach for. Here it was the one the task brief
itself described as the current state.

The entry does not extend 0027. Whether "red on the current tree" should become "red on the current
tree, or against a plausible named wrong implementation" is named and left open on one application
and one gap, with the trigger stated: a second acceptance that turns out to be a guard against a
wrong fix, in an unrelated task.
