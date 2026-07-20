# Google Calendar

Your Google Calendar on the desktop — an agenda list or a full day timeline, with attendees, RSVP
status, and one-click video join.

## Views

- **Agenda** — upcoming events (Today / next 24h / next 7 days), each expandable to attendees + join.
- **Day timeline** — a scrollable 24-hour grid with overlapping events laid out side by side and a
  live "now" line.

## Setup

This pack signs in with your own Google OAuth client (read-only Calendar scope).

1. In [Google Cloud Console](https://console.cloud.google.com/), create an **OAuth client ID** of type
   **Desktop app**, and enable the **Google Calendar API** for the project.
2. In the widget's **⚙ Settings**, paste the **Client ID** and **Client secret**, then click
   **Connect Google** and authorize in the browser.

Sign-in uses a loopback redirect + PKCE; only a refresh token is stored (encrypted).

> **Heads up:** this pack ships a small **host** (runs code on your computer) to perform the OAuth
> loopback and Calendar requests, so you'll see a "runs code on your computer" note at install — the
> same model as any host widget.

## Privacy & access

- **Network** — Google OAuth + Calendar endpoints only.
- **Secrets** — client secret + refresh token live in the encrypted store; the app never displays them
  back.
- Read-only: the widget never modifies your calendar.
