// app.js - orchestration, rendering, standings, polling.

const DEFAULT_LEAGUE_ID = '1387827434572754944';
const LIVE_POLL_MS = 30000;

const state = {
  leagueId: null,
  league: null,
  users: [],
  rosters: [],
  realRosters: [],
  medianRoster: null,
  rosterMeta: {}, // roster_id -> { name, avatarUrl, ownerId }
  season: null,
  currentStateWeek: 1,
  playoffWeekStart: 14,
  lastLeagueWeek: 17, // last playable week (championship/3rd-place week), refined from league settings
  selectedWeek: 1,
  weekData: null, // populated by loadWeekData
  standingsCache: null, // { throughWeek, rows, medianRow }
  recordsByRoster: {}, // roster_id -> { wins, losses, ties, seed } (seed null for median)
  pollTimer: null,
  activeTab: 'scoreboard',
  boogieBowlSaved: null, // [seed, seed, seed] preference order loaded from boogie-bowl.json, or null
  bbDraftOrder: null, // in-progress reorder state for the ranking builder UI
  playoffData: null, // { pointsByWeek } - populated by loadPlayoffContext() for playoff weeks
};

// ---------------------------------------------------------------- helpers

function el(id) {
  return document.getElementById(id);
}

function fmtPts(n) {
  return (Math.round((n || 0) * 100) / 100).toFixed(2);
}

function avatarUrlFor(user) {
  const meta = user && user.metadata;
  if (meta && meta.avatar) return meta.avatar;
  if (user && user.avatar) return `https://sleepercdn.com/avatars/thumbs/${user.avatar}`;
  return null;
}

function getLeagueId() {
  return localStorage.getItem('smt:leagueId') || DEFAULT_LEAGUE_ID;
}

function setLeagueId(id) {
  localStorage.setItem('smt:leagueId', id);
}

// ---------------------------------------------------------- default week
//
// NFL weeks run Wednesday-to-Tuesday: a week's games finish by Monday
// night, Tuesday is a recap/grace day, and the tracker's default view
// should move forward to the next week starting that Wednesday. We compute
// this straight from the calendar (days elapsed since the season's kickoff
// Wednesday, in US Eastern time so every viewer gets the same answer
// regardless of their own timezone) rather than from Sleeper's own
// "current week" field, whose exact rollover day isn't guaranteed to line
// up with that rule.

