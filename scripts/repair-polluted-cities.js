import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function resolveDatabasePath() {
  return process.env.TONGPIN_DB_PATH || path.join(process.cwd(), "data", "tongpin.sqlite");
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseJson(value, fallback = {}) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stableStringify(value) {
  return JSON.stringify(value ?? {});
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeList(value) {
  return String(value || "")
    .split(/[\n,，、；;/]/u)
    .map((item) => item.trim())
    .filter(Boolean);
}

function looksLikeSmalltalkCityPollution(value) {
  const text = normalizeText(value);

  if (!text) {
    return false;
  }

  return /[！？?!]/u.test(text) || /(你具体|你呢|哪里|在哪|聊聊|哈喽|你好|感觉你|印象不错)/u.test(text);
}

function isLikelyPlaceName(value) {
  const text = normalizeText(value);

  if (!text) {
    return false;
  }

  if (/(市|区|县|镇|乡|村|北京|上海|杭州|深圳|广州|苏州|南京|成都|重庆|武汉|西安|天津|宁波|厦门|青岛|长沙|珠海|海外)/u.test(text)) {
    return true;
  }

  return text.length >= 2 && text.length <= 6 && !/(可以|接受|偏向|倾向|长期|生活|定居|希望|具体|哪里)/u.test(text);
}

function cleanCityOption(value) {
  return normalizeText(value)
    .replace(
      /^(我这边|我|目前|未来|长期|生活城市|城市|定居|更偏向|更倾向|偏向|倾向|可以接受|能接受|接受|在)+/gu,
      ""
    )
    .replace(/(生活|定居|也可以|都可以|也可接受|可接受|可以接受|能接受)$/gu, "")
    .trim();
}

function sanitizeCitiesValue(value) {
  const text = normalizeText(value);

  if (!text || looksLikeSmalltalkCityPollution(text)) {
    return "";
  }

  const options = [...new Set(normalizeList(text).map(cleanCityOption).filter(Boolean))];
  const safeOptions = options.filter(isLikelyPlaceName);
  return safeOptions.join("、");
}

function pickFallbackCities(database, userId, excludeVersionId) {
  const rows = database
    .prepare(`
      SELECT id, payload_json
      FROM twin_profile_versions
      WHERE user_id = ? AND id <> ?
      ORDER BY version_number DESC
    `)
    .all(userId, excludeVersionId);

  for (const row of rows) {
    const payload = parseJson(row.payload_json, {});
    const safeCities = sanitizeCitiesValue(payload.cities);
    if (safeCities) {
      return safeCities;
    }
  }

  return "";
}

function backupDatabase(databasePath) {
  const backupPath = `${databasePath}.bak-cities-repair-${nowStamp()}`;
  fs.copyFileSync(databasePath, backupPath);
  return backupPath;
}

function repairTwinProfiles(database) {
  const currentRows = database
    .prepare(`
      SELECT user_id, twin_version_id, display_name, payload_json, runtime_state_json
      FROM current_twin_state_users
      ORDER BY user_id ASC
    `)
    .all();

  const updateCurrent = database.prepare(`
    UPDATE current_twin_state_users
    SET payload_json = ?, runtime_state_json = ?, updated_at = ?
    WHERE user_id = ?
  `);

  const updateVersion = database.prepare(`
    UPDATE twin_profile_versions
    SET payload_json = ?
    WHERE id = ?
  `);

  let repairedCurrentCount = 0;
  let repairedVersionCount = 0;

  for (const row of currentRows) {
    const payload = parseJson(row.payload_json, {});
    const runtimeState = parseJson(row.runtime_state_json, {});
    const originalCities = normalizeText(payload.cities);
    const prechatGoals = payload.prechatGoals && typeof payload.prechatGoals === "object" ? payload.prechatGoals : null;
    let changed = false;

    if (prechatGoals) {
      runtimeState.prechatGoals = {
        ...(runtimeState.prechatGoals && typeof runtimeState.prechatGoals === "object"
          ? runtimeState.prechatGoals
          : {}),
        ...prechatGoals
      };
      delete payload.prechatGoals;
      changed = true;
    }

    if (!originalCities) {
      if (changed) {
        const nextPayloadJson = stableStringify(payload);
        updateCurrent.run(nextPayloadJson, JSON.stringify(runtimeState), new Date().toISOString(), row.user_id);
        repairedCurrentCount += 1;
      }
      continue;
    }

    const safeCities = sanitizeCitiesValue(originalCities);
    if (safeCities === originalCities) {
      if (changed) {
        const nextPayloadJson = stableStringify(payload);
        updateCurrent.run(nextPayloadJson, JSON.stringify(runtimeState), new Date().toISOString(), row.user_id);
        repairedCurrentCount += 1;
      }
      continue;
    }

    const fallbackCities = safeCities || pickFallbackCities(database, row.user_id, row.twin_version_id);
    const nextPayload = { ...payload, cities: fallbackCities };
    const nextPayloadJson = stableStringify(nextPayload);

    updateCurrent.run(nextPayloadJson, JSON.stringify(runtimeState), new Date().toISOString(), row.user_id);
    updateVersion.run(nextPayloadJson, row.twin_version_id);
    repairedCurrentCount += 1;
    repairedVersionCount += 1;
  }

  return { repairedCurrentCount, repairedVersionCount };
}

function repairMatchReports(database) {
  const rows = database
    .prepare(`
      SELECT id, payload_json
      FROM match_reports
      ORDER BY created_at DESC
    `)
    .all();

  const updateReport = database.prepare(`
    UPDATE match_reports
    SET payload_json = ?
    WHERE id = ?
  `);

  let repairedReportCount = 0;

  for (const row of rows) {
    const payload = parseJson(row.payload_json, {});
    const shortlist = Array.isArray(payload.shortlist) ? payload.shortlist : [];
    let changed = false;

    const nextShortlist = shortlist.map((candidate) => {
      const nextCandidate = { ...candidate };
      const safeCity = sanitizeCitiesValue(candidate.city);
      const rawCity = normalizeText(candidate.city);

      if (rawCity && safeCity !== rawCity) {
        nextCandidate.city = safeCity;
        changed = true;
      }

      if (Array.isArray(candidate.realitySummary)) {
        const nextRealitySummary = candidate.realitySummary
          .map((item) => ({ ...item }))
          .filter((item) => {
            if (item.key !== "cities") {
              return true;
            }

            const safeValue = sanitizeCitiesValue(item.value);
            if (!safeValue) {
              changed = true;
              return false;
            }

            if (safeValue !== item.value || safeValue !== item.valueLabel) {
              item.value = safeValue;
              item.valueLabel = safeValue;
              changed = true;
            }

            return true;
          });

        nextCandidate.realitySummary = nextRealitySummary;
      }

      if (typeof candidate.summary === "string" && candidate.summary.includes("偏好城市：")) {
        const polluted = /偏好城市：[^；。!?！？]+/u.exec(candidate.summary);
        if (polluted) {
          const currentValue = polluted[0].replace(/^偏好城市：/u, "");
          const safeValue = sanitizeCitiesValue(currentValue);
          const replacement = safeValue ? `偏好城市：${safeValue}` : "";
          nextCandidate.summary = candidate.summary
            .replace(polluted[0], replacement)
            .replace(/；；+/gu, "；")
            .replace(/^；|；$/gu, "")
            .trim();
          changed = true;
        }
      }

      return nextCandidate;
    });

    if (!changed) {
      continue;
    }

    updateReport.run(
      stableStringify({
        ...payload,
        shortlist: nextShortlist
      }),
      row.id
    );
    repairedReportCount += 1;
  }

  return { repairedReportCount };
}

function main() {
  const databasePath = resolveDatabasePath();

  if (!fs.existsSync(databasePath)) {
    throw new Error(`数据库不存在：${databasePath}`);
  }

  const backupPath = backupDatabase(databasePath);
  const database = new DatabaseSync(databasePath);
  database.exec("BEGIN");

  try {
    const twinStats = repairTwinProfiles(database);
    const reportStats = repairMatchReports(database);
    database.exec("COMMIT");

    console.log(
      JSON.stringify(
        {
          databasePath,
          backupPath,
          ...twinStats,
          ...reportStats
        },
        null,
        2
      )
    );
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
}

main();
