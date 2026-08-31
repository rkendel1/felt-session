import { managedWebSessionToken } from "./lib/local-auth";

const index = process.argv.indexOf("--login");
const login = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
if (!login) throw new Error("Usage: bun scripts/print-web-session-token.ts --login <github-login>");
const token = await managedWebSessionToken({ login });
if (!token) process.exit(2);
process.stdout.write(token);