// Midnight-UTC Date for a plain 'YYYY-MM-DD' calendar date (no timezone
// shift - it's just a day, not a moment in time).
function dateOnlyUTC(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`);
}

// Midnight-UTC Date representing the Eastern-timezone calendar day that
// moment `d` falls on - lets us compare "today" the same way for every
// viewer, in the league's own home timezone, instead of each viewer's local
// day potentially being a day off (and so landing on the wrong side of the
// Wednesday cutover) near midnight.
function easternCalendarDateUTC(d) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const day = parts.find((p) => p.type === 'day').value;
  return dateOnlyUTC(`${y}-${m}-${day}`);
}

// The week to show by default, per the Wednesday-rollover rule above.
// `seasonStartDate` is Sleeper's nflState.season_start_date (the season's
// kickoff Wednesday); `now` is the real current time; `lastLeagueWeek`
// clamps to the last playable week.
function computeDefaultDisplayWeek(seasonStartDate, now, lastLeagueWeek) {
  if (!seasonStartDate) return 1;
  const start = dateOnlyUTC(seasonStartDate);
  const today = easternCalendarDateUTC(now);
  const daysSinceStart = Math.round((today - start) / 86400000);
  if (daysSinceStart < 0) return 1;
  const week = 1 + Math.floor(daysSinceStart / 7);
  return Math.max(1, Math.min(week, lastLeagueWeek || week));
}

// The 1-seed's Boogie Bowl opponent preference, if someone has saved one.
// Lives as a plain JSON file alongside index.html (no backend) - see
// buildBoogieBowlPanel(). Missing file / bad JSON just means "not set yet."
async function loadBoogieBowlRanking() {
  try {
    const res = await fetch('boogie-bowl.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data.oneSeedRanking) && data.oneSeedRanking.length === 3) {
      return data.oneSeedRanking;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------ league load

async function loadLeagueMeta() {
  state.leagueId = getLeagueId();
  const [league, users, rosters, nflState] = await Promise.all([
    getLeague(state.leagueId),
    getUsers(state.leagueId),
    getRosters(state.leagueId),
    getState(),
  ]);

  state.league = league;
  state.users = users;
  state.rosters = rosters;
  state.season = league.season;
  state.playoffWeekStart = (league.settings && league.settings.playoff_week_start) || 14;
  // Playoffs run 4 weeks: Boogie Bowl (wk 14), Round 1 (wk 14-15, 2-week
  // aggregate), Championship + 3rd place (wk 16-17, 2-week aggregate) - this
  // league's own fixed format, so the season's last playable week is always
  // playoffWeekStart + 3.
  //
  // NOTE: this used to fall back to league.settings.last_scored_leg "when
  // present", on the assumption it would confirm the season's final week.
  // It doesn't - Sleeper updates last_scored_leg live, to the most recent
  // week that's fully final (e.g. 3 while week 4 is still being played), so
  // using it here clamped the default week (and the playoff week range)
  // down to whatever week just finished, every single week of the season.
  // That was the real cause of the tracker always showing last week's
  // scores by default. last_scored_leg is a "how far has scoring caught
  // up" signal, not a "how long is this season" one - don't use it here.
  state.lastLeagueWeek = state.playoffWeekStart + 3;

  const { medianRoster, realRosters } = splitRosters(rosters);
  state.medianRoster = medianRoster;
  state.realRosters = realRosters;

  const usersById = {};
  for (const u of users) usersById[u.user_id] = u;

  const meta = {};
  for (const r of rosters) {
    if (r.owner_id && usersById[r.owner_id]) {
      const u = usersById[r.owner_id];
      meta[r.roster_id] = {
        name: (u.metadata && u.metadata.team_name) || u.display_name || `Team ${r.roster_id}`,
        avatarUrl: avatarUrlFor(u),
        ownerId: r.owner_id,
        handle: u.display_name ? `@${u.display_name}` : null,
      };
    } else {
      meta[r.roster_id] = { name: 'Median', avatarUrl: null, ownerId: null, handle: null };
    }
  }
  state.rosterMeta = meta;

  // state.currentStateWeek drives the "is this week final yet" checks used
  // all over the app, so it stays exactly what Sleeper reports as the
  // league's current week.
  let currentStateWeek = 1;
  if (nflState && String(nflState.season) === String(league.season)) {
    currentStateWeek = nflState.week || 1;
  }
  state.currentStateWeek = currentStateWeek;

  // The week shown by default on load is a separate question - see
  // computeDefaultDisplayWeek() above - so that it reliably advances every
  // Wednesday regardless of exactly which day Sleeper itself rolls its own
  // current-week field over.
  let defaultWeek =
    nflState && String(nflState.season) === String(league.season)
      ? computeDefaultDisplayWeek(nflState.season_start_date, new Date(), state.lastLeagueWeek)
      : 1;
  defaultWeek = Math.max(1, Math.min(defaultWeek, state.lastLeagueWeek));
  state.selectedWeek = defaultWeek;

  el('leagueTitle').textContent = league.name || 'League';
  el('leagueSeason').textContent = `${league.season} Season`;
  el('brandYear').textContent = league.season || '';

  populateWeekSelect();
}

// Short label for a playoff week's dropdown entry, e.g. "Week 14 - Boogie Bowl".
function playoffWeekLabel(w) {
  const start = state.playoffWeekStart;
  if (w === start) return `Week ${w} - Boogie Bowl`;
  if (w === start + 1) return `Week ${w} - Round 1`;
  if (w === start + 2 || w === start + 3) return `Week ${w} - Championship`;
  return `Week ${w}`;
}

function populateWeekSelect() {
  const sel = el('weekSelect');
  sel.innerHTML = '';
  const regSeasonLast = Math.max(1, state.playoffWeekStart - 1);
  for (let w = 1; w <= regSeasonLast; w++) {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = `Week ${w}`;
    if (w === state.selectedWeek) opt.selected = true;
    sel.appendChild(opt);
  }
  for (let w = state.playoffWeekStart; w <= state.lastLeagueWeek; w++) {
    const opt = document.createElement('option');
    opt.value = String(w);
    opt.textContent = playoffWeekLabel(w);
    if (w === state.selectedWeek) opt.selected = true;
    sel.appendChild(opt);
  }
}

// -------------------------------------------------------------- week load

async function loadWeekData(week) {
  const leagueId = state.leagueId;
  const season = state.season;
  const isFinal = week < state.currentStateWeek;

  const matchupEntries = await getMatchups(leagueId, week, { isFinal });
  const gameInfoByTeam = await getGameInfoByTeam(season, week).catch(() => ({}));
  const gameStatusByTeam = {};
  for (const team in gameInfoByTeam) gameStatusByTeam[team] = gameInfoByTeam[team].state;

  // Pull full rosters (not just starters) so the Bench section has data too.
  const neededPlayerIds = new Set();
  for (const e of matchupEntries) {
    for (const pid of e.players || e.starters || []) {
      if (pid && pid !== '0') neededPlayerIds.add(pid);
    }
  }
  const players = await getPlayersTrimmed([...neededPlayerIds]);

  let projectionPointsMap = {};
  try {
    const rawProj = await getProjectionsRaw(season, week);
    const relevant = rawProj.filter((e) => neededPlayerIds.has(e.player_id));
    projectionPointsMap = buildProjectionPointsMap(relevant, state.league.scoring_settings);
  } catch (e) {
    console.warn('projections unavailable', e);
  }

  let actualStatsMap = {};
  try {
    const rawStats = await getStatsRaw(season, week, { isFinal });
    for (const e of rawStats) {
      if (neededPlayerIds.has(e.player_id)) actualStatsMap[e.player_id] = e.stats;
    }
  } catch (e) {
    console.warn('stats unavailable', e);
  }

  // The median mechanic only applies during the regular season - once
  // playoffs start there's no median matchup to compute.
  const isPlayoff = week >= state.playoffWeekStart;
  const medianRosterId = state.medianRoster ? state.medianRoster.roster_id : null;
  const medianResult =
    !isPlayoff && medianRosterId
      ? computeMedianForWeek({
          matchupEntries,
          medianRosterId,
          players,
          gameStatusByTeam,
          projectionPointsMap,
        })
      : null;

  state.weekData = {
    week,
    isPlayoff,
    matchupEntries,
    groups: groupMatchups(matchupEntries),
    gameInfoByTeam,
    gameStatusByTeam,
    players,
    projectionPointsMap,
    actualStatsMap,
    medianResult,
  };
}

// ------------------------------------------------------------- playoffs

// A week's per-roster points, as { actual: {roster_id: pts}, blended: {roster_id: pts} }.
// "actual" is real accrued points so far; "blended" fills in projections for
// players whose games haven't started yet (same idea as teamLiveBlendedPoints,
// applied to every roster in the week rather than just one matchup). For a
// week that's already fully final the two are identical.
async function loadPlayoffWeekPoints(uptoWeek) {
  const start = state.playoffWeekStart;
  const result = {};
  for (let w = start; w <= uptoWeek; w++) {
    if (state.weekData && state.weekData.week === w && state.weekData.matchupEntries) {
      // Already fetched (with players/game-status/projections) to render this
      // week's cards - reuse it instead of hitting the API again.
      const wd = state.weekData;
      const actual = {};
      const blended = {};
      for (const e of wd.matchupEntries) {
        actual[e.roster_id] = e.points || 0;
        blended[e.roster_id] = teamLiveBlendedPoints(e, wd.players, wd.gameStatusByTeam, wd.projectionPointsMap);
      }
      result[w] = { actual, blended };
    } else {
      const isFinal = w < state.currentStateWeek;
      let entries = [];
      try {
        entries = await getMatchups(state.leagueId, w, { isFinal });
      } catch (e) {
        entries = [];
      }
      const actual = {};
      for (const e of entries) actual[e.roster_id] = e.points || 0;
      result[w] = { actual, blended: actual };
    }
  }
  return result;
}

function weekPts(pointsByWeek, week, rosterId, kind) {
  const wk = pointsByWeek[week];
  if (!wk) return 0;
  const map = kind === 'blended' ? wk.blended : wk.actual;
  return (map && map[rosterId]) || 0;
}

function sumWeeksKind(pointsByWeek, weeks, rosterId, kind) {
  return weeks.reduce((sum, w) => sum + weekPts(pointsByWeek, w, rosterId, kind), 0);
}

// Boogie Bowl winner (seed 4 or 5), once Week 14 is fully final - null while
// it's still pending. Ties (shouldn't really happen) favor the higher seed.
function computeBoogieBowlWinnerSeed(pointsByWeek) {
  const bbWeek = state.playoffWeekStart;
  if (!(bbWeek < state.currentStateWeek)) return null;
  const seed4 = seedRosterId(4);
  const seed5 = seedRosterId(5);
  const p4 = weekPts(pointsByWeek, bbWeek, seed4, 'actual');
  const p5 = weekPts(pointsByWeek, bbWeek, seed5, 'actual');
  return p4 >= p5 ? 4 : 5;
}

// Fetches this state's playoff-weeks point data through the selected week.
// Called instead of computeMedianForWeek's regular-season path once playoffs
// have started - see refreshCurrentWeek().
async function loadPlayoffContext() {
  await ensureRecords();
  const cache = state.standingsCache;
  if (!cache || !cache.rows || cache.rows.length < 5) {
    state.playoffData = null;
    return;
  }
  const pointsByWeek = await loadPlayoffWeekPoints(state.selectedWeek);
  state.playoffData = { pointsByWeek };
}

// -------------------------------------------------------------- rendering

function rosterName(rosterId) {
  const m = state.rosterMeta[rosterId];
  return m ? m.name : `Team ${rosterId}`;
}

function rosterAvatar(rosterId) {
  const m = state.rosterMeta[rosterId];
  return m && m.avatarUrl;
}

function avatarEl(rosterId, isMedian, sizeClass) {
  const url = rosterAvatar(rosterId);
  const cls = `avatar ${sizeClass || ''}`.trim();
  if (url) {
    const img = document.createElement('img');
    img.className = cls;
    img.src = url;
    img.alt = '';
    return img;
  }
  const div = document.createElement('div');
  div.className = cls + ' avatar-fallback' + (isMedian ? ' avatar-median' : '');
  div.textContent = isMedian ? 'μ' : rosterName(rosterId).slice(0, 1).toUpperCase();
  return div;
}

function trackedTeamAsMedianEntry(trackedRosterId) {
  const wd = state.weekData;
  for (const [, entries] of wd.groups) {
    for (const e of entries) {
      if (e.roster_id === trackedRosterId) return e;
    }
  }
  return null;
}

function isMatchupFullyFinal(entryA, entryB) {
  const gi = state.weekData.gameInfoByTeam;
  const players = state.weekData.players;
  const allFinal = (entry) =>
    (entry.starters || []).every((pid) => {
      const p = players[pid];
      const info = p && p.team && gi[p.team];
      return !info || info.state === 'final'; // no game info = bye, treat as settled
    });
  return allFinal(entryA) && allFinal(entryB);
}

function winShare(a, b) {
  const sum = a + b;
  if (sum <= 0) return 50;
  return Math.round((100 * a) / sum);
}

// Build the { name, avatar, score, proj, sub, trophy } descriptor for one
// side of a matchup header - shared by the scoreboard card and the modal.
function sideDescriptor(entry, isMedian, mr, isLeftSide) {
  const rosterId = entry.roster_id;
  if (isMedian) {
    const trackedName = mr.trackedRosterId ? rosterName(mr.trackedRosterId) : '—';
    return {
      rosterId,
      isMedian: true,
      name: 'Median',
      avatarNode: avatarEl(rosterId, true, 'avatar-lg'),
      score: mr.medianLiveScore,
      proj: mr.medianBlendedScore,
      sub: `tracking ${trackedName}`,
    };
  }
  const rec = state.recordsByRoster[rosterId];
  const recordText = rec ? `${recordStr(rec)}${rec.seed ? ` (#${rec.seed})` : ''}` : '';
  const handle = (state.rosterMeta[rosterId] && state.rosterMeta[rosterId].handle) || '';
  const bits = [handle, recordText].filter(Boolean);
  const sub = isLeftSide ? bits.join(' · ') : bits.slice().reverse().join(' · ');
  const blended = mr && mr.ranking ? mr.ranking.find((r) => r.roster_id === rosterId) : null;
  // The team facing the median this week is deliberately excluded from
  // mr.ranking (only the "other 10" teams get ranked to find the median's
  // score), so it has no pre-computed blended value - compute its own
  // honest live-blended projection directly rather than falling back to its
  // raw actual points (which would wrongly show 0/partial instead of a real
  // projection while its game is still in progress).
  const wd = state.weekData;
  const ownBlended =
    blended != null
      ? blended.blended
      : wd
      ? teamLiveBlendedPoints(entry, wd.players, wd.gameStatusByTeam, wd.projectionPointsMap)
      : entry.points;
  return {
    rosterId,
    isMedian: false,
    name: rosterName(rosterId),
    avatarNode: avatarEl(rosterId, false, 'avatar-lg'),
    score: entry.points,
    proj: ownBlended,
    sub,
  };
}

function buildMatchupHeader(leftDesc, rightDesc, isMedianMatchup, isFullyFinal) {
  const header = document.createElement('div');
  header.className = 'matchup-header';

  const leftPct = winShare(leftDesc.proj, rightDesc.proj);
  const rightPct = 100 - leftPct;
  const leftLeading = leftPct >= rightPct;
  const leftWonFinal = isFullyFinal && leftDesc.score >= rightDesc.score;

  function scoreCol(desc, pct, leading, side) {
    const col = document.createElement('div');
    col.className = `score-col score-col-${side}`;
    const big = document.createElement('div');
    big.className = 'score-big';
    big.textContent = fmtPts(desc.score);
    const proj = document.createElement('div');
    proj.className = 'score-proj';
    proj.textContent = fmtPts(desc.proj);
    const bar = document.createElement('div');
    bar.className = 'winbar';
    const fill = document.createElement('div');
    fill.className = 'winbar-fill ' + (leading ? 'winbar-lead' : 'winbar-trail');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    const pctLabel = document.createElement('div');
    pctLabel.className = 'winbar-label ' + (leading ? 'winbar-lead-text' : 'winbar-trail-text');
    pctLabel.textContent = `${pct}%`;
    col.appendChild(big);
    col.appendChild(proj);
    col.appendChild(bar);
    col.appendChild(pctLabel);
    return col;
  }

  function avatarWrap(desc, won) {
    const wrap = document.createElement('div');
    wrap.className = 'avatar-wrap';
    wrap.appendChild(desc.avatarNode);
    if (won) {
      const trophy = document.createElement('span');
      trophy.className = 'trophy-badge';
      trophy.textContent = '🏆';
      wrap.appendChild(trophy);
    }
    return wrap;
  }

  header.appendChild(avatarWrap(leftDesc, leftWonFinal));
  header.appendChild(scoreCol(leftDesc, leftPct, leftLeading, 'left'));
  const vs = document.createElement('div');
  vs.className = 'vs-badge';
  vs.textContent = 'VS';
  header.appendChild(vs);
  header.appendChild(scoreCol(rightDesc, rightPct, !leftLeading, 'right'));
  header.appendChild(avatarWrap(rightDesc, isFullyFinal && !leftWonFinal));

  const teams = document.createElement('div');
  teams.className = 'matchup-teams';
  const leftMeta = document.createElement('div');
  leftMeta.className = 'team-meta team-meta-left';
  leftMeta.innerHTML = `<div class="team-name">${leftDesc.name}</div><div class="team-sub">${leftDesc.sub}</div>`;
  const rightMeta = document.createElement('div');
  rightMeta.className = 'team-meta team-meta-right';
  rightMeta.innerHTML = `<div class="team-name">${rightDesc.name}</div><div class="team-sub">${rightDesc.sub}</div>`;
  teams.appendChild(leftMeta);
  teams.appendChild(rightMeta);

  const wrap = document.createElement('div');
  wrap.appendChild(header);
  wrap.appendChild(teams);
  return wrap;
}

function renderScoreboard() {
  el('scoreboardSectionHeading').classList.add('hidden');
  el('consolationWrap').classList.add('hidden');
  el('byeWrap').classList.add('hidden');

  const grid = el('scoreboardGrid');
  grid.innerHTML = '';
  const wd = state.weekData;
  if (!wd) return;

  el('weekHeading').textContent = `Week ${wd.week}`;

  const medianRosterId = state.medianRoster ? state.medianRoster.roster_id : null;
  const mr = wd.medianResult;

  for (const [matchupId, entries] of wd.groups) {
    if (entries.length < 2) continue;
    const isMedianMatchup = mr && matchupId === mr.medianMatchupId;
    const [a, b] = entries;
    const card = document.createElement('div');
    card.className = 'matchup-card' + (isMedianMatchup ? ' matchup-card-median' : '');

    const leftDesc = sideDescriptor(a, isMedianMatchup && a.roster_id === medianRosterId, mr, true);
    const rightDesc = sideDescriptor(b, isMedianMatchup && b.roster_id === medianRosterId, mr, false);
    const fullyFinal = isMatchupFullyFinal(a, b);
    card.appendChild(buildMatchupHeader(leftDesc, rightDesc, isMedianMatchup, fullyFinal));

    card.addEventListener('click', () => openMatchupModal(matchupId));
    grid.appendChild(card);
  }
}

// ------------------------------------------------------ playoff scoreboard

// { name, avatar, score, proj, sub } descriptor for one side of a playoff
// card - mirrors sideDescriptor's shape so buildMatchupHeader can be reused
// unchanged. score = actual points so far over the window; proj = the same
// but blended with in-progress-game projections (drives the win-share bar,
// same as the regular season).
function playoffSideDescriptor(rosterId, weeks, pointsByWeek) {
  const actual = sumWeeksKind(pointsByWeek, weeks, rosterId, 'actual');
  const blended = sumWeeksKind(pointsByWeek, weeks, rosterId, 'blended');
  const rec = state.recordsByRoster[rosterId];
  const seedTxt = rec && rec.seed ? `#${rec.seed} seed` : '';
  const sub =
    weeks.length > 1
      ? weeks.map((w) => `Wk${w} ${fmtPts(weekPts(pointsByWeek, w, rosterId, 'actual'))}`).join('  +  ')
      : seedTxt;
  return {
    rosterId,
    isMedian: false,
    name: rosterName(rosterId),
    avatarNode: avatarEl(rosterId, false, 'avatar-lg'),
    score: actual,
    proj: blended,
    sub,
  };
}

