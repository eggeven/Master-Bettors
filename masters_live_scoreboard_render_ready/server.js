
const express = require("express");
const path = require("path");
const fs = require("fs");
const cheerio = require("cheerio");
const JSON5 = require("json5");

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_URL = process.env.MASTERS_SOURCE_URL || "https://www.masters.com/leaderboard";
const REFRESH_SECONDS = Number(process.env.REFRESH_SECONDS || 60);
const TEAM_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "teams.json"), "utf8"));

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/config", (_req, res) => {
  res.json({
    sourceUrl: SOURCE_URL,
    refreshSeconds: REFRESH_SECONDS,
    scoring: TEAM_CONFIG.scoring,
    teamCount: TEAM_CONFIG.teams.length,
    updatedAt: new Date().toISOString()
  });
});

app.get("/api/scoreboard", async (_req, res) => {
  try {
    const html = await fetchOfficialLeaderboardHtml();
    const players = parseOfficialLeaderboard(html);
    const scoreboard = buildScoreboard(players, TEAM_CONFIG);
    res.json({
      ok: true,
      sourceUrl: SOURCE_URL,
      refreshSeconds: REFRESH_SECONDS,
      fetchedAt: new Date().toISOString(),
      playersFound: players.length,
      ...scoreboard
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
      sourceUrl: SOURCE_URL
    });
  }
});

