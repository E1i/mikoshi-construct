# Frozen manifests

Each `construct.json` here is the real shape of a manifest written by the version named in its
directory — code that no longer exists and that today's code cannot reproduce. That is the whole
point of freezing them: a replay change can be run against records the current templates could never
generate, which no fixture written by today's code can do.

Every name has been replaced. The project name, the package scope and the package names are
invented; what is kept is the shape — how many packages there are, what roles they play and how they
are allowed to import one another, which is what the fixtures actually exercise. Nothing here names
a real project, a real package or anyone's counterparty, and nothing here should ever be edited
toward "more realism".

The recorded `files` hashes are meaningless after that replacement. They are kept because their
presence and their keys are part of the shape, not because any of them is the hash of anything.
Never compare a rendering against them; they are there to be counted and keyed, never matched.
