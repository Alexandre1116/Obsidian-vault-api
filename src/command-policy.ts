/**
 * Command policy for `run_local_command`.
 *
 * Kept identical to the same file in the Docker project so both products
 * enforce one documented set of rules. Pure and free of the `obsidian` import,
 * so the unit tests import it directly.
 *
 * **No shell is involved.** The command string is tokenized here and executed
 * with `execFile(program, args)`, so `;`, `&&`, `|`, `>`, backticks and `$(...)`
 * are literal characters that carry no meaning: they cannot start a second
 * program, because nothing interprets them. The tokenizer understands plain
 * `program argument argument` plus ordinary quoting, which is what makes vault
 * paths containing spaces work without a shell.
 *
 * **This is not a sandbox.** An allowlisted program keeps its own power:
 * `grep -f`, `pandoc --lua-filter`, `python -c`, `git -c core.pager=...` and
 * friends do exactly what their manual says. The allowlist answers "which
 * program may run", never "what may that program do".
 */

export class CommandInputError extends Error {}

/** True when the deployment asked for no restriction at all. */
export function unrestricted(patterns: string): boolean {
  return !patterns || patterns.trim() === "*";
}

/**
 * Splits a command line into argv without a shell.
 *
 * Quoting rules, stated because there is no shell to inherit them from:
 * - whitespace separates arguments;
 * - `'...'` is taken literally, and cannot contain a single quote;
 * - `"..."` is taken literally, with `\"` and `\\` as the only escapes;
 * - outside quotes, `\` escapes the next character.
 *
 * Everything else, including `;`, `|`, `$`, backticks and `<`, is an ordinary
 * character of an argument. That is only safe because the executor is
 * `execFile`: a shell would reinterpret those characters.
 */
export function tokenizeCommand(cmd: string): { program: string; args: string[] } {
  if (typeof cmd !== "string" || cmd.trim() === "") throw new CommandInputError("the command is empty");
  if (cmd.includes("\0")) throw new CommandInputError("'command' must not contain null bytes");
  if (/[\r\n]/.test(cmd)) throw new CommandInputError("'command' must be a single line");

  const tokens: string[] = [];
  let current = "";
  let started = false;
  let i = 0;

  const push = () => {
    tokens.push(current);
    current = "";
    started = false;
  };

  while (i < cmd.length) {
    const ch = cmd[i];

    if (/\s/.test(ch)) {
      if (started) push();
      i++;
      continue;
    }

    if (ch === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end === -1) throw new CommandInputError("unterminated single quote");
      current += cmd.slice(i + 1, end);
      started = true;
      i = end + 1;
      continue;
    }

    if (ch === '"') {
      i++;
      while (i < cmd.length && cmd[i] !== '"') {
        const next = cmd[i];
        if (next === "\\" && (cmd[i + 1] === '"' || cmd[i + 1] === "\\")) {
          current += cmd[i + 1];
          i += 2;
          continue;
        }
        current += next;
        i++;
      }
      if (i >= cmd.length) throw new CommandInputError("unterminated double quote");
      started = true;
      i++;
      continue;
    }

    if (ch === "\\") {
      if (i + 1 >= cmd.length) throw new CommandInputError("command ends with a backslash");
      current += cmd[i + 1];
      started = true;
      i += 2;
      continue;
    }

    current += ch;
    started = true;
    i++;
  }

  if (started) push();
  if (tokens.length === 0 || tokens[0] === "") throw new CommandInputError("the program name is empty");
  return { program: tokens[0], args: tokens.slice(1) };
}

export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const regexStr = "^" + pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    + "$";
  return new RegExp(regexStr, "i").test(value.trim());
}

/**
 * Flags that turn an otherwise read-only helper into an executor or a deleter
 * (`find -exec`, `grep -f`, `find -delete`). They are rejected only to keep a
 * restrictive list meaningful; they are not a defence against a program that
 * was listed on purpose, and a program can gain the same power in ways no flag
 * list can name.
 */
const FORBIDDEN_FLAGS = new Set(["exec", "execdir", "ok", "okdir", "delete", "fprint", "fprint0", "fls", "files0-from"]);

/**
 * With a restrictive list configured, arguments stay inside the vault: the
 * working directory is already the vault, so an absolute path, a `~`, a drive
 * path or a `..` segment only lets the program reach the rest of the machine.
 *
 * This is argument hygiene, not containment: a program that opens files itself
 * can still be pointed at something it should not read.
 */
export function findUnsafeArgument(args: string[]): string | null {
  for (const token of args) {
    if (token === "-" || token === "--") continue;
    if (
      token.startsWith("/") ||
      token.startsWith("~") ||
      token.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(token) ||
      token.split(/[/\\]/).includes("..")
    ) {
      return `'${token}' (outside the vault directory)`;
    }
    if (token.startsWith("-") && FORBIDDEN_FLAGS.has(token.replace(/^--?/, ""))) {
      return `'${token}' (executes or deletes files by itself)`;
    }
  }
  return null;
}

/**
 * Null when the program and its arguments are allowed, otherwise the reason it
 * is blocked.
 *
 * A pattern always matches the **whole command**, so a bare name means exactly
 * that command with no arguments: `git` allows `git`, `git *` allows `git` with
 * any arguments, `git status` allows only `git status`. Matching only the
 * program name would let one listed program be pointed at anything its manual
 * describes, which is the opposite of what a list is for.
 */
export function checkCommand(program: string, args: string[], patterns: string): string | null {
  if (unrestricted(patterns)) return null;

  const unsafe = findUnsafeArgument(args);
  if (unsafe) {
    return `${unsafe} is not allowed: with an allowlist configured, arguments must stay ` +
      "inside the vault directory (the working directory is already the vault).";
  }

  const whole = [program, ...args].join(" ");
  for (const pattern of patterns.split(",")) {
    const p = pattern.trim();
    if (!p) continue;
    if (globMatch(p, whole)) return null;
  }
  return `'${whole}' does not match the allowed patterns. Allowed patterns: ${patterns}`;
}

/**
 * Environment handed to the spawned program.
 *
 * The plugin process holds the API key in its own environment, and a child
 * inherits `process.env` by default, so inheritance would hand the key to every
 * allowlisted program. Only what a normal command-line tool needs is passed.
 */
const PASSTHROUGH_ENV = [
  "PATH", "HOME", "USER", "SHELL", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP",
  // Windows: without these, CreateProcess cannot resolve or start most programs.
  "SystemRoot", "windir", "ComSpec", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
];

export function childEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of PASSTHROUGH_ENV) {
    const value = env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
