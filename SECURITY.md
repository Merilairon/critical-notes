# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, pull request or discussion for them.

Use the private vulnerability reporting of the host where this repository lives: the "Report a vulnerability"
button under the repository's Security tab.

Include what you found, the version or commit, how you installed it (Docker or from source), and the steps to
reproduce it. Do not include rules content (5etools text or art) or other people's data.

You can expect an acknowledgement within 7 days. We will keep you informed, fix the problem, and credit
you in the release notes if you wish.

## Supported versions

Only the latest release receives security fixes. If you run an older version, upgrade to the latest release
first and check whether the problem is still there.

## What counts

Examples: a player receiving DM-only content, access to another campaign or user's data, authentication or
session bypass, an MCP token with more rights than its owner, script injection, path traversal in the
image or upload handling.

Out of scope: problems that need an already compromised host, and issues in a third-party dependency that are
not reachable through Critical Notes (report those upstream).
