# Lab 3 — Kết nối và duy trì kết nối giữa các service

Project gồm hai ứng dụng Node.js/Express và các script đo kiểm cho đủ bốn tình huống trong đề.

## 1. Yêu cầu môi trường

- Node.js 18.17 trở lên.
- Windows PowerShell hoặc terminal tương đương.
- Hai cổng localhost `4001` (Fee Service) và `4002` (Bank Service) chưa bị chương trình khác sử dụng.

## 2. Cài đặt

Mở PowerShell tại thư mục `lab3-service-reliability`:

```powershell
npm install
Copy-Item .env.example .env
```

Hai service sẽ tự đọc file `.env` khi khởi động. Trong cấu hình này, `FEE_PORT=4001` là cổng của Fee Service; `BANK_PORT=4002` là cổng của Bank Service; `BANK_URL=http://localhost:4002` là địa chỉ ngân hàng mà Fee Service gọi. Đây là ba thiết lập liên quan nhưng có vai trò khác nhau. Các biến được đặt trực tiếp trong PowerShell sẽ ghi đè giá trị tương ứng trong `.env`.

Mở hai terminal riêng, đều tại thư mục project.

**Terminal 1 — Bank Service**

```powershell
$env:BANK_PORT="4002"
$env:DELAY_MS="0"
$env:FAIL_RATE="0"
$env:DROP_RATE="0"
npm run bank
```

**Terminal 2 — Fee Service**

```powershell
$env:BANK_URL="http://localhost:4002"
$env:FEE_PORT="4001"
$env:PAYMENT_DEADLINE_MS="4000"
$env:MAX_BANK_ATTEMPTS="3"
$env:BANK_MAX_SOCKETS="10"
$env:BANK_FREE_SOCKET_TIMEOUT_MS="4000"
npm run fee
```

Kiểm tra hai service:

```powershell
Invoke-RestMethod http://localhost:4001/health
Invoke-RestMethod http://localhost:4002/health
Invoke-RestMethod http://localhost:4002/stats
Invoke-RestMethod http://localhost:4001/students/1/fees
```

## 3. API và dữ liệu

### Xem công nợ

```http
GET http://localhost:4001/students/1/fees
```

Dữ liệu khởi tạo trong bộ nhớ:

- Sinh viên 1: `50.000.000 VND`.
- Sinh viên 2: `0 VND`.
- Sinh viên 3: `3.200.000 VND`.

`fees` là công nợ thực tế; `reservedAmount` là khoản đang được xử lý `PENDING` và `availableFees` là công nợ còn khả dụng để tạo giao dịch mới. Việc reserve không làm giảm `fees`.

### Thanh toán

```http
POST http://localhost:4001/students/1/payments
Content-Type: application/json
Idempotency-Key: demo-pay-001

{
  "paymentId": "demo-pay-001",
  "amount": 100000
}
```

`amount` là số nguyên VND. Dùng một `paymentId` mới cho mỗi giao dịch logic; khi thử lại cùng giao dịch phải giữ nguyên mã này. Nếu muốn xác minh một thanh toán `PENDING`, gửi lại cùng `paymentId` và số tiền; không cấp mã mới cho lần thử lại.

### Xem trạng thái một payment

```http
GET http://localhost:4001/payments/demo-pay-001
```

### Stats của ngân hàng

```http
GET http://localhost:4002/stats
```

- `connections`: số kết nối TCP mới được ngân hàng chấp nhận, tính lũy kế từ khi Bank Service khởi động.
- `requests`: số HTTP request vào `POST /charges`, gồm cả retry.
- `charges`: số giao dịch được trừ tiền thực tế, mỗi `reference` thành công chỉ tính một lần.
- `duplicates`: số lần trừ tiền trùng thực tế. Với idempotency hoạt động đúng, giá trị phải là `0`.
- `idempotencyReplays`: số lần ngân hàng trả lại kết quả đã lưu khi nhận lại cùng khóa. Đây là chỉ số bổ sung để phân biệt retry hợp lệ với trừ tiền trùng.

Mỗi lần kiểm thử nên ghi stats trước và sau, rồi tính chênh lệch `sau - trước`. Bộ đếm được reset khi khởi động lại Bank Service.

## 4. Quy tắc triển khai