async function fetchOfficialLeaderboardHtml() {
  const response = await fetch(SOURCE_URL, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; MastersPoolScoreboard/1.0; +https://example.com)",
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "pragma": "no-cache"
    }
  });

  if (!response.ok) {
    throw new Error(`Official leaderboard request failed: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

function parseOfficialLeaderboard(html) {
  const strategies = [
    extractPlayersFromNextData,
    extractPlayersFromJsonScripts,
    extractPlayersFromJavascriptState,
    extractPlayersFromDomTables
  ];

  for (const strategy of strategies) {
    try {
      const players = strategy(html);
      if (players.length >= 10) {
        return dedupePlayers(players);
      }
    } catch (_) {
      // try next strategy
    }
  }

  throw new Error("Could not parse player data from Masters.com leaderboard HTML. Inspect the latest page markup and adjust the parser.");
}

function extractPlayersFromNextData(html) {
  const $ = cheerio.load(html);
  const scripts = [
    $("#__NEXT_DATA__").html(),
    $('script[type="application/json"]').first().html()
  ].filter(Boolean);

  for (const scriptText of scripts) {
    try {
      const parsed = JSON.parse(scriptText);
      const players = bestPlayersFromObject(parsed);
      if (players.length >= 10) return players;
    } catch (_) {
      // continue
    }
  }

  return [];
}

function extractPlayersFromJsonScripts(html) {
  const $ = cheerio.load(html);
  const candidates = [];

  $('script[type="application/json"], script[type="application/ld+json"]').each((_, el) => {
    const scriptText = $(el).html();
    if (!scriptText || scriptText.length < 100) return;

    try {
      const parsed = JSON.parse(scriptText);
      candidates.push(...bestPlayersFromObject(parsed));
    } catch (_) {
      try {
        const parsed = JSON5.parse(scriptText);
        candidates.push(...bestPlayersFromObject(parsed));
      } catch (__){
        // ignore
      }
    }
  });

  return dedupePlayers(candidates);
}

function extractPlayersFromJavascriptState(html) {
  const $ = cheerio.load(html);
  const scripts = $("script").toArray().map((el) => $(el).html()).filter(Boolean);
  let best = [];

  for (const scriptText of scripts) {
    if (scriptText.length < 500) continue;
    const lower = scriptText.toLowerCase();
    if (!lower.includes("leader") && !lower.includes("player")) continue;

    const fragments = extractStructuredFragments(scriptText);
    for (const fragment of fragments) {
      try {
        const parsed = JSON5.parse(fragment);
        const players = bestPlayersFromObject(parsed);
        if (players.length > best.length) best = players;
      } catch (_) {
        // ignore
      }
    }
  }

  return best;
}

function extractStructuredFragments(scriptText) {
  const fragments = [];
  const seedTerms = ["leaderboard", "players", "field", "appState", "state", "__INITIAL_STATE__", "__PRELOADED_STATE__"];

  for (const term of seedTerms) {
    let index = scriptText.indexOf(term);
    while (index !== -1) {
      const openIndex = findNextStructureStart(scriptText, index);
      if (openIndex !== -1) {
        const fragment = balancedSlice(scriptText, openIndex);
        if (fragment && fragment.length >= 100) fragments.push(fragment);
      }
      index = scriptText.indexOf(term, index + term.length);
    }
  }

  return Array.from(new Set(fragments));
}

function findNextStructureStart(text, startIndex) {
  for (let i = startIndex; i < Math.min(text.length, startIndex + 2500); i += 1) {
    if (text[i] === "{" || text[i] === "[") return i;
  }
  return -1;
}

function balancedSlice(text, startIndex) {
  const openChar = text[startIndex];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === openChar) depth += 1;
    if (ch === closeChar) depth -= 1;

    if (depth === 0) {
      return text.slice(startIndex, i + 1);
    }
  }

  return null;
}

function extractPlayersFromDomTables(html) {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();
  let best = [];

  for (const table of tables) {
    const headers = $(table).find("thead th").toArray().map((th) => normalizeText($(th).text()).toLowerCase());
    const rows = $(table).find("tbody tr").toArray();

    const parsed = rows.map((row) => {
      const cells = $(row).find("td").toArray().map((td) => normalizeText($(td).text()));
      if (cells.length < 4) return null;

      const name = detectNameCell(cells);
      if (!name) return null;

      return {
        name,
        position: detectCellByHeaderOrPattern(headers, cells, ["pos", "position", "rank"], /^T?\d+$/),
        total: detectCellByHeaderOrPattern(headers, cells, ["total", "score", "to par"], /^(E|[+-]\d+|--?)$/i),
        today: detectCellByHeaderOrPattern(headers, cells, ["today"], /^(E|[+-]\d+|--?)$/i),
        thru: detectCellByHeaderOrPattern(headers, cells, ["thru", "thru.", "hole"], /^(F|\d{1,2}|--?)$/i),
        round1: detectRoundCell(headers, cells, 1),
        round2: detectRoundCell(headers, cells, 2),
        round3: detectRoundCell(headers, cells, 3),
        round4: detectRoundCell(headers, cells, 4)
      };
    }).filter(Boolean).map(normalizeRawPlayer).filter(Boolean);

    if (parsed.length > best.length) best = parsed;
  }

  return best;
}

function detectRoundCell(headers, cells, roundNumber) {
  return detectCellByHeaderOrPattern(headers, cells, [`r${roundNumber}`, `round ${roundNumber}`], /^(\d{2}|--?)$/);
}

function detectNameCell(cells) {
  const candidate = cells.find((cell) => /^[A-Za-zÀ-ÖØ-öø-ÿ.' -]{5,}$/.test(cell) && cell.split(" ").length >= 2);
  return candidate || null;
}

function detectCellByHeaderOrPattern(headers, cells, headerTerms, pattern) {
  const headerIndex = headers.findIndex((header) => headerTerms.some((term) => header.includes(term)));
  if (headerIndex !== -1 && cells[headerIndex]) return cells[headerIndex];
  return cells.find((cell) => pattern.test(cell)) || null;
}

function bestPlayersFromObject(data) {
  const candidates = [];

  walk(data, (node) => {
    if (!Array.isArray(node) || node.length < 8) return;

    const normalized = node.map(normalizeRawPlayer).filter(Boolean);
    const ratio = normalized.length / node.length;

    if (normalized.length >= 8 && ratio >= 0.5) {
      candidates.push(normalized);
    }
  });

  if (!candidates.length) return [];
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function walk(node, visitor) {
  visitor(node);
  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, visitor));
    return;
  }
  if (node && typeof node === "object") {
    Object.values(node).forEach((value) => walk(value, visitor));
  }
}

function normalizeRawPlayer(raw) {
  if (!raw || typeof raw !== "object") return null;

  const flat = flattenObject(raw);
  const name = firstTruthy(flat, [
    "fullName", "fullname", "displayName", "display_name", "playerName", "player_name",
    "name", "shortName", "short_name", "player.fullName", "player.displayName"
  ]) || joinNames(flat);

  if (!name || typeof name !== "string") return null;

  const player = {
    name: normalizeText(name),
    position: normalizeText(firstTruthy(flat, ["position", "pos", "rank", "place", "standing"])),
    totalToPar: parseScore(firstTruthy(flat, [
      "total", "toPar", "to_par", "scoreToPar", "score_to_par", "par", "overallScore", "score"
    ])),
    todayToPar: parseScore(firstTruthy(flat, [
      "today", "currentRoundScore", "roundScore", "round_score", "roundToPar", "current_round"
    ])),
    thru: normalizeText(firstTruthy(flat, [
      "thru", "through", "holesCompleted", "holes_completed", "hole", "currentHole", "current_hole"
    ])),
    status: normalizeText(firstTruthy(flat, [
      "status", "playerStatus", "state", "roundStatus", "startTime", "teeTime", "tee_time"
    ])),
    round1: parseRound(firstTruthy(flat, ["r1", "round1", "round_1", "roundOne", "scores.r1"])),
    round2: parseRound(firstTruthy(flat, ["r2", "round2", "round_2", "roundTwo", "scores.r2"])),
    round3: parseRound(firstTruthy(flat, ["r3", "round3", "round_3", "roundThree", "scores.r3"])),
    round4: parseRound(firstTruthy(flat, ["r4", "round4", "round_4", "roundFour", "scores.r4"]))
  };

  const looksLikeScoreboardRow = (
    player.totalToPar !== null ||
    player.todayToPar !== null ||
    player.position ||
    player.thru ||
    player.round1 !== null ||
    player.round2 !== null ||
    player.round3 !== null ||
    player.round4 !== null
  );

  return looksLikeScoreboardRow ? player : null;
}

function flattenObject(obj, prefix = "", output = {}) {
  if (Array.isArray(obj)) return output;
  Object.entries(obj).forEach(([key, value]) => {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    output[nextKey] = value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenObject(value, nextKey, output);
    }
  });
  return output;
}

function firstTruthy(flat, keys) {
  for (const key of keys) {
    if (flat[key] !== undefined && flat[key] !== null && flat[key] !== "") {
      return flat[key];
    }
  }
  return null;
}

function joinNames(flat) {
  const first = firstTruthy(flat, ["first_name", "firstName", "player.first_name", "player.firstName"]);
  const last = firstTruthy(flat, ["last_name", "lastName", "player.last_name", "player.lastName"]);
  if (first || last) return [first, last].filter(Boolean).join(" ");
  return null;
}

function parseRound(value) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (/^\d{2}$/.test(text)) return Number(text);
  if (/^\d+$/.test(text) && Number(text) > 18) return Number(text);
  return null;
}

function parseScore(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;

  const text = String(value).trim().toUpperCase();
  if (!text || text === "--" || text === "-") return null;
  if (text === "E" || text === "EVEN") return 0;
  if (/^[+-]\d+$/.test(text)) return Number(text);
  if (/^\d+$/.test(text)) return Number(text);
  return null;
}

function dedupePlayers(players) {
  const map = new Map();

  for (const player of players) {
    const key = normalizeKey(player.name);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, player);
      continue;
    }

    const current = map.get(key);
    const currentScoreFields = countKnownScoreFields(current);
    const nextScoreFields = countKnownScoreFields(player);
    if (nextScoreFields > currentScoreFields) {
      map.set(key, player);
    }
  }

  return Array.from(map.values());
}

function countKnownScoreFields(player) {
  return [
    player.totalToPar, player.todayToPar, player.position, player.thru,
    player.round1, player.round2, player.round3, player.round4
  ].filter((value) => value !== null && value !== undefined && value !== "").length;
}

function buildScoreboard(officialPlayers, config) {
  const officialIndex = new Map();
  officialPlayers.forEach((player) => {
    officialIndex.set(normalizeKey(player.name), player);
  });

  const teams = config.teams.map((team) => {
    const roster = team.players.map((pick) => {
      const matched = matchPlayer(pick, officialPlayers, officialIndex);
      const numericScore = matched?.totalToPar ?? 0;
      return {
        owner: team.owner,
        draftLabel: pick.draftLabel,
        canonicalName: pick.canonicalName,
        aliases: pick.aliases || [],
        matched: Boolean(matched),
        officialName: matched?.name || pick.canonicalName,
        position: matched?.position || "",
        totalToPar: numericScore,
        totalDisplay: formatPar(numericScore),
        todayToPar: matched?.todayToPar ?? null,
        todayDisplay: formatNullablePar(matched?.todayToPar),
        thru: matched?.thru || "—",
        status: matched?.status || "",
        round1: matched?.round1,
        round2: matched?.round2,
        round3: matched?.round3,
        round4: matched?.round4
      };
    });

    const sortedScores = [...roster].sort((a, b) => a.totalToPar - b.totalToPar);
    const counting = sortedScores.slice(0, config.scoring.count_best_of).map((player) => player.officialName);
    const dropped = sortedScores.slice(config.scoring.count_best_of).map((player) => player.officialName);
    const teamScore = sortedScores.slice(0, config.scoring.count_best_of).reduce((sum, player) => sum + player.totalToPar, 0);

    const rosterWithFlags = roster.map((player) => ({
      ...player,
      isCounting: counting.includes(player.officialName),
      isDropped: dropped.includes(player.officialName)
    })).sort((a, b) => a.totalToPar - b.totalToPar);

    return {
      owner: team.owner,
      score: teamScore,
      scoreDisplay: formatPar(teamScore),
      players: rosterWithFlags
    };
  }).sort((a, b) => a.score - b.score);

  const leader = teams[0] || null;

  return {
    scoring: config.scoring,
    leader: leader ? { owner: leader.owner, score: leader.score, scoreDisplay: leader.scoreDisplay } : null,
    teams
  };
}

function matchPlayer(pick, officialPlayers, officialIndex) {
  const exactCandidates = [
    pick.canonicalName,
    ...(pick.aliases || []),
    pick.draftLabel
  ];

  for (const candidate of exactCandidates) {
    const matched = officialIndex.get(normalizeKey(candidate));
    if (matched) return matched;
  }

  const canonicalKey = normalizeKey(pick.canonicalName);
  const aliasKeys = exactCandidates.map(normalizeKey).filter(Boolean);

  let best = null;
  let bestScore = 0;

  for (const player of officialPlayers) {
    const key = normalizeKey(player.name);
    let score = similarity(canonicalKey, key);

    for (const alias of aliasKeys) {
      score = Math.max(score, similarity(alias, key));
    }

    if (score > bestScore) {
      bestScore = score;
      best = player;
    }
  }

  return bestScore >= 0.72 ? best : null;
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.92;
  const distance = levenshtein(a, b);
  return 1 - distance / Math.max(a.length, b.length);
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));

  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[a.length][b.length];
}

function normalizeKey(value) {
  if (!value) return "";
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function formatPar(value) {
  if (value === 0) return "E";
  return value > 0 ? `+${value}` : `${value}`;
}

function formatNullablePar(value) {
  if (value === null || value === undefined) return "—";
  return formatPar(value);
}

app.listen(PORT, () => {
  console.log(`Masters draft scoreboard listening on http://localhost:${PORT}`);
});
