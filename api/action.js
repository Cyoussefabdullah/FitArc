const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);

const ADMIN_PASSWORD = 'Joe2002';

const PLAN_DAYS = { monthly: 30, quarterly: 90 };
const PLAN_WEEKS = { monthly: 4, quarterly: 12 };

function checkPassword(pw) {
  return pw === ADMIN_PASSWORD;
}

function toDateStr(d) {
  if (!d) return null;
  if (d instanceof Date) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  return String(d).slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return toDateStr(d);
}

function todayStr() {
  return toDateStr(new Date());
}

// Minimum number of days that must pass since a client's last submitted
// weekly check-in before they're allowed to submit the next one. Deliberately
// NOT tied to the calendar week (clients' training cycles start on different
// days and don't all take exactly 7 days) -- this is a floor, not a fixed
// cadence, so a client who finishes a short cycle can still check in sooner
// than someone on a longer one, as long as at least this many days passed.
const MIN_CHECKIN_GAP_DAYS = 3;

async function generateLoginId() {
  for (let i = 0; i < 20; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const rows = await sql`SELECT 1 FROM clients WHERE login_id = ${code}`;
    if (!rows.length) return code;
  }
  throw new Error('could_not_generate_login_id');
}

// ---------- Clients ----------

async function addClient(pw, name, phone, plan, driveLink) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!name) return { ok: false, error: 'invalid_input' };
  const safePlan = PLAN_WEEKS[plan] ? plan : 'monthly';
  const loginId = await generateLoginId();
  const totalWeeks = PLAN_WEEKS[safePlan];
  const rows = await sql`
    INSERT INTO clients (login_id, name, phone, drive_link, plan, start_date, total_weeks)
    VALUES (${loginId}, ${name}, ${phone || null}, ${driveLink || null}, ${safePlan}, ${todayStr()}, ${totalWeeks})
    RETURNING id, login_id AS "loginId"
  `;
  return { ok: true, clientId: rows[0].id, loginId: rows[0].loginId };
}

async function updateClient(pw, clientId, body) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId) return { ok: false, error: 'invalid_id' };
  if (!body.name) return { ok: false, error: 'invalid_input' };
  await sql`
    UPDATE clients SET name = ${body.name}, phone = ${body.phone || null}, drive_link = ${body.driveLink || null}
    WHERE id = ${clientId}
  `;
  return { ok: true };
}

async function deleteClient(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId) return { ok: false, error: 'invalid_id' };
  await sql`DELETE FROM workout_logs WHERE client_id = ${clientId}`;
  await sql`DELETE FROM workout_plan WHERE client_id = ${clientId}`;
  await sql`DELETE FROM workout_plan_weeks WHERE client_id = ${clientId}`;
  await sql`DELETE FROM diet_plan WHERE client_id = ${clientId}`;
  await sql`DELETE FROM checkins WHERE client_id = ${clientId}`;
  await sql`DELETE FROM assessments WHERE client_id = ${clientId}`;
  await sql`DELETE FROM clients WHERE id = ${clientId}`;
  return { ok: true };
}

function subscriptionFields(c) {
  const endDate = addDays(toDateStr(c.start_date), PLAN_DAYS[c.plan] || 30);
  const daysRemaining = Math.ceil((new Date(endDate + 'T00:00:00Z') - new Date(todayStr() + 'T00:00:00Z')) / 86400000);
  return { plan: c.plan, startDate: toDateStr(c.start_date), endDate, daysRemaining, totalWeeks: c.total_weeks };
}

async function listClients(pw) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const rows = await sql`
    SELECT id, login_id AS "loginId", name, phone, drive_link AS "driveLink", plan, start_date, total_weeks, created_at AS "createdAt"
    FROM clients ORDER BY created_at DESC
  `;
  const logRows = await sql`SELECT client_id AS "clientId", MAX(updated_at) AS "lastLog" FROM workout_logs GROUP BY client_id`;
  const lastLogs = {};
  logRows.forEach(r => { lastLogs[r.clientId] = r.lastLog; });
  return {
    ok: true,
    clients: rows.map(c => ({
      id: c.id, loginId: c.loginId, name: c.name, phone: c.phone, driveLink: c.driveLink || '',
      createdAt: c.createdAt, lastWorkoutLog: lastLogs[c.id] || null,
      ...subscriptionFields(c),
    })),
  };
}

