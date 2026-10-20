/*
 * Postman test script: runs Lab 3 scenarios 1-4 automatically.
 * Requires ENABLE_TEST_ENDPOINTS=true in .env for BOTH services.
 */
const FEE = pm.collectionVariables.get('feeUrl') || 'http://localhost:4001';
const BANK = pm.collectionVariables.get('bankUrl') || 'http://localhost:4002';
const report = [];

function jsonBody(response) {
  if (!response) return null;
  try { return response.json(); } catch (_) { return { raw: response.text() }; }
}

function send(method, url, body, timeoutMs = 15000) {
  const started = Date.now();
  const request = {
    url,
    method,
    header: { Accept: 'application/json' },
    timeout: timeoutMs
  };
  if (body !== undefined) {
    request.header['Content-Type'] = 'application/json';
    request.body = { mode: 'raw', raw: JSON.stringify(body) };
  }
  return new Promise((resolve) => {
    pm.sendRequest(request, (err, response) => {
      resolve({
        status: response ? response.code : 0,
        body: jsonBody(response),
        elapsedMs: Date.now() - started,
        error: err ? err.message : null,
        text: response ? response.text() : ''
      });
    });
  });
}

function assertTest(name, pass, actual, expected) {
  const item = { test: name, pass: Boolean(pass), actual, expected };
  report.push(item);
  pm.test(name, function () {
    pm.expect(Boolean(pass), `Actual=${JSON.stringify(actual)}; Expected=${JSON.stringify(expected)}`).to.eql(true);
  });
}

function newId(prefix, suffix = '') {
  const guid = pm.variables.replaceIn('{{$guid}}');
  return `${prefix}-${Date.now()}-${suffix}-${guid}`;
}

async function configureFee(bankUrl) {
  return send('POST', `${FEE}/__test/config`, { bankUrl });
}

async function configureBank(config) {
  return send('POST', `${BANK}/__test/config`, config);
}

async function getStats() {
  return send('GET', `${BANK}/stats`);
}

async function getFees(studentId = '1') {
  return send('GET', `${FEE}/students/${studentId}/fees`);
}

// Payment helper always sends the same paymentId in the JSON body and header.
async function makePayment(paymentId, amount, studentId = '1', timeoutMs = 15000) {
  const started = Date.now();
  const response = await new Promise((resolve) => {
    pm.sendRequest({
      url: `${FEE}/students/${studentId}/payments`,
      method: 'POST',
      header: { Accept: 'application/json', 'Content-Type': 'application/json', 'Idempotency-Key': paymentId },
      body: { mode: 'raw', raw: JSON.stringify({ paymentId, amount }) },
      timeout: timeoutMs
    }, (err, res) => resolve({
      status: res ? res.code : 0,
      body: jsonBody(res),
      elapsedMs: Date.now() - started,
      error: err ? err.message : null
    }));
  });
  return response;
}

function delta(after, before, key) {
  return (after?.body?.[key] ?? after?.[key] ?? 0) - (before?.body?.[key] ?? before?.[key] ?? 0);
}

