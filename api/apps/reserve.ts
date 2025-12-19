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

function normalizeStored(value: any): { reserved_until?: string } | null {
  if (!value) return null;

  // Upstash a veces devuelve objeto (auto-deserializado)
  if (typeof value === "object") return value;

  // o string
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      // si por alguna razón guardaste algo no-JSON, igual no romper
      return { reserved_until: undefined };
    }
  }

  return null;
}

export default async function handler(req: any, res: any) {
  try {
    // Siempre JSON (evita que Shopify/tema reciba HTML y “reviente”)
    res.setHeader("Content-Type", "application/json; charset=utf-8");

    const secret = process.env.SHOPIFY_PROXY_SECRET;
    if (!secret || !verifyProxySignature(req.query, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const action = String(req.query?.action || "").toLowerCase() || (req.method === "GET" ? "check" : "reserve");

    const variant_id =
      (req.query?.variant_id ? String(req.query.variant_id) : null) ||
      (req.body?.variant_id ? String(req.body.variant_id) : null);

    if (!variant_id) {
      return res.status(400).json({ ok: false, error: "missing_variant" });
    }

    const key = `reserve:variant:${variant_id}`;

    // CHECK (leer estado)
    if (action === "check") {
      const existing = await redis.get(key);
      const parsed = normalizeStored(existing);
      const reserved_until = parsed?.reserved_until || null;

      return res.status(200).json({
        ok: true,
        reserved: !!reserved_until,
        reserved_until,
      });
    }

    // RELEASE (liberar)
    if (action === "release") {
      await redis.del(key);
      return res.status(200).json({ ok: true, released: true });
    }

    // RESERVE (crear si no existe)
    if (action === "reserve") {
      const reserved_until = new Date(Date.now() + HOLD_SECONDS * 1000).toISOString();

      const success = await redis.set(key, { reserved_until }, { nx: true, ex: HOLD_SECONDS });

      if (success) {
        return res.status(200).json({ ok: true, reserved: true, reserved_until });
      }

      const existing = await redis.get(key);
      const parsed = normalizeStored(existing);
      return res.status(409).json({
        ok: true,
        reserved: false,
        reserved_until: parsed?.reserved_until || null,
      });
    }

    return res.status(400).json({ ok: false, error: "invalid_action" });
  } catch (err: any) {
    // Importante: que SIEMPRE regrese JSON
    return res.status(500).json({ ok: false, error: "server_error", detail: String(err?.message || err) });
  }
}






