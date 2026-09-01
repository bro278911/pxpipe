import { describe, expect, it } from 'vitest';

import { isPathLike, planSpawn, whichSync, type LaunchHost } from '../src/warp/launch.js';

/** A host whose only executables are the paths listed. */
const host = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  files: readonly string[] = [],
  aliasTarget?: (name: string) => string | null,
): LaunchHost => ({
  platform,
  env,
  exists: (p) => files.includes(p),
  aliasTarget,
});

describe('isPathLike', () => {
  it('treats a forward slash as a path on every platform', () => {
    expect(isPathLike('./bin/claude', 'linux')).toBe(true);
    expect(isPathLike('./bin/claude', 'win32')).toBe(true);
  });

  it('treats a backslash or a drive letter as a path only on Windows', () => {
    expect(isPathLike('C:\\bin\\claude.exe', 'win32')).toBe(true);
    // A backslash is a legal character in a POSIX command name, not a separator.
    expect(isPathLike('C:\\bin\\claude.exe', 'linux')).toBe(false);
  });

  it('treats a bare name as a name', () => {
    expect(isPathLike('claude', 'win32')).toBe(false);
    expect(isPathLike('claude', 'linux')).toBe(false);
  });
});

describe('whichSync', () => {
  it('splits PATH on the platform separator', () => {
    // A Windows PATH holds drive letters, so a colon split would shred it.
    const win = host('win32', { PATH: 'C:\\a;C:\\b', PATHEXT: '.EXE' }, ['C:\\b\\claude.EXE']);
    expect(whichSync('claude', win)).toBe('C:\\b\\claude.EXE');

    const posix = host('linux', { PATH: '/a:/b' }, ['/b/claude']);
    expect(whichSync('claude', posix)).toBe('/b/claude');
  });

  it('appends each PATHEXT entry on Windows', () => {
    const win = host('win32', { PATH: 'C:\\a', PATHEXT: '.COM;.EXE;.CMD' }, ['C:\\a\\codex.CMD']);
    expect(whichSync('codex', win)).toBe('C:\\a\\codex.CMD');
  });

  it('prefers the earlier PATHEXT entry when both exist', () => {
    const win = host('win32', { PATH: 'C:\\a', PATHEXT: '.EXE;.CMD' }, [
      'C:\\a\\codex.CMD',
      'C:\\a\\codex.EXE',
    ]);
    expect(whichSync('codex', win)).toBe('C:\\a\\codex.EXE');
  });

  it('accepts a name that already carries its extension', () => {
    const win = host('win32', { PATH: 'C:\\a', PATHEXT: '.EXE' }, ['C:\\a\\claude.exe']);
    expect(whichSync('claude.exe', win)).toBe('C:\\a\\claude.exe');
  });

  it('returns null when nothing matches', () => {
    expect(whichSync('claude', host('win32', { PATH: 'C:\\a', PATHEXT: '.EXE' }))).toBeNull();
    expect(whichSync('claude', host('linux', { PATH: '/a' }))).toBeNull();
  });
});

describe('planSpawn on Windows', () => {
  const env = { PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('runs a resolved executable directly', () => {
    const plan = planSpawn(['claude', '--verbose'], host('win32', env, ['C:\\bin\\claude.EXE']));
    expect(plan).toMatchObject({ file: 'C:\\bin\\claude.EXE', args: ['--verbose'] });
    expect(plan.windowsVerbatimArguments).toBeFalsy();
  });

  it('routes a .cmd shim through cmd.exe, which Node refuses to spawn directly', () => {
    const plan = planSpawn(['codex', 'exec'], host('win32', env, ['C:\\bin\\codex.CMD']));
    expect(plan.file).toBe('cmd.exe');
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.windowsVerbatimArguments).toBe(true);
    // /s strips the outermost pair, so the command string carries its own.
    expect(plan.args[3]).toBe('""C:\\bin\\codex.CMD" exec"');
  });

  it('quotes only the arguments that need it', () => {
    const plan = planSpawn(
      ['codex', '--route', 'a b', 'plain'],
      host('win32', env, ['C:\\bin\\codex.BAT']),
    );
    expect(plan.args[3]).toBe('""C:\\bin\\codex.BAT" --route "a b" plain"');
  });

  it('never consults an interactive shell alias', () => {
    // cmd.exe has no inherited aliases; probing one costs a shell start and
    // returns garbage. The POSIX-only probe must not run here.
    let probed = false;
    const plan = planSpawn(
      ['claude'],
      host('win32', env, ['C:\\bin\\claude.EXE'], () => {
        probed = true;
        return null;
      }),
    );
    expect(probed).toBe(false);
    expect(plan.file).toBe('C:\\bin\\claude.EXE');
  });

  it('never falls back to a POSIX shell flag', () => {
    // The old fallback ran `cmd.exe -ic <script>`, which cmd rejects outright.
    const plan = planSpawn(['missing'], host('win32', env));
    expect(plan.args).not.toContain('-ic');
    expect(plan.file).toBe('missing');
  });

  it('runs an absolute path as given', () => {
    const plan = planSpawn(
      ['C:\\other\\claude.exe', '-p'],
      host('win32', env, ['C:\\other\\claude.exe']),
    );
    expect(plan).toMatchObject({ file: 'C:\\other\\claude.exe', args: ['-p'] });
  });
});

describe('planSpawn on POSIX', () => {
  const env = { PATH: '/usr/bin', SHELL: '/bin/zsh' };

  it('runs a binary on PATH directly', () => {
    const plan = planSpawn(['claude', '-p'], host('linux', env, ['/usr/bin/claude']));
    expect(plan).toMatchObject({ file: 'claude', args: ['-p'] });
  });

  it('prefers a usable alias over a binary of the same name', () => {
    const plan = planSpawn(
      ['cc'],
      host('linux', env, ['/usr/bin/cc', '/opt/claude'], () => '/opt/claude'),
    );
    expect(plan).toMatchObject({ file: '/bin/zsh', args: ['-ic', 'cc'] });
  });

  it('ignores a stale alias that points at nothing', () => {
    const plan = planSpawn(
      ['cc'],
      host('linux', env, ['/usr/bin/cc'], () => '/gone/claude'),
    );
    expect(plan).toMatchObject({ file: 'cc' });
    expect(plan.note).toMatch(/stale alias/);
  });

  it('takes an env-assignment alias at its word', () => {
    const plan = planSpawn(
      ['cc'],
      host('linux', env, [], () => 'FOO=1 claude'),
    );
    expect(plan).toMatchObject({ file: '/bin/zsh', args: ['-ic', 'cc'] });
  });

  it('falls back to the interactive shell when the word is not executable', () => {
    const plan = planSpawn(['cc', "it's"], host('linux', env));
    expect(plan).toMatchObject({ file: '/bin/zsh' });
    // The command word stays unquoted so the shell can still expand an alias.
    expect(plan.args[1]).toBe(`cc 'it'\\''s'`);
  });

  it('defaults to /bin/sh when SHELL is unset', () => {
    const plan = planSpawn(['cc'], host('linux', { PATH: '/usr/bin' }));
    expect(plan.file).toBe('/bin/sh');
  });
});
