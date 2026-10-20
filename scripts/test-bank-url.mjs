import axios from 'axios';
import { randomUUID } from 'node:crypto';

const FEE_URL = (process.env.FEE_URL || 'http://localhost:4001').replace(/\/+$/, '');
const paymentId = `bank-url-4999-${randomUUID()}`;
const http = axios.create({ timeout: 5_000, validateStatus: () => true });

try {
  const start = performance.now();
  const response = await http.post(`${FEE_URL}/students/1/payments`, {
    paymentId,
    amount: 100_000
  }, { headers: { 'Idempotency-Key': paymentId } });
  const elapsedMs = Math.round(performance.now() - start);
  const body = response.data || {};
  const pass = response.status === 503 && body.status === 'FAILED' &&
    typeof body.error === 'string' && body.paymentId === paymentId && elapsedMs < 1_500;
  console.log(JSON.stringify({
    configuredTest: 'Fee Service BANK_URL=http://localhost:4999, không có Bank tại cổng 4999',
    httpStatus: response.status,
    elapsedMs,
    body,
    result: pass ? 'ĐẠT' : 'CHƯA ĐẠT'
  }, null, 2));
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error('Không gọi được Fee Service:', error.message);
  process.exitCode = 1;
}
