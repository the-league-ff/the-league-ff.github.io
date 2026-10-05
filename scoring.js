// scoring.js
// Fantasy point math and the median-team algorithm.
//
// Actual/live points for real rosters come straight from Sleeper's matchups
// endpoint (players_points), which already applies the league's custom
// scoring - we never need to recompute those ourselves.
//
// Projected points are NOT provided pre-scored for custom leagues, so we
// compute them the same way Sleeper computes actual points: dot-product the
// raw per-player stat categories against the league's scoring_settings. This
// was validated against real historical data (raw stats x scoring_settings
// reproduces Sleeper's own players_points to the cent).

function computePointsFromStats(rawStats, scoringSettings) {
  let total = 0;
  for (const key in rawStats) {
    const weight = scoringSettings[key];
    if (weight) total += rawStats[key] * weight;
  }
  return Math.round(total * 100) / 100;
}

function buildProjectionPointsMap(rawProjectionsList, scoringSettings) {
  const map = {};
  for (const entry of rawProjectionsList) {
    const stats = entry.stats || {};
    // Sleeper always returns a row for every rostered player, but for
    // someone with no real projection yet (most commonly: ruled out/inactive,
    // or the week's projections just haven't been published for them) that
    // row carries nothing but an ADP placeholder - no actual scoring
    // categories. Map that to null ("no projection available") rather than
    // a computed 0, so the UI can show it as unavailable instead of a
    // literal (and misleading-looking) zero.
    const hasRealProjection = Object.keys(stats).some((k) => k in scoringSettings);
    map[entry.player_id] = hasRealProjection ? computePointsFromStats(stats, scoringSettings) : null;
  }
  return map;
}

// Identify the "median" placeholder roster (no owner) vs the real rosters.
function splitRosters(rosters) {
  const median = rosters.find((r) => !r.owner_id);
  const real = rosters.filter((r) => r.owner_id);
  return { medianRoster: median, realRosters: real };
}

// Group a week's matchup entries by matchup_id -> [entry, entry]
function groupMatchups(matchupEntries) {
  const groups = new Map();
  for (const e of matchupEntries) {
    if (!groups.has(e.matchup_id)) groups.set(e.matchup_id, []);
    groups.get(e.matchup_id).push(e);
  }
  return groups;
}

// A player's "live-blended" point value for ranking purposes: their real
// accrued points once their game has started (live or final), otherwise
// their pregame projection. This is what determines who the 5th-highest
// scorer currently is, per the user's request to rank by projection rather
// than raw live score.
function playerLiveBlendedPoints(playerId, players, gameStatusByTeam, actualPointsMap, projectionPointsMap) {
  const player = players[playerId];
  const team = player ? player.team : null;
  const state = team && gameStatusByTeam[team] ? gameStatusByTeam[team] : 'pre';
  if (state === 'pre') {
    return projectionPointsMap[playerId] ?? 0;
  }
  return actualPointsMap[playerId] ?? 0;
}

function teamActualPoints(matchupEntry) {
  return matchupEntry.points || 0;
}

function teamLiveBlendedPoints(matchupEntry, players, gameStatusByTeam, projectionPointsMap) {
  let total = 0;
  for (const starterId of matchupEntry.starters) {
    if (!starterId || starterId === '0') continue;
    total += playerLiveBlendedPoints(
      starterId,
      players,
      gameStatusByTeam,
      matchupEntry.players_points || {},
      projectionPointsMap
    );
  }
  return Math.round(total * 100) / 100;
}

// Core median algorithm for one week.
//
// Returns:
//   medianMatchupId, byeRosterId (real team facing the median this week)
//   otherRosterIds (the 10 real rosters in the other 5 matchups)
//   ranking: [{roster_id, actual, blended}] sorted by blended desc
//   trackedRosterId: the roster currently ranked 5th by blended points
//   medianLiveScore: that roster's actual (live) points right now
//   medianBlendedScore: that roster's blended points (where it's "trending")
function computeMedianForWeek({ matchupEntries, medianRosterId, players, gameStatusByTeam, projectionPointsMap }) {
  const groups = groupMatchups(matchupEntries);
  let medianMatchupId = null;
  let byeRosterId = null;
  for (const [mid, entries] of groups) {
    const hasMedian = entries.some((e) => e.roster_id === medianRosterId);
    if (hasMedian) {
      medianMatchupId = mid;
      const other = entries.find((e) => e.roster_id !== medianRosterId);
      byeRosterId = other ? other.roster_id : null;
    }
  }

  const otherEntries = [];
  for (const [mid, entries] of groups) {
    if (mid === medianMatchupId) continue;
    for (const e of entries) otherEntries.push(e);
  }

  const ranking = otherEntries
    .map((e) => ({
      roster_id: e.roster_id,
      actual: teamActualPoints(e),
      blended: teamLiveBlendedPoints(e, players, gameStatusByTeam, projectionPointsMap),
      entry: e,
    }))
    .sort((a, b) => b.blended - a.blended);

  const fifth = ranking[4] || null;

  return {
    medianMatchupId,
    byeRosterId,
    ranking,
    trackedRosterId: fifth ? fifth.roster_id : null,
    medianLiveScore: fifth ? fifth.actual : 0,
    medianBlendedScore: fifth ? fifth.blended : 0,
  };
}

