import axios from 'axios';
import { randomUUID } from 'node:crypto';

const FEE_URL = (process.env.FEE_URL || 'http://localhost:4001').replace(/\/+$/, '');
const BANK_URL = (process.env.BANK_URL || 'http://localhost:4002').replace(/\/+$/, '');
const http = axios.create({ timeout: 10_000, validateStatus: () => true });
const AMOUNT = 1_000;
const TOTAL = 200;
const CONCURRENCY = 10;

async function getStats() {
  const response = await http.get(`${BANK_URL}/stats`);
  return response.data;
}

async function pay(index, batchId) {
  const paymentId = `s3-${batchId}-${String(index + 1).padStart(3, '0')}-${randomUUID()}`;
  const start = performance.now();
  try {
    const response = await http.post(`${FEE_URL}/students/1/payments`, {
      paymentId,
      amount: AMOUNT
    }, { headers: { 'Idempotency-Key': paymentId } });
    return { status: response.status, body: response.data, elapsedMs: Math.round(performance.now() - start) };
  } catch (error) {
    return { status: 0, body: { error: error.message }, elapsedMs: Math.round(performance.now() - start) };
  }
}

async function sendInBatches(total, concurrency, batchId) {
  const results = [];
  for (let start = 0; start < total; start += concurrency) {
    const end = Math.min(total, start + concurrency);
    const batch = Array.from({ length: end - start }, (_, offset) => pay(start + offset, batchId));
    results.push(...await Promise.all(batch));
  }
  return results;
}

try {
  const initialStats = await getStats();
  const normalBankConfig = initialStats.config?.delayMs === 0 && initialStats.config?.failRate === 0 && initialStats.config?.dropRate === 0;
  if (!normalBankConfig) console.warn('CẢNH BÁO: khởi động Bank Service với DELAY_MS=0, FAIL_RATE=0, DROP_RATE=0 trước khi đo.');
  const start = performance.now();
  const results = await sendInBatches(TOTAL, CONCURRENCY, randomUUID());
  const elapsedMs = Math.round(performance.now() - start);
  const afterStats = await getStats();
  const statuses = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});

  const delta = (key) => (afterStats[key] ?? 0) - (initialStats[key] ?? 0);
  const batchMetrics = {
    requested: TOTAL,
    concurrency: CONCURRENCY,
    amountEach: AMOUNT,
    successful201: results.filter((r) => r.status === 201 && r.body?.status === 'PAID').length,
    statuses,
    totalElapsedMs: elapsedMs,
    averagePaymentMs: Math.round(results.reduce((sum, r) => sum + r.elapsedMs, 0) / results.length),
    bankDelta: {
      connections: delta('connections'),
      requests: delta('requests'),
      charges: delta('charges'),
      duplicates: delta('duplicates'),
      idempotencyReplays: delta('idempotencyReplays')
    }
  };
  console.log('Kết quả 200 thanh toán:', JSON.stringify(batchMetrics, null, 2));

  console.log('\nChờ 6 giây để ngân hàng đóng các kết nối nhàn rỗi...');
  await new Promise((resolve) => setTimeout(resolve, 6_000));
  const idleResults = await Promise.all(Array.from({ length: 3 }, (_, i) => pay(TOTAL + i, randomUUID())));
  const finalStats = await getStats();
  console.log('Kết quả sau 6 giây nhàn rỗi:', idleResults.map((r) => ({ status: r.status, paymentStatus: r.body?.status, elapsedMs: r.elapsedMs })));
  console.log('Số TCP mới từ sau batch 200 đến sau bài thử idle:', finalStats.connections - afterStats.connections);

  const idlePass = idleResults.every((r) => r.status === 201 && r.body?.status === 'PAID');
  const pass = normalBankConfig && batchMetrics.successful201 === 200 &&
    batchMetrics.bankDelta.connections <= 20 && batchMetrics.bankDelta.charges === 200 &&
    batchMetrics.bankDelta.duplicates === 0 && idlePass;
  console.log(`\nKết quả kiểm tra tự động: ${pass ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error('Không chạy được load test. Kiểm tra hai service.', error.message);
  process.exitCode = 1;
}
