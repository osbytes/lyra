# States and feedback

How Lyra shows work in progress, its endings and its errors, so work that outlives the screen
that started it is never invisible, never silent when it fails, and never lost. The design boards
(variants, a clickable prototype and the full inventory) are in the "Lyra states and feedback
design guide" canvas; this file is the rulebook the code follows.

## Principles

1. **Work belongs to main, not to a screen.** Anything that can take over a second and can
   outlive the screen that started it reports to the Activity registry
   (`apps/lyra/src/main/activity.ts`). Windows subscribe to it; closing one loses nothing.
2. **Show it where it started, and where it can always be found.** The control that started it
   shows the detail (rungs 0–1). Activity lists anything still running or needing attention: in
   the sidebar footer, or behind a top-bar button when the sidebar is hidden. Whether the
   sidebar is open never decides whether you hear about work.
3. **Match the feedback to the wait** (see Timing).
4. **Quiet success, persistent failure.** A result appearing on screen is its own confirmation.
   Announce an ending only when the person isn't looking at its result. A failure stays until
   it's retried, dismissed, or its cause goes away.
5. **Every error ends in an action**: what didn't work, why in plain words if known, and one way
   forward (Retry, Open Settings, Allow access). Raw error text goes to the log.
6. **Background work never takes your words.** Edited content is skipped by automatic and bulk
   runs, and the result says how many were skipped.
7. **One component, one vocabulary**: `StatusLine`-style lines, Activity rows and the toast, with
   the wording rules below.

## The ladder: where feedback appears

| Rung | Surface | Use for |
| --- | --- | --- |
| 0 | The control itself (Copy → Copied, Write summary → Stop summary) | Under 10 s, result in view |
| 1 | A status line beside what it's about (Settings row, transcript bar, dock) | The detail: phase, count, Cancel, the ending |
| 2 | A mark on the session's row in the sidebar | A session's own work; hidden with the sidebar, so never alone |
| 3 | Activity: sidebar footer, or the top-bar button when the sidebar is hidden | Anything running over 3 s or ended unseen |
| 4 | Toast | Announcing an ending whose screen isn't open; one action at most |
| 5 | Overlay pill, tray | The live recording while the window is hidden |
| 6 | System notification | Long work you started, finished while Lyra is in the background |

A dialog is for a decision only, never for progress or news.

| Situation | While working | Done | Failed |
| --- | --- | --- | --- |
| Under 10 s, result in view | 0 | 0 (the result) | 0 or 1 |
| Longer, one session | 1 + 2, 3 past a minute | 1; 4 if elsewhere | 1 + 2 + 3 |
| Longer, app-wide, you started it | 1 + 3 | 1; 4 if its screen is closed | 1 + 3 until seen |
| Automatic, you didn't ask | 2 only | nothing | 2 + 3 |

## States

A task is `running`, then ends `done`, `partial`, `failed` or `cancelled`; `waiting` means it
needs the person to act and isn't an error (an update to install). Cancelled is never an error.
Lasting conditions of a feature or data: empty (first run, or no results: name the filter and
offer to clear it), off (the user's choice: not a warning), needs setup, blocked by the OS,
unavailable (a server not running), outdated, edited by you, still processing, degraded,
couldn't load (error boundary), disabled control (always with a reason).

## Timing

| Wait | Show |
| --- | --- |
| Under 0.4 s | Nothing. A spinner shown later stays at least 0.5 s |
| 0.4–3 s | The control is busy and can't be pressed twice; lists keep old rows |
| 3–10 s | A status line naming the step; Stop if it can stop |
| 10 s–1 min | A bar with a count in a real unit (MB, sessions, parts) and Cancel; app-wide work is in Activity after 3 s |
| Over 1 min | Say it's fine to leave; time left only once steady; tell people it's done if Lyra was in the background |

Phases (download, then read sessions) each get their own label and bar. Saving needs no
indicator, only a failure. Spinners stop under reduced motion; the words carry the state.

## Errors

- A field: under it, on leaving or saving, tied with `aria-describedby`; keep what was typed.
- An action just taken: a line under the control, `role="alert"`.
- Background work: its status line, a mark on its session, and an Activity row until it's
  seen and dealt with; a toast points to it once if you were elsewhere.
- Some of many: lead with what worked, name each failure with its reason, retry only those.
- Blocked before it starts: say what still works, link to the exact system setting, clear it
  once fixed.
- A crashed pane: "Your notes are safe" first, then Reload this pane.

Retry on its own only when it's free and transient (download drops, three times with backoff),
never a paid cloud call more than once. Keep the work: a failed summary keeps the old one.

## Words

| State | Write | Not |
| --- | --- | --- |
| Working | Downloading the search model… | Loading… / Please wait |
| Counting | 63 of 150 MB · part 3 of 9 | 3/9 · 42.13% |
| Done | Summary written · Search by meaning is ready | Success! |
| Failed | Couldn't write the summary: the key was refused. | Oops! Error 401 |
| Stopped | Summary stopped · Download cancelled | Error: aborted |
| Buttons | Retry · Stop · Open · Allow access | OK · Yes · Click here |

Sentence case, no exclamation marks, no error codes, no note text in Activity, toasts or
notifications (names of sessions are fine).

## Accessibility

- One polite live region per surface; announce the start, each phase and the ending, never every
  percent. An error from the person's own action is `role="alert"`; background ones are polite.
- Bars are `role="progressbar"` with `aria-valuetext` ("63 of 150 MB").
- Toasts never take focus (F6 reaches them); an error is never shown only in a toast.
- Colour never alone: an icon and words with every warning; text meets 4.5:1.

## In code

- Main: `report()` / `end()` / `onActivityAction()` in `src/main/activity.ts`. Ids are stable per
  thing (`model:semanticSearch`, `notes:<pageId>`, `backfill`, `update`). Running items carry
  `progress` (0–1 or null) and a `detail` in a real unit; endings carry the result or the reason.
- Shared pure rules: `src/shared/activity.ts` (what's visible, what the collapsed button shows,
  when an ending is cleared). Unit-tested.
- Renderer: `useActivity()`, `ActivityFooter` and `ActivityButton` (`components/Activity.tsx`);
  App raises ending toasts and marks items seen when their screen is open.
- A new long-running feature: report it to Activity, give it a rung-1 line where it started,
  and add it to the inventory in the design canvas.
