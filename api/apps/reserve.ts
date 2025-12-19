import crypto from "crypto";
import { Redis } from "@upstash/redis";

const redis = Redis.fromEnv();
const HOLD_SECONDS = 60 * 60; // 1 hora

function verifyProxySignature(query: any, secret: string) {
  const q = query || {};
  const { signature, ...rest } = q;
  if (!signature) return false;

  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join("");

  const digest = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("hex");

  return digest === signature;
}

function getVariantId(req: any): string | null {
  // 1) query
  const qid = req?.query?.variant_id;
  if (qid) return String(qid);

  // 2) body object
  const bid = req?.body?.variant_id;
  if (bid) return String(bid);

  // 3) body string (por si llega raw)
  if (typeof req?.body === "string") {
    try {
      const parsed = JSON.parse(req.body);
      if (parsed?.variant_id) return String(parsed.variant_id);
    } catch {
      // ignore
    }
  }

  return null;
}

function safeParseExisting(existing: any): { reserved_until?: string } | null {
  if (!existing) return null;

  // Upstash normalmente devuelve string, pero protegemos por si devuelve objeto
  if (typeof existing === "string") {
    try {
      return JSON.parse(existing);
    } catch {
      return null;
    }
  }

  if (typeof existing === "object") return existing;
  return null;
}

export default async function handler(req: any, res: any) {
  try {
    // 1) Verificación App Proxy
    const secret = process.env.SHOPIFY_PROXY_SECRET;
    if (!secret || !verifyProxySignature(req.query, secret)) {
      return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const variant_id = getVariantId(req);
    if (!variant_id) {
      return res.status(400).json({ ok: false, error: "missing_variant" });
    }

    const key = `reserve:variant:${variant_id}`;

    // 2) CHECK (GET)
    const action = String(req?.query?.action || "");
    if (req.method === "GET" || action === "check") {
      const existing = await redis.get(key);
      const parsed = safeParseExisting(existing);

      if (parsed?.reserved_until) {
        return res.status(200).json({
          ok: true,
          reserved: true,
          reserved_until: parsed.reserved_until,
        });
      }

      return res.status(200).json({ ok: true, reserved: false });
    }

    // 3) RESERVE (POST)
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "method_not_allowed" });
    }

    const reserved_until = new Date(Date.now() + HOLD_SECONDS * 1000).toISOString();

    const success = await redis.set(
      key,
      JSON.stringify({ reserved_until }),
      { nx: true, ex: HOLD_SECONDS }
    );

    if (success) {
      return res.status(200).json({ ok: true, reserved_until });
    }

    // Ya estaba reservado
    const existing = await redis.get(key);
    const parsed = safeParseExisting(existing);

    return res.status(409).json({
      ok: false,
      reserved_until: parsed?.reserved_until || null,
    });
  } catch (err: any) {
    console.error("reserve handler error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}




