import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import axios from 'axios';
import AgentKeepAlive from 'agentkeepalive';

const app = express();
app.use(express.json({ limit: '32kb' }));

const PORT = Number.parseInt(process.env.FEE_PORT || process.env.PORT || '4001', 10);
const DEFAULT_BANK_URL = (process.env.BANK_URL || 'http://localhost:4002').replace(/\/+$/, '');
let BANK_URL = DEFAULT_BANK_URL;
const ENABLE_TEST_ENDPOINTS = process.env.ENABLE_TEST_ENDPOINTS === 'true';
const PAYMENT_DEADLINE_MS = readPositiveInteger(process.env.PAYMENT_DEADLINE_MS, 4_000);
const MAX_BANK_ATTEMPTS = readPositiveInteger(process.env.MAX_BANK_ATTEMPTS, 3);
const BANK_MAX_SOCKETS = readPositiveInteger(process.env.BANK_MAX_SOCKETS, 10);
const BANK_FREE_SOCKET_TIMEOUT_MS = readPositiveInteger(process.env.BANK_FREE_SOCKET_TIMEOUT_MS, 4_000);
const RETRY_PAUSE_MS = 60;

function readPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const bankAgent = new AgentKeepAlive({
  keepAlive: true,
  maxSockets: BANK_MAX_SOCKETS,
  maxFreeSockets: BANK_MAX_SOCKETS,
  timeout: 30_000,
  freeSocketTimeout: BANK_FREE_SOCKET_TIMEOUT_MS,
  freeSocketKeepAliveTimeout: 1_000
});

const bankHttp = axios.create({
  httpAgent: bankAgent,
  timeout: 0,
  validateStatus: () => true,
  headers: { 'Content-Type': 'application/json' }
});

// In-memory data follows the exercise specification.
const students = new Map([
  ['1', { id: '1', fees: 50_000_000 }],
  ['2', { id: '2', fees: 0 }],
  ['3', { id: '3', fees: 3_200_000 }]
]);
const payments = new Map();
const inFlight = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorBody(error, paymentId, status, extra = {}) {
  return { error, paymentId, status, ...extra };
}

function calculateReserved(studentId, exceptPaymentId = null) {
  let reserved = 0;
  for (const payment of payments.values()) {
    if (
      payment.studentId === studentId &&
      payment.paymentId !== exceptPaymentId &&
      payment.status === 'PENDING'
    ) {
      reserved += payment.amount;
    }
  }
  return reserved;
}

function paymentView(payment) {
  const student = students.get(payment.studentId);
  return {
    paymentId: payment.paymentId,
    studentId: payment.studentId,
    amount: payment.amount,
    status: payment.status,
    remainingFees: student?.fees ?? null,
    createdAt: payment.createdAt,
    updatedAt: payment.updatedAt,
    error: payment.error || undefined
  };
}

function setPaymentStatus(payment, status, error = null) {
  payment.status = status;
  payment.error = error;
  payment.updatedAt = new Date().toISOString();
}

function findNetworkCode(error) {
  return error?.code || error?.cause?.code || error?.cause?.cause?.code || null;
}

const NO_CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN'
]);

/**
 * Calls the bank under ONE total deadline. Retries keep the same reference/key.
 * The 500 simulation is contractually before debit, so it can be retried.
 * A timeout/reset after sending the request is ambiguous and must not become FAILED.
 */