function buildPlayoffCard(label, rosterIdLeft, rosterIdRight, weeks, pointsByWeek, isFullyFinal) {
  const leftDesc = playoffSideDescriptor(rosterIdLeft, weeks, pointsByWeek);
  const rightDesc = playoffSideDescriptor(rosterIdRight, weeks, pointsByWeek);

  const card = document.createElement('div');
  card.className = 'matchup-card matchup-card-playoff';
  const labelEl = document.createElement('div');
  labelEl.className = 'matchup-round-label';
  labelEl.textContent = label;
  card.appendChild(labelEl);
  card.appendChild(buildMatchupHeader(leftDesc, rightDesc, false, isFullyFinal));
  return card;
}

function buildPendingCard(title, text) {
  const card = document.createElement('div');
  card.className = 'matchup-card pending-card';
  const t = document.createElement('div');
  t.className = 'pending-card-title';
  t.textContent = title;
  const p = document.createElement('div');
  p.className = 'pending-card-text';
  p.textContent = text;
  card.appendChild(t);
  card.appendChild(p);
  return card;
}

// Boogie Bowl week only: seeds 1-3 don't play that week (they're waiting on
// Round 1), so give them their own live-sorted panel - same visual language
// as the consolation panel, but for just that one week's score.
function buildByeSection(pointsByWeek, week) {
  const rows = [1, 2, 3].map((seed) => {
    const rosterId = seedRosterId(seed);
    // Actual (not blended) - same live-updating points-scored-so-far number
    // the Boogie Bowl card itself shows, no projections data needed.
    const score = weekPts(pointsByWeek, week, rosterId, 'actual');
    return { seed, rosterId, score };
  });
  rows.sort((a, b) => b.score - a.score);

  const wrap = document.createElement('div');
  wrap.className = 'cons-panel';

  const heading = document.createElement('div');
  heading.className = 'cons-heading';
  heading.textContent = 'On a Bye This Week';
  wrap.appendChild(heading);

  const note = document.createElement('div');
  note.className = 'cons-note';
  note.textContent = `Seeds 1-3 sit out the Boogie Bowl and wait to see who they draw in Round 1. Here's how their Week ${week} is going.`;
  wrap.appendChild(note);

  const list = document.createElement('div');
  list.className = 'cons-list';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = 'cons-row' + (i === 0 ? ' cons-row-leader' : '');

    const rank = document.createElement('div');
    rank.className = 'cons-rank';
    rank.textContent = String(i + 1);

    const team = document.createElement('div');
    team.className = 'cons-team';
    team.appendChild(avatarEl(r.rosterId, false, 'avatar'));
    const teamMeta = document.createElement('div');
    teamMeta.className = 'cons-team-meta';
    teamMeta.innerHTML = `<div class="cons-team-name">${rosterName(r.rosterId)}</div><div class="cons-team-seed">#${
      r.seed
    } seed</div>`;
    team.appendChild(teamMeta);

    const scoreBlock = document.createElement('div');
    scoreBlock.className = 'cons-score-block';
    const total = document.createElement('div');
    total.className = 'cons-total';
    total.textContent = fmtPts(r.score);
    scoreBlock.appendChild(total);

    row.appendChild(rank);
    row.appendChild(team);
    row.appendChild(scoreBlock);
    list.appendChild(row);
  });
  wrap.appendChild(list);

  return wrap;
}