async function getClientRow(clientId) {
  const rows = await sql`SELECT * FROM clients WHERE id = ${clientId}`;
  return rows[0] || null;
}

async function hasAssessmentOrCheckin(clientId) {
  const a = await sql`SELECT id FROM assessments WHERE client_id = ${clientId} LIMIT 1`;
  if (a.length) return true;
  const c = await sql`SELECT id FROM checkins WHERE client_id = ${clientId} LIMIT 1`;
  return c.length > 0;
}

async function clientLogin(loginId) {
  if (!loginId) return { ok: false, error: 'invalid_login_id' };
  const rows = await sql`SELECT id, name FROM clients WHERE login_id = ${loginId}`;
  if (!rows.length) return { ok: false, error: 'invalid_login_id' };
  return { ok: true, clientId: rows[0].id, name: rows[0].name };
}

async function getClientPortal(clientId) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const has = await hasAssessmentOrCheckin(clientId);
  return {
    ok: true, name: c.name, driveLink: c.drive_link || '', hasAssessment: has,
    ...subscriptionFields(c),
  };
}

async function getClientDetail(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const has = await hasAssessmentOrCheckin(clientId);
  const logRows = await sql`SELECT MAX(updated_at) AS "lastLog" FROM workout_logs WHERE client_id = ${clientId}`;
  return {
    ok: true, id: c.id, loginId: c.login_id, name: c.name, phone: c.phone,
    driveLink: c.drive_link || '', hasAssessment: has,
    lastWorkoutLog: (logRows[0] && logRows[0].lastLog) || null,
    ...subscriptionFields(c),
  };
}

// ---------- Assessment (first check-in) ----------

async function submitAssessment(body) {
  const clientId = body.clientId;
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const required = [
    'fullName', 'job', 'age', 'heightCm', 'weightKg', 'medicalHistory', 'goal',
    'trainingDays', 'supplements', 'favoriteFoods', 'dislikedFoods', 'stepsPerDay',
    'mealsPerDay', 'sleepHours', 'trainedBefore', 'stressLevel',
  ];
  for (const f of required) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      return { ok: false, error: 'missing_fields' };
    }
  }
  // trainedBefore is 'yes' | 'no'; trainedDuration is a required free-text follow-up only when 'yes'
  // (how long they trained continuously, with how much commitment) -- left blank otherwise.
  if (body.trainedBefore !== 'yes' && body.trainedBefore !== 'no') {
    return { ok: false, error: 'missing_fields' };
  }
  if (body.trainedBefore === 'yes' && !body.trainedDuration) {
    return { ok: false, error: 'missing_fields' };
  }
  await sql`
    INSERT INTO assessments
      (client_id, full_name, job, age, height_cm, weight_kg, medical_history, goal,
       training_days, supplements, favorite_foods, disliked_foods, steps_per_day,
       meals_per_day, sleep_hours, trained_before, trained_duration, stress_level)
    VALUES
      (${clientId}, ${body.fullName}, ${body.job}, ${body.age}, ${body.heightCm},
       ${body.weightKg}, ${body.medicalHistory}, ${body.goal}, ${body.trainingDays},
       ${body.supplements}, ${body.favoriteFoods}, ${body.dislikedFoods}, ${body.stepsPerDay},
       ${body.mealsPerDay}, ${body.sleepHours}, ${body.trainedBefore}, ${body.trainedDuration || ''}, ${body.stressLevel})
  `;
  return { ok: true };
}

async function getClientAssessment(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const rows = await sql`
    SELECT full_name AS "fullName", job, age, height_cm AS "heightCm", weight_kg AS "weightKg",
           medical_history AS "medicalHistory", goal, training_days AS "trainingDays",
           supplements, favorite_foods AS "favoriteFoods", disliked_foods AS "dislikedFoods",
           steps_per_day AS "stepsPerDay", meals_per_day AS "mealsPerDay", sleep_hours AS "sleepHours",
           trained_before AS "trainedBefore", trained_duration AS "trainedDuration",
           stress_level AS "stressLevel", submitted_at AS "submittedAt"
    FROM assessments WHERE client_id = ${clientId} ORDER BY id DESC LIMIT 1
  `;
  if (!rows.length) return { ok: true, exists: false };
  return { ok: true, exists: true, ...rows[0] };
}