async function chargeBank(payment, deadlineAt) {
  let attempt = 0;
  let lastError = null;
  let sawAmbiguousNetworkAttempt = false;

  while (attempt < MAX_BANK_ATTEMPTS && Date.now() < deadlineAt) {
    attempt += 1;
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;

    const controller = new AbortController();
    let deadlineFired = false;
    const timer = setTimeout(() => {
      deadlineFired = true;
      controller.abort();
    }, remainingMs);

    try {
      const response = await bankHttp.post(
        `${BANK_URL}/charges`,
        { reference: payment.paymentId, amount: payment.amount },
        {
          signal: controller.signal,
          headers: { 'Idempotency-Key': payment.paymentId }
        }
      );
      clearTimeout(timer);

      if (response.status === 201 && response.data?.status === 'PAID') {
        return { kind: 'paid', bankData: response.data };
      }

      if (response.status === 402) {
        return {
          kind: 'rejected',
          httpStatus: 402,
          error: response.data?.error || 'Ngân hàng từ chối giao dịch',
          bankData: response.data
        };
      }

      if (response.status === 500) {
        lastError = response.data?.error || 'Ngân hàng trả HTTP 500 tạm thời';
        if (attempt < MAX_BANK_ATTEMPTS && Date.now() + RETRY_PAUSE_MS < deadlineAt) {
          await sleep(RETRY_PAUSE_MS * attempt);
          continue;
        }
        // Per the exercise, FAIL_RATE occurs before debit, so this is a known failure.
        return { kind: 'temporary_failure', error: lastError };
      }

      if (response.status >= 500) {
        // Other server errors are not specified as pre-debit; preserve uncertainty.
        return { kind: 'uncertain', error: response.data?.error || `Ngân hàng trả HTTP ${response.status}` };
      }

      if (response.status >= 400) {
        return {
          kind: 'rejected',
          httpStatus: response.status,
          error: response.data?.error || `Ngân hàng từ chối với HTTP ${response.status}`,
          bankData: response.data
        };
      }

      return { kind: 'uncertain', error: `Phản hồi ngân hàng không hợp lệ: HTTP ${response.status}` };
    } catch (error) {
      clearTimeout(timer);
      lastError = error?.message || 'Lỗi kết nối ngân hàng';
      const code = findNetworkCode(error);

      if (deadlineFired || Date.now() >= deadlineAt || error?.name === 'CanceledError') {
        return { kind: 'timeout', error: 'Hết thời gian chờ ngân hàng' };
      }

      // A refused connection means no TCP connection was established, so no charge
      // request could have reached the bank. Do not spend the deadline retrying it.
      if (NO_CONNECTION_CODES.has(code)) {
        // A first connection refusal proves no request reached the bank. If an earlier
        // attempt had an ambiguous reset, however, that earlier attempt may have charged.
        if (!sawAmbiguousNetworkAttempt) {
          return { kind: 'unavailable', error: `Không kết nối được ngân hàng (${code})` };
        }
      } else {
        // ECONNRESET/socket hang-up is ambiguous; future attempts keep the same key.
        sawAmbiguousNetworkAttempt = true;
      }

      if (attempt < MAX_BANK_ATTEMPTS && Date.now() + RETRY_PAUSE_MS < deadlineAt) {
        await sleep(RETRY_PAUSE_MS * attempt);
        continue;
      }

      return { kind: 'uncertain', error: lastError };
    }
  }

  if (Date.now() >= deadlineAt) {
    return { kind: 'timeout', error: 'Hết thời gian chờ ngân hàng' };
  }
  return { kind: 'uncertain', error: lastError || 'Không xác định được kết quả ngân hàng' };
}

async function processPayment(payment) {
  const deadlineAt = Date.now() + PAYMENT_DEADLINE_MS;
  const outcome = await chargeBank(payment, deadlineAt);
  const student = students.get(payment.studentId);

  if (outcome.kind === 'paid') {
    if (!payment.appliedToFees) {
      // Set the guard before updating the balance to prevent a second deduction.
      payment.appliedToFees = true;
      student.fees -= payment.amount;
    }
    payment.retryable = false;
    setPaymentStatus(payment, 'PAID');
    payment.lastHttpStatus = 201;
    payment.lastOutcome = {
      httpStatus: 201,
      body: {
        ...paymentView(payment),
        transactionId: outcome.bankData?.transactionId,
        replayed: false
      }
    };
    return payment.lastOutcome;
  }

  if (outcome.kind === 'rejected') {
    payment.retryable = false;
    setPaymentStatus(payment, 'FAILED', outcome.error);
    payment.lastHttpStatus = outcome.httpStatus;
    payment.lastOutcome = {
      httpStatus: outcome.httpStatus,
      body: errorBody(outcome.error, payment.paymentId, 'FAILED', {
        studentId: payment.studentId,
        amount: payment.amount
      })
    };
    return payment.lastOutcome;
  }

  if (outcome.kind === 'unavailable') {
    payment.retryable = true;
    setPaymentStatus(payment, 'FAILED', outcome.error);
    payment.lastHttpStatus = 503;
    payment.lastOutcome = {
      httpStatus: 503,
      body: errorBody(outcome.error, payment.paymentId, 'FAILED', {
        studentId: payment.studentId,
        amount: payment.amount
      })
    };
    return payment.lastOutcome;
  }

  if (outcome.kind === 'temporary_failure') {
    payment.retryable = true;
    setPaymentStatus(payment, 'FAILED', outcome.error);
    payment.lastHttpStatus = 502;
    payment.lastOutcome = {
      httpStatus: 502,
      body: errorBody(`Ngân hàng vẫn lỗi sau ${MAX_BANK_ATTEMPTS} lần thử: ${outcome.error}`, payment.paymentId, 'FAILED', {
        studentId: payment.studentId,
        amount: payment.amount
      })
    };
    return payment.lastOutcome;
  }

  // Timeout or any ambiguous network result must remain PENDING.
  payment.retryable = false;
  setPaymentStatus(payment, 'PENDING', outcome.error || 'Chưa xác minh được kết quả ngân hàng');
  payment.lastHttpStatus = 504;
  payment.lastOutcome = {
    httpStatus: 504,
    body: errorBody(outcome.error || 'Chưa xác minh được kết quả ngân hàng', payment.paymentId, 'PENDING', {
      studentId: payment.studentId,
      amount: payment.amount
    })
  };
  return payment.lastOutcome;
}

