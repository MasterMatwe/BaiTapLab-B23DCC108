import 'dotenv/config';
import express from 'express';
import http from 'node:http';

const app = express();
app.use(express.json({ limit: '32kb' }));

const PORT = Number.parseInt(process.env.BANK_PORT || '4002', 10);
const ENABLE_TEST_ENDPOINTS = process.env.ENABLE_TEST_ENDPOINTS === 'true';
const DEFAULT_BANK_CONFIG = {
  delayMs: readNonNegativeNumber(process.env.DELAY_MS, 0),
  failRate: readRate(process.env.FAIL_RATE, 0),
  dropRate: readRate(process.env.DROP_RATE, 0),
  bankLimit: readNonNegativeNumber(process.env.BANK_LIMIT, 20_000_000)
};
const bankConfig = { ...DEFAULT_BANK_CONFIG };

const stats = {
  connections: 0,
  activeConnections: 0,
  requests: 0,
  charges: 0,
  duplicates: 0,
  idempotencyReplays: 0,
  chargedAmountTotal: 0
};

// In-memory ledger. A successful/rejected reference is stored so the same key
// can never create a second debit. FAIL_RATE errors are not stored because the
// specification says they happen before money is deducted and may be retried.
const transactions = new Map();
const chargedReferences = new Set();

function readNonNegativeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readRate(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendStoredResult(res, result) {
  return res.status(result.httpStatus).json(result.body);
}

app.get('/health', (_req, res) => {
  res.status(200).json({ service: 'bank-service', status: 'UP' });
});

app.get('/stats', (_req, res) => {
  res.status(200).json({
    ...stats,
    config: {
      ...bankConfig
    }
  });
});

// Test-only controls used by the Postman Collection. Keep disabled outside this lab.
if (ENABLE_TEST_ENDPOINTS) {
  app.post('/__test/config', (req, res) => {
    const body = req.body || {};
    const next = { ...bankConfig };

    if (body.delayMs !== undefined) {
      const value = Number(body.delayMs);
      if (!Number.isFinite(value) || value < 0) {
        return res.status(400).json({ error: 'delayMs phải là số >= 0', paymentId: null, status: 'FAILED' });
      }
      next.delayMs = value;
    }
    for (const key of ['failRate', 'dropRate']) {
      if (body[key] !== undefined) {
        const value = Number(body[key]);
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          return res.status(400).json({ error: `${key} phải nằm trong khoảng 0..1`, paymentId: null, status: 'FAILED' });
        }
        next[key] = value;
      }
    }
    if (body.bankLimit !== undefined) {
      const value = Number(body.bankLimit);
      if (!Number.isSafeInteger(value) || value <= 0) {
        return res.status(400).json({ error: 'bankLimit phải là số nguyên dương', paymentId: null, status: 'FAILED' });
      }
      next.bankLimit = value;
    }

    Object.assign(bankConfig, next);
    res.status(200).json({ updated: true, config: { ...bankConfig } });
  });

  app.post('/__test/reset', (_req, res) => {
    // Only call when no test payments are actively being sent to the bank.
    for (const key of ['connections', 'requests', 'charges', 'duplicates', 'idempotencyReplays', 'chargedAmountTotal']) {
      stats[key] = 0;
    }
    // activeConnections tracks sockets already accepted, including the reset request.
    transactions.clear();
    chargedReferences.clear();
    Object.assign(bankConfig, DEFAULT_BANK_CONFIG);
    res.status(200).json({ reset: true, stats: { ...stats }, config: { ...bankConfig } });
  });
}

