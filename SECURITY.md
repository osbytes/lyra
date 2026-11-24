# Security

Lyra is a local desktop app. Audio, transcripts, and notes stay on the device. It goes online
only to download its models on first use (each pinned and checked against a sha256 hash), to
check GitHub for updates, and, when you turn cloud summaries on, to send a session's transcript
to the provider you picked (Anthropic, OpenAI, Google, or your own OpenAI-compatible server). What it protects and how is in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

## Reporting a vulnerability

**Do not open a public GitHub issue for security bugs.**

Report privately through [GitHub Security Advisories](https://github.com/osbytes/lyra/security/advisories/new). Enable **Private vulnerability reporting** in the repository settings if that page is not available yet.

Please include:

- A description of the issue
- Steps to reproduce
- Affected versions / platforms if you know them

We will acknowledge the report and work on a fix before any public disclosure.