- `FEE_PORT` là cổng lắng nghe của Fee Service (mặc định 4001); `BANK_PORT` là cổng lắng nghe của Bank Service (mặc định 4002). `BANK_URL` là địa chỉ Fee Service dùng để gọi Bank Service.
- Các service nạp file `.env` khi khởi động thông qua `dotenv`; cần sao chép `.env.example` thành `.env` trước khi chạy. `BANK_URL` được đọc khi Fee Service khởi động; đổi địa chỉ cần khởi động lại Fee Service.
- `PAYMENT_DEADLINE_MS` mặc định 4000 ms, nhỏ hơn ngưỡng tổng 4500 ms của đề.
- Tối đa `MAX_BANK_ATTEMPTS=3` lần gửi trong cùng deadline; mọi retry dùng cùng `Idempotency-Key`.
- Ngân hàng từ chối vượt hạn mức trả `402`; Fee Service không thử lại lỗi này.
- Lỗi mô phỏng `FAIL_RATE` trả HTTP 500 trước khi trừ tiền, vì vậy được phép retry có giới hạn.
- `DROP_RATE` được áp dụng sau khi ngân hàng đã ghi nhận charge; Fee Service có thể retry cùng khóa để lấy kết quả đã lưu.
- Timeout hoặc ngắt socket sau khi yêu cầu có thể đã tới ngân hàng được xem là chưa xác định: trả `504` + `PENDING`, không giảm công nợ cho đến khi xác minh thành công.
- `ECONNREFUSED` trước khi thiết lập được kết nối trả `503` + `FAILED` vì yêu cầu chưa được gửi đến ngân hàng.

## 5. Kiểm thử tình huống 1 — Ngân hàng tắt rồi bật lại

Điều kiện ban đầu: Fee Service đang chạy với `BANK_URL=http://localhost:4002`.

1. Dừng Bank Service bằng `Ctrl+C` ở Terminal 1; không dừng Fee Service.
2. Chạy ở một terminal thứ ba:

   ```powershell
   npm run test:s1
   ```

3. Script gửi thanh toán khi ngân hàng tắt, đo thời gian và gọi GET fees. Khi script yêu cầu, khởi động lại Bank Service với cấu hình bình thường rồi nhấn Enter.
4. Script gửi một payment mới và báo kết quả.

Kỳ vọng: lần đầu HTTP `503`, JSON có `error`, `paymentId`, `status: "FAILED"`, thời gian dưới 1500 ms; GET fees trả `200`; lần hai trả `201`, không restart Fee Service.

### Kiểm tra BANK_URL trỏ sang cổng 4999

Dừng Fee Service, sau đó ở Terminal 2:

```powershell
$env:BANK_URL="http://localhost:4999"
npm run fee
```

Đảm bảo không có ngân hàng chạy tại cổng 4999, rồi ở Terminal 3 chạy:

```powershell
npm run test:bank-url
```

Kỳ vọng hành vi giống ngân hàng không kết nối được: `503`, `FAILED`, có đủ `error`, `paymentId`, `status` và dưới 1,5 giây. Sau phép thử, khởi động lại Fee Service với `BANK_URL=http://localhost:4002`.

## 6. Kiểm thử tình huống 2 — Ngân hàng chậm 5 giây

Dừng rồi khởi động lại Bank Service ở Terminal 1:

```powershell
$env:DELAY_MS="5000"
$env:FAIL_RATE="0"
$env:DROP_RATE="0"
npm run bank
```

Fee Service cần tiếp tục chạy với deadline 4000 ms. Tại Terminal 3:

```powershell
npm run test:s2
```

Script gửi 20 yêu cầu thanh toán đồng thời và đo GET fees trong khi các yêu cầu đang chờ.

Kỳ vọng: 20 lời gọi thanh toán trả `504` với `status: "PENDING"`; mỗi lời gọi kết thúc trong tối đa 4500 ms; GET fees trả `200` dưới 300 ms. Ngân hàng có thể đã ghi nhận charge trước khi trả lời chậm; do đó không coi `PENDING` là thất bại cuối cùng. Khởi động lại Bank Service ở chế độ bình thường và Fee Service trước các tình huống kế tiếp để xóa dữ liệu thử trong bộ nhớ.

## 7. Kiểm thử tình huống 3 — Duy trì kết nối

Khởi động lại Bank Service với cấu hình bình thường (`DELAY_MS=0`, `FAIL_RATE=0`, `DROP_RATE=0`) và khởi động lại Fee Service để có trạng thái sạch. Tại Terminal 3:

```powershell
npm run test:s3
```

Script:

- Ghi stats ngân hàng trước.
- Gửi 200 payment, mỗi payment 1000 VND, tối đa 10 lời gọi đồng thời.
- Ghi stats sau đợt 200 payment và tính chênh lệch.
- Chờ 6 giây, sau đó gửi thêm ba payment để kiểm tra tái lập kết nối.

