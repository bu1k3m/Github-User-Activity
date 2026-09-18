#!/usr/bin/env node

/**
 * github-activity
 *
 * A zero-dependency CLI that fetches a GitHub user's recent public activity
 * and prints it to the terminal.
 *
 * Usage:
 *   node github-activity.js <username>
 *   github-activity <username>          (after `npm link`, see README)
 *
 * Only Node's built-in modules are used (https, process) -- no npm packages.
 */

"use strict";

const https = require("https");

/**
 * The full list of GitHub event types this tool knows how to format.
 * Used both to validate the --type flag and to build the usage message.
 */
const KNOWN_EVENT_TYPES = [
  "PushEvent",
  "IssuesEvent",
  "IssueCommentEvent",
  "PullRequestEvent",
  "PullRequestReviewEvent",
  "PullRequestReviewCommentEvent",
  "WatchEvent",
  "ForkEvent",
  "CreateEvent",
  "DeleteEvent",
  "ReleaseEvent",
  "PublicEvent",
  "MemberEvent",
  "GollumEvent",
  "CommitCommentEvent",
];

/**
 * Step 1: Parse the command-line arguments into a structured options object.
 *
 * process.argv looks like:
 *   [0] path to the node binary
 *   [1] path to this script
 *   [2..] the real arguments -- a mix of the username and flags
 *
 * Supported flags:
 *   --limit <n>   only show the first n events (after filtering)
 *   --type <Type> only show events of this type, e.g. PushEvent
 *   --json        print the raw filtered/limited data as JSON instead of
 *                 formatted text
 *
 * Flags can appear in any order, before or after the username, e.g. both
 * of these are valid:
 *   github-activity bu1k3m --limit 5
 *   github-activity --type PushEvent bu1k3m
 */
function parseArgs() {
  const args = process.argv.slice(2); // drop "node" and the script path

  const options = {
    username: null,
    limit: null,
    type: null,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--limit") {
      const value = args[i + 1];
      const parsedLimit = Number(value);
      if (!value || !Number.isInteger(parsedLimit) || parsedLimit <= 0) {
        printUsageAndExit(
          "--limit requires a positive whole number, e.g. --limit 5",
        );
      }
      options.limit = parsedLimit;
      i++; // skip the value we just consumed
      continue;
    }

    if (arg === "--type") {
      const value = args[i + 1];
      if (!value) {
        printUsageAndExit(
          "--type requires an event type, e.g. --type PushEvent",
        );
      }
      if (!KNOWN_EVENT_TYPES.includes(value)) {
        printUsageAndExit(
          `"${value}" isn't a recognized event type.\nKnown types: ${KNOWN_EVENT_TYPES.join(", ")}`,
        );
      }
      options.type = value;
      i++; // skip the value we just consumed
      continue;
    }

    if (arg === "--json") {
      options.json = true;
      continue;
    }

    if (arg.startsWith("--")) {
      printUsageAndExit(`Unknown flag: ${arg}`);
    }

    // Anything that isn't a recognized flag is treated as the username.
    if (options.username === null) {
      options.username = arg.trim();
    } else {
      printUsageAndExit(`Unexpected extra argument: ${arg}`);
    }
  }

  if (!options.username) {
    printUsageAndExit("Missing argument: please provide a GitHub username.");
  }

  // Basic sanity check: GitHub usernames may only contain alphanumeric
  // characters and single hyphens, and cannot start/end with a hyphen.
  const validUsernamePattern =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
  if (!validUsernamePattern.test(options.username)) {
    printUsageAndExit(
      `"${options.username}" doesn't look like a valid GitHub username.`,
    );
  }

  return options;
}

function printUsageAndExit(message) {
  console.error(`Error: ${message}`);
  console.error("\nUsage:");
  console.error("  github-activity <username> [options]");
  console.error("\nOptions:");
  console.error("  --limit <n>      show only the first n events");
  console.error(
    "  --type <Type>    show only events of this type (e.g. PushEvent)",
  );
  console.error("  --json           print raw JSON instead of formatted text");
  console.error("\nExamples:");
  console.error("  github-activity bu1k3m");
  console.error("  github-activity bu1k3m --limit 5");
  console.error("  github-activity bu1k3m --type PushEvent");
  console.error("  github-activity bu1k3m --limit 3 --json");
  process.exit(1);
}

/**
 * Step 2: Fetch the events for that username from the GitHub REST API.
 *
 * Endpoint: GET https://api.github.com/users/<username>/events
 *
 * We use the built-in `https` module directly (no axios/node-fetch), and
 * wrap it in a Promise so the rest of the code can use async/await.
 *
 * GitHub's API requires:
 *   - an explicit User-Agent header (requests without one are rejected), and
 *   - an Accept header naming the API version we want.
 */
