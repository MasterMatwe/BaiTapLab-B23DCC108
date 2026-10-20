import axios from 'axios';
import { randomUUID } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const FEE_URL = (process.env.FEE_URL || 'http://localhost:4001').replace(/\/+$/, '');
const STUDENT_ID = '1';
const AMOUNT = 100_000;
const http = axios.create({ timeout: 10_000, validateStatus: () => true });

async function timedPayment(paymentId) {
  const start = performance.now();
  const response = await http.post(`${FEE_URL}/students/${STUDENT_ID}/payments`, {
    paymentId,
    amount: AMOUNT
  }, { headers: { 'Idempotency-Key': paymentId } });
  return { status: response.status, body: response.data, elapsedMs: Math.round(performance.now() - start) };
}

try {
  const before = await http.get(`${FEE_URL}/students/${STUDENT_ID}/fees`);
  console.log('Công nợ trước khi thử:', before.data);

  console.log('\n[1] Hãy bảo đảm ngân hàng đang TẮT. Gửi thanh toán...');
  const offline = await timedPayment(`s1-offline-${randomUUID()}`);
  console.log('Kết quả khi ngân hàng tắt:', offline);
  const feesStart = performance.now();
  const feesWhileOffline = await http.get(`${FEE_URL}/students/${STUDENT_ID}/fees`);
  const feesElapsedMs = Math.round(performance.now() - feesStart);
  console.log('GET fees khi ngân hàng tắt:', {
    status: feesWhileOffline.status,
    elapsedMs: feesElapsedMs,
    body: feesWhileOffline.data
  });

  console.log('\n[2] Khởi động ngân hàng tại cổng 4002, KHÔNG khởi động lại Fee Service.');
  const rl = readline.createInterface({ input, output });
  await rl.question('Sau khi ngân hàng đã chạy, nhấn Enter để tiếp tục... ');
  rl.close();

  const online = await timedPayment(`s1-online-${randomUUID()}`);
  console.log('Kết quả sau khi ngân hàng hoạt động lại:', online);
  const feesAfter = await http.get(`${FEE_URL}/students/${STUDENT_ID}/fees`);
  console.log('Công nợ sau phép thử:', feesAfter.data);
  const pass = offline.status === 503 && offline.body?.status === 'FAILED' && offline.elapsedMs < 1_500 &&
    feesWhileOffline.status === 200 && feesElapsedMs < 300 && online.status === 201;
  console.log(`\nKết quả kiểm tra tự động: ${pass ? 'ĐẠT' : 'CHƯA ĐẠT'}`);
  if (!pass) process.exitCode = 1;
} catch (error) {
  console.error('Không gọi được Fee Service. Hãy kiểm tra FEE_URL và tiến trình Fee Service.', error.message);
  process.exitCode = 1;
}