// Consolation standings: every team that isn't in the "final four" (seeds 1,
// 2, 3, and the Boogie Bowl winner) competes on total points scored across
// weeks 14-17, no head-to-head. That's seeds 6+ plus whoever loses the
// Boogie Bowl - the loser only joins once that game is fully final.
function buildConsolationSection(pointsByWeek, uptoWeek) {
  const cache = state.standingsCache;
  if (!cache || !cache.rows || cache.rows.length < 6) return null;

  const start = state.playoffWeekStart;
  const weeks = [];
  for (let w = start; w <= uptoWeek; w++) weeks.push(w);

  const nonPlayoffRows = cache.rows.slice(5); // seeds 6+
  const bbWinnerSeed = computeBoogieBowlWinnerSeed(pointsByWeek);
  const bbLoserRosterId = bbWinnerSeed != null ? seedRosterId(bbWinnerSeed === 4 ? 5 : 4) : null;

  const memberIds = nonPlayoffRows.map((r) => r.roster_id);
  if (bbLoserRosterId) memberIds.push(bbLoserRosterId);

  const members = memberIds.map((rid) => {
    const seed = cache.rows.findIndex((r) => r.roster_id === rid) + 1;
    return { rosterId: rid, seed, total: sumWeeksKind(pointsByWeek, weeks, rid, 'actual') };
  });
  members.sort((a, b) => b.total - a.total);

  const wrap = document.createElement('div');
  wrap.className = 'cons-panel';

  const heading = document.createElement('div');
  heading.className = 'cons-heading';
  heading.textContent = 'Consolation Standings';
  wrap.appendChild(heading);

  const note = document.createElement('div');
  note.className = 'cons-note';
  note.textContent = `Highest combined score wins - Weeks ${start}-${start + 3}, no head-to-head. Every team outside the final four, plus whoever's eliminated from the Boogie Bowl.`;
  wrap.appendChild(note);

  const list = document.createElement('div');
  list.className = 'cons-list';
  members.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'cons-row' + (i === 0 ? ' cons-row-leader' : '');

    const rank = document.createElement('div');
    rank.className = 'cons-rank';
    rank.textContent = String(i + 1);

    const team = document.createElement('div');
    team.className = 'cons-team';
    team.appendChild(avatarEl(m.rosterId, false, 'avatar'));
    const teamMeta = document.createElement('div');
    teamMeta.className = 'cons-team-meta';
    teamMeta.innerHTML = `<div class="cons-team-name">${rosterName(m.rosterId)}</div><div class="cons-team-seed">#${
      m.seed
    } seed</div>`;
    team.appendChild(teamMeta);

    const scoreBlock = document.createElement('div');
    scoreBlock.className = 'cons-score-block';
    const total = document.createElement('div');
    total.className = 'cons-total';
    total.textContent = fmtPts(m.total);
    const breakdown = document.createElement('div');
    breakdown.className = 'cons-breakdown';
    breakdown.textContent = weeks
      .map((w) => `Wk${w} ${fmtPts(weekPts(pointsByWeek, w, m.rosterId, 'actual'))}`)
      .join('  +  ');
    scoreBlock.appendChild(total);
    scoreBlock.appendChild(breakdown);

    row.appendChild(rank);
    row.appendChild(team);
    row.appendChild(scoreBlock);
    list.appendChild(row);
  });
  wrap.appendChild(list);

  if (bbWinnerSeed == null) {
    const pending = document.createElement('div');
    pending.className = 'cons-pending-note';
    pending.textContent = `Once the Boogie Bowl (${rosterName(seedRosterId(4))} vs ${rosterName(
      seedRosterId(5)
    )}) is final, its loser joins this list.`;
    wrap.appendChild(pending);
  }

  return wrap;
}

