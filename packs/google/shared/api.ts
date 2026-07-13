// Shared host↔UI contract for the Google Calendar pack. Event types are copied verbatim from the
// built-in (myview src/shared/types/calendar.ts) so the cloned UI renders identically.

/** A meeting attendee's RSVP. */
export type RsvpStatus = 'accepted' | 'declined' | 'tentative' | 'needsAction'

export interface Attendee {
  email?: string
  name?: string
  /** True if this attendee is you. */
  self?: boolean
  /** True if this attendee is the organizer. */
  organizer?: boolean
  response?: RsvpStatus
  optional?: boolean
}

/** A calendar event, normalized from the Google Calendar API. */
export interface CalendarEvent {
  id: string
  title: string
  /** ISO datetime (timed) or YYYY-MM-DD (all-day) of the start. */
  start: string
  /** ISO datetime / date of the end. */
  end?: string
  allDay: boolean
  location?: string
  /** Video-conference link (Meet/Zoom/…), if any. */
  joinUrl?: string
  /** Link to open the event in Google Calendar. */
  url?: string
  status?: string
  /** Agenda / notes (plain text, HTML stripped). */
  description?: string
  organizer?: { email?: string; name?: string; self?: boolean }
  attendees?: Attendee[]
}

/** OAuth credentials the UI persists (client id/secret + refresh token) and passes to host calls. */
export interface Creds {
  clientId: string
  clientSecret: string
  refreshToken: string
}

/** Host RPC surface. The host is stateless re: persistence — the UI passes creds on every call. */
export interface Api {
  /** Interactive OAuth: emits `auth:url` (UI opens it), captures the loopback redirect, returns tokens. */
  connect(a: { clientId: string; clientSecret: string }): Promise<{ email: string; refreshToken: string }>
  listUpcoming(a: Creds & { range: string; maxResults: number; calendarId?: string }): Promise<CalendarEvent[]>
  listDay(a: Creds & { dayOffset: number; calendarId?: string }): Promise<CalendarEvent[]>
}

export interface Events {
  /** Sign-in URL — the UI opens it with g.openExternal (host has no Electron shell). */
  'auth:url': { url: string }
}
