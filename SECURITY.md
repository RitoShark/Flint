# Security

## Supported versions

The latest release. Flint updates itself, so older builds do not get fixes.

## Reporting

Do not open a public issue for a security bug.

Use GitHub's private vulnerability reporting on this repository
(Security tab, "Report a vulnerability"), which goes straight to the maintainers.

Worth reporting:

- Anything that lets an opened project, `.fantome` or `.modpkg` run code or write outside the
  folder it was opened from.
- Path traversal when extracting a WAD or a mod package.
- The updater or the ritobin LSP installer accepting something it should not, such as a bad
  checksum or an unexpected download source.

Not really security bugs, just file them as normal issues:

- Flint crashing on a malformed file. Annoying, but it is a parser bug.
- League crashing because of a mod Flint produced.