function renderPlayoffScoreboard() {
  const heading = el('scoreboardSectionHeading');
  heading.textContent = 'Playoffs & Boogie Bowl';
  heading.classList.remove('hidden');

  const grid = el('scoreboardGrid');
  grid.innerHTML = '';
  const wd = state.weekData;
  if (!wd) return;

  el('weekHeading').textContent = playoffWeekLabel(wd.week);

  const pd = state.playoffData;
  if (!pd || !pd.pointsByWeek) {
    grid.innerHTML = '<div class="loading">Loading playoff data…</div>';
    el('consolationWrap').classList.add('hidden');
    el('byeWrap').classList.add('hidden');
    return;
  }
  const { pointsByWeek } = pd;
  const start = state.playoffWeekStart;
  const round1Weeks = [start, start + 1];
  const finalWeeks = [start + 2, start + 3];
  const uptoWeek = wd.week;

  const seed1 = seedRosterId(1);
  const seed2 = seedRosterId(2);
  const seed4 = seedRosterId(4);
  const seed5 = seedRosterId(5);

  const byeWrap = el('byeWrap');
  byeWrap.innerHTML = '';
  byeWrap.classList.add('hidden');

  // Only the round that's actually live for the selected week shows - not
  // every round the bracket has worked through so far.
  if (uptoWeek === start) {
    // Boogie Bowl week: seed4 vs seed5 play; seeds 1-3 are on a bye.
    const bbFinal = start < state.currentStateWeek;
    grid.appendChild(buildPlayoffCard(`Boogie Bowl · Week ${start}`, seed4, seed5, [start], pointsByWeek, bbFinal));

    byeWrap.appendChild(buildByeSection(pointsByWeek, start));
    byeWrap.classList.remove('hidden');
  } else if (uptoWeek === round1Weeks[1]) {
    // Round 1 week: whoever the Boogie Bowl winner drew, plus the other Round 1 pairing.
    const bbWinnerSeed = computeBoogieBowlWinnerSeed(pointsByWeek);
    const bracket = state.boogieBowlSaved ? resolveBoogieBowlBracket(state.boogieBowlSaved, bbWinnerSeed) : null;

    if (!bracket || bracket.pending) {
      grid.appendChild(
        buildPendingCard(
          'Round 1 pairing pending',
          bbWinnerSeed == null
            ? `Waiting on the Boogie Bowl (${rosterName(seed4)} vs ${rosterName(seed5)}) to finish.`
            : `${rosterName(seed1)} hasn't saved a Boogie Bowl preference yet - set one on the Standings tab.`
        )
      );
    } else {
      const oneOppRoster = seedRosterId(bracket.oneSeedOpponentSeed);
      const twoOppRoster = seedRosterId(bracket.twoSeedOpponentSeed);
      const round1Final = round1Weeks.every((w) => w < state.currentStateWeek);

      grid.appendChild(buildPlayoffCard('Round 1 · 2-week total', seed1, oneOppRoster, round1Weeks, pointsByWeek, round1Final));
      grid.appendChild(buildPlayoffCard('Round 1 · 2-week total', seed2, twoOppRoster, round1Weeks, pointsByWeek, round1Final));
    }
  } else if (uptoWeek >= finalWeeks[0]) {
    // Championship week(s): needs Round 1's final result to know who's playing.
    const bbWinnerSeed = computeBoogieBowlWinnerSeed(pointsByWeek);
    const bracket = state.boogieBowlSaved ? resolveBoogieBowlBracket(state.boogieBowlSaved, bbWinnerSeed) : null;
    const round1Final = round1Weeks.every((w) => w < state.currentStateWeek);

    if (!bracket || bracket.pending || !round1Final) {
      grid.appendChild(buildPendingCard('Championship pairing pending', 'Waiting on Round 1 to finish.'));
    } else {
      const oneOppRoster = seedRosterId(bracket.oneSeedOpponentSeed);
      const twoOppRoster = seedRosterId(bracket.twoSeedOpponentSeed);

      const oneTotal = sumWeeksKind(pointsByWeek, round1Weeks, seed1, 'actual');
      const oneOppTotal = sumWeeksKind(pointsByWeek, round1Weeks, oneOppRoster, 'actual');
      const twoTotal = sumWeeksKind(pointsByWeek, round1Weeks, seed2, 'actual');
      const twoOppTotal = sumWeeksKind(pointsByWeek, round1Weeks, twoOppRoster, 'actual');

      const champA = oneTotal >= oneOppTotal ? seed1 : oneOppRoster;
      const champALoser = oneTotal >= oneOppTotal ? oneOppRoster : seed1;
      const champB = twoTotal >= twoOppTotal ? seed2 : twoOppRoster;
      const champBLoser = twoTotal >= twoOppTotal ? twoOppRoster : seed2;

      const finalFinal = finalWeeks.every((w) => w < state.currentStateWeek);
      grid.appendChild(buildPlayoffCard('Championship · 2-week total', champA, champB, finalWeeks, pointsByWeek, finalFinal));
      grid.appendChild(buildPlayoffCard('3rd Place · 2-week total', champALoser, champBLoser, finalWeeks, pointsByWeek, finalFinal));
    }
  }

  const consWrap = el('consolationWrap');
  consWrap.innerHTML = '';
  const cons = buildConsolationSection(pointsByWeek, uptoWeek);
  if (cons) {
    consWrap.appendChild(cons);
    consWrap.classList.remove('hidden');
  } else {
    consWrap.classList.add('hidden');
  }
}

// ----------------------------------------------------------------- modal

function startSlotLabels() {
  return (state.league.roster_positions || []).filter((p) => p !== 'BN' && p !== 'IR' && p !== 'TAXI');
}

function injuryTag(status) {
  if (!status) return null;
  const map = {
    Questionable: { text: 'QUES', cls: 'tag-warn' },
    Doubtful: { text: 'DOUB', cls: 'tag-warn' },
    Out: { text: 'OUT', cls: 'tag-bad' },
    IR: { text: 'IR', cls: 'tag-bad' },
    PUP: { text: 'PUP', cls: 'tag-bad' },
    Suspended: { text: 'SUS', cls: 'tag-bad' },
  };
  return map[status] || null;
}

