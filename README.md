# TEMU 商品发布助手

当前版本是前端交互原型，用于确认商品导入、图片匹配、店铺选择、模板、SKU 和发布任务的操作流程。

## 打开方式

直接打开 `dist/index.html`。页面不需要安装依赖或启动开发服务器。

## 当前可操作内容

- 商品表格与图片文件夹选择
- 图片匹配规则选择
- 分别选择 ERP 中已绑定的目标店铺、产品模板和 SKU 模板
- 产品标题按 Excel 行顺序读取
- 第 N 个产品严格匹配 `N.1` 至 `N.6` 六张轮播图
- 每组 `N.1` 自动作为该产品预览图
- Excel 产品标题数量必须与轮播图组数一致
- 商品搜索、勾选、单个编辑和批量修改
- 创建本地演示任务、查看发布任务和模拟失败重试
- 腾讯云 COS、妙手开放平台、TEMU 官方开放平台配置占位

当前所有任务均为浏览器内的演示数据，不会上传图片，也不会请求真实店铺接口。

`app_id` 和 `app_secret` 不写入前端文件。正式部署时分别配置为后端环境变量 `MIAOSHOU_APP_ID` 和 `MIAOSHOU_APP_SECRET`，示例见 `.env.example`。

## TEMU 官方接入路线

1. 在对应区域的 TEMU Partner Platform 注册开发者并创建应用。
2. 只服务自己的店铺时，优先申请 Seller In-House System / private app；服务其他卖家时，需要按 ERP / public app 流程申请、审核和发布。
3. 申请商品管理相关权限，包括类目、属性模板、图片、商品创建、SKU、库存和发布状态。
4. 设置授权回调地址。卖家完成授权后，回调会带回 `code`，后端使用 `bg.open.accesstoken.create` 换取 `access_token` 和 `mallId`。
5. 后端按店铺区域选择接口域名，并为每次请求生成签名。`app_secret`、`access_token` 和刷新凭证不得保存在前端。
6. 发布商品前依次获取类目、类目属性模板、规格 ID，上传图片，校验敏感词和合规属性，再调用商品创建接口。
7. 创建后通过发布状态接口轮询结果，把失败原因保存到任务记录供修改和重试。

常用商品接口名称以应用权限页中的实际文档为准，通常包括：

- `bg.local.goods.cats.get`
- `bg.local.goods.template.get`
- `bg.local.goods.spec.id.get`
- `bg.local.goods.image.upload`
- `temu.local.goods.illegal.vocabulary.check`
- `bg.local.goods.compliance.property.check`
- `temu.local.goods.v2.add` 或 `bg.local.goods.add`
- `bg.local.goods.publish.status.get`

区域接口：

- US: `https://openapi-b-us.temu.com/openapi/router`
- EU: `https://openapi-b-eu.temu.com/openapi/router`
- Global: `https://openapi-b-global.temu.com/openapi/router`

## 后端建议

- 前端：保留当前操作流程，后续迁移到正式工程。
- 后端：Node.js API 服务，负责授权回调、签名、任务队列和错误重试。
- 数据库：保存店铺、模板、商品批次、图片映射和发布结果。
- 图片：腾讯云 COS 作为原图与处理中转存储；前端使用后端签发的临时凭证直传 COS。
- 任务：发布过程使用队列异步执行，浏览器关闭后任务仍能继续。

## 下一阶段需要的信息

- 店铺属于 Local Seller 还是 Cross-border / Semi-managed
- 店铺区域是 US、EU 还是 Global
- TEMU Partner Platform 创建应用后获得的应用类型和已批准权限列表
- 腾讯云 COS 的 Region、Bucket 和自定义域名（密钥只配置在后端）
