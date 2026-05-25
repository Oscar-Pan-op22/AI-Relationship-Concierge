import fs from "node:fs";
import path from "node:path";

const dataDir = path.join(process.cwd(), "data");
const reportsPath = path.join(dataDir, "screenings.json");

function ensureStore() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  if (!fs.existsSync(reportsPath)) {
    fs.writeFileSync(reportsPath, "[]", "utf8");
  }
}

export function loadReports() {
  ensureStore();
  const raw = fs.readFileSync(reportsPath, "utf8");
  return JSON.parse(raw);
}

export function saveReport(report) {
  const reports = loadReports();
  reports.unshift(report);
  fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2), "utf8");
  return report;
}