function formatKickoff(dateTime) {
  if (!dateTime) return '';
  const d = new Date(dateTime);
  if (isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString(undefined, { weekday: 'short' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} ${time}`;
}

// { text, cls } line under a player's meta row, e.g. "Final L 15-24 vs CHI".
function gameResultInfo(teamAbbr) {
  const info = state.weekData.gameInfoByTeam[teamAbbr];
  if (!info) return { text: 'BYE', cls: '' };
  const oppText = `${info.isHome ? 'vs' : '@'} ${info.opp}`;
  if (info.state === 'pre') {
    return { text: `${formatKickoff(info.dateTime)} ${oppText}`, cls: '' };
  }
  if (info.state === 'live') {
    const q = info.quarter ? `Q${info.quarter}` : 'Live';
    return { text: `${q} ${info.clock || ''} ${oppText}`, cls: 'result-live' };
  }
  const win = info.teamScore > info.oppScore;
  const tie = info.teamScore === info.oppScore;
  const wl = tie ? 'T' : win ? 'W' : 'L';
  return {
    text: `Final ${wl} ${info.teamScore}-${info.oppScore} ${oppText}`,
    cls: tie ? '' : win ? 'result-w' : 'result-l',
  };
}

function playerName(pid) {
  const p = state.weekData.players[pid];
  if (!p) return pid;
  if (p.position === 'DEF') return `${p.last_name} D/ST`;
  return `${(p.first_name || '').slice(0, 1)}${p.first_name ? '. ' : ''}${p.last_name || ''}`.trim();
}

function playerMetaLine(pid) {
  const p = state.weekData.players[pid];
  if (!p) return '';
  const bye = ''; // bye-week number isn't in our trimmed player cache
  return `${p.position} · ${p.team || 'FA'}${bye}`;
}

function buildPlayerCell(pid, side, entry) {
  const cell = document.createElement('div');
  cell.className = `player-side player-side-${side}`;
  if (!pid) {
    cell.innerHTML = '<div class="player-empty">Empty</div>';
    return cell;
  }
  const p = state.weekData.players[pid] || {};
  const bigScore = (entry && entry.players_points && entry.players_points[pid]) || 0;
  const rawProj = state.weekData.projectionPointsMap[pid];
  const projScore = rawProj == null ? null : rawProj; // null = no projection available (e.g. ruled out)

  const topline = document.createElement('div');
  topline.className = 'player-topline';
  const nameEl = document.createElement('div');
  nameEl.className = 'player-name';
  nameEl.textContent = playerName(pid);
  const scoreBlock = document.createElement('div');
  scoreBlock.className = 'player-scoreblock';
  scoreBlock.innerHTML = `<div class="player-score">${fmtPts(bigScore)}</div><div class="player-proj">${
    projScore == null ? '—' : fmtPts(projScore)
  }</div>`;
  if (side === 'left') {
    topline.appendChild(nameEl);
    topline.appendChild(scoreBlock);
  } else {
    topline.appendChild(scoreBlock);
    topline.appendChild(nameEl);
  }
  cell.appendChild(topline);

  const meta = document.createElement('div');
  meta.className = 'player-meta';
  meta.textContent = playerMetaLine(pid);
  const tag = injuryTag(p.injury_status);
  if (tag) {
    const tagEl = document.createElement('span');
    tagEl.className = `injury-tag ${tag.cls}`;
    tagEl.textContent = tag.text;
    meta.appendChild(document.createTextNode(' '));
    meta.appendChild(tagEl);
  }
  cell.appendChild(meta);

  if (p.team) {
    const result = gameResultInfo(p.team);
    const resultEl = document.createElement('div');
    resultEl.className = `player-result ${result.cls}`;
    resultEl.textContent = result.text;
    cell.appendChild(resultEl);

    const stats = state.weekData.actualStatsMap[pid];
    if (stats) {
      const line = statLine(p.position, stats);
      if (line) {
        const lineEl = document.createElement('div');
        lineEl.className = 'player-statline';
        lineEl.textContent = line;
        cell.appendChild(lineEl);
      }
    }
  }

  return cell;
}

function buildPlayerRow(pidLeft, pidRight, badgeText, entryLeft, entryRight) {
  const row = document.createElement('div');
  row.className = 'player-row';
  row.appendChild(buildPlayerCell(pidLeft, 'left', entryLeft));
  const badge = document.createElement('div');
  badge.className = 'pos-badge';
  badge.style.background = positionColor(badgeText);
  badge.textContent = badgeText;
  row.appendChild(badge);
  row.appendChild(buildPlayerCell(pidRight, 'right', entryRight));
  return row;
}

function summarizePositions(pidList) {
  const order = [];
  const counts = {};
  for (const pid of pidList) {
    const p = state.weekData.players[pid];
    const pos = (p && p.position) || '?';
    if (!(pos in counts)) order.push(pos);
    counts[pos] = (counts[pos] || 0) + 1;
  }
  return order.map((pos) => (counts[pos] > 1 ? `${counts[pos]} ${pos}` : pos)).join(', ');
}

function yetToPlayRow(entryLeft, entryRight) {
  const gi = state.weekData.gameInfoByTeam;
  const notStarted = (entry) =>
    (entry.starters || []).filter((pid) => {
      const p = state.weekData.players[pid];
      const info = p && p.team && gi[p.team];
      return info && info.state === 'pre';
    });

  const leftList = notStarted(entryLeft);
  const rightList = notStarted(entryRight);
  if (leftList.length === 0 && rightList.length === 0) return null;

  const row = document.createElement('div');
  row.className = 'yet-to-play-row';
  const left = document.createElement('div');
  left.className = 'yet-to-play yet-to-play-left';
  left.textContent = leftList.length ? `yet to play (${leftList.length}): ${summarizePositions(leftList)}` : '';
  const right = document.createElement('div');
  right.className = 'yet-to-play yet-to-play-right';
  right.textContent = rightList.length ? `yet to play (${rightList.length}): ${summarizePositions(rightList)}` : '';
  row.appendChild(left);
  row.appendChild(right);
  return row;
}

function buildSection(label, rows) {
  const section = document.createElement('div');
  section.className = 'lineup-section';
  const heading = document.createElement('div');
  heading.className = 'section-label';
  heading.textContent = label;
  section.appendChild(heading);
  rows.forEach((r) => section.appendChild(r));
  return section;
}

function openMatchupModal(matchupId) {
  const wd = state.weekData;
  const entries = wd.groups.get(matchupId);
  if (!entries || entries.length < 2) return;
  const mr = wd.medianResult;
  const isMedianMatchup = mr && matchupId === mr.medianMatchupId;
  const medianRosterId = state.medianRoster ? state.medianRoster.roster_id : null;

  let [a, b] = entries;
  if (isMedianMatchup && a.roster_id === medianRosterId) {
    [a, b] = [b, a]; // always put the real (bye-week) team on the left, median on the right
  }

  // For the median matchup, the "right" side's real lineup is whichever team
  // median is currently tracking - median's own roster is an empty shell.
  const rightLineupEntry = isMedianMatchup ? trackedTeamAsMedianEntry(mr.trackedRosterId) || b : b;

  const body = el('modalBody');
  body.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'modal-title';
  title.textContent = `Week ${wd.week}`;
  body.appendChild(title);

  const leftDesc = sideDescriptor(a, false, mr, true);
  const rightDesc = sideDescriptor(b, isMedianMatchup, mr, false);
  const fullyFinal = isMatchupFullyFinal(a, rightLineupEntry);
  body.appendChild(buildMatchupHeader(leftDesc, rightDesc, isMedianMatchup, fullyFinal));

  if (isMedianMatchup) {
    const note = document.createElement('div');
    note.className = 'modal-note';
    note.textContent = `Median mirrors the 5th-highest scoring team (by live projection) among the other 10 teams this week. Right now that's ${rosterName(
      mr.trackedRosterId
    )} - shown below as median's lineup.`;
    body.appendChild(note);
  }

  const ytp = yetToPlayRow(a, rightLineupEntry);
  if (ytp) body.appendChild(ytp);

  const slots = startSlotLabels();
  const starterRows = a.starters.map((pid, i) =>
    buildPlayerRow(pid, rightLineupEntry.starters[i], slots[i] || 'FLEX', a, rightLineupEntry)
  );
  body.appendChild(buildSection('Starters', starterRows));

  const leftBench = (a.players || []).filter((p) => !a.starters.includes(p));
  const rightBench = (rightLineupEntry.players || []).filter((p) => !rightLineupEntry.starters.includes(p));
  const benchLen = Math.max(leftBench.length, rightBench.length);
  if (benchLen > 0) {
    const benchRows = [];
    for (let i = 0; i < benchLen; i++) {
      benchRows.push(buildPlayerRow(leftBench[i] || null, rightBench[i] || null, 'BN', a, rightLineupEntry));
    }
    const benchSection = buildSection('Bench', benchRows);
    benchSection.classList.add('lineup-section-bench');
    body.appendChild(benchSection);
  }

  el('matchupModal').classList.remove('hidden');
}

function closeModal() {
  el('matchupModal').classList.add('hidden');
}

// ------------------------------------------------------------- standings

