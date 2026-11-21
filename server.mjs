import { createServer } from "node:http";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodemailer from "nodemailer";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT ?? 4173);
const now = () => new Date().toISOString();
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const createUserState = (user) => ({
  patient: { id: user.id, name: user.name, clinicalMode: false },
  template: "Post-Op Joint Rehab",
  baseline: null,
  scans: [],
  queue: [],
  messages: [],
  roster: [],
  scanSession: { active: false, startedAt: null, stoppedAt: null, completedRegions: [] }
});
const users = new Map();
const sessions = new Map();
const userStates = new Map();
const siteMessages = [];
const userStorePath = join(process.cwd(), ".biovision-users.json");
const stateStorePath = join(process.cwd(), ".biovision-state.json");
let savedStates = {};
if (existsSync(stateStorePath)) {
  try {
    savedStates = JSON.parse(readFileSync(stateStorePath, "utf8"));
  } catch (error) {
    console.error("Could not load local workspace state:", error.message);
  }
}
if (existsSync(userStorePath)) {
  try {
    for (const user of JSON.parse(readFileSync(userStorePath, "utf8"))) users.set(user.email, user);
  } catch (error) {
    console.error("Could not load local user store:", error.message);
  }
}
const smtpPassword = (process.env.SMTP_PASSWORD ?? "").replace(/\s/g, "");
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: process.env.SMTP_USER && smtpPassword ? {
    user: process.env.SMTP_USER,
    pass: smtpPassword
  } : undefined
});
const smtpConfigured = Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.SMTP_USER && smtpPassword);

const templates = [
  "Workout Muscle Gains",
  "Post-Op Joint Rehab",
  "Sprains",
  "Posture Alignment",
  "Skin Rash Evolution"
];

function baselineAgeDays(userState) {
  return userState.baseline ? Math.max(0, (Date.now() - Date.parse(userState.baseline.capturedAt)) / 86_400_000) : null;
}

function createScan(userState, volume = 106) {
  const baseline = userState.baseline;
  if (!baseline) throw new Error("A baseline is required before scanning");
  const scan = {
    id: `scan-${userState.scans.length + 1}`,
    capturedAt: now(),
    template: userState.template,
    bodyRegion: "Left knee",
    volumeCm3: volume,
    volumeDifferentialCm3: volume - baseline.volumeCm3,
    swellingPercent: ((volume - baseline.volumeCm3) / baseline.volumeCm3) * 100,
    rom: Math.max(0, Math.min(180, baseline.rom - 8 + Math.round(Math.random() * 6))),
    surfaceAreaCm2: 220 + Math.round(Math.random() * 8),
    perimeterCm: 48 + Math.round(Math.random() * 3),
    joints: { flexion: 108, extension: 4, velocity: 12 },
    color: { redYellowRatio: Number((1.1 + Math.random() * 0.3).toFixed(2)), boundaryShift: "1.8 cm" }
  };
  userState.scans.unshift(scan);
  userState.queue.push({ kind: "scan-metrics", id: scan.id, createdAt: scan.capturedAt });
  return scan;
}

function fhir(userState) {
  const scan = userState.scans[0];
  if (!scan) return null;
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [{ resource: {
      resourceType: "Observation",
      status: "final",
      code: { text: `BioVision ${scan.bodyRegion} scan` },
      subject: { reference: `Patient/${userState.patient.id}` },
      effectiveDateTime: scan.capturedAt,
      component: [
        { code: { text: "Volume" }, valueQuantity: { value: scan.volumeCm3, unit: "cm3" } },
        { code: { text: "Volume differential" }, valueQuantity: { value: scan.volumeDifferentialCm3, unit: "cm3" } },
        { code: { text: "Range of motion" }, valueQuantity: { value: scan.rom, unit: "degree" } }
      ]
    }}]
  };
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`;
}

function persistUsers() {
  try {
    writeFileSync(userStorePath, JSON.stringify([...users.values()], null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("Could not persist local users:", error.message);
  }
}

function persistState(user) {
  const states = Object.fromEntries([...userStates.entries()]);
  states[user.id] = userStates.get(user.id);
  try {
    writeFileSync(stateStorePath, JSON.stringify(states, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("Could not persist local workspace state:", error.message);
  }
}

function verifyPassword(password, stored) {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 32);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

function cookies(request) {
  return Object.fromEntries((request.headers.cookie ?? "").split(";").filter(Boolean).map((part) => {
    const [key, ...value] = part.trim().split("=");
    return [key, decodeURIComponent(value.join("="))];
  }));
}

function authenticatedUser(request) {
  const sessionId = cookies(request).session;
  const userId = sessionId ? sessions.get(sessionId) : undefined;
  return userId ? [...users.values()].find((user) => user.id === userId) : undefined;
}

function userState(user) {
  let value = userStates.get(user.id);
  if (!value) {
    value = savedStates[user.id] ? {
      ...createUserState(user),
      ...savedStates[user.id],
      patient: { ...createUserState(user).patient, ...savedStates[user.id].patient }
    } : createUserState(user);
    userStates.set(user.id, value);
  }
  return value;
}

function code() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendEmailCode(email, subject, value) {
  if (!smtpConfigured) throw new Error("SMTP_HOST, SMTP_FROM, SMTP_USER, and SMTP_PASSWORD must be configured before email can be sent");
  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    subject,
    text: `Your BioVision verification code is ${value}. It expires in 10 minutes.`
  });
}

function summarizeSubject(kind, message) {
  const text = message.toLowerCase();
  if (/\b(password|login|log in|sign in|account|verification|2fa)\b/.test(text)) return "BioVision: Account access issue";
  if (/\b(scan|camera|ar|baseline|body map|measurement)\b/.test(text)) return "BioVision: Scan support request";
  if (/\b(crash|bug|broken|error|not working|issue)\b/.test(text)) return "BioVision: Technical issue";
  if (/\b(partnership|hospital|clinic|provider|integration)\b/.test(text)) return "BioVision: Partnership inquiry";
  if (/\b(billing|payment|invoice|charge)\b/.test(text)) return "BioVision: Billing question";
  if (kind === "feedback") return "BioVision: Product feedback";
  if (kind === "support") return "BioVision: Support request";
  return "BioVision: General inquiry";
}

async function forwardSiteMessage(kind, email, message) {
  if (!smtpConfigured) {
    throw new Error("SMTP_HOST, SMTP_FROM, SMTP_USER, and SMTP_PASSWORD must be configured before requests can be forwarded");
  }
  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: process.env.SUPPORT_TO || process.env.SMTP_USER,
    replyTo: email,
    subject: summarizeSubject(kind, message),
    text: `${kind} request received from ${email}:\n\n${message}`
  });
}

async function sendProgressReport(email, user, state) {
  if (!smtpConfigured || !process.env.SMTP_USER) {
    throw new Error("Email delivery is not configured");
  }
  const latest = state.scans[0];
  const baseline = state.baseline;
  const report = [
    `BioVision progress report for ${user.name}`,
    "",
    `Baseline: ${baseline ? `Active since ${baseline.capturedAt}` : "Not created"}`,
    `Scans completed: ${state.scans.length}`,
    latest ? [
      "",
      `Latest scan: ${latest.capturedAt}`,
      `Template: ${latest.template}`,
      `Body region: ${latest.bodyRegion}`,
      `Volume change: ${latest.volumeDifferentialCm3.toFixed(1)} cm³ (${latest.swellingPercent.toFixed(1)}%)`,
      `Range of motion: ${latest.rom}°`
    ].join("\n") : "Latest scan: No scan completed yet",
    "",
    "This report is for progress tracking and discussion with a qualified professional. It is not a diagnosis."
  ].join("\n");
  await mailer.sendMail({
    from: process.env.SMTP_FROM,
    to: email,
    replyTo: process.env.SMTP_USER,
    subject: "BioVision: Progress report",
    text: report
  });
}

function challenge(user, purpose) {
  const value = code();
  user[`${purpose}CodeHash`] = hashPassword(value);
  user[`${purpose}CodeExpiresAt`] = Date.now() + 10 * 60 * 1000;
  return value;
}

function validChallenge(user, purpose, value) {
  const hash = user[`${purpose}CodeHash`];
  const expiresAt = user[`${purpose}CodeExpiresAt`];
  return Boolean(hash && expiresAt && Date.now() < expiresAt && verifyPassword(value, hash));
}

function isMobilePhoneRequest(request) {
  const userAgent = request.headers["user-agent"] ?? "";
  return /(?:iPhone|iPod|Android.*Mobile)/i.test(userAgent) && !/iPad|Tablet/i.test(userAgent);
}

function authPage(message = "", next = "/consumer", register = false) {
  const title = register ? "Create your BioVision account" : "Sign in to BioVision";
  const action = register ? "/api/auth/register" : "/api/auth/login";
  const name = register ? '<label>Name<input name="name" required autocomplete="name"></label>' : "";
  const healthProfile = register ? '<p class="section-title">Your health profile</p><p class="hint">These details help personalize your workspace. You can update them later from Account.</p><label>Birthday<input name="birthday" type="date" required></label><label>Phone number<input name="phone" type="tel" autocomplete="tel"></label><div class="two"><label>Height (cm)<input name="heightCm" type="number" min="30" max="300" step="0.1" required></label><label>Weight (kg)<input name="weightKg" type="number" min="2" max="500" step="0.1" required></label></div><label>Health goals<input name="healthGoals" placeholder="For example: improve mobility"></label><label>Relevant health notes<textarea name="healthNotes" placeholder="Optional conditions, injuries, or considerations"></textarea></label>' : "";
  const alternate = register ? '<a href="/login">Already have an account? Sign in</a><br><br><a href="/hospital-interest">Are you a hospital or clinic?</a>' : '<a href="/register">Create an account</a>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BioVision · ${register ? "Create account" : "Sign in"}</title><style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 0%,#13263c,#080d17 55%);color:#e8eef7;font:15px system-ui,sans-serif}.card{width:min(560px,calc(100% - 32px));padding:28px;background:#111d2d;border:1px solid #29445f;border-radius:18px;box-shadow:0 20px 60px #0008}h1{margin:0 0 8px}p{color:#8fa4bd}.dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#38d39f;box-shadow:0 0 14px #38d39f;margin-right:8px}label{display:block;color:#a8bdd5;margin-top:14px}input,textarea,button{width:100%;margin-top:7px;padding:12px;border-radius:9px;border:1px solid #35516d;background:#0d1725;color:#e8eef7;font:inherit}textarea{min-height:76px;resize:vertical}button{background:#2878d6;border-color:#2878d6;cursor:pointer}.section-title{color:#e8eef7;font-weight:700;margin:24px 0 0}.hint{font-size:13px;margin:4px 0}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.error{color:#ff8585;min-height:20px}a{color:#77c7ff}@media(max-width:520px){.two{grid-template-columns:1fr}}</style></head><body><main class="card"><h1><span class="dot"></span>${title}</h1><p>${register ? "Create a private workspace for your fitness or hospital account." : "Access your private fitness or hospital workspace."}</p><form method="post" action="${action}?next=${encodeURIComponent(next)}">${name}<label>Email<input name="email" type="email" required autocomplete="email"></label><label>Password<input name="password" type="password" minlength="8" required autocomplete="${register ? "new-password" : "current-password"}"></label>${healthProfile}<div class="error">${message}</div><button>${register ? "Create account" : "Sign in"}</button></form><p>${alternate}</p>${register ? "" : '<p><a href="/forgot">Forgot password?</a></p>'}</main></body></html>`;
}

