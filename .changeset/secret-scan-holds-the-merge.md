---
'mikoshi-construct': patch
---

bus: the merge node reads the Secret scan check beside the required one. A pull request whose Secret scan is red is red to the bus, and one whose Secret scan is still running is pending, however green the required check is; a head with no Secret scan reported reads as before. The fake GH_TOKEN of the factory-off-owner-machine test is now a value the gitleaks GitHub token rule does not match.