Kỳ vọng: 200/200 thanh toán trả `201`; số TCP mới trong đợt đo không quá 20; `duplicates=0`; ba yêu cầu sau thời gian nhàn rỗi thành công. Việc lấy `/stats` cũng tạo kết nối HTTP riêng và được tính trong `connections`, nên script giữ cả phép đo này trong chênh lệch thực tế.

## 8. Kiểm thử tình huống 4 — Mất phản hồi, lỗi 500 và từ chối hạn mức

Mỗi nhánh dùng dữ liệu trong bộ nhớ, nên hãy khởi động lại Fee Service và Bank Service trước từng phép thử để có công nợ sinh viên 1 là 50.000.000 VND và bộ đếm stats mới.

### 4a. Charge đã ghi nhận nhưng phản hồi bị mất

Khởi động Bank Service:

```powershell
$env:DELAY_MS="0"
$env:FAIL_RATE="0"
$env:DROP_RATE="0.3"
npm run bank
```

Khởi động Fee Service bình thường rồi chạy:

```powershell
npm run test:s4 -- drop
```

Script gửi 60 payment tuần tự, mỗi payment 100.000 VND. Kỳ vọng ít nhất 54 `PAID`, `duplicates=0`, số charge khớp số giao dịch thực sự đã trừ tiền và công nợ giảm đúng tổng tiền của các payment `PAID`. Nếu một lệnh không thể xác minh trong deadline, nó phải trả `504 PENDING`.

### 4b. HTTP 500 tạm thời trước khi trừ tiền

Khởi động lại Bank Service với:

```powershell
$env:DELAY_MS="0"
$env:FAIL_RATE="0.3"
$env:DROP_RATE="0"
npm run bank
```

Khởi động lại Fee Service rồi chạy:

```powershell
npm run test:s4 -- fail
```

Kỳ vọng ít nhất 54/60 `PAID`, không có trừ tiền trùng, công nợ chỉ giảm theo giao dịch `PAID`, và mỗi yêu cầu tuân thủ deadline tổng không quá 4500 ms. Trong script, `502 FAILED` chỉ xuất hiện nếu cả ba lần gửi đều nhận lỗi 500 trước khi trừ tiền.

### 4c. Từ chối thanh toán 25.000.000 VND

Khởi động lại Bank Service ở chế độ bình thường và khởi động lại Fee Service. Chạy:

```powershell
npm run test:s4 -- limit
```

Kỳ vọng HTTP `402`, `status: "FAILED"`, ngân hàng nhận đúng một `POST /charges`, `charges` không tăng và công nợ không đổi.

## 9. Bảng kết quả cần đưa vào báo cáo nhóm

Chạy mỗi tình huống và ghi số liệu thực tế vào bảng của báo cáo:

| Tình huống | Chỉ số | Trước khi sửa | Sau khi sửa |
|---|---|---:|---:|
| 1 | HTTP / thời gian thanh toán khi ngân hàng tắt | ___ | ___ |
| 1 | HTTP / thời gian GET fees | ___ | ___ |
| 2 | Thời gian thanh toán lớn nhất trong 20 lời gọi | ___ | ___ |
| 2 | Thời gian GET fees trong lúc tải | ___ | ___ |
| 3 | Tổng thời gian 200 payment | ___ | ___ |
| 3 | Thành công trên 200 | ___ | ___ |
| 3 | Chênh lệch `connections` / `charges` / `duplicates` | ___ | ___ |
| 4a | PAID trên 60 / `charges` / `duplicates` | ___ | ___ |
| 4b | PAID trên 60 / số retry / `duplicates` | ___ | ___ |
| 4c | HTTP / chênh lệch requests / công nợ trước-sau | ___ | ___ |

Giá trị sau khi sửa là kết quả script đo thật. Không ghi giá trị mục tiêu như thể đó là dữ liệu đã quan sát.


## 10. Tự động kiểm thử cả bốn tình huống bằng Postman

Project có collection `postman/Lab3-Auto-Test.postman_collection.json`. Collection điều phối các tình huống 1–4 trong một lần chạy: 20 thanh toán đồng thời ở tình huống 2; 200 thanh toán với concurrency 10 ở tình huống 3; hai đợt 60 thanh toán cho `DROP_RATE=0.3` và `FAIL_RATE=0.3`; cuối cùng là giao dịch 25.000.000 VND. Các kiểm tra HTTP, trạng thái, thời gian, `connections`, `charges`, `duplicates` và chênh lệch công nợ được đánh giá tự động.