function codePage(title, action, fields, message = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BioVision · ${title}</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080d17;color:#e8eef7;font:15px system-ui,sans-serif}.card{width:min(440px,calc(100% - 32px));padding:28px;background:#111d2d;border:1px solid #29445f;border-radius:18px}h1{margin:0 0 8px}p{color:#8fa4bd}label{display:block;margin-top:14px;color:#a8bdd5}input,button{width:100%;margin-top:7px;padding:12px;border-radius:9px;border:1px solid #35516d;background:#0d1725;color:#e8eef7;font:inherit}button{background:#2878d6;border-color:#2878d6}.error{color:#ff8585;min-height:20px}a{color:#77c7ff}</style></head><body><main class="card"><h1>${title}</h1><p>Email delivery is required. Codes expire in 10 minutes.</p><form method="post" action="${action}">${fields}<div class="error">${message}</div><button>Continue</button></form><p><a href="/login">Back to sign in</a></p></main></body></html>`;
}

function hospitalInterestPage(message = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BioVision · Hospital interest</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 0%,#13263c,#080d17 55%);color:#e8eef7;font:15px system-ui,sans-serif}.card{width:min(500px,calc(100% - 32px));padding:30px;background:#111d2d;border:1px solid #29445f;border-radius:20px;box-shadow:0 20px 60px #0008}h1{margin:0 0 8px;letter-spacing:-.03em}p{color:#8fa4bd;line-height:1.55}label{display:block;color:#a8bdd5;margin-top:14px}input,textarea,button{width:100%;margin-top:7px;padding:12px;border-radius:9px;border:1px solid #35516d;background:#0d1725;color:#e8eef7;font:inherit}textarea{min-height:90px;resize:vertical}button{background:#2878d6;border-color:#2878d6;cursor:pointer}.error{color:#ff8585;min-height:20px;margin-top:12px}.success{color:#62e1b0;min-height:20px;margin-top:12px}a{color:#77c7ff}</style></head><body><main class="card"><h1>Bring BioVision to your hospital</h1><p>Tell us who you are and where you work. Our team will review your request and get back to you soon.</p><form method="post" action="/api/hospital-interest"><label>Your name<input name="name" required autocomplete="name"></label><label>Work email<input name="email" type="email" required autocomplete="email"></label><label>Hospital or clinic name<input name="hospital" required autocomplete="organization"></label><label>What would you like to explore?<textarea name="message" placeholder="Optional details"></textarea></label><div class="${message.startsWith("Thanks") ? "success" : "error"}">${message}</div><button>Request hospital access</button></form><p><a href="/">Back to BioVision</a></p></main></body></html>`;
}