// ---------- Weekly check-in ----------

async function lastCheckinForClient(clientId) {
  const rows = await sql`
    SELECT week_number AS "weekNumber", checkin_date AS "checkinDate",
           weight, sleep_hours AS "sleepHours", energy, diet, stress_level AS "stressLevel",
           steps, problems, notes, week_rating AS "weekRating"
    FROM checkins WHERE client_id = ${clientId} ORDER BY week_number DESC LIMIT 1
  `;
  return rows[0] || null;
}

async function submitCheckin(body) {
  const clientId = body.clientId;
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  if (
    body.weight == null || body.sleepHours == null || body.energy == null ||
    body.diet == null || body.stressLevel == null || body.steps == null || body.weekRating == null
  ) {
    return { ok: false, error: 'missing_fields' };
  }
  const last = await lastCheckinForClient(clientId);
  if (last) {
    const daysSince = (Date.now() - new Date(last.checkinDate).getTime()) / 86400000;
    if (daysSince < MIN_CHECKIN_GAP_DAYS) return { ok: false, error: 'too_soon' };
  }
  const weekNumber = last ? last.weekNumber + 1 : 1;
  const inserted = await sql`
    INSERT INTO checkins
      (client_id, week_number, checkin_date, weight, sleep_hours, energy, diet, stress_level, steps, problems, notes, week_rating)
    VALUES
      (${clientId}, ${weekNumber}, now(), ${body.weight}, ${body.sleepHours}, ${body.energy},
       ${body.diet}, ${body.stressLevel}, ${body.steps}, ${body.problems || ''}, ${body.notes || ''}, ${body.weekRating})
    ON CONFLICT (client_id, week_number) DO NOTHING
    RETURNING id
  `;
  if (!inserted.length) return { ok: false, error: 'already_submitted' };
  return { ok: true, weekNumber };
}

async function getMyCheckin(clientId) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const last = await lastCheckinForClient(clientId);
  if (!last) return { ok: true, exists: false, canSubmit: true, data: null };
  const daysSince = (Date.now() - new Date(last.checkinDate).getTime()) / 86400000;
  const canSubmit = daysSince >= MIN_CHECKIN_GAP_DAYS;
  const nextAvailableDate = addDays(toDateStr(new Date(last.checkinDate)), MIN_CHECKIN_GAP_DAYS);
  return { ok: true, exists: true, canSubmit, nextAvailableDate, data: last };
}

async function listCheckins(pw) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const rows = await sql`
    SELECT c.client_id AS "clientId", cl.name, c.week_number AS "weekNumber", c.weight,
           c.sleep_hours AS "sleepHours", c.energy, c.diet, c.stress_level AS "stressLevel", c.steps, c.problems, c.notes,
           c.week_rating AS "weekRating", c.submitted_at AS "submittedAt"
    FROM checkins c JOIN clients cl ON cl.id = c.client_id
  `;
  return { ok: true, checkins: rows };
}

// ---------- Subscription ----------

async function renewSubscription(pw, clientId, plan) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId || !PLAN_WEEKS[plan]) return { ok: false, error: 'invalid_input' };
  await sql`UPDATE clients SET plan = ${plan}, start_date = ${todayStr()} WHERE id = ${clientId}`;
  return { ok: true };
}

// ---------- Workout weeks (add/remove a month = 4 weeks) ----------

async function addMonth(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const newTotal = c.total_weeks + 4;
  await sql`UPDATE clients SET total_weeks = ${newTotal} WHERE id = ${clientId}`;
  return { ok: true, totalWeeks: newTotal };
}

async function removeMonth(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const newTotal = c.total_weeks - 4;
  if (newTotal < 1) return { ok: false, error: 'cannot_remove_last_weeks' };
  await sql`DELETE FROM workout_logs WHERE client_id = ${clientId} AND week_number > ${newTotal}`;
  await sql`DELETE FROM workout_plan_weeks WHERE client_id = ${clientId} AND week_number > ${newTotal}`;
  await sql`UPDATE clients SET total_weeks = ${newTotal} WHERE id = ${clientId}`;
  return { ok: true, totalWeeks: newTotal };
}

// ---------- Workout plan (structure) + logs (weekly numbers) ----------