### Chuẩn bị một lần

1. Mở file `.env`, thêm hoặc sửa dòng sau cho cả hai service:

   ```env
   ENABLE_TEST_ENDPOINTS=true
   ```

   Dòng này đã có trong `.env.example`, nhưng nếu bạn đã tạo `.env` từ trước thì cần tự thêm dòng rồi lưu.
2. Dừng và khởi động lại cả Bank Service và Fee Service để biến môi trường được nạp lại. Dùng `npm.cmd run bank` và `npm.cmd run fee` trong PowerShell nếu máy đang chặn `npm.ps1`.
3. Đảm bảo Bank Service chạy cổng 4002, Fee Service chạy cổng 4001, và dùng Postman Desktop (hoặc Desktop Agent) để gọi `localhost`.
4. Trong Postman chọn **Import** rồi chọn file `postman/Lab3-Auto-Test.postman_collection.json`.
5. Chọn collection **Lab 3 — Auto Test 4 tình huống**, bấm **Run** rồi **Run Lab 3**. Không cần tự thay `DELAY_MS`, `FAIL_RATE`, `DROP_RATE`, dừng ngân hàng hay chạy lần lượt các script Node.

### Collection tự làm gì?

- Reset dữ liệu trong bộ nhớ về trạng thái đầu: sinh viên 1 có công nợ 50.000.000 VND và bộ đếm ngân hàng được reset.
- Tình huống 1: đặt Fee Service dùng `http://localhost:4999` để mô phỏng lỗi `ECONNREFUSED`, kiểm tra `503 FAILED` và GET fees; sau đó tự đổi về `http://localhost:4002` và xác nhận thanh toán mới thành công. Đây là mô phỏng tự động kết quả khi ngân hàng không thể kết nối; Postman không tự dừng/khởi động tiến trình Windows.
- Tình huống 2: cấu hình runtime `DELAY_MS=5000`, gửi 20 payment đồng thời, đo thời gian, GET fees, rồi gửi lại 20 `paymentId` cũ với độ trễ đã tắt để xác minh và giải phóng các giao dịch `PENDING`.
- Tình huống 3: gửi 200 payment theo nhóm 10, đo chênh lệch stats, chờ 6 giây và gửi thêm 3 payment.
- Tình huống 4: cấu hình lần lượt `DROP_RATE=0.3`, `FAIL_RATE=0.3`, rồi kiểm tra hạn mức 25.000.000 VND.
- Cuối lượt chạy, collection cố gắng khôi phục cấu hình ngân hàng bình thường và `BANK_URL=http://localhost:4002`.

### Xem kết quả

- Tab **Test Results** thể hiện các assertion đạt/chưa đạt; mục tổng kết kiểm tra toàn suite sẽ báo nếu có kiểm tra thất bại.
- Mở **View → Show Postman Console** để xem các báo cáo `S3_REPORT`, `S4A_REPORT`, `S4B_REPORT` và `LAB3_AUTOMATED_REPORT` có số liệu đo trước/sau.
- Collection variables `lab3LastRunReport` và `lab3LastTestItems` cũng lưu dữ liệu kết quả.
- Chạy lại collection sẽ reset dữ liệu trong RAM. Chỉ chạy trên môi trường lab local, không bật `ENABLE_TEST_ENDPOINTS` trên hệ thống thật: các endpoint `/__test/reset` có khả năng xóa dữ liệu trong bộ nhớ.

**Lưu ý về độ ngẫu nhiên:** `FAIL_RATE=0.3` và `DROP_RATE=0.3` là xác suất mô phỏng, nên số kết quả có thể thay đổi giữa các lượt chạy. Đề yêu cầu ít nhất 54/60 thành công; nếu ngưỡng này thất bại trong một lượt ngẫu nhiên, lưu kết quả và chạy lại sau khi kiểm tra cấu hình. Các giá trị trong báo cáo là số đo thật từ lượt chạy, không phải giá trị mục tiêu.

## 11. Giới hạn của bài lab

Dữ liệu và bộ đếm đang lưu trong RAM theo phạm vi đề bài. Khởi động lại service sẽ xóa trạng thái và thống kê. Đây là triển khai học tập cho một tiến trình, chưa phải thiết kế giao dịch tài chính production: một hệ thống thực tế cần lưu bền vững ledger, thực hiện cập nhật nguyên tử/transactional, và có quy trình đối soát `PENDING` sau khi service khởi động lại.