app.post('/charges', async (req, res) => {
  stats.requests += 1;

  const reference = String(req.get('Idempotency-Key') || req.body?.reference || '').trim();
  const amount = req.body?.amount;
  const paymentId = reference || null;

  if (!reference) {
    return res.status(400).json({
      error: 'reference hoặc Idempotency-Key là bắt buộc',
      paymentId,
      status: 'FAILED'
    });
  }

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return res.status(400).json({
      error: 'amount phải là số nguyên dương tính theo VND',
      paymentId,
      status: 'FAILED'
    });
  }

  if (req.get('Idempotency-Key') && req.body?.reference && req.get('Idempotency-Key') !== req.body.reference) {
    return res.status(409).json({
      error: 'Idempotency-Key không khớp reference',
      paymentId,
      status: 'FAILED'
    });
  }

  const cached = transactions.get(reference);
  if (cached) {
    if (cached.amount !== amount) {
      return res.status(409).json({
        error: 'reference đã được sử dụng với số tiền khác',
        paymentId,
        status: 'FAILED'
      });
    }

    // A replay is expected after a lost response. It is not a duplicate debit.
    stats.idempotencyReplays += 1;
    return sendStoredResult(res, cached.result);
  }

  // Business refusal is deterministic and is cached for this reference.
  if (amount > bankConfig.bankLimit) {
    const result = {
      httpStatus: 402,
      body: {
        error: `Số tiền vượt hạn mức ${bankConfig.bankLimit} VND`,
        paymentId: reference,
        status: 'FAILED'
      }
    };
    transactions.set(reference, { amount, result, state: 'REJECTED' });
    return sendStoredResult(res, result);
  }

  // Temporary server error is simulated BEFORE the debit and is not cached.
  if (Math.random() < bankConfig.failRate) {
    return res.status(500).json({
      error: 'Lỗi tạm thời mô phỏng trước khi trừ tiền',
      paymentId: reference,
      status: 'FAILED'
    });
  }

  // Defensive guard: under normal operation the transaction map catches this
  // case first. This guard makes a second debit observable if the code changes.
  if (chargedReferences.has(reference)) {
    stats.duplicates += 1;
    const old = transactions.get(reference);
    if (old) return sendStoredResult(res, old.result);
    return res.status(409).json({
      error: 'Phát hiện reference đã bị trừ tiền',
      paymentId: reference,
      status: 'FAILED'
    });
  }

  // Debit and record the result synchronously before any await / simulated drop.
  // The record therefore exists even when the response connection is destroyed.
  chargedReferences.add(reference);
  stats.charges += 1;
  stats.chargedAmountTotal += amount;

  const result = {
    httpStatus: 201,
    body: {
      reference,
      paymentId: reference,
      amount,
      status: 'PAID',
      transactionId: `TX-${reference}`
    }
  };
  const shouldDropFirstResponse = Math.random() < bankConfig.dropRate;
  transactions.set(reference, { amount, result, state: 'CHARGED' });

  if (bankConfig.delayMs > 0) {
    const delayForThisRequest = bankConfig.delayMs;
    await sleep(delayForThisRequest);
  }

  if (shouldDropFirstResponse) {
    // The charge is already committed; only the response is lost.
    req.socket.destroy();
    return;
  }

  // The client may have timed out while the simulated bank was waiting.
  if (res.destroyed || req.socket.destroyed) return;
  return sendStoredResult(res, result);
});

app.use((err, _req, res, _next) => {
  if (res.headersSent || res.destroyed) return;
  res.status(500).json({
    error: 'Lỗi nội bộ tại ngân hàng giả lập',
    paymentId: null,
    status: 'FAILED'
  });
});

const server = http.createServer(app);
server.keepAliveTimeout = 5_000;
server.headersTimeout = 6_000;
server.requestTimeout = 30_000;
server.on('connection', (socket) => {
  stats.connections += 1;
  stats.activeConnections += 1;
  socket.on('close', () => {
    stats.activeConnections = Math.max(0, stats.activeConnections - 1);
  });
});

server.listen(PORT, () => {
  console.log(`[Bank] listening on http://localhost:${PORT}`);
  console.log(`[Bank] DELAY_MS=${bankConfig.delayMs}, FAIL_RATE=${bankConfig.failRate}, DROP_RATE=${bankConfig.dropRate}, BANK_LIMIT=${bankConfig.bankLimit}`);
});
