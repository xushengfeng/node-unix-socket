# unix-socket

高性能的 Node.js Unix socket 库，使用 Rust (Neon) 实现，支持文件描述符传递 (SCM_RIGHTS)。

## 特性

- 🚀 **高性能** - 使用 Rust 实现，比纯 JavaScript 方案更快
- 📁 **文件描述符传递** - 支持通过 Unix socket 传递文件描述符 (SCM_RIGHTS)
- 🔄 **非阻塞 I/O** - 支持非阻塞的 accept 操作
- 📦 **TypeScript 支持** - 完整的类型定义
- 🧪 **测试覆盖** - 完整的测试用例

## 安装

```bash
npm install unix-socket
# 或
pnpm add unix-socket
# 或
yarn add unix-socket
```

## 快速开始

### 基本用法

```typescript
import { UServer, USocket } from "unix-socket";

// 创建服务器
const server = new UServer();
server.listen("/tmp/my-socket");

server.on("listening", () => {
    console.log("Server listening");
});

// 创建客户端连接
const client = new USocket("/tmp/my-socket");

// 等待服务器接受连接
let serverSocket: USocket | null = null;
while (!serverSocket) {
    serverSocket = server.accept();
}

// 发送数据
const message = Buffer.from("Hello, Server!");
client.write(message);

// 读取数据
let data: Buffer | null = null;
while (!data) {
    data = serverSocket.read(1024);
}
console.log(data.toString()); // "Hello, Server!"

// 清理
client.close();
serverSocket.close();
server.close();
```

### 文件描述符传递

```typescript
import { UServer, USocket } from "unix-socket";
import * as fs from "fs";

// 创建服务器
const server = new UServer();
server.listen("/tmp/fd-socket");

// 创建客户端
const client = new USocket("/tmp/fd-socket");

// 等待服务器接受连接
let serverSocket: USocket | null = null;
while (!serverSocket) {
    serverSocket = server.accept();
}

// 客户端打开文件并发送 fd
const fileFd = fs.openSync("/tmp/test.txt", "r");
const message = Buffer.from("fd-transfer");
client.write(message, [fileFd]);

// 服务器接收 fd
let result = null;
while (!result || result.fds.length === 0) {
    result = serverSocket.readWithFds(1024);
}

// 使用接收到的 fd 读取文件
const receivedFd = result.fds[0];
const content = fs.readFileSync(receivedFd, "utf-8");
console.log(content);

// 清理
fs.closeSync(fileFd);
fs.closeSync(receivedFd);
client.close();
serverSocket.close();
server.close();
```

## API

### USocket

Unix socket 客户端类。

#### 构造函数

```typescript
new USocket(opts?: USocketOptions | string)
```

- `opts.path` - 连接的 socket 路径
- `opts.fd` - 使用现有的文件描述符

#### 方法

##### `connect(opts: USocketOptions | string): void`

连接到 Unix socket 服务器。

##### `write(data: Buffer, fds?: number[]): number`

发送数据，可选择发送文件描述符数组。

- `data` - 要发送的数据
- `fds` - 要发送的文件描述符数组 (可选)
- 返回实际写入的字节数

##### `read(size: number): Buffer | null`

读取数据。

- `size` - 要读取的最大字节数
- 返回读取的数据或 null

##### `readWithFds(size: number): ReadWithFdsResult | null`

读取数据和文件描述符。

返回对象：

- `data` - 读取的数据 (Buffer | null)
- `fds` - 接收到的文件描述符数组

##### `shutdown(): void`

关闭 socket 连接。

##### `close(): void`

关闭并释放资源。

### UServer

Unix socket 服务器类，继承自 EventEmitter。

#### 构造函数

```typescript
new UServer();
```

#### 方法

##### `listen(path: string, backlog?: number, cb?: () => void): void`

开始监听指定路径。

- `path` - socket 文件路径
- `backlog` - 连接队列长度 (默认: 16)
- `cb` - 监听成功回调 (可选)

##### `accept(): USocket | null`

接受新的连接。

- 返回新的 USocket 实例，如果没有连接则返回 null

##### `pause(): void`

暂停接受连接。

##### `resume(): void`

恢复接受连接。

##### `close(): void`

关闭服务器。

#### 事件

- `listening` - 服务器开始监听时触发

## 构建

### 前置要求

- Node.js >= 18
- Rust 和 Cargo
- pnpm (或 npm/yarn)

### 构建步骤

```bash
# 安装依赖
pnpm install

# 构建
pnpm run build

# 运行测试
pnpm test

# 监视模式测试
pnpm run test:watch

# 生成测试覆盖率报告
pnpm run test:coverage
```

### 构建脚本

- `pnpm run build` - 完整构建 (Rust + TypeScript + 类型定义)
- `pnpm run build:rust` - 仅构建 Rust 原生模块
- `pnpm run build:ts` - 仅构建 TypeScript
- `pnpm run build:types` - 仅生成类型定义
- `pnpm test` - 运行测试
- `pnpm run test:rust` - 运行 Rust 测试

## 项目结构

```
├── src/
│   ├── index.ts          # TypeScript 入口
│   ├── socket.rs         # Rust 实现
│   └── socket.test.ts    # 测试文件
├── dist/                 # 构建输出
├── Cargo.toml           # Rust 配置
├── package.json         # Node.js 配置
├── tsconfig.json        # TypeScript 配置
└── vite.config.ts       # Vite 配置
```

## 技术栈

- **Rust** - 核心实现
- **Neon** - Rust 和 Node.js 的桥梁
- **Vite** - TypeScript 打包
- **Vitest** - 测试框架
- **nix** - Unix 系统调用

## 相关项目

- [neon](https://neon-bindings.com/) - Rust 和 Node.js 的绑定