function accountPage(user, message = "") {
  const profile = user.profile ?? {};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BioVision · Account</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 20% 0%,#13263c,#080d17 55%);color:#e8eef7;font:15px system-ui,sans-serif}.wrap{width:min(700px,calc(100% - 32px));margin:46px auto}.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:20px}.brand{font-size:20px;font-weight:700}.actions{display:flex;gap:10px;align-items:center}.card{padding:28px;background:#111d2d;border:1px solid #29445f;border-radius:20px;box-shadow:0 20px 60px #0008}h1{margin:0 0 8px;letter-spacing:-.03em}h2{font-size:16px;margin:26px 0 0}p{color:#8fa4bd;line-height:1.55}label{display:block;color:#a8bdd5;margin-top:14px}input,textarea,button{width:100%;margin-top:7px;padding:12px;border-radius:9px;border:1px solid #35516d;background:#0d1725;color:#e8eef7;font:inherit}textarea{min-height:90px;resize:vertical}button{background:#2878d6;border-color:#2878d6;cursor:pointer}.actions button,.actions a{width:auto;margin:0;padding:8px 12px;border-radius:999px;text-decoration:none}.logout{background:#101d2d;color:#e8eef7}.danger{background:#42212a;border-color:#7c3d4b;color:#ffb5bd}.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}.success{color:#62e1b0;min-height:20px;margin-top:14px}.error{color:#ff8585;min-height:20px;margin-top:14px}a{color:#77c7ff}@media(max-width:560px){.two{grid-template-columns:1fr}.top{align-items:flex-start;gap:14px}.actions{flex-wrap:wrap;justify-content:flex-end}}</style></head><body><main class="wrap"><div class="top"><div class="brand">BioVision <span style="color:#8fa4bd;font-size:13px">/ Account</span></div><div class="actions"><a href="/consumer">Back to workspace</a><form method="post" action="/api/auth/logout"><button class="logout">Log out</button></form></div></div><section class="card"><h1>Manage your account</h1><p>Keep your contact details and health profile current for more useful progress tracking.</p><form method="post" action="/api/account"><h2>Contact details</h2><label>Name<input name="name" value="${escapeHtml(user.name)}" required autocomplete="name"></label><label>Email<input name="email" type="email" value="${escapeHtml(user.email)}" required autocomplete="email"></label><label>Phone number<input name="phone" type="tel" value="${escapeHtml(profile.phone)}" autocomplete="tel"></label><h2>Health profile</h2><label>Birthday<input name="birthday" type="date" value="${escapeHtml(profile.birthday)}" required></label><div class="two"><label>Height (cm)<input name="heightCm" type="number" min="30" max="300" step="0.1" value="${escapeHtml(profile.heightCm)}" required></label><label>Weight (kg)<input name="weightKg" type="number" min="2" max="500" step="0.1" value="${escapeHtml(profile.weightKg)}" required></label></div><label>Health goals<input name="healthGoals" value="${escapeHtml(profile.healthGoals)}" placeholder="For example: improve mobility"></label><label>Relevant health notes<textarea name="healthNotes" placeholder="Optional conditions, injuries, or considerations">${escapeHtml(profile.healthNotes)}</textarea></label><div class="${message.startsWith("Saved") ? "success" : "error"}">${escapeHtml(message)}</div><button>Save account details</button></form><h2>Danger zone</h2><p>Deleting your account permanently removes your BioVision account and saved workspace data.</p><button id="deleteAccount" class="danger" type="button">Delete account</button><p id="deleteStatus" class="error"></p></section></main><script>document.getElementById('deleteAccount').onclick=async()=>{if(!confirm('Are you sure you want to permanently delete your account and saved data?'))return;const password=prompt('Enter your password to confirm account deletion:');if(password===null)return;if(!password){document.getElementById('deleteStatus').textContent='Password is required.';return}const button=document.getElementById('deleteAccount');button.disabled=true;try{const response=await fetch('/api/account/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Account deletion failed.');window.location='/';}catch(error){document.getElementById('deleteStatus').textContent=error.message;button.disabled=false}}</script></body></html>`;
}