function fetchGithubEvents(username) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/users/${encodeURIComponent(username)}/events`,
      method: "GET",
      headers: {
        "User-Agent": "github-activity-cli", // required by GitHub's API
        Accept: "application/vnd.github+json",
      },
    };

    const request = https.request(options, (response) => {
      let rawData = "";

      // Response bodies arrive in chunks; collect them all first.
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        rawData += chunk;
      });

      response.on("end", () => {
        handleResponseEnd(response, rawData, username, resolve, reject);
      });
    });

    // Network-level failures (DNS issues, no internet connection, etc.)
    request.on("error", (err) => {
      reject(
        new Error(
          `Network error while contacting the GitHub API: ${err.message}`,
        ),
      );
    });

    // Guard against a request that hangs forever.
    request.setTimeout(10000, () => {
      request.destroy(new Error("Request to GitHub API timed out after 10s"));
    });

    request.end();
  });
}

/**
 * Step 3: Interpret the HTTP status code and either resolve with the
 * parsed JSON or reject with a helpful, human-readable error.
 */
function handleResponseEnd(response, rawData, username, resolve, reject) {
  const statusCode = response.statusCode;

  // GitHub returns 404 when the username does not exist.
  if (statusCode === 404) {
    reject(new Error(`User "${username}" was not found on GitHub.`));
    return;
  }

  // GitHub returns 403 (sometimes 429) when you've hit the rate limit for
  // unauthenticated requests (60 requests/hour per IP).
  if (statusCode === 403 || statusCode === 429) {
    const resetHeader = response.headers["x-ratelimit-reset"];
    let resetMessage = "";
    if (resetHeader) {
      const resetDate = new Date(Number(resetHeader) * 1000);
      resetMessage = ` Rate limit resets at ${resetDate.toLocaleTimeString()}.`;
    }
    reject(
      new Error(
        `GitHub API rate limit exceeded (unauthenticated requests are limited to 60/hour).${resetMessage}`,
      ),
    );
    return;
  }

  // Any other non-2xx status is an unexpected failure.
  if (statusCode < 200 || statusCode >= 300) {
    reject(
      new Error(
        `GitHub API responded with status ${statusCode}: ${rawData.slice(0, 200)}`,
      ),
    );
    return;
  }

  // Status is 2xx: try to parse the JSON body.
  try {
    const parsed = JSON.parse(rawData);
    resolve(parsed);
  } catch (parseError) {
    reject(
      new Error(
        `Failed to parse GitHub API response as JSON: ${parseError.message}`,
      ),
    );
  }
}

/**
 * Step 4: Turn one raw GitHub "event" object into a single human-readable
 * line of output. GitHub's event `type` field tells us what kind of
 * activity it was; the `payload` field holds type-specific details.
 *
 * Reference: https://docs.github.com/en/rest/using-the-rest-api/github-event-types
 */
function formatEvent(event) {
  const repoName =
    event.repo && event.repo.name ? event.repo.name : "a repository";
  const payload = event.payload || {};

  switch (event.type) {
    case "PushEvent": {
      const commitCount = Array.isArray(payload.commits)
        ? payload.commits.length
        : 0;
      const commitWord = commitCount === 1 ? "commit" : "commits";
      return `Pushed ${commitCount} ${commitWord} to ${repoName}`;
    }

    case "IssuesEvent": {
      const action = payload.action || "updated"; // opened, closed, reopened, etc.
      return `${capitalize(action)} an issue in ${repoName}`;
    }

    case "IssueCommentEvent":
      return `Commented on an issue in ${repoName}`;

    case "PullRequestEvent": {
      const action = payload.action || "updated"; // opened, closed, merged, etc.
      const merged = payload.pull_request && payload.pull_request.merged;
      const verb = merged ? "Merged" : capitalize(action);
      return `${verb} a pull request in ${repoName}`;
    }

    case "PullRequestReviewEvent":
      return `Reviewed a pull request in ${repoName}`;

    case "PullRequestReviewCommentEvent":
      return `Commented on a pull request review in ${repoName}`;

    case "WatchEvent":
      // GitHub's "Star" action is internally called WatchEvent with action "started".
      return `Starred ${repoName}`;

    case "ForkEvent":
      return `Forked ${repoName}`;

    case "CreateEvent": {
      const refType = payload.ref_type; // "repository", "branch", or "tag"
      if (refType === "repository") {
        return `Created a new repository ${repoName}`;
      }
      if (refType === "branch") {
        return `Created a new branch "${payload.ref}" in ${repoName}`;
      }
      if (refType === "tag") {
        return `Created a new tag "${payload.ref}" in ${repoName}`;
      }
      return `Created something new in ${repoName}`;
    }

    case "DeleteEvent":
      return `Deleted ${payload.ref_type || "a ref"} "${payload.ref}" in ${repoName}`;

    case "ReleaseEvent":
      return `Published a new release in ${repoName}`;

    case "PublicEvent":
      return `Made ${repoName} public`;

    case "MemberEvent":
      return `${capitalize(payload.action || "updated")} a collaborator in ${repoName}`;

    case "GollumEvent":
      return `Updated the wiki in ${repoName}`;

    case "CommitCommentEvent":
      return `Commented on a commit in ${repoName}`;

    default:
      // Fallback for any event type not explicitly handled above, so the
      // program never silently drops an event.
      return `${event.type} in ${repoName}`;
  }
}

function capitalize(word) {
  if (!word) return word;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Step 5: Print the formatted activity list, or a friendly message if
 * nothing is left to show after filtering.
 *
 * `options` is the object returned by parseArgs(): { username, limit, type, json }
 */
function displayEvents(events, options) {
  let filteredEvents = Array.isArray(events) ? events : [];

  // Apply --type filter first, so --limit counts only matching events.
  if (options.type) {
    filteredEvents = filteredEvents.filter(
      (event) => event.type === options.type,
    );
  }

  // Apply --limit after filtering.
  if (options.limit) {
    filteredEvents = filteredEvents.slice(0, options.limit);
  }

  // --json bypasses the human-readable formatting entirely.
  if (options.json) {
    console.log(JSON.stringify(filteredEvents, null, 2));
    return;
  }

  if (filteredEvents.length === 0) {
    const typeNote = options.type ? ` of type "${options.type}"` : "";
    console.log(
      `${options.username} has no recent public activity${typeNote}.`,
    );
    return;
  }

  console.log(`Recent activity for ${options.username}:\n`);
  filteredEvents.forEach((event) => {
    console.log(`- ${formatEvent(event)}`);
  });
}

/**
 * Step 6: Wire everything together.
 */
async function main() {
  const options = parseArgs();

  try {
    const events = await fetchGithubEvents(options.username);
    displayEvents(events, options);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
