/**
 * How to actually start the agent, decided as data rather than done inline.
 *
 * `spawn()` is execvp: it only knows files, and only on POSIX. Windows adds two
 * rules that a POSIX-shaped launcher gets wrong in silence — `PATH` is split on
 * `;`, and a bare name is only executable once one of the `PATHEXT` suffixes is
 * appended — so a `claude` sitting right there on `PATH` looks missing and the
 * launcher drops into a shell fallback written for zsh. Keeping the decision in
 * one pure function makes both platforms testable without spawning anything.
 */

export interface LaunchHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Does this path exist and count as runnable? */
  exists: (path: string) => boolean;
  /**
   * What the user's interactive shell thinks this bare name means, or null.
   * POSIX only; the caller owns the shell start so this stays pure.
   */
  aliasTarget?: (name: string) => string | null;
}

export interface SpawnPlan {
  file: string;
  args: string[];
  /**
   * cmd.exe needs the command string handed over byte for byte; Node's own
   * Windows quoting would wrap it a second time and cmd would run the wrong
   * thing.
   */
  windowsVerbatimArguments?: boolean;
  /** Something the operator should hear about, e.g. a stale alias. */
  note?: string;
}

/** Extensions that cmd.exe interprets rather than the OS loading directly. */
const SHIM_EXTENSIONS = ['.cmd', '.bat'];

/**
 * A path the caller already resolved, versus a name to look up. A backslash
 * counts only on Windows: it is a legal character in a POSIX filename, so
 * treating it as a separator there would refuse to look up a name that exists.
 */
export function isPathLike(word: string, platform: NodeJS.Platform): boolean {
  if (word.includes('/')) return true;
  if (platform !== 'win32') return false;
  return word.includes('\\') || /^[A-Za-z]:/.test(word);
}

/**
 * Minimal `which`: the full path of a bare name on `PATH`, or null.
 *
 * On Windows the name is tried bare first — `claude.exe` given in full must not
 * become `claude.exe.EXE` — then with each `PATHEXT` suffix in the operator's
 * own order, which is what decides `.EXE` over `.CMD` when both exist.
 */
export function whichSync(name: string, host: LaunchHost): string | null {
  if (isPathLike(name, host.platform)) return null;
  const isWin = host.platform === 'win32';
  const dirs = (host.env.PATH ?? host.env.Path ?? '').split(isWin ? ';' : ':');
  const suffixes = isWin
    ? ['', ...(host.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
    : [''];
  const sep = isWin ? '\\' : '/';
  for (const dir of dirs) {
    if (!dir) continue;
    const base = dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
    for (const suffix of suffixes) {
      if (!suffix && isWin && !/\.[^.\\/]+$/.test(name)) continue; // bare name needs an extension
      const candidate = `${base}${suffix}`;
      if (host.exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Can this word be executed as-is: an existing path, or a name on `PATH`? */
function resolve(word: string, host: LaunchHost): string | null {
  if (isPathLike(word, host.platform)) return host.exists(word) ? word : null;
  return whichSync(word, host);
}

/** POSIX single-quote: safe for anything except a single quote itself. */
function posixQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * cmd.exe quoting, which is not the POSIX one: only double quotes group, and a
 * literal double quote is doubled. Words that need no grouping are left bare so
 * the command line stays readable in a process list.
 */
function cmdQuote(arg: string): string {
  if (arg !== '' && !/[\s"^&|<>()]/.test(arg)) return arg;
  return `"${arg.replaceAll('"', '""')}"`;
}

/**
 * Decide how to start `command`.
 *
 * POSIX keeps the existing behaviour exactly: ask the interactive shell about
 * an alias first (a `cc` alias must win over the `cc` binary on `PATH`), ignore
 * one that points at nothing, and fall back to `$SHELL -ic` when the word is
 * not executable — an alias only exists inside a shell that sourced the rc file.
 *
 * Windows has neither inherited aliases nor `-ic`, so it resolves the name and
 * runs it. The one indirection left is a `.cmd`/`.bat` shim, which Node has
 * refused to spawn without a shell since the 2024 argument-injection fix.
 */
export function planSpawn(command: string[], host: LaunchHost): SpawnPlan {
  const word = command[0]!;
  const rest = command.slice(1);

  if (host.platform === 'win32') {
    const resolved = resolve(word, host);
    // Unresolved: hand the word to spawn anyway. It fails with ENOENT, which
    // the caller already reports as "cannot run <word>" — a truer message than
    // anything a shell would print.
    if (!resolved) return { file: word, args: rest };
    if (!SHIM_EXTENSIONS.some((ext) => resolved.toLowerCase().endsWith(ext))) {
      return { file: resolved, args: rest };
    }
    // `/d` skips AutoRun registry commands, `/s` takes the rest of the line
    // verbatim after stripping one outer quote pair — hence the extra pair.
    // The program is quoted unconditionally: a Windows install path holds a
    // space often enough (`C:\Program Files\...`) that leaving it to the
    // needs-quoting test is a trap waiting for the next machine.
    const script = [`"${resolved.replaceAll('"', '""')}"`, ...rest.map(cmdQuote)].join(' ');
    return {
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `"${script}"`],
      windowsVerbatimArguments: true,
    };
  }

  const shell = host.env.SHELL || '/bin/sh';
  const alias = host.aliasTarget?.(isPathLike(word, host.platform) ? '' : word) ?? null;
  const aliasWord = alias?.split(/\s+/)[0] ?? '';
  // An env-assignment prefix (`FOO=1 claude`) is unverifiable, so it is taken
  // at its word; anything else must still be executable or it is stale.
  const aliasUsable = alias !== null && (aliasWord.includes('=') || resolve(aliasWord, host) !== null);
  const note =
    alias !== null && !aliasUsable
      ? `ignoring stale alias ${word} → ${aliasWord} (not executable)`
      : undefined;

  if (!aliasUsable && resolve(word, host) !== null) return { file: word, args: rest, note };

  // The command word is deliberately left unquoted: a shell only expands
  // aliases on unquoted words, so quoting it would defeat this fallback.
  // Arguments are still quoted — they are data, never aliases.
  const script = [word, ...rest.map(posixQuote)].join(' ');
  return { file: shell, args: ['-ic', script], note };
}
