import axios from 'axios';
import { randomUUID } from 'node:crypto';

const mode = (process.argv[2] || '').toLowerCase();
const FEE_URL = (process.env.FEE_URL || 'http://localhost:4001').replace(/\/+$/, '');
const BANK_URL = (process.env.BANK_URL || 'http://localhost:4002').replace(/\/+$/, '');
const http = axios.create({ timeout: 10_000, validateStatus: () => true });

async function stats() {
  return (await http.get(`${BANK_URL}/stats`)).data;
}

async function fees() {
  return (await http.get(`${FEE_URL}/students/1/fees`)).data;
}

async function makePayment(paymentId, amount) {
  const start = performance.now();
  const response = await http.post(`${FEE_URL}/students/1/payments`, { paymentId, amount }, {
    headers: { 'Idempotency-Key': paymentId }
  });
  return { httpStatus: response.status, body: response.data, elapsedMs: Math.round(performance.now() - start) };
}

function delta(after, before, key) {
  return (after[key] ?? 0) - (before[key] ?? 0);
}

try {
  if (!['drop', 'fail', 'limit'].includes(mode)) {
    console.error('Cách dùng: node scripts/test-scenario4.mjs drop|fail|limit');
    process.exit(2);
  }

  const beforeStats = await stats();
  const beforeFees = await fees();

  if (mode === 'limit') {
    const paymentId = `s4-limit-${randomUUID()}`;
    const result = await makePayment(paymentId, 25_000_000);
    const afterStats = await stats();
    const afterFees = await fees();
    const report = {
      mode,
      result,
      bankDelta: {
        requests: delta(afterStats, beforeStats, 'requests'),
        charges: delta(afterStats, beforeStats, 'charges'),
        duplicates: delta(afterStats, beforeStats, 'duplicates')
      },
      feesBefore: beforeFees.fees,
      feesAfter: afterFees.fees
    };
    console.log(JSON.stringify(report, null, 2));
    const pass = result.httpStatus === 402 && result.body?.status === 'FAILED' &&
      report.bankDelta.requests === 1 && report.bankDelta.charges === 0 &&
      report.feesBefore === report.feesAfter;
    console.log(`\nKết quả kiểm tra tự động: ${pass ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
    if (!pass) process.exitCode = 1;
    else process.exitCode = 0;
    // The limit test is complete; exit without running the 60-payment branch.
    process.exit(pass ? 0 : 1);
  }

  const expectedRate = 0.3;
  const config = beforeStats.config || {};
  console.log(`Chạy 60 giao dịch tuần tự ở mode=${mode}. Cấu hình hiện tại:`, config);
  if (mode === 'drop' && config.dropRate !== expectedRate) {
    console.warn('CẢNH BÁO: cần khởi động Bank Service với DROP_RATE=0.3.');
  }
  if (mode === 'fail' && config.failRate !== expectedRate) {
    console.warn('CẢNH BÁO: cần khởi động Bank Service với FAIL_RATE=0.3.');
  }

  const results = [];
  for (let i = 0; i < 60; i += 1) {
    const paymentId = `s4-${mode}-${Date.now()}-${i + 1}-${randomUUID()}`;
    results.push(await makePayment(paymentId, 100_000));
  }

  const afterStats = await stats();
  const afterFees = await fees();
  const paid = results.filter((r) => r.body?.status === 'PAID' && [200, 201].includes(r.httpStatus)).length;
  const pending = results.filter((r) => r.body?.status === 'PENDING').length;
  const failed = results.filter((r) => r.body?.status === 'FAILED' ||
    (!['PAID', 'PENDING'].includes(r.body?.status) && r.httpStatus !== 200 && r.httpStatus !== 201)).length;
  const statusCounts = results.reduce((acc, r) => {
    acc[r.httpStatus] = (acc[r.httpStatus] || 0) + 1;
    return acc;
  }, {});

  const report = {
    mode,
    attempted: results.length,
    paid,
    pending,
    failed,
    statusCounts,
    bankDelta: {
      connections: delta(afterStats, beforeStats, 'connections'),
      requests: delta(afterStats, beforeStats, 'requests'),
      charges: delta(afterStats, beforeStats, 'charges'),
      duplicates: delta(afterStats, beforeStats, 'duplicates'),
      idempotencyReplays: delta(afterStats, beforeStats, 'idempotencyReplays')
    },
    feesBefore: beforeFees.fees,
    feesAfter: afterFees.fees,
    expectedFeeReduction: paid * 100_000,
    actualFeeReduction: beforeFees.fees - afterFees.fees,
    maxElapsedMs: Math.max(...results.map((r) => r.elapsedMs))
  };
  console.log(JSON.stringify(report, null, 2));

  const configPass = mode === 'drop' ? config.dropRate === 0.3 : config.failRate === 0.3;
  const commonPass = paid >= 54 && report.bankDelta.duplicates === 0 &&
    report.bankDelta.charges === paid && report.actualFeeReduction === report.expectedFeeReduction;
  const pendingResponsesPass = results.filter((r) => r.body?.status === 'PENDING').every((r) => r.httpStatus === 504);
  const modePass = mode === 'drop'
    ? configPass && commonPass && pendingResponsesPass && failed === 0 && pending === 60 - paid && report.maxElapsedMs <= 4_500
    : configPass && commonPass && report.maxElapsedMs <= 4_500;
  console.log(`\nKết quả kiểm tra tự động: ${modePass ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
  if (!modePass) process.exitCode = 1;
} catch (error) {
  console.error('Không chạy được phép thử tình huống 4. Kiểm tra cấu hình service.', error.message);
  process.exitCode = 1;
}
