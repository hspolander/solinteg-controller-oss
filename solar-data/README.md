# solar-data/

Put your own site's data here to run the onboarding pipeline described in `DOMAIN.md`'s
"Adapting to a new site":

- Your household's daily production/consumption CSV export (for `scripts/process-inverter-data.ts`
  and `scripts/build-load-model.mjs`).
- Historical GHI data for your location (for `scripts/process-smhi-data.ts`, or an equivalent
  script if your source isn't SMHI).

Nothing in this directory is required for the app to build, test, or run — it's only needed if
you're regenerating the fitted constants in `lib/consumption-data.ts` / `lib/irradiance-data.ts`
for your own site. This directory is gitignored except for this file (see `.gitignore`) since
the data itself is personal to each installation.
