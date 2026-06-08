import {
  getCurrentTwin,
  getLatestOpenSessionForMatch,
  getMatchForUser,
  listMatchableUsers,
  listMatchesForUser,
  upsertMatch
} from "./database.js";
import { buildPublicTwinSnapshot, scoreUserMatch } from "./phase2MatchEngine.js";

function isBrokenName(value) {
  return /^\?{2,}$/u.test(String(value || "").trim()) || /^\uFFFD+$/u.test(String(value || "").trim());
}

export function refreshMatchesForUser(userId) {
  const currentTwin = getCurrentTwin(userId);

  if (!currentTwin) {
    return [];
  }

  const counterparts = listMatchableUsers(userId);

  for (const counterpart of counterparts) {
    const scored = scoreUserMatch(currentTwin, counterpart);
    upsertMatch(userId, counterpart.id, scored.score, "matched");
  }

  return buildMatchesForUser(userId);
}

export function buildMatchesForUser(userId) {
  const currentTwin = getCurrentTwin(userId);

  if (!currentTwin) {
    return [];
  }

  return listMatchesForUser(userId)
    .map((match) => {
      const counterpartTwin = getCurrentTwin(match.counterpartId);

      if (!counterpartTwin) {
        return null;
      }

      const scored = scoreUserMatch(currentTwin, counterpartTwin);
      const snapshot = buildPublicTwinSnapshot(counterpartTwin);

      if (isBrokenName(snapshot.displayName) || isBrokenName(match.counterpart.displayName)) {
        return null;
      }

      const openSession = getLatestOpenSessionForMatch(match.id);

      return {
        ...match,
        score: scored.score,
        scoreLabel: scored.label,
        counterpart: {
          ...match.counterpart,
          ...snapshot
        },
        reasons: scored.reasons,
        openSession: openSession
          ? {
              id: openSession.id,
              status: openSession.status
            }
          : null
      };
    })
    .filter(Boolean);
}