// target rep range (repsMin/repsMax) is optional coach guidance shown
// read-only to the client next to Rest Time -- e.g. "8-12 reps" -- not the
// same as the per-set reps the client actually logs each week.
function sanitizeRepBound(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(v, 10);
  return (Number.isFinite(n) && n > 0) ? Math.min(100, n) : null;
}

function sanitizeExercises(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map(e => ({
    name: String((e && e.name) || '').slice(0, 120),
    setsCount: Math.max(1, Math.min(12, parseInt((e && e.setsCount) || 3, 10) || 3)),
    repsMin: sanitizeRepBound(e && e.repsMin),
    repsMax: sanitizeRepBound(e && e.repsMax),
    restTime: String((e && e.restTime) || '').slice(0, 60),
    notes: String((e && e.notes) || '').slice(0, 500),
    videoLink: String((e && e.videoLink) || '').slice(0, 500),
    videoLink2: String((e && e.videoLink2) || '').slice(0, 500), // second video link, for supersets (one row covering two exercises)
  })).filter(e => e.name);
}

function sanitizeWarmupItems(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map(w => ({
    name: String((w && w.name) || '').slice(0, 120),
    sets: String((w && w.sets) || '').slice(0, 20),
    repTime: String((w && w.repTime) || '').slice(0, 60),
    videoLink: String((w && w.videoLink) || '').slice(0, 500),
  })).filter(w => w.name);
}

// warmup is stored as { items: [{name, sets, repTime, videoLink}], notes }, not a bare array --
// notes is one free-text field for the whole warm-up section (coach-authored, shown to the client).
function sanitizeWarmup(raw) {
  const obj = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { items: Array.isArray(raw) ? raw : [], notes: '' };
  return {
    items: sanitizeWarmupItems(obj.items),
    notes: String(obj.notes || '').slice(0, 1000),
  };
}

// cardio is a fixed list the coach fills in once (not logged/edited weekly by
// the client, same convention as warmup) -- each row is {name, time, hrZone}:
// name is the cardio type typed in freely by the coach (e.g. "Running",
// "Cycling"), time is a free-text duration (e.g. "20 min"), hrZone is a
// free-text heart-rate-zone target (e.g. "Zone 2" or "140-150 bpm").
function sanitizeCardio(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map(c => ({
    name: String((c && c.name) || '').slice(0, 120),
    time: String((c && c.time) || '').slice(0, 60),
    hrZone: String((c && c.hrZone) || '').slice(0, 60),
  })).filter(c => c.name);
}

// a workout "day" bundles its own exercises + warm-up + cardio -- the coach
// splits each week's plan into as many days as they want (same free-form
// count/titles convention as diet_plan.days), informed by the client's
// stated trainingDays answer in First Assessment but never auto-linked to it.
function sanitizeWorkoutDay(d) {
  return {
    title: String((d && d.title) || '').slice(0, 60),
    exercises: sanitizeExercises(d && d.exercises),
    warmup: sanitizeWarmup(d && d.warmup),
    cardio: sanitizeCardio(d && d.cardio),
  };
}

function sanitizeWorkoutDays(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 7).map(sanitizeWorkoutDay).filter(d => d.title);
}

function sanitizeMeals(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 20).map(m => ({
    title: String((m && m.title) || '').slice(0, 120),
    content: String((m && m.content) || '').slice(0, 1000),
  })).filter(m => m.title || m.content);
}

function sanitizeDietDays(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 14).map(d => ({
    title: String((d && d.title) || '').slice(0, 60),
    meals: sanitizeMeals(d && d.meals),
  })).filter(d => d.title);
}

// General diet-plan notes -- free text set by the coach, shown to the client
// above their diet days, NOT tied to any one day (e.g. "اشرب 3 لتر مية في اليوم").
function sanitizeDietNotes(notes) {
  return String(notes || '').slice(0, 2000);
}

function sanitizeLogData(data, exercises) {
  const out = [];
  for (let i = 0; i < exercises.length; i++) {
    const setsCount = exercises[i].setsCount;
    const incoming = (data && data[i] && Array.isArray(data[i].sets)) ? data[i].sets : [];
    const sets = [];
    for (let s = 0; s < setsCount; s++) {
      const src = incoming[s] || {};
      sets.push({
        weight: src.weight != null ? String(src.weight).slice(0, 20) : '',
        reps: src.reps != null ? String(src.reps).slice(0, 20) : '',
      });
    }
    const note = (data && data[i] && data[i].note != null) ? String(data[i].note).slice(0, 500) : '';
    out.push({ sets, note });
  }
  return out;
}

