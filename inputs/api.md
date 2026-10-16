# 商城系统 API 接口文档

> 版本：v1.0.0 ｜ 技术栈：FastAPI + SQLite ｜ 在线文档：`http://127.0.0.1:8000/docs`（Swagger UI）
> 统一响应格式：`{ "code": 0, "msg": "success", "data": ... }`（`code != 0` 表示业务失败；HTTP 401/403 表示鉴权/权限错误）

---

## 一、总体架构与模块说明

你最初描述的框架是「系统管理（用户/角色/菜单/字典）+ 品牌 + 商品」，以及店铺端的登录、浏览、收藏、加购。
为使系统逻辑闭环、可演示，我在其基础上**补全并新增**了以下模块（以下也是我对"还缺什么"的判断）：

| 模块 | 状态 | 说明 / 补全理由 |
| --- | --- | --- |
| 系统管理-用户管理 | 你已提 | 增加密码加盐哈希、启用/禁用、角色分配 |
| 系统管理-角色管理 | 你已提 | 增加角色→菜单权限分配（RBAC） |
| 系统管理-菜单管理 | 你已提 | 树形结构（父子级），驱动后台左侧菜单 |
| 系统管理-字典管理 | 你已提 | 类型+数据两级，承载"商品状态/订单状态/用户状态"等枚举 |
| 品牌管理 | 你已提 | 增删改查 |
| 商品分类管理（**新增**） | 新增 | 商品必须归属分类与品牌，否则"商品 CRUD"无法闭环 |
| 商品管理 | 你已提 | 增删改查 **+ 上架/下架** 两个专用接口 |
| 用户注册（**新增**） | 新增 | 店铺端需要自助注册账号 |
| 购物车（**新增**） | 新增 | 前端"加入购物车"必须有后端承载，含库存校验 |
| 商品收藏（**新增**） | 你已提 | 增删查 |
| 收货地址（**新增**） | 新增 | 下单必须选择收货地址 |
| 订单管理（**新增**） | 新增 | 购物车结算必然产生订单，含下单/列表/详情/状态流转（待付款→已付款→已发货→已完成，可取消） |
| 鉴权 Token（**新增**） | 新增 | 登录签发 Token，后续请求 `Authorization: Bearer <token>` |
| 管理后台 / 店铺前端（**新增**） | 新增 | 你最终要的"可视化页面"——两套独立前端 |

**权限模型**：后台管理员（角色 `ADMIN`）才能访问 `/api/system/*`、`/api/brands`、`/api/categories`、`/api/products`（写）、`/api/admin/*`；店铺浏览商品、注册/登录、购物车、收藏、下单为登录用户或公开。

---

## 二、环境准备与启动

```bash
# 1. 安装依赖（Python 3.10+）
pip install fastapi uvicorn

# 2. 初始化数据库并启动（首次运行会自动建库 + 写入演示数据）
cd backend
python app.py

# 启动后访问：
#   接口根：     http://127.0.0.1:8000/api/...
#   在线文档：   http://127.0.0.1:8000/docs
#   店铺前端：   http://127.0.0.1:8000/shop/
#   管理后台：   http://127.0.0.1:8000/admin/
```

**演示账号**
- 管理员：`admin / 123456`（可登录管理后台）
- 普通用户：`xiaoming / 123456`（可用店铺端下单）

---

## 三、通用约定

- **Base URL**：`http://127.0.0.1:8000/api`
- **请求**：`Content-Type: application/json`（GET 参数走 query）
- **鉴权**：除登录/注册/商品浏览等公开接口外，需在 Header 携带 `Authorization: Bearer <token>`
- **分页**：列表类接口支持 `page`、`size`（默认 page=1, size=10/12）
- **状态码**：`code=0` 成功；非 0 为业务错误；HTTP `401` 未登录、`403` 无权限

---

## 四、接口清单

### 4.1 鉴权 Auth

#### POST `/api/auth/login` 登录
请求：
```json
{ "username": "admin", "password": "123456" }
```
响应：
```json
{ "code": 0, "msg": "success",
  "data": { "token": "eyJ...", "user": { "id": 1, "username": "admin", "nickname": "超级管理员", "roles": [{"id":1,"name":"管理员","code":"ADMIN"}] } } }
```

#### POST `/api/auth/register` 注册
请求：`{ "username": "xiaoming", "password": "123456", "nickname": "小明" }`
响应：返回 `token` 与新用户（默认授予 `USER` 角色）。

#### GET `/api/auth/me` 获取当前用户
Header 带 Token。响应含用户信息及 `is_admin` 标记。

---

### 4.2 系统管理 - 用户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/users?page=&size=&keyword=` | 用户列表（管理） |
| POST | `/api/system/users` | 新增用户（密码必填） |
| PUT | `/api/system/users/{id}` | 修改用户（密码留空则不改） |
| DELETE | `/api/system/users/{id}` | 删除用户 |
| PUT | `/api/system/users/{id}/roles` | 分配角色 `{ "role_ids": [1,2] }` |
| GET | `/api/system/users/{id}/roles` | 获取用户已分配角色 ID 列表 |

---

### 4.3 系统管理 - 角色

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/roles` | 角色列表 |
| POST | `/api/system/roles` | 新增角色（name、code 必填） |
| PUT | `/api/system/roles/{id}` | 修改角色 |
| DELETE | `/api/system/roles/{id}` | 删除角色 |
| GET | `/api/system/roles/{id}/menus` | 角色已分配菜单 ID |
| PUT | `/api/system/roles/{id}/menus` | 分配菜单权限 `{ "menu_ids": [1,2,3] }` |

---

### 4.4 系统管理 - 菜单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/menus?tree=1` | 菜单树（默认 tree=1） |
| POST | `/api/system/menus` | 新增菜单（支持 parent_id 父子级） |
| PUT | `/api/system/menus/{id}` | 修改菜单 |
| DELETE | `/api/system/menus/{id}` | 删除菜单 |

