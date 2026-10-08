# Vaultwarden trên Cloudflare Containers + PostgreSQL

Bộ triển khai này build **source Vaultwarden trong repo hiện tại** bằng Dockerfile
Debian có sẵn, với features `postgresql,s3`. Worker chuyển tiếp HTTP và WebSocket
đến một container duy nhất. PostgreSQL bên ngoài giữ dữ liệu quan hệ; R2 giữ toàn bộ
`DATA_FOLDER`, gồm attachments, Send, RSA key và `config.json`.

Tham khảo cách triển khai ở `vaultwarden_heroku/vaultwarden_heroku.sh`: dùng
`DATABASE_URL`, giới hạn pool ở 7 kết nối và build image từ source. Phần dành riêng
cho Heroku (CLI, registry, `$PORT`, addons, clone lại upstream) được thay bằng `cf`.
Không cần bỏ kiểm tra persistence: `DATA_FOLDER` trỏ đến R2 qua S3, chỉ thư mục tạm
và template overrides nằm trên disk tạm của container.

## Deploy bằng giao diện web

Không cần Docker trên máy cá nhân khi build bằng Workers Builds hoặc GitHub Actions.
Đưa các file trong `cloudflare/` và workflow `.github/workflows/cloudflare-deploy.yml`
lên repository GitHub trước. Cả hai cách dưới đây build source của commit được chọn.

### Cloudflare Dashboard → Workers Builds

1. Vào **Workers & Pages → Create application → Import a repository**, chọn repo
   `dijnie/worker-warden` và nhánh đã có bộ triển khai này.
2. Điền:

   | Ô | Giá trị |
   | --- | --- |
   | Worker name | `worker-warden` |
   | Root directory | `/` (gốc repo, để Dockerfile và Rust source cùng nằm trong build context) |
   | Build command | `npm ci --prefix cloudflare && npm --prefix cloudflare run check && npm --prefix cloudflare test` |
   | Deploy command | `npm --prefix cloudflare run deploy:ci` |
   | Non-production/preview builds | Tắt cho cấu hình production này |

3. Trong **Build variables and secrets**, thêm `NODE_VERSION=24` và
   `SKIP_DEPENDENCY_INSTALL=1`. Thêm bảy app secrets: `DATABASE_URL`, `DOMAIN`,
   `R2_BUCKET`, `R2_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
   `ADMIN_TOKEN`. Giá trị theo bảng cấu hình bên dưới; bật chế độ Secret.
4. Tạo R2 bucket private và R2 S3 credentials trên dashboard nếu chưa có.
   Chọn API token deploy có quyền Workers Scripts và Containers trên account
   đích. Token tự tạo bởi Workers Builds có thể cần bổ sung quyền Containers.
5. Bấm **Save and Deploy**. Với Worker đã tồn tại, cấu hình ở **Settings → Builds**
   rồi chạy lại build. Sau provisioning, kiểm tra `/alive` và `/admin`.

`deploy:ci` lấy bảy app secrets từ environment của build, ghi file tạm quyền `0600`,
upload bằng `cf deploy --secrets-file`, rồi xóa file. Build secrets thông thường
không tự trở thành runtime secrets; script xử lý bước này. Không tạo hoặc commit
`.secrets.json` khi dùng cách deploy web.

Workers Builds giới hạn **20 phút mỗi build**. Repo Rust này chưa được đo thời gian
build image; nếu build từ đầu bị timeout, dùng workflow GitHub bên dưới. Không đổi
sang image upstream mặc định vì bộ triển khai này cần feature `s3`.

### GitHub → Actions → Run workflow

Cách này cũng chỉ thao tác trên web, phù hợp khi build Rust vượt giới hạn Workers Builds:

1. Đảm bảo `.github/workflows/cloudflare-deploy.yml` đã nằm trên default branch.
2. Vào **Settings → Secrets and variables → Actions → New repository secret**.
   Thêm bảy app secrets ở trên, cùng `CLOUDFLARE_ACCOUNT_ID` và
   `CLOUDFLARE_API_TOKEN` có quyền deploy Workers/Containers trên account đích.
3. Vào **Actions → Deploy Vaultwarden to Cloudflare → Run workflow**.
4. Runner GitHub build Docker image và gọi `cf` để deploy lên Cloudflare.

Workflow chỉ chạy khi bấm nút, không tự deploy mỗi lần push; timeout là 120 phút.
Chọn một nơi quản lý deploy production để tránh hai pipeline cập nhật cùng lúc.

Tài liệu: [Deploy Containers qua Workers Builds](https://developers.cloudflare.com/containers/guides/deploy/#deploy-with-workers-builds),
[build settings](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/),
[giới hạn build](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/).

## Chuẩn bị khi deploy từ terminal

- Node.js 24+, Docker đang chạy và truy cập được từ terminal hiện tại.
- Tài khoản Cloudflare có Containers/R2; chạy `cf auth login` nếu chưa đăng nhập.
- PostgreSQL dành riêng cho Vaultwarden, truy cập được qua Internet và bật TLS.
  Dùng direct connection hoặc session pooling, tránh transaction pooling cho lần
  khởi tạo/migrations. Vaultwarden tự chạy migrations khi khởi động; tài khoản DB
  cần quyền tạo/sửa bảng. Cấu hình này không tự chuyển dữ liệu từ database cũ.
- R2 bucket riêng, private; S3 credentials có quyền Object Read & Write chỉ trên
  bucket đó. Không bật public access cho bucket chứa vault.
- Một HTTPS origin: `https://worker-warden.<subdomain>.workers.dev` hoặc custom
  domain đã gắn vào Worker. `DOMAIN` phải khớp origin client sử dụng, không có subpath.

