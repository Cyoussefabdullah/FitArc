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

function currentWeekId() {
  const now = new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return date.getUTCFullYear() + '-W' + (weekNo < 10 ? '0' + weekNo : weekNo);
}

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
  const weekId = currentWeekId();
  await sql`
    INSERT INTO checkins
      (client_id, week_id, checkin_date, weight, sleep_hours, energy, diet, stress_level, steps, problems, notes, week_rating)
    VALUES
      (${clientId}, ${weekId}, now(), ${body.weight}, ${body.sleepHours}, ${body.energy},
       ${body.diet}, ${body.stressLevel}, ${body.steps}, ${body.problems || ''}, ${body.notes || ''}, ${body.weekRating})
    ON CONFLICT (client_id, week_id) DO UPDATE SET
      weight = EXCLUDED.weight, sleep_hours = EXCLUDED.sleep_hours, energy = EXCLUDED.energy,
      diet = EXCLUDED.diet, stress_level = EXCLUDED.stress_level, steps = EXCLUDED.steps, problems = EXCLUDED.problems,
      notes = EXCLUDED.notes, week_rating = EXCLUDED.week_rating, submitted_at = now()
  `;
  return { ok: true, weekId };
}

async function getMyCheckin(clientId) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const weekId = currentWeekId();
  const rows = await sql`
    SELECT weight, sleep_hours AS "sleepHours", energy, diet, stress_level AS "stressLevel", steps, problems, notes, week_rating AS "weekRating"
    FROM checkins WHERE client_id = ${clientId} AND week_id = ${weekId}
  `;
  return { ok: true, exists: rows.length > 0, weekId, data: rows[0] || null };
}

