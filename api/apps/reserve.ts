import crypto from 'crypto'
import { Redis } from '@upstash/redis'

const redis = Redis.fromEnv()
const HOLD_SECONDS = 60 * 60 // 1 hora

function verifyProxySignature(query: any, secret: string) {
  const { signature, ...rest } = query || {}
  if (!signature) return false

  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('')

  const digest = crypto
    .createHmac('sha256', secret)
    .update(message)
    .digest('hex')

  return digest === signature
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false })

  const secret = process.env.SHOPIFY_PROXY_SECRET
  if (!secret || !verifyProxySignature(req.query, secret)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }

  const { variant_id } = req.body || {}
  if (!variant_id) return res.status(400).json({ ok: false, error: 'missing_variant' })

  const key = `reserve:variant:${variant_id}`
  const reserved_until = new Date(Date.now() + HOLD_SECONDS * 1000).toISOString()

  const success = await redis.set(key, JSON.stringify({ reserved_until }), { nx: true, ex: HOLD_SECONDS })

  if (success) return res.status(200).json({ ok: true, reserved_until })

  const existing = await redis.get(key)
  const parsed = existing ? JSON.parse(existing as string) : null

  return res.status(409).json({ ok: false, reserved_until: parsed?.reserved_until || null })
}

