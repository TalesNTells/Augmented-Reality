import crypto from 'node:crypto';

const COOKIE = 'tnt_admin';
const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export function adminPassword() {
  // In production the password MUST come from the environment.
  // For local dev only, fall back to "admin" so `npm run dev` just works.
  return process.env.ADMIN_PASSWORD || (process.env.VERCEL ? '' : 'admin');
}

function secret() {
  return process.env.AUTH_SECRET || adminPassword();
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

export function checkPassword(input) {
  const real = adminPassword();
  if (!real) return false;
  return crypto.timingSafeEqual(sha(input ?? ''), sha(real));
}

export function makeToken() {
  const exp = String(Math.floor(Date.now() / 1000) + MAX_AGE);
  return `${exp}.${sign(exp)}`;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthed(req) {
  if (!secret()) return false;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  const expected = sign(exp);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cookieFlags(req) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || !!process.env.VERCEL;
  return `Path=/; HttpOnly; SameSite=Lax; ${secure ? 'Secure; ' : ''}`;
}

export function setSession(req, res) {
  res.setHeader('set-cookie', `${COOKIE}=${makeToken()}; ${cookieFlags(req)}Max-Age=${MAX_AGE}`);
}

export function clearSession(req, res) {
  res.setHeader('set-cookie', `${COOKIE}=; ${cookieFlags(req)}Max-Age=0`);
}
