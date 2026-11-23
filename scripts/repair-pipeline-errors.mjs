import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, 'src', 'data');
const PUBLIC_DATA_DIR = path.join(ROOT, 'public', 'data');
const dryRun = process.env.PIPELINE_REPAIR_DRY_RUN === '1';
const TARGET_FILES = ['kopis-performances.json', 'interpark.json'];
const SOURCE_FILES = [
  'kopis-performances.json', 'interpark.json', 'culture-portal.json',
  'yes24.json', 'timeticket.json',
];
const REPAIR_FIELDS = [
  'price', 'priceList', 'age', 'ageDetail', 'runtime', 'runningTime',
  'image', 'backupPoster', 'synopsis', 'description', 'bookingLinks',
];

const emptyValue = (value) => {
  if (Array.isArray(value)) return value.length === 0;
  if (value == null) return true;
  return !String(value).trim() || /정보\s*없음|미정|문의|예매처\s*확인|가격\s*확인/i.test(String(value));
};
const normalize = (value) => String(value || '').toLowerCase()
  .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
  .replace(/[^0-9a-z가-힣]/g, '');
const dates = (value) => (String(value || '').match(/20\d{2}[./-]\d{1,2}[./-]\d{1,2}/g) || [])
  .map((date) => { const [y, m, d] = date.split(/[./-]/).map(Number); return new Date(y, m - 1, d).getTime(); })
  .filter(Number.isFinite);
const overlaps = (a, b) => {
  const left = dates(a); const right = dates(b);
  if (!left.length || !right.length) return false;
  return Math.min(...left) <= Math.max(...right) && Math.min(...right) <= Math.max(...left);
};
const stableKey = (item) => {
  const title = normalize(item.title || item.name);
  const venue = normalize(item.venue || item.place || item.address);
  return title && venue ? `${title}|${venue}` : '';
};
const readArray = (file) => {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch { return []; }
};
const writeJson = (file, value) => {
  const target = path.join(DATA_DIR, file);
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, target);
};

const rowsByFile = new Map(SOURCE_FILES.map((file) => [file, readArray(file)]));
const peers = SOURCE_FILES.flatMap((file) => rowsByFile.get(file).map((item) => ({ file, item })));
const repairs = [];
for (const file of TARGET_FILES) {
  const rows = rowsByFile.get(file);
  let changed = false;
  for (const row of rows) {
    const key = stableKey(row);
    if (!key) continue;
    const matches = peers.filter((peer) => peer.file !== file
      && stableKey(peer.item) === key && overlaps(row.date, peer.item.date));
    for (const field of REPAIR_FIELDS) {
      if (!emptyValue(row[field])) continue;
      const match = matches.find(({ item }) => !emptyValue(item[field]));
      if (!match) continue;
      row[field] = match.item[field];
      changed = true;
      repairs.push({ id: row.id || row.title, field, fromSource: match.item.source || match.file });
    }
  }
  if (changed && !dryRun) writeJson(file, rows);
}

const sourceHealth = SOURCE_FILES.map((file) => {
  const rows = rowsByFile.get(file);
  const dated = rows.map((row) => String(row.date || row.startDate || '')).filter(Boolean).sort();
  const imageFields = rows.filter((row) => !emptyValue(row.image || row.poster || row.thumbnail || row.backupPoster)).length;
  return {
    source: file.replace(/\.json$/, ''),
    records: rows.length,
    latestDate: dated.at(-1) || null,
    imageCoverage: rows.length ? Number((imageFields / rows.length).toFixed(4)) : 0,
  };
});

const failurePath = path.join(ROOT, 'scrape_failures.txt');
const failures = fs.existsSync(failurePath)
  ? fs.readFileSync(failurePath, 'utf8').split(/\r?\n/).map((source) => source.trim()).filter(Boolean).map((source) => ({
    source,
    kind: ['umclass', 'mochaclass'].includes(source) ? 'access-or-structure' : source === 'museum' ? 'timeout' : 'scraper-failure',
    action: 'retain-last-good-data',
    blocking: false,
  })) : [];

const report = {
  generatedAt: new Date().toISOString(),
  runId: process.env.GITHUB_RUN_ID || null,
  commit: process.env.GITHUB_SHA || null,
  failures,
  sourceHealth,
  repairs: {
    attempted: true,
    changedRecords: new Set(repairs.map((repair) => repair.id)).size,
    changedFields: repairs.length,
    details: repairs,
  },
  retainedDataPolicy: 'Failed sources never replace the last known-good source file.',
  dryRun,
};
fs.mkdirSync(PUBLIC_DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(PUBLIC_DATA_DIR, 'pipeline-error-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`[pipeline-repair] failures=${failures.length} changedRecords=${report.repairs.changedRecords} changedFields=${repairs.length}`);
