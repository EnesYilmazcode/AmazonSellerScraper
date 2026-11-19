// ProScan Ask: answers a signed-in user's question about their own scan.
//
// POST {idToken, question, history, context: {products, total, source}}
//   -> 200 {answer, left} | 4xx/5xx {error, code}
//
// The Gemini key never leaves AWS. Each Firebase user gets DAILY_LIMIT
// questions a day and the whole service GLOBAL_LIMIT, counted in DynamoDB.
// Spend is also capped on the Google side by the AI Studio project's monthly cap.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const Chat = createRequire(import.meta.url)('./chat.js');

const PROJECT = process.env.FIREBASE_PROJECT || 'proscanbot';
const TABLE = process.env.TABLE || 'proscan-ask-usage';
const KEY_PARAM = process.env.KEY_PARAM || '/proscan/ask/gemini-key';
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 20);
const GLOBAL_LIMIT = Number(process.env.GLOBAL_LIMIT || 2000);
const MAX_BODY = 200_000;
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

const ddb = new DynamoDBClient({});
const ssm = new SSMClient({});
let geminiKey = null;
let jwks = { keys: null, until: 0 };

const reply = (status, body) => ({ statusCode: status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const fail = (status, code, error) => reply(status, { code, error });

async function keys() {
  if (jwks.keys && Date.now() < jwks.until) return jwks.keys;
  const res = await fetch(JWKS_URL);
  const age = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  jwks = { keys: (await res.json()).keys, until: Date.now() + 1000 * Math.min(Number(age ? age[1] : 3600), 21600) };
  return jwks.keys;
}

/** The Firebase uid in a valid ID token for this project, or null. */
export async function verifyIdToken(token, now = Date.now() / 1000) {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
  } catch { return null; }
  if (header.alg !== 'RS256') return null;
  const jwk = (await keys()).find((k) => k.kid === header.kid);
  if (!jwk) return null;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) return null;
  if (claims.aud !== PROJECT || claims.iss !== `https://securetoken.google.com/${PROJECT}`) return null;
  if (!(claims.exp > now) || !(claims.iat <= now + 60) || !(claims.auth_time <= now + 60)) return null;
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) return null;
  return claims.sub;
}

/** Counts one question against `pk`; false when it is already at `max`. */
async function take(pk, max, day) {
  try {
    const out = await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: pk } },
      UpdateExpression: 'ADD n :one SET expiresAt = :ttl',
      ConditionExpression: 'attribute_not_exists(n) OR n < :max',
      ExpressionAttributeValues: { ':one': { N: '1' }, ':max': { N: String(max) }, ':ttl': { N: String(Math.floor(Date.parse(day) / 1000) + 2 * 86400) } },
      ReturnValues: 'UPDATED_NEW',
    }));
    return Number(out.Attributes.n.N);
  } catch (e) {
    if (e.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
}

/** The client's context, re-cleaned field by field; null when malformed. */
export function cleanContext(ctx) {
  if (!ctx || !Array.isArray(ctx.products) || ctx.products.length === 0) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    products: ctx.products.slice(0, Chat.MAX_PRODUCTS).map((p) => ({
      asin: Chat.cleanText(p && p.asin, 10),
      title: Chat.cleanText(p && p.title, 120),
      price: num(p && p.price),
      rating: num(p && p.rating),
      reviews: num(p && p.reviews),
      prime: !!(p && p.prime),
    })),
    total: Math.min(num(ctx.total) || ctx.products.length, 100000),
    source: { label: Chat.cleanText(ctx.source && ctx.source.label, 120) || null, pages: 0 },
  };
}

async function gemini() {
  if (geminiKey) return geminiKey;
  const out = await ssm.send(new GetParameterCommand({ Name: KEY_PARAM, WithDecryption: true }));
  geminiKey = out.Parameter.Value;
  return geminiKey;
}

export async function handler(event) {
  if (event.requestContext?.http?.method !== 'POST') return fail(405, 'METHOD', 'POST only.');
  const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
  if (raw.length > MAX_BODY) return fail(413, 'TOO_BIG', 'That scan is too large to send.');
  let req;
  try { req = JSON.parse(raw); } catch { return fail(400, 'BAD_JSON', 'Bad request.'); }

  const uid = await verifyIdToken(req.idToken).catch(() => null);
  if (!uid) return fail(401, 'AUTH', 'Sign in to ProScan to use AI chat.');
  const question = Chat.cleanText(req.question, 500);
  if (!question) return fail(400, 'EMPTY', 'Type a question first.');
  const context = cleanContext(req.context);
  if (!context) return fail(400, 'NO_DATA', 'No scanned products yet. Run a scan first.');

  const day = new Date().toISOString().slice(0, 10);
  if ((await take(`all#${day}`, GLOBAL_LIMIT, day)) === false) {
    return fail(429, 'BUSY', 'ProScan AI is at its limit for today. Try again tomorrow.');
  }
  const used = await take(`u#${uid}#${day}`, DAILY_LIMIT, day);
  if (used === false) return fail(429, 'DAILY', `You have used your ${DAILY_LIMIT} questions for today. They reset at midnight UTC.`);

  const { url, init } = Chat.buildRequest({ apiKey: await gemini(), question, context, history: req.history });
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(25000) });
  } catch {
    return fail(504, 'TIMEOUT', 'The AI took too long to answer. Try again.');
  }
  if (!res.ok) {
    console.error('gemini', res.status, (await res.text()).slice(0, 500));
    return fail(502, 'UPSTREAM', res.status === 429 ? 'ProScan AI is busy. Try again in a minute.' : 'ProScan AI could not answer right now.');
  }
  const text = Chat.extractText(await res.json().catch(() => null));
  if (!text) return fail(502, 'EMPTY_ANSWER', 'The AI returned an empty answer. Try rephrasing.');
  return reply(200, { answer: Chat.checkCitations(text, context), left: DAILY_LIMIT - used });
}