async function getWorkoutPlan(clientId) {
  const rows = await sql`SELECT days FROM workout_plan WHERE client_id = ${clientId}`;
  if (!rows.length) return { days: [] };
  return { days: sanitizeWorkoutDays(rows[0].days) };
}

async function saveWorkoutPlan(pw, clientId, days) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const cleanDays = sanitizeWorkoutDays(days);
  await sql`
    INSERT INTO workout_plan (client_id, days, updated_at)
    VALUES (${clientId}, ${JSON.stringify(cleanDays)}::jsonb, now())
    ON CONFLICT (client_id) DO UPDATE SET days = EXCLUDED.days, updated_at = now()
  `;
  return { ok: true, days: cleanDays };
}

// Per-week plan: week 1 IS the base plan (workout_plan). Any other week falls
// back to that same base plan unless the coach has specifically customized it
// (a row in workout_plan_weeks), in which case that override is used instead.
async function getWorkoutPlanForWeek(clientId, weekNumber) {
  const base = await getWorkoutPlan(clientId);
  if (weekNumber === 1) return { ...base, isCustom: false };
  const rows = await sql`SELECT days FROM workout_plan_weeks WHERE client_id = ${clientId} AND week_number = ${weekNumber}`;
  if (!rows.length) return { ...base, isCustom: false };
  return { days: sanitizeWorkoutDays(rows[0].days), isCustom: true };
}

// Builds { 1: {days, isCustom}, 2: {...}, ... } for every week 1..totalWeeks
// in a single pass (one query for all overrides, instead of one query per
// week) -- used by the "load everything at once" endpoints.
async function buildPlansByWeek(clientId, totalWeeks, base) {
  const overrideRows = await sql`SELECT week_number AS "weekNumber", days FROM workout_plan_weeks WHERE client_id = ${clientId}`;
  const overridesByWeek = {};
  overrideRows.forEach(r => {
    overridesByWeek[r.weekNumber] = { days: sanitizeWorkoutDays(r.days), isCustom: true };
  });
  const plansByWeek = {};
  for (let w = 1; w <= totalWeeks; w++) {
    plansByWeek[w] = (w !== 1 && overridesByWeek[w]) ? overridesByWeek[w] : { ...base, isCustom: false };
  }
  return plansByWeek;
}

async function saveWorkoutPlanForWeek(pw, clientId, weekNumber, days) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId || !weekNumber) return { ok: false, error: 'invalid_input' };
  if (weekNumber === 1) {
    const r = await saveWorkoutPlan(pw, clientId, days);
    return r.ok ? { ...r, isCustom: false } : r;
  }
  const cleanDays = sanitizeWorkoutDays(days);
  await sql`
    INSERT INTO workout_plan_weeks (client_id, week_number, days, updated_at)
    VALUES (${clientId}, ${weekNumber}, ${JSON.stringify(cleanDays)}::jsonb, now())
    ON CONFLICT (client_id, week_number) DO UPDATE SET days = EXCLUDED.days, updated_at = now()
  `;
  return { ok: true, days: cleanDays, isCustom: true };
}

// Removes a week's customization so it goes back to inheriting the base (Week 1) plan.
async function resetWorkoutPlanWeek(pw, clientId, weekNumber) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId || !weekNumber || weekNumber === 1) return { ok: false, error: 'invalid_input' };
  await sql`DELETE FROM workout_plan_weeks WHERE client_id = ${clientId} AND week_number = ${weekNumber}`;
  const base = await getWorkoutPlan(clientId);
  return { ok: true, days: base.days, isCustom: false };
}

// ---------- Workout plan templates (reusable, saved independently of any client) ----------

async function listWorkoutTemplates(pw) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const rows = await sql`SELECT id, name, days, created_at AS "createdAt" FROM workout_templates ORDER BY created_at DESC`;
  return {
    ok: true,
    templates: rows.map(r => ({
      id: r.id,
      name: r.name,
      days: sanitizeWorkoutDays(r.days),
      createdAt: r.createdAt,
    })),
  };
}

