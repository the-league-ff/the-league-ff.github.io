// sleeper-api.js
// Thin wrapper around Sleeper's public read-only API, with localStorage caching
// for the heavy/slow-changing endpoints (players master list, weekly projections,
// completed-week matchups). Nothing here requires auth - Sleeper's API is public.

const SLEEPER_BASE = 'https://api.sleeper.app';

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Sleeper API ${res.status} for ${url}`);
  }
  return res.json();
}

// ---- tiny localStorage cache helper -------------------------------------

function cacheGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof maxAgeMs === 'number' && Date.now() - parsed.t > maxAgeMs) return null;
    return parsed.v;
  } catch (e) {
    return null;
  }
}

function cacheSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value }));
  } catch (e) {
    // localStorage full or unavailable - degrade gracefully, just don't cache
  }
}

// ---- core league endpoints (cheap, always fetch fresh) ------------------

async function getState() {
  return fetchJSON(`${SLEEPER_BASE}/v1/state/nfl`);
}

async function getLeague(leagueId) {
  return fetchJSON(`${SLEEPER_BASE}/v1/league/${leagueId}`);
}

async function getUsers(leagueId) {
  return fetchJSON(`${SLEEPER_BASE}/v1/league/${leagueId}/users`);
}

async function getRosters(leagueId) {
  return fetchJSON(`${SLEEPER_BASE}/v1/league/${leagueId}/rosters`);
}

// Matchups for a single week. Completed weeks never change, so cache those
// indefinitely; the current/live week is always fetched fresh.
async function getMatchups(leagueId, week, { isFinal } = {}) {
  const cacheKey = `smt:matchups:${leagueId}:${week}`;
  if (isFinal) {
    const cached = cacheGet(cacheKey); // no max age - completed weeks are immutable
    if (cached) return cached;
  }
  const data = await fetchJSON(`${SLEEPER_BASE}/v1/league/${leagueId}/matchups/${week}`);
  if (isFinal) cacheSet(cacheKey, data);
  return data;
}

// Per-NFL-game scoreboard/status for a week. Used to tell whether a given
// player's game has kicked off yet (pre_game) or is live/final, and to build
// the "Final L 15-24 vs CHI" style line under each player.
async function getGameInfoByTeam(season, week) {
  const games = await fetchJSON(`${SLEEPER_BASE}/scores/nfl/regular/${season}/${week}`);
  const byTeam = {};
  for (const g of games) {
    const meta = g.metadata || {};
    const home = meta.home_team;
    const away = meta.away_team;
    let state = 'pre';
    if (g.status === 'complete') state = 'final';
    else if (g.status && g.status !== 'pre_game') state = 'live';
    else if (meta.has_started) state = 'live';

    const homeInfo = {
      state,
      opp: away,
      isHome: true,
      teamScore: meta.home_score,
      oppScore: meta.away_score,
      quarter: meta.quarter,
      clock: meta.time_remaining,
      dateTime: meta.date_time || g.date,
    };
    const awayInfo = {
      state,
      opp: home,
      isHome: false,
      teamScore: meta.away_score,
      oppScore: meta.home_score,
      quarter: meta.quarter,
      clock: meta.time_remaining,
      dateTime: meta.date_time || g.date,
    };
    if (home) byTeam[home] = homeInfo;
    if (away) byTeam[away] = awayInfo;
  }
  return byTeam; // { 'KC': { state:'live', opp:'SF', isHome:true, teamScore:21, oppScore:14, ... } }
}

// Back-compat simple state map, still handy for quick pre/live/final checks.
async function getGameStatusByTeam(season, week) {
  const byTeam = await getGameInfoByTeam(season, week);
  const out = {};
  for (const team in byTeam) out[team] = byTeam[team].state;
  return out;
}

// ---- players master list (large, cached ~1x/day, trimmed to what's needed) --

async function getPlayersTrimmed(neededIds) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cacheKey = 'smt:players:trimmed';
  let trimmed = cacheGet(cacheKey, DAY_MS) || {};

  const missing = neededIds.filter((id) => !trimmed[id] && !/^[A-Z]{2,4}$/.test(id));
  // Team defenses (e.g. "JAX", "NO") aren't in the players list as normal
  // players - handle those separately below without a network call.

  if (missing.length > 0) {
    const full = await fetchJSON(`${SLEEPER_BASE}/v1/players/nfl`);
    trimmed = {};
    for (const id of neededIds) {
      const p = full[id];
      if (p) {
        trimmed[id] = {
          first_name: p.first_name,
          last_name: p.last_name,
          position: p.position,
          team: p.team,
          injury_status: p.injury_status || null,
          number: p.number,
        };
      }
    }
    cacheSet(cacheKey, trimmed);
  }

  // Fill in team-defense pseudo-players (id === team abbreviation).
  const out = { ...trimmed };
  for (const id of neededIds) {
    if (/^[A-Z]{2,4}$/.test(id) && !out[id]) {
      out[id] = { first_name: '', last_name: id, position: 'DEF', team: id, injury_status: null };
    }
  }
  return out;
}

// ---- weekly projections (medium-sized, cached ~10 min) -------------------

async function getProjectionsRaw(season, week) {
  const cacheKey = `smt:proj:${season}:${week}`;
  const cached = cacheGet(cacheKey, 10 * 60 * 1000);
  if (cached) return cached;
  try {
    const data = await fetchJSON(
      `${SLEEPER_BASE}/projections/nfl/${season}/${week}?season_type=regular`
    );
    // Trim to the fields we actually use before caching, to keep localStorage small.
    const trimmed = data
      .filter((e) => e.player_id)
      .map((e) => ({ player_id: String(e.player_id), team: e.team, stats: e.stats || {} }));
    cacheSet(cacheKey, trimmed);
    return trimmed;
  } catch (e) {
    // This is a multi-MB payload fetched on every live poll, so a transient
    // network hiccup here is expected occasionally - fall back to whatever
    // we had cached (even if past its normal 10-minute freshness window)
    // rather than wiping out every player's projection for this cycle. Only
    // give up if we have nothing at all cached yet.
    const stale = cacheGet(cacheKey);
    if (stale) return stale;
    throw e;
  }
}

// ---- weekly actual box-score stats (for the per-player stat line under
// each starter, e.g. "19/34 CMP, 230 YD, 2 TD, 1 INT"). Live during the
// week, cached indefinitely once the week is final. ------------------------

async function getStatsRaw(season, week, { isFinal } = {}) {
  const cacheKey = `smt:stats:${season}:${week}`;
  if (isFinal) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  } else {
    const cached = cacheGet(cacheKey, 60 * 1000); // short TTL while live
    if (cached) return cached;
  }
  try {
    const data = await fetchJSON(`${SLEEPER_BASE}/stats/nfl/${season}/${week}?season_type=regular`);
    const trimmed = data
      .filter((e) => e.player_id)
      .map((e) => ({ player_id: String(e.player_id), team: e.team, stats: e.stats || {} }));
    cacheSet(cacheKey, trimmed);
    return trimmed;
  } catch (e) {
    const stale = cacheGet(cacheKey);
    if (stale) return stale;
    throw e;
  }
}
