https://roadmap.sh/projects/github-user-activity

# github-activity

A simple, **zero-dependency** command-line tool that fetches a GitHub user's
recent public activity from the GitHub REST API and prints it to your
terminal.

Built entirely with Node.js core modules (`https`) — no npm packages
required to run it.

## Requirements

- Node.js v14 or later installed on your machine.

## Files in this project

```
github-activity-cli/
├── github-activity.js   # the whole CLI — this is the only code file
├── package.json         # lets you install it as a global "github-activity" command
└── README.md
```

## Step 1 — Get the files onto your machine

Download `github-activity.js` and `package.json` into a folder, e.g.
`github-activity-cli/`.

## Step 2 — Run it directly with Node (no install needed)

From inside the project folder:

```bash
node github-activity.js <username>
```

Example:

```bash
node github-activity.js bu1k3m
```

Example output:

```
Recent activity for bu1k3m:

- Pushed 3 commits to bu1k3m/developer-roadmap
- Opened an issue in bu1k3m/developer-roadmap
- Starred bu1k3m/developer-roadmap
```

### Optional flags

```bash
node github-activity.js <username> [--limit <n>] [--type <EventType>] [--json]
```

- `--limit <n>` — show only the first `n` events (after any `--type` filter)
- `--type <EventType>` — show only events of one type, e.g. `PushEvent`,
  `WatchEvent`, `IssuesEvent`, `PullRequestEvent`, `ForkEvent`, `CreateEvent`
- `--json` — print the filtered/limited events as raw JSON instead of
  formatted text
  Flags can go before or after the username, e.g. both of these work:

```bash
node github-activity.js kamranahmedse --limit 5
node github-activity.js --type PushEvent kamranahmedse
```

That's enough to use the tool. The steps below are optional and let you
run it as a short `github-activity <username>` command from anywhere.

## Step 3 (optional) — Install it as a global command

This uses `npm link`, which reads the `"bin"` field in `package.json` and
creates a symlink so your terminal recognizes `github-activity` as a
command.

```bash
cd github-activity-cli
npm link
```

On macOS/Linux you may need `sudo npm link` depending on how Node was
installed.

Now, from any directory:

```bash
github-activity bu1k3m

```

To remove the global command later:

```bash
npm unlink -g github-activity-cli
```

## How it works, step by step

1. **Read the argument** — `process.argv` holds the raw command-line
   arguments; the script slices off the first two (the Node path and the
   script path) and treats the next one as the username. It also
   validates the format against GitHub's username rules.
2. **Build the request** — it targets
   `https://api.github.com/users/<username>/events` using Node's built-in
   `https` module, sending the `User-Agent` and `Accept` headers GitHub's
   API requires.
3. **Collect the response** — HTTP responses arrive in chunks; the script
   listens for `'data'` events to build up the full JSON string, then
   `'end'` to know the body is complete.
4. **Check the status code**:
   - `404` → the username doesn't exist
   - `403` / `429` → you've hit GitHub's rate limit (60 requests/hour for
     unauthenticated requests) — the message tells you when it resets
   - anything else outside 200–299 → a generic API error, with GitHub's
     response body included
   - `2xx` → parse the body as JSON
5. **Format each event** — GitHub's API returns an array of event
   objects, each with a `type` (e.g. `PushEvent`, `WatchEvent`,
   `IssuesEvent`) and a `payload` with type-specific details. The script
   has one case per common event type and a fallback for anything else,
   so it never silently skips an event.
6. **Print the results** — one line per event, or a friendly "no recent
   activity" message if the array is empty.

## Notes on the GitHub API rate limit

Unauthenticated requests to the GitHub API are limited to **60 per hour
per IP address**. If you see a rate-limit error, wait for the reset time
shown in the error message, or try again later. This project intentionally
avoids authentication to keep it dependency-free and simple, per the
project requirements.

## Extending it

Some natural next steps if you want to keep practicing:

- Add a `--limit <n>` flag to show only the first `n` events
- Add colored output (would require a small library, or raw ANSI escape
  codes if you want to stay dependency-free)
- Cache responses locally to avoid hitting the rate limit while testing
- Add authenticated requests (a personal access token) to raise the rate
  limit to 5,000/hour
