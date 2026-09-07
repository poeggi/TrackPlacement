# TrackPlacement: licensing, CurseForge, release pipeline

TrackPlacement is a server-side Minecraft Bedrock Dedicated Server behavior
pack, licensed AGPL-3.0-or-later (relicensed in v1.0.4).

## License

- Treat the project as always having been AGPL. Never reference any prior
  license in the README, commit messages, release bodies, or changelogs.
- The license is expressed in five places; keep them consistent: LICENSE file
  (full AGPL text, needed so it ships inside the .mcpack), README License
  section, per-file notice atop scripts/main.js and scripts/tracked_blocks.js,
  and the "license" key in manifest.json metadata.
- OPEN manual step: the CurseForge project's own License field is empty. The
  curseforge-upload action cannot set it; it is only settable in the CurseForge
  web UI project settings.

## CurseForge access

- Project id 1483473. Read stats keylessly via https://api.cfwidget.com/1483473
  (json: downloads.total, files[]). It caches, so it lags reality somewhat.
- www.curseforge.com returns HTTP 403 to curl (Cloudflare) even with a browser
  User-Agent; cfwidget is the only machine-readable source.
- New uploads sit in a manual file-approval queue for minutes to a day before
  they appear in the API. Absence right after a release is normal, not a
  failure.

## Release pipeline gotchas (.github/workflows/release.yml, tag-triggered on v*)

- The CurseForge upload step has continue-on-error: true, so the API reports
  conclusion=success even when it failed. To truly verify, read the raw job log
  (or the step's `outcome`, not `conclusion`).
- generate_release_notes: true yields an EMPTY body for a direct commit with no
  PR; the release body then needs PATCHing by hand.

## Line endings

core.autocrlf=true and the repo is mixed: README.md and manifest.json are CRLF;
scripts/*.js and release.yml are LF. Edit each file in its own convention or
the diff fills with whitespace noise. Detect reliably with
`tr -cd '\r' < file | wc -c`, not by grepping for \r.