async function saveWorkoutTemplate(pw, templateId, name, days) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const cleanName = String(name || '').slice(0, 120).trim();
  if (!cleanName) return { ok: false, error: 'name_required' };
  const cleanDays = sanitizeWorkoutDays(days);
  if (templateId) {
    await sql`
      UPDATE workout_templates
      SET name = ${cleanName}, days = ${JSON.stringify(cleanDays)}::jsonb
      WHERE id = ${templateId}
    `;
    return { ok: true, id: templateId, name: cleanName, days: cleanDays };
  }
  const rows = await sql`
    INSERT INTO workout_templates (name, days)
    VALUES (${cleanName}, ${JSON.stringify(cleanDays)}::jsonb)
    RETURNING id
  `;
  return { ok: true, id: rows[0].id, name: cleanName, days: cleanDays };
}

async function deleteWorkoutTemplate(pw, templateId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!templateId) return { ok: false, error: 'invalid_id' };
  await sql`DELETE FROM workout_templates WHERE id = ${templateId}`;
  return { ok: true };
}

// ---------- Warm-up templates (reusable warm-up tables, e.g. "Legs Warmup",
// "Upper Warmup" -- saved independently of any client or day, loaded into
// any training day's Warm Up section) ----------

async function listWarmupTemplates(pw) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const rows = await sql`SELECT id, name, warmup, created_at AS "createdAt" FROM warmup_templates ORDER BY created_at DESC`;
  return {
    ok: true,
    templates: rows.map(r => ({
      id: r.id,
      name: r.name,
      warmup: sanitizeWarmup(r.warmup),
      createdAt: r.createdAt,
    })),
  };
}

async function saveWarmupTemplate(pw, templateId, name, warmup) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const cleanName = String(name || '').slice(0, 120).trim();
  if (!cleanName) return { ok: false, error: 'name_required' };
  const cleanWarmup = sanitizeWarmup(warmup);
  if (templateId) {
    await sql`
      UPDATE warmup_templates
      SET name = ${cleanName}, warmup = ${JSON.stringify(cleanWarmup)}::jsonb
      WHERE id = ${templateId}
    `;
    return { ok: true, id: templateId, name: cleanName, warmup: cleanWarmup };
  }
  const rows = await sql`
    INSERT INTO warmup_templates (name, warmup)
    VALUES (${cleanName}, ${JSON.stringify(cleanWarmup)}::jsonb)
    RETURNING id
  `;
  return { ok: true, id: rows[0].id, name: cleanName, warmup: cleanWarmup };
}

async function deleteWarmupTemplate(pw, templateId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!templateId) return { ok: false, error: 'invalid_id' };
  await sql`DELETE FROM warmup_templates WHERE id = ${templateId}`;
  return { ok: true };
}

// Returns a full week: every day in that week's plan, each with its own
// exercises/warmup/cardio PLUS that day's logged data ("data", parallel to
// that day's exercises) -- one round trip gives the whole week, since a
// client/coach viewing a week typically flips between its few days.
async function getWorkoutWeek(clientId, weekNumber) {
  const plan = await getWorkoutPlanForWeek(clientId, weekNumber);
  const logRows = await sql`SELECT day_index AS "dayIndex", data FROM workout_logs WHERE client_id = ${clientId} AND week_number = ${weekNumber}`;
  const logsByDay = {};
  logRows.forEach(r => { logsByDay[r.dayIndex] = r.data; });
  const days = plan.days.map((day, i) => ({
    title: day.title,
    exercises: day.exercises,
    warmup: day.warmup,
    cardio: day.cardio,
    data: sanitizeLogData(logsByDay[i] || [], day.exercises),
  }));
  return { days, isCustom: plan.isCustom };
}

async function getWorkoutWeekAdmin(pw, clientId, weekNumber) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const result = await getWorkoutWeek(clientId, weekNumber);
  return { ok: true, ...result };
}

async function getWorkoutWeekClient(clientId, weekNumber) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const result = await getWorkoutWeek(clientId, weekNumber);
  return { ok: true, ...result };
}