async function listCheckins(pw) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const rows = await sql`
    SELECT c.client_id AS "clientId", cl.name, c.week_id AS "weekId", c.weight,
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
  await sql`UPDATE clients SET total_weeks = ${newTotal} WHERE id = ${clientId}`;
  return { ok: true, totalWeeks: newTotal };
}

// ---------- Workout plan (structure) + logs (weekly numbers) ----------

function sanitizeExercises(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map(e => ({
    name: String((e && e.name) || '').slice(0, 120),
    setsCount: Math.max(1, Math.min(12, parseInt((e && e.setsCount) || 3, 10) || 3)),
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
  const rows = await sql`SELECT exercises, warmup, cardio FROM workout_plan WHERE client_id = ${clientId}`;
  if (!rows.length) return { exercises: [], warmup: { items: [], notes: '' }, cardio: [] };
  return { exercises: sanitizeExercises(rows[0].exercises), warmup: sanitizeWarmup(rows[0].warmup), cardio: sanitizeCardio(rows[0].cardio) };
}

async function saveWorkoutPlan(pw, clientId, exercises, warmup, cardio) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const cleanExercises = sanitizeExercises(exercises);
  const cleanWarmup = sanitizeWarmup(warmup);
  const cleanCardio = sanitizeCardio(cardio);
  await sql`
    INSERT INTO workout_plan (client_id, exercises, warmup, cardio, updated_at)
    VALUES (${clientId}, ${JSON.stringify(cleanExercises)}::jsonb, ${JSON.stringify(cleanWarmup)}::jsonb, ${JSON.stringify(cleanCardio)}::jsonb, now())
    ON CONFLICT (client_id) DO UPDATE SET exercises = EXCLUDED.exercises, warmup = EXCLUDED.warmup, cardio = EXCLUDED.cardio, updated_at = now()
  `;
  return { ok: true, exercises: cleanExercises, warmup: cleanWarmup, cardio: cleanCardio };
}

// ---------- Workout plan templates (reusable, saved independently of any client) ----------

async function listWorkoutTemplates(pw) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const rows = await sql`SELECT id, name, exercises, warmup, cardio, created_at AS "createdAt" FROM workout_templates ORDER BY created_at DESC`;
  return {
    ok: true,
    templates: rows.map(r => ({
      id: r.id,
      name: r.name,
      exercises: sanitizeExercises(r.exercises),
      warmup: sanitizeWarmup(r.warmup),
      cardio: sanitizeCardio(r.cardio),
      createdAt: r.createdAt,
    })),
  };
}

async function saveWorkoutTemplate(pw, templateId, name, exercises, warmup, cardio) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const cleanName = String(name || '').slice(0, 120).trim();
  if (!cleanName) return { ok: false, error: 'name_required' };
  const cleanExercises = sanitizeExercises(exercises);
  const cleanWarmup = sanitizeWarmup(warmup);
  const cleanCardio = sanitizeCardio(cardio);
  if (templateId) {
    await sql`
      UPDATE workout_templates
      SET name = ${cleanName}, exercises = ${JSON.stringify(cleanExercises)}::jsonb, warmup = ${JSON.stringify(cleanWarmup)}::jsonb, cardio = ${JSON.stringify(cleanCardio)}::jsonb
      WHERE id = ${templateId}
    `;
    return { ok: true, id: templateId, name: cleanName, exercises: cleanExercises, warmup: cleanWarmup, cardio: cleanCardio };
  }
  const rows = await sql`
    INSERT INTO workout_templates (name, exercises, warmup, cardio)
    VALUES (${cleanName}, ${JSON.stringify(cleanExercises)}::jsonb, ${JSON.stringify(cleanWarmup)}::jsonb, ${JSON.stringify(cleanCardio)}::jsonb)
    RETURNING id
  `;
  return { ok: true, id: rows[0].id, name: cleanName, exercises: cleanExercises, warmup: cleanWarmup, cardio: cleanCardio };
}

async function deleteWorkoutTemplate(pw, templateId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!templateId) return { ok: false, error: 'invalid_id' };
  await sql`DELETE FROM workout_templates WHERE id = ${templateId}`;
  return { ok: true };
}

async function getWorkoutWeek(clientId, weekNumber) {
  const plan = await getWorkoutPlan(clientId);
  const rows = await sql`SELECT data FROM workout_logs WHERE client_id = ${clientId} AND week_number = ${weekNumber}`;
  const data = sanitizeLogData(rows.length ? rows[0].data : [], plan.exercises);
  return { exercises: plan.exercises, warmup: plan.warmup, cardio: plan.cardio, data };
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

async function writeWorkoutLog(clientId, weekNumber, data) {
  const plan = await getWorkoutPlan(clientId);
  const clean = sanitizeLogData(data, plan.exercises);
  await sql`
    INSERT INTO workout_logs (client_id, week_number, data, updated_at)
    VALUES (${clientId}, ${weekNumber}, ${JSON.stringify(clean)}::jsonb, now())
    ON CONFLICT (client_id, week_number) DO UPDATE SET data = EXCLUDED.data, updated_at = now()
  `;
  return clean;
}

async function saveWorkoutLog(pw, clientId, weekNumber, data) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId || !weekNumber) return { ok: false, error: 'invalid_input' };
  const clean = await writeWorkoutLog(clientId, weekNumber, data);
  return { ok: true, data: clean };
}

async function logWorkout(clientId, weekNumber, data) {
  if (!clientId || !weekNumber) return { ok: false, error: 'invalid_input' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  // mirror the client-side week lock: a client can only log week N once they've
  // submitted (N-1) weekly check-ins. Enforced here too so the lock can't be
  // bypassed by calling the API directly. The coach (saveWorkoutLog, password-gated)
  // is never subject to this -- they can always edit any week.
  const checkinCountRows = await sql`SELECT COUNT(*)::int AS count FROM checkins WHERE client_id = ${clientId}`;
  const checkinsCount = checkinCountRows[0] ? checkinCountRows[0].count : 0;
  if (weekNumber > checkinsCount + 1) return { ok: false, error: 'week_locked' };
  const clean = await writeWorkoutLog(clientId, weekNumber, data);
  return { ok: true, data: clean };
}

async function getMyWorkoutAll(clientId) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const plan = await getWorkoutPlan(clientId);
  const rows = await sql`SELECT week_number AS "weekNumber", data FROM workout_logs WHERE client_id = ${clientId}`;
  const logsByWeek = {};
  rows.forEach(r => { logsByWeek[r.weekNumber] = sanitizeLogData(r.data, plan.exercises); });
  const checkinCountRows = await sql`SELECT COUNT(*)::int AS count FROM checkins WHERE client_id = ${clientId}`;
  const checkinsCount = checkinCountRows[0] ? checkinCountRows[0].count : 0;
  return { ok: true, exercises: plan.exercises, warmup: plan.warmup, cardio: plan.cardio, totalWeeks: c.total_weeks, logsByWeek, checkinsCount };
}

async function getClientWorkoutAll(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const plan = await getWorkoutPlan(clientId);
  const rows = await sql`SELECT week_number AS "weekNumber", data FROM workout_logs WHERE client_id = ${clientId}`;
  const logsByWeek = {};
  rows.forEach(r => { logsByWeek[r.weekNumber] = sanitizeLogData(r.data, plan.exercises); });
  return { ok: true, exercises: plan.exercises, warmup: plan.warmup, cardio: plan.cardio, totalWeeks: c.total_weeks, logsByWeek };
}

// ---------- Diet plan (fixed, split into days) ----------

async function getDietPlan(clientId) {
  const rows = await sql`SELECT days FROM diet_plan WHERE client_id = ${clientId}`;
  return rows.length ? sanitizeDietDays(rows[0].days) : [];
}

async function saveDietPlan(pw, clientId, days) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const clean = sanitizeDietDays(days);
  await sql`
    INSERT INTO diet_plan (client_id, days, updated_at)
    VALUES (${clientId}, ${JSON.stringify(clean)}::jsonb, now())
    ON CONFLICT (client_id) DO UPDATE SET days = EXCLUDED.days, updated_at = now()
  `;
  return { ok: true, days: clean };
}

async function getClientDietPlan(pw, clientId) {
  if (!checkPassword(pw)) return { ok: false, error: 'unauthorized' };
  const days = await getDietPlan(clientId);
  return { ok: true, days };
}

async function getMyDietPlan(clientId) {
  if (!clientId) return { ok: false, error: 'invalid_id' };
  const c = await getClientRow(clientId);
  if (!c) return { ok: false, error: 'invalid_id' };
  const days = await getDietPlan(clientId);
  return { ok: true, days };
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
        out = await saveWorkoutPlan(body.password, body.clientId, body.exercises, body.warmup, body.cardio);
        break;
      case 'listWorkoutTemplates':
        out = await listWorkoutTemplates(body.password);
        break;
      case 'saveWorkoutTemplate':
        out = await saveWorkoutTemplate(body.password, body.templateId, body.name, body.exercises, body.warmup, body.cardio);
        break;
      case 'deleteWorkoutTemplate':
        out = await deleteWorkoutTemplate(body.password, body.templateId);
        break;
      case 'getWorkoutWeekAdmin':
        out = await getWorkoutWeekAdmin(body.password, body.clientId, body.weekNumber);
        break;
      case 'getWorkoutWeekClient':
        out = await getWorkoutWeekClient(body.clientId, body.weekNumber);
        break;
      case 'saveWorkoutLog':
        out = await saveWorkoutLog(body.password, body.clientId, body.weekNumber, body.data);
        break;
      case 'logWorkout':
        out = await logWorkout(body.clientId, body.weekNumber, body.data);
        break;
      case 'getClientWorkoutAll':
        out = await getClientWorkoutAll(body.password, body.clientId);
        break;
      case 'getMyWorkoutAll':
        out = await getMyWorkoutAll(body.clientId);
        break;
      case 'saveDietPlan':
        out = await saveDietPlan(body.password, body.clientId, body.days);
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