async function computeStandingsThroughWeek(lastWeek) {
  const rows = {}; // roster_id -> { wins, losses, ties, pf, pa }
  for (const r of state.realRosters) {
    rows[r.roster_id] = { wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 };
  }
  const medianRow = { wins: 0, losses: 0, ties: 0, pf: 0, pa: 0 };
  const medianRosterId = state.medianRoster ? state.medianRoster.roster_id : null;

  for (let w = 1; w <= lastWeek; w++) {
    let matchupEntries;
    try {
      matchupEntries = await getMatchups(state.leagueId, w, { isFinal: true });
    } catch (e) {
      continue;
    }
    if (!matchupEntries || matchupEntries.length === 0) continue;

    const result = computeMedianForWeekFinal({ matchupEntries, medianRosterId });
    for (const [mid, entries] of result.groups) {
      if (entries.length < 2) continue;
      if (mid === result.medianMatchupId) {
        const byeEntry = entries.find((e) => e.roster_id !== medianRosterId);
        if (!byeEntry) continue;
        const byeScore = byeEntry.points;
        const medScore = result.medianScore;
        const row = rows[byeEntry.roster_id];
        if (!row) continue;
        row.pf += byeScore;
        row.pa += medScore;
        medianRow.pf += medScore;
        medianRow.pa += byeScore;
        if (byeScore > medScore) {
          row.wins++;
          medianRow.losses++;
        } else if (byeScore < medScore) {
          row.losses++;
          medianRow.wins++;
        } else {
          row.ties++;
          medianRow.ties++;
        }
      } else {
        const [x, y] = entries;
        const rx = rows[x.roster_id];
        const ry = rows[y.roster_id];
        if (!rx || !ry) continue;
        rx.pf += x.points;
        rx.pa += y.points;
        ry.pf += y.points;
        ry.pa += x.points;
        if (x.points > y.points) {
          rx.wins++;
          ry.losses++;
        } else if (x.points < y.points) {
          ry.wins++;
          rx.losses++;
        } else {
          rx.ties++;
          ry.ties++;
        }
      }
    }
  }

  const sorted = state.realRosters
    .map((r) => ({ roster_id: r.roster_id, ...rows[r.roster_id] }))
    .sort((p, q) => {
      const pPct = winPct(p);
      const qPct = winPct(q);
      if (qPct !== pPct) return qPct - pPct;
      return q.pf - p.pf;
    });

  return { rows: sorted, medianRow };
}

// Records + seeds, used both by the Standings tab and by the small
// "@handle · 7-6 (#5)" line under each team in the scoreboard/matchup header.
async function ensureRecords() {
  const lastWeek = Math.min(state.currentStateWeek - 1, state.playoffWeekStart - 1);
  if (state.standingsCache && state.standingsCache.throughWeek === lastWeek) {
    return state.standingsCache;
  }
  if (lastWeek < 1) {
    state.recordsByRoster = {};
    return null;
  }
  const { rows, medianRow } = await computeStandingsThroughWeek(lastWeek);
  const byRoster = {};
  rows.forEach((r, i) => {
    byRoster[r.roster_id] = { ...r, seed: i + 1 };
  });
  if (state.medianRoster) {
    byRoster[state.medianRoster.roster_id] = { ...medianRow, seed: null };
  }
  state.recordsByRoster = byRoster;
  const cache = { throughWeek: lastWeek, rows, medianRow };
  state.standingsCache = cache;
  return cache;
}

function winPct(r) {
  const total = r.wins + r.losses + r.ties;
  if (total === 0) return 0;
  return (r.wins + r.ties * 0.5) / total;
}

function recordStr(r) {
  return r.ties > 0 ? `${r.wins}-${r.losses}-${r.ties}` : `${r.wins}-${r.losses}`;
}

