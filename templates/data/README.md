# StitchBench reference data (private)

Data StitchBench loads at start that was read out of the sewing-machine makers' manuals, plus the owner's manual
list. It is kept out of the public code because it includes text copied from the manuals, until a lawyer has looked
at it.

| File | What it is |
| --- | --- |
| `factory_settings.json` | timing and adjustment settings, with the manual page and figure |
| `tension_specs.json` | upper and bobbin tension specs |
| `library_docs.json` | the owner's manual library listing (loaded only by a bench that has that library) |
| `hub_links.json` | the seed list of where manuals can be downloaded (`scripts/hub/parse_sources.py`), for a hub's catalog |

Not licensed for redistribution. Don't make this repository public, and don't copy these files into a public one.

**How official builds get them.** stitchbench's `scripts/data/fetch-reference-data.mjs` downloads them into
`prisma/seed-data/` when `STITCH_DATA_TOKEN` is set: a fine-grained GitHub token with read-only access to this
repository's contents. It is set as a variable on both hosted services in Railway, and as the `STITCH_DATA_TOKEN`
secret of the stitchbench repository (the Windows installers workflow).

**Updating.** Regenerate the files in a stitchbench checkout (the scripts in `scripts/library/`; the files are
git-ignored there), commit them here, then redeploy the hosted services and build new installers.
