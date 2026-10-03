# TEMU 商品发布助手

公网网页：<https://yanyujie-upload-item-d1ab8962386-1465086870.tcloudbaseapp.com/>

## 当前流程

- 从 XLSX、XLS 或 CSV 第一张工作表读取产品标题。
- 选择完整图片文件夹，严格要求 `1.1` 至 `1.6`、`2.1` 至 `2.6`，一直连续到 `N.6`。
- 禁止缺号、多余文件、重复编号、前导零、子文件夹和不支持的图片格式。
- 每个产品使用六张轮播图，`N.1` 同时作为预览图。
- 选择妙手 ERP 已绑定店铺、产品模板和 SKU 模板。
- 浏览器计算每张图片的 SHA-256，并发直传腾讯云；失败项最多自动重试五轮。
- 云函数按批次逐张核对对象路径、文件大小和 SHA-256。整批完全一致后，才允许导入妙手图片空间。
- 相同清单可断点续传，只上传或导入尚未成功的项目。
- 当前流程不保存草稿。

## 云端组成

- 静态网站：CloudBase 静态网站托管。
- API：CloudBase 云函数 `temu-api`，HTTP 网关路径 `/api`。
- 图片：CloudBase 云存储桶 `temu-product-images`。
- 清单：CloudBase PostgreSQL 表 `temu_upload_batches` 和 `temu_upload_items`。

妙手 AppSecret 只保存在云函数环境变量中，不写入网页或 Git。当前妙手接口返回 `appNotFound`，需要先在妙手开放平台确认 AppKey 正确并让应用审核启用；在此之前，网页会明确显示 ERP 连接失败并阻止创建不完整任务。

临时图片清理接口只接受状态为 `published` 的整批任务，不能在发布完成前误删图片。