function landingPage(message = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="BioVision helps people and care teams understand movement and change over time."><title>BioVision · Move with confidence</title><style>
  :root{font:16px system-ui,sans-serif;color:#eaf2ff;background:#070c14}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 75% -10%,#1b4364 0,#070c14 42%);line-height:1.55}.wrap{width:min(1120px,calc(100% - 40px));margin:auto}.nav{height:76px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #20354b}.brand{font-weight:750;font-size:20px;letter-spacing:-.3px}.brand i{display:inline-block;width:10px;height:10px;border-radius:50%;background:#42dda4;box-shadow:0 0 16px #42dda4;margin-right:8px}.navlinks{display:flex;align-items:center;gap:22px}.nav a{color:#a7c1dc;text-decoration:none}.button{display:inline-flex;align-items:center;justify-content:center;border:1px solid #34516e;border-radius:10px;padding:10px 16px;color:#eaf2ff;text-decoration:none;background:#101d2d;font-weight:650}.button.primary{background:#2b7cdb;border-color:#2b7cdb;box-shadow:0 8px 24px #2b7cdb44}.hero{display:grid;grid-template-columns:1.05fr .95fr;gap:72px;align-items:center;padding:86px 0 70px}.eyebrow{color:#62e1b0;text-transform:uppercase;letter-spacing:.14em;font-size:12px;font-weight:750}.hero h1{font-size:clamp(42px,6vw,72px);line-height:1.02;letter-spacing:-.055em;margin:15px 0}.hero p{font-size:19px;color:#a8bdd5;max-width:620px}.actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.visual{min-height:350px;border:1px solid #2c4c69;border-radius:26px;background:radial-gradient(circle at 50% 35%,#275d88,#0d1a2a 64%);display:grid;place-items:center;box-shadow:0 28px 80px #0007,inset 0 0 60px #0006}.visual strong{font-size:130px;color:#5fc2ff;text-shadow:0 0 35px #5fc2ff88}.section{padding:68px 0;border-top:1px solid #1c3045}.section h2{font-size:34px;letter-spacing:-.03em;margin:0 0 12px}.lead{color:#9eb4cc;max-width:700px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:28px}.card{padding:24px;border:1px solid #253e58;border-radius:16px;background:linear-gradient(145deg,#111e2f,#0c1522)}.card h3{margin:0 0 8px}.card p{color:#9eb4cc;margin:0}.form{max-width:620px;display:grid;gap:12px}.form input,.form textarea,.form select{width:100%;padding:12px;border:1px solid #35516d;border-radius:9px;background:#0d1725;color:#eaf2ff;font:inherit}.form textarea{min-height:120px;resize:vertical}.notice{color:#62e1b0;min-height:24px}.footer{padding:30px 0;color:#8298b2;border-top:1px solid #1c3045}.footer .wrap{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap}@media(max-width:800px){.wrap{width:min(100% - 28px,620px)}.nav{height:auto;padding:17px 0;align-items:flex-start;gap:14px}.navlinks{gap:12px;flex-wrap:wrap;justify-content:flex-end}.navlinks a:not(.button){display:none}.hero{grid-template-columns:1fr;gap:34px;padding:58px 0}.visual{min-height:230px}.visual strong{font-size:90px}.cards{grid-template-columns:1fr}.section{padding:48px 0}}
  </style></head><body><header class="nav wrap"><div class="brand"><i></i>BioVision</div><nav class="navlinks"><a href="#why">Why we exist</a><a href="#support">Support</a><a href="#contact">Contact</a><a class="button" href="/login">Sign in</a><a class="button primary" href="/register">Create account</a></nav></header>
  <main><section class="hero wrap"><div><div class="eyebrow">Movement intelligence, made human</div><h1>See progress.<br><span style="color:#61c6ff">Move forward.</span></h1><p>BioVision turns careful movement scans into a clearer picture of change—so people can understand their progress and care teams can act with better context.</p><div class="actions"><a class="button primary" href="/register">Start your workspace</a><a class="button" href="/hospital-interest">For hospitals and clinics</a></div></div><div class="visual" aria-label="Abstract body scan visualization"><strong>◉</strong></div></section>
  <section id="why" class="section"><div class="wrap"><h2>Why BioVision exists</h2><p class="lead">Small changes in mobility, swelling, posture, and skin appearance can be difficult to notice day to day. We built BioVision to make those changes easier to see over time—without asking people to become experts in their own measurements.</p><div class="cards"><article class="card"><h3>For everyday people</h3><p>Build a consistent movement baseline, track fitness goals, and understand trends in a calm, visual way.</p></article><article class="card"><h3>For care teams</h3><p>Give clinicians structured context between visits while keeping the patient experience guided and understandable.</p></article><article class="card"><h3>Designed for trust</h3><p>Raw camera frames stay on the device in the product design. Trends are signals for conversation—not diagnoses.</p></article></div></div></section>
  <section id="support" class="section"><div class="wrap"><h2>Support</h2><p class="lead">Need help with your account, a scan, or a report? Send a request and our team will follow up.</p><form class="form" onsubmit="submitSiteMessage(event,this)"><input type="hidden" name="kind" value="support"><input name="email" type="email" placeholder="Your email for a reply" required><textarea name="message" placeholder="How can we help?" required></textarea><button class="button primary" type="submit">Contact support</button></form></div></section>
  <section id="feedback" class="section"><div class="wrap"><h2>Give feedback</h2><p class="lead">Your feedback helps us make scanning clearer, more accessible, and more useful.</p><form class="form" onsubmit="submitSiteMessage(event,this)"><input type="hidden" name="kind" value="feedback"><input name="email" type="email" placeholder="Your email for a reply" required><textarea name="message" placeholder="What should we improve?" required></textarea><button class="button" type="submit">Send feedback</button></form></div></section>
  <section id="contact" class="section"><div class="wrap"><h2>Contact us</h2><p class="lead">For clinic partnerships, accessibility questions, or general inquiries, send a message.</p><form class="form" onsubmit="submitSiteMessage(event,this)"><input type="hidden" name="kind" value="contact"><input name="email" type="email" placeholder="Your email for a reply" required><textarea name="message" placeholder="Your message" required></textarea><button class="button" type="submit">Send message</button></form><p class="notice">${message}</p></div></section></main>
  <script>async function submitSiteMessage(event,form){event.preventDefault();const button=form.querySelector('button');button.disabled=true;try{const response=await fetch('/api/site-message',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(new FormData(form))});if(!response.ok){const detail=await response.text();throw new Error(detail)}form.reset();alert('Thanks — your request was received. We will get back to you soon.')}catch(error){alert('Message not sent: '+error.message)}finally{button.disabled=false}}</script>
  <footer class="footer"><div class="wrap"><span>© BioVision</span><span>Scanning is available on supported phones only.</span></div></footer></body></html>`;
}

function html(mode) {
  const hospital = mode === "hospital";
  const productLabel = hospital ? "Hospital clinical portal" : "Personal fitness tracker";
  const scanTitle = hospital ? "Guided clinical 3D scan" : "Guided fitness 3D scan";
  const baselineLabel = hospital ? "Refresh 30-day clinical baseline" : "Refresh 30-day body baseline";
  const analyticsTitle = hospital ? "Recovery analytics" : "Fitness progress";
  const rosterTitle = hospital ? "Clinical Pro / provider roster" : "Activity overview";
  const roleDescription = hospital
    ? "Monitor enrolled patients and review swelling and mobility alerts."
    : "Track body composition trends, mobility, workout progress, posture, and skin changes. This is wellness tracking, not a diagnosis.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BioVision · ${productLabel}</title>
<style>
:root{font:15px system-ui,sans-serif;color:#e8eef7;background:#080d17}*{box-sizing:border-box}
body{margin:0;background:radial-gradient(circle at 20% 0%,#13263c 0,#080d17 38%);min-height:100vh}.top{background:#0b1422eF;border-bottom:1px solid #243b55;color:#fff;padding:18px 28px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:2;backdrop-filter:blur(14px)}
.brand{font-size:21px;font-weight:700;letter-spacing:-.3px}.brand:before{content:"";display:inline-block;width:9px;height:9px;border-radius:50%;background:#38d39f;box-shadow:0 0 14px #38d39f;margin:0 9px 2px 0}.mode{background:#1d9a6c;border:0;color:#fff;border-radius:20px;padding:9px 14px;cursor:pointer;box-shadow:0 0 18px #1d9a6c55}
main{max-width:1250px;margin:24px auto;padding:0 20px}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px}
.card{background:linear-gradient(145deg,#111d2d,#0d1725);border:1px solid #233b55;border-radius:16px;padding:18px;box-shadow:0 12px 30px #00000028}
.wide{grid-column:span 8}.side{grid-column:span 4}.full{grid-column:span 12}
h2{font-size:17px;margin:0 0 14px;color:#f4f8ff}h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;margin:18px 0 8px;color:#87a2c2}
button,select,input{font:inherit;border:1px solid #35516d;border-radius:9px;padding:9px 12px;background:#101d2d;color:#e8eef7;cursor:pointer}
button:hover{border-color:#57b8ff;transform:translateY(-1px)}button.primary{background:#2878d6;color:#fff;border-color:#2878d6;box-shadow:0 5px 16px #2878d655}button.danger{background:#3a2027;color:#ffb1b1;border-color:#713942}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.metric{font-size:25px;font-weight:700;color:#fff}.muted{color:#8fa4bd;font-size:13px}
.ok{color:#42dda4}.alert{color:#ff8585}.bar{height:9px;background:#1d3046;border-radius:8px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#2c85e6,#45dfac);box-shadow:0 0 12px #45dfac}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:10px 6px;border-bottom:1px solid #21354a}th{font-size:12px;color:#8298b2}
pre{white-space:pre-wrap;max-height:300px;overflow:auto;background:#070c14;color:#d9e7ff;padding:14px;border-radius:8px;font-size:12px}
.avatar{height:210px;border-radius:12px;background:radial-gradient(circle at 50% 30%,#23466a,#101c2c 60%);display:flex;align-items:center;justify-content:center;color:#59bfff;font-size:74px;box-shadow:inset 0 0 30px #0008}
.camera{width:100%;height:100%;object-fit:cover;border-radius:12px;display:none}.camera.active{display:block}.camera-status{min-height:20px;margin-top:8px}
.scan-progress{margin-top:12px;padding:12px;border:1px solid #29445f;border-radius:10px;background:#0b1523}.regions{display:flex;gap:6px;flex-wrap:wrap}.region{padding:5px 8px;border-radius:999px;background:#17283b;color:#8fa4bd;font-size:12px}.region.done{background:#123d35;color:#5ee8b2}
.web-only{padding:14px;border:1px solid #31597c;background:linear-gradient(135deg,#102b43,#13253a);color:#b9daf5;border-radius:12px;margin-top:12px;line-height:1.55}.eyebrow{color:#5ee8b2;text-transform:uppercase;letter-spacing:.13em;font-size:11px;font-weight:750;margin-bottom:8px}.dashboard-intro{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;margin-bottom:22px}.dashboard-intro h1{font-size:clamp(28px,4vw,42px);line-height:1.05;letter-spacing:-.045em;margin:0 0 8px}.dashboard-intro p{max-width:680px;margin:0}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}.summary .card{padding:16px}.summary .metric{font-size:28px}.account-link{padding:8px 12px;border:1px solid #35516d;border-radius:999px;background:#101d2d;color:#eaf2ff!important;text-decoration:none}@media(max-width:650px){.summary{grid-template-columns:1fr}.dashboard-intro{display:block}}button:disabled{opacity:.45;cursor:not-allowed;transform:none}
@media(max-width:850px){.wide,.side{grid-column:span 12}}
</style></head><body>
<header class="top"><div class="brand">BioVision <span class="muted">/ ${productLabel}</span></div>
<div class="row"><a href="/consumer" style="color:#9ed7ff;text-decoration:none">Fitness</a><a href="${hospital ? "/hospital" : "/hospital-interest"}" style="color:#9ed7ff;text-decoration:none">Hospitals</a><a href="/account" class="account-link">Account</a>${hospital ? '<button id="clinical" class="mode">Enable Clinical Pro</button>' : ""}</div></header>
<main><div class="dashboard-intro"><div><div class="eyebrow">${hospital ? "Clinical workspace" : "Personal workspace"}</div><h1>${hospital ? "A clearer view of patient recovery." : "Your progress, made visible."}</h1><p class="muted">${hospital ? "Review movement trends, baseline changes, and updates in one focused workspace." : "Build your baseline, understand your movement, and keep every milestone in view."}</p></div></div><div class="summary"><section class="card"><div class="metric" id="summaryScans">0</div><div class="muted">${hospital ? "patient scans reviewed" : "scans completed"}</div></section><section class="card"><div class="metric" id="summaryBaseline">—</div><div class="muted">baseline status</div></section><section class="card"><div class="metric" id="summaryTrend">—</div><div class="muted">${hospital ? "care alerts" : "latest change"}</div></section></div><div class="grid">
<section class="card wide"><h2>${scanTitle}</h2><div class="avatar"><video id="camera" class="camera" autoplay playsinline muted></video><span id="cameraFallback">◉</span></div>
<div class="web-only">Scanning is available only on a supported mobile phone. Before starting, BioVision checks camera access, graphics support, AR capability, and depth sensing. Laptops, tablets, and phones without the required sensors are blocked.</div>
<div class="row" style="margin-top:12px"><button id="startCamera">Check phone and start camera</button><button id="stopCamera" disabled>Stop camera</button><button id="captureFrame" disabled>Capture frame</button></div><p id="cameraStatus" class="camera-status muted">Phone and hardware check required.</p>
<h3>Scan template</h3><div class="row"><select id="template"></select><button id="startScan" class="primary" disabled>Start full-body scan</button><button id="stopScan" disabled>Stop &amp; restart</button><button id="baseline" class="danger" disabled>Create 30-day baseline</button></div>
<div class="scan-progress"><div class="row"><b id="scanState">Scan not started</b><span id="scanTimer" class="muted">00:00</span></div><p class="muted">Move slowly for 10–15 minutes. Cover nearly your entire body and hold each angle steady. Stopping cancels this session; you must restart.</p><div class="regions" id="regions"></div><button id="completeScan" class="primary" disabled>Complete scan</button></div>
<label class="muted" style="display:block;margin-top:10px"><input id="helper" type="checkbox"> It is recommended that someone else operate the phone and guide the scan.</label>
<p id="hardwareStatus" class="muted">No phone has been checked yet.</p><p id="lock" class="muted"></p><p class="muted">${roleDescription}</p><p class="muted">A successful browser check confirms device capability signals; clinical-grade accuracy still requires native ARKit/ARCore processing.</p></section>
<section class="card side"><h2>Baseline status</h2><div id="baselineStatus"></div><h3>Clinical alert</h3><div id="alert"></div><h3>Saved updates</h3><div id="queue"></div></section>
<section class="card wide"><h2>${analyticsTitle}</h2><div class="row"><div><div class="metric" id="volume"></div><div class="muted">ΔV from baseline</div></div><div><div class="metric" id="rom"></div><div class="muted">Current ROM</div></div><div><div class="metric" id="redness"></div><div class="muted">Red/yellow ratio</div></div></div>
<h3>Mobility recovery</h3><div class="bar"><i id="romBar"></i></div><h3>Scan timeline</h3><table><thead><tr><th>Time</th><th>Template</th><th>ΔV</th><th>ROM</th><th>Status</th></tr></thead><tbody id="timeline"></tbody></table></section>
<section class="card side"><h2>Interactive body map</h2><div class="avatar">🧍</div><p id="selectedRegion" class="muted">No region selected</p><p>Flexion <b id="flexion"></b> · Extension <b id="extension"></b></p><button id="report">Print progress report</button><button id="fhir">Download care summary</button></section>
<section class="card full"><h2>Injury photo check</h2><p class="muted">Add a well-lit photo of the area. The comparison stays in this browser and provides a change signal only; it is not a diagnosis.</p><div class="row"><input id="photo" type="file" accept="image/*"><button id="comparePhoto" disabled>Compare to baseline</button></div><p id="photoResult" class="muted"></p></section>
<section class="card full"><h2>${rosterTitle}</h2><div id="roster"></div></section>
</div></main>
<script>
const $=id=>document.getElementById(id);const hospitalMode=${hospital ? "true" : "false"};let app;let cameraStream;let scanTimer;let scanStartedAt;let hardwareReady=false;let photoImage;let capturedRegions=[];
const regions=['Head/neck','Chest','Abdomen','Left arm','Right arm','Left leg','Right leg','Back/posture'];
async function startCamera(){const phone=/(?:iPhone|iPod|Android.*Mobile)/i.test(navigator.userAgent)&&!/iPad|Tablet/i.test(navigator.userAgent);if(!phone){$('cameraStatus').textContent='Use a supported mobile phone. Laptops and tablets cannot scan.';return}if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia){$('cameraStatus').textContent='Secure camera access is unavailable in this browser.';return}const webgl2=Boolean(document.createElement('canvas').getContext('webgl2'));if(!webgl2){$('cameraStatus').textContent='This phone does not support the required graphics hardware.';return}$('cameraStatus').textContent='Checking camera and depth hardware…';try{if(!navigator.xr?.isSessionSupported)throw new Error('AR browser support is unavailable');const arSupported=await navigator.xr.isSessionSupported('immersive-ar');if(!arSupported)throw new Error('AR depth support is unavailable');const depthSession=await navigator.xr.requestSession('immersive-ar',{requiredFeatures:['depth-sensing']});await depthSession.end();cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1280},height:{ideal:720}},audio:false});$('camera').srcObject=cameraStream;$('camera').classList.add('active');$('cameraFallback').style.display='none';$('stopCamera').disabled=false;$('captureFrame').disabled=false;$('startScan').disabled=false;hardwareReady=true;$('cameraStatus').textContent='Hardware approved. Camera live — center the body region in the guide.';$('hardwareStatus').textContent='Phone, camera, WebGL2, AR, and depth sensing verified.'}catch(error){hardwareReady=false;$('startScan').disabled=true;$('hardwareStatus').textContent='Hardware check failed.';$('cameraStatus').textContent=error.name==='NotAllowedError'?'Camera or AR permission was denied. Allow access and try again.':'This phone cannot provide the required AR depth capability.'}}
function stopCamera(){if(cameraStream){for(const track of cameraStream.getTracks())track.stop();cameraStream=undefined}$('camera').srcObject=null;$('camera').classList.remove('active');$('cameraFallback').style.display='inline';$('stopCamera').disabled=true;$('captureFrame').disabled=true;$('startScan').disabled=true;$('cameraStatus').textContent='Camera is off until you grant permission.'}
function captureFrame(){const video=$('camera');if(!cameraStream||video.readyState<2){$('cameraStatus').textContent='Start the camera and wait for a live preview first.';return}const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;canvas.getContext('2d').drawImage(video,0,0);if(scanStartedAt&&capturedRegions.length<regions.length){capturedRegions.push(regions[capturedRegions.length]);renderRegions(capturedRegions);$('cameraStatus').textContent='Frame captured locally for '+capturedRegions.at(-1)+'.'}else{$('cameraStatus').textContent='Frame captured locally for scan processing.'}if(scanStartedAt&&capturedRegions.length===regions.length&&elapsed()>=600)$('completeScan').disabled=false}
function renderRegions(done=[]){$('regions').innerHTML=regions.map(region=>'<span class="region '+(done.includes(region)?'done':'')+'">'+(done.includes(region)?'✓ ':'')+region+'</span>').join('')}
function elapsed(){return scanStartedAt?Math.floor((Date.now()-scanStartedAt)/1000):0}
function updateTimer(){const seconds=elapsed();$('scanTimer').textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')}
function startScan(){if(!hardwareReady){$('scanState').textContent='Start camera on a supported phone first.';return}if(!$('helper').checked){$('scanState').textContent='Please acknowledge the recommended helper before starting.';return}stopScan(false);scanStartedAt=Date.now();capturedRegions=[];$('scanState').textContent='Scan active — move slowly';scanTimer=setInterval(updateTimer,1000);$('completeScan').disabled=true;renderRegions([])}
function stopScan(restart=true){if(scanTimer)clearInterval(scanTimer);scanTimer=undefined;if(scanStartedAt){fetch('/api/scan/stop',{method:'POST'}).catch(()=>{});scanStartedAt=undefined}capturedRegions=[];$('scanState').textContent=restart?'Session stopped. Restart required.':'Ready to start';$('completeScan').disabled=true;renderRegions([])}
function completeScan(){if(!scanStartedAt||elapsed()<600||capturedRegions.length<regions.length){$('scanState').textContent='Keep scanning until all regions are covered for at least 10 minutes.';return}fetch('/api/scan',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({template:$('template').value,elapsedSeconds:elapsed(),completedRegions:capturedRegions})}).then(async response=>{if(!response.ok){$('scanState').textContent=(await response.json()).error;return}stopScan(false);get()})}
function comparePhoto(){if(!photoImage)return;const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const context=canvas.getContext('2d');context.drawImage(photoImage,0,0,64,64);const pixels=context.getImageData(0,0,64,64).data;let ratio=0;for(let i=0;i<pixels.length;i+=4)ratio+=pixels[i]/Math.max(1,(pixels[i]+pixels[i+1])/2+pixels[i+2]*.1);ratio/=pixels.length/4;const change=((ratio-1.1)/1.1)*100;$('photoResult').textContent=(change>5?'Change signal above baseline — consider clinical review. ':'No significant change signal detected. ')+'Photo comparison: '+change.toFixed(1)+'%. This is not a diagnosis.'}
function comparePhoto(){if(!photoImage)return;const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const context=canvas.getContext('2d');context.drawImage(photoImage,0,0,64,64);const pixels=context.getImageData(0,0,64,64).data;let ratio=0;for(let i=0;i<pixels.length;i+=4)ratio+=pixels[i]/Math.max(1,(pixels[i]+pixels[i+1])/2+pixels[i+2]*.1);ratio/=pixels.length/4;const change=((ratio-1.1)/1.1)*100;$('photoResult').textContent=(change>5?'Change signal above baseline — consider clinical review. ':'No significant change signal detected. ')+'Photo comparison: '+change.toFixed(1)+'%. This is not a diagnosis.'}
async function get(){try{const response=await fetch('/api/state');if(response.status===401){window.location='/login?next='+encodeURIComponent(hospitalMode?'/hospital':'/consumer');return}if(!response.ok)throw new Error('Workspace unavailable');app=await response.json();render()}catch(error){$('summaryTrend').textContent='Unavailable';$('shareStatus').textContent='Could not load your workspace. Refresh and sign in again.'}}
function render(){const b=app.baseline,a=app.scans[0],age=b?(Date.now()-Date.parse(b.capturedAt))/86400000:null;
 $('template').innerHTML=app.templates.map(t=>'<option>'+t+'</option>').join('');$('template').value=app.template;
 $('lock').textContent=!b?'Create a baseline before starting a scan.':age>30?'Advanced analysis locked: refresh baseline required.':'Advanced analysis available; baseline age '+age.toFixed(1)+' days.';
 $('baselineStatus').innerHTML='<div class="metric">'+(!b?'Not created':age>30?'Expired':'Fresh')+'</div><div class="muted">'+(b?'Captured '+new Date(b.capturedAt).toLocaleString():'Capture a baseline to unlock comparisons.')+'</div>';
 $('queue').textContent=app.queue.length?app.queue.length+' update(s) saved for later':'Everything is up to date';$('alert').innerHTML=a&&a.swellingPercent>5?'<b class="alert">Swelling spike '+a.swellingPercent.toFixed(1)+'% (&gt;5%)</b>':'<b class="ok">No abnormal swelling spike</b>';
 $('summaryScans').textContent=hospitalMode?app.roster.reduce((total,patient)=>total+(patient.scans??0),0):app.scans.length;$('summaryBaseline').textContent=app.baseline?'Active':'Not set';$('summaryTrend').textContent=a?(a.swellingPercent>0?'+'+a.swellingPercent.toFixed(1)+'%':a.swellingPercent.toFixed(1)+'%'):'No data';
 $('volume').textContent=a?(a.swellingPercent>=0?'+':'')+a.swellingPercent.toFixed(1)+'%':'—';$('rom').textContent=a?a.rom+'°':'—';$('redness').textContent=a?a.color.redYellowRatio:'—';$('romBar').style.width=(a?Math.min(100,a.rom/1.8):0)+'%';
 $('selectedRegion').textContent=a?'Selected region: '+a.bodyRegion:'No region selected';$('flexion').textContent=a?a.joints.flexion+'°':'—';$('extension').textContent=a?a.joints.extension+'°':'—';
 $('timeline').innerHTML=app.scans.map(s=>'<tr><td>'+new Date(s.capturedAt).toLocaleTimeString()+'</td><td>'+s.template+'</td><td>'+s.volumeDifferentialCm3.toFixed(1)+' cm³</td><td>'+s.rom+'°</td><td class="'+(s.swellingPercent>5?'alert':'ok')+'">'+(s.swellingPercent>5?'Alert':'Stable')+'</td></tr>').join('')||'<tr><td colspan="5">No scans yet</td></tr>';
 $('roster').innerHTML=hospitalMode?(app.roster.length?'<table><thead><tr><th>Patient</th><th>Compliance</th><th>Alert</th></tr></thead><tbody>'+app.roster.map(p=>'<tr><td>'+p.name+'</td><td>'+(p.compliance*100).toFixed(0)+'%</td><td class="'+(p.alert?'alert':'ok')+'">'+(p.alert?'Swelling alert':'Stable')+'</td></tr>').join('')+'</tbody></table>':'<p class="muted">No patients are enrolled yet.</p>'):'<p class="muted">No goals yet. Complete your first mobile scan to start tracking.</p>'}
$('startScan').onclick=startScan;$('stopScan').onclick=()=>stopScan(true);$('completeScan').onclick=completeScan;renderRegions();
$('startCamera').onclick=startCamera;$('stopCamera').onclick=stopCamera;$('captureFrame').onclick=captureFrame;window.addEventListener('beforeunload',stopCamera);
$('photo').onchange=event=>{const file=event.target.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{photoImage=new Image();photoImage.onload=()=>{$('comparePhoto').disabled=false;$('photoResult').textContent='Photo ready. Comparison will run locally.'};photoImage.src=reader.result};reader.readAsDataURL(file)};$('comparePhoto').onclick=comparePhoto;
$('baseline').onclick=async()=>{await fetch('/api/baseline',{method:'POST'});get()};
$('clinical')?.addEventListener('click',async()=>{await fetch('/api/clinical',{method:'POST'});get();$('clinical').textContent='Clinical Pro enabled'});
$('send').onclick=async()=>{const text=$('message').value;if(!text)return;await fetch('/api/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})});$('message').value='';$('sent').textContent='Encrypted message queued for clinic delivery.'};
$('fhir').onclick=async()=>{const data=await fetch('/api/fhir').then(r=>r.json());const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='biovision-fhir.json';a.click()};
$('report').onclick=()=>window.print();get();
</script></body></html>`;
}