async function writeWorkoutLog(clientId, weekNumber, dayIndex, data) {
  const plan = await getWorkoutPlanForWeek(clientId, weekNumber);
  const day = plan.days[dayIndex];
  const clean = sanitizeLogData(data, day ? day.exercises : []);
  await sql`
    INSERT INTO workout_logs (client_id, week_number, day_index, data, updated_at)
    VALUES (${clientId}, ${weekNumber}, ${dayIndex}, ${JSON.stringify(clean)}::jsonb, now())
    ON CONFLICT (client_id, week_number, day_index) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
  return clean;
}

async function saveWorkoutLog(pw, clientId, weekNumber, dayIndex, data) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId || !weekNumber || dayIndex == null) return { ok: false, error: 'invalid_input' };
  const clean = await writeWorkoutLog(clientId, weekNumber, dayIndex, data);
  return { ok: true, data: clean };
}

async function logWorkout(clientId, weekNumber, dayIndex, data) {
  if (!clientId || !weekNumber || dayIndex == null) return { ok: false, error: 'invalid_input' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  // mirror the client-side week lock: a client can only log week N once they've
  // submitted (N-1) weekly check-ins. Enforced here too so the lock can't be
  // bypassed by calling the API directly. The coach (saveWorkoutLog, password-gated)
  // is never subject to this -- they can always edit any week.
  const checkinCountRows = await sql`SELECT COUNT(*)::int AS count FROM checkins WHERE client_id = ${clientId}`;
  const checkinsCount = checkinCountRows[0] ? checkinCountRows[0].count : 0;
  if (weekNumber > checkinsCount + 1) return { ok: false, error: 'week_locked' };
  const clean = await writeWorkoutLog(clientId, weekNumber, dayIndex, data);
  return { ok: true, data: clean };
}

// logsByWeek[weekNumber][dayIndex] = array of {sets, note} parallel to
// plansByWeek[weekNumber].days[dayIndex].exercises.
async function buildLogsByWeek(clientId, plansByWeek) {
  const rows = await sql`SELECT week_number AS "weekNumber", day_index AS "dayIndex", data FROM workout_logs WHERE client_id = ${clientId}`;
  const logsByWeek = {};
  rows.forEach(r => {
    const weekPlan = plansByWeek[r.weekNumber];
    const day = weekPlan && weekPlan.days[r.dayIndex];
    if (!logsByWeek[r.weekNumber]) logsByWeek[r.weekNumber] = {};
    logsByWeek[r.weekNumber][r.dayIndex] = sanitizeLogData(r.data, day ? day.exercises : []);
  });
  return logsByWeek;
}

async function getMyWorkoutAll(clientId) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const plan = await getWorkoutPlan(clientId);
  const plansByWeek = await buildPlansByWeek(clientId, c.total_weeks, plan);
  const logsByWeek = await buildLogsByWeek(clientId, plansByWeek);
  const checkinCountRows = await sql`SELECT COUNT(*)::int AS count FROM checkins WHERE client_id = ${clientId}`;
  const checkinsCount = checkinCountRows[0] ? checkinCountRows[0].count : 0;
  return { ok: true, days: plan.days, plansByWeek, totalWeeks: c.total_weeks, logsByWeek, checkinsCount };
}

async function getClientWorkoutAll(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const plan = await getWorkoutPlan(clientId);
  const plansByWeek = await buildPlansByWeek(clientId, c.total_weeks, plan);
  const logsByWeek = await buildLogsByWeek(clientId, plansByWeek);
  return { ok: true, days: plan.days, plansByWeek, totalWeeks: c.total_weeks, logsByWeek };
}

// ---------- Diet plan (fixed, split into days) ----------

async function getDietPlan(clientId) {
  const rows = await sql`SELECT days, notes FROM diet_plan WHERE client_id = ${clientId}`;
  return rows.length ? { days: sanitizeDietDays(rows[0].days), notes: sanitizeDietNotes(rows[0].notes) } : { days: [], notes: '' };
}

async function saveDietPlan(pw, clientId, days, notes) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const cleanDays = sanitizeDietDays(days);
  const cleanNotes = sanitizeDietNotes(notes);
  await sql`
    INSERT INTO diet_plan (client_id, days, notes, updated_at)
    VALUES (${clientId}, ${JSON.stringify(cleanDays)}::jsonb, ${cleanNotes}, now())
    ON CONFLICT (client_id) DO UPDATE SET days = EXCLUDED.days, notes = EXCLUDED.notes, updated_at = now()
  `;
  return { ok: true, days: cleanDays, notes: cleanNotes };
}

async function getClientDietPlan(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const plan = await getDietPlan(clientId);
  return { ok: true, days: plan.days, notes: plan.notes };
}

async function getMyDietPlan(clientId) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const plan = await getDietPlan(clientId);
  return { ok: true, days: plan.days, notes: plan.notes };
}

// ---------- Router ----------

module.exports = async (req, res) => {
  try {
    const body = req.body || {};
    let out;
    switch (body.action) {
      case 'adminLogin':
        out = { ok: checkPassword(body.password) };
        break;
      case 'clientLogin':
        out = await clientLogin(body.loginId);
        break;
      case 'addClient':
        out = await addClient(body.password, body.name, body.phone, body.plan, body.driveLink);
        break;
      case 'updateClient':
        out = await updateClient(body.password, body.clientId, body);
        break;
      case 'deleteClient':
        out = await deleteClient(body.password, body.clientId);
        break;
      case 'listClients':
        out = await listClients(body.password);
        break;
      case 'getClientDetail':
        out = await getClientDetail(body.password, body.clientId);
        break;
      case 'getClientPortal':
        out = await getClientPortal(body.clientId);
        break;
      case 'submitAssessment':
        out = await submitAssessment(body);
        break;
      case 'getClientAssessment':
        out = await getClientAssessment(body.password, body.clientId);
        break;
      case 'submitCheckin':
        out = await submitCheckin(body);
        break;
      case 'getMyCheckin':
        out = await getMyCheckin(body.clientId);
        break;
      case 'listCheckins':
        out = await listCheckins(body.password);
        break;
      case 'renewSubscription':
        out = await renewSubscription(body.password, body.clientId, body.plan);
        break;
      case 'addMonth':
        out = await addMonth(body.password, body.clientId);
        break;
      case 'removeMonth':
        out = await removeMonth(body.password, body.clientId);
        break;
      case 'saveWorkoutPlan':
        out = await saveWorkoutPlan(body.password, body.clientId, body.days);
        break;
      case 'saveWorkoutPlanForWeek':
        out = await saveWorkoutPlanForWeek(body.password, body.clientId, body.weekNumber, body.days);
        break;
      case 'resetWorkoutPlanWeek':
        out = await resetWorkoutPlanWeek(body.password, body.clientId, body.weekNumber);
        break;
      case 'listWorkoutTemplates':
        out = await listWorkoutTemplates(body.password);
        break;
      case 'saveWorkoutTemplate':
        out = await saveWorkoutTemplate(body.password, body.templateId, body.name, body.days);
        break;
      case 'deleteWorkoutTemplate':
        out = await deleteWorkoutTemplate(body.password, body.templateId);
        break;
      case 'listWarmupTemplates':
        out = await listWarmupTemplates(body.password);
        break;
      case 'saveWarmupTemplate':
        out = await saveWarmupTemplate(body.password, body.templateId, body.name, body.warmup);
        break;
      case 'deleteWarmupTemplate':
        out = await deleteWarmupTemplate(body.password, body.templateId);
        break;
      case 'getWorkoutWeekAdmin':
        out = await getWorkoutWeekAdmin(body.password, body.clientId, body.weekNumber);
        break;
      case 'getWorkoutWeekClient':
        out = await getWorkoutWeekClient(body.clientId, body.weekNumber);
        break;
      case 'saveWorkoutLog':
        out = await saveWorkoutLog(body.password, body.clientId, body.weekNumber, body.dayIndex, body.data);
        break;
      case 'logWorkout':
        out = await logWorkout(body.clientId, body.weekNumber, body.dayIndex, body.data);
        break;
      case 'getClientWorkoutAll':
        out = await getClientWorkoutAll(body.password, body.clientId);
        break;
      case 'getMyWorkoutAll':
        out = await getMyWorkoutAll(body.clientId);
        break;
      case 'saveDietPlan':
        out = await saveDietPlan(body.password, body.clientId, body.days, body.notes);
        break;
      case 'getClientDietPlan':
        out = await getClientDietPlan(body.password, body.clientId);
        break;
      case 'getMyDietPlan':
        out = await getMyDietPlan(body.clientId);
        break;
      default:
        out = { ok: false, error: 'unknown_action' };
    }
    res.status(200).json(out);
  } catch (err) {
    res.status(200).json({ ok: false, error: String((err && err.message) || err) });
  }
};
