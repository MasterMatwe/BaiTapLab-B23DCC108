import axios from 'axios';
import { randomUUID } from 'node:crypto';

const FEE_URL = (process.env.FEE_URL || 'http://localhost:4001').replace(/\/+$/, '');
const BANK_URL = (process.env.BANK_URL || 'http://localhost:4002').replace(/\/+$/, '');
const http = axios.create({ timeout: 12_000, validateStatus: () => true });

async function timedGetFees() {
  const start = performance.now();
  const response = await http.get(`${FEE_URL}/students/1/fees`);
  return { status: response.status, elapsedMs: Math.round(performance.now() - start), body: response.data };
}

try {
  const bankConfig = await http.get(`${BANK_URL}/stats`);
  console.log('Cấu hình ngân hàng hiện tại:', bankConfig.data.config);
  if (bankConfig.data.config?.delayMs !== 5000) {
    console.warn('CẢNH BÁO: DELAY_MS hiện không bằng 5000; hãy khởi động lại Bank Service với DELAY_MS=5000.');
  }

  const requests = Array.from({ length: 20 }, (_, index) => {
    const paymentId = `s2-${Date.now()}-${index + 1}-${randomUUID()}`;
    const start = performance.now();
    return http.post(`${FEE_URL}/students/1/payments`, {
      paymentId,
      amount: 1_000
    }, { headers: { 'Idempotency-Key': paymentId } }).then((response) => ({
      status: response.status,
      body: response.data,
      elapsedMs: Math.round(performance.now() - start)
    })).catch((error) => ({ status: 0, body: { error: error.message }, elapsedMs: -1 }));
  });

  // Let payment requests enter the service before measuring the independent fees API.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const feesDuringLoad = await timedGetFees();
  const startAll = performance.now();
  const results = await Promise.all(requests);
  const totalElapsedMs = Math.round(performance.now() - startAll);

  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  const maxPaymentMs = Math.max(...results.map((r) => r.elapsedMs));
  console.log('\nKết quả 20 thanh toán:', { counts, maxPaymentMs, totalElapsedMs });
  console.log('GET fees trong lúc tải:', feesDuringLoad);
  console.log('Danh sách trạng thái:', results.map((r) => r.status));

  const pass = bankConfig.data.config?.delayMs === 5000 && results.length === 20 &&
    results.every((r) => r.status === 504 && r.body?.status === 'PENDING') &&
    maxPaymentMs <= 4_500 && feesDuringLoad.status === 200 && feesDuringLoad.elapsedMs < 300;
  console.log(`\nKết quả kiểm tra tự động: ${pass ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error('Không chạy được phép thử. Kiểm tra Fee Service và Bank Service.', error.message);
  process.exitCode = 1;
}