async function renderStandings() {
  const wrap = el('standingsTableWrap');
  wrap.innerHTML = '<div class="loading">Loading standings…</div>';

  const cache = await ensureRecords();
  if (!cache) {
    wrap.innerHTML = '<div class="loading">Standings will appear once Week 1 is complete.</div>';
    return;
  }
  const { rows, medianRow, throughWeek: lastWeek } = cache;

  wrap.innerHTML = '';

  const note = document.createElement('div');
  note.className = 'standings-note';
  note.textContent = `Through Week ${lastWeek}`;
  wrap.appendChild(note);

  const table = document.createElement('table');
  table.className = 'standings-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Seed</th><th>Team</th><th>Record</th><th>PF</th><th>PA</th></tr>';
  table.appendChild(thead);
  const tbody = document.createElement('tbody');

  rows.forEach((r, i) => {
    const rank = i + 1;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${rank}</td>
      <td>${rosterName(r.roster_id)}</td>
      <td>${recordStr(r)}</td>
      <td>${fmtPts(r.pf)}</td>
      <td>${fmtPts(r.pa)}</td>
    `;
    tbody.appendChild(tr);

    if (rank === 3) {
      tbody.appendChild(cutLineRow('Boogie Bowl cut line — seeds 1–3 get a Round 1 bye'));
    }
    if (rank === 5) {
      tbody.appendChild(cutLineRow('Playoff cut line — seeds 6+ miss the playoffs'));
    }
  });

  table.appendChild(tbody);
  const scroll = document.createElement('div');
  scroll.className = 'standings-scroll';
  scroll.appendChild(table);
  wrap.appendChild(scroll);

  const medianWrap = document.createElement('div');
  medianWrap.className = 'median-standings';
  const medianTable = document.createElement('table');
  medianTable.className = 'standings-table standings-table-median';
  medianTable.innerHTML = `
    <thead><tr><th colspan="5">Median (placeholder team — not seeded)</th></tr></thead>
    <tbody>
      <tr>
        <td>—</td>
        <td>Median</td>
        <td>${recordStr(medianRow)}</td>
        <td>${fmtPts(medianRow.pf)}</td>
        <td>${fmtPts(medianRow.pa)}</td>
      </tr>
    </tbody>
  `;
  const medianScroll = document.createElement('div');
  medianScroll.className = 'standings-scroll';
  medianScroll.appendChild(medianTable);
  medianWrap.appendChild(medianScroll);
  wrap.appendChild(medianWrap);

  const bbPanel = buildBoogieBowlPanel();
  if (bbPanel) wrap.appendChild(bbPanel);
}

function cutLineRow(label) {
  const tr = document.createElement('tr');
  tr.className = 'cut-line-row';
  const td = document.createElement('td');
  td.colSpan = 5;
  td.innerHTML = `<div class="cut-line"><span>${label}</span></div>`;
  tr.appendChild(td);
  return tr;
}

// --------------------------------------------------------- boogie bowl UI

function seedRosterId(seed) {
  const cache = state.standingsCache;
  if (!cache || !cache.rows || cache.rows.length < seed) return null;
  return cache.rows[seed - 1].roster_id;
}

// Standings-tab panel: shows the saved 1-seed preference (if any) and the
// resulting bracket preview, plus a ranking builder anyone can use to
// generate the file contents to save. There's no login and nothing is
// locked - per the league's own call, this is meant as a shared, honor-system
// tool, not an access-controlled one. Saving means committing a small JSON
// file (boogie-bowl.json) to the same GitHub repo the site itself lives in;
// that keeps it visible to everyone with no new backend, accounts, or cost.
function buildBoogieBowlPanel() {
  const cache = state.standingsCache;
  if (!cache || !cache.rows || cache.rows.length < 5) return null;

  const seed1 = seedRosterId(1);
  const seed2 = seedRosterId(2);
  const seed3 = seedRosterId(3);
  const seed4 = seedRosterId(4);
  const seed5 = seedRosterId(5);

  if (!state.bbDraftOrder) {
    state.bbDraftOrder =
      state.boogieBowlSaved && state.boogieBowlSaved.length === 3 ? state.boogieBowlSaved.slice() : [3, 4, 5];
  }

  const wrap = document.createElement('div');
  wrap.className = 'bb-panel';

  const heading = document.createElement('div');
  heading.className = 'bb-heading';
  heading.textContent = 'Boogie Bowl';
  wrap.appendChild(heading);

  const intro = document.createElement('div');
  intro.className = 'bb-intro';
  intro.innerHTML = `Seeds 4 and 5 - <strong>${rosterName(seed4)}</strong> vs <strong>${rosterName(
    seed5
  )}</strong> - play a single-elimination game in Week 14. The winner carries that score into a 2-week Round 1 matchup against whichever top-3 seed <strong>${rosterName(
    seed1
  )}</strong> (the 1-seed) ranks higher below.`;
  wrap.appendChild(intro);

  if (state.boogieBowlSaved && state.boogieBowlSaved.length === 3) {
    const savedBox = document.createElement('div');
    savedBox.className = 'bb-saved';
    const label = document.createElement('div');
    label.className = 'bb-saved-label';
    label.textContent = `${rosterName(seed1)}'s saved preference (most → least wanted opponent)`;
    savedBox.appendChild(label);
    const order = document.createElement('div');
    order.className = 'bb-saved-order';
    state.boogieBowlSaved.forEach((seed, i) => {
      const chip = document.createElement('span');
      chip.className = 'bb-chip';
      chip.textContent = `${i + 1}. ${rosterName(seedRosterId(seed))}`;
      order.appendChild(chip);
    });
    savedBox.appendChild(order);
    wrap.appendChild(savedBox);

    const note = document.createElement('div');
    note.className = 'bb-preview-note';
    note.textContent = `Once the Boogie Bowl is played, whichever of ${rosterName(
      seed3
    )} or the Boogie Bowl winner ranks higher above becomes ${rosterName(
      seed1
    )}'s Round 1 opponent - the other plays ${rosterName(seed2)}.`;
    wrap.appendChild(note);
  } else {
    const none = document.createElement('div');
    none.className = 'bb-none';
    none.textContent = 'No saved preference yet - use the builder below to set one.';
    wrap.appendChild(none);
  }

  const builder = document.createElement('div');
  builder.className = 'bb-builder';
  const builderLabel = document.createElement('div');
  builderLabel.className = 'bb-builder-label';
  builderLabel.textContent = `Ranking builder - order who ${rosterName(seed1)} would rather face`;
  builder.appendChild(builderLabel);

  const list = document.createElement('div');
  list.className = 'bb-order-list';
  state.bbDraftOrder.forEach((seed, i) => {
    const row = document.createElement('div');
    row.className = 'bb-order-row';
    const nameEl = document.createElement('div');
    nameEl.className = 'bb-order-name';
    nameEl.innerHTML = `<span class="bb-order-rank">${i + 1}</span> ${rosterName(
      seedRosterId(seed)
    )} <span class="bb-order-seed">(#${seed})</span>`;
    row.appendChild(nameEl);

    const btns = document.createElement('div');
    btns.className = 'bb-order-btns';
    const btnUp = document.createElement('button');
    btnUp.className = 'bb-order-btn';
    btnUp.type = 'button';
    btnUp.textContent = '↑';
    btnUp.disabled = i === 0;
    btnUp.addEventListener('click', () => {
      const arr = state.bbDraftOrder;
      [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      renderStandings();
    });
    const btnDown = document.createElement('button');
    btnDown.className = 'bb-order-btn';
    btnDown.type = 'button';
    btnDown.textContent = '↓';
    btnDown.disabled = i === state.bbDraftOrder.length - 1;
    btnDown.addEventListener('click', () => {
      const arr = state.bbDraftOrder;
      [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
      renderStandings();
    });
    btns.appendChild(btnUp);
    btns.appendChild(btnDown);
    row.appendChild(btns);
    list.appendChild(row);
  });
  builder.appendChild(list);

  const output = document.createElement('div');
  output.className = 'bb-output hidden';

  const genBtn = document.createElement('button');
  genBtn.className = 'btn-primary bb-generate-btn';
  genBtn.type = 'button';
  genBtn.textContent = 'Generate file to save';
  genBtn.addEventListener('click', () => {
    const json = JSON.stringify({ oneSeedRanking: state.bbDraftOrder }, null, 2);
    output.classList.remove('hidden');
    output.innerHTML = '';
    const ta = document.createElement('textarea');
    ta.className = 'bb-output-textarea';
    ta.readOnly = true;
    ta.value = json;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn-secondary bb-copy-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', () => {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(json).then(() => {
          copyBtn.textContent = 'Copied!';
          setTimeout(() => (copyBtn.textContent = 'Copy'), 1500);
        });
      } else {
        ta.select();
      }
    });
    const hint = document.createElement('div');
    hint.className = 'bb-output-hint';
    hint.innerHTML =
      'Save this as <code>boogie-bowl.json</code> in your GitHub repo (same "Add file → Upload files" flow you used to deploy the site) to make it visible to everyone. Anyone can update it at any time - including after Week 14 starts, if a correction is needed.';
    output.appendChild(ta);
    output.appendChild(copyBtn);
    output.appendChild(hint);
  });
  builder.appendChild(genBtn);
  builder.appendChild(output);
  wrap.appendChild(builder);

  return wrap;
}

// -------------------------------------------------------------- controls

function switchTab(tab) {
  state.activeTab = tab;
  el('scoreboardView').classList.toggle('hidden', tab !== 'scoreboard');
  el('standingsView').classList.toggle('hidden', tab !== 'standings');
  el('tabScoreboard').classList.toggle('active', tab === 'scoreboard');
  el('tabStandings').classList.toggle('active', tab === 'standings');
  if (tab === 'standings') renderStandings();
}

async function refreshCurrentWeek() {
  try {
    await loadWeekData(state.selectedWeek);
    if (state.weekData.isPlayoff) {
      await loadPlayoffContext();
      renderPlayoffScoreboard();
    } else {
      renderScoreboard();
    }
    el('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    console.error(e);
    el('lastUpdated').textContent = 'Update failed — retrying…';
  }
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (state.activeTab === 'scoreboard') refreshCurrentWeek();
  }, LIVE_POLL_MS);
}

async function init() {
  el('tabScoreboard').addEventListener('click', () => switchTab('scoreboard'));
  el('tabStandings').addEventListener('click', () => switchTab('standings'));
  el('modalClose').addEventListener('click', closeModal);
  el('matchupModal').addEventListener('click', (e) => {
    if (e.target.id === 'matchupModal') closeModal();
  });
  el('weekSelect').addEventListener('change', async (e) => {
    state.selectedWeek = parseInt(e.target.value, 10);
    el('scoreboardGrid').innerHTML = '<div class="loading">Loading…</div>';
    await refreshCurrentWeek();
  });
  el('settingsBtn').addEventListener('click', () => {
    el('leagueIdInput').value = state.leagueId || '';
    el('settingsModal').classList.remove('hidden');
  });
  el('cancelSettings').addEventListener('click', () => el('settingsModal').classList.add('hidden'));
  el('saveSettings').addEventListener('click', () => {
    const val = el('leagueIdInput').value.trim();
    if (val) {
      setLeagueId(val);
      el('settingsModal').classList.add('hidden');
      boot();
    }
  });

  await boot();
}

async function boot() {
  el('scoreboardGrid').innerHTML = '<div class="loading">Loading league…</div>';
  try {
    await loadLeagueMeta();
    await ensureRecords();
    state.boogieBowlSaved = await loadBoogieBowlRanking();
    state.bbDraftOrder = null; // recompute from the freshly-loaded saved ranking on next render
    await refreshCurrentWeek();
    startPolling();
  } catch (e) {
    console.error(e);
    el('scoreboardGrid').innerHTML = `<div class="loading error">Couldn't load league data: ${e.message}</div>`;
  }
}

document.addEventListener('DOMContentLoaded', init);