## Cấu hình và triển khai

Chạy từ thư mục `cloudflare/`:

```sh
npm ci
umask 077
cp .secrets.json.example .secrets.json
```

Điền `.secrets.json` (đã được gitignore):

| Khóa | Giá trị |
| --- | --- |
| `DATABASE_URL` | `postgresql://USER:PASSWORD@HOST:5432/DATABASE?sslmode=require`; URL-encode mật khẩu |
| `DOMAIN` | HTTPS origin công khai |
| `R2_BUCKET` | Tên bucket riêng |
| `R2_ENDPOINT` | `https://ACCOUNT_ID.r2.cloudflarestorage.com` (hoặc endpoint jurisdiction tương ứng) |
| `AWS_ACCESS_KEY_ID` | R2 S3 Access Key ID |
| `AWS_SECRET_ACCESS_KEY` | R2 S3 Secret Access Key |
| `ADMIN_TOKEN` | Argon2 hash từ Vaultwarden hoặc token ngẫu nhiên tối thiểu 32 ký tự |

Có thể tạo token quản trị bằng `openssl rand -hex 32`. Không commit secrets hoặc
đưa chúng vào build arguments. Credentials được truyền vào container lúc khởi động.
Nếu nhà cung cấp PostgreSQL hỗ trợ certificate validation, ưu tiên `sslmode=verify-full`
và cung cấp CA phù hợp; `require` mã hóa kết nối nhưng không xác minh hostname.

Tạo bucket nếu chưa có:

```sh
cf r2 buckets create --name worker-warden-data --dry-run
cf r2 buckets create --name worker-warden-data
```

Tạo R2 S3 credentials giới hạn cho bucket trong Cloudflare R2 API Tokens. Sau đó:

```sh
npm run check
npm test
npm run preflight
cf deploy --dry-run
npm run deploy
```

`cf deploy` build image `linux/amd64`, upload Worker/image và triển khai container.
Lần đầu cần chờ provisioning. Không dùng Wrangler cho bộ cấu hình này.
`npm run preflight` chỉ kiểm tra định dạng, không xác minh kết nối DB/R2.

## Khởi tạo tài khoản và vận hành

- Public signup mặc định tắt. Vào `/admin`, dùng `ADMIN_TOKEN` để invite địa chỉ email
  của bạn, rồi đăng ký bằng đúng địa chỉ đã invite. Nếu chưa cấu hình SMTP, mở trang
  đăng ký thủ công. Sau này có thể cấu hình SMTP và các tùy chọn app qua `/admin`;
  `config.json` được lưu trên R2 và có thể ghi đè một số biến môi trường.
- Cron mỗi phút giữ container chạy để scheduler gốc thực hiện purge và các tác vụ
  nền. Điều này có chi phí container chạy thường xuyên. Restart/rollout vẫn có thể
  gây gián đoạn ngắn; đây không phải cấu hình high availability.
- Mọi request dùng cùng Durable Object `primary`, với `maxInstances: 1`. Giữ tên
  này ổn định; tăng số instance cần thiết kế lại notification và scheduler trước.
- SQLite của Durable Object chỉ phục vụ cơ chế điều phối Cloudflare, không thay
  thế PostgreSQL và không có D1 trong cấu hình này.
- Khi đổi secrets, triển khai lại và bảo đảm process container được restart;
  process đang chạy giữ environment cũ. Không xóa R2 RSA key khi cập nhật.
- Backup cả PostgreSQL **và** R2. Snapshot disk container không phải backup vault.
- Logging bỏ query string ở Worker vì URL WebSocket có thể chứa access token.
  Vaultwarden mặc định `LOG_LEVEL=warn`; không bật log request chứa token.

## Kiểm chứng trước khi dùng dữ liệu thật

1. `/alive` trả HTTP 200 (endpoint này lấy một kết nối PostgreSQL).
2. Tạo tài khoản thử, đăng nhập bằng web vault và client Bitwarden.
3. Tạo/sửa/xóa một item; kiểm tra đồng bộ giữa hai client và WebSocket.
4. Upload attachment, tạo Send; tải lại và kiểm tra nội dung.
5. Restart container; kiểm tra đăng nhập, item, attachment, Send và cấu hình admin
   còn nguyên. Kiểm tra RSA key trên R2 không bị tạo lại.
6. Thử backup/restore trên database và bucket thử nghiệm riêng.

Unit tests kiểm tra cấu hình PostgreSQL/R2, forwarding headers, payload upload và
handshake WebSocket. Chúng không thay thế thử nghiệm container/client thực tế.

Tài liệu: [cf config](https://developers.cloudflare.com/cf/projects/cloudflare-config/),
[Container API](https://developers.cloudflare.com/containers/api/durable-object-container/),
[R2 S3](https://developers.cloudflare.com/r2/api/s3/api/).
