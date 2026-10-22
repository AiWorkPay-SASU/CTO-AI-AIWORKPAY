import fs from 'node:fs';
import path from 'node:path';

/** A minimal Linux filesystem, private PID/user/network namespaces and no host home/git metadata. */
export function sandboxCommand(cwd, nodeArgs) {
  if (process.platform !== 'linux') throw new Error('Test sandbox requires Linux and bubblewrap');
  const root = fs.realpathSync(cwd);
  const node = fs.realpathSync(process.execPath);
  const args = [
    '--die-with-parent', '--new-session', '--unshare-all', '--cap-drop', 'ALL',
    '--clearenv', '--setenv', 'PATH', '/usr/bin:/bin', '--setenv', 'HOME', '/tmp',
    '--setenv', 'TMPDIR', '/tmp', '--setenv', 'LANG', 'C.UTF-8'
  ];
  // These contain the runtime and dynamic libraries, never the host's /etc, /home or /workspace.
  for (const dir of ['/usr', '/bin', '/lib', '/lib64']) {
    if (fs.existsSync(dir)) args.push('--ro-bind', dir, dir);
  }
  if (!['/usr/', '/bin/'].some((prefix) => node.startsWith(prefix))) {
    args.push('--ro-bind', node, node);
  }
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--bind', root, '/work', '--chdir', '/work');
  if (fs.existsSync(path.join(root, '.git'))) {
    if (fs.lstatSync(path.join(root, '.git')).isDirectory()) args.push('--tmpfs', '/work/.git');
    else args.push('--ro-bind', '/dev/null', '/work/.git');
  }
  args.push('--', node, ...nodeArgs);
  return { command: 'bwrap', args };
}