function makePaymentRecord(paymentId, studentId, amount) {
  const timestamp = new Date().toISOString();
  return {
    paymentId,
    studentId,
    amount,
    status: 'PENDING',
    error: null,
    retryable: false,
    appliedToFees: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastHttpStatus: null,
    lastOutcome: null
  };
}

app.get('/health', (_req, res) => {
  res.status(200).json({ service: 'fee-service', status: 'UP' });
});

// Test-only controls used by the Postman Collection. Keep disabled outside this lab.
if (ENABLE_TEST_ENDPOINTS) {
  app.get('/__test/config', (_req, res) => {
    res.status(200).json({ bankUrl: BANK_URL, defaultBankUrl: DEFAULT_BANK_URL });
  });

  app.post('/__test/config', (req, res) => {
    const candidate = typeof req.body?.bankUrl === 'string' ? req.body.bankUrl.trim() : '';
    if (candidate) {
      let parsed;
      try {
        parsed = new URL(candidate);
      } catch {
        return res.status(400).json({ error: 'bankUrl không hợp lệ', paymentId: null, status: 'FAILED' });
      }
      const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
      if (parsed.protocol !== 'http:' || !isLoopback || !['4002', '4999'].includes(parsed.port)) {
        return res.status(400).json({
          error: 'Trong lab, bankUrl chỉ được là localhost:4002 hoặc localhost:4999',
          paymentId: null,
          status: 'FAILED'
        });
      }
      BANK_URL = candidate.replace(/\/+$/, '');
    }
    res.status(200).json({ bankUrl: BANK_URL, defaultBankUrl: DEFAULT_BANK_URL });
  });

  app.post('/__test/reset', (_req, res) => {
    if (inFlight.size > 0) {
      return res.status(409).json({ error: 'Không thể reset khi thanh toán còn đang chạy', paymentId: null, status: 'FAILED' });
    }
    students.clear();
    students.set('1', { id: '1', fees: 50_000_000 });
    students.set('2', { id: '2', fees: 0 });
    students.set('3', { id: '3', fees: 3_200_000 });
    payments.clear();
    inFlight.clear();
    BANK_URL = DEFAULT_BANK_URL;
    res.status(200).json({ reset: true, bankUrl: BANK_URL, students: 3, feesStudent1: 50_000_000 });
  });
}

app.get('/students/:id/fees', (req, res) => {
  const student = students.get(String(req.params.id));
  if (!student) {
    return res.status(404).json({
      error: 'Không tìm thấy sinh viên',
      paymentId: null,
      status: 'FAILED'
    });
  }

  const reservedAmount = calculateReserved(student.id);
  return res.status(200).json({
    studentId: student.id,
    fees: student.fees,
    currency: 'VND',
    reservedAmount,
    availableFees: Math.max(0, student.fees - reservedAmount)
  });
});

app.get('/payments/:paymentId', (req, res) => {
  const payment = payments.get(String(req.params.paymentId));
  if (!payment) {
    return res.status(404).json(errorBody('Không tìm thấy paymentId', String(req.params.paymentId), 'FAILED'));
  }
  return res.status(200).json(paymentView(payment));
});

