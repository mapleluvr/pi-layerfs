#!/usr/bin/env python3
"""Stage an exact Git HEAD snapshot as an unprivileged user."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import subprocess


GIT_ENV = {key: os.environ[key] for key in ('PATH', 'HOME', 'LANG', 'LC_ALL') if key in os.environ}
GIT_ENV.update(GIT_NO_LAZY_FETCH='1', GIT_NO_REPLACE_OBJECTS='1', GIT_OPTIONAL_LOCKS='0')


def git(directory, *args):
    return subprocess.check_output(['git', '-C', directory, *args], env=GIT_ENV)


def source_identity(directory):
    root = Path(os.fsdecode(git(directory, 'rev-parse', '--show-toplevel').removesuffix(b'\n'))).resolve()
    commit = git(root, 'rev-parse', '--verify', 'HEAD^{commit}').decode().strip()
    key = hashlib.sha256(os.fsencode(root)).hexdigest()[:32]
    return {'key': key, 'commit': commit, 'name': root.name, 'path': str(root)}


def excluded(path):
    blocked = {'.git', '.ssh', '.netrc', 'node_modules'}
    return any(part in blocked or part.startswith('.env') for part in map(str.casefold, path.parts))


def blob_header(blobs, object_id, filename):
    blobs.stdin.write(object_id + b'\n')
    blobs.stdin.flush()
    header = blobs.stdout.readline().split()
    if len(header) != 3 or header[:2] != [object_id, b'blob']:
        raise ValueError(f'Git blob unavailable at {filename!r}')
    return int(header[2])


def write_blob(blobs, size, target, mode):
    with target.open('xb') as output:
        while size:
            chunk = blobs.stdout.read(min(size, 1024 * 1024))
            if not chunk:
                raise ValueError(f'Truncated Git blob for {target.name!r}')
            output.write(chunk)
            size -= len(chunk)
    target.chmod(0o755 if mode == b'100755' else 0o644)


def snapshot(source, directory):
    tree = git(source['path'], 'ls-tree', '-rz', '--full-tree', source['commit'])
    directory.mkdir(mode=0o700)
    destination = directory / 'source'
    destination.mkdir(mode=0o755)
    files = 0
    skipped = 0
    links = []
    with subprocess.Popen(['git', '-C', source['path'], 'cat-file', '--batch'],
                          env=GIT_ENV, stdin=subprocess.PIPE, stdout=subprocess.PIPE) as blobs:
        try:
            for record in tree.split(b'\0')[:-1]:
                fields, filename = record.split(b'\t', 1)
                mode, kind, object_id = fields.split()
                path = PurePosixPath(os.fsdecode(filename))
                if path.is_absolute() or not path.parts or '..' in path.parts:
                    raise ValueError('Git tree contains an invalid path')
                if excluded(path):
                    skipped += 1
                    continue
                if kind != b'blob' or mode not in {b'100644', b'100755', b'120000'}:
                    raise ValueError(f'Unsupported Git entry at {filename!r}. Import submodules separately.')
                target = destination.joinpath(*path.parts)
                target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
                size = blob_header(blobs, object_id, filename)
                if mode == b'120000':
                    link = blobs.stdout.read(size)
                    resolved = posixpath.normpath(posixpath.join(os.fsencode(path.parent), link))
                    if not link or link.startswith(b'/') or resolved == b'..' or resolved.startswith(b'../'):
                        raise ValueError(f'Symlink leaves the Git tree at {filename!r}')
                    os.symlink(link, target)
                    links.append(target)
                else:
                    write_blob(blobs, size, target, mode)
                if blobs.stdout.read(1) != b'\n':
                    raise ValueError(f'Incomplete Git blob at {filename!r}')
                files += 1
        except BaseException:
            blobs.kill()
            raise
        finally:
            blobs.stdin.close()
        if blobs.wait() != 0:
            raise ValueError('Git could not read the requested snapshot')
    if not files:
        raise ValueError('The selected commit has no files to import')
    tree_root = destination.resolve()
    for link in links:
        if not link.resolve().is_relative_to(tree_root):
            raise ValueError(f'Symlink chain leaves the Git tree at {link.relative_to(destination)!s}')
    for directory_path, _, _ in os.walk(destination):
        Path(directory_path).chmod(0o755)
    (directory / 'source.json').write_text(json.dumps({**source, 'files': files, 'excluded': skipped}) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('repo', type=Path)
    parser.add_argument('output', type=Path, nargs='?')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        source = source_identity(args.repo)
        if args.output is None:
            print(json.dumps(source))
        else:
            snapshot(source, args.output)
            print(source['key'])
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'git-snapshot: {error}\n')


if __name__ == '__main__':
    main()
