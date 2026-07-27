# CapCut Delivery System

> Hệ thống giao hàng tự động tài khoản **CapCut Pro** tích hợp với **Plati.market** và **Google Sheets**.

## 🚀 Tính năng

- ✅ Tự động xác thực unique code từ Plati.market  
- ✅ Giao hàng ngay sau thanh toán (redirect tự động)  
- ✅ Google Sheets làm kho sản phẩm & lịch sử đơn hàng  
- ✅ Chống trùng: mỗi unique code chỉ giao 1 lần  
- ✅ Khách hàng tra cứu lại bằng code + email  
- ✅ Giao diện đẹp, responsive, dark mode  

---

## 📁 Cấu trúc dự án

```
capcut-delivery/
├── api/
│   ├── verify.js      # POST: xác thực & giao hàng
│   ├── lookup.js      # GET: tra cứu đơn cũ
│   └── stock.js       # GET: xem tồn kho
├── lib/
│   ├── plati.js       # Plati.market API helper
│   └── sheets.js      # Google Sheets helper
├── index.html         # Trang nhận hàng chính
├── lookup.html        # Trang tra cứu đơn hàng
├── style.css          # Styles dùng chung
├── vercel.json        # Cấu hình Vercel
├── package.json
└── .env.example       # Mẫu biến môi trường
```

---

## ⚙️ Cài đặt & Deploy

### Bước 1 – Google Sheets

1. Tạo Google Spreadsheet mới
2. Tạo **4 tab (sheet)**:

**Tab "Orders"** – Lịch sử đơn (tự động điền):

| A: UniqueCode | B: BuyerEmail | C: AccountEmail | D: AccountPassword | E: SoldAt | F: PlatiOrderID | G: ProductType | H: ProductName |
|---|---|---|---|---|---|---|---|

**Tab "CapCut Pro 7 Ngày"** – Kho tài khoản 7 ngày:

| A: ID | B: Email | C: Password | D: Status | E: SoldAt | F: UniqueCode |
|:---:|:---|:---|:---:|:---:|:---|
| 1 | acc1@email.com | Pass@123 | available | | |

**Tab "CapCut Pro 1 Tháng"** – Kho tài khoản 1 tháng:
*(Cùng cấu trúc như trên)*

**Tab "CapCut Pro 6 Tháng"** – Kho tài khoản 6 tháng:
*(Cùng cấu trúc như trên)*

3. Tạo **Google Cloud Project** → bật Google Sheets API  
4. Tạo **Service Account** → tải key JSON  
5. **Share** spreadsheet với email service account (Editor)

### Bước 2 – Plati.market

1. Vào cài đặt sản phẩm → chọn **Automatic delivery**  
2. Nhập URL: `https://your-app.vercel.app/?uniquecode={uniquecode}`  
   *(Plati sẽ tự thêm `uniquecode=XXXXX` vào URL)*
3. Lấy: **Seller ID**, **Goods ID**, **Secret Key** từ API settings

### Bước 3 – Deploy lên Vercel

```bash
# Clone & cài dependencies
cd capcut-delivery
npm install

# Deploy
npx vercel --prod
```

Sau đó thêm Environment Variables trong Vercel Dashboard:

| Key | Value |
|-----|-------|
| `PLATI_SELLER_ID` | ID của bạn trên Plati |
| `PLATI_GOODS_ID_7D`  | Goods ID variant 7 ngày |
| `PLATI_GOODS_ID_1M`  | Goods ID variant 1 tháng (30 ngày) |
| `PLATI_GOODS_ID_6M`  | Goods ID variant 6 tháng (183 ngày) |
| `PLATI_SECRET_KEY`| Secret key API Plati |
| `GOOGLE_SERVICE_ACCOUNT` | Nội dung file JSON (1 dòng) |
| `GOOGLE_SPREADSHEET_ID`  | ID của Google Sheet |

### Bước 4 – Thêm .gitignore

```bash
# Tạo file .gitignore
echo ".env
.env.local
node_modules/
.vercel/" > .gitignore
```

---

## 🔑 Chữ ký Plati API

Chữ ký được tính theo công thức:
```
sign = MD5(seller_id + goods_id + unique_code + secret_key)
```

---

## 📊 Quản lý tồn kho

- Thêm tài khoản mới: Thêm dòng vào sheet **Products** với `Status = available`  
- Xem đơn đã bán: Sheet **Orders** tự động cập nhật  
- API kiểm tra stock: `GET /api/stock`  

---

## 🛡️ Bảo mật

- Unique code được xác thực trực tiếp với Plati API
- Email kiểm tra khi tra cứu đơn
- Mỗi code chỉ xử lý 1 lần (idempotent)

---

## 📞 Hỗ trợ

Liên hệ qua Telegram: [@your_telegram](https://t.me/your_telegram)
