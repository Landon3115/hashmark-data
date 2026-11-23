# hashmark-data

Data for the Hashmark app. Every Sunday morning a GitHub Action runs `scripts/sync-data.mjs` (teams, scores, polls, ratings, rosters, head coaches and season stats from CollegeFootballData.com, plus class years from ESPN), and every 2 hours `scripts/sync-news.mjs` collects headlines from public college football RSS feeds. Everything is published as JSON on this repository's GitHub Pages site under `/v1/`.

- Run it now: **Actions → Weekly data refresh → Run workflow**. Tick "full" to re-fetch rosters and coaches too.
- The CFBD key lives only in the `CFBD_API_KEY` repository secret.
- Not official data. Check the sources' terms before any public release.

`seed/` holds CFBD responses that no longer change (every past season's games, for head-to-head history, and finished weeks' scoring plays and box scores). The job copies them into its cache first, so they never cost API calls again.