app.post('/students/:id/payments', async (req, res, next) => {
  try {
    const studentId = String(req.params.id);
    const headerKey = req.get('Idempotency-Key')?.trim();
    const bodyKey = typeof req.body?.paymentId === 'string' ? req.body.paymentId.trim() : '';
    const paymentId = headerKey || bodyKey || randomUUID();
    const amount = req.body?.amount;

    if (headerKey && bodyKey && headerKey !== bodyKey) {
      return res.status(400).json(errorBody('Idempotency-Key không khớp paymentId', paymentId, 'FAILED'));
    }

    const student = students.get(studentId);
    if (!student) {
      return res.status(404).json(errorBody('Không tìm thấy sinh viên', paymentId, 'FAILED'));
    }

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      return res.status(400).json(errorBody('amount phải là số nguyên dương tính theo VND', paymentId, 'FAILED'));
    }

    let payment = payments.get(paymentId);
    if (payment && (payment.studentId !== studentId || payment.amount !== amount)) {
      return res.status(409).json(errorBody('paymentId đã được sử dụng với dữ liệu khác', paymentId, 'FAILED'));
    }

    // Concurrent requests for the same payment share one in-flight operation.
    const currentJob = inFlight.get(paymentId);
    if (currentJob) {
      const outcome = await currentJob;
      return res.status(outcome.httpStatus).json({ ...outcome.body, replayed: true });
    }

    if (payment?.status === 'PAID') {
      return res.status(200).json({ ...paymentView(payment), replayed: true });
    }

    if (payment?.status === 'FAILED' && !payment.retryable) {
      const previous = payment.lastOutcome || {
        httpStatus: payment.lastHttpStatus || 400,
        body: errorBody(payment.error || 'Thanh toán thất bại', paymentId, 'FAILED')
      };
      return res.status(previous.httpStatus).json({ ...previous.body, replayed: true });
    }

    if (!payment) {
      const reservedByOtherPayments = calculateReserved(studentId);
      const availableFees = Math.max(0, student.fees - reservedByOtherPayments);
      if (amount > availableFees) {
        return res.status(400).json(errorBody(
          `Số tiền thanh toán vượt công nợ còn khả dụng (${availableFees} VND)`,
          paymentId,
          'FAILED',
          { studentId, amount }
        ));
      }
      payment = makePaymentRecord(paymentId, studentId, amount);
      payments.set(paymentId, payment);
    } else if (payment.status === 'FAILED' && payment.retryable) {
      const reservedByOtherPayments = calculateReserved(studentId, paymentId);
      const availableFees = Math.max(0, student.fees - reservedByOtherPayments);
      if (amount > availableFees) {
        return res.status(400).json(errorBody(
          `Số tiền thanh toán vượt công nợ còn khả dụng (${availableFees} VND)`,
          paymentId,
          'FAILED',
          { studentId, amount }
        ));
      }
      setPaymentStatus(payment, 'PENDING');
      payment.retryable = false;
    }
    // Existing PENDING records can be retried with the same key to resolve uncertainty.

    const job = processPayment(payment);
    inFlight.set(paymentId, job);
    let outcome;
    try {
      outcome = await job;
    } finally {
      if (inFlight.get(paymentId) === job) inFlight.delete(paymentId);
    }
    return res.status(outcome.httpStatus).json(outcome.body);
  } catch (error) {
    return next(error);
  }
});

app.use((err, req, res, _next) => {
  if (res.headersSent || res.destroyed) return;
  const paymentId = req.body?.paymentId || req.get('Idempotency-Key') || null;
  res.status(500).json(errorBody('Lỗi nội bộ tại Fee Service', paymentId, 'FAILED'));
});

const server = http.createServer(app);
server.keepAliveTimeout = 5_000;
server.headersTimeout = 6_000;
server.listen(PORT, () => {
  console.log(`[Fee] listening on http://localhost:${PORT}`);
  console.log(`[Fee] BANK_URL=${BANK_URL}`);
  console.log(`[Fee] deadline=${PAYMENT_DEADLINE_MS}ms, maxAttempts=${MAX_BANK_ATTEMPTS}, maxBankSockets=${BANK_MAX_SOCKETS}, freeSocketTimeout=${BANK_FREE_SOCKET_TIMEOUT_MS}ms`);
});
