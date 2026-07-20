# Atlassian

Jira issues and Bitbucket pull requests on your desktop — one account, per-product tokens.

## Widgets

- **Jira Tickets** — your assigned/filtered issues with status, priority, and one-click open. Configure
  a project, JQL, "only mine", statuses, sprint, and refresh interval per placement.
- **Pull Requests** — open PRs across your Bitbucket repos, grouped by repo, with review state and a
  direct link.

## Setup

Open **Settings → Atlassian** and enter, once (shared by both widgets):

| Field | Where to get it |
|-------|-----------------|
| **Email** | your Atlassian account email |
| **Jira site** | `your-domain.atlassian.net` (no `https://`) |
| **Jira API token** | [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens) → Create API token |
| **Bitbucket token** | Bitbucket → Personal settings → API tokens / app password |

Then add a widget from **Add widget → Atlassian**.

## Background notifications

Turn on **Background notifications** in Settings to get a click-through alert when a new ticket is
assigned to you — even when the widget isn't on the board. Polls every ~5 minutes; no widget needs to
be open.

## Privacy & access

- **Network** — talks only to `*.atlassian.net` and `api.bitbucket.org`.
- **Storage** — your email + site are stored locally; tokens are kept in the encrypted secret store and
  never leave your machine except as auth headers to Atlassian/Bitbucket.
- No host process — this pack runs fully sandboxed.