export async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/login") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(authPage("", url.searchParams.get("next") || "/consumer"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/register") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(authPage("", url.searchParams.get("next") || "/consumer", true));
    return;
  }
  if (request.method === "GET" && url.pathname === "/forgot") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(codePage("Reset your password", "/api/auth/request-reset", '<label>Email<input name="email" type="email" required autocomplete="email"></label>'));
    return;
  }
  if (request.method === "GET" && url.pathname === "/verify") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(codePage("Verify your email", "/api/auth/verify", '<label>Email<input name="email" type="email" required type="email"></label><label>Verification code<input name="code" inputmode="numeric" pattern="[0-9]{6}" required></label>'));
    return;
  }
  if (request.method === "GET" && url.pathname === "/reset") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(codePage("Choose a new password", "/api/auth/reset", '<label>Email<input name="email" type="email" required type="email"></label><label>Reset code<input name="code" inputmode="numeric" pattern="[0-9]{6}" required></label><label>New password<input name="password" type="password" minlength="8" required autocomplete="new-password"></label>'));
    return;
  }
  if (request.method === "GET" && url.pathname === "/security") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(codePage("Protect your account", "/api/auth/security", `<input name="email" type="hidden" value="${url.searchParams.get("email") ?? ""}"><label><input name="enable2fa" type="checkbox" value="yes"> Enable email two-factor authentication</label>`));
    return;
  }
  if (request.method === "GET" && url.pathname === "/2fa") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(codePage("Two-factor authentication", `/api/auth/2fa?next=${encodeURIComponent(url.searchParams.get("next") || "/consumer")}`, `<label>Email<input name="email" type="email" value="${url.searchParams.get("email") ?? ""}" required></label><label>Security code<input name="code" inputmode="numeric" pattern="[0-9]{6}" required></label>`));
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(landingPage(url.searchParams.get("sent") === "1" ? "Thanks—your message was received." : ""));
    return;
  }
  if (request.method === "GET" && url.pathname === "/hospital-interest") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(hospitalInterestPage());
    return;
  }
  if (request.method === "GET" && url.pathname === "/account") {
    const user = authenticatedUser(request);
    if (!user) {
      response.writeHead(302, { location: "/login?next=/account" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(accountPage(user));
    return;
  }
  if (request.method === "GET" && (url.pathname === "/hospital" || url.pathname === "/consumer")) {
    if (!authenticatedUser(request)) {
      response.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname)}` });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html(url.pathname === "/consumer" ? "consumer" : "hospital"));
    return;
  }
  if (request.method === "GET" && url.pathname === "/health") {
    json(response, 200, {
      status: "ok",
      service: "biovision",
      emailConfigured: smtpConfigured,
      deployment: process.env.VERCEL === "1" ? "vercel" : "local"
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/email-status") {
    json(response, 200, {
      configured: smtpConfigured,
      host: smtpConfigured ? process.env.SMTP_HOST : null,
      from: smtpConfigured ? process.env.SMTP_FROM : null,
      recipient: smtpConfigured ? (process.env.SUPPORT_TO || process.env.SMTP_USER) : null
    });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/state") {
    const user = authenticatedUser(request);
    if (!user) return json(response, 401, { error: "Authentication required" });
    const currentState = userState(user);
    json(response, 200, { ...currentState, templates, baselineAgeDays: baselineAgeDays(currentState) });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/fhir") {
    const user = authenticatedUser(request);
    if (!user) return json(response, 401, { error: "Authentication required" });
    const payload = fhir(userState(user));
    if (!payload) return json(response, 404, { error: "Capture a scan first" });
    json(response, 200, payload);
    return;
  }
  if (request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (url.pathname === "/api/site-message") {
      const form = new URLSearchParams(body);
      const email = form.get("email")?.trim();
      const message = form.get("message")?.trim();
      const kind = form.get("kind");
      if (!email || !message || !["support", "feedback", "contact"].includes(kind)) {
        response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        response.end("A valid email, message, and message type are required.");
        return;
      }
      try {
        await forwardSiteMessage(kind, email, message);
        siteMessages.push({ kind, email, message, createdAt: now() });
        json(response, 200, { sent: true });
      } catch (error) {
        console.error("Site message delivery failed:", error.message);
        json(response, 503, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/hospital-interest") {
      const form = new URLSearchParams(body);
      const name = form.get("name")?.trim();
      const email = form.get("email")?.trim().toLowerCase();
      const hospital = form.get("hospital")?.trim();
      const message = form.get("message")?.trim() || "No additional details provided.";
      if (!name || !email || !hospital) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(hospitalInterestPage("Name, work email, and hospital or clinic name are required."));
        return;
      }
      try {
        await forwardSiteMessage("partnership", email, `Hospital or clinic: ${hospital}\nContact name: ${name}\n\n${message}`);
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(hospitalInterestPage("Thanks — your request was received. We will get back to you soon."));
      } catch (error) {
        console.error("Hospital interest delivery failed:", error.message);
        response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
        response.end(hospitalInterestPage(`Request not sent: ${error.message}`));
      }
      return;
    }
    if (url.pathname === "/api/share-report") {
      const user = authenticatedUser(request);
      if (!user) return json(response, 401, { error: "Please sign in again before sharing a report." });
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return json(response, 400, { error: "A valid recipient email is required." });
      }
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json(response, 400, { error: "A valid recipient email is required." });
      }
      try {
        await sendProgressReport(email, user, userState(user));
        json(response, 200, { sent: true });
      } catch (error) {
        console.error("Progress report delivery failed:", error.message);
        json(response, 503, { error: error.message });
      }
      return;
    }
    if (url.pathname === "/api/auth/logout") {
      const sessionId = cookies(request).session;
      if (sessionId) sessions.delete(sessionId);
      response.writeHead(303, {
        location: "/",
        "set-cookie": "session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
      });
      response.end();
      return;
    }
    if (url.pathname === "/api/account/delete") {
      const user = authenticatedUser(request);
      if (!user) return json(response, 401, { error: "Your session expired. Please sign in again." });
      let input;
      try {
        input = JSON.parse(body);
      } catch {
        return json(response, 400, { error: "Password confirmation is required." });
      }
      if (typeof input.password !== "string" || !verifyPassword(input.password, user.passwordHash)) {
        return json(response, 400, { error: "The password is incorrect. Your account was not deleted." });
      }
      users.delete(user.email);
      userStates.delete(user.id);
      for (const [sessionId, userId] of sessions) {
        if (userId === user.id) sessions.delete(sessionId);
      }
      persistUsers();
      persistState(user);
      json(response, 200, { deleted: true });
      return;
    }
    if (url.pathname === "/api/account") {
      const user = authenticatedUser(request);
      if (!user) {
        response.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        response.end("Your session expired. Please sign in again.");
        return;
      }
      const form = new URLSearchParams(body);
      const name = form.get("name")?.trim();
      const email = form.get("email")?.trim().toLowerCase();
      const birthday = form.get("birthday")?.trim();
      const heightCm = form.get("heightCm")?.trim();
      const weightKg = form.get("weightKg")?.trim();
      if (!name || !email || !birthday || !heightCm || !weightKg) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(accountPage(user, "Name, email, birthday, height, and weight are required."));
        return;
      }
      if (email !== user.email && users.has(email)) {
        response.writeHead(409, { "content-type": "text/html; charset=utf-8" });
        response.end(accountPage(user, "That email is already in use."));
        return;
      }
      const oldEmail = user.email;
      user.name = name;
      user.email = email;
      user.profile = {
        birthday,
        phone: form.get("phone")?.trim() ?? "",
        heightCm,
        weightKg,
        healthGoals: form.get("healthGoals")?.trim() ?? "",
        healthNotes: form.get("healthNotes")?.trim() ?? ""
      };
      if (oldEmail !== email) users.delete(oldEmail);
      users.set(email, user);
      persistUsers();
      const state = userStates.get(user.id);
      if (state) {
        state.patient.name = name;
        persistState(user);
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(accountPage(user, "Saved. Your account details are up to date."));
      return;
    }
    if (url.pathname === "/api/auth/login" || url.pathname === "/api/auth/register") {
      const form = new URLSearchParams(body);
      const email = form.get("email")?.trim().toLowerCase();
      const password = form.get("password") ?? "";
      const name = form.get("name")?.trim();
      const profile = {
        birthday: form.get("birthday")?.trim() ?? "",
        phone: form.get("phone")?.trim() ?? "",
        heightCm: form.get("heightCm")?.trim() ?? "",
        weightKg: form.get("weightKg")?.trim() ?? "",
        healthGoals: form.get("healthGoals")?.trim() ?? "",
        healthNotes: form.get("healthNotes")?.trim() ?? ""
      };
      const action = url.pathname === "/api/auth/register" ? "register" : "login";
      if (!email || password.length < 8) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(authPage("Enter a valid email and a password of at least 8 characters.", "/consumer", action === "register"));
        return;
      }
      let user = users.get(email);
      if (action === "register") {
        if (user) {
          response.writeHead(409, { "content-type": "text/html; charset=utf-8" });
          response.end(authPage("An account already exists for that email.", "/consumer", true));
          return;
        }
        if (!name || !profile.birthday || !profile.heightCm || !profile.weightKg) {
          response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          response.end(authPage("Name, birthday, height, and weight are required when creating an account.", "/consumer", true));
          return;
        }
        user = { id: randomBytes(12).toString("hex"), email, name, profile, passwordHash: hashPassword(password), emailVerified: false, twoFactorEnabled: false };
        users.set(email, user);
        persistUsers();
        try {
          await sendEmailCode(email, "Verify your BioVision account", challenge(user, "verification"));
        } catch (error) {
          users.delete(email);
          response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
          response.end(authPage(`Email delivery is unavailable: ${error.message}`, "/consumer", true));
          return;
        }
        response.writeHead(303, { location: `/verify?email=${encodeURIComponent(email)}` });
        response.end();
        return;
      } else if (!user || !verifyPassword(password, user.passwordHash)) {
        response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
        response.end(authPage("Email or password is incorrect."));
        return;
      }
      if (!user.emailVerified) {
        response.writeHead(303, { location: `/verify?email=${encodeURIComponent(email)}` });
        response.end();
        return;
      }
      if (user.twoFactorEnabled) {
        try {
          await sendEmailCode(email, "Your BioVision security code", challenge(user, "twoFactor"));
        } catch (error) {
          response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
          response.end(authPage(`Two-factor email delivery is unavailable: ${error.message}`));
          return;
        }
        response.writeHead(303, { location: `/2fa?email=${encodeURIComponent(email)}&next=${encodeURIComponent(url.searchParams.get("next") || "/consumer")}` });
        response.end();
        return;
      }
      const sessionId = randomBytes(32).toString("hex");
      sessions.set(sessionId, user.id);
      response.writeHead(303, { location: url.searchParams.get("next") || "/consumer", "set-cookie": `session=${sessionId}; HttpOnly; SameSite=Lax; Path=/` });
      response.end();
      return;
    }
    if (url.pathname === "/api/auth/request-reset") {
      const form = new URLSearchParams(body);
      const email = form.get("email")?.trim().toLowerCase();
      const user = email ? users.get(email) : undefined;
      if (user) {
        try {
          await sendEmailCode(email, "Reset your BioVision password", challenge(user, "reset"));
        } catch (error) {
          response.writeHead(503, { "content-type": "text/html; charset=utf-8" });
          response.end(codePage("Reset your password", "/api/auth/request-reset", '<label>Email<input name="email" type="email" required></label>', `Email delivery is unavailable: ${error.message}`));
          return;
        }
      }
      response.writeHead(303, { location: `/reset?email=${encodeURIComponent(email || "")}` });
      response.end();
      return;
    }
    if (url.pathname === "/api/auth/verify") {
      const form = new URLSearchParams(body);
      const email = form.get("email")?.trim().toLowerCase();
      const user = email ? users.get(email) : undefined;
      if (!user || !validChallenge(user, "verification", form.get("code") ?? "")) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(codePage("Verify your email", "/api/auth/verify", '<label>Email<input name="email" type="email" required></label><label>Verification code<input name="code" inputmode="numeric" required></label>', "That code is invalid or expired."));
        return;
      }
      user.emailVerified = true;
      persistUsers();
      delete user.verificationCodeHash;
      delete user.verificationCodeExpiresAt;
      response.writeHead(303, { location: `/security?email=${encodeURIComponent(email)}` });
      response.end();
      return;
    }
    if (url.pathname === "/api/auth/reset") {
      const form = new URLSearchParams(body);
      const email = form.get("email")?.trim().toLowerCase();
      const user = email ? users.get(email) : undefined;
      const password = form.get("password") ?? "";
      if (!user || !validChallenge(user, "reset", form.get("code") ?? "") || password.length < 8) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(codePage("Choose a new password", "/api/auth/reset", '<label>Email<input name="email" type="email" required></label><label>Reset code<input name="code" inputmode="numeric" required></label><label>New password<input name="password" type="password" minlength="8" required></label>', "The reset code is invalid, expired, or the password is too short."));
        return;
      }
      user.passwordHash = hashPassword(password);
      persistUsers();
      delete user.resetCodeHash;
      delete user.resetCodeExpiresAt;
      response.writeHead(303, { location: "/login" });
      response.end();
      return;
    }
    if (url.pathname === "/api/auth/security") {
      const form = new URLSearchParams(body);
      const email = form.get("email")?.trim().toLowerCase();
      const user = email ? users.get(email) : undefined;
      if (!user) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(authPage("Account not found."));
        return;
      }
      user.twoFactorEnabled = form.get("enable2fa") === "yes";
      persistUsers();
      response.writeHead(303, { location: "/login" });
      response.end();
      return;
    }
    if (url.pathname === "/api/auth/2fa") {
      const form = new URLSearchParams(body);
      const email = form.get("email")?.trim().toLowerCase();
      const user = email ? users.get(email) : undefined;
      if (!user || !validChallenge(user, "twoFactor", form.get("code") ?? "")) {
        response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        response.end(codePage("Two-factor authentication", "/api/auth/2fa", '<label>Email<input name="email" type="email" required></label><label>Security code<input name="code" inputmode="numeric" required></label>', "That security code is invalid or expired."));
        return;
      }
      delete user.twoFactorCodeHash;
      delete user.twoFactorCodeExpiresAt;
      const sessionId = randomBytes(32).toString("hex");
      sessions.set(sessionId, user.id);
      response.writeHead(303, { location: url.searchParams.get("next") || "/consumer", "set-cookie": `session=${sessionId}; HttpOnly; SameSite=Lax; Path=/` });
      response.end();
      return;
    }
    let input = {};
    const contentType = request.headers["content-type"] ?? "";
    if (body && contentType.includes("application/json")) {
      try {
        input = JSON.parse(body);
      } catch {
        json(response, 400, { error: "Request body must be valid JSON" });
        return;
      }
    }
    const user = authenticatedUser(request);
    if (!user) return json(response, 401, { error: "Authentication required" });
    const currentState = userState(user);
    if (url.pathname === "/api/scan/stop") {
      currentState.scanSession = { active: false, startedAt: null, stoppedAt: now(), completedRegions: [] };
      persistState(user);
      json(response, 200, { stopped: true, restartRequired: true });
      return;
    }
    if (url.pathname === "/api/scan") {
      if (!isMobilePhoneRequest(request)) {
        json(response, 400, { error: "Scans are only available from a supported mobile phone." });
        return;
      }
      if (typeof input.elapsedSeconds !== "number" || input.elapsedSeconds < 600 || !Array.isArray(input.completedRegions) || input.completedRegions.length < 8) {
        json(response, 400, { error: "A scan must cover all body regions for at least 10 minutes" });
        return;
      }
      currentState.template = input.template ?? currentState.template;
      const scan = createScan(currentState, 100 + Math.round(Math.random() * 12));
      persistState(user);
      json(response, 201, scan);
      return;
    }
    if (url.pathname === "/api/baseline") {
      const latest = currentState.scans[0];
      currentState.baseline = { id: `baseline-${Date.now()}`, capturedAt: now(), volumeCm3: latest?.volumeCm3 ?? 100, rom: latest?.rom ?? 92 };
      persistState(user);
      json(response, 200, currentState.baseline);
      return;
    }
    if (url.pathname === "/api/clinical") {
      currentState.patient.clinicalMode = true;
      persistState(user);
      json(response, 200, currentState.patient);
      return;
    }
    if (url.pathname === "/api/message") {
      if (typeof input.text !== "string" || !input.text.trim()) return json(response, 400, { error: "Message text is required" });
      currentState.messages.push({ id: `message-${Date.now()}`, text: input.text, createdAt: now() });
      currentState.queue.push({ kind: "clinical-message", id: currentState.messages.at(-1).id, createdAt: now() });
      persistState(user);
      json(response, 201, { queued: true });
      return;
    }
  }
  json(response, 404, { error: "Not found" });
}

export default handleRequest;

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectExecution) {
  const server = createServer(handleRequest);
  server.listen(port, "127.0.0.1", () => console.log(`BioVision local app: http://127.0.0.1:${port}`));
}