---

### 4.5 系统管理 - 字典

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system/dicts` | 字典类型列表 |
| GET | `/api/system/dicts/{type}/data` | 某类型下的字典数据 |
| POST | `/api/system/dicts` | 新增字典类型 `{ "type":"order_status","name":"订单状态" }` |
| POST | `/api/system/dicts/data` | 新增字典数据 `{ "type":"order_status","label":"已发货","value":"2" }` |
| DELETE | `/api/system/dicts/{type}` | 删除字典类型（级联删数据） |
| DELETE | `/api/system/dicts/data/{id}` | 删除字典数据 |

---

### 4.6 品牌管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/brands?page=&size=&keyword=` | 品牌列表 |
| POST | `/api/brands` | 新增品牌 |
| PUT | `/api/brands/{id}` | 修改品牌 |
| DELETE | `/api/brands/{id}` | 删除品牌 |

---

### 4.7 商品分类（两级）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/categories?tree=1` | 分类树 |
| POST | `/api/categories` | 新增分类（parent_id=0 为顶级） |
| PUT | `/api/categories/{id}` | 修改分类 |
| DELETE | `/api/categories/{id}` | 删除分类 |

---

### 4.8 商品管理（含上下架）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/products?page=&size=&keyword=&category_id=&brand_id=&on_sale=1` | 商品列表（公开，店铺端浏览用 `on_sale=1`） |
| GET | `/api/products/{id}` | 商品详情（含品牌名/分类名） |
| POST | `/api/products` | 新增商品（管理） |
| PUT | `/api/products/{id}` | 修改商品 |
| DELETE | `/api/products/{id}` | 删除商品 |
| POST | `/api/products/{id}/shelf` | **上架** |
| POST | `/api/products/{id}/unshelf` | **下架** |

商品字段：`name, category_id, brand_id, price, stock, description, images(JSON 数组), status(0下架/1上架), sales`

---

### 4.9 收藏

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/favorites` | 我的收藏列表 |
| POST | `/api/favorites` | 收藏 `{ "product_id": 1 }` |
| DELETE | `/api/favorites/{product_id}` | 取消收藏 |

---

### 4.10 购物车

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/cart` | 购物车列表（返回 items、合计 total、商品数 count） |
| POST | `/api/cart` | 加入购物车 `{ "product_id":1, "quantity":2 }`（校验库存/下架） |
| PUT | `/api/cart/{product_id}` | 修改数量 `{ "quantity":3 }` |
| DELETE | `/api/cart/{product_id}` | 移除一项 |
| DELETE | `/api/cart` | 清空购物车 |

---

### 4.11 收货地址

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/addresses` | 我的地址列表 |
| POST | `/api/addresses` | 新增地址（is_default=1 自动取消其他默认） |
| PUT | `/api/addresses/{id}` | 修改地址 |
| DELETE | `/api/addresses/{id}` | 删除地址 |

---

### 4.12 订单

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/orders` | **结算下单** `{ "address_id": 1 }`（清空购物车、扣库存、加销量） |
| GET | `/api/orders?page=&size=&status=` | 我的订单列表（含明细 items） |
| GET | `/api/orders/{id}` | 订单详情 |
| PUT | `/api/orders/{id}/status` | 状态流转（付款 0→1、确认收货 2→3、取消 0/1→4） |
| GET | `/api/admin/orders?status=` | 管理员订单列表（需 ADMIN） |
| PUT | `/api/admin/orders/{id}/ship` | 管理员发货（1→2） |

订单状态：`0待付款 1已付款 2已发货 3已完成 4已取消`

---

## 五、典型调用时序（下单）

```
1. 用户登录      POST /api/auth/login            -> token
2. 浏览商品      GET  /api/products?on_sale=1     -> 商品列表
3. 加入购物车    POST /api/cart                   -> ok
4. 维护地址      POST /api/addresses              -> ok
5. 提交订单      POST /api/orders {address_id}    -> {order_no, total_amount}
6. 付款          PUT  /api/orders/{id}/status {1}
7. 管理员发货    PUT  /api/admin/orders/{id}/ship
8. 确认收货      PUT  /api/orders/{id}/status {3}
```

---

## 六、前端页面与接口对应关系

- **店铺端** `frontend/shop/`：`#/home`(商品浏览) → `#/product/:id`(详情/加购/收藏) → `#/favorites`(收藏) → `#/cart`(购物车) → `#/orders`(订单)
- **管理后台** `frontend/admin/`：仪表盘 + 系统管理(用户/角色/菜单/字典) + 品牌/分类/商品/订单
- 两套前端均通过 `js/api.js` 调用上面的接口，Token 存于 `localStorage`。

---

## 七、安全与扩展性说明（演示级）

- 密码使用 `PBKDF2-HMAC-SHA256` 加盐哈希；Token 为自签 HMAC（**演示用，生产请替换为 JWT + 密钥管理**）。
- 数据库为文件型 SQLite（`backend/mall.db`），零额外依赖；切换 MySQL/PostgreSQL 只需替换 `db.py` 中的连接层。
- 已做基础校验：购物车库存校验、下架商品不可下单/加购、订单地址归属校验、角色/菜单权限校验。
- 如需更完善：可补充"商品评价、优惠券、支付网关回调、操作日志审计、文件(图片)上传"等模块。
