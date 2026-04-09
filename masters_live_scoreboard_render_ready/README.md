# Masters live draft scoreboard

This package turns your uploaded **Master Bettors.xlsx** sheet into a live web scoreboard using the exact draft teams from the spreadsheet.

## What it does
- Uses the 8 draft teams from your spreadsheet
- Scores each team as **best 5 of 6 golfers**
- Pulls live official data from **https://www.masters.com/leaderboard**
- Shows:
  - current winning owner
  - live pool standings
  - each golfer's score/status
  - dropped golfer per team

## Files
- `teams.json` — extracted team config from your spreadsheet
- `server.js` — Node/Express app plus the Masters.com scraper/parser
- `public/` — accessible front-end
- `package.json` — dependencies

## Run locally
```bash
npm install
npm start
```

Then open:
```bash
http://localhost:3000
```

## Deploy publicly
Any Node host will work. Easiest options:
- Render
- Railway
- Fly.io
- any VPS with Node 20+

Typical deployment:
1. upload this folder to a Git repo
2. create a new Node web service
3. build command: `npm install`
4. start command: `npm start`

## Notes
- The app uses **server-side scraping** of Masters.com so the site can stay live online without a browser CORS problem.
- If Masters.com changes its HTML / embedded data structure, the parser in `server.js` may need a small update.
- I mapped the golfer names from the spreadsheet shorthand to their expected official names, while still allowing fuzzy matching.

## Extracted teams
- Carson
- Xander
- Dawson
- Alvaro
- Jack
- Jake
- Conner
- Nate
