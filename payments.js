import { createHmac, timingSafeEqual } from 'node:crypto';

const MP_API = 'https://api.mercadopago.com';

export function paymentsConfigured() {
  return Boolean(
    process.env.MERCADO_PAGO_ACCESS_TOKEN &&
    process.env.MERCADO_PAGO_WEBHOOK_SECRET
  );
}

async function mpRequest(pathname, { method = 'GET', body, idempotencyKey } = {}) {
  const token = process.env.MERCADO_PAGO_ACCESS_TOKEN;
  if (!token) throw new Error('Mercado Pago não configurado.');

  const headers = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json'
  };

  if (idempotencyKey) headers['X-Idempotency-Key'] = idempotencyKey;

  const response = await fetch(MP_API + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = { message: text }; }
  }

  if (!response.ok) {
    const error = new Error(data?.message || 'Falha no Mercado Pago.');
    error.status = 502;
    throw error;
  }

  return data;
}

export async function createPixPayment({
  amount,
  description,
  externalReference,
  notificationUrl,
  payer,
  idempotencyKey
}) {
  return mpRequest('/v1/payments', {
    method: 'POST',
    idempotencyKey,
    body: {
      transaction_amount: amount,
      description,
      payment_method_id: 'pix',
      external_reference: externalReference,
      notification_url: notificationUrl,
      payer
    }
  });
}

export async function getPayment(paymentId) {
  return mpRequest('/v1/payments/' + encodeURIComponent(paymentId));
}

export function verifyMercadoPagoWebhook(url, headers) {
  const secret = process.env.MERCADO_PAGO_WEBHOOK_SECRET;
  if (!secret) return false;

  const signature = String(headers['x-signature'] || '');
  const requestId = String(headers['x-request-id'] || '');
  const dataId = String(
    url.searchParams.get('data.id') ||
    url.searchParams.get('id') ||
    ''
  ).toLowerCase();

  const parts = {};
  for (const part of signature.split(',')) {
    const [key, value] = part.trim().split('=');
    if (key && value) parts[key] = value;
  }

  if (!parts.ts || !parts.v1 || !requestId || !dataId) return false;

  const manifest =
    'id:' + dataId +
    ';request-id:' + requestId +
    ';ts:' + parts.ts + ';';

  const expected = createHmac('sha256', secret)
    .update(manifest)
    .digest('hex');

  if (expected.length !== parts.v1.length) return false;

  return timingSafeEqual(
    Buffer.from(expected),
    Buffer.from(parts.v1)
  );
}
