export const WELCOME_TEXT = [
  "Welcome to GitHub Manager!",
  "",
  "Connect your GitHub account to manage repositories, upload projects, monitor GitHub Actions, and download application builds.",
  "",
  "Send /login to connect your GitHub account, then /web to open the dashboard.",
].join("\n");

export const HELP_TEXT = [
  "Commands:",
  "/login - connect your GitHub account",
  "/web - open the web dashboard (sign-in link, valid 8 hours)",
  "/status - show your connected account and selected repository",
  "/repos - choose a repository your GitHub App installation can access",
  "/branch [name] - list or select an existing branch",
  "/upload - send a .zip project to commit to the selected repository (update only, nothing is deleted)",
  "/cancel - cancel a pending upload",
  "/actions - latest workflow runs for the selected repository",
  "/apk - download the newest APK from artifacts or the latest release",
  "/logout - revoke and delete your GitHub credentials",
  "/help - show this help",
].join("\n");

export const UNKNOWN_TEXT =
  "That command is not available. Send /help for the list of commands.";
