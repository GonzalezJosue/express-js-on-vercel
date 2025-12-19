import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const HOLD_SECONDS = 60 * 60; // 1 hora

function verifyProxySignature(query: any, secret: string) {
  const { signature, ...rest } = query || {};
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("");

  const digest = crypto.createHmac("sha256", secret).update(message).digest("hex");
  return digest === signature;
}

function safeParseRedisValue(value: any): any | null {
  if (!value) return null;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null; // si alguien guardó algo no-JSON, no tronamos
    }
  }
  // a veces el cliente puede devolver ya un objeto
  if (typeof value === "object") return value;
  return null;
}

export default async function handler(req: any, res: any) {
  // App Proxy signature check
  const secret = process.env.SHOPIFY_PROXY_SECRET;
  if (!secret || !verifyProxySignature(req.query, secret)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const action = String(req.query?.action || "reserve");

  // -------- CHECK (GET) --------
  if (req.method === "GET" && action === "check") {
    const variant_id = String(req.query?.variant_id || "");
    if (!variant_id) return res.status(400).json({ ok: false, error: "missing_variant" });

    const key = `reserve:variant:${variant_id}`;
    const existing = await redis.get(key);
    const parsed = safeParseRedisValue(existing);

    const reserved_until = parsed?.reserved_until || null;
    const reserved = Boolean(reserved_until);

    return res.status(200).json({ ok: true, reserved, reserved_until });
  }

  // -------- RESERVE (POST) --------
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false });
  }

  const variant_id = req.body?.variant_id ? String(req.body.variant_id) : "";
  if (!variant_id) return res.status(400).json({ ok: false, error: "missing_variant" });

  const key = `reserve:variant:${variant_id}`;
  const reserved_until = new Date(Date.now() + HOLD_SECONDS * 1000).toISOString();

  const success = await redis.set(key, JSON.stringify({ reserved_until }), {
    nx: true,
    ex: HOLD_SECONDS,
  });

  if (success) {
    return res.status(200).json({ ok: true, reserved: true, reserved_until });
  }

  const existing = await redis.get(key);
  const parsed = safeParseRedisValue(existing);

  return res.status(409).json({
    ok: true,
    reserved: true,
    reserved_until: parsed?.reserved_until || null,
  });
}





