# hashmark-data

Weekly data for the Hashmark app. Every Sunday morning a GitHub Action runs `scripts/sync-data.mjs`, which pulls teams, scores, polls, ratings, rosters and head coaches from CollegeFootballData.com (plus class years from ESPN's public API) and publishes JSON files to this repository's GitHub Pages site under `/v1/`.

- Run it now: **Actions → Weekly data refresh → Run workflow**. Tick "full" to re-fetch rosters and coaches too.
- The CFBD key lives only in the `CFBD_API_KEY` repository secret.
- Not official data. Check the sources' terms before any public release.
