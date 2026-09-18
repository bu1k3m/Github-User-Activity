#!/usr/bin/env node

/**
 * github-activity
 *
 * A zero-dependency CLI that fetches a GitHub user's recent public activity
 * and prints it to the terminal.
 *
 * Usage:
 *   node github-activity.js bu1k3m
 *   github-activity bu1k3m          (after `npm link`, see README)
 *
 * Only Node's built-in modules are used (https, process) -- no npm packages.
 */

"use strict";

const https = require("https");

/**
 * Step 1: Read the username from the command-line arguments.
 *
 * process.argv looks like:
 *   [0] path to the node binary
 *   [1] path to this script
 *   [2] the first real argument the user typed -- our username
 */
function getUsernameFromArgs() {
  const args = process.argv.slice(2); // drop "node" and the script path

  if (args.length === 0) {
    printUsageAndExit("Missing argument: please provide a GitHub username.");
  }

  const username = args[0].trim();

  // Basic sanity check: GitHub usernames may only contain alphanumeric
  // characters and single hyphens, and cannot start/end with a hyphen.
  const validUsernamePattern =
    /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
  if (!validUsernamePattern.test(username)) {
    printUsageAndExit(
      `"${username}" doesn't look like a valid GitHub username.`,
    );
  }

  return username;
}

function printUsageAndExit(message) {
  console.error(`Error: ${message}`);
  console.error("\nUsage:");
  console.error("  github-activity <username>");
  console.error("\nExample:");
  console.error("  github-activity bu1k3m");
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
 * Step 5: Print the formatted activity list, or a friendly message if the
 * user has no recent public activity.
 */
function displayEvents(events, username) {
  if (!Array.isArray(events) || events.length === 0) {
    console.log(`${username} has no recent public activity.`);
    return;
  }

  console.log(`Recent activity for ${username}:\n`);
  events.forEach((event) => {
    console.log(`- ${formatEvent(event)}`);
  });
}

/**
 * Step 6: Wire everything together.
 */
async function main() {
  const username = getUsernameFromArgs();

  try {
    const events = await fetchGithubEvents(username);
    displayEvents(events, username);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