// Cheaper version for completed/historical weeks, used by the standings
// builder: once a week is over, actual === blended, so there's no need to
// fetch players/projections/game-status just to rank it.
function computeMedianForWeekFinal({ matchupEntries, medianRosterId }) {
  const groups = groupMatchups(matchupEntries);
  let medianMatchupId = null;
  let byeRosterId = null;
  for (const [mid, entries] of groups) {
    const hasMedian = entries.some((e) => e.roster_id === medianRosterId);
    if (hasMedian) {
      medianMatchupId = mid;
      const other = entries.find((e) => e.roster_id !== medianRosterId);
      byeRosterId = other ? other.roster_id : null;
    }
  }

  const otherEntries = [];
  for (const [mid, entries] of groups) {
    if (mid === medianMatchupId) continue;
    for (const e of entries) otherEntries.push(e);
  }

  const ranking = otherEntries
    .map((e) => ({ roster_id: e.roster_id, actual: teamActualPoints(e) }))
    .sort((a, b) => b.actual - a.actual);

  const fifth = ranking[4] || null;

  return {
    medianMatchupId,
    byeRosterId,
    groups,
    ranking,
    medianScore: fifth ? fifth.actual : 0,
  };
}

// ---------------------------------------------------------------- display
// Compact box-score line under each starter, e.g. "19/34 CMP, 230 YD, 2 TD,
// 1 INT, 4 CAR, 31 YD" - built from the same raw per-category stats used for
// scoring, formatted per position the way Sleeper's own matchup view does.

function n(stats, key) {
  return stats[key] || 0;
}

function statLine(position, stats) {
  const parts = [];
  const passAtt = n(stats, 'pass_att');
  const rushAtt = n(stats, 'rush_att');
  const recTgt = n(stats, 'rec_tgt');

  if (position === 'QB' || passAtt > 0) {
    if (passAtt > 0) {
      parts.push(`${n(stats, 'pass_cmp')}/${passAtt} CMP`);
      parts.push(`${n(stats, 'pass_yd')} YD`);
      if (n(stats, 'pass_td')) parts.push(`${n(stats, 'pass_td')} TD`);
      if (n(stats, 'pass_int')) parts.push(`${n(stats, 'pass_int')} INT`);
    }
  }
  if (position === 'K') {
    parts.length = 0;
    parts.push(`${n(stats, 'fgm')}/${n(stats, 'fga')} FG`);
    parts.push(`${n(stats, 'xpm')}/${n(stats, 'xpa')} XP`);
  } else if (position === 'DEF') {
    parts.length = 0;
    parts.push(`${n(stats, 'pts_allow')} PTS ALLOW`);
    if (n(stats, 'sack')) parts.push(`${n(stats, 'sack')} SACK`);
    if (n(stats, 'int')) parts.push(`${n(stats, 'int')} INT`);
    if (n(stats, 'fum_rec')) parts.push(`${n(stats, 'fum_rec')} FUM REC`);
    if (n(stats, 'def_td') || n(stats, 'fum_rec_td')) parts.push('DEF TD');
  } else {
    if (rushAtt > 0) {
      parts.push(`${rushAtt} CAR`);
      parts.push(`${n(stats, 'rush_yd')} YD`);
      if (n(stats, 'rush_td')) parts.push(`${n(stats, 'rush_td')} TD`);
    }
    if (recTgt > 0 || n(stats, 'rec') > 0) {
      parts.push(`${n(stats, 'rec')}/${recTgt || n(stats, 'rec')} REC`);
      parts.push(`${n(stats, 'rec_yd')} YD`);
      if (n(stats, 'rec_td')) parts.push(`${n(stats, 'rec_td')} TD`);
    }
    if (n(stats, 'fum_lost')) parts.push(`${n(stats, 'fum_lost')} FUM LOST`);
  }
  return parts.join(', ');
}

// Sleeper-style position badge colors.
const POSITION_COLORS = {
  QB: '#f16b7a',
  RB: '#22d3b0',
  WR: '#5b9cf6',
  TE: '#a78bfa',
  FLEX: '#8a92a6',
  K: '#e879c4',
  DEF: '#f0a04b',
  BN: '#8a92a6',
};

function positionColor(pos) {
  return POSITION_COLORS[pos] || POSITION_COLORS.FLEX;
}

// ------------------------------------------------------------ boogie bowl
//
// Playoff format: seeds 1-3 get a Round 1 bye. Seeds 4 and 5 play a
// single-elimination "Boogie Bowl" - the loser is out, the winner carries
// their Boogie Bowl score forward into a 2-week Round 1 matchup against one
// of the top-3 seeds. Which top-3 seed they get is decided in advance: the
// 1-seed ranks seeds 3, 4, and 5 in order of who they'd most want to face.
// Once the Boogie Bowl is decided, whichever of {seed 3, Boogie Bowl winner}
// is ranked higher on that list becomes the 1-seed's Round 1 opponent; the
// other one instead plays the 2-seed.
//
// oneSeedRanking: an array of exactly the seed numbers 3, 4, 5 in preference
// order (most-wanted opponent first), e.g. [4, 3, 5].
// boogieBowlWinnerSeed: 4 or 5 - whichever seed won the Boogie Bowl - or
// null/undefined if that game hasn't been decided yet.
function resolveBoogieBowlBracket(oneSeedRanking, boogieBowlWinnerSeed) {
  if (!Array.isArray(oneSeedRanking) || oneSeedRanking.length !== 3) return null;
  if (boogieBowlWinnerSeed == null) {
    return { pending: true, oneSeedOpponentSeed: null, twoSeedOpponentSeed: null };
  }
  const eliminatedSeed = boogieBowlWinnerSeed === 4 ? 5 : 4;
  // oneSeedRanking is already in preference order, so filtering out the
  // eliminated seed leaves the surviving two in that same preference order -
  // whichever comes first is the 1-seed's more-wanted survivor.
  const remaining = oneSeedRanking.filter((s) => s !== eliminatedSeed);
  return {
    pending: false,
    oneSeedOpponentSeed: remaining[0],
    twoSeedOpponentSeed: remaining[1],
  };
}