function countByStatus(results) {
  return results.reduce((acc, result) => {
    const key = String(result.status);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function paidCount(results) {
  return results.filter((result) => [200, 201].includes(result.status) && result.body?.status === 'PAID').length;
}

async function runAll() {
  // Setup: restore known initial data and normal simulator settings.
  const resetFee = await send('POST', `${FEE}/__test/reset`, {});
  const resetBank = await send('POST', `${BANK}/__test/reset`, {});
  const normalConfig = await configureBank({ delayMs: 0, failRate: 0, dropRate: 0, bankLimit: 20000000 });
  assertTest('SETUP: Fee test controls enabled and fee state reset', resetFee.status === 200 && resetFee.body?.reset === true, resetFee.status, 200);
  assertTest('SETUP: Bank test controls enabled and bank state reset', resetBank.status === 200 && resetBank.body?.reset === true, resetBank.status, 200);
  assertTest('SETUP: Bank starts in normal configuration', normalConfig.status === 200 && normalConfig.body?.config?.delayMs === 0 && normalConfig.body?.config?.failRate === 0 && normalConfig.body?.config?.dropRate === 0, normalConfig.body, { delayMs: 0, failRate: 0, dropRate: 0 });
  if (resetFee.status !== 200 || resetBank.status !== 200 || normalConfig.status !== 200) {
    throw new Error('Setup thất bại. Kiểm tra ENABLE_TEST_ENDPOINTS=true và khởi động lại cả hai service.');
  }

  // Scenario 1: automate ECONNREFUSED by switching Fee's bank URL to unused port 4999.
  const feeOfflineConfig = await configureFee('http://localhost:4999');
  const offlineId = newId('postman-s1-offline');
  const offlineStart = Date.now();
  const offline = await makePayment(offlineId, 100000);
  const offlineMs = offline.elapsedMs ?? (Date.now() - offlineStart);
  const feesOffline = await getFees('1');
  assertTest('S1: BANK_URL localhost:4999 trả 503 FAILED nhanh', feeOfflineConfig.status === 200 && offline.status === 503 && offline.body?.status === 'FAILED' && Boolean(offline.body?.error) && Boolean(offline.body?.paymentId) && offlineMs < 1500, { configStatus: feeOfflineConfig.status, httpStatus: offline.status, body: offline.body, elapsedMs: offlineMs }, '503 + FAILED + error/paymentId và < 1500 ms');
  assertTest('S1: GET fees vẫn trả 200 và nhanh khi bank không kết nối được', feesOffline.status === 200 && feesOffline.elapsedMs < 300, { status: feesOffline.status, elapsedMs: feesOffline.elapsedMs }, 'HTTP 200 và < 300 ms');
  const feeOnlineConfig = await configureFee('http://localhost:4002');
  const online = await makePayment(newId('postman-s1-online'), 100000);
  assertTest('S1: khôi phục BANK_URL về 4002 thì payment mới thành công không restart Fee', feeOnlineConfig.status === 200 && online.status === 201 && online.body?.status === 'PAID', { configStatus: feeOnlineConfig.status, status: online.status, body: online.body }, 'HTTP 201 PAID');

  // Scenario 2: 20 concurrent payments while Bank takes 5 seconds to reply.
  const bankSlowConfig = await configureBank({ delayMs: 5000, failRate: 0, dropRate: 0 });
  const s2Ids = Array.from({ length: 20 }, (_, index) => newId('postman-s2', index + 1));
  const s2Start = Date.now();
  const s2Promises = s2Ids.map((id) => makePayment(id, 1000, '1', 12000));
  const s2FeesPromise = getFees('1');
  const s2Results = await Promise.all(s2Promises);
  const s2Fees = await s2FeesPromise;
  const s2Elapsed = Date.now() - s2Start;
  const s2MaxMs = Math.max(...s2Results.map((result) => result.elapsedMs));
  const s2Counts = countByStatus(s2Results);
  pm.collectionVariables.set('lab3_s2_payment_ids', JSON.stringify(s2Ids));
  assertTest('S2: bank cấu hình DELAY_MS=5000', bankSlowConfig.status === 200 && bankSlowConfig.body?.config?.delayMs === 5000, bankSlowConfig.body?.config, { delayMs: 5000 });
  assertTest('S2: cả 20 lần gọi trả 504 PENDING', s2Results.length === 20 && s2Results.every((r) => r.status === 504 && r.body?.status === 'PENDING' && r.body?.paymentId && r.body?.error), { counts: s2Counts, sample: s2Results[0]?.body }, '20 × HTTP 504 PENDING');
  assertTest('S2: thời gian phản hồi thanh toán không quá 4500 ms', s2MaxMs <= 4500, { maxPaymentMs: s2MaxMs, elapsedAllMs: s2Elapsed }, '<= 4500 ms');
  assertTest('S2: GET fees phản hồi dưới 300 ms trong lúc 20 payment đang chờ', s2Fees.status === 200 && s2Fees.elapsedMs < 300, { status: s2Fees.status, elapsedMs: s2Fees.elapsedMs }, 'HTTP 200 và < 300 ms');

  // Resolve PENDING payments using the same IDs after removing artificial delay.
  const bankNormalAfterS2 = await configureBank({ delayMs: 0, failRate: 0, dropRate: 0 });
  const s2Resolved = await Promise.all(s2Ids.map((id) => makePayment(id, 1000, '1', 12000)));
  const s2ResolvedCount = paidCount(s2Resolved);
  assertTest('S2 cleanup: retry cùng paymentId xác minh các giao dịch đã charge', bankNormalAfterS2.status === 200 && s2ResolvedCount === 20, { paid: s2ResolvedCount, counts: countByStatus(s2Resolved) }, '20/20 PAID khi retry cùng khóa');

  // Scenario 3: 200 unique payments, concurrency 10, then reuse after idle > 5 sec.
  const normalS3 = await configureBank({ delayMs: 0, failRate: 0, dropRate: 0 });
  const s3Before = await getStats();
  const s3Ids = Array.from({ length: 200 }, (_, index) => newId('postman-s3', index + 1));
  const s3Start = Date.now();
  const s3Results = [];
  for (let start = 0; start < s3Ids.length; start += 10) {
    const batch = s3Ids.slice(start, start + 10).map((id) => makePayment(id, 1000, '1', 15000));
    s3Results.push(...await Promise.all(batch));
  }
  const s3Elapsed = Date.now() - s3Start;
  const s3After = await getStats();
  const s3Paid = paidCount(s3Results);
  const s3Connections = delta(s3After, s3Before, 'connections');
  const s3Charges = delta(s3After, s3Before, 'charges');
  const s3Duplicates = delta(s3After, s3Before, 'duplicates');
  assertTest('S3: 200/200 thanh toán thành công', s3Paid === 200, { paid: s3Paid, statuses: countByStatus(s3Results), totalElapsedMs: s3Elapsed }, '200/200 PAID');
  assertTest('S3: số kết nối TCP mới không vượt 20', s3Connections <= 20 && s3Connections >= 0, { connectionsBefore: s3Before.body?.connections, connectionsAfter: s3After.body?.connections, deltaConnections: s3Connections }, '<= 20 TCP connections');
  assertTest('S3: charges tăng đúng 200 và duplicates không tăng', s3Charges === 200 && s3Duplicates === 0, { deltaCharges: s3Charges, deltaDuplicates: s3Duplicates, deltaRequests: delta(s3After, s3Before, 'requests') }, 'charges +200; duplicates +0');
  console.log('S3_REPORT', JSON.stringify({ requested: 200, concurrency: 10, paid: s3Paid, totalElapsedMs: s3Elapsed, statsBefore: s3Before.body, statsAfter: s3After.body, delta: { connections: s3Connections, charges: s3Charges, duplicates: s3Duplicates } }));

  await new Promise((resolve) => setTimeout(resolve, 6000));
  const s3IdleIds = Array.from({ length: 3 }, (_, index) => newId('postman-s3-idle', index + 1));
  const s3IdleResults = await Promise.all(s3IdleIds.map((id) => makePayment(id, 1000, '1')));
  assertTest('S3: 3 thanh toán sau 6 giây nhàn rỗi vẫn thành công', paidCount(s3IdleResults) === 3, { paid: paidCount(s3IdleResults), statuses: countByStatus(s3IdleResults) }, '3/3 PAID');

  // Scenario 4a: bank debits, then drops the first response.
  const bankDropConfig = await configureBank({ delayMs: 0, failRate: 0, dropRate: 0.3 });
  const s4aStatsBefore = await getStats();
  const s4aFeesBefore = await getFees('1');
  const s4aIds = Array.from({ length: 60 }, (_, index) => newId('postman-s4-drop', index + 1));
  const s4aResults = [];
  for (let index = 0; index < s4aIds.length; index += 1) {
    s4aResults.push(await makePayment(s4aIds[index], 100000, '1', 12000));
  }
  const s4aStatsAfter = await getStats();
  const s4aFeesAfter = await getFees('1');
  const s4aPaid = paidCount(s4aResults);
  const s4aPending = s4aResults.filter((r) => r.body?.status === 'PENDING');
  const s4aCharges = delta(s4aStatsAfter, s4aStatsBefore, 'charges');
  const s4aDuplicates = delta(s4aStatsAfter, s4aStatsBefore, 'duplicates');
  const s4aFeeReduction = (s4aFeesBefore.body?.fees ?? 0) - (s4aFeesAfter.body?.fees ?? 0);
  const s4aExpectedFeeReduction = s4aPaid * 100000;
  const s4aMaxMs = Math.max(...s4aResults.map((r) => r.elapsedMs));
  assertTest('S4a: ít nhất 54/60 thanh toán được xác nhận PAID', s4aPaid >= 54, { paid: s4aPaid, statusCounts: countByStatus(s4aResults) }, '>= 54/60');
  assertTest('S4a: DROP_RATE=0.3, 60 giao dịch được charge một lần và không duplicate', bankDropConfig.status === 200 && bankDropConfig.body?.config?.dropRate === 0.3 && s4aCharges === 60 && s4aDuplicates === 0, { config: bankDropConfig.body?.config, deltaCharges: s4aCharges, deltaDuplicates: s4aDuplicates, deltaRequests: delta(s4aStatsAfter, s4aStatsBefore, 'requests'), deltaReplays: delta(s4aStatsAfter, s4aStatsBefore, 'idempotencyReplays') }, 'DROP_RATE 0.3; charges +60; duplicates +0');
  assertTest('S4a: nếu trả PENDING thì mã HTTP là 504; mọi giao dịch PAID giảm công nợ đúng tiền', s4aPending.every((r) => r.status === 504) && s4aFeeReduction === s4aExpectedFeeReduction, { pending: s4aPending.length, pendingStatuses: s4aPending.map((r) => r.status), actualFeeReduction: s4aFeeReduction, expectedFeeReduction: s4aExpectedFeeReduction }, 'PENDING => 504; fee reduction = PAID × 100000');
  assertTest('S4a: mọi thanh toán kết thúc trong tối đa 4500 ms', s4aMaxMs <= 4500, { maxPaymentMs: s4aMaxMs }, '<= 4500 ms');
  console.log('S4A_REPORT', JSON.stringify({ paid: s4aPaid, pending: s4aPending.length, statusCounts: countByStatus(s4aResults), maxElapsedMs: s4aMaxMs, statsDelta: { charges: s4aCharges, duplicates: s4aDuplicates, requests: delta(s4aStatsAfter, s4aStatsBefore), idempotencyReplays: delta(s4aStatsAfter, s4aStatsBefore, 'idempotencyReplays') }, feeReduction: { actual: s4aFeeReduction, expectedFromPaid: s4aExpectedFeeReduction } }));

  // Scenario 4b: HTTP 500 is injected before debit and may be retried.
  const bankFailConfig = await configureBank({ delayMs: 0, failRate: 0.3, dropRate: 0 });
  const s4bStatsBefore = await getStats();
  const s4bFeesBefore = await getFees('1');
  const s4bIds = Array.from({ length: 60 }, (_, index) => newId('postman-s4-fail', index + 1));
  const s4bResults = [];
  for (let index = 0; index < s4bIds.length; index += 1) {
    s4bResults.push(await makePayment(s4bIds[index], 100000, '1', 12000));
  }
  const s4bStatsAfter = await getStats();
  const s4bFeesAfter = await getFees('1');
  const s4bPaid = paidCount(s4bResults);
  const s4bCharges = delta(s4bStatsAfter, s4bStatsBefore, 'charges');
  const s4bDuplicates = delta(s4bStatsAfter, s4bStatsBefore, 'duplicates');
  const s4bFeeReduction = (s4bFeesBefore.body?.fees ?? 0) - (s4bFeesAfter.body?.fees ?? 0);
  const s4bExpectedFeeReduction = s4bPaid * 100000;
  const s4bMaxMs = Math.max(...s4bResults.map((r) => r.elapsedMs));
  assertTest('S4b: ít nhất 54/60 thanh toán được xác nhận PAID', s4bPaid >= 54, { paid: s4bPaid, statusCounts: countByStatus(s4bResults) }, '>= 54/60');
  assertTest('S4b: FAIL_RATE=0.3, charges khớp PAID và không duplicate', bankFailConfig.status === 200 && bankFailConfig.body?.config?.failRate === 0.3 && s4bCharges === s4bPaid && s4bDuplicates === 0, { config: bankFailConfig.body?.config, paid: s4bPaid, deltaCharges: s4bCharges, deltaDuplicates: s4bDuplicates, deltaRequests: delta(s4bStatsAfter, s4bStatsBefore, 'requests') }, 'charges delta = PAID; duplicates +0');
  assertTest('S4b: công nợ chỉ giảm theo các giao dịch PAID', s4bFeeReduction === s4bExpectedFeeReduction, { actualFeeReduction: s4bFeeReduction, expectedFeeReduction: s4bExpectedFeeReduction }, 'fee reduction = PAID × 100000');
  assertTest('S4b: mọi thanh toán kết thúc trong tối đa 4500 ms', s4bMaxMs <= 4500, { maxPaymentMs: s4bMaxMs }, '<= 4500 ms');
  console.log('S4B_REPORT', JSON.stringify({ paid: s4bPaid, statusCounts: countByStatus(s4bResults), maxElapsedMs: s4bMaxMs, statsDelta: { charges: s4bCharges, duplicates: s4bDuplicates, requests: delta(s4bStatsAfter, s4bStatsBefore) }, feeReduction: { actual: s4bFeeReduction, expectedFromPaid: s4bExpectedFeeReduction } }));

  // Scenario 4c: deterministic bank rejection for 25,000,000 VND.
  await configureBank({ delayMs: 0, failRate: 0, dropRate: 0, bankLimit: 20000000 });
  const s4cStatsBefore = await getStats();
  const s4cFeesBefore = await getFees('1');
  const s4cResult = await makePayment(newId('postman-s4-limit'), 25000000, '1');
  const s4cStatsAfter = await getStats();
  const s4cFeesAfter = await getFees('1');
  const s4cRequests = delta(s4cStatsAfter, s4cStatsBefore, 'requests');
  const s4cCharges = delta(s4cStatsAfter, s4cStatsBefore, 'charges');
  const s4cFeeReduction = (s4cFeesBefore.body?.fees ?? 0) - (s4cFeesAfter.body?.fees ?? 0);
  assertTest('S4c: khoản 25.000.000 VND bị từ chối HTTP 402 FAILED', s4cResult.status === 402 && s4cResult.body?.status === 'FAILED' && Boolean(s4cResult.body?.error) && Boolean(s4cResult.body?.paymentId), { status: s4cResult.status, body: s4cResult.body }, 'HTTP 402 + FAILED');
  assertTest('S4c: ngân hàng chỉ nhận một request, không charge', s4cRequests === 1 && s4cCharges === 0, { deltaRequests: s4cRequests, deltaCharges: s4cCharges, deltaDuplicates: delta(s4cStatsAfter, s4cStatsBefore, 'duplicates') }, 'requests +1; charges +0');
  assertTest('S4c: công nợ không thay đổi khi ngân hàng từ chối', s4cFeeReduction === 0, { before: s4cFeesBefore.body?.fees, after: s4cFeesAfter.body?.fees, reduction: s4cFeeReduction }, 'reduction 0');

  const completeReport = {
    generatedAt: new Date().toISOString(),
    suite: 'Lab 3 — Postman auto test',
    notes: 'Các thời gian và counter bên dưới là số đo thực tế của lượt chạy hiện tại.',
    scenario2: { maxPaymentMs: s2MaxMs, totalElapsedMs: s2Elapsed, statuses: s2Counts, feesElapsedMs: s2Fees.elapsedMs, resolvedPaid: s2ResolvedCount },
    scenario3: { paid: s3Paid, totalElapsedMs: s3Elapsed, statsBefore: s3Before.body, statsAfter: s3After.body, delta: { connections: s3Connections, charges: s3Charges, duplicates: s3Duplicates }, idlePaid: paidCount(s3IdleResults) },
    scenario4a: { paid: s4aPaid, pending: s4aPending.length, statusCounts: countByStatus(s4aResults), charges: s4aCharges, duplicates: s4aDuplicates, feeReduction: s4aFeeReduction, maxElapsedMs: s4aMaxMs },
    scenario4b: { paid: s4bPaid, statusCounts: countByStatus(s4bResults), charges: s4bCharges, duplicates: s4bDuplicates, feeReduction: s4bFeeReduction, maxElapsedMs: s4bMaxMs },
    scenario4c: { httpStatus: s4cResult.status, requests: s4cRequests, charges: s4cCharges, feeReduction: s4cFeeReduction },
    tests: report
  };
  pm.collectionVariables.set('lab3LastRunReport', JSON.stringify(completeReport, null, 2));
  console.log('LAB3_AUTOMATED_REPORT\n' + JSON.stringify(completeReport, null, 2));
} 

try {
  await runAll();
} catch (error) {
  console.error('Lab 3 Postman auto test failed:', error && error.stack ? error.stack : error);
  assertTest('LAB3: kịch bản tự động hoàn tất không gặp lỗi cấu hình', false, error?.message || String(error), 'Không có lỗi');
} finally {
  // Always restore normal config and BANK_URL for manual use after the run.
  const bankRestore = await configureBank({ delayMs: 0, failRate: 0, dropRate: 0, bankLimit: 20000000 });
  const feeRestore = await configureFee('http://localhost:4002');
  assertTest('CLEANUP: trả Bank config và BANK_URL về mặc định an toàn', bankRestore.status === 200 && feeRestore.status === 200, { bankStatus: bankRestore.status, feeStatus: feeRestore.status, bankConfig: bankRestore.body?.config, feeConfig: feeRestore.body }, 'normal bank + BANK_URL localhost:4002');
  const failed = report.filter((item) => !item.pass);
  assertTest('TỔNG KẾT: toàn bộ bài kiểm thử tự động đạt', failed.length === 0, {
    passed: report.length - failed.length,
    failed: failed.length,
    failures: failed.map((item) => ({ test: item.test, actual: item.actual, expected: item.expected }))
  }, '0 kiểm tra thất bại');
  pm.collectionVariables.set('lab3LastTestItems', JSON.stringify(report, null, 2));
}
